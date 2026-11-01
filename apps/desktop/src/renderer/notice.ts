/**
 * 轻量瞬态提示条（错误 / 信息）—— 渲染进程「动作结果」的反馈出口。
 *
 * R11（首次用户体验）：扇出等动作是异步的，而且 `session.start` 要 spawn agent，
 * 几秒到几十秒才返回。此前派发结果被 `void ctx.hub.dispatch(...)` 直接丢弃，
 * 用户点完「扇出」只看到窗口关了、什么都没发生（失败时更是一点提示都没有）。
 * 这里不引入任何状态管理，只在 body 上挂一条自动消失的提示，成功给即时反馈，
 * 失败把 `{ok:false, error}` 亮出来。
 */

let lastToast: HTMLElement | null = null;

export function notify(message: string, kind: "error" | "info" = "info"): void {
  if (typeof document === "undefined") return;
  // 连续点击时只保留最新一条，避免提示条堆叠。
  if (lastToast) lastToast.remove();
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.textContent = message;
  document.body.appendChild(t);
  lastToast = t;
  const ttl = kind === "error" ? 8000 : 6000;
  window.setTimeout(() => {
    if (lastToast === t) lastToast = null;
    t.remove();
  }, ttl);
}
