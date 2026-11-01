/**
 * 黑板 —— 唯一的共享状态源。
 *
 * 架构约束（docs/ARCHITECTURE.md）：
 *  - §8.1 唯一写入者：只有主进程持有写连接，agent 侧不直连 SQLite
 *  - §8.3 三写一事务：每次写操作在单个事务内追加 events、更新视图表、追写 audit 索引
 *  - §10  哈希链只在 events 上保证一次；audit 是检索索引，不另存链
 *
 * 存储用 Node 内置 node:sqlite（免原生编译，队友机器不需要构建工具链）。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { backupBeforeOpen, restoreFromBackup } from "../reliability/backup.ts";
import type { AnswerSpec, AnswerType } from "../../../../../packages/shared-protocol/events.ts";

export interface HealthChain {
  ok: boolean;
  brokenAt?: number;
}

/**
 * P7-A：events 哈希链连续性检查（只看 prev_hash，不重算历史 hash，避免旧格式误报）。
 * 返回首个断点的事件 id；空 events 视为 ok。
 */
export function checkEventChain(db: DatabaseSync): HealthChain {
  const rows = db
    .prepare("SELECT id, prev_hash, hash FROM events ORDER BY id ASC")
    .all() as Array<{ id: number; prev_hash: string | null; hash: string }>;
  let prev: string | null = null;
  for (const row of rows) {
    if ((row.prev_hash ?? null) !== prev) return { ok: false, brokenAt: Number(row.id) };
    prev = row.hash;
  }
  return { ok: true };
}

export type EventKind =
  | "fact"
  | "deadend"
  | "intent"
  | "claim"
  | "release"
  | "answer"
  | "approval"
  | "note"
  | "lifecycle";

export interface DeadEnd {
  id: string;
  task_id: string;
  description: string;
  scope: string | null;
  reopen_when: string | null;
  created_by: string | null;
  created_at: number;
}

export interface Lease {
  resource: string;
  task_id: string | null;
  holder: string;
  acquired_at: number;
  expires_at: number;
  renew_count: number;
}

/** 授权目标（WP4 / P4-A）。P4-A 只存值，不做解析/匹配/策略判定。 */
export interface Target {
  id: string;
  task_id: string;
  value: string;
  kind: string;
  status: string;
  notes: string | null;
  created_at: number;
}

const TARGET_KINDS = new Set(["host", "cidr", "url"]);
const TARGET_STATUSES = new Set(["unknown", "alive", "owned"]);
const MAX_TARGET_VALUE = 256;
const MAX_TARGET_NOTES = 4096;

/** P5-A：flag 候选持久化（v3）。 */
export type FlagEvidence = "E0" | "E1" | "E2";
export type FlagStatus = "new" | "confirmed" | "false_positive";

export interface FlagCandidate {
  id: string;
  task_id: string;
  value: string;
  source_session: string | null;
  witness: string | null;
  evidence: string;
  first_seen: number;
  status: string;
  submitted_at: number | null;
  submit_status: string | null;
  submit_detail: string | null;
  /** V2-P0-2：候选类型/归一化值/spec 标识；旧候选为 null。 */
  answer_type: string | null;
  normalized_value: string | null;
  spec_id: string | null;
}

export interface FlagSource {
  id: number;
  candidate_id: string;
  session_id: string | null;
  witness: string | null;
  evidence: string;
  seen_at: number;
  /** V2-P0-2：来源位置；旧来源为 null。 */
  line: number | null;
  byte_offset: number | null;
  source_kind: string | null;
  source_path: string | null;
}

function evidenceRank(evidence: string): number {
  return evidence === "E2" ? 2 : evidence === "E1" ? 1 : 0;
}

/** 事件/审计只记答案哈希，不写明文（V2 约束）。 */
function answerValueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isFlagEvidence(value: unknown): value is FlagEvidence {
  return value === "E0" || value === "E1" || value === "E2";
}

export interface Intent {
  id: string;
  task_id: string;
  description: string;
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
}

export interface EventRow {
  id: number;
  ts: number;
  session_id: string | null;
  kind: EventKind;
  subject: string | null;
  body: string;
  witness: string | null;
  hash: string;
  prev_hash: string | null;
}

export interface LeaseResult {
  status: "WON" | "LOST";
  holder?: string;
  expiresAt?: number;
}

const LEASE_TTL_MS = 5 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  subject     TEXT,
  body        TEXT NOT NULL,
  witness     TEXT,
  hash        TEXT NOT NULL,
  prev_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(subject, id);

