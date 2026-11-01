/**
 * 选择 HubApi 实现：优先用 preload 暴露的真实桥（`window.bumimang`），
 * 没有则回落到进程内 Mock（见 mock/engine.ts）。这是 T11「mock → 真实 IPC」的切换点。
 */
import type { HubApi, HubSnapshot } from "./contract.ts";
import { createMockHub, type MockHubApi } from "./mock/engine.ts";

export function resolveHub(): HubApi {
  const g = globalThis as { bumimang?: HubApi };
  if (g.bumimang) return g.bumimang;
  // P1-E：没有真实主进程时用多任务世界演示任务看板（旧 smoke 仍显式用默认 2 任务）。
  // P6-C 2.5：测试 preload 可注入 __realSnapshot（真实 app 数据）+ __stressStream；
  // ?stress=1/replay 启用 mock 高倍率 stream；默认关闭。
  const stress =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("stress");
  const injectedStream = (globalThis as { __stressStream?: unknown }).__stressStream;
  const stressStream = Array.isArray(injectedStream) ? injectedStream : undefined;
  const injectedSnapshot = (globalThis as { __realSnapshot?: unknown }).__realSnapshot;
  const snapshot =
    injectedSnapshot && typeof injectedSnapshot === "object"
      ? (injectedSnapshot as HubSnapshot)
      : undefined;
  return createMockHub({
    multiTask: true,
    ...(snapshot ? { snapshot } : {}),
    ...(stress ? { stress: true } : {}),
    ...(stress && stressStream ? { stressStream: stressStream as never } : {}),
  });
}

export function isMock(hub: HubApi): hub is MockHubApi {
  return typeof (hub as MockHubApi).start === "function";
}
