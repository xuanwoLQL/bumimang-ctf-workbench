/**
 * P1-A 迁移验收 —— 旧 tasks 表补列、user_version、幂等。
 *
 * 为什么单独成文件：P1-A 只做数据字段/迁移/配置，不碰 Hub 行为；
 * 这组断言必须在不动 hub.ts / session/manager.ts 的前提下独立可跑。
 *
 * 用法：npm run verify:migration
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard } from "../main/blackboard/board.ts";
import { loadAppConfig } from "../main/config/loader.ts";

const V4_TABLES = [
  "awd_rounds",
  "awd_services",
  "awd_patches",
  "awd_checks",
  "awd_attacks",
  "ir_timeline",
  "ir_questions",
] as const;

const results: Array<{ name: string; pass: boolean; detail: string }> = [];

function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function makeOldDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      brief           TEXT NOT NULL,
      status          TEXT NOT NULL,
      answer          TEXT,
      answer_evidence TEXT,
      solved_by       TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE facts (
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
    CREATE TABLE sessions (
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
      tokens_note TEXT
    );
  `);
  db.prepare(`INSERT INTO tasks (id, title, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "task-old-a",
    "旧题 A",
    "brief A",
    "open",
    1000,
  );
  db.prepare(`INSERT INTO tasks (id, title, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "task-old-b",
    "旧题 B",
    "brief B",
    "solved",
    2000,
  );
  const fact = db.prepare(
    `INSERT INTO facts (id, task_id, content, status, evidence, created_at, updated_at)
     VALUES (?, ?, ?, 'verified', 'E1', ?, ?)`,
  );
  fact.run("fact-1", "task-old-a", "旧事实 1", 1100, 1100);
  fact.run("fact-2", "task-old-a", "旧事实 2", 1200, 1200);
  fact.run("fact-3", "task-old-b", "旧事实 3", 2100, 2100);
  const session = db.prepare(
    `INSERT INTO sessions (id, task_id, agent, role, tier, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  session.run("s-old-1", "task-old-a", "claude", "lead", "guarded", "running", 1300);
  session.run("s-old-2", "task-old-b", "codex", "verify", "autonomous", "done", 2300);
  db.close();
}

function columnNames(dbPath: string, table: string): Set<string> {
  const db = new DatabaseSync(dbPath);
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    return Number(row.user_version ?? 0);
  } finally {
    db.close();
  }
}

function rawCount(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, table: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    return Boolean(row?.name);
  } finally {
    db.close();
  }
}

/** 读 tasks 的某一列（只用于 schema 默认值断言）；缺列时返回可读标记而不是崩掉套件。 */
function taskColumn(
  dbPath: string,
  taskId: string,
  column:
    | "deny_targets"
    | "scope_notes"
    | "points"
    | "submit_mode"
    | "submit_command"
    | "submit_timeout_ms"
    | "answer_spec"
    | "allowed_actions",
): unknown {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT ${column} AS v FROM tasks WHERE id = ?`).get(taskId) as
      | { v?: unknown }
      | undefined;
    return row?.v ?? null;
  } catch {
    return `<missing-column:${column}>`;
  } finally {
    db.close();
  }
}

/** v2 表可能还没建；缺表时返回可读标记，红测能完整跑完。 */
function countSafe(dbPath: string, table: string): number | string {
  try {
    return rawCount(dbPath, table);
  } catch {
    return `<missing-table:${table}>`;
  }
}

/**
 * 造一个 P1-A 之后的 v1 库：tasks 已有四列、user_version=1，
 * 但没有 targets 表，也没有 deny_targets/scope_notes。
 * 用来验证 v1 → v2 不依赖 v0 的补列路径。
 */
function makeV1Db(dbPath: string): void {
  makeOldDb(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      UPDATE tasks SET updated_at = created_at;
      PRAGMA user_version = 1;
    `);
  } finally {
    db.close();
  }
}

/** P5-A：造一个 v2 库（有 targets/deny/scope，没有 flag 表/points 等）。 */
function makeV2Db(dbPath: string): void {
  makeV1Db(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN deny_targets TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN scope_notes TEXT;
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
      PRAGMA user_version = 2;
    `);
  } finally {
    db.close();
  }
}

/** P9-D：造一个 v3 库（有 flag 表/points，没有 AWD/IR 强类型表）。 */
function makeV3Db(dbPath: string): void {
  makeV2Db(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
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
      ALTER TABLE tasks ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN submit_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE tasks ADD COLUMN submit_command TEXT;
      ALTER TABLE tasks ADD COLUMN submit_timeout_ms INTEGER NOT NULL DEFAULT 30000;
      PRAGMA user_version = 3;
    `);
  } finally {
    db.close();
  }
}

