// 拆分说明（满足 400 行架构上限）：翻译桥按职责分四叶，本文件收敛为公开面 barrel：
// - translateSupport.ts：HarnessMethodError / notSupported / 上下文 / H2 入参校验（schema safeParse）
// - translateEvents.ts：内部 session/服务事件 → harness 公开事件投影（公开面刻意小于内部协议）
// - translateRun.ts：run 的订阅-发送-归属等待半程（H1）
// - translateHandlers.ts：方法分发表（方法名 → services 入口）与未知方法名断言（spec 附录单一出处）
// 翻译桥绝不 import acode-protocol（v4），只经 services 层 API 形状调用；能力缺失如实 not_supported。
export {
  HarnessMethodError,
  notSupported,
  parseHarnessMethodParams,
  type HarnessTranslateContext,
} from "./translateSupport.js";
export {
  translateSessionEvent,
  translateAgentServiceEvent,
} from "./translateEvents.js";
export { runAndWaitTurn } from "./translateRun.js";
export {
  createHarnessMethodHandlers,
  assertKnownHarnessMethod,
} from "./translateHandlers.js";
