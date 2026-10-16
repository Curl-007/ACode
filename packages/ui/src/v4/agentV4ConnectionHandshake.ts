// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { IACodeAgentService } from "@acode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsInteractionAnswerRoster,
  hostSupportsWorkflowRunDeltas,
  type AttachAnswersDeclaration,
  type ClientHello,
  type HelloMessage,
} from "@acode/shared/acode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IACodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

// answers 代答能力申报（shared attach-answers.ts，specs/protocol-attachment-typed-errors.md
// R3/W2）：ACode 客户端对 pendingInteraction 闭集的全部成员都有既有交互面——
// permission → PermissionDialog（v4 pendingInteractionAdapter 映射）、userInput →
// V4UserInputDialog/V4InteractionDialogs、workspaceHookReview → WorkspaceHookPendingBanner
// （与下方 workspaceHookReviewUi 能力同批）。因此按闭集全量申报，无空集成员。
// 列表显式钉死而不取 schema options：闭集未来扩员时必须先有对应交互面再申报。
const CLIENT_ATTACH_ANSWERS: AttachAnswersDeclaration = [
  "permission",
  "userInput",
  "workspaceHookReview",
];

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    // `workflowRunDeltas` 的声明是**单向**的：只有 Host 先在 hello 里宣告，客户端才能回声明。
    // clientHello 的 capabilities 是 `.strict()` 的，向老 Host 发一个它不认识的键会让整条
    // clientHello 解析失败、连接握不上手——这不是降级，是整个会话面板打不开。
    // `answers` 同款纪律：只有 hello 亮出 interactionAnswerRoster 位才携带（R3）。
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
      ...(hostSupportsInteractionAnswerRoster(hello.capabilities)
        ? { answers: CLIENT_ATTACH_ANSWERS }
        : {}),
    };
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
      // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities,
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
