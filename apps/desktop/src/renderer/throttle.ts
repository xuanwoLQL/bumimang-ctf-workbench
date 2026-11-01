/**
 * 流式事件节流 + 聚合（纯逻辑，无 DOM）。
 *
 * 背景（ARCHITECTURE §6 已知坑）：单轮 prompt 约 150 条 `tool_call_update`，
 * 线日志可达 3 MB。若每条事件都触发一次 DOM 写，界面会立刻卡死。
 * 所以：`tool_call_update` 只数不渲染，其余事件按时间窗批量刷一次。
 */
import type { StreamUpdate } from "./contract.ts";

export interface AggregatedStream {
  /** 保留原样的重要事件（tool_call / agent_message / agent_thought / plan / other） */
  items: StreamUpdate[];
  /** 被折叠掉的 tool_call_update 条数 */
  toolCallUpdates: number;
  /** 真实的 tool_call 条数（计数口径：只数 tool_call，不数 tool_call_update） */
  toolCalls: number;
  /** 本批最后一条 status（若有），供窗格右上角显示当前动作状态 */
  lastStatus?: string;
}

export function aggregateStream(updates: StreamUpdate[]): AggregatedStream {
  const items: StreamUpdate[] = [];
  let toolCallUpdates = 0;
  let toolCalls = 0;
  let lastStatus: string | undefined;

  for (const u of updates) {
    if (u.kind === "tool_call_update") {
      toolCallUpdates++;
      if (u.status) lastStatus = u.status;
      continue; // 折叠，不逐条进 items
    }
    if (u.kind === "tool_call") toolCalls++;
    items.push(u);
  }

  return { items, toolCallUpdates, toolCalls, lastStatus };
}

export type ScheduleFn = (fn: () => void, delayMs: number) => unknown;

export interface ThrottlerOptions {
  /** 最多每隔多少毫秒刷一次 */
  windowMs: number;
  now?: () => number;
  /** 调度器；浏览器默认 setTimeout，测试里可注入 fake 调度器 */
  schedule?: ScheduleFn;
  onFlush: (batch: StreamUpdate[]) => void;
}

export class StreamThrottler {
  private buffer: StreamUpdate[] = [];
  private timer: unknown = null;
  private lastFlush = -Infinity;
  private readonly now: () => number;
  private readonly schedule: ScheduleFn;
  private readonly onFlush: (batch: StreamUpdate[]) => void;
  readonly windowMs: number;

  constructor(opts: ThrottlerOptions) {
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.onFlush = opts.onFlush;
  }

  push(u: StreamUpdate): void {
    this.buffer.push(u);
    const elapsed = this.now() - this.lastFlush;
    if (elapsed >= this.windowMs) {
      // 距上次刷新已满一个窗口：立即刷，保持低延迟。
      this.flush();
      return;
    }
    if (this.timer == null) {
      const wait = this.windowMs - elapsed;
      this.timer = this.schedule(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.lastFlush = this.now();
    this.onFlush(batch);
  }
}
