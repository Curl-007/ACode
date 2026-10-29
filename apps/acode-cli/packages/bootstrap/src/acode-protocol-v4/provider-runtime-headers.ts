import { randomUUID } from "node:crypto";
import { type ACodeWorkspaceRef , LEGACY_SKEW_FALLBACK_METHODS, LEGACY_NOTIFICATIONS} from "@acode/shared";
import { v4ProviderRuntimeHeadersResponseSchema, V4_METHODS, V4_NOTIFICATIONS } from "@acode/shared/acode-protocol-v4";
// v4 面符号只挂在子路径（根桶不 re-export v4，M2-3 既有纪律）。

import type { ACodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ACodeProtocolAgentServerContext,
} from "./server-types.js";

// 无应答方时 UI 的 SDK 超时不会启动；端口总时限同时覆盖排队与凭据解析。
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;

export function createProviderRuntimeHeadersPort(
  context: ACodeProtocolAgentServerContext,
  workspace: ACodeWorkspaceRef,
): NonNullable<ACodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
      // Account 请求由绑定 Model 决定是否进入鉴权，不能把所有账号收窄到旧 Start ID。
      // 普通 API 不进入此端口；Team/Individual 继续复用请求级鉴权合同。
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      // M2-4 dual-form（§2.3）：v4 先行，-32601 回落 legacy（automation-port 先例）。
      // 取消通知的形态绑定其触发请求的形态（闭包内追踪），不用连接级 flag——
      // host 按请求形态登记了哪条分支的队列，取消就必须打到同一条分支。
      let requestForm: "v4" | "legacy" = "v4";
      const params = {
        // 同一毫秒内的并发请求不能共用关联键，否则 pending 应答会覆盖或串用。
        requestId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspace,
        modelSelection: { providerId: input.providerId, modelId: input.modelId },
        providerId: input.providerId,
        ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
        reason: input.reason,
      };
      const requestOptions = {
        signal: input.abortSignal,
        trace: protocolTraceFromTraceContext(input.traceContext),
        timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
      };
      let result;
      try {
        try {
          result = await context.requestClient(
            V4_METHODS.interactionRequestProviderRuntimeHeaders,
            params,
            v4ProviderRuntimeHeadersResponseSchema,
            requestOptions,
          );
        } catch (error) {
          // 只有 -32601 能证明该 host 缺 v4 inbound 分支（能力偏斜）；
          // 超时/断连/响应非法等直接抛出，不误判为偏斜（见 §2.1）。
          if (!(error instanceof ProtocolRequestError && error.code === -32601)) {
            throw error;
          }
          // 偏斜期 legacy 保留路径（M3 删除）：wire 形态逐字同形，只换方法名。
          requestForm = "legacy";
          result = await context.requestClient(
            LEGACY_SKEW_FALLBACK_METHODS.interactionRequestProviderRuntimeHeaders,
            params,
            v4ProviderRuntimeHeadersResponseSchema,
            requestOptions,
          );
        }
      } catch (error) {
        // requestClient abort 只清理 CLI 等待，Host 仍占着凭据解析队列直到超时。
        // 仅此端口发送取消，不改变其他反向 RPC 的生命周期。
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
        // 总时限与主动停止都必须释放 Host；否则 CLI 已失败，旧请求仍会占用队列。
        // 取消通知按触发请求的形态发出（requestForm 闭包绑定）。
        if (input.abortSignal?.aborted || timedOut) {
          const cancelParams = { workspace, sessionId: input.sessionId, requestId };
          context.notify({
            method:
              requestForm === "v4"
                ? V4_NOTIFICATIONS.interactionProviderRuntimeHeadersCancelled
                : LEGACY_NOTIFICATIONS.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: cancelParams,
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            "Provider runtime headers request timed out. Please send your message again.",
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
        // runtime header 刷新失败可能来自配置读取失败或凭据缺失；
        // 不能统一改写成单一失败文案，否则会掩盖真实根因并误导重试策略。
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
      // zcode-plan 的账号鉴权材料是每次请求刷新的运行时配置，
      // 但 provider registry revision 是 workspace 级全局状态；并发刷新时后一个请求会推进全局 revision，
      // 不能再用全局 revision 不相等误判当前请求的 headers 未应用。
      return result;
    },
  };
}
