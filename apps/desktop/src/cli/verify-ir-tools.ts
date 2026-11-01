/**
 * V2.1：IR 工具 Doctor（真实执行，不 mock）。
 *
 * 解析优先级：config/ir-tools.json 显式路径 > BUMIMANG_* 环境变量 > PATH。
 * 对 tshark / capinfos / EvtxECmd / Volatility 记录：
 *   - 绝对路径与来源（config/env/path）
 *   - 版本探测命令、exitCode、stdout/stderr 摘要、耗时、版本号
 *   - PATH_ERROR / VERSION_FAIL / CLI_FAIL 三类错误
 *
 * YARA 只报告“独立工具存在，但未接入 IR 流程”，不并入真实通过结论。
 *
 * 用法：npm run verify:ir-tools
 * 证据：evidence/v3-ir-reality/ir-tools-doctor.json / .txt
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  IR_TOOL_ENV,
  loadIrToolConfig,
  resolveIrTool,
  runCommandSafe,
  type IrToolKey,
  type IrToolResolution,
} from "../main/ir/index.ts";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "evidence", "v3-ir-reality");

function irUserDataDir(): string | undefined {
  const explicit = process.env.BUMIMANG_IR_USER_CONFIG_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const appData = process.env.APPDATA?.trim();
  if (appData) return path.join(appData, "bumimang");
  return undefined;
}

/** 配置查找层级自检：explicit > userData > dev；打包态不读 resources 里的旧配置。 */
function configPriorityChecks(): Array<{ name: string; ok: boolean; detail: string }> {
  const tmp = mkdtempSync(path.join(tmpdir(), "bumimang-ir-config-"));
  try {
    const userDir = path.join(tmp, "user");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      path.join(userDir, "ir-tools.json"),
      JSON.stringify({ tshark: process.execPath }),
      "utf8",
    );
    const resources = path.join(tmp, "resources");
    mkdirSync(path.join(resources, "app-source", "config"), { recursive: true });
    writeFileSync(
      path.join(resources, "app-source", "config", "ir-tools.json"),
      JSON.stringify({ tshark: "Z:/should-not-be-read/tshark.exe" }),
      "utf8",
    );
    const fromUser = loadIrToolConfig({
      repoRoot: ROOT,
      isPackaged: true,
      resourcesPath: resources,
      userDataDir: userDir,
      env: {},
    });
    const explicitFile = path.join(tmp, "explicit.json");
    writeFileSync(explicitFile, JSON.stringify({ tshark: process.execPath }), "utf8");
    const fromExplicit = loadIrToolConfig({
      repoRoot: ROOT,
      isPackaged: true,
      resourcesPath: resources,
      userDataDir: userDir,
      env: { BUMIMANG_IR_TOOLS_CONFIG: explicitFile },
    });
    const noUser = loadIrToolConfig({
      repoRoot: ROOT,
      isPackaged: true,
      resourcesPath: resources,
      userDataDir: path.join(tmp, "none"),
      env: {},
    });
    const fromDev = loadIrToolConfig({
      repoRoot: ROOT,
      isPackaged: false,
      resourcesPath: "",
      userDataDir: path.join(tmp, "none"),
      env: {},
    });
    return [
      {
        name: "explicit > userData",
        ok:
          fromExplicit.source === "explicit" &&
          fromExplicit.tools.tshark === process.execPath &&
          fromUser.source === "userData" &&
          fromUser.tools.tshark === process.execPath,
        detail: `explicit=${fromExplicit.source}/${fromExplicit.path ?? "-"} userData=${fromUser.source}/${fromUser.path ?? "-"}`,
      },
      {
        name: "packaged: no user config -> resources ir-tools.json is NOT read",
        ok: noUser.path === null && noUser.source === null && Object.keys(noUser.tools).length === 0,
        detail: JSON.stringify({ path: noUser.path, source: noUser.source, tools: noUser.tools }),
      },
      {
        name: "dev fallback reads repo config/ir-tools.json",
        ok: fromDev.source === "dev" && fromDev.path === path.join(ROOT, "config", "ir-tools.json"),
        detail: JSON.stringify({ path: fromDev.path, source: fromDev.source }),
      },
    ];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ToolProbe {
  key: IrToolKey;
  label: string;
  required: boolean;
  resolution: IrToolResolution;
  status: "OK" | "NOT_FOUND" | "PATH_ERROR" | "VERSION_FAIL" | "CLI_FAIL" | "AVAILABLE_NOT_INTEGRATED";
  version?: string;
  command?: string;
  argv?: string[];
  exitCode?: number | null;
  durationMs?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  note?: string;
}

export interface NegativeProbe {
  kind: "PATH_ERROR" | "VERSION_FAIL" | "CLI_FAIL";
  command: string;
  argv: string[];
  exitCode: number | null;
  version?: string;
  status: ToolProbe["status"];
  note: string;
}

const LABELS: Record<IrToolKey, { label: string; required: boolean; versionArgs: string[] }> = {
  tshark: { label: "tshark", required: true, versionArgs: ["-v"] },
  capinfos: { label: "capinfos", required: true, versionArgs: ["-v"] },
  text2pcap: { label: "text2pcap", required: false, versionArgs: ["-v"] },
  evtxecmd: { label: "EvtxECmd", required: true, versionArgs: ["--help"] },
  volatility: { label: "Volatility 3", required: true, versionArgs: ["-h"] },
  yaraPython: { label: "YARA Python", required: false, versionArgs: [] },
  yaraScan: { label: "YARA scan wrapper", required: false, versionArgs: [] },
};

function summarize(text: string, max = 500): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function extractVersion(key: IrToolKey, output: string): string | null {
  const patterns: Record<IrToolKey, RegExp[]> = {
    tshark: [/TShark \(Wireshark\) ([\d.]+)/i],
    capinfos: [/Capinfos \(Wireshark\) ([\d.]+)/i],
    text2pcap: [/Text2pcap \(Wireshark\) ([\d.]+)/i],
    evtxecmd: [/EvtxECmd version ([\d.]+)/i, /version ([\d.]+)/i],
    volatility: [/Volatility 3 Framework ([\d.]+)/i, /Volatility ([\d.]+)/i],
    yaraPython: [/Python ([\d.]+)/i],
    yaraScan: [/yara-scan[^\n]*?([\d.]+)/i],
  };
  for (const re of patterns[key] ?? []) {
    const m = re.exec(output);
    if (m) return m[1]!;
  }
  return null;
}

function hasCliMarkers(output: string): boolean {
  return /usage:|unrecognized arguments|unknown option|invalid option|error:.*(argument|option)|-h, --help/i.test(output);
}

export function classifyProbe(input: {
  key: IrToolKey;
  resolution: IrToolResolution;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): { status: ToolProbe["status"]; version?: string; note?: string } {
  if (input.resolution.error || !input.resolution.path) {
    return {
      status: input.resolution.error ? "PATH_ERROR" : "NOT_FOUND",
      ...(input.resolution.error ? { note: input.resolution.error } : {}),
    };
  }
  const combined = `${input.stdout}\n${input.stderr}`;
  const version = extractVersion(input.key, combined) ?? undefined;
  if (version) {
    return {
      status: "OK",
      version,
      ...(input.exitCode !== 0 ? { note: `版本探测 exit=${input.exitCode}，但输出含版本号` } : {}),
    };
  }
  if (input.exitCode !== 0 && hasCliMarkers(combined)) {
    return { status: "CLI_FAIL", note: "版本探测参数不兼容/CLI 用法错误" };
  }
  if (input.exitCode !== 0) {
    return { status: "VERSION_FAIL", note: `版本探测 exit=${input.exitCode}，未找到版本号` };
  }
  return { status: "VERSION_FAIL", note: "版本探测 exit=0，但输出无版本号" };
}

async function probeTool(key: IrToolKey, tools: ReturnType<typeof loadIrToolConfig>["tools"]): Promise<ToolProbe> {
  const meta = LABELS[key];
  const resolution = resolveIrTool({ key, tools });
  const base: ToolProbe = {
    key,
    label: meta.label,
    required: meta.required,
    resolution,
    status: "NOT_FOUND",
  };
  if (key === "yaraPython" || key === "yaraScan") {
    return {
      ...base,
      status: resolution.path ? "AVAILABLE_NOT_INTEGRATED" : resolution.error ? "PATH_ERROR" : "NOT_FOUND",
      note: resolution.path
        ? "YARA 独立工具存在，但平台 IR 流程未接入；不计入真实通过"
        : resolution.error ?? "未找到 YARA 工具",
    };
  }
  if (!resolution.path) {
    return { ...base, ...classifyProbe({ key, resolution, exitCode: null, stdout: "", stderr: "" }) };
  }
  const res = await runCommandSafe(resolution.path, meta.versionArgs, {
    cwd: ROOT,
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  });
  const classified = classifyProbe({
    key,
    resolution,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
  });
  return {
    ...base,
    ...classified,
    command: resolution.path,
    argv: meta.versionArgs,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    stdoutSummary: summarize(res.stdout),
    stderrSummary: summarize(res.stderr),
  };
}

/** 负向探针：只验证分类器能区分三类错误，不伪装成真实 IR 工具。 */
async function negativeProbes(): Promise<NegativeProbe[]> {
  const out: NegativeProbe[] = [];
  const missing: IrToolResolution = {
    key: "tshark",
    path: null,
    source: "config",
    configuredPath: "Z:/definitely-missing/tshark.exe",
    error: "配置路径不存在或不是文件：Z:/definitely-missing/tshark.exe",
  };
  out.push({
    kind: "PATH_ERROR",
    command: missing.configuredPath!,
    argv: [],
    exitCode: null,
    status: "PATH_ERROR",
    note: missing.error!,
  });

  const versionFail = await runCommandSafe(process.execPath, ["-e", "process.exit(7)"], {
    cwd: ROOT,
    timeoutMs: 5000,
    maxOutputBytes: 4096,
  });
  const versionClass = classifyProbe({
    key: "tshark",
    resolution: { key: "tshark", path: process.execPath, source: "path" },
    exitCode: versionFail.exitCode,
    stdout: versionFail.stdout,
    stderr: versionFail.stderr,
  });
  out.push({
    kind: "VERSION_FAIL",
    command: process.execPath,
    argv: ["-e", "process.exit(7)"],
    exitCode: versionFail.exitCode,
    status: versionClass.status,
    note: "NEGATIVE_PROBE：真实进程 exit=7、无版本号；只验证 VERSION_FAIL 分类",
  });

  const cliFail = await runCommandSafe(
    process.execPath,
    ["-e", "console.error('usage: tool [options]\\nerror: unrecognized arguments: --bad'); process.exit(2)"],
    { cwd: ROOT, timeoutMs: 5000, maxOutputBytes: 4096 },
  );
  const cliClass = classifyProbe({
    key: "tshark",
    resolution: { key: "tshark", path: process.execPath, source: "path" },
    exitCode: cliFail.exitCode,
    stdout: cliFail.stdout,
    stderr: cliFail.stderr,
  });
  out.push({
    kind: "CLI_FAIL",
    command: process.execPath,
    argv: ["-e", "usage/unrecognized arguments"],
    exitCode: cliFail.exitCode,
    status: cliClass.status,
    note: "NEGATIVE_PROBE：真实进程输出 usage/unrecognized，exit=2；只验证 CLI_FAIL 分类",
  });
  return out;
}

/** 优先级自检：config > env > PATH；显式路径错误不静默回退。 */
function priorityChecks(): Array<{ name: string; source: string | null; path: string | null; error?: string; ok: boolean }> {
  const exe = process.execPath;
  const missing = "Z:/definitely-missing/ir-tool.exe";
  const fromConfig = resolveIrTool({
    key: "tshark",
    tools: { tshark: exe },
    env: { BUMIMANG_TSHARK: missing },
    find: () => missing,
  });
  const fromEnv = resolveIrTool({
    key: "tshark",
    tools: {},
    env: { BUMIMANG_TSHARK: exe },
    find: () => missing,
  });
  const fromPath = resolveIrTool({
    key: "tshark",
    tools: {},
    env: {},
    find: () => exe,
  });
  const badConfig = resolveIrTool({
    key: "tshark",
    tools: { tshark: missing },
    env: { BUMIMANG_TSHARK: exe },
    find: () => exe,
  });
  return [
    { name: "config > env > PATH (config wins)", source: fromConfig.source, path: fromConfig.path, ok: fromConfig.source === "config" && fromConfig.path === exe },
    { name: "env when config absent", source: fromEnv.source, path: fromEnv.path, ok: fromEnv.source === "env" && fromEnv.path === exe },
    { name: "PATH when config/env absent", source: fromPath.source, path: fromPath.path, ok: fromPath.source === "path" && fromPath.path === exe },
    {
      name: "bad config path is PATH_ERROR, no fallback",
      source: badConfig.source,
      path: badConfig.path,
      error: badConfig.error,
      ok: badConfig.source === "config" && badConfig.path === null && Boolean(badConfig.error),
    },
  ];
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const config = loadIrToolConfig({
    repoRoot: ROOT,
    isPackaged: false,
    resourcesPath: "",
    userDataDir: irUserDataDir(),
  });
  const keys: IrToolKey[] = ["tshark", "capinfos", "text2pcap", "evtxecmd", "volatility", "yaraPython", "yaraScan"];
  const tools: ToolProbe[] = [];
  for (const key of keys) tools.push(await probeTool(key, config.tools));
  const negatives = await negativeProbes();
  const priority = priorityChecks();
  const priorityOk = priority.every((p) => p.ok);
  const configPriority = configPriorityChecks();
  const configPriorityOk = configPriority.every((p) => p.ok);

  const required = tools.filter((t) => t.required);
  const ok = required.every((t) => t.status === "OK");
  const report = {
    generatedAt: new Date().toISOString(),
    configPath: config.path,
    configSource: config.source,
    configError: config.error ?? null,
    priority: "BUMIMANG_IR_TOOLS_CONFIG > userData/ir-tools.json > dev config > BUMIMANG_* env > PATH",
    requiredAllOk: ok,
    priorityOk,
    priorityChecks: priority,
    configPriorityOk,
    configPriorityChecks: configPriority,
    tools,
    negativeProbes: negatives,
    notes: [
      "fixture/mock 通过不等于真实工具通过；本报告只证明工具路径与版本探测。",
      "YARA 独立工具存在但未接入 IR 流程，不计入真实 tshark/EVTX/内存通过。",
      "真实样本解析见 verify:ir-real。",
    ],
  };
  writeFileSync(path.join(OUT_DIR, "ir-tools-doctor.json"), JSON.stringify(report, null, 2), "utf8");
  const lines: string[] = [
    "# IR 工具 Doctor",
    `生成：${report.generatedAt}`,
    `配置：${config.path ?? "(未找到)"} source=${config.source ?? "-"}${config.error ? `；错误=${config.error}` : ""}`,
    `优先级：${report.priority}`,
  ];
  for (const t of tools) {
    lines.push(
      `${t.required ? "[required]" : "[optional]"} ${t.label}  status=${t.status}  source=${t.resolution.source ?? "-"}  ` +
        `path=${t.resolution.path ?? t.resolution.configuredPath ?? "-"}  version=${t.version ?? "-"}  ` +
        `exit=${t.exitCode ?? "-"}  duration=${t.durationMs ?? "-"}ms` +
        (t.note ? `  note=${t.note}` : ""),
    );
  }
  lines.push("", "负向探针（只验证分类器，不伪装真实工具）：");
  for (const n of negatives) {
    lines.push(`- ${n.kind} status=${n.status} exit=${n.exitCode ?? "-"} note=${n.note}`);
  }
  lines.push("", "优先级自检：");
  for (const p of priority) {
    lines.push(`- ${p.name}: source=${p.source ?? "-"} path=${p.path ?? "-"} ok=${p.ok}${p.error ? ` error=${p.error}` : ""}`);
  }
  lines.push("", "配置查找层级自检：");
  for (const p of configPriority) {
    lines.push(`- ${p.name}: ok=${p.ok} ${p.detail}`);
  }
  lines.push("", `requiredAllOk=${ok}`, `priorityOk=${priorityOk}`, `configPriorityOk=${configPriorityOk}`, ...report.notes);
  writeFileSync(path.join(OUT_DIR, "ir-tools-doctor.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  if (!ok || !priorityOk || !configPriorityOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message ?? String(err));
  process.exitCode = 2;
});
