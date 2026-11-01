/**
 * 强网拟态（赛宁 CT）平台客户端。
 *
 * 本文件只做网络协议，不读写本地黑板：
 *  - 密码按平台前端约定做 DES/ECB/PKCS7，再提交 hex；
 *  - 登录后同时携带 Bearer 与 token cookie，兼容平台不同模块；
 *  - 题目列表按方向并发拉取，再并发补详情，避免逐题串行拖慢开赛。
 */

import { createCipheriv } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type {
  PlatformChallengeView,
  PlatformRaceView,
  PlatformTargetView,
  TaskCategory,
} from "../../../../../packages/shared-protocol/events.ts";
import type {
  PlatformAdapter,
  PlatformLoginResult,
  PlatformUser,
} from "./adapter.ts";

type JsonRecord = Record<string, unknown>;

export interface NestClientOptions {
  baseUrl: string;
  desKey: string;
  insecureTls: boolean;
  timeoutMs?: number;
}

export type NestUser = PlatformUser;
export type NestLoginResult = PlatformLoginResult & { token: string };

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface LoginPayload {
  success?: boolean;
  code?: string;
  message?: string;
  data?: {
    token?: string;
    user?: {
      username?: string;
      name?: string;
      roles?: Array<{ name?: string }>;
      orgpaths?: unknown;
    };
  };
}

interface Envelope {
  code?: string;
  message?: string;
  detail?: string;
  data?: unknown;
}

export class NestApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, opts: { code?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = "NestApiError";
    this.code = opts.code ?? null;
    this.status = opts.status ?? null;
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function encryptNestPassword(plain: string, key: string): string {
  const keyBytes = Buffer.from(key, "utf8");
  if (keyBytes.length !== 8) {
    throw new Error(`DES 密钥必须是 8 字节，当前 ${keyBytes.length} 字节`);
  }
  // Node 的 DES 单算法受 OpenSSL 3 provider 影响；k1=k2=k3 的 3DES 与 DES 等价。
  const cipher = createCipheriv("des-ede3", Buffer.concat([keyBytes, keyBytes, keyBytes]), null);
  cipher.setAutoPadding(true);
  const first = cipher.update(plain, "utf8");
  const last = cipher.final();
  return Buffer.concat([first, last]).toString("hex");
}

function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function flattenOrgPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      const parts = item.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      if (parts.length > 0) out.push(parts.join(" / "));
    } else if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function categoryOf(direction: string): TaskCategory {
  const d = direction.trim().toLowerCase();
  if (d.includes("web")) return "web";
  if (d.includes("pwn") || d.includes("binary")) return "pwn";
  if (d.includes("crypto") || d.includes("密码")) return "crypto";
  if (d.includes("reverse") || d.includes("rev") || d.includes("逆向")) return "reverse";
  if (d.includes("misc") || d.includes("杂项") || d.includes("ai")) return "misc";
  return "unknown";
}

function collectSceneTargets(value: unknown): PlatformTargetView[] {
  const found: PlatformTargetView[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as JsonRecord;
    const host = str(obj.access_ip) || str(obj.host) || str(obj.ip);
    const port = num(obj.access_port) || num(obj.port);
    if (host && port > 0) {
      const protocol = str(obj.protocol) || "tcp";
      const key = `${protocol}|${host}|${port}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          protocol,
          host,
          port,
          url: protocol === "http" || protocol === "https"
            ? `${protocol}://${host}:${port}`
            : `${host}:${port}`,
          innerPort: num(obj.port) || null,
          label: str(obj.name) || str(obj.desc) || null,
        });
      }
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(value);
  return found;
}

