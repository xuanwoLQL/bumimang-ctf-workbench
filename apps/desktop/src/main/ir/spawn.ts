/**
 * V2-P0-4：IR 外部工具的安全执行层。
 *
 * 约束：
 *  - 参数数组 + `shell:false`，绝不拼命令行字符串；
 *  - 工具路径可配置（env），否则在 PATH 中查找；不硬编码盘符；
 *  - cwd 由调用方限定在任务目录；超时、stdout/stderr 上限；
 *  - 每次命令由上层写 audit；这里只返回结构化结果。
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export interface IrCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface IrCommandResult {
  command: string;
  argv: string[];
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/** 在 PATH 中查找可执行文件；不做 shell 调用。 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!name.trim()) return null;
  if (name.includes("/") || name.includes("\\")) {
    try {
      return statSync(name).isFile() ? path.resolve(name) : null;
    } catch {
      return null;
    }
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const pathext = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const candidates = [name];
  if (!path.extname(name)) {
    for (const ext of pathext) candidates.push(`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`);
  }
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/** env 覆盖优先；否则 PATH 查找。返回 null 表示未安装。 */
export function resolveTool(
  envVar: string,
  defaultName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env[envVar]?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  return findExecutable(defaultName, env);
}

function capAppend(current: { text: string; bytes: number; truncated: boolean }, chunk: Buffer, max: number): void {
  if (current.truncated) return;
  const remain = max - current.bytes;
  if (remain <= 0) {
    current.truncated = true;
    return;
  }
  if (chunk.length > remain) {
    current.text += chunk.subarray(0, remain).toString("utf8");
    current.bytes += remain;
    current.truncated = true;
    return;
  }
  current.text += chunk.toString("utf8");
  current.bytes += chunk.length;
}

/**
 * 执行一个外部工具。永不抛错：启动失败/超时/输出超限都返回可读结果。
 * 超时后先 kill；2 秒后仍未退出则放弃等待（不阻塞分析）。
 */
export function runCommandSafe(command: string, args: string[], opts: IrCommandOptions): Promise<IrCommandResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT);
  const maxOutput = Math.max(1024, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
  const started = Date.now();
  return new Promise((resolve) => {
    const stdout = { text: "", bytes: 0, truncated: false };
    const stderr = { text: "", bytes: 0, truncated: false };
    let settled = false;
    let timeoutFired = false;
    let child;
    const finish = (exitCode: number | null, timedOut: boolean, errorText?: string): void => {
      if (settled) return;
      settled = true;
      if (errorText) stderr.text += errorText;
      resolve({
        command,
        argv: args.slice(),
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
      });
    };
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(null, false, `启动失败：${(err as Error).message}`);
      return;
    }
    const timer = setTimeout(() => {
      timeoutFired = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // 给进程 2 秒退出；否则强杀并返回 timedOut。
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(null, true, `超时 ${timeoutMs}ms，已终止`);
      }, 2000);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => capAppend(stdout, chunk, maxOutput));
    child.stderr?.on("data", (chunk: Buffer) => capAppend(stderr, chunk, maxOutput));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(null, timeoutFired, `执行错误：${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code, timeoutFired, timeoutFired ? `超时 ${timeoutMs}ms，已终止` : undefined);
    });
    child.stdin?.end();
  });
}

/** 流式计算文件 sha256（不把大文件读进内存）。 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
