import type { Event } from "@acode/rpc";
import type { ConversationTelemetryFact } from "@acode/shared/acode-protocol-v4";
import type { IACodeAgentService } from "#src/acode-agent/acodeAgent.js";

export interface ConversationTelemetryWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 对话埋点的 workspace 级只读服务面。它只包装已完成 clientMode 鉴权的 connection-scoped
 * agent service，不另开 RPC channel，也不让 Web/mobile 绕过 desktop-continuous 门禁。
 */
export interface IConversationTelemetryService {
  onFact(target: ConversationTelemetryWorkspaceTarget): Event<ConversationTelemetryFact>;
}

// 审计版保留 UI 仍使用的公开订阅 API：仅转发本地业务事实，不初始化 SDK、不产生网络上报。
export function createConversationTelemetryService(
  acodeAgentService: Pick<IACodeAgentService, "onDynamicConversationTelemetryFact">,
): IConversationTelemetryService {
  return {
    onFact: (target) =>
      // 带 workspace 参数的 RPC Event 必须使用 onDynamic* 命名，
      // 否则 ProxyChannel 会把它当普通 Event，并把 target 误当 listener。
      acodeAgentService.onDynamicConversationTelemetryFact(target),
  };
}
