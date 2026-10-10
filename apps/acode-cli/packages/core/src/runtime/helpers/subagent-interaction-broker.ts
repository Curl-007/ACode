import type {
  InteractionRequestOrigin,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
} from "../deps.js";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "../../subagent/interaction-origin.js";

interface SubagentInteractionBrokerContext extends SubagentInteractionOriginContext {
  parentToolCallId?: PermissionBrokerRequest["toolCallId"] | string;
}

/**
 * 谱系合并（specs/subagent-interaction-origin-lineage.md R1-R3）：外层 broker 把
 * 「自己这一层」append 进内层已建的 origin，并以自己的 parentSessionId 覆写
 * rootSessionId——与 sessionId 改写同款「外层后写」纪律，最外层最后写，任意深度
 * rootSessionId 必然是根会话（机械保证，不查表、不读 config 谱系字段）。
 * 只在 request.origin 已存在（= 本层不是发起者）时调用；depth 1 永不进入，
 * origin 与历史结构逐字节一致（R0）。
 */
function appendAncestorLayer(
  origin: InteractionRequestOrigin,
  context: SubagentInteractionBrokerContext,
): InteractionRequestOrigin {
  return {
    ...origin,
    ancestors: [
      ...(origin.ancestors ?? []),
      {
        agentId: context.agentId,
        agentType: context.agentType,
        sessionId: context.childSessionId,
        parentSessionId: context.parentSessionId,
        ...(context.description ? { description: context.description } : {}),
        ...(context.parentToolCallId ? { parentToolCallId: context.parentToolCallId } : {}),
        ...(context.parentTurnId ? { parentTurnId: context.parentTurnId } : {}),
      },
    ],
    rootSessionId: context.parentSessionId,
  };
}

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort {
  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): Promise<PermissionBrokerResult> {
      // 子 agent 的 permission / AskUserQuestion / ExitPlanMode 都需要父 task 的 UI 响应；
      // broker request 对外路由到父 session，origin 保留 child 归属，便于 UI 与日志识别来源。
      //
      // 本包装可以叠加。`sessionId` 由**外层**（离客户端更近的一层）
      // 最后改写，所以任意深度最终都落到根会话；`origin` 反过来保留**内层**已有值，
      // 归属永远是真正发起请求的那个子代理，不会被外层覆盖成中间层。
      // 中间层不丢：外层把逐层谱系 append 进 origin.ancestors（R2，见 appendAncestorLayer）。
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: request.origin
            ? appendAncestorLayer(request.origin, context)
            : buildSubagentInteractionOrigin(context, request.turnId),
        },
        options,
      );
    },
  };
}
