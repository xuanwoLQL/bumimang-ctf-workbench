/**
 * 渲染进程内的共享上下文：把 hub / store 在三个分栏之间传递。
 */
import type { HubApi } from "./contract.ts";
import type { Store } from "./store.ts";

export interface UiCtx {
  hub: HubApi;
  store: Store;
}
