/**
 * 黑板台账的纯逻辑（无 DOM）：四类视图分区 + 冲突检测。
 *
 * 冲突检测的诚实边界：契约的 `FactView` 没有「挑战了哪条事实」的外键，
 * 所以系统只能做两种判定——
 *   1. 同一归一化内容出现多条 → 并列冲突组；
 *   2. 单条 `challenged` 事实 → 单独高亮。
 * 更细的语义冲突配对（「X 成立」vs「X 不成立」）需要契约加字段，走 docs/requests/。
 */
import type { FactView } from "../contract.ts";

export function normalizeContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ConflictGroup {
  content: string;
  facts: FactView[];
}

/** 按归一化内容分组，返回「同一内容被多条事实占据」的组（即并列冲突）。 */
export function findConflicts(facts: FactView[]): ConflictGroup[] {
  const map = new Map<string, FactView[]>();
  for (const f of facts) {
    const k = normalizeContent(f.content);
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push(f);
  }
  const groups: ConflictGroup[] = [];
  for (const [content, arr] of map) {
    if (arr.length > 1) groups.push({ content, facts: arr });
  }
  return groups;
}

/** 单独被质疑的事实（challenged），即使找不到它的对手也要高亮。 */
export function isChallenged(f: FactView): boolean {
  return f.status === "challenged";
}

/** 冲突组里是否涉及某条事实。 */
export function inConflict(conflicts: ConflictGroup[], factId: string): boolean {
  return conflicts.some((g) => g.facts.some((f) => f.id === factId));
}
