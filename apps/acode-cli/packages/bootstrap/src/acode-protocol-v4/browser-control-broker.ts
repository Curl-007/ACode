import { randomUUID } from "node:crypto";
import type { BrowserControlPort, TraceContext } from "@acode/contracts";
import { LEGACY_SKEW_FALLBACK_METHODS } from "@acode/shared";
import { v4InteractionBrowserExecuteResultSchema, v4InteractionBrowserListResultSchema, V4_METHODS } from "@acode/shared/acode-protocol-v4";
// v4 面符号只挂在子路径（根桶不 re-export v4，M2-3 既有纪律）。result 面本就中立，
// v4 leaf 直接重导出中立叶——两侧 schema 是同一实例。

import {
  protocolTraceFromTraceContext,
  requireSession,
  type ACodeProtocolAgentServerContext,
  type ACodeProtocolClientRequestOptions,
} from "./server-types.js";
import { requestV4WithLegacyFallback } from "./dual-form-request.js";

/**
 * M2-4 dual-form（§2.3）：browser 反向请求经共享助手 requestV4WithLegacyFallback
 * （dual-form-request.ts，M2-7 抽出）v4 先行，-32601 回落 legacy。四个 requestClient
 * 站点（list / execute / cancelRequest / lifecycle）共用，保证偏斜门控一致。
 *
 * ProtocolBrowserControlBroker —— agent 侧 BrowserControlPort 实现。
 * browser-client 的 agent.browsers.* 每个调用经此把一条 BrowserCommand 变成
 * ACode Protocol 的 interaction/browserExecute 反向请求，由 app（host→main WebContentsView/CDP）
 * 执行并返回结果。与 permission broker 并列注入（server-operations 的 createWorkspaceACodeApp options）。
 */
export function createProtocolBrowserControlBroker(
  context: ACodeProtocolAgentServerContext,
): BrowserControlPort {
  const connectionsBySession = new Map<
    string,
    Map<string, { browserId: string; browserGeneration: number }>
  >();

  const rememberConnection = (sessionId: string, browserId: string, browserGeneration: number) => {
    const connections = connectionsBySession.get(sessionId) ?? new Map();
    connections.set(`${browserId}\u0000${browserGeneration}`, { browserId, browserGeneration });
    connectionsBySession.set(sessionId, connections);
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command: { method: "turnEnded"; turnId?: string } | { method: "closeSession" },
  ): Promise<void> => {
    const connections = [...(connectionsBySession.get(sessionId)?.values() ?? [])];
    await Promise.allSettled(
      connections.map(({ browserId, browserGeneration }) =>
        requestV4WithLegacyFallback(
          context,
          V4_METHODS.interactionBrowserExecute,
          LEGACY_SKEW_FALLBACK_METHODS.interactionBrowserExecute,
          {
            ...buildBrowserRequestContext(context, { sessionId, turnId }),
            browserId,
            browserGeneration,
            command,
          },
          v4InteractionBrowserExecuteResultSchema,
          v4InteractionBrowserExecuteResultSchema,
        ),
      ),
    );
  };

  return {
    async list({ sessionId, turnId, traceContext, signal }) {
      const result = await requestV4WithLegacyFallback(
        context,
        V4_METHODS.interactionBrowserList,
        LEGACY_SKEW_FALLBACK_METHODS.interactionBrowserList,
        buildBrowserRequestContext(context, { sessionId, turnId, traceContext }),
        v4InteractionBrowserListResultSchema,
        v4InteractionBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
      return result.browsers;
    },

    async execute({
      browserId,
      browserGeneration,
      sessionId,
      turnId,
      command,
      traceContext,
      signal,
    }) {
      rememberConnection(sessionId, browserId, browserGeneration);
      const requestContext = buildBrowserRequestContext(context, {
        sessionId,
        turnId,
        traceContext,
      });
      const cancelBackendRequest = () => {
        // 只取消 agent 侧 requestClient 会让 host/main 的 CDP 动作继续执行。
        // 这里用同一 backend/generation 发送内部 cancelRequest，main 再按原 requestId 中断 waiter；
        // 已下发动作无法证明无副作用时由 manager 返回 uncertain 标记。
        void requestV4WithLegacyFallback(
          context,
          V4_METHODS.interactionBrowserExecute,
          LEGACY_SKEW_FALLBACK_METHODS.interactionBrowserExecute,
          {
            ...buildBrowserRequestContext(context, { sessionId, turnId, traceContext }),
            browserId,
            browserGeneration,
            command: { method: "cancelRequest", requestId: requestContext.requestId },
          },
          v4InteractionBrowserExecuteResultSchema,
          v4InteractionBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, undefined),
        ).catch(() => undefined);
      };
      if (signal?.aborted) cancelBackendRequest();
      else signal?.addEventListener("abort", cancelBackendRequest, { once: true });
      try {
        return await requestV4WithLegacyFallback(
          context,
          V4_METHODS.interactionBrowserExecute,
          LEGACY_SKEW_FALLBACK_METHODS.interactionBrowserExecute,
          {
            ...requestContext,
            browserId,
            browserGeneration,
            command,
          },
          v4InteractionBrowserExecuteResultSchema,
          v4InteractionBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, signal),
        );
      } finally {
        signal?.removeEventListener("abort", cancelBackendRequest);
      }
    },

    async turnEnded({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "turnEnded", turnId });
    },

    async closeSession({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "closeSession" });
      connectionsBySession.delete(sessionId);
    },
  };
}

function buildBrowserRequestContext(
  context: ACodeProtocolAgentServerContext,
  input: {
    sessionId: string;
    turnId?: string;
    traceContext?: TraceContext;
  },
) {
  const record = requireSession(context, input.sessionId);
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;

  return {
    requestId: randomUUID(),
    sessionId: input.sessionId,
    ...((input.turnId ?? input.traceContext?.turnId)
      ? { turnId: String(input.turnId ?? input.traceContext?.turnId) }
      : {}),
    // workspacePath 可能在不同 remote workspace 中相同，隔离 key 必须优先使用
    // workspaceIdentity，避免 browser backend/tab ownership 跨工作区串线。
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): ACodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
