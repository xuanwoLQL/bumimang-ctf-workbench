import type {
  PlatformChallengeView,
  PlatformStateView,
  TaskStatus,
  TaskView,
} from "../contract.ts";

export type ChallengeFilter = "all" | "web" | "pwn" | "crypto" | "reverse" | "misc" | "unknown";
export type ChallengeSort = "speed" | "points" | "order";

export const FILTER_ORDER: ChallengeFilter[] = [
  "all",
  "web",
  "pwn",
  "crypto",
  "reverse",
  "misc",
  "unknown",
];

export const FILTER_LABEL: Record<ChallengeFilter, string> = {
  all: "全部",
  web: "Web",
  pwn: "Pwn",
  crypto: "Crypto",
  reverse: "Reverse",
  misc: "Misc",
  unknown: "其他",
};

export interface ChallengeCardView extends PlatformChallengeView {
  index: number;
  task: TaskView | null;
  taskStatus: TaskStatus | null;
  statusLabel: string;
  statusClass: string;
  runningSessions: number;
  totalSessions: number;
}

export interface CompetitionStats {
  accessible: number;
  solved: number;
  unsolved: number;
  points: number;
  running: number;
}

export function challengeStatus(
  challenge: PlatformChallengeView,
  task: TaskView | null,
  runningSessions: number,
): { label: string; cls: string } {
  if (challenge.isSolved || task?.status === "solved") {
    return { label: "已完成", cls: "is-solved" };
  }
  if (runningSessions > 0) {
    return { label: "解题中", cls: "is-running" };
  }
  if (task?.status === "solving") return { label: "已暂停", cls: "is-paused" };
  if (task?.status === "abandoned") return { label: "已放弃", cls: "is-abandoned" };
  return { label: "待开始", cls: "is-open" };
}

export function buildCompetitionStats(
  platform: PlatformStateView | null,
  tasks: TaskView[],
): CompetitionStats {
  const challenges = platform?.challenges ?? [];
  const solved = challenges.filter((challenge) => challenge.isSolved).length;
  return {
    accessible: challenges.length,
    solved,
    unsolved: Math.max(0, challenges.length - solved),
    points: challenges.filter((challenge) => challenge.isSolved).reduce((sum, challenge) => sum + challenge.points, 0),
    running: tasks.reduce((sum, task) => sum + (task.runningSessions ?? 0), 0),
  };
}

export function buildChallengeCards(
  platform: PlatformStateView | null,
  tasks: TaskView[],
  filter: ChallengeFilter,
  query: string,
  selectedId: string | null,
  sort: ChallengeSort = "speed",
): ChallengeCardView[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const q = query.trim().toLowerCase();
  const cards = (platform?.challenges ?? [])
    .map((challenge, index) => {
      const task = challenge.taskId ? taskById.get(challenge.taskId) ?? null : null;
      const runningSessions = task?.runningSessions ?? 0;
      const status = challengeStatus(challenge, task, runningSessions);
      const card: ChallengeCardView = {
        ...challenge,
        index: index + 1,
        task,
        taskStatus: task?.status ?? null,
        statusLabel: status.label,
        statusClass: status.cls,
        runningSessions,
        totalSessions: task?.totalSessions ?? 0,
      };
      return { card, selected: challenge.id === selectedId };
    })
    .filter(({ card }) => filter === "all" || card.category === filter || (filter === "unknown" && card.category === "unknown"))
    .filter(({ card }) => {
      if (!q) return true;
      return (
        card.title.toLowerCase().includes(q) ||
        card.direction.toLowerCase().includes(q) ||
        card.id.toLowerCase().includes(q) ||
        card.description.toLowerCase().includes(q)
      );
    })
    .map(({ card }) => card);

  cards.sort((a, b) => {
    if (a.isSolved !== b.isSolved) return a.isSolved ? 1 : -1;
    if (sort === "speed") {
      if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
      if (a.points !== b.points) return b.points - a.points;
    } else if (sort === "points") {
      if (a.points !== b.points) return b.points - a.points;
      if (a.solvedCount !== b.solvedCount) return b.solvedCount - a.solvedCount;
    }
    return a.index - b.index;
  });
  return cards;
}

export function categoryCounts(
  platform: PlatformStateView | null,
): Record<ChallengeFilter, number> {
  const counts: Record<ChallengeFilter, number> = {
    all: platform?.challenges.length ?? 0,
    web: 0,
    pwn: 0,
    crypto: 0,
    reverse: 0,
    misc: 0,
    unknown: 0,
  };
  for (const challenge of platform?.challenges ?? []) {
    const category =
      challenge.category in counts ? (challenge.category as ChallengeFilter) : "unknown";
    counts[category] += 1;
  }
  return counts;
}

export function roleForAgent(agentId: string): "lead" | "verify" | "recon" | "scribe" {
  if (agentId === "claude") return "verify";
  if (agentId === "opencode") return "recon";
  if (agentId === "dsh") return "scribe";
  return "lead";
}

export function formatRelative(ms: number | null): string {
  if (!ms) return "从未";
  const delta = Date.now() - ms;
  if (delta < 15_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  return `${Math.floor(delta / 3_600_000)} 小时前`;
}

export function countdownText(endAt: string | null, now = Date.now()): string {
  if (!endAt) return "--:--:--";
  const end = Date.parse(endAt.replace(" ", "T"));
  if (!Number.isFinite(end)) return "--:--:--";
  const remain = Math.max(0, end - now);
  const totalSeconds = Math.floor(remain / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function platformStatusLabel(status: PlatformStateView["status"]): string {
  switch (status) {
    case "connected":
      return "平台已连接";
    case "syncing":
      return "正在同步";
    case "connecting":
      return "正在连接";
    case "offline":
      return "离线缓存";
    case "needs_login":
      return "等待登录";
    case "error":
      return "连接错误";
    default:
      return "未配置平台";
  }
}
