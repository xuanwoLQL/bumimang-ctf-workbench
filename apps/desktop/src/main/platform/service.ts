/**
 * 比赛平台运行态。
 *
 * 凭据与题目数据分开保存：
 *  - 密码只在 Electron safeStorage 可用时加密落盘，平台状态 JSON 不包含 token/密码；
 *  - 题目/比赛映射可以离线读取，因此平台暂时不可达时 UI 仍能展示上次同步结果。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PlatformChallengeView,
  PlatformConnectionStatus,
  PlatformRaceView,
  PlatformStateView,
  WpMatchView,
} from "../../../../../packages/shared-protocol/events.ts";
import type { PlatformConfig } from "../config/loader.ts";
import type { PlatformAdapter, PlatformUser } from "./adapter.ts";
import { NestClient } from "./nest-client.ts";
import { CtfdClient } from "./ctfd-client.ts";
import { CtfyClient } from "./ctfy-client.ts";
import type { CopiedWp, WpLibrary } from "./wp-library.ts";

interface PersistedPlatformState {
  version: 1;
  baseUrl: string;
  raceId: string | null;
  username: string | null;
  user: PlatformUser | null;
  provider?: string;
  race: PlatformRaceView | null;
  challenges: PlatformChallengeView[];
  taskByChallenge: Record<string, string>;
  wpCountByChallenge: Record<string, number>;
  lastSyncAt: number | null;
}

export interface PlatformSecretCodec {
  encrypt(plain: string): string | null;
  decrypt(encrypted: string): string | null;
}

export interface PlatformServiceOptions {
  config: PlatformConfig;
  statePath: string;
  secretPath: string;
  wpLibrary: WpLibrary;
  secretCodec?: PlatformSecretCodec;
  env?: NodeJS.ProcessEnv;
  onChange?: (platform: PlatformStateView) => void;
}

function emptyState(config: PlatformConfig): PersistedPlatformState {
  return {
    version: 1,
    baseUrl: config.baseUrl,
    provider: config.provider,
    raceId: config.raceId ?? null,
    username: config.username ?? null,
    user: null,
    race: null,
    challenges: [],
    taskByChallenge: {},
    wpCountByChallenge: {},
    lastSyncAt: null,
  };
}

function normalizeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveProvider(raw: string, baseUrl: string, password: string): string {
  if (raw && raw !== "auto") return raw;
  const url = baseUrl.toLowerCase();
  if (password.startsWith("pf_") || url.includes("ctfy")) return "ctfy";
  if (password.startsWith("ctfd_") || url.includes("ctfd")) return "ctfd";
  if (url.includes("cyberpeace") || url.includes("nestctf")) return "nest-cyberpeace";
  // 无法从 URL 判断时默认尝试强网拟态；UI 明确选择其他适配器时不会走这里。
  return "nest-cyberpeace";
}

export class PlatformService {
  private readonly config: PlatformConfig;
  private readonly statePath: string;
  private readonly secretPath: string;
  private readonly wpLibrary: WpLibrary;
  private readonly secretCodec?: PlatformSecretCodec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onChange?: (platform: PlatformStateView) => void;
  private client: PlatformAdapter;
  private state: PersistedPlatformState;
  private status: PlatformConnectionStatus;
  private error: string | null = null;
  private persistChain = Promise.resolve();
  private syncing: Promise<PlatformStateView> | null = null;

  constructor(opts: PlatformServiceOptions) {
    this.config = opts.config;
    this.statePath = opts.statePath;
    this.secretPath = opts.secretPath;
    this.wpLibrary = opts.wpLibrary;
    this.secretCodec = opts.secretCodec;
    this.env = opts.env ?? process.env;
    this.onChange = opts.onChange;
    this.state = this.loadState();
    this.client = this.makeClient(this.state.provider ?? this.config.provider, this.state.baseUrl);
    this.status = this.state.lastSyncAt
      ? "offline"
      : this.config.username || this.state.username
        ? "needs_login"
        : "unconfigured";
  }

  async autoConnect(): Promise<void> {
    if (!this.config.enabled || !this.config.autoConnect) return;
    const username =
      this.env.BUMIMANG_PLATFORM_USER?.trim() ||
      this.state.username ||
      this.config.username ||
      "";
    const provider = this.state.provider ?? this.config.provider;
    if (!username && provider !== "ctfd" && provider !== "ctfy") {
      this.status = "unconfigured";
      this.emit();
      return;
    }
    const password =
      this.env.BUMIMANG_PLATFORM_PASSWORD ||
      this.env.NEST_PASS ||
      this.readSavedPassword();
    if (!password) {
      this.status = "needs_login";
      this.emit();
      return;
    }
    try {
      await this.connect({
        username,
        password,
        baseUrl: this.state.baseUrl || this.config.baseUrl,
        provider,
        raceId: this.state.raceId ?? this.config.raceId,
        remember: false,
      });
    } catch (err) {
      this.status = this.state.challenges.length > 0 ? "offline" : "error";
      this.error = normalizeError(err);
      this.emit();
    }
  }

  async connect(input: {
    username: string;
    password: string;
    baseUrl?: string;
    provider?: string;
    raceId?: string;
    remember?: boolean;
  }): Promise<PlatformStateView> {
    const username = input.username.trim();
    const password = input.password;
    if (!password) throw new Error("平台密码不能为空");
    const baseUrl = (input.baseUrl?.trim() || this.config.baseUrl).replace(/\/+$/, "");
    const provider = resolveProvider(
      input.provider?.trim() || this.state.provider || this.config.provider,
      baseUrl,
      input.password,
    );
    if (!username && provider !== "ctfd" && provider !== "ctfy") {
      throw new Error("平台账号不能为空");
    }

    this.status = "connecting";
    this.error = null;
    this.emit();
    try {
      this.client = this.makeClient(provider, baseUrl);
      const result = await this.client.login(username, password);
      this.state.baseUrl = baseUrl;
      this.state.provider = provider;
      this.state.username = username;
      this.state.user = result.user;
      if (input.raceId?.trim()) this.state.raceId = input.raceId.trim();
      this.status = "connected";
      if (input.remember !== false) this.savePassword(username, password, baseUrl);
      await this.persist();
      this.emit();
      return await this.sync(input.raceId?.trim() || this.state.raceId || undefined);
    } catch (err) {
      this.status = this.state.challenges.length > 0 ? "offline" : "error";
      this.error = normalizeError(err);
      this.emit();
      throw err;
    }
  }

  logout(): PlatformStateView {
    this.client = this.makeClient(this.state.provider ?? this.config.provider, this.state.baseUrl);
    this.status = "needs_login";
    this.error = null;
    this.emit();
    return this.snapshot();
  }

  async sync(raceId?: string): Promise<PlatformStateView> {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncInner(raceId).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async syncInner(raceId?: string): Promise<PlatformStateView> {
    if (!this.client.connected) {
      throw new Error("平台尚未登录");
    }
    this.status = "syncing";
    this.error = null;
    this.emit();
    try {
      const races = await this.client.listRaces();
      const wanted = raceId?.trim() || this.state.raceId || this.config.raceId || "";
      let race =
        races.find((item) => item.id === wanted) ??
        races.find((item) => item.timeStatus === 1) ??
        races[0] ??
        null;
      if (!race && wanted) race = await this.client.raceInfo(wanted);
      if (!race) throw new Error("当前账号没有可见比赛");

      const challenges = await this.client.listChallenges(race.id);
      this.state.raceId = race.id;
      this.state.race = race;
      this.state.challenges = challenges.map((challenge) => ({
        ...challenge,
        taskId: this.state.taskByChallenge[challenge.id] ?? null,
        wpMatchCount: this.state.wpCountByChallenge[challenge.id] ?? 0,
      }));
      this.state.lastSyncAt = Date.now();
      this.status = "connected";
      await this.persist();
      this.emit();
      // WP 索引首次构建可能几秒；后台预热，避免用户第一次点“开题”才等待。
      void this.wpLibrary
        .ensureIndex()
        .then(() => this.emit())
        .catch(() => undefined);
      return this.snapshot();
    } catch (err) {
      this.status = this.state.challenges.length > 0 ? "offline" : "error";
      this.error = normalizeError(err);
      this.emit();
      throw err;
    }
  }

  async refreshChallenge(challengeId: string): Promise<PlatformChallengeView | null> {
    if (!this.client.connected || !this.state.raceId) return this.challenge(challengeId);
    const detail = await this.client.challengeDetail(this.state.raceId, challengeId);
    const index = this.state.challenges.findIndex((item) => item.id === challengeId);
    if (index >= 0) {
      const previous = this.state.challenges[index];
      const direction =
        detail.direction && detail.direction !== "Unknown"
          ? detail.direction
          : previous.direction;
      const category = detail.category !== "unknown" ? detail.category : previous.category;
      this.state.challenges[index] = {
        ...previous,
        ...detail,
        // 详情接口经常只返回场景字段；列表元数据必须单调保留，不能被空值抹掉。
        title: detail.title || previous.title,
        direction,
        category,
        points: Math.max(detail.points, previous.points),
        solvedCount: Math.max(detail.solvedCount, previous.solvedCount),
        isSolved: detail.isSolved || previous.isSolved,
        description: detail.description || previous.description,
        attachmentName: detail.attachmentName || previous.attachmentName,
        attachmentUrl: detail.attachmentUrl || previous.attachmentUrl,
        withScene: detail.withScene || previous.withScene,
        sceneReady: detail.sceneReady,
        targets: detail.sceneReady
          ? detail.targets.length > 0
            ? detail.targets
            : previous.targets
          : [],
        noticeCount: Math.max(detail.noticeCount, previous.noticeCount),
        taskId: this.state.taskByChallenge[challengeId] ?? null,
        wpMatchCount: this.state.wpCountByChallenge[challengeId] ?? 0,
      };
      await this.persist();
      this.emit();
    }
    return this.challenge(challengeId);
  }

  challenge(challengeId: string): PlatformChallengeView | null {
    const found = this.state.challenges.find((item) => item.id === challengeId);
    return found ? { ...found, targets: found.targets.map((target) => ({ ...target })) } : null;
  }

  challenges(): PlatformChallengeView[] {
    return this.state.challenges.map((item) => ({
      ...item,
      targets: item.targets.map((target) => ({ ...target })),
    }));
  }

  attachTask(challengeId: string, taskId: string): void {
    this.state.taskByChallenge[challengeId] = taskId;
    const challenge = this.state.challenges.find((item) => item.id === challengeId);
    if (challenge) challenge.taskId = taskId;
    void this.persist();
    this.emit();
  }

  taskForChallenge(challengeId: string): string | null {
    return this.state.taskByChallenge[challengeId] ?? null;
  }

  challengeForTask(taskId: string): PlatformChallengeView | null {
    const id = Object.entries(this.state.taskByChallenge).find(([, value]) => value === taskId)?.[0];
    return id ? this.challenge(id) : null;
  }

  setWpMatchCount(challengeId: string, count: number): void {
    this.state.wpCountByChallenge[challengeId] = count;
    const challenge = this.state.challenges.find((item) => item.id === challengeId);
    if (challenge) challenge.wpMatchCount = count;
    void this.persist();
    this.emit();
  }

  async searchWp(challengeId: string, limit = 8): Promise<WpMatchView[]> {
    const challenge = this.challenge(challengeId);
    if (!challenge) throw new Error(`平台题目不存在：${challengeId}`);
    const matches = await this.wpLibrary.search(challenge, limit);
    this.setWpMatchCount(challengeId, matches.length);
    this.emit();
    return matches;
  }

  async copyWp(challengeId: string, taskDir: string, limit = 6): Promise<CopiedWp[]> {
    const challenge = this.challenge(challengeId);
    if (!challenge) throw new Error(`平台题目不存在：${challengeId}`);
    const matches = await this.wpLibrary.copyMatches(challenge, taskDir, limit);
    this.setWpMatchCount(challengeId, matches.length);
    return matches;
  }

  async downloadAttachment(challengeId: string, targetDir: string): Promise<string | null> {
    const challenge = this.challenge(challengeId);
    if (!challenge?.attachmentUrl) return null;
    const rawName = challenge.attachmentName || "attachment.bin";
    const safe = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 180) || "attachment.bin";
    const target = join(targetDir, safe);
    await this.client.download(challenge.attachmentUrl, target);
    return target;
  }

  async openScene(challengeId: string): Promise<PlatformChallengeView> {
    if (!this.state.raceId) throw new Error("尚未选择比赛");
    if (!this.client.openScene) throw new Error(`平台 ${this.client.provider} 不支持开靶`);
    await this.client.openScene(this.state.raceId, challengeId);
    // 开靶请求 accepted 后先短暂等地址；仍为空则立即把控制权交还给调度器，
    // 由 Hub 在后台继续轮询，避免把四个 Agent 的启动整整阻塞三分钟。
    const detail = await this.waitScene(challengeId, true, 8_000, false);
    return detail;
  }

  async closeScene(challengeId: string): Promise<PlatformChallengeView> {
    if (!this.state.raceId) throw new Error("尚未选择比赛");
    if (!this.client.closeScene) throw new Error(`平台 ${this.client.provider} 不支持关靶`);
    await this.client.closeScene(this.state.raceId, challengeId);
    const detail = await this.waitScene(challengeId, false, 40_000, true);
    return detail;
  }

  async submitFlag(challengeId: string, flag: string): Promise<Record<string, unknown>> {
    if (!this.state.raceId) throw new Error("尚未选择比赛");
    return this.client.submitFlag(this.state.raceId, challengeId, flag.trim());
  }

  snapshot(): PlatformStateView {
    const wp = this.wpLibrary.status();
    return {
      provider: this.state.provider ?? this.config.provider,
      status: this.status,
      baseUrl: this.state.baseUrl,
      username: this.state.username,
      displayName: this.state.user?.displayName ?? null,
      team: this.config.teamName || this.state.user?.displayName || this.state.user?.team || null,
      organization: this.state.user?.organization ?? [],
      race: this.state.race ? { ...this.state.race } : null,
      challenges: this.challenges(),
      lastSyncAt: this.state.lastSyncAt,
      cached: !this.client.connected && this.state.challenges.length > 0,
      error: this.error,
      autoConnect: this.config.autoConnect,
      autoSync: this.config.autoSync,
      autoSubmit: this.config.autoSubmit,
      syncIntervalSeconds: this.config.syncIntervalSeconds,
      wpRoot: wp.root,
      wpIndexed: wp.indexed,
      wpCount: wp.count,
    };
  }

  private makeClient(provider: string, baseUrl: string): PlatformAdapter {
    if (provider === "ctfd") {
      return new CtfdClient({
        baseUrl,
        insecureTls: this.config.insecureTls,
        timeoutMs: 30_000,
      });
    }
    if (provider === "ctfy") {
      return new CtfyClient({
        baseUrl,
        insecureTls: this.config.insecureTls,
        timeoutMs: 90_000,
      });
    }
    return new NestClient({
      baseUrl,
      desKey: this.config.desKey,
      insecureTls: this.config.insecureTls,
      timeoutMs: 30_000,
    });
  }

  private async waitScene(
    challengeId: string,
    wantReady: boolean,
    timeoutMs: number,
    throwOnTimeout: boolean,
  ): Promise<PlatformChallengeView> {
    let last = this.challenge(challengeId);
    const deadline = Date.now() + Math.max(2_000, timeoutMs);
    while (Date.now() < deadline) {
      last = (await this.refreshChallenge(challengeId)) ?? last;
      if (last) {
        const ready =
          last.sceneReady === wantReady &&
          (!wantReady || !last.withScene || last.targets.length > 0);
        if (ready) return last;
      }
      await new Promise<void>((resolveWait) =>
        setTimeout(resolveWait, Math.min(2_000, Math.max(0, deadline - Date.now()))),
      );
    }
    if (!last) throw new Error("读取场景状态失败");
    if (throwOnTimeout) {
      throw new Error(wantReady ? "场景仍在创建，请稍后同步" : "场景仍在关闭，请稍后同步");
    }
    return last;
  }

  private loadState(): PersistedPlatformState {
    if (!existsSync(this.statePath)) return emptyState(this.config);
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedPlatformState;
      if (parsed?.version !== 1) return emptyState(this.config);
      return {
        ...emptyState(this.config),
        ...parsed,
        baseUrl: parsed.baseUrl || this.config.baseUrl,
        challenges: Array.isArray(parsed.challenges) ? parsed.challenges : [],
        taskByChallenge: parsed.taskByChallenge ?? {},
        wpCountByChallenge: parsed.wpCountByChallenge ?? {},
      };
    } catch {
      return emptyState(this.config);
    }
  }

  private savePassword(username: string, password: string, baseUrl: string): void {
    if (!this.secretCodec) return;
    try {
      const encrypted = this.secretCodec.encrypt(password);
      if (!encrypted) return;
      const payload = { version: 1, username, baseUrl, encrypted };
      const temp = `${this.secretPath}.tmp-${process.pid}-${Date.now()}`;
      mkdirSync(dirname(this.secretPath), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, "utf8");
      renameSync(temp, this.secretPath);
    } catch {
      // 凭据保存失败不影响本次登录。
    }
  }

  private readSavedPassword(): string | null {
    if (!this.secretCodec || !existsSync(this.secretPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.secretPath, "utf8")) as {
        username?: string;
        baseUrl?: string;
        encrypted?: string;
      };
      if (parsed.username && !this.state.username) this.state.username = parsed.username;
      if (parsed.baseUrl && !this.state.baseUrl) this.state.baseUrl = parsed.baseUrl;
      return parsed.encrypted ? this.secretCodec.decrypt(parsed.encrypted) : null;
    } catch {
      return null;
    }
  }

  private emit(): void {
    try {
      this.onChange?.(this.snapshot());
    } catch {
      // 广播失败不能反向破坏平台动作。
    }
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.statePath), { recursive: true });
        const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
        await rename(temp, this.statePath);
      });
    return this.persistChain;
  }
}