function main(): void {
  console.log("================ P1-A 旧库迁移 ================\n");
  const dir = mkdtempSync(join(tmpdir(), "bumimang-migration-"));
  const dbPath = join(dir, "board.db");
  try {
    makeOldDb(dbPath);
    eq("迁移前旧库 user_version 为 0", userVersion(dbPath), 0);
    eq("迁移前旧库有 2 个任务", rawCount(dbPath, "tasks"), 2);
    eq("迁移前旧库有 3 条事实", rawCount(dbPath, "facts"), 3);
    eq("迁移前旧库有 2 个会话", rawCount(dbPath, "sessions"), 2);

    // 第一次打开：补列 + user_version + 回填 updated_at。
    let bb = Blackboard.open(dbPath);
    const cols = columnNames(dbPath, "tasks");
    for (const col of ["category", "priority", "archived", "updated_at"]) {
      check(`tasks 表补出 ${col} 列`, cols.has(col));
    }
    // P4-A v2：v0 库必须在同一次 open() 里走完 v1 → v2，不跳版本。
    for (const col of ["deny_targets", "scope_notes"]) {
      check(`tasks 表补出 v2 列 ${col}`, cols.has(col));
    }
    check("v2 迁移创建 targets 表", tableExists(dbPath, "targets"));
    eq("v2 迁移后 targets 为空", countSafe(dbPath, "targets"), 0);
    eq("旧任务 deny_targets 默认 '[]'", taskColumn(dbPath, "task-old-a", "deny_targets"), "[]");
    eq("旧任务 scope_notes 默认 NULL", taskColumn(dbPath, "task-old-a", "scope_notes"), null);
    // P5-A v3：flag 持久化 + tasks 提交/记分列；v0 库同一次 open() 里 v1→v2→v3。
    check("v3 迁移创建 flag_candidates 表", tableExists(dbPath, "flag_candidates"));
    check("v3 迁移创建 flag_sources 表", tableExists(dbPath, "flag_sources"));
    eq("v3 迁移后 flag_candidates 为空", countSafe(dbPath, "flag_candidates"), 0);
    eq("v3 迁移后 flag_sources 为空", countSafe(dbPath, "flag_sources"), 0);
    for (const col of ["points", "submit_mode", "submit_command", "submit_timeout_ms"]) {
      check(`tasks 表补出 v3 列 ${col}`, cols.has(col));
    }
    eq("旧任务 points 默认 0", taskColumn(dbPath, "task-old-a", "points"), 0);
    eq("旧任务 submit_mode 默认 manual", taskColumn(dbPath, "task-old-a", "submit_mode"), "manual");
    eq("旧任务 submit_command 默认 NULL", taskColumn(dbPath, "task-old-a", "submit_command"), null);
    eq("旧任务 submit_timeout_ms 默认 30000", taskColumn(dbPath, "task-old-a", "submit_timeout_ms"), 30000);
    // P9-D v4：只建 AWD/IR 强类型表，不背填 facts。
    for (const table of V4_TABLES) {
      check(`v4 迁移创建 ${table} 表`, tableExists(dbPath, table));
      eq(`v4 迁移后 ${table} 为空（不背填）`, countSafe(dbPath, table), 0);
    }
    // V2-P0-2 v5：AnswerSpec 与候选来源位置列；只加列，旧数据为 NULL。
    check("v5 迁移 tasks 有 answer_spec 列", cols.has("answer_spec"));
    const v5CandCols = columnNames(dbPath, "flag_candidates");
    for (const col of ["answer_type", "normalized_value", "spec_id"]) {
      check(`v5 迁移 flag_candidates 有 ${col} 列`, v5CandCols.has(col));
    }
    const v5SourceCols = columnNames(dbPath, "flag_sources");
    for (const col of ["line", "byte_offset", "source_kind", "source_path"]) {
      check(`v5 迁移 flag_sources 有 ${col} 列`, v5SourceCols.has(col));
    }
    eq("旧任务 answer_spec 默认 NULL", taskColumn(dbPath, "task-old-a", "answer_spec"), null);
    // V2-P0-5 v6：allowed_actions 列，旧任务默认 '[]'。
    check("v6 迁移 tasks 有 allowed_actions 列", cols.has("allowed_actions"));
    eq("旧任务 allowed_actions 默认 '[]'", taskColumn(dbPath, "task-old-a", "allowed_actions"), "[]");
    eq("迁移后 user_version 为 6", userVersion(dbPath), 6);
    eq("迁移后任务数量不变", bb.listTasks().length, 2);
    eq("迁移后事实数量不变", bb.listFacts("task-old-a").length + bb.listFacts("task-old-b").length, 3);
    eq("迁移后会话数量不变", bb.listSessions().length, 2);

    const oldA = bb.getTask("task-old-a");
    eq("旧任务 category 默认 unknown", oldA?.category, "unknown");
    eq("旧任务 priority 默认 0", oldA?.priority, 0);
    eq("旧任务 archived 默认 0", oldA?.archived, 0);
    eq("旧任务 updated_at 回填 created_at", oldA?.updated_at, oldA?.created_at);

    const oldB = bb.getTask("task-old-b");
    eq("旧任务 B category 默认 unknown", oldB?.category, "unknown");
    eq("旧任务 B updated_at 回填 created_at", oldB?.updated_at, oldB?.created_at);

    // 幂等：关掉再开，不重复加列、不重复回填、不产生新行。
    bb.close();
    bb = Blackboard.open(dbPath);
    eq("重复打开 user_version 仍为 6", userVersion(dbPath), 6);
    eq("重复打开任务数量不变", bb.listTasks().length, 2);
    eq("重复打开事实数量不变", bb.listFacts("task-old-a").length + bb.listFacts("task-old-b").length, 3);
    eq("重复打开会话数量不变", bb.listSessions().length, 2);
    eq("重复打开 targets 表仍只有一张", countSafe(dbPath, "targets"), 0);
    check("重复打开 targets 表仍在", tableExists(dbPath, "targets"));
    check("重复打开 flag_candidates 表仍在", tableExists(dbPath, "flag_candidates"));
    check("重复打开 flag_sources 表仍在", tableExists(dbPath, "flag_sources"));
    eq("重复打开 flag_candidates 仍为空", countSafe(dbPath, "flag_candidates"), 0);
    eq("重复打开 flag_sources 仍为空", countSafe(dbPath, "flag_sources"), 0);
    for (const table of V4_TABLES) {
      check(`重复打开 ${table} 表仍在`, tableExists(dbPath, table));
      eq(`重复打开 ${table} 仍为空`, countSafe(dbPath, table), 0);
    }
    eq("重复打开旧任务 updated_at 未被改写", bb.getTask("task-old-a")?.updated_at, 1000);

    // createTask 可选字段：显式值生效；省略时保持旧默认 unknown/0。
    const web = bb.createTask({ title: "新 Web 题", brief: "brief", category: "web", priority: 7 });
    const webRow = bb.getTask(web.id);
    eq("createTask 显式 category 生效", webRow?.category, "web");
    eq("createTask 显式 priority 生效", webRow?.priority, 7);
    eq("createTask 新任务 archived 为 0", webRow?.archived, 0);
    check("createTask 新任务 updated_at 已写入", Number(webRow?.updated_at) > 0);

    const plain = bb.createTask({ title: "新默认题", brief: "brief" });
    const plainRow = bb.getTask(plain.id);
    eq("createTask 省略 category 时默认 unknown", plainRow?.category, "unknown");
    eq("createTask 省略 priority 时默认 0", plainRow?.priority, 0);
    eq("新任务 answer_spec 默认 NULL", plainRow?.answer_spec, null);
    // V2-P0-2：AnswerSpec 持久化（JSON），不做业务判定。
    const specTask = bb.createTask({
      title: "自定义答案格式",
      brief: "brief",
      answerSpec: {
        mode: "flag_regex",
        pattern: "DASCTF\\{[^}\\s]{3,128}\\}",
        answerType: "flag",
        caseSensitive: true,
        normalizers: ["trim"],
        requiredEvidence: "E1",
      },
    });
    const specRow = bb.getTask(specTask.id);
    check(
      "createTask 持久化 answer_spec JSON",
      typeof specRow?.answer_spec === "string" && specRow.answer_spec.includes("DASCTF"),
      specRow?.answer_spec ?? "null",
    );
    // V2-P0-5：范围数据持久化（denyTargets/scopeNotes/allowedActions）。
    const scopeTask = bb.createTask({ title: "范围数据", brief: "brief" });
    bb.updateTaskScope({
      taskId: scopeTask.id,
      denyTargets: ["10.9.9.9"],
      scopeNotes: "只打 10.0.0.0/8",
      allowedActions: ["terminal/exec"],
    });
    const scopeRow = bb.getTaskScope(scopeTask.id);
    eq("updateTaskScope denyTargets", (scopeRow?.denyTargets ?? []).join(","), "10.9.9.9");
    eq("updateTaskScope scopeNotes", scopeRow?.scopeNotes, "只打 10.0.0.0/8");
    eq("updateTaskScope allowedActions", (scopeRow?.allowedActions ?? []).join(","), "terminal/exec");
    eq("新任务 deny_targets 默认 '[]'", taskColumn(dbPath, plain.id, "deny_targets"), "[]");
    eq("新任务 scope_notes 默认 NULL", taskColumn(dbPath, plain.id, "scope_notes"), null);

    // 关闭后直接查库：列/版本/行数保持；新任务字段持久化。
    bb.close();
    eq("最终任务数量为 6", rawCount(dbPath, "tasks"), 6);
    eq("最终事实数量仍为 3", rawCount(dbPath, "facts"), 3);
    eq("最终会话数量仍为 2", rawCount(dbPath, "sessions"), 2);
    eq("最终 user_version 仍为 6", userVersion(dbPath), 6);
    const finalCols = columnNames(dbPath, "tasks");
    check("最终 tasks 表仍有 archived 列", finalCols.has("archived"));
    check("最终 tasks 表仍有 deny_targets 列", finalCols.has("deny_targets"));
    check("最终 tasks 表仍有 scope_notes 列", finalCols.has("scope_notes"));
    for (const col of ["points", "submit_mode", "submit_command", "submit_timeout_ms"]) {
      check(`最终 tasks 表仍有 v3 列 ${col}`, finalCols.has(col));
    }

    // P4-A：v1 库（已有四列、没有 targets/deny/scope）单独走 v1 → v2。
    const v1Path = join(dir, "board-v1.db");
    makeV1Db(v1Path);
    eq("v1 夹具迁移前 user_version 为 1", userVersion(v1Path), 1);
    eq("v1 夹具迁移前没有 targets 表", tableExists(v1Path, "targets"), false);
    eq("v1 夹具迁移前任务数 2", rawCount(v1Path, "tasks"), 2);
    const v1bb = Blackboard.open(v1Path);
    eq("v1 库迁移后 user_version 为 6", userVersion(v1Path), 6);
    check("v1 库迁移后创建 targets 表", tableExists(v1Path, "targets"));
    eq("v1 库迁移后 targets 为空", countSafe(v1Path, "targets"), 0);
    check("v1 库迁移后补出 deny_targets", columnNames(v1Path, "tasks").has("deny_targets"));
    check("v1 库迁移后补出 scope_notes", columnNames(v1Path, "tasks").has("scope_notes"));
    eq("v1 库迁移后任务数不变", rawCount(v1Path, "tasks"), 2);
    eq("v1 库迁移后事实数不变", rawCount(v1Path, "facts"), 3);
    eq("v1 库迁移后会话数不变", rawCount(v1Path, "sessions"), 2);
    eq("v1 旧任务 deny_targets 默认 '[]'", taskColumn(v1Path, "task-old-b", "deny_targets"), "[]");
    eq("v1 旧任务 scope_notes 默认 NULL", taskColumn(v1Path, "task-old-b", "scope_notes"), null);
    check("v1 库迁移后创建 flag_candidates 表", tableExists(v1Path, "flag_candidates"));
    check("v1 库迁移后创建 flag_sources 表", tableExists(v1Path, "flag_sources"));
    eq("v1 库迁移后 flag_candidates 为空", countSafe(v1Path, "flag_candidates"), 0);
    eq("v1 旧任务 points 默认 0", taskColumn(v1Path, "task-old-b", "points"), 0);
    eq("v1 旧任务 submit_mode 默认 manual", taskColumn(v1Path, "task-old-b", "submit_mode"), "manual");
    eq("v1 旧任务 submit_timeout_ms 默认 30000", taskColumn(v1Path, "task-old-b", "submit_timeout_ms"), 30000);
    for (const table of V4_TABLES) {
      check(`v1 库迁移后创建 ${table} 表`, tableExists(v1Path, table));
      eq(`v1 库迁移后 ${table} 为空`, countSafe(v1Path, table), 0);
    }
    v1bb.close();

    // P5-A：v2 库（有 targets/deny/scope，没有 flag 表/提交列）单独走 v2 → v3。
    const v2Path = join(dir, "board-v2.db");
    makeV2Db(v2Path);
    eq("v2 夹具迁移前 user_version 为 2", userVersion(v2Path), 2);
    eq("v2 夹具迁移前没有 flag_candidates 表", tableExists(v2Path, "flag_candidates"), false);
    eq("v2 夹具迁移前 tasks 没有 points 列", columnNames(v2Path, "tasks").has("points"), false);
    eq("v2 夹具迁移前任务数 2", rawCount(v2Path, "tasks"), 2);
    const v2bb = Blackboard.open(v2Path);
    eq("v2 库迁移后 user_version 为 6", userVersion(v2Path), 6);
    check("v2 库迁移后创建 flag_candidates 表", tableExists(v2Path, "flag_candidates"));
    check("v2 库迁移后创建 flag_sources 表", tableExists(v2Path, "flag_sources"));
    eq("v2 库迁移后 flag_candidates 为空", countSafe(v2Path, "flag_candidates"), 0);
    const v2Cols = columnNames(v2Path, "tasks");
    for (const col of ["points", "submit_mode", "submit_command", "submit_timeout_ms"]) {
      check(`v2 库迁移后 tasks 有 ${col} 列`, v2Cols.has(col));
    }
    eq("v2 旧任务 points 默认 0", taskColumn(v2Path, "task-old-b", "points"), 0);
    eq("v2 旧任务 submit_mode 默认 manual", taskColumn(v2Path, "task-old-b", "submit_mode"), "manual");
    eq("v2 旧任务 submit_timeout_ms 默认 30000", taskColumn(v2Path, "task-old-b", "submit_timeout_ms"), 30000);
    eq("v2 库迁移后任务数不变", rawCount(v2Path, "tasks"), 2);
    eq("v2 库迁移后事实数不变", rawCount(v2Path, "facts"), 3);
    eq("v2 库迁移后会话数不变", rawCount(v2Path, "sessions"), 2);
    for (const table of V4_TABLES) {
      check(`v2 库迁移后创建 ${table} 表`, tableExists(v2Path, table));
      eq(`v2 库迁移后 ${table} 为空`, countSafe(v2Path, table), 0);
    }
    v2bb.close();
    const v2bbAgain = Blackboard.open(v2Path);
    eq("v2 库重复打开 user_version 仍为 6", userVersion(v2Path), 6);
    eq("v2 库重复打开 flag_candidates 仍为空", countSafe(v2Path, "flag_candidates"), 0);
    v2bbAgain.close();

    // P9-D：v3 库（有 flag 表/提交列，没有 AWD/IR 强类型表）单独走 v3 → v4。
    const v3Path = join(dir, "board-v3.db");
    makeV3Db(v3Path);
    eq("v3 夹具迁移前 user_version 为 3", userVersion(v3Path), 3);
    eq("v3 夹具迁移前没有 awd_rounds 表", tableExists(v3Path, "awd_rounds"), false);
    eq("v3 夹具迁移前任务数 2", rawCount(v3Path, "tasks"), 2);
    const v3bb = Blackboard.open(v3Path);
    eq("v3 库迁移后 user_version 为 6", userVersion(v3Path), 6);
    for (const table of V4_TABLES) {
      check(`v3 库迁移后创建 ${table} 表`, tableExists(v3Path, table));
      eq(`v3 库迁移后 ${table} 为空（不背填）`, countSafe(v3Path, table), 0);
    }
    eq("v3 库迁移后任务数不变", rawCount(v3Path, "tasks"), 2);
    eq("v3 库迁移后事实数不变", rawCount(v3Path, "facts"), 3);
    eq("v3 库迁移后会话数不变", rawCount(v3Path, "sessions"), 2);
    eq("v3 库迁移后 flag_candidates 不变", countSafe(v3Path, "flag_candidates"), 0);
    v3bb.close();
    const v3bbAgain = Blackboard.open(v3Path);
    eq("v3 库重复打开 user_version 仍为 6", userVersion(v3Path), 6);
    v3bbAgain.close();

    // 真实旧库副本：有就复制到临时目录再迁移，绝不改 .probe 里的备份。
    // 没有（例如队友机器没跑过应用）则跳过，不算失败。
    const realBackup = join(process.cwd(), ".probe", "backup-wp1", "board.db");
    if (!existsSync(realBackup)) {
      console.log("SKIP  真实备份副本不存在（.probe/backup-wp1/board.db）");
    } else {
      const realCopy = join(dir, "real-backup.db");
      copyFileSync(realBackup, realCopy);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(realBackup + suffix)) copyFileSync(realBackup + suffix, realCopy + suffix);
      }
      const before = {
        tasks: rawCount(realCopy, "tasks"),
        facts: rawCount(realCopy, "facts"),
        sessions: rawCount(realCopy, "sessions"),
        events: rawCount(realCopy, "events"),
      };
      const rb = Blackboard.open(realCopy);
      const realCols = columnNames(realCopy, "tasks");
      check("真实备份迁移后 tasks 有 category 列", realCols.has("category"));
      check("真实备份迁移后 tasks 有 archived 列", realCols.has("archived"));
      const firstTask = rb.listTasks()[0];
      rb.close();
      eq("真实备份迁移后任务数不变", rawCount(realCopy, "tasks"), before.tasks);
      eq("真实备份迁移后事实数不变", rawCount(realCopy, "facts"), before.facts);
      eq("真实备份迁移后会话数不变", rawCount(realCopy, "sessions"), before.sessions);
      eq("真实备份迁移后事件数不变", rawCount(realCopy, "events"), before.events);
      eq("真实备份迁移后 user_version 为 6", userVersion(realCopy), 6);
      check("真实备份迁移后 targets 表存在", tableExists(realCopy, "targets"));
      eq("真实备份迁移后 targets 为空", countSafe(realCopy, "targets"), 0);
      check("真实备份迁移后 flag_candidates 表存在", tableExists(realCopy, "flag_candidates"));
      check("真实备份迁移后 flag_sources 表存在", tableExists(realCopy, "flag_sources"));
      eq("真实备份迁移后 flag_candidates 为空", countSafe(realCopy, "flag_candidates"), 0);
      for (const table of V4_TABLES) {
        check(`真实备份迁移后创建 ${table} 表`, tableExists(realCopy, table));
        eq(`真实备份迁移后 ${table} 为空（不背填）`, countSafe(realCopy, table), 0);
      }
      check("真实备份迁移后 tasks 有 points 列", realCols.has("points"));
      check("真实备份迁移后 tasks 有 submit_mode 列", realCols.has("submit_mode"));
      if (firstTask) {
        eq("真实备份旧任务 deny_targets 默认 '[]'", taskColumn(realCopy, firstTask.id, "deny_targets"), "[]");
        eq("真实备份旧任务 scope_notes 默认 NULL", taskColumn(realCopy, firstTask.id, "scope_notes"), null);
        eq("真实备份旧任务 points 默认 0", taskColumn(realCopy, firstTask.id, "points"), 0);
        eq("真实备份旧任务 submit_mode 默认 manual", taskColumn(realCopy, firstTask.id, "submit_mode"), "manual");
        eq("真实备份旧任务 submit_timeout_ms 默认 30000", taskColumn(realCopy, firstTask.id, "submit_timeout_ms"), 30000);
      } else {
        check("真实备份旧任务 deny_targets 默认 '[]'", false, "备份里没有任务");
        check("真实备份旧任务 scope_notes 默认 NULL", false, "备份里没有任务");
        check("真实备份旧任务 points 默认 0", false, "备份里没有任务");
        check("真实备份旧任务 submit_mode 默认 manual", false, "备份里没有任务");
        check("真实备份旧任务 submit_timeout_ms 默认 30000", false, "备份里没有任务");
      }
      check("真实备份至少有一个任务", before.tasks > 0, `tasks=${before.tasks}`);
    }

    // P1-A 配额配置：只验证加载，不执行配额（P1-B 才消费）。
    const loaded = loadAppConfig({
      repoRoot: process.cwd(),
      isPackaged: false,
      resourcesPath: "",
      env: {},
    });
    eq("config/app.json maxSessionsPerTask 加载为 3", loaded.config.maxSessionsPerTask, 3);
    eq("config/app.json maxSessionsTotal 加载为 8", loaded.config.maxSessionsTotal, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n================ ${results.length - failed}/${results.length} 通过 ================`);
  if (failed > 0) process.exitCode = 1;
}

main();
