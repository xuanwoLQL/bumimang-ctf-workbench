/**
 * CTFd 通用适配器。
 *
 * 支持两类凭据：
 *  - API Token：密码框直接填 `ctfd_...`（也兼容普通 Bearer token）；
 *  - 用户名 + 密码：自动读取 /login 的 nonce 表单登录并复用 Cookie。
 */

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

type Json = Record<string, unknown>;

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  location?: string;
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
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

function categoryOf(value: string): TaskCategory {
  const v = value.toLowerCase();
  if (v.includes("web")) return "web";
  if (v.includes("pwn") || v.includes("binary")) return "pwn";
  if (v.includes("crypto")) return "crypto";
  if (v.includes("reverse") || v.includes("rev")) return "reverse";
  if (v.includes("misc") || v.includes("forensic")) return "misc";
  return "unknown";
}

function extractTargets(value: string): PlatformTargetView[] {
  const out: PlatformTargetView[] = [];
  const seen = new Set<string>();
  const add = (url: string, protocol: string): void => {
    if (!url || seen.has(url)) return;
    try {
      const parsed = new URL(url.includes("://") ? url : `http://${url}`);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      if (!parsed.hostname || !port) return;
      seen.add(url);
      out.push({
        protocol,
        host: parsed.hostname,
        port,
        url,
        innerPort: null,
        label: null,
      });
    } catch {
      // 非 URL 连接串保持原样，作为 host 目标供 Agent 使用。
      if (!seen.has(value.trim())) {
        seen.add(value.trim());
        out.push({
          protocol,
          host: value.trim(),
          port: 0,
          url: value.trim(),
          innerPort: null,
          label: null,
        });
      }
    }
  };
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    add(match[0].replace(/[),.;]+$/, ""), match[0].toLowerCase().startsWith("https") ? "https" : "http");
  }
  for (const match of value.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?\b/gi)) {
    const candidate = match[0];
    if (!candidate.includes("://")) add(candidate, "tcp");
  }
  return out;
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class CtfdClient implements PlatformAdapter {
  readonly provider = "ctfd";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly agent: HttpsAgent;
  private readonly cookies = new Map<string, string>();
  private authHeader = "";
  private loggedIn = false;

  constructor(opts: { baseUrl: string; insecureTls: boolean; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, opts.timeoutMs ?? 30_000);
    this.agent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: !opts.insecureTls });
  }

  get connected(): boolean {
    return this.loggedIn;
  }

  async login(username: string, password: string): Promise<PlatformLoginResult> {
    this.cookies.clear();
    const tokenLike = password.startsWith("ctfd_") || (password.length >= 24 && !password.includes(" "));
    if (tokenLike || !username.trim()) {
      for (const scheme of ["Token", "Bearer"]) {
        this.authHeader = `${scheme} ${password}`;
        const response = await this.request("GET", "/api/v1/challenges");
        if (response.status >= 200 && response.status < 300) {
          this.loggedIn = true;
          return {
            token: password,
            user: this.user(username || "CTFd API", null),
          };
        }
      }
      this.authHeader = "";
      throw new Error("CTFd API Token 无效");
    }

    const loginPage = await this.request("GET", "/login");
    if (loginPage.status < 200 || loginPage.status >= 400) {
      throw new Error(`CTFd /login 不可用：HTTP ${loginPage.status}`);
    }
    const html = loginPage.body.toString("utf8");
    const nonce =
      /name=["']nonce["'][^>]*value=["']([^"']+)/i.exec(html)?.[1] ??
      /name=["']_csrf_token["'][^>]*value=["']([^"']+)/i.exec(html)?.[1] ??
      "";
    const form = new URLSearchParams({
      name: username,
      password,
      _submit: "Submit",
      ...(nonce ? { nonce } : {}),
    });
    const login = await this.request("POST", "/login", {
      body: form.toString(),
      contentType: "application/x-www-form-urlencoded",
    });
    if (login.status >= 400) throw new Error(`CTFd 登录失败：HTTP ${login.status}`);
    const verify = await this.request("GET", "/api/v1/challenges");
    if (verify.status < 200 || verify.status >= 300) {
      throw new Error(`CTFd 登录后 API 仍不可用：HTTP ${verify.status}`);
    }
    this.loggedIn = true;
    return { user: this.user(username, null) };
  }

  async listRaces(): Promise<PlatformRaceView[]> {
    await this.ensureLoggedIn();
    const host = new URL(this.baseUrl).hostname;
    return [
      {
        id: "ctfd",
        name: `CTFd · ${host}`,
        startAt: null,
        endAt: null,
        timeStatus: 1,
        checkpointNum: null,
      },
    ];
  }

  async listChallenges(_raceId: string): Promise<PlatformChallengeView[]> {
    const json = await this.requestJson("GET", "/api/v1/challenges");
    const data = asRecord(json.data);
    const rows = Array.isArray(data.data) ? data.data : [];
    const challenges = await mapLimit(rows, 6, async (row) => {
      const base = asRecord(row);
      const id = String(base.id ?? "");
      if (!id) return null;
      let detail: Json = {};
      try {
        const d = await this.requestJson("GET", `/api/v1/challenges/${encodeURIComponent(id)}`);
        detail = asRecord(asRecord(d.data).data);
      } catch {
        // 列表字段仍可展示。
      }
      return this.toChallenge({ ...base, ...detail });
    });
    return challenges
      .filter((item): item is PlatformChallengeView => Boolean(item))
      .sort((a, b) => Number(a.isSolved) - Number(b.isSolved) || b.points - a.points);
  }

  async challengeDetail(_raceId: string, challengeId: string): Promise<PlatformChallengeView> {
    const json = await this.requestJson("GET", `/api/v1/challenges/${encodeURIComponent(challengeId)}`);
    return this.toChallenge(asRecord(asRecord(json.data).data));
  }

  async submitFlag(
    _raceId: string,
    challengeId: string,
    flag: string,
  ): Promise<Record<string, unknown>> {
    const json = await this.requestJson("POST", "/api/v1/challenges/attempt", {
      body: { challenge_id: Number(challengeId) || challengeId, submission: flag },
    });
    const data = asRecord(asRecord(json.data).data);
    if (str(data.status) === "incorrect") {
      throw new Error(str(data.message) || "CTFd 判定 flag 错误");
    }
    return data;
  }

  async download(urlPath: string, target: string): Promise<{ bytes: number }> {
    const response = await this.request("GET", urlPath);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CTFd 附件下载失败：HTTP ${response.status}`);
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const prefix = response.body.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
    if (/text\/html/i.test(contentType) || prefix.startsWith("<html") || prefix.startsWith("<!doctype")) {
      throw new Error("CTFd 附件下载返回了 HTML，拒绝导入");
    }
    await mkdir(dirname(target), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target, { flags: "wx" });
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(response.body);
    });
    return { bytes: response.body.length };
  }

  private user(username: string, team: string | null): PlatformUser {
    return {
      username,
      displayName: username,
      team,
      organization: [],
      roles: [],
      tokenExpiresAt: null,
    };
  }

  private toChallenge(row: Json): PlatformChallengeView {
    const id = String(row.id ?? "");
    const categoryName = str(row.category);
    const files = Array.isArray(row.files) ? row.files : [];
    const file = asRecord(files[0]);
    const connection = str(row.connection_info);
    return {
      id,
      taskId: null,
      title: str(row.name) || id,
      direction: categoryName || "Unknown",
      category: categoryOf(categoryName),
      points: num(row.value),
      solvedCount: num(row.solves),
      isSolved: bool(row.solved_by_me),
      description: str(row.description),
      attachmentName: str(file.name) || (str(file.url) ? str(file.url).split("/").pop() ?? null : null),
      attachmentUrl: str(file.url) || null,
      withScene: Boolean(connection),
      sceneReady: false,
      targets: extractTargets(connection),
      noticeCount: 0,
      difficulty: str(row.difficulty) || null,
    };
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.loggedIn) throw new Error("CTFd 尚未登录");
  }

  private async requestJson(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<Json> {
    const response = await this.request(method, path, {
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      contentType: "application/json",
    });
    const text = response.body.toString("utf8");
    let parsed: Json;
    try {
      parsed = asRecord(text ? JSON.parse(text) : {});
    } catch {
      throw new Error(`CTFd 返回非 JSON：HTTP ${response.status} ${text.slice(0, 120)}`);
    }
    if (response.status < 200 || response.status >= 300 || parsed.success === false) {
      const errors = asRecord(parsed.errors);
      throw new Error(str(errors.message) || str(parsed.message) || `CTFd 请求失败：HTTP ${response.status}`);
    }
    return parsed;
  }

  private async request(
    method: string,
    pathOrUrl: string,
    opts: { body?: string; contentType?: string } = {},
    redirects = 0,
  ): Promise<ResponseData> {
    if (redirects > 5) throw new Error("CTFd 重定向次数过多");
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl, `${this.baseUrl}/`);
    const headers: Record<string, string> = {
      Accept: "application/json, text/html, */*",
      "User-Agent": "Bumimang-CTF-Agent/1.0",
    };
    if (this.authHeader) headers.Authorization = this.authHeader;
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    const body = opts.body === undefined ? null : Buffer.from(opts.body, "utf8");
    if (body) headers["Content-Length"] = String(body.length);

    const response = await new Promise<ResponseData>((resolve, reject) => {
      const req = httpsRequest(url, { method, headers, agent: this.agent, timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const setCookies = res.headers["set-cookie"] ?? [];
          for (const cookie of setCookies) {
            const pair = cookie.split(";")[0] ?? "";
            const index = pair.indexOf("=");
            if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
          });
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`CTFd 请求超时：${this.timeoutMs}ms`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    if (
      response.location &&
      [301, 302, 303, 307, 308].includes(response.status) &&
      method !== "POST"
    ) {
      return this.request("GET", response.location, {}, redirects + 1);
    }
    return response;
  }
}
