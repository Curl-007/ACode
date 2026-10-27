// U11 工具图片外置引用生产门的**可信 clientMode 盖章**（spec:
// apps/acode-cli/specs/tool-media-attachment-ref.md R10.2a）。
//
// 为什么单独一个叶子：`sendConversationCommandV4` 是装配闭包里的私有函数，其 createSession 分支
// 决定「哪个 clientMode 进 payload、进而决定 CLI 是否为该会话产 ref」——这是**安全关键**决策，
// 必须可单测。抽成无依赖的纯叶子后，服务里只剩一次调用，测试能直接钉住覆盖语义与来源纪律。
//
// 安全模型（两层）：
//   第 1 层（facade，acodeAgentConnectionScope.withTrustedConnection）：删掉调用方**顶层**可伪造的
//     `clientMode`，写入 host 真值 carrier（`__acodeTrustedV4Connection`）。
//   第 2 层（本叶子）：facade **不触碰** `envelope.payload.clientMode`——renderer 仍能在 payload 里
//     伪造 `clientMode: "desktop-continuous"`。故盖章必须是**覆盖**语义：可信值写在 spread 之后，
//     伪造值永不存活。
import type { ACodeTaskClientMode } from "@acode/shared";
import {
  readTrustedACodeAgentV4Connection,
  type ACodeAgentV4ClientMode,
} from "./acodeAgentConnectionScope.js";

/**
 * 解析本次命令的**可信** clientMode。来源优先级（与 sendConversationCommandV4 既有实现逐字一致，
 * 此处只是单源化以便测试）：
 *   1. trusted carrier（facade 盖章的 host 真值）——正常 RPC 路径恒在此命中；
 *   2. `params.clientMode`（host 内部 adapter 直调，未经 facade 时的兼容回退）；
 *   3. `"desktop-continuous"`（最终缺省）。
 *
 * **安全不变量**：本函数**绝不**读 `params.envelope.payload.clientMode`。payload 里的 clientMode
 * 是 renderer 可控字段，把它当来源就等于让 renderer 自选是否开启 ref 生产。
 */
export function resolveTrustedCommandClientMode(params: {
  clientMode?: ACodeTaskClientMode;
}): ACodeAgentV4ClientMode {
  return (
    readTrustedACodeAgentV4Connection(params)?.clientMode ??
    params.clientMode ??
    "desktop-continuous"
  );
}

/**
 * 用可信 clientMode **无条件盖章** createSession payload。
 *
 * 覆盖语义（`...payload` 在前、`clientMode: trustedClientMode` 在后）是安全关键：即使 renderer 在
 * payload 里预置了 `clientMode: "desktop-continuous"`，盖章后也一定等于 `trustedClientMode`。
 * 返回新对象，不改入参（envelope 是不可变事实）。
 */
export function stampCreateSessionClientMode<TPayload extends object>(
  payload: TPayload,
  trustedClientMode: ACodeAgentV4ClientMode,
): TPayload & { clientMode: ACodeAgentV4ClientMode } {
  return { ...payload, clientMode: trustedClientMode };
}
