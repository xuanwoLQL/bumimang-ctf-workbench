/**
 * CTFy MCP 适配器。
 *
 * 登录密码框填写 CTFy 的 `pf_...` token。适配器直接调用平台官方 MCP
 * tools/call，不依赖本机 CLI；支持比赛列表、题单、开题详情和提交答案。
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type {
  PlatformChallengeView,
  PlatformRaceView,
  PlatformTargetView,
  TaskCategory,
} from "../../../../../packages/shared-protocol/events.ts";
import type { PlatformAdapter, PlatformLoginResult, PlatformUser } from "./adapter.ts";

type Json = Record<string, unknown>;

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
  if (v.includes("pwn")) return "pwn";
  if (v.includes("crypto")) return "crypto";
  if (v.includes("reverse") || v.includes("rev")) return "reverse";
  if (v.includes("misc") || v.includes("forensic") || v.includes("agent")) return "misc";
  return "unknown";
}

function firstArray(value: unknown, depth = 0): unknown[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return [];
  const obj = value as Json;
  for (const key of ["items", "list", "results", "challenges", "competitions", "data"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const child of Object.values(obj)) {
    const found = firstArray(child, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function targetFromAttackSurface(value: unknown): PlatformTargetView[] {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value ?? "");
  const out: PlatformTargetView[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"',}]+/gi)) {
    const raw = match[0].replace(/\\+$/, "");
    try {
      const parsed = new URL(raw);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      out.push({
        protocol: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port,
        url: raw,
        innerPort: null,
        label: null,
      });
    } catch {
      // 忽略畸形 URL。
    }
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
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      out[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class CtfyClient implements PlatformAdapter {
  readonly provider = "ctfy";
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly agent: HttpsAgent;
  private readonly timeoutMs: number;
  private token = "";
  private nextId = 1;
  private instanceByChallenge = new Map<string, string>();

  constructor(opts: { baseUrl: string; insecureTls: boolean; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.endpoint = this.baseUrl.endsWith("/api/v1/mcp")
      ? `${this.baseUrl}/`
      : `${this.baseUrl}/api/v1/mcp/`;
    this.agent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: !opts.insecureTls });
    this.timeoutMs = Math.max(5000, opts.timeoutMs ?? 90_000);
  }

  get connected(): boolean {
    return Boolean(this.token);
  }

  async login(username: string, password: string): Promise<PlatformLoginResult> {
    this.token = password.trim();
    if (!this.token) throw new Error("CTFy token 不能为空");
    await this.callTool("health", {});
    const user: PlatformUser = {
      username: username || "CTFy MCP",
      displayName: username || "CTFy MCP",
      team: null,
      organization: [],
      roles: [],
      tokenExpiresAt: null,
    };
    return { token: this.token, user };
  }

  async listRaces(): Promise<PlatformRaceView[]> {
    const data = await this.callTool("list_competitions", {});
    const rows = firstArray(data);
    return rows
      .map((row) => {
        const item = asRecord(row);
        const id = str(item.competition_id) || str(item.id);
        return {
          id,
          name: str(item.name) || str(item.title) || id,
          startAt: str(item.starts_at) || str(item.start_at) || str(item.start_time) || null,
          endAt: str(item.ends_at) || str(item.end_at) || str(item.end_time) || null,
          timeStatus:
            str(item.state) === "active" || str(item.status) === "active" || str(item.status) === "published"
              ? 1
              : 0,
          checkpointNum: num(item.challenge_count) || num(item.challenges_count) || null,
        };
      })
      .filter((race) => race.id);
  }

  async listChallenges(raceId: string): Promise<PlatformChallengeView[]> {
    const data = await this.callTool("list_competition_challenges", {
      competition_id: raceId,
    });
    const rows = firstArray(data);
    // CTFy 题目可能很多；列表字段足够渲染，详情在用户开题时再补。
    return rows
      .map((row) => this.toChallenge(asRecord(row), raceId))
      .filter((item) => item.id)
      .sort((a, b) => Number(a.isSolved) - Number(b.isSolved) || b.points - a.points);
  }

  async challengeDetail(raceId: string, challengeId: string): Promise<PlatformChallengeView> {
    const data = await this.callTool("get_challenge", {
      competition_id: raceId,
      challenge_id: challengeId,
    });
    const obj = asRecord(asRecord(data).challenge ?? data);
    return this.toChallenge(obj, raceId);
  }

  async submitFlag(
    raceId: string,
    challengeId: string,
    flag: string,
  ): Promise<Record<string, unknown>> {
    const instanceId = this.instanceByChallenge.get(challengeId);
    return this.callTool("submit_answer", {
      competition_id: raceId,
      challenge_id: challengeId,
      question_id: "flag",
      answer: flag,
      ...(instanceId ? { instance_id: instanceId } : {}),
    });
  }

  async openScene(raceId: string, challengeId: string): Promise<Record<string, unknown>> {
    const result = await this.callTool("start_instance", {
      competition_id: raceId,
      challenge_id: challengeId,
    });
    const instanceId =
      str(asRecord(result).instance_id) ||
      str(asRecord(asRecord(result).instance).id);
    if (instanceId) this.instanceByChallenge.set(challengeId, instanceId);
    return result;
  }

  async closeScene(raceId: string, challengeId: string): Promise<Record<string, unknown>> {
    const instanceId = this.instanceByChallenge.get(challengeId);
    if (!instanceId) throw new Error("没有记录到该题的 CTFy 实例");
    const result = await this.callTool("stop_instance", {
      competition_id: raceId,
      instance_id: instanceId,
    });
    this.instanceByChallenge.delete(challengeId);
    return result;
  }

  async download(urlPath: string, target: string): Promise<{ bytes: number }> {
    const url = /^https?:\/\//i.test(urlPath)
      ? new URL(urlPath)
      : new URL(urlPath, `${this.baseUrl}/`);
    const response = await this.rawRequest(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CTFy 附件下载失败：HTTP ${response.status}`);
    }
    const ct = String(response.headers["content-type"] ?? "");
    const head = response.body.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
    if (/text\/html/i.test(ct) || head.startsWith("<html") || head.startsWith("<!doctype")) {
      throw new Error("CTFy 附件下载返回 HTML，拒绝导入");
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

  private toChallenge(row: Json, raceId: string): PlatformChallengeView {
    const id = str(row.challenge_id) || str(row.id);
    const categoryName = str(row.category) || str(row.direction);
    const attachments = Array.isArray(row.attachments) ? row.attachments : Array.isArray(row.files) ? row.files : [];
    const attachment = asRecord(attachments[0]);
    const instance = asRecord(row.instance);
    const title = str(row.title) || str(row.name) || id;
    const description = str(row.description) || str(row.prompt) || str(row.statement);
    const targets = targetFromAttackSurface(instance.attack_surface ?? row.attack_surface);
    const solved =
      bool(row.my_fully_solved) ||
      bool(row.solved) ||
      bool(row.my_solved);
    return {
      id,
      taskId: null,
      title,
      direction: categoryName || "Unknown",
      category: categoryOf(categoryName),
      points: num(row.points) || num(row.score) || num(row.value),
      solvedCount: num(row.solved_count) || num(row.solves),
      isSolved: solved,
      description,
      attachmentName:
        str(attachment.filename) ||
        str(attachment.name) ||
        (str(attachment.url) ? str(attachment.url).split("/").pop() ?? null : null),
      attachmentUrl: str(attachment.url) || str(row.attachment_url) || null,
      withScene: bool(row.with_scene) || Boolean(instance.attack_surface),
      sceneReady: Boolean(instance.instance_id || instance.id),
      targets,
      noticeCount: num(row.notice_count),
      difficulty: str(row.difficulty) || null,
    };
  }

  private async callTool(name: string, args: Json): Promise<Json> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const result = asRecord(response.result);
    if (result.isError) {
      throw new Error(`CTFy ${name} 失败：${JSON.stringify(result.content ?? result)}`);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = asRecord(content[0]).text;
    if (typeof text === "string") {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        return { text };
      }
    }
    return result;
  }

  private async rpc(method: string, params: Json): Promise<Json> {
    const payload = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const response = await this.rawRequest(new URL(this.endpoint), body);
    const text = response.body.toString("utf8");
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    const jsonText = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text;
    let parsed: Json;
    try {
      parsed = asRecord(JSON.parse(jsonText));
    } catch {
      throw new Error(`CTFy MCP 返回非 JSON：HTTP ${response.status}`);
    }
    if (parsed.error) throw new Error(`CTFy MCP 错误：${JSON.stringify(parsed.error)}`);
    return parsed;
  }

  private async rawRequest(
    url: URL,
    body: Buffer | null = null,
  ): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json, text/event-stream, application/octet-stream, */*",
        "User-Agent": "Bumimang-CTF-Agent/1.0",
      };
      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(body.length);
      }
      const req = httpsRequest(url, { method: body ? "POST" : "GET", headers, agent: this.agent, timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`CTFy 请求超时：${this.timeoutMs}ms`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