-- audit 是检索索引，不是第二份日志，不存哈希链（§10）
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  session_id  TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  event_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, ts);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  brief           TEXT NOT NULL,
  status          TEXT NOT NULL,
  answer          TEXT,
  answer_evidence TEXT,
  solved_by       TEXT,
  created_at      INTEGER NOT NULL,
  category        TEXT NOT NULL DEFAULT 'unknown',
  priority        INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS facts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL,
  evidence   TEXT NOT NULL,
  scope      TEXT,
  witness    TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS dead_ends (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  description TEXT NOT NULL,
  scope       TEXT,
  reopen_when TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  resource    TEXT PRIMARY KEY,
  task_id     TEXT,
  holder      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  renew_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL,
  claimed_by  TEXT,
  claimed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS intent_resources (
  intent_id TEXT NOT NULL,
  resource  TEXT NOT NULL,
  PRIMARY KEY (intent_id, resource)
);

CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  action         TEXT NOT NULL,
  context        TEXT NOT NULL,
  intent_summary TEXT,
  risk           TEXT NOT NULL,
  rule           TEXT,
  status         TEXT NOT NULL,
  decided_by     TEXT,
  decided_at     INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  role        TEXT NOT NULL,
  tier        TEXT NOT NULL,
  acp_session TEXT,
  status      TEXT NOT NULL,
  pid         INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_ms INTEGER,
  tool_calls  INTEGER DEFAULT 0,
  tokens_note TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0
);
`;

export class Blackboard {
  private db: DatabaseSync;
  private lastHash: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** P7-A：打开时检查的 events 链健康；断裂只告警，不截断。 */
  private healthChain: HealthChain = { ok: true };

  private constructor(db: DatabaseSync) {
    this.db = db;
    const row = this.db
      .prepare("SELECT hash FROM events ORDER BY id DESC LIMIT 1")
      .get() as { hash?: string } | undefined;
    this.lastHash = row?.hash ?? null;
  }

  getHealthChain(): HealthChain {
    return { ...this.healthChain };
  }

  /**
   * P7-A：打开/迁移前备份；迁移失败自动恢复并抛可读错误，不静默重置。
   * 临时目录默认不备份（避免 verify 套件写满 %APPDATA%）；显式 backup:true 时强制。
   */
  static open(dbPath: string, options: { backup?: boolean } = {}): Blackboard {
    const isTemp =
      dbPath !== ":memory:" &&
      (() => {
        const abs = resolve(dbPath);
        const tmp = resolve(tmpdir());
        return abs === tmp || abs.startsWith(`${tmp}${sep}`);
      })();
    const wantBackup = options.backup ?? (dbPath !== ":memory:" && !isTemp);
    let backupPath: string | null = null;
    if (wantBackup) {
      try {
        backupPath = backupBeforeOpen(dbPath);
      } catch (err) {
        process.stderr.write(
          `[board] 启动备份失败（继续尝试打开）：${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    try {
      return Blackboard.openRaw(dbPath);
    } catch (err) {
      const original = err instanceof Error ? err.message : String(err);
      if (backupPath) {
        try {
          restoreFromBackup(backupPath, dbPath);
          throw new Error(`board.db 打开/迁移失败，已从备份恢复（${backupPath}）：${original}`);
        } catch (restoreErr) {
          if (restoreErr instanceof Error && restoreErr.message.includes("已从备份恢复")) {
            throw restoreErr;
          }
          throw new Error(
            `board.db 打开/迁移失败，且恢复备份失败（${backupPath}）：${original}；恢复错误：${
              restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
            }`,
          );
        }
      }
      throw new Error(`board.db 打开/迁移失败（无可用备份）：${original}`);
    }
  }

  private static openRaw(dbPath: string): Blackboard {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    // R20：老库补 hidden 列（session.remove 的只隐藏标记）。
    // CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，必须显式迁移。
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "hidden")) {
      db.exec("ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    }
    // P1-A：任务表 v1 迁移。CREATE TABLE IF NOT EXISTS 同样不会给老表补列，
    // 因此按列检查逐列 ALTER；用 user_version 标记已迁移，重复打开幂等。
    // 旧任务默认 category=unknown / priority=0 / archived=0，updated_at 回填 created_at。
    db.exec("BEGIN IMMEDIATE");
    try {
      const taskCols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
      );
      const taskMigrations: Array<{ column: string; ddl: string }> = [
        { column: "category", ddl: "ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'unknown'" },
        { column: "priority", ddl: "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0" },
        { column: "archived", ddl: "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0" },
        { column: "updated_at", ddl: "ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0" },
      ];
      for (const m of taskMigrations) {
        if (!taskCols.has(m.column)) db.exec(m.ddl);
      }
      db.exec("UPDATE tasks SET updated_at = created_at WHERE updated_at = 0");
      const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionRow?.user_version ?? 0) < 1) db.exec("PRAGMA user_version = 1");

      // P4-A：v2 迁移。必须在同一次 open() 里紧接着 v1 执行（旧库 v0 → v1 → v2），
      // 不能跳版本；重复打开时按列/表存在性判断，不重复 ALTER/CREATE。
      // 只存目标数据，不做策略判定/目标解析/代理（P4-B/C/D）。
      const versionV1 = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionV1?.user_version ?? 0) < 2) {
        const v2TaskCols = new Set(
          (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (!v2TaskCols.has("deny_targets")) {
          db.exec("ALTER TABLE tasks ADD COLUMN deny_targets TEXT NOT NULL DEFAULT '[]'");
        }
        if (!v2TaskCols.has("scope_notes")) {
          db.exec("ALTER TABLE tasks ADD COLUMN scope_notes TEXT");
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS targets (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            value       TEXT NOT NULL,
            kind        TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'unknown',
            notes       TEXT,
            created_at  INTEGER NOT NULL,
            UNIQUE(task_id, value)
          );
          CREATE INDEX IF NOT EXISTS idx_targets_task ON targets(task_id, created_at);
        `);
        db.exec("PRAGMA user_version = 2");
      }

      // P5-A：v3 迁移。必须在 v2 之后同一次 open() 内执行（v0/v1/v2 都走 v1→v2→v3，
      // 不跳版本）；按表/列存在性判断，重复打开不重复 CREATE/ALTER。
      // 只做持久化，不做确认/误报/导出/提交/backfill。
      const versionV2 = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionV2?.user_version ?? 0) < 3) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS flag_candidates (
            id             TEXT PRIMARY KEY,
            task_id        TEXT NOT NULL,
            value          TEXT NOT NULL,
            source_session TEXT,
            witness        TEXT,
            evidence       TEXT NOT NULL DEFAULT 'E0',
            first_seen     INTEGER NOT NULL,
            status         TEXT NOT NULL DEFAULT 'new',
            submitted_at   INTEGER,
            submit_status  TEXT,
            submit_detail  TEXT,
            UNIQUE(task_id, value)
          );
          CREATE INDEX IF NOT EXISTS idx_flag_candidates_task
            ON flag_candidates(task_id, first_seen);
          CREATE TABLE IF NOT EXISTS flag_sources (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            candidate_id  TEXT NOT NULL,
            session_id    TEXT,
            witness       TEXT,
            evidence      TEXT NOT NULL DEFAULT 'E0',
            seen_at       INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_flag_sources_candidate
            ON flag_sources(candidate_id, seen_at);
        `);
        const v3TaskCols = new Set(
          (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        const v3Migrations: Array<{ column: string; ddl: string }> = [
          { column: "points", ddl: "ALTER TABLE tasks ADD COLUMN points INTEGER NOT NULL DEFAULT 0" },
          { column: "submit_mode", ddl: "ALTER TABLE tasks ADD COLUMN submit_mode TEXT NOT NULL DEFAULT 'manual'" },
          { column: "submit_command", ddl: "ALTER TABLE tasks ADD COLUMN submit_command TEXT" },
          { column: "submit_timeout_ms", ddl: "ALTER TABLE tasks ADD COLUMN submit_timeout_ms INTEGER NOT NULL DEFAULT 30000" },
        ];
        for (const m of v3Migrations) {
          if (!v3TaskCols.has(m.column)) db.exec(m.ddl);
        }
        db.exec("PRAGMA user_version = 3");
      }

      // P9-D：v4 迁移。只建 AWD/IR 强类型表；**不背填/不迁移现有 facts**，
      // 模型读取仍走 facts（MVP）；这些表留给真实数据量/查询需求启用。
      // 与 v1/v2/v3 一样，v0/v1/v2/v3 都在同一次 open() 内走到 v4，不跳版本。
      const versionV3 = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionV3?.user_version ?? 0) < 4) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS awd_rounds (
            id           TEXT PRIMARY KEY,
            task_id      TEXT NOT NULL,
            round_no     INTEGER NOT NULL,
            started_at   INTEGER,
            ended_at     INTEGER,
            duration_ms  INTEGER,
            state        TEXT,
            UNIQUE(task_id, round_no)
          );
          CREATE INDEX IF NOT EXISTS idx_awd_rounds_task ON awd_rounds(task_id, round_no);

          CREATE TABLE IF NOT EXISTS awd_services (
            id               TEXT PRIMARY KEY,
            task_id          TEXT NOT NULL,
            name             TEXT NOT NULL,
            host             TEXT,
            port             INTEGER,
            status           TEXT,
            owner_session_id TEXT,
            patch_status     TEXT,
            UNIQUE(task_id, name)
          );
          CREATE INDEX IF NOT EXISTS idx_awd_services_task ON awd_services(task_id);

          CREATE TABLE IF NOT EXISTS awd_patches (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            service_id  TEXT,
            vuln        TEXT,
            status      TEXT,
            evidence    TEXT,
            witness     TEXT,
            updated_at  INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_awd_patches_task ON awd_patches(task_id, updated_at);

          CREATE TABLE IF NOT EXISTS awd_checks (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            round_no    INTEGER,
            item        TEXT,
            status      TEXT,
            evidence    TEXT,
            checked_at  INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_awd_checks_task ON awd_checks(task_id, round_no);

          CREATE TABLE IF NOT EXISTS awd_attacks (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            attacker    TEXT,
            target      TEXT,
            action      TEXT,
            result      TEXT,
            evidence    TEXT,
            at          INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_awd_attacks_task ON awd_attacks(task_id, at);

          CREATE TABLE IF NOT EXISTS ir_timeline (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            at          INTEGER,
            source      TEXT,
            event       TEXT,
            impact      TEXT,
            evidence    TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_ir_timeline_task ON ir_timeline(task_id, at);

          CREATE TABLE IF NOT EXISTS ir_questions (
            id          TEXT PRIMARY KEY,
            task_id     TEXT NOT NULL,
            question    TEXT,
            status      TEXT,
            answer      TEXT,
            evidence    TEXT,
            updated_at  INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_ir_questions_task ON ir_questions(task_id, updated_at);
        `);
        db.exec("PRAGMA user_version = 4");
      }

      // V2-P0-2：v5 迁移。只加列，不背填；旧任务/旧候选保持 NULL。
      //  - tasks.answer_spec：AnswerSpec JSON（损坏时读取层回落默认 flag 规则）
      //  - flag_candidates：answer_type / normalized_value / spec_id
      //  - flag_sources：line / byte_offset / source_kind / source_path
      const versionV4 = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionV4?.user_version ?? 0) < 5) {
        const taskColsV5 = new Set(
          (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (!taskColsV5.has("answer_spec")) {
          db.exec("ALTER TABLE tasks ADD COLUMN answer_spec TEXT");
        }
        const candColsV5 = new Set(
          (db.prepare("PRAGMA table_info(flag_candidates)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        for (const m of [
          { column: "answer_type", ddl: "ALTER TABLE flag_candidates ADD COLUMN answer_type TEXT" },
          { column: "normalized_value", ddl: "ALTER TABLE flag_candidates ADD COLUMN normalized_value TEXT" },
          { column: "spec_id", ddl: "ALTER TABLE flag_candidates ADD COLUMN spec_id TEXT" },
        ]) {
          if (!candColsV5.has(m.column)) db.exec(m.ddl);
        }
        const sourceColsV5 = new Set(
          (db.prepare("PRAGMA table_info(flag_sources)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        for (const m of [
          { column: "line", ddl: "ALTER TABLE flag_sources ADD COLUMN line INTEGER" },
          { column: "byte_offset", ddl: "ALTER TABLE flag_sources ADD COLUMN byte_offset INTEGER" },
          { column: "source_kind", ddl: "ALTER TABLE flag_sources ADD COLUMN source_kind TEXT" },
          { column: "source_path", ddl: "ALTER TABLE flag_sources ADD COLUMN source_path TEXT" },
        ]) {
          if (!sourceColsV5.has(m.column)) db.exec(m.ddl);
        }
        db.exec("PRAGMA user_version = 5");
      }

      // V2-P0-5：v6 迁移。tasks.allowed_actions（JSON 数组，缺省空 = 不限制）。
      const versionV5 = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      if (Number(versionV5?.user_version ?? 0) < 6) {
        const colsV6 = new Set(
          (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        if (!colsV6.has("allowed_actions")) {
          db.exec("ALTER TABLE tasks ADD COLUMN allowed_actions TEXT NOT NULL DEFAULT '[]'");
        }
        db.exec("PRAGMA user_version = 6");
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务可能已因迁移失败自动回滚 */
      }
      try {
        db.close();
      } catch {
        /* 关闭失败也要抛原始错误 */
      }
      throw err;
    }
    const bb = new Blackboard(db);
    bb.healthChain = checkEventChain(db);
    if (!bb.healthChain.ok) {
      process.stderr.write(
        `[board] events 哈希链断裂 at event ${bb.healthChain.brokenAt}；只告警，不自动截断\n`,
      );
    }
    return bb;
  }

  close(): void {
    this.db.close();
  }

  /**
   * 所有写入都串行化到一条队列上 —— §8.1 唯一写入者的落地方式。
   * 这样即便多个会话的回调并发到达，也不会撞 SQLite 写锁。
   */
  private serial<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private hashOf(prev: string | null, payload: string): string {
    return createHash("sha256").update(`${prev ?? ""}‖${payload}`).digest("hex");
  }

  /** 三写一事务：events + 视图表 + audit 索引，任一失败整体回滚。 */
  private tx<T>(fn: (tx: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    // A6：事务内 appendEvent 会先推进内存链尾；若后面某条语句失败回滚，
    // 链尾必须退回事务前的值——否则下一条事件的 prev_hash 指向一个不存在的事件。
    const hashBefore = this.lastHash;
    try {
      const out = fn(this.db);
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.lastHash = hashBefore;
      throw err;
    }
  }

  private appendEvent(
    tx: DatabaseSync,
    e: {
      sessionId: string | null;
      kind: EventKind;
      subject: string | null;
      body: unknown;
      witness?: string | null;
    },
  ): number {
    const ts = Date.now();
    const body = JSON.stringify(e.body);
    const prev = this.lastHash;
    // A6：witness 必须进哈希输入——E2 证据恰恰靠 witness，改 witness 不断链 =
    // 链条形同虚设。注意这会改变哈希格式，历史库的旧链不能按新算法校验
    // （当前没有链校验器，接受；若将来加校验器需要带版本）。
    const hash = this.hashOf(prev, `${ts}|${e.sessionId ?? ""}|${e.kind}|${e.subject ?? ""}|${e.witness ?? ""}|${body}`);
    const info = tx
      .prepare(
        `INSERT INTO events (ts, session_id, kind, subject, body, witness, hash, prev_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ts, e.sessionId, e.kind, e.subject, body, e.witness ?? null, hash, prev);
    this.lastHash = hash;
    return Number(info.lastInsertRowid);
  }

  private appendAudit(
    tx: DatabaseSync,
    a: { sessionId: string | null; actor: string; action: string; detail?: unknown; eventId?: number },
  ): void {
    tx.prepare(
      `INSERT INTO audit (ts, session_id, actor, action, detail, event_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      a.sessionId,
      a.actor,
      a.action,
      a.detail === undefined ? null : JSON.stringify(a.detail),
      a.eventId ?? null,
    );
  }

  // ---------- 任务 ----------

  createTask(input: {
    title: string;
    brief: string;
    category?: string;
    priority?: number;
    /** V2-P0-3：题目分值；缺省 0。 */
    points?: number;
    /** V2-P0-2：答案格式；缺省 NULL（读取层回落默认 flag 规则）。 */
    answerSpec?: AnswerSpec;
  }): { id: string } {
    const id = `task-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const category = input.category ?? "unknown";
    const priority = input.priority ?? 0;
    const points = Number.isInteger(input.points) && (input.points as number) >= 0 ? (input.points as number) : 0;
    const answerSpec = input.answerSpec ? JSON.stringify(input.answerSpec) : null;
    this.tx((tx) => {
      tx.prepare(
        `INSERT INTO tasks (id, title, brief, status, created_at, category, priority, archived, updated_at, points, answer_spec)
         VALUES (?, ?, ?, 'open', ?, ?, ?, 0, ?, ?, ?)`,
      ).run(id, input.title, input.brief, now, category, priority, now, points, answerSpec);
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: id,
        body: { what: "task.created", title: input.title, category, priority, points, answerSpec: answerSpec !== null },
      });
      this.appendAudit(tx, { sessionId: null, actor: "human", action: "task.create", detail: { id }, eventId: eid });
    });
    return { id };
  }

  /**
   * V2-P0-3：人工更新任务的分值/优先级。只改调度输入；不碰状态/答案。
   * 返回更新后的字段；非法输入抛可读错误。
   */
  updateTaskScheduling(input: { taskId: string; priority?: number; points?: number }): {
    priority: number;
    points: number;
  } {
    const row = this.getTask(input.taskId);
    if (!row) throw new Error(`任务不存在：${input.taskId}`);
    if (input.priority !== undefined) {
      if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) {
        throw new Error("priority 必须是 0–100 的整数");
      }
    }
    if (input.points !== undefined) {
      if (!Number.isInteger(input.points) || input.points < 0 || input.points > 1_000_000) {
        throw new Error("points 必须是 0–1000000 的整数");
      }
    }
    const priority = input.priority ?? row.priority;
    const points = input.points ?? row.points;
    return this.tx((tx) => {
      tx.prepare("UPDATE tasks SET priority = ?, points = ?, updated_at = ? WHERE id = ?").run(
        priority,
        points,
        Date.now(),
        input.taskId,
      );
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: input.taskId,
        body: { what: "task.scheduling", priority, points },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "task.update",
        detail: { taskId: input.taskId, priority, points },
        eventId: eid,
      });
      return { priority, points };
    });
  }

  // ---------- 授权目标（P4-A）----------

  /** 某任务的目标列表（按创建时间升序；只做数据，不做范围判定）。 */
  listTargets(taskId: string): Target[] {
    return this.db
      .prepare(
        `SELECT id, task_id, value, kind, status, notes, created_at
         FROM targets WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId) as never;
  }

  /** 读单个目标；taskId 一并过滤，避免跨任务误更新/误删。 */
  getTarget(taskId: string, targetId: string): Target | undefined {
    return this.db
      .prepare(
        `SELECT id, task_id, value, kind, status, notes, created_at
         FROM targets WHERE task_id = ? AND id = ?`,
      )
      .get(taskId, targetId) as never;
  }

  /**
   * 任务的 denyTargets / scopeNotes（P4-A 只读）。
   * deny_targets 是 JSON 数组；损坏时返回空数组而不是让快照炸掉。
   */
  getTaskScope(taskId: string):
    | { denyTargets: string[]; scopeNotes: string | null; allowedActions: string[] }
    | undefined {
    const row = this.db
      .prepare("SELECT deny_targets, scope_notes, allowed_actions FROM tasks WHERE id = ?")
      .get(taskId) as
      | { deny_targets?: string | null; scope_notes?: string | null; allowed_actions?: string | null }
      | undefined;
    if (!row) return undefined;
    let denyTargets: string[] = [];
    try {
      const parsed = JSON.parse(String(row.deny_targets ?? "[]")) as unknown;
      if (Array.isArray(parsed)) {
        denyTargets = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      denyTargets = [];
    }
    let allowedActions: string[] = [];
    try {
      const parsed = JSON.parse(String(row.allowed_actions ?? "[]")) as unknown;
      if (Array.isArray(parsed)) {
        allowedActions = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      allowedActions = [];
    }
    return {
      denyTargets,
      scopeNotes: typeof row.scope_notes === "string" ? row.scope_notes : null,
      allowedActions,
    };
  }

  /**
   * V2-P0-5：更新任务范围数据。只写 tasks 的三列并留痕；不自动启用 scope、
   * 不改 targets、不执行任何网络动作。
   */
  updateTaskScope(input: {
    taskId: string;
    denyTargets?: string[];
    scopeNotes?: string | null;
    allowedActions?: string[];
  }): { denyTargets: string[]; scopeNotes: string | null; allowedActions: string[] } {
    const row = this.getTask(input.taskId);
    if (!row) throw new Error(`任务不存在：${input.taskId}`);
    const cleanList = (list: string[] | undefined, label: string): string[] | undefined => {
      if (list === undefined) return undefined;
      if (!Array.isArray(list)) throw new Error(`${label} 必须是数组`);
      if (list.length > 200) throw new Error(`${label} 最多 200 项`);
      return list.map((v, i) => {
        if (typeof v !== "string" || !v.trim() || v.includes("\0") || v.length > 512) {
          throw new Error(`${label}[${i}] 必须是 1–512 字符的非空字符串`);
        }
        return v.trim();
      });
    };
    const denyTargets = cleanList(input.denyTargets, "denyTargets");
    const allowedActions = cleanList(input.allowedActions, "allowedActions");
    if (input.scopeNotes !== undefined && input.scopeNotes !== null) {
      if (typeof input.scopeNotes !== "string" || input.scopeNotes.length > 4096) {
        throw new Error("scopeNotes 最多 4096 字符");
      }
    }
    const current = this.getTaskScope(input.taskId)!;
    const next = {
      denyTargets: denyTargets ?? current.denyTargets,
      scopeNotes: input.scopeNotes !== undefined ? input.scopeNotes : current.scopeNotes,
      allowedActions: allowedActions ?? current.allowedActions,
    };
    return this.tx((tx) => {
      tx.prepare(
        "UPDATE tasks SET deny_targets = ?, scope_notes = ?, allowed_actions = ?, updated_at = ? WHERE id = ?",
      ).run(
        JSON.stringify(next.denyTargets),
        next.scopeNotes,
        JSON.stringify(next.allowedActions),
        Date.now(),
        input.taskId,
      );
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: input.taskId,
        body: {
          what: "task.scope",
          denyTargets: next.denyTargets,
          scopeNotes: next.scopeNotes,
          allowedActions: next.allowedActions,
        },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "task.scope.update",
        detail: {
          taskId: input.taskId,
          denyTargets: next.denyTargets,
          allowedActions: next.allowedActions,
        },
        eventId: eid,
      });
      return next;
    });
  }

  /**
   * 新增目标（P4-A）。
   *
   * 数据约束：value 非空、≤256、不含 NUL；kind 只允许 host/cidr/url；
   * notes ≤4096；同一任务内 value 唯一。**不做** IP/CIDR 解析（P4-B）。
   */
  addTarget(input: {
    taskId: string;
    value: string;
    kind?: string;
    notes?: string;
  }): { ok: boolean; id?: string; error?: string } {
    const taskId = input.taskId;
    if (typeof taskId !== "string" || !taskId) return { ok: false, error: "taskId 不能为空" };
    if (typeof input.value !== "string") return { ok: false, error: "目标 value 必须是字符串" };
    const value = input.value.trim();
    if (!value) return { ok: false, error: "目标 value 不能为空" };
    if (value.length > MAX_TARGET_VALUE) {
      return { ok: false, error: `目标 value 过长（>${MAX_TARGET_VALUE}）` };
    }
    if (value.includes("\0")) return { ok: false, error: "目标 value 不能包含 NUL 字符" };
    const kind = input.kind ?? "host";
    if (!TARGET_KINDS.has(kind)) {
      return { ok: false, error: `目标 kind 非法：${JSON.stringify(kind)}（允许：host, cidr, url）` };
    }
    if (
      input.notes !== undefined &&
      (typeof input.notes !== "string" || input.notes.length > MAX_TARGET_NOTES)
    ) {
      return { ok: false, error: `目标 notes 非法或过长（>${MAX_TARGET_NOTES}）` };
    }
    const notes = input.notes === undefined ? null : input.notes;
    return this.tx((tx) => {
      const task = tx.prepare("SELECT id, archived FROM tasks WHERE id = ?").get(taskId) as
        | { id: string; archived: number }
        | undefined;
      if (!task) return { ok: false, error: `任务不存在：${taskId}` };
      if (Number(task.archived)) return { ok: false, error: `任务已归档：${taskId}` };
      const dup = tx
        .prepare("SELECT id FROM targets WHERE task_id = ? AND value = ?")
        .get(taskId, value) as { id: string } | undefined;
      if (dup) return { ok: false, error: `目标已存在：${value}` };
      const id = `target-${randomUUID().slice(0, 8)}`;
      const now = Date.now();
      tx.prepare(
        `INSERT INTO targets (id, task_id, value, kind, status, notes, created_at)
         VALUES (?, ?, ?, ?, 'unknown', ?, ?)`,
      ).run(id, taskId, value, kind, notes, now);
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: taskId,
        body: { what: "target.added", targetId: id, value, kind, status: "unknown" },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "target.add",
        detail: { taskId, targetId: id, value, kind },
        eventId: eid,
      });
      return { ok: true, id };
    });
  }

  /** 更新目标状态/备注（P4-A）；targetId 必须属于该 taskId。 */
  updateTarget(input: {
    taskId: string;
    targetId: string;
    status?: string;
    notes?: string;
  }): { ok: boolean; error?: string } {
    const taskId = input.taskId;
    const targetId = input.targetId;
    if (typeof taskId !== "string" || !taskId) return { ok: false, error: "taskId 不能为空" };
    if (typeof targetId !== "string" || !targetId) return { ok: false, error: "targetId 不能为空" };
    if (input.status !== undefined && !TARGET_STATUSES.has(input.status)) {
      return {
        ok: false,
        error: `目标 status 非法：${JSON.stringify(input.status)}（允许：unknown, alive, owned）`,
      };
    }
    if (
      input.notes !== undefined &&
      (typeof input.notes !== "string" || input.notes.length > MAX_TARGET_NOTES)
    ) {
      return { ok: false, error: `目标 notes 非法或过长（>${MAX_TARGET_NOTES}）` };
    }
    return this.tx((tx) => {
      const row = tx
        .prepare(
          `SELECT id, task_id, value, kind, status, notes, created_at
           FROM targets WHERE task_id = ? AND id = ?`,
        )
        .get(taskId, targetId) as Target | undefined;
      if (!row) return { ok: false, error: `目标不存在或不属于该任务：${targetId}` };
      const status = input.status ?? row.status;
      const notes = input.notes === undefined ? row.notes : input.notes;
      tx.prepare("UPDATE targets SET status = ?, notes = ? WHERE task_id = ? AND id = ?").run(
        status,
        notes,
        taskId,
        targetId,
      );
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: taskId,
        body: { what: "target.updated", targetId, value: row.value, status, notes },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "target.update",
        detail: { taskId, targetId, status, notes },
        eventId: eid,
      });
      return { ok: true };
    });
  }

  /** 移除目标（P4-A）；targetId 必须属于该 taskId。 */
  removeTarget(input: { taskId: string; targetId: string }): { ok: boolean; error?: string } {
    const taskId = input.taskId;
    const targetId = input.targetId;
    if (typeof taskId !== "string" || !taskId) return { ok: false, error: "taskId 不能为空" };
    if (typeof targetId !== "string" || !targetId) return { ok: false, error: "targetId 不能为空" };
    return this.tx((tx) => {
      const row = tx
        .prepare(
          `SELECT id, task_id, value, kind, status, notes, created_at
           FROM targets WHERE task_id = ? AND id = ?`,
        )
        .get(taskId, targetId) as Target | undefined;
      if (!row) return { ok: false, error: `目标不存在或不属于该任务：${targetId}` };
      tx.prepare("DELETE FROM targets WHERE task_id = ? AND id = ?").run(taskId, targetId);
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: taskId,
        body: { what: "target.removed", targetId, value: row.value },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "target.remove",
        detail: { taskId, targetId, value: row.value },
        eventId: eid,
      });
      return { ok: true };
    });
  }

  // ---------- flag 候选（P5-A v3） ----------

  /**
   * 添加/命中一个 flag 候选。同任务同 value 只保留一条；新来源的证据等级
   * 只会向上覆盖（E0 < E1 < E2），不会降级。调用方随后用 addFlagSource 记来源。
   */
  addFlagCandidate(input: {
    taskId: string;
    value: string;
    sessionId?: string | null;
    witness?: string | null;
    evidence?: FlagEvidence;
    status?: FlagStatus;
    now?: number;
    /** V2-P0-2：答案类型/归一化值/spec 标识；旧调用方可缺席。 */
    answerType?: AnswerType;
    normalizedValue?: string;
    specId?: string;
  }): { candidate: FlagCandidate; created: boolean } {
    const taskId = input.taskId;
    if (typeof taskId !== "string" || !taskId) throw new Error("taskId 不能为空");
    const value = String(input.value ?? "").trim();
    if (!value || value.includes("\0") || value.length > 4096) {
      throw new Error("flag value 非空、<=4096 且不能含 NUL");
    }
    const evidence: FlagEvidence = input.evidence ?? "E0";
    if (!isFlagEvidence(evidence)) throw new Error(`非法证据等级：${String(evidence)}`);
    const status: FlagStatus = input.status ?? "new";
    if (status !== "new" && status !== "confirmed" && status !== "false_positive") {
      throw new Error(`非法候选状态：${String(status)}`);
    }
    const sessionId = input.sessionId ?? null;
    const witness = input.witness ?? null;
    const now = input.now ?? Date.now();
    const answerType = input.answerType ?? null;
    const normalizedValue = input.normalizedValue?.trim() || null;
    const specId = input.specId ?? null;
    return this.tx((tx) => {
      const task = tx.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as
        | { id?: string }
        | undefined;
      if (!task) throw new Error(`任务不存在：${taskId}`);
      const existing = tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE task_id = ? AND value = ?`,
        )
        .get(taskId, value) as FlagCandidate | undefined;
      if (existing) {
        const nextRank = evidenceRank(evidence);
        const oldRank = evidenceRank(existing.evidence);
        const nextWitness =
          nextRank > oldRank || existing.witness === null ? (witness ?? existing.witness) : existing.witness;
        const nextSource = existing.source_session ?? sessionId;
        const nextType = existing.answer_type ?? answerType;
        const nextNormalized = existing.normalized_value ?? normalizedValue;
        const nextSpec = existing.spec_id ?? specId;
        if (
          nextRank > oldRank ||
          nextWitness !== existing.witness ||
          nextSource !== existing.source_session ||
          nextType !== existing.answer_type ||
          nextNormalized !== existing.normalized_value ||
          nextSpec !== existing.spec_id
        ) {
          tx.prepare(
            `UPDATE flag_candidates
             SET evidence = ?, witness = ?, source_session = ?,
                 answer_type = ?, normalized_value = ?, spec_id = ?
             WHERE task_id = ? AND value = ?`,
          ).run(
            nextRank > oldRank ? evidence : existing.evidence,
            nextWitness,
            nextSource,
            nextType,
            nextNormalized,
            nextSpec,
            taskId,
            value,
          );
        }
        const candidate = tx
          .prepare(
            `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                    submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
             FROM flag_candidates WHERE task_id = ? AND value = ?`,
          )
          .get(taskId, value) as FlagCandidate;
        return { candidate, created: false };
      }
      const id = `flag-${randomUUID().slice(0, 8)}`;
      tx.prepare(
        `INSERT INTO flag_candidates
          (id, task_id, value, source_session, witness, evidence, first_seen, status,
           submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(id, taskId, value, sessionId, witness, evidence, now, status, answerType, normalizedValue, specId);
      // 事件只记 candidateId/哈希/类型，不写答案明文（V2 约束）。
      this.appendEvent(tx, {
        sessionId,
        kind: "lifecycle",
        subject: taskId,
        body: {
          what: "flag.candidate",
          candidateId: id,
          evidence,
          valueHash: answerValueHash(value),
          answerType,
        },
      });
      const candidate = tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(id) as FlagCandidate;
      return { candidate, created: true };
    });
  }

  /** 某任务的候选，最新 first_seen 在前（旧 flagCandidate 语义取最近一条）。 */
  listFlagCandidates(taskId: string): FlagCandidate[] {
    return this.db
      .prepare(
        `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
         FROM flag_candidates WHERE task_id = ?
         ORDER BY first_seen DESC, id DESC`,
      )
      .all(taskId) as unknown as FlagCandidate[];
  }

  getFlagCandidate(taskId: string, value: string): FlagCandidate | undefined {
    return this.db
      .prepare(
        `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
         FROM flag_candidates WHERE task_id = ? AND value = ?`,
      )
      .get(taskId, value) as FlagCandidate | undefined;
  }

  /** P5-C：按候选 id 查（Hub 校验 candidateId 归属用；不做跨任务猜测）。 */
  getFlagCandidateById(candidateId: string): FlagCandidate | undefined {
    return this.db
      .prepare(
        `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
         FROM flag_candidates WHERE id = ?`,
      )
      .get(candidateId) as FlagCandidate | undefined;
  }

  /**
   * P5-C：人工确认/误报只改候选状态，不删除候选、不写 task.answer。
   *
   * 状态没变化时幂等返回（不重复写 events/audit）；变化时写一条 lifecycle
   * 事件（`flag.confirm` / `flag.reject`）和 audit 索引。事件/审计只记
   * candidateId/status，不写 flag 明文（flag 值已经在 P5-A 的候选事件里）。
   */
  updateFlagCandidateStatus(
    candidateId: string,
    status: "confirmed" | "false_positive",
    actor = "human",
  ): FlagCandidate {
    if (status !== "confirmed" && status !== "false_positive") {
      throw new Error(`非法候选状态：${String(status)}`);
    }
    return this.tx((tx) => {
      const candidate = tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(candidateId) as FlagCandidate | undefined;
      if (!candidate) throw new Error(`flag 候选不存在：${candidateId}`);
      if (candidate.status !== status) {
        tx.prepare(`UPDATE flag_candidates SET status = ? WHERE id = ?`).run(status, candidateId);
        const action = status === "confirmed" ? "flag.confirm" : "flag.reject";
        const eid = this.appendEvent(tx, {
          sessionId: null,
          kind: "lifecycle",
          subject: candidate.task_id,
          body: { what: action, candidateId, status },
        });
        this.appendAudit(tx, {
          sessionId: null,
          actor,
          action,
          detail: { taskId: candidate.task_id, candidateId, status },
          eventId: eid,
        });
      }
      return tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(candidateId) as FlagCandidate;
    });
  }

  /**
   * P5-C：记录一次导出（只记格式/数量，不记导出内容/flag 明文）。
   *
   * 导出本身不写文件；这里只写一条 lifecycle 事件 + audit 索引，满足
   * 「导出可审计」且不把 flag 明文再抄进 events。
   */
  recordFlagExport(input: { taskId: string | null; format: string; count: number }): number {
    return this.tx((tx) => {
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: input.taskId,
        body: { what: "flag.export", taskId: input.taskId, format: input.format, count: input.count },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "flag.export",
        detail: { taskId: input.taskId, format: input.format, count: input.count },
        eventId: eid,
      });
      return eid;
    });
  }

  /**
   * P5-D：记录人工提交/预览状态。
   *
   * 只更新候选的 submitted_at / submit_status；不写 task.answer、不执行命令、
   * 不调用平台 API。事件/审计只记 candidateId/status，不写 flag 明文。
   */
  updateFlagSubmitStatus(
    candidateId: string,
    status: "manual" | "dry_run" | "ok" | "failed" | "timeout",
    submittedAt = Date.now(),
    detail: string | null = null,
  ): FlagCandidate {
    if (!["manual", "dry_run", "ok", "failed", "timeout"].includes(status)) {
      throw new Error(`非法提交状态：${String(status)}`);
    }
    const at = Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now();
    return this.tx((tx) => {
      const candidate = tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(candidateId) as FlagCandidate | undefined;
      if (!candidate) throw new Error(`flag 候选不存在：${candidateId}`);
      tx.prepare(
        `UPDATE flag_candidates
         SET submitted_at = ?, submit_status = ?, submit_detail = ?
         WHERE id = ?`,
      ).run(at, status, detail ? detail.slice(0, 400) : null, candidateId);
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: candidate.task_id,
        body: { what: "flag.submit", candidateId, status },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "flag.submit",
        detail: { taskId: candidate.task_id, candidateId, status },
        eventId: eid,
      });
      return tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(candidateId) as FlagCandidate;
    });
  }

  /**
   * 记一条来源。完全相同的 source（candidate + session + witness + evidence + 位置）
   * 只保留第一条，避免流式重复扫描把来源表刷爆；不同会话/不同证据/不同位置会新增来源。
   */
  addFlagSource(
    candidateId: string,
    input: {
      sessionId?: string | null;
      witness?: string | null;
      evidence?: FlagEvidence;
      seenAt?: number;
      line?: number | null;
      offset?: number | null;
      sourceKind?: string | null;
      sourcePath?: string | null;
    } = {},
  ): { source: FlagSource; created: boolean } {
    const evidence: FlagEvidence = input.evidence ?? "E0";
    if (!isFlagEvidence(evidence)) throw new Error(`非法证据等级：${String(evidence)}`);
    const sessionId = input.sessionId ?? null;
    const witness = input.witness ?? null;
    const seenAt = input.seenAt ?? Date.now();
    const line = Number.isInteger(input.line) ? (input.line as number) : null;
    const byteOffset = Number.isInteger(input.offset) ? (input.offset as number) : null;
    const sourceKind = input.sourceKind ?? null;
    const sourcePath = input.sourcePath ?? null;
    return this.tx((tx) => {
      const candidate = tx
        .prepare(
          `SELECT id, task_id, value, source_session, witness, evidence, first_seen, status,
                  submitted_at, submit_status, submit_detail, answer_type, normalized_value, spec_id
           FROM flag_candidates WHERE id = ?`,
        )
        .get(candidateId) as FlagCandidate | undefined;
      if (!candidate) throw new Error(`flag 候选不存在：${candidateId}`);
      const existing = tx
        .prepare(
          `SELECT id, candidate_id, session_id, witness, evidence, seen_at,
                  line, byte_offset, source_kind, source_path
           FROM flag_sources WHERE candidate_id = ? ORDER BY seen_at ASC, id ASC`,
        )
        .all(candidateId) as unknown as FlagSource[];
      const same = existing.find(
        (s) =>
          s.session_id === sessionId &&
          s.witness === witness &&
          s.evidence === evidence &&
          s.line === line &&
          s.byte_offset === byteOffset &&
          s.source_kind === sourceKind &&
          s.source_path === sourcePath,
      );
      if (same) return { source: same, created: false };
      const info = tx
        .prepare(
          `INSERT INTO flag_sources
             (candidate_id, session_id, witness, evidence, seen_at, line, byte_offset, source_kind, source_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(candidateId, sessionId, witness, evidence, seenAt, line, byteOffset, sourceKind, sourcePath);
      const id = Number(info.lastInsertRowid);
      this.appendEvent(tx, {
        sessionId,
        kind: "lifecycle",
        subject: candidate.task_id,
        body: {
          what: "flag.source",
          candidateId,
          valueHash: answerValueHash(candidate.value),
          sessionId,
          witness,
          evidence,
          seenAt,
          line,
          offset: byteOffset,
          sourceKind,
          sourcePath,
        },
      });
      const nextRank = evidenceRank(evidence);
      const oldRank = evidenceRank(candidate.evidence);
      if (nextRank > oldRank || candidate.witness === null || candidate.source_session === null) {
        tx.prepare(
          `UPDATE flag_candidates
           SET evidence = ?, witness = ?, source_session = ?
           WHERE id = ?`,
        ).run(
          nextRank > oldRank ? evidence : candidate.evidence,
          nextRank > oldRank || candidate.witness === null ? (witness ?? candidate.witness) : candidate.witness,
          candidate.source_session ?? sessionId,
          candidateId,
        );
      }
      const source = tx
        .prepare(
          `SELECT id, candidate_id, session_id, witness, evidence, seen_at,
                  line, byte_offset, source_kind, source_path
           FROM flag_sources WHERE id = ?`,
        )
        .get(id) as FlagSource;
      return { source, created: true };
    });
  }

  listFlagSources(candidateId: string): FlagSource[] {
    return this.db
      .prepare(
        `SELECT id, candidate_id, session_id, witness, evidence, seen_at,
                line, byte_offset, source_kind, source_path
         FROM flag_sources WHERE candidate_id = ? ORDER BY seen_at ASC, id ASC`,
      )
      .all(candidateId) as unknown as FlagSource[];
  }

  /** P5-A：改回非 solved 时清空该任务的候选/来源（保留既有 task.setStatus 语义）。 */
  clearFlagCandidates(taskId: string): void {
    this.tx((tx) => {
      tx.prepare(
        "DELETE FROM flag_sources WHERE candidate_id IN (SELECT id FROM flag_candidates WHERE task_id = ?)",
      ).run(taskId);
      tx.prepare("DELETE FROM flag_candidates WHERE task_id = ?").run(taskId);
    });
  }

  // ---------- 会话 ----------

  insertSession(s: {
    id: string;
    taskId: string;
    agent: string;
    role: string;
    tier: string;
    status: string;
  }): void {
    this.tx((tx) => {
      tx.prepare(
        `INSERT INTO sessions (id, task_id, agent, role, tier, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(s.id, s.taskId, s.agent, s.role, s.tier, s.status, Date.now());
      const eid = this.appendEvent(tx, {
        sessionId: s.id,
        kind: "lifecycle",
        subject: s.taskId,
        body: { what: "session.created", agent: s.agent, role: s.role, tier: s.tier },
      });
      this.appendAudit(tx, { sessionId: s.id, actor: "system", action: "session.create", eventId: eid });
    });
  }

  setAcpSession(sessionId: string, acpSession: string, pid?: number): void {
    this.tx((tx) => {
      tx.prepare(`UPDATE sessions SET acp_session = ?, pid = ? WHERE id = ?`).run(
        acpSession,
        pid ?? null,
        sessionId,
      );
      this.appendAudit(tx, { sessionId, actor: "system", action: "session.acp_bound", detail: { acpSession } });
    });
  }

  setSessionStatus(sessionId: string, status: string): void {
    this.tx((tx) => {
      tx.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
      if (status === "failed" || status === "stopped" || status === "blocked" || status === "done") {
        tx.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(Date.now(), sessionId);
      }
      const eid = this.appendEvent(tx, {
        sessionId,
        kind: "lifecycle",
        subject: null,
        body: { what: "session.status", status },
      });
      this.appendAudit(tx, { sessionId, actor: "system", action: "session.status", detail: { status }, eventId: eid });
    });
  }

  /**
   * A4（Codex 评审）：审批落库。之前 approvals 表只有 schema、0 条 INSERT——
   * 重启后无法回答「谁批准了什么」。INSERT OR REPLACE 让请求创建与裁决更新
   * 走同一条路；同时写一条 kind=approval 的黑板事件（有哈希链与审计索引）。
   */
  upsertApproval(v: {
    id: string;
    taskId: string;
    sessionId: string;
    action: string;
    command: string | null;
    intentSummary: string | null;
    risk: string;
    rule: string | null;
    status: string;
    decidedBy: string | null;
    decidedAt: number | null;
    createdAt: number;
    /** V2-P0-5：结构化目标（仅 no-out-of-scope 命中时有值）。 */
    scopeTarget?: { kind: string; value: string } | null;
  }): void {
    this.tx((tx) => {
      tx.prepare(
        `INSERT OR REPLACE INTO approvals
           (id, task_id, session_id, action, context, intent_summary, risk, rule, status, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        v.id,
        v.taskId,
        v.sessionId,
        v.action,
        v.command ?? "",
        v.intentSummary,
        v.risk,
        v.rule,
        v.status,
        v.decidedBy,
        v.decidedAt,
        v.createdAt,
      );
      const eid = this.appendEvent(tx, {
        sessionId: v.sessionId,
        kind: "approval",
        subject: v.taskId,
        body: { id: v.id, status: v.status, decidedBy: v.decidedBy },
      });
      this.appendAudit(tx, {
        sessionId: v.sessionId,
        actor: v.decidedBy ?? "policy",
        action: v.status === "pending" ? "approval.request" : `approval.${v.status}`,
        detail: {
          id: v.id,
          action: v.action,
          command: v.command,
          rule: v.rule,
          risk: v.risk,
          scopeTarget: v.scopeTarget ?? null,
          decidedBy: v.decidedBy,
          status: v.status,
        },
        eventId: eid,
      });
    });
  }

  /**
   * 会话隐藏标记（R20 session.remove）。
   *
   * 只隐藏、不删除：行与 stream.jsonl 都保留，`hidden=1` 的会话不出现在
   * `listSessions` 里。恢复 = 把这里翻回 false。
   */
  setSessionHidden(sessionId: string, hidden: boolean): void {
    this.tx((tx) => {
      tx.prepare(`UPDATE sessions SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, sessionId);
      const eid = this.appendEvent(tx, {
        sessionId,
        kind: "lifecycle",
        subject: null,
        body: { what: hidden ? "session.hidden" : "session.restored" },
      });
      this.appendAudit(tx, {
        sessionId,
        actor: "human",
        action: hidden ? "session.hide" : "session.restore",
        eventId: eid,
      });
    });
  }

  getSession(sessionId: string): { id: string; task_id: string; role: string; tier: string; status: string } | undefined {
    return this.db.prepare(`SELECT id, task_id, role, tier, status FROM sessions WHERE id = ?`).get(sessionId) as never;
  }

  /**
   * 已用过的最大会话序号。
   *
   * 会话 id 形如 `s1`、`s2`。Lane B 实测发现的坑：如果序号只在进程内从 1 数，
   * 同一个 board.db 被第二次进程打开时 `session.start` 会撞 `s1` 主键。
   * 所以序号必须从库里算，而不是从进程内计数器算。
   */
  maxSessionSeq(): number {
    const rows = this.db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>;
    let max = 0;
    for (const r of rows) {
      const m = /^s(\d+)$/.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  countToolCalls(sessionId: string): void {
    this.db
      .prepare(`UPDATE sessions SET tool_calls = COALESCE(tool_calls, 0) + 1 WHERE id = ?`)
      .run(sessionId);
  }

  // ---------- 死路 ----------

  declareDeadEnd(input: {
    taskId: string;
    sessionId: string | null;
    description: string;
    scope?: string | null;
    reopenWhen?: string | null;
  }): { id: string } {
    const id = `de-${randomUUID().slice(0, 8)}`;
    this.tx((tx) => {
      tx.prepare(
        `INSERT INTO dead_ends (id, task_id, description, scope, reopen_when, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.taskId,
        input.description,
        input.scope ?? null,
        input.reopenWhen ?? null,
        input.sessionId,
        Date.now(),
      );
      const eid = this.appendEvent(tx, {
        sessionId: input.sessionId,
        kind: "deadend",
        subject: input.taskId,
        body: { description: input.description, scope: input.scope ?? null },
      });
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.sessionId ?? "human",
        action: "deadend.declare",
        detail: { id, description: input.description },
        eventId: eid,
      });
    });
    return { id };
  }

  listDeadEnds(taskId: string): DeadEnd[] {
    return this.db
      .prepare(`SELECT * FROM dead_ends WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as unknown as DeadEnd[];
  }

  // ---------- 事实 ----------

  submitFact(input: {
    taskId: string;
    sessionId: string | null;
    content: string;
    witness?: string | null;
    /** E0 只有自述；E1 有 witness 但未回溯；E2 已回溯。M1 只做 E0/E1 判定。 */
    evidence?: "E0" | "E1" | "E2";
  }): { id: string; evidence: string } {
    const id = `fact-${randomUUID().slice(0, 8)}`;
    const evidence: "E0" | "E1" | "E2" =
      input.evidence ?? (input.witness ? "E1" : "E0");
    const status = evidence === "E2" ? "verified" : "candidate";
    this.tx((tx) => {
      const now = Date.now();
      tx.prepare(
        `INSERT INTO facts (id, task_id, content, status, evidence, scope, witness, created_by, created_at, updated_at, decided_by)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(id, input.taskId, input.content, status, evidence, input.witness ?? null, input.sessionId, now, now, evidence === "E2" ? "rule" : null);
      const eid = this.appendEvent(tx, {
        sessionId: input.sessionId,
        kind: "fact",
        subject: input.taskId,
        body: { content: input.content, evidence },
        witness: input.witness ?? null,
      });
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.sessionId ?? "human",
        action: "fact.submit",
        detail: { id, evidence, status },
        eventId: eid,
      });
    });
    return { id, evidence };
  }

  listFacts(taskId: string): Array<{
    id: string;
    content: string;
    status: string;
    evidence: string;
    witness: string | null;
    created_by: string | null;
    created_at: number;
  }> {
    return this.db
      .prepare(
        `SELECT id, content, status, evidence, witness, created_by, created_at FROM facts
         WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as never;
  }

  // ---------- 意图 ----------

  openIntent(input: { taskId: string; sessionId: string; description: string }): { id: string } {
    const id = `in-${randomUUID().slice(0, 8)}`;
    this.tx((tx) => {
      tx.prepare(
        `INSERT INTO intents (id, task_id, description, status, claimed_by, claimed_at)
         VALUES (?, ?, ?, 'claimed', ?, ?)`,
      ).run(id, input.taskId, input.description, input.sessionId, Date.now());
      const eid = this.appendEvent(tx, {
        sessionId: input.sessionId,
        kind: "intent",
        subject: input.taskId,
        body: { description: input.description },
      });
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.sessionId,
        action: "intent.open",
        detail: { id },
        eventId: eid,
      });
    });
    return { id };
  }

  abandonIntentsOf(sessionId: string): number {
    return this.tx((tx) => {
      const rows = tx
        .prepare(`SELECT id FROM intents WHERE claimed_by = ? AND status = 'claimed'`)
        .all(sessionId) as Array<{ id: string }>;
      for (const r of rows) {
        tx.prepare(`UPDATE intents SET status = 'abandoned' WHERE id = ?`).run(r.id);
        this.appendAudit(tx, { sessionId, actor: "system", action: "intent.abandon", detail: { id: r.id } });
      }
      return rows.length;
    });
  }

  /**
   * 按任务放弃 stale 意图（P1-D 启动恢复）。
   *
   * stale = 仍 claimed，但领取者不是本进程里的活跃会话（会话已终态、或根本不
   * 存在）。只处理 `task_id = ?`，绝不把 A 的意图在 B 的恢复里清掉。
   */
  abandonStaleIntents(taskId: string): number {
    return this.tx((tx) => {
      const rows = tx
        .prepare(
          `SELECT id FROM intents
           WHERE task_id = ? AND status = 'claimed'
             AND (claimed_by IS NULL OR claimed_by NOT IN (
               SELECT id FROM sessions
               WHERE status NOT IN ('blocked', 'stopped', 'failed', 'done')
             ))`,
        )
        .all(taskId) as Array<{ id: string }>;
      for (const r of rows) {
        tx.prepare(`UPDATE intents SET status = 'abandoned' WHERE id = ?`).run(r.id);
        this.appendAudit(tx, {
          sessionId: null,
          actor: "system",
          action: "intent.abandon",
          detail: { id: r.id, taskId, reason: "启动恢复：领取者已不在" },
        });
      }
      return rows.length;
    });
  }

  listIntents(taskId: string): Intent[] {
    return this.db
      .prepare(`SELECT * FROM intents WHERE task_id = ? ORDER BY claimed_at ASC`)
      .all(taskId) as unknown as Intent[];
  }

  // ---------- 租约 —— §8.4 intent 是语义层，lease 是资源层 ----------

  acquireLease(input: {
    resource: string;
    sessionId: string;
    taskId: string;
    ttlMs?: number;
  }): LeaseResult {
    const now = Date.now();
    const ttl = input.ttlMs ?? LEASE_TTL_MS;
    return this.tx((tx) => {
      const cur = tx.prepare(`SELECT * FROM leases WHERE resource = ?`).get(input.resource) as
        | Lease
        | undefined;
      // 过期即视为空闲，顺手回收 —— §8.6
      if (cur && cur.expires_at > now && cur.holder !== input.sessionId) {
        return { status: "LOST" as const, holder: cur.holder, expiresAt: cur.expires_at };
      }
      const expiresAt = now + ttl;
      if (cur && cur.holder === input.sessionId) {
        tx.prepare(`UPDATE leases SET expires_at = ?, renew_count = renew_count + 1 WHERE resource = ?`).run(
          expiresAt,
          input.resource,
        );
      } else {
        tx.prepare(
          `INSERT INTO leases (resource, task_id, holder, acquired_at, expires_at, renew_count)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(resource) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at, task_id = excluded.task_id, renew_count = 0`,
        ).run(input.resource, input.taskId, input.sessionId, now, expiresAt);
      }
      const eid = this.appendEvent(tx, {
        sessionId: input.sessionId,
        kind: "claim",
        subject: input.taskId,
        body: { resource: input.resource, expiresAt },
      });
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.sessionId,
        action: "lease.acquire",
        detail: { resource: input.resource },
        eventId: eid,
      });
      return { status: "WON" as const, holder: input.sessionId, expiresAt };
    });
  }

  releaseLease(resource: string, sessionId: string | null, reason: string): boolean {
    return this.tx((tx) => {
      const cur = tx.prepare(`SELECT * FROM leases WHERE resource = ?`).get(resource) as Lease | undefined;
      if (!cur) return false;
      // A2（Codex 评审）：必须校验 holder——之前任何知道资源名的会话都能放掉别人的租约。
      // sessionId=null 是系统清理路径（重启收尾等），保留旁路；会话路径一律按 holder 校验。
      if (sessionId !== null && cur.holder !== sessionId) return false;
      tx.prepare(`DELETE FROM leases WHERE resource = ?`).run(resource);
      const eid = this.appendEvent(tx, {
        sessionId,
        kind: "release",
        subject: cur.task_id,
        body: { resource, reason, previousHolder: cur.holder },
      });
      this.appendAudit(tx, {
        sessionId,
        actor: sessionId ?? "system",
        action: "lease.release",
        detail: { resource, reason },
        eventId: eid,
      });
      return true;
    });
  }

  /** §8.6：崩溃时立即释放该会话持有的全部租约，不等过期。 */
  releaseAllLeasesOf(sessionId: string, reason: string): string[] {
    return this.tx((tx) => {
      const rows = tx.prepare(`SELECT * FROM leases WHERE holder = ?`).all(sessionId) as unknown as Lease[];
      for (const r of rows) {
        tx.prepare(`DELETE FROM leases WHERE resource = ?`).run(r.resource);
        const eid = this.appendEvent(tx, {
          sessionId,
          kind: "release",
          subject: r.task_id,
          body: { resource: r.resource, reason },
        });
        this.appendAudit(tx, {
          sessionId,
          actor: "system",
          action: "lease.release",
          detail: { resource: r.resource, reason },
          eventId: eid,
        });
      }
      return rows.map((r) => r.resource);
    });
  }

  /**
   * 按任务释放 stale 租约（P1-D 启动恢复）。
   *
   * stale = 已过期，或持有者不是本进程里的活跃会话（会话已终态/根本不存在）。
   * 只处理 `task_id = ?`：A 的恢复不能清掉 B 的租约。运行中会话持有的未过期
   * 租约不会被误放。
   */
  releaseStaleLeases(
    taskId: string,
    now = Date.now(),
    reason = "应用重启：上一进程已结束",
  ): string[] {
    return this.tx((tx) => {
      const rows = tx
        .prepare(
          `SELECT * FROM leases
           WHERE task_id = ?
             AND (expires_at <= ? OR holder NOT IN (
               SELECT id FROM sessions
               WHERE status NOT IN ('blocked', 'stopped', 'failed', 'done')
             ))`,
        )
        .all(taskId, now) as unknown as Lease[];
      for (const r of rows) {
        tx.prepare(`DELETE FROM leases WHERE resource = ?`).run(r.resource);
        const eid = this.appendEvent(tx, {
          sessionId: r.holder,
          kind: "release",
          subject: r.task_id,
          body: { resource: r.resource, reason },
        });
        this.appendAudit(tx, {
          sessionId: r.holder,
          actor: "system",
          action: "lease.release",
          detail: { resource: r.resource, reason, taskId },
          eventId: eid,
        });
      }
      return rows.map((r) => r.resource);
    });
  }

  /**
   * 某任务当前有效的租约（R18）。
   *
   * 租约表是全局的（资源键天然互斥），但对外视图必须按任务隔离，否则新任务的
   * 简报会把旧任务的 `target:old-task` 当成「队友正持有」。过期的租约不再返回；
   * 真正的回收在 `acquireLease()` 里完成（过期视为空闲并覆盖 holder/task）。
   */
  listLeases(taskId: string, now = Date.now()): Lease[] {
    return this.db
      .prepare(`SELECT * FROM leases WHERE task_id = ? AND expires_at > ? ORDER BY acquired_at ASC`)
      .all(taskId, now) as unknown as Lease[];
  }

  /** 全库租约 —— 只给运维/验收断言用，业务视图禁止直接使用。 */
  listAllLeases(): Lease[] {
    return this.db.prepare(`SELECT * FROM leases ORDER BY acquired_at ASC`).all() as unknown as Lease[];
  }

  getLease(resource: string): Lease | undefined {
    return this.db.prepare(`SELECT * FROM leases WHERE resource = ?`).get(resource) as Lease | undefined;
  }

  // ---------- 读取 ----------

  /** §7.4 拉模式的唯一常规入口。 */
  readSince(afterId: number, limit = 200): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as unknown as EventRow[];
  }

  /**
   * 只读某个任务的事件（R17）。
   *
   * 黑板事件表是全局的；桥/简报/flag 识别都必须按任务隔离，否则新建任务后
   * 旧任务的事实会漏进新任务。任务实体事件的 `subject` 是 taskId；生命周期事件
   * 的 `subject` 为空，用 session 归属补齐。
   */
  readSinceForTask(afterId: number, taskId: string, limit = 200): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM events
         WHERE id > ?
           AND (subject = ? OR session_id IN (SELECT id FROM sessions WHERE task_id = ?))
         ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, taskId, taskId, limit) as unknown as EventRow[];
  }

  lastEventId(): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events`).get() as { m: number };
    return Number(r.m);
  }

  getTask(taskId: string):
    | {
        id: string;
        title: string;
        brief: string;
        status: string;
        answer: string | null;
        solved_by: string | null;
        created_at: number;
        category: string;
        priority: number;
        archived: number;
        updated_at: number;
        points: number;
        submit_mode: string;
        submit_command: string | null;
        submit_timeout_ms: number;
        answer_spec: string | null;
        allowed_actions: string;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT id, title, brief, status, answer, solved_by, created_at, category, priority, archived,
                updated_at, points, submit_mode, submit_command, submit_timeout_ms, answer_spec, allowed_actions
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as never;
  }

  /** 全部任务（R19 切换用），按创建时间倒序（最新在前）。 */
  listTasks(): Array<{
    id: string;
    title: string;
    brief: string;
    status: string;
    answer: string | null;
    solved_by: string | null;
    created_at: number;
    category: string;
    priority: number;
    archived: number;
    updated_at: number;
    points: number;
    submit_mode: string;
    submit_command: string | null;
    submit_timeout_ms: number;
    answer_spec: string | null;
    allowed_actions: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, title, brief, status, answer, solved_by, created_at, category, priority, archived,
                updated_at, points, submit_mode, submit_command, submit_timeout_ms, answer_spec, allowed_actions
         FROM tasks ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as never;
  }

  /**
   * P5-D：记分板只读聚合（包含归档任务，历史积分仍算）。
   *
   * `flagCount` 是该任务全部候选（new/confirmed/false_positive）的数量；
   * 不写表、不改变任务状态。
   */
  getScoreboard(): {
    tasks: Array<{
      taskId: string;
      title: string;
      status: string;
      points: number;
      flagCount: number;
    }>;
    solved: number;
    total: number;
    points: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT t.id AS taskId, t.title AS title, t.status AS status, t.points AS points,
                (SELECT COUNT(*) FROM flag_candidates c WHERE c.task_id = t.id) AS flagCount
         FROM tasks t ORDER BY t.created_at DESC`,
      )
      .all() as Array<{
      taskId: string;
      title: string;
      status: string;
      points: number;
      flagCount: number;
    }>;
    const tasks = rows.map((r) => ({
      ...r,
      points: Number(r.points) || 0,
      flagCount: Number(r.flagCount) || 0,
    }));
    return {
      tasks,
      solved: tasks.filter((t) => t.status === "solved").length,
      total: tasks.length,
      points: tasks.reduce((sum, t) => sum + t.points, 0),
    };
  }

  /**
   * 非归档任务，按创建时间倒序（最新在前）。
   *
   * 启动恢复只应碰这些任务；`listTasks()` 仍返回全部（含 archived），
   * 看板/历史查询需要归档任务时用它。
   */
  listActiveTasks(): ReturnType<Blackboard["listTasks"]> {
    return this.listTasks().filter((t) => t.archived === 0);
  }

  /**
   * 归档任务（P1-D）。
   *
   * 只改 `tasks.archived/updated_at`，不删 facts/sessions/leases，也不停进程。
   * 有非终态会话时一律返回 `requiresStop`（即使 force=true）——板子不能杀进程，
   * 由 Hub 先 `stopTaskSessions` 再重试。这样直接调用也不会留下“任务已归档、
   * 会话还在跑”的脏状态。
   */
  archiveTask(
    taskId: string,
    opts: { force?: boolean } = {},
  ): { ok: boolean; error?: string; requiresStop?: boolean; activeSessions?: number } {
    return this.tx((tx) => {
      const task = tx.prepare(`SELECT id, archived FROM tasks WHERE id = ?`).get(taskId) as
        | { id: string; archived: number }
        | undefined;
      if (!task) return { ok: false, error: `任务不存在：${taskId}` };
      const active = Number(
        (
          tx
            .prepare(
              `SELECT COUNT(*) AS c FROM sessions
               WHERE task_id = ? AND hidden = 0
                 AND status NOT IN ('blocked', 'stopped', 'failed', 'done')`,
            )
            .get(taskId) as { c: number }
        ).c,
      );
      if (active > 0) {
        return {
          ok: false,
          requiresStop: true,
          activeSessions: active,
          error: `任务仍有 ${active} 个非终态会话；请先停止会话，或由 Hub 以 force=true 处理`,
        };
      }
      if (task.archived) return { ok: true, activeSessions: 0 };
      tx.prepare(`UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?`).run(Date.now(), taskId);
      const eid = this.appendEvent(tx, {
        sessionId: null,
        kind: "lifecycle",
        subject: taskId,
        body: { what: "task.archived", force: opts.force === true },
      });
      this.appendAudit(tx, {
        sessionId: null,
        actor: "human",
        action: "task.archive",
        detail: { taskId, force: opts.force === true },
        eventId: eid,
      });
      return { ok: true, activeSessions: 0 };
    });
  }

  /** 最近创建的任务 —— 重启后恢复「上次在做的那道题」。 */
  latestTask():
    | {
        id: string;
        title: string;
        brief: string;
        status: string;
        answer: string | null;
        solved_by: string | null;
        created_at: number;
        category: string;
        priority: number;
        archived: number;
        updated_at: number;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT id, title, brief, status, answer, solved_by, created_at, category, priority, archived, updated_at
         FROM tasks ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as never;
  }

  /** 会话表 → 恢复用。含重启后仍需要展示的元数据。 */
  listSessions(taskId?: string): Array<{
    id: string;
    task_id: string;
    agent: string;
    role: string;
    tier: string;
    acp_session: string | null;
    status: string;
    started_at: number;
    ended_at: number | null;
    tool_calls: number | null;
    pid: number | null;
  }> {
    const sql =
      `SELECT id, task_id, agent, role, tier, acp_session, status, started_at, ended_at, tool_calls, pid
       FROM sessions WHERE hidden = 0` + (taskId ? ` AND task_id = ?` : ``) + ` ORDER BY started_at ASC`;
    return (taskId ? this.db.prepare(sql).all(taskId) : this.db.prepare(sql).all()) as never;
  }

  /** 公开留痕入口：给 Hub 记录「识别到 flag 候选」这类非黑板表事件。 */
  audit(input: { sessionId: string | null; actor: string; action: string; detail?: unknown }): void {
    this.tx((tx) => {
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.actor,
        action: input.action,
        detail: input.detail,
      });
    });
  }

  /**
   * 写一条任务级 note 事件（P1-C 收敛用）。
   *
   * 和 `submitFact` 不同：note 不参与事实/证据判定，也不触发 flag 扫描；它只是
   * 让切回该任务的队友看到“为什么被收敛”。`subject` 必须是 taskId，保证事件
   * 只属于该任务（`readSinceForTask` 按 subject / session 归属过滤）。
   */
  note(input: { taskId: string; sessionId: string | null; text: string }): number {
    return this.tx((tx) => {
      const eid = this.appendEvent(tx, {
        sessionId: input.sessionId,
        kind: "note",
        subject: input.taskId,
        body: { text: input.text },
      });
      this.appendAudit(tx, {
        sessionId: input.sessionId,
        actor: input.sessionId ?? "system",
        action: "board.note",
        detail: { taskId: input.taskId },
        eventId: eid,
      });
      return eid;
    });
  }

  setTaskStatus(taskId: string, status: string, answer?: string, sessionId?: string): void {
    const solved = status === "solved";
    this.tx((tx) => {
      // 只有 solved 才写答案/解题人；改回 open/solving 时清掉，避免任务栏把旧答案
      // 当成当前答案展示（「改回待解」就该真的回到待解）。
      tx.prepare(`UPDATE tasks SET status = ?, answer = ?, solved_by = ? WHERE id = ?`).run(
        status,
        solved ? answer ?? null : null,
        solved ? sessionId ?? null : null,
        taskId,
      );
      const eid = this.appendEvent(tx, {
        sessionId: sessionId ?? null,
        kind: "answer",
        subject: taskId,
        // 不写答案明文；只记状态与哈希，导出/快照仍从 tasks.answer 读取。
        body: { status, answerHash: solved && answer ? answerValueHash(answer) : null },
      });
      this.appendAudit(tx, { sessionId: sessionId ?? null, actor: sessionId ?? "human", action: "task.status", detail: { status }, eventId: eid });
    });
  }

  counts(): { events: number; deadEnds: number; leases: number; facts: number; intents: number } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as { c: number }).c);
    return {
      events: one("SELECT COUNT(*) AS c FROM events"),
      deadEnds: one("SELECT COUNT(*) AS c FROM dead_ends"),
      leases: one("SELECT COUNT(*) AS c FROM leases"),
      facts: one("SELECT COUNT(*) AS c FROM facts"),
      intents: one("SELECT COUNT(*) AS c FROM intents"),
    };
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  raw(sql: string, ...params: any[]): unknown[] {
    return this.db.prepare(sql).all(...params) as unknown[];
  }
}
