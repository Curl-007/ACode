// ============================================================
// jcode 桥接：瘦 v4 dispatch（spec R1「北向复用」/ 装配缝调查判定选项 c）
//
// 为什么不复用 ACodeProtocolAgentServer：它把 gateway 硬编码在构造函数里
// （server.ts:276 `createConversationV4Gateway(this.context)`）且强依赖 native
// createACodeApp，无 host 注入缝。故本模块只照抄 server.ts:494-613 的 **v4 子集**，
// 把 method 路由到复用的 ConversationV4Gateway；native 的 legacy session/*、plugins、
// workspace 等一律不接（jcode 后端无对应，见 spec「未做与取舍」）。
//
// subscribe/resync 的 initialWires 必须在 response line **之后**写（transport.ts:263-281
// 消费 takePostResponseBatch），故用 post-response outbox，按 request id 隔离。
// ============================================================

import type {
  ACodeProtocolError,
  ACodeProtocolMessage,
  ACodeProtocolRequest,
  ACodeProtocolRequestId,
  ACodeProtocolResponse,
} from "@acode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4CapabilityQueryParamsSchema,
  v4CapabilityQueryResultSchema,
} from "@acode/shared/acode-protocol-v4";
import type { ConversationV4Gateway } from "@acode/bootstrap";

/** JSON-RPC 错误码（保留段）。 */
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

/** subscribe/resync 的 post-response 帧批（对齐 server.ts:518-524 的 outbox 形态）。 */
export interface PostResponseBatch {
  readonly messages: readonly { method: string; params: unknown }[];
  commit(): boolean;
}

export type PostResponseOutbox = Map<ACodeProtocolRequestId, PostResponseBatch>;

export interface JcodeDispatchDeps {
  gateway: ConversationV4Gateway;
  outbox: PostResponseOutbox;
}

/** 请求判定（对齐 server-types.ts:195：有 method 且有 id）。 */
function isRequest(message: ACodeProtocolMessage): message is ACodeProtocolRequest {
  return "method" in message && "id" in message;
}

function ok(id: ACodeProtocolRequestId, result: unknown): ACodeProtocolResponse {
  return { id, result } as ACodeProtocolResponse;
}

function fail(id: ACodeProtocolRequestId, code: number, message: string, data?: unknown): ACodeProtocolError {
  return { error: { code, data, message }, id } as ACodeProtocolError;
}

/**
 * capabilitiesQuery：jcode 后端**不支持** independentPlanState（无 plan 一等状态，
 * spec R4-1 权限/模式收敛）。返回 supported:false 使客户端 ensureIndependentPlanSupport
 * 抛 proto.independentPlanUnsupported——该检查仅在 planEnabled 时触发
 * （acodeAgentService.ts:5262-5268），故只降级 plan 模式，不阻断普通对话。
 *
 * 不复用 native queryV4Capability（它对 independentPlanState 返回 true），本地按
 * shared schema 严格解析后恒回 false，避免给 jcode 后端谎报能力。
 */
function queryCapability(rawParams: unknown): unknown {
  const params = v4CapabilityQueryParamsSchema.parse(rawParams);
  return v4CapabilityQueryResultSchema.parse({
    capability: params.capability,
    // jcode 后端无任何独立能力位（无 plan 一等状态、无 fork/rewind、无权限弹窗）。
    // 恒回 false；未来若接通某能力，在此按 params.capability 分派。
    supported: false,
  });
}

/** subscribe/resync 共用：把 initialWires 存进 outbox，response 只回 ack。 */
function stageInitialWires(
  outbox: PostResponseOutbox,
  requestId: ACodeProtocolRequestId,
  dispatch: { initialWires: readonly unknown[]; commit(): boolean; ack: unknown },
): unknown {
  if (dispatch.initialWires.length > 0) {
    outbox.set(requestId, {
      messages: dispatch.initialWires.map((wire) => ({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      })),
      commit: () => dispatch.commit(),
    });
  }
  return { ack: dispatch.ack };
}

