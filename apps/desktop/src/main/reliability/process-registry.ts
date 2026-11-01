/**
 * P7-B：进程登记 + 启动残留清理。
 *
 * P4-D 只记录代理子进程 PID/时间，按 ChildProcess 句柄清理，不做跨进程 stale 清理。
 * P7-B 增加：
 *  - 持久化登记表（filePath）：pid / startedAt / OS startTime / kind / taskId / sessionId；
 *  - 启动时 cleanupStale()：读登记表，PID+启动时间都匹配才 taskkill /T /F；
 *    PID 复用（启动时间不符）绝不误杀；
 *  - 当前进程退出 terminateAll()：按句柄/任务树清理并持久化。
 *
 * 不引原生模块；Windows 用 taskkill /T /F，其他平台退化为 SIGKILL。
 * 测试可注入 getStartTime/isAlive/killPid，避免真的杀进程。
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessRecordView {
  pid: number;
  /** 本 app 登记时间（ms） */
  startedAt: number;
  /** OS 进程启动时间（ms）；null 表示拿不到，stale 清理不杀 */
  startTime: number | null;
  kind: string;
  taskId?: string;
  sessionId?: string;
}

interface ProcessRecord extends ProcessRecordView {
  child?: ChildProcess;
}

export interface ProcessRegistryOptions {
  filePath?: string;
  getStartTime?: (pid: number) => number | null;
  isAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultKillPid(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      /* 已退出/没有权限：继续普通 kill */
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

/** Windows: Get-Process.StartTime 精确到 OS 创建时间；其他平台返回 null（stale 清理保守跳过）。 */
function defaultGetStartTime(pid: number): number | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { $p=Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { '' }`,
      ],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export class ProcessRegistry {
  private records = new Map<number, ProcessRecord>();
  private readonly filePath?: string;
  private readonly getStartTime: (pid: number) => number | null;
  private readonly isAliveFn: (pid: number) => boolean;
  private readonly killPid: (pid: number) => void;

  constructor(opts: ProcessRegistryOptions = {}) {
    this.filePath = opts.filePath;
    this.getStartTime = opts.getStartTime ?? defaultGetStartTime;
    this.isAliveFn = opts.isAlive ?? defaultIsAlive;
    this.killPid = opts.killPid ?? defaultKillPid;
    if (this.filePath) fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  register(
    child: ChildProcess,
    kind: string,
    startedAt = Date.now(),
    meta: { taskId?: string; sessionId?: string } = {},
  ): void {
    const pid = child.pid;
    if (!pid) return;
    this.records.set(pid, {
      pid,
      startedAt,
      startTime: this.getStartTime(pid),
      kind,
      taskId: meta.taskId,
      sessionId: meta.sessionId,
      child,
    });
    child.once("exit", () => this.unregister(pid));
    this.persist();
  }

  /** 无 ChildProcess 句柄（agent/mcp）时按 PID 登记；清理时按 OS 启动时间校验。 */
  registerPid(
    pid: number | null | undefined,
    kind: string,
    meta: { taskId?: string; sessionId?: string } = {},
    startedAt = Date.now(),
  ): void {
    if (!pid) return;
    this.records.set(pid, {
      pid,
      startedAt,
      startTime: this.getStartTime(pid),
      kind,
      taskId: meta.taskId,
      sessionId: meta.sessionId,
    });
    this.persist();
  }

  unregister(pid: number | null | undefined): void {
    if (pid) {
      this.records.delete(pid);
      this.persist();
    }
  }

  /**
   * P7-B killTree 守卫：只有登记过且 OS 启动时间匹配（±2s）才返回 true。
   * 没有登记/拿不到启动时间时返回 true（保留 ChildProcess 句柄 kill 的基线行为）。
   */
  isPidCurrent(pid: number): boolean {
    const rec = this.records.get(pid);
    if (!rec || rec.startTime === null) return true;
    const actual = this.getStartTime(pid);
    if (actual === null) return true;
    return Math.abs(actual - rec.startTime) <= 2000;
  }

  list(): ProcessRecordView[] {
    return [...this.records.values()].map((r) => ({
      pid: r.pid,
      startedAt: r.startedAt,
      startTime: r.startTime,
      kind: r.kind,
      taskId: r.taskId,
      sessionId: r.sessionId,
    }));
  }

  /**
   * 启动时清理残留：只杀 PID 存活且 OS 启动时间匹配（±2s）的记录。
   * 返回统计；不因单条失败中断启动。
   */
  cleanupStale(log?: (msg: string) => void): {
    checked: number;
    killed: number[];
    skipped: number[];
    removed: number;
    fileMissing: boolean;
  } {
    const result = { checked: 0, killed: [] as number[], skipped: [] as number[], removed: 0, fileMissing: false };
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      result.fileMissing = true;
      return result;
    }
    let stored: ProcessRecordView[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) stored = parsed.filter((r) => r && typeof r.pid === "number");
    } catch {
      stored = [];
    }
    for (const rec of stored) {
      result.checked += 1;
      if (rec.pid === process.pid || rec.pid <= 0) {
        result.skipped.push(rec.pid);
        continue;
      }
      const actual = this.getStartTime(rec.pid);
      if (!this.isAliveFn(rec.pid) || actual === null || rec.startTime === null) {
        result.skipped.push(rec.pid);
        continue;
      }
      if (Math.abs(actual - rec.startTime) > 2000) {
        result.skipped.push(rec.pid);
        log?.(`[registry] PID ${rec.pid} 启动时间不匹配（复用），跳过`);
        continue;
      }
      try {
        this.killPid(rec.pid);
        result.killed.push(rec.pid);
        log?.(`[registry] 清理残留 ${rec.kind} pid=${rec.pid} task=${rec.taskId ?? "?"}`);
      } catch {
        result.skipped.push(rec.pid);
      }
    }
    result.removed = result.killed.length + result.skipped.length;
    this.persist();
    return result;
  }

  async terminateAll(timeoutMs = 2000): Promise<{ killed: number[]; timedOut: number[] }> {
    const killed: number[] = [];
    const timedOut: number[] = [];
    for (const rec of [...this.records.values()]) {
      this.records.delete(rec.pid);
      if (rec.child) {
        if (rec.child.exitCode !== null) continue;
        try {
          rec.child.kill();
        } catch {
          /* 已退出/句柄失效 */
        }
        const exited = await waitForExit(rec.child, timeoutMs);
        if (exited) {
          killed.push(rec.pid);
        } else {
          timedOut.push(rec.pid);
          try {
            rec.child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
        }
      } else {
        try {
          this.killPid(rec.pid);
          killed.push(rec.pid);
        } catch {
          timedOut.push(rec.pid);
        }
      }
    }
    this.persist();
    return { killed, timedOut };
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.list(), null, 2) + "\n");
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* 登记失败不能影响启动/会话 */
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