function collectConnectionUrls(value: unknown): PlatformTargetView[] {
  const out: PlatformTargetView[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as JsonRecord;
    const raw = str(obj.connection_url) || str(obj.url);
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      try {
        const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`);
        const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
        out.push({
          protocol: parsed.protocol.replace(":", ""),
          host: parsed.hostname,
          port,
          url: raw,
          innerPort: num(obj.access_port) || num(obj.port) || null,
          label: str(obj.desc) || str(obj.name) || null,
        });
      } catch {
        // 平台偶尔返回相对路径；不把它当可直接访问地址。
      }
    }
    for (const child of Object.values(obj)) visit(child);
  };
  visit(value);
  return out;
}

function listPage(value: unknown): { rows: JsonRecord[]; total: number | null } {
  const obj = asRecord(value);
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(obj.list)
      ? obj.list
      : Array.isArray(obj.results)
        ? obj.results
        : Array.isArray(obj.items)
          ? obj.items
          : Array.isArray(obj.rows)
            ? obj.rows
            : [];
  return {
    rows: raw.map(asRecord).filter((row) => Object.keys(row).length > 0),
    total:
      typeof obj.total === "number"
        ? obj.total
        : typeof obj.count === "number"
          ? obj.count
          : null,
  };
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

export class NestClient implements PlatformAdapter {
  readonly provider = "nest-cyberpeace";
  private readonly baseUrl: string;
  private readonly desKey: string;
  private readonly timeoutMs: number;
  private readonly agent: HttpsAgent;
  private token = "";

  constructor(opts: NestClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.desKey = opts.desKey;
    this.timeoutMs = Math.max(5000, opts.timeoutMs ?? 30_000);
    this.agent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: !opts.insecureTls });
  }

  get connected(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string): void {
    this.token = token.trim();
  }

  async login(username: string, password: string): Promise<NestLoginResult> {
    const encrypted = encryptNestPassword(password, this.desKey);
    const response = await this.requestJson("POST", "/api/mp/auth/login", {
      body: { username, password: encrypted },
      auth: false,
      raw: true,
    });
    const payload = response as LoginPayload;
    const data = payload.data ?? {};
    const token = str(data.token);
    if (!payload.success || !token) {
      throw new NestApiError(payload.message || payload.code || "平台登录失败", {
        code: payload.code ?? null,
      });
    }
    this.token = token;
    const rawUser = data.user ?? {};
    const organization = flattenOrgPaths(rawUser.orgpaths);
    const roles = (rawUser.roles ?? [])
      .map((role) => str(role?.name))
      .filter((name) => name.length > 0);
    return {
      token,
      user: {
        username: str(rawUser.username) || username,
        displayName: str(rawUser.name) || null,
        team: organization[0] ?? null,
        organization,
        roles,
        tokenExpiresAt: decodeJwtExpiry(token),
      },
    };
  }

  async listRaces(): Promise<PlatformRaceView[]> {
    const data = await this.getJson("/api/ct/web/jeopardy_race/race/?timeover=0");
    const obj = asRecord(data);
    const list = Array.isArray(obj.list) ? obj.list : Array.isArray(data) ? data : [];
    return list.map((row) => this.toRace(asRecord(row))).filter((race) => race.id);
  }

  async raceInfo(raceId: string): Promise<PlatformRaceView> {
    const data = await this.getJson(`/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/info/`);
    return this.toRace(asRecord(data));
  }

  async listChallenges(raceId: string): Promise<PlatformChallengeView[]> {
    const summary = await this.getJson(
      `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/summary/checkpoints/`,
    );
    const rows = Array.isArray(summary) ? summary : [];
    let directions = rows
      .map((row) => str(asRecord(row).direction))
      .filter((direction) => direction.length > 0);
    if (directions.length === 0) {
      directions = ["Web", "Pwn", "Crypto", "Reverse", "Misc"];
    }
    directions = [...new Set(directions)];

    const lists = await mapLimit(directions, 4, async (direction) => {
      const path = `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/checkpoints/`;
      const first = listPage(
        await this.getJson(path, {
          query: { direction, page: 1, page_size: 100, limit: 100 },
        }),
      );
      const rows = [...first.rows];
      const seen = new Set(
        rows.map((row) => str(row.resource_id) || str(row.checkpoint_id) || str(row.id)),
      );
      const total = first.total;
      // Some deployments silently ignore pagination; only request another page
      // when the server explicitly reports more rows than the first response.
      for (let page = 2; total != null && rows.length < total && page <= 20; page += 1) {
        const next = listPage(
          await this.getJson(path, {
            query: { direction, page, page_size: 100, limit: 100 },
          }),
        );
        if (next.rows.length === 0) break;
        let added = 0;
        for (const row of next.rows) {
          const id = str(row.resource_id) || str(row.checkpoint_id) || str(row.id);
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          rows.push(row);
          added += 1;
        }
        if (added === 0) break;
      }
      return rows.map((row) => ({ row, direction }));
    });

    const flat = lists.flat();
    const detailed = await mapLimit(flat, 6, async ({ row, direction }) => {
      const id = str(row.resource_id) || str(row.checkpoint_id) || str(row.id);
      if (!id) return null;
      let detail: JsonRecord = {};
      try {
        detail = asRecord(
          await this.getJson(
            `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/checkpoints/${encodeURIComponent(id)}/`,
          ),
        );
      } catch {
        // 列表仍可用；单题详情失败不能拖垮整轮同步。
      }
      const merged = { ...row, ...detail };
      const resolvedTargets = await this.resolveSceneTargets(merged);
      return this.toChallenge(merged, direction, resolvedTargets);
    });

    return detailed
      .filter((item): item is PlatformChallengeView => Boolean(item))
      .sort((a, b) => {
        if (a.isSolved !== b.isSolved) return a.isSolved ? 1 : -1;
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return b.points - a.points;
      });
  }

  async challengeDetail(raceId: string, challengeId: string): Promise<PlatformChallengeView> {
    const data = await this.getJson(
      `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/checkpoints/${encodeURIComponent(challengeId)}/`,
    );
    const row = asRecord(data);
    const resolvedTargets = await this.resolveSceneTargets(row);
    return this.toChallenge(row, str(row.direction), resolvedTargets);
  }

  async submitFlag(raceId: string, challengeId: string, flag: string): Promise<JsonRecord> {
    const data = await this.requestJson(
      "POST",
      `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/flag/`,
      { body: { checkpoint_id: challengeId, flag } },
    );
    return asRecord(data);
  }

  async openScene(raceId: string, challengeId: string): Promise<JsonRecord> {
    return asRecord(
      await this.requestJson(
        "POST",
        `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/scenes/`,
        { body: { checkpoint_id: challengeId } },
      ),
    );
  }

  async closeScene(raceId: string, challengeId: string): Promise<JsonRecord> {
    return asRecord(
      await this.requestJson(
        "DELETE",
        `/api/ct/web/jeopardy_race/race/${encodeURIComponent(raceId)}/scenes/`,
        { body: { checkpoint_id: challengeId } },
      ),
    );
  }

  async download(urlPath: string, target: string): Promise<{ bytes: number }> {
    const url = /^https?:\/\//i.test(urlPath)
      ? new URL(urlPath)
      : new URL(urlPath, `${this.baseUrl}/`);
    await mkdir(dirname(target), { recursive: true });
    const response = await this.requestRaw("GET", url, null, "jwt");
    if (response.status < 200 || response.status >= 300) {
      throw new NestApiError(`附件下载失败：HTTP ${response.status}`, { status: response.status });
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const prefix = response.body.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
    if (/text\/html/i.test(contentType) || prefix.startsWith("<!doctype html") || prefix.startsWith("<html")) {
      throw new NestApiError(
        `附件下载被平台拒绝：返回了 HTML（HTTP ${response.status}）`,
        { status: response.status },
      );
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target, { flags: "wx" });
      stream.on("error", reject);
      stream.on("finish", () => resolve());
      stream.end(response.body);
    });
    return { bytes: response.body.length };
  }

  private toRace(row: JsonRecord): PlatformRaceView {
    return {
      id: str(row.resource_id) || str(row.id),
      name: str(row.name),
      startAt: str(row.start_time) || null,
      endAt: str(row.end_time) || null,
      timeStatus: typeof row.time_status === "number" ? row.time_status : null,
      checkpointNum: typeof row.checkpoint_num === "number" ? row.checkpoint_num : null,
    };
  }

  private toChallenge(
    row: JsonRecord,
    fallbackDirection: string,
    resolvedTargets: PlatformTargetView[] = [],
  ): PlatformChallengeView {
    const id = str(row.resource_id) || str(row.checkpoint_id) || str(row.id);
    const direction = str(row.direction) || fallbackDirection || "Unknown";
    const attachment = asRecord(row.attachment);
    const attachmentUrl = str(attachment.url) || str(row.attachment_url) || null;
    const sceneConfig = asRecord(row.scene_config);
    const targets = [...collectSceneTargets(sceneConfig), ...resolvedTargets].filter(
      (target, index, all) =>
        all.findIndex((candidate) => candidate.url === target.url) === index,
    );
    return {
      id,
      taskId: null,
      title: str(row.name) || str(row.title) || id,
      direction,
      category: categoryOf(direction),
      points: num(row.score) || num(row.current_score),
      solvedCount: num(row.solved) || num(row.solved_quantity),
      isSolved: bool(row.is_solved),
      description: str(row.desc) || str(row.description),
      attachmentName: str(attachment.name) || null,
      attachmentUrl,
      withScene: bool(row.with_scene),
      sceneReady: bool(row.with_scene_inst),
      targets,
      noticeCount: num(row.notice_num),
      difficulty: str(row.difficulty) || null,
    };
  }

  private async resolveSceneTargets(row: JsonRecord): Promise<PlatformTargetView[]> {
    if (!bool(row.with_scene_inst)) return [];
    const sceneConfig = asRecord(row.scene_config);
    const sceneId = str(sceneConfig.id);
    const plugins = asRecord(asRecord(asRecord(sceneConfig.scene).plugins).cpcloud);
    const ports = asRecord(plugins.element_ports);
    const portIds = Object.keys(ports);
    if (!sceneId || portIds.length === 0) return [];
    const results = await Promise.all(
      portIds.map(async (portId) => {
        try {
          const data = await this.getJson(
            `/api/ct/public/service/scene/${encodeURIComponent(sceneId)}/connections/${encodeURIComponent(portId)}/`,
            { query: { reference: 302 } },
          );
          return collectConnectionUrls(data);
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  private async getJson(
    path: string,
    opts: { query?: Record<string, string | number | boolean | null | undefined> } = {},
  ): Promise<unknown> {
    return this.requestJson("GET", path, { query: opts.query });
  }

  private async requestJson(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string | number | boolean | null | undefined>;
      auth?: boolean;
      raw?: boolean;
    } = {},
  ): Promise<unknown> {
    const url = this.urlFor(path, opts.query);
    const body =
      opts.body === undefined
        ? null
        : Buffer.from(JSON.stringify(opts.body), "utf8");
    const response = await this.requestRaw(
      method,
      url,
      body,
      opts.auth === false ? false : "bearer",
    );
    const text = response.body.toString("utf8");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new NestApiError(
        `平台返回非 JSON（HTTP ${response.status}）：${text.slice(0, 180)}`,
        { status: response.status },
      );
    }
    const envelope = asRecord(parsed) as Envelope;
    const code = str(envelope.code);
    const okCode =
      !code ||
      code === "AD-000000" ||
      code === "MP-000000" ||
      response.status < 400;
    if (response.status >= 400 || (!okCode && !("success" in envelope))) {
      throw new NestApiError(
        str(envelope.message) || str(envelope.detail) || `平台请求失败：HTTP ${response.status}`,
        { code: code || null, status: response.status },
      );
    }
    return opts.raw ? parsed : (envelope.data ?? parsed);
  }

  private urlFor(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): URL {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async requestRaw(
    method: string,
    url: URL,
    body: Buffer | null = null,
    auth: "bearer" | "jwt" | false = "bearer",
  ): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const headers: Record<string, string> = {
        Accept: "application/json, application/octet-stream, */*",
        "User-Agent": "Xuanwo-CTF-Agent/1.0",
      };
      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(body.length);
      }
      if (auth && this.token) {
        if (auth === "jwt") {
          headers.Authorization = `JWT ${this.token}`;
          headers.Cookie = `cr_jwttoken=${this.token}`;
        } else {
          headers.Authorization = `Bearer ${this.token}`;
          headers.Cookie = `token=${this.token}; cr_jwttoken=${this.token}`;
        }
      }
      const req = httpsRequest(
        url,
        {
          method,
          headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > 350 * 1024 * 1024) {
              res.destroy(new Error("平台响应超过 350MB 上限"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`请求超时（${this.timeoutMs}ms）`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
