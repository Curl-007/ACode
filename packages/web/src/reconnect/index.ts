export {
  computeReconnectBackoffMs,
  createWebReconnectController,
  createWebConnectionGenerationGuard,
  type WebConnectionGenerationGuard,
  type WebReconnectBackoffOptions,
  type WebReconnectController,
  type WebReconnectControllerOptions,
  type WebReconnectState,
} from "./webSocketReconnect.js";
export {
  formatRetryCountdown,
  getWebReconnectCopy,
  resolveWebReconnectLocale,
} from "./webReconnectLocale.js";
export { WebDisconnectOverlay } from "./WebDisconnectOverlay.js";
// 只经 barrel 暴露 main.tsx 实际消费的接线函数；pageLifecycle 的类型（PageLifecycleController/
// Target/PageTransitionEventLike）由测试直接从 ./pageLifecycle.js 引用，不在 barrel 重复导出（避免
// 未消费的 barrel 导出面）。
export { attachWebReconnectPageLifecycle } from "./pageLifecycle.js";
