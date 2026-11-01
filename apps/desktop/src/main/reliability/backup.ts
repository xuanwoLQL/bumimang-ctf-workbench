/**
 * P7-A：board.db 启动备份 / 迁移失败恢复 / 滚动清理。
 *
 * 设计：
 * - backupBeforeOpen(dbPath)：在打开/迁移前复制 db + -wal + -shm 到
 *   %APPDATA%/bumimang/backups/<timestamp>-<rand>/；返回备份目录；文件不存在返回 null。
 * - restoreFromBackup(backupPath, dbPath)：迁移失败时恢复；先移除目标 -wal/-shm，
 *   再复制备份中的 db/wal/shm，避免旧 WAL 与新 db 混用。
 * - listBackups()：按目录 mtime 新→旧列出包含 board.db 的备份。
 * - 默认保留最近 5 份；滚动清理不删除当前（最新）备份。
 *
 * 这个模块不 import electron；verify-reliability 可直接跑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface BackupOptions {
  backupRoot?: string;
  keep?: number;
}

export function defaultBackupRoot(): string {
  if (process.env.BUMIMANG_BACKUP_DIR) return process.env.BUMIMANG_BACKUP_DIR;
  const appData =
    process.env.APPDATA ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(appData, "bumimang", "backups");
}

function resolveRoot(opts: BackupOptions = {}): string {
  return opts.backupRoot ?? defaultBackupRoot();
}

/** 按目录 mtime 新→旧列出包含 board.db 的备份目录。 */
export function listBackups(opts: BackupOptions = {}): string[] {
  const root = resolveRoot(opts);
  if (!fs.existsSync(root)) return [];
  const dirs: Array<{ p: string; m: number }> = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const p = path.join(root, ent.name);
    if (!fs.existsSync(path.join(p, "board.db"))) continue;
    try {
      dirs.push({ p, m: fs.statSync(p).mtimeMs });
    } catch {
      /* 目录消失/权限：忽略 */
    }
  }
  return dirs.sort((a, b) => b.m - a.m).map((d) => d.p);
}

function prune(root: string, keep: number): void {
  const all = listBackups({ backupRoot: root });
  for (const old of all.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(old, { recursive: true, force: true });
    } catch {
      /* 清理失败不能影响本次备份 */
    }
  }
}

/**
 * 打开/迁移前备份。db 不存在（首次启动）返回 null。
 * 不抛错给启动路径？调用方负责：这里抛错代表备份目录不可写，board.open 会记录并继续。
 */
export function backupBeforeOpen(dbPath: string, opts: BackupOptions = {}): string | null {
  if (dbPath === ":memory:") return null;
  if (!fs.existsSync(dbPath)) return null;
  const root = resolveRoot(opts);
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(root, `${stamp}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(dbPath, path.join(dir, "board.db"));
  for (const suffix of ["-wal", "-shm"]) {
    const src = `${dbPath}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, `board.db${suffix}`));
  }
  prune(root, opts.keep ?? 5);
  return dir;
}

/** 迁移失败时从备份恢复；调用方必须先关闭当前 DB 句柄。 */
export function restoreFromBackup(backupPath: string, dbPath: string): void {
  const srcDb = path.join(backupPath, "board.db");
  if (!fs.existsSync(srcDb)) throw new Error(`备份不完整（缺少 board.db）：${backupPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) {
    const target = `${dbPath}${suffix}`;
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 忽略 */
    }
    const src = path.join(backupPath, `board.db${suffix}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, target);
  }
  fs.copyFileSync(srcDb, dbPath);
}