/** v4 method → gateway 路由（server.ts:494-613 的 jcode 后端子集）。 */
async function dispatchRequest(deps: JcodeDispatchDeps, request: ACodeProtocolRequest): Promise<unknown> {
  const { gateway, outbox } = deps;
  switch (request.method) {
    case V4_METHODS.capabilitiesQuery:
      return queryCapability(request.params);
    case V4_METHODS.connectionFlow:
      gateway.setConnectionFlowState(request.params);
      return {};
    case V4_METHODS.conversationSubscribe: {
      // 同一 subscribe 按 topic 前缀分派（对齐 server.ts:504-527）。
      const topic = (request.params as { topic?: unknown } | null)?.topic;
      let dispatch;
      if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
        dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
      } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
        dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
      } else {
        dispatch = await gateway.subscribeReserved(request.params);
      }
      return stageInitialWires(outbox, request.id, dispatch);
    }
    case V4_METHODS.conversationResync:
      return stageInitialWires(outbox, request.id, gateway.resyncReserved(request.params));
    case V4_METHODS.conversationUnsubscribe:
      gateway.unsubscribe(request.params);
      return {};
    case V4_METHODS.conversationRowsRange:
      return await gateway.rowsRange(request.params);
    // 附件三段事务：网关的 attachment registry 是 host 无关的（spec R2/§5），
    // commit 后经 host.putSessionAttachment 落地——jcode 后端未实现该可选方法，
    // 故 commit 会降级（gateway 内部处理），但 begin/chunk/abort 账本仍走通。
    case V4_METHODS.attachmentBegin:
      return await gateway.attachmentBegin(request.params);
    case V4_METHODS.attachmentChunk:
      return await gateway.attachmentChunk(request.params);
    case V4_METHODS.attachmentCommit:
      return await gateway.attachmentCommit(request.params);
    case V4_METHODS.attachmentAbort:
      await gateway.attachmentAbort(request.params);
      return {};
    case V4_METHODS.command:
      return await gateway.handleCommand(request.params);
    case V4_METHODS.commandsQuery:
      return await gateway.queryCommands(request.params);
    default:
      // 其余 v4 method（plans/fileChanges/workflow*/visualization/networkCapture/
      // usage* 等）依赖 native context 或 jcode 无对应数据（spec「未做与取舍」）：
      // 明确回 method-not-found，客户端据此降级，不静默返回空对象骗过调用方。
      throw Object.assign(new Error(`jcode bridge: method not supported: ${request.method}`), {
        code: JSONRPC_METHOD_NOT_FOUND,
      });
  }
}

/**
 * connection 的 handleMessage：分流 response（忽略，jcode 后端不发反向请求）/
 * request（dispatch）/ notification（忽略）。返回出站帧或 undefined。
 */
export function createJcodeMessageHandler(
  deps: JcodeDispatchDeps,
): (message: ACodeProtocolMessage) => Promise<ACodeProtocolResponse | ACodeProtocolError | undefined> {
  return async (message) => {
    // 客户端对服务端反向请求的响应：jcode 后端不发起反向请求（无 interaction/*），
    // 收到即忽略（不留悬挂——本就没有在飞的反向请求 id）。
    if ("id" in message && !("method" in message)) return undefined;
    if (!isRequest(message)) return undefined; // notification：忽略
    const request = message;
    // request id 可复用；新请求不能继承上一请求未消费的 outbox（对齐 server.ts:474）。
    deps.outbox.delete(request.id);
    try {
      const result = await dispatchRequest(deps, request);
      return ok(request.id, result);
    } catch (error) {
      deps.outbox.delete(request.id);
      const code =
        typeof (error as { code?: unknown })?.code === "number"
          ? (error as { code: number }).code
          : JSONRPC_INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);
      return fail(request.id, code, message);
    }
  };
}
