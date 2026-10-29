/* Agent 侧的官方 MCP 身份头端口。
   Agent 进程不是身份权威：经 interaction/requestOfficialMcpAuthHeaders 反向请求 host，
   由 host 解析当前 Coding Plan 凭证后回传本次请求的身份头。凭证不落 runtime config、
   不持久化、不进日志。 */
import { type ACodeWorkspaceRef , LEGACY_SKEW_FALLBACK_METHODS} from "@acode/shared";
import { v4OfficialMcpAuthHeadersResponseSchema, V4_METHODS } from "@acode/shared/acode-protocol-v4";
// v4 面符号只挂在子路径（根桶不 re-export v4，M2-3 既有纪律）。

import type { OfficialMcpAuthHeadersPort } from "@acode/contracts";
import { ProtocolRequestError, type ACodeProtocolAgentServerContext } from "./server-types.js";

let requestSequence = 0;

/** 端口只需要发反向请求的能力，不需要整个 server context。 */
export type OfficialMcpAuthRequestContext = Pick<
  ACodeProtocolAgentServerContext,
  "requestClient"
>;

/**
 * 构造经协议反向请求取身份头的端口。
 *
 * `resolveContext` 是惰性的：MCP 连接池的构造早于 ACodeProtocolAgentServer，
 * server 就绪前返回 undefined，此时按不可用处理（不降级为匿名请求）。
 *
 * 失败一律走返回值（ok:false + 可枚举 reason），不抛异常：
 * 传输层异常统一归为 official_auth_unavailable，由 MCP adapter 置该 server 为 failed。
 *
 * workspace 的用途与已知缺口：
 * - host 侧**不**用它路由响应——响应经 `client.respond(request.id, ...)` 回到发起请求的
 *   那条 stdio 连接，路由由连接本身决定。该字段仅作请求上下文/审计用；
 * - 但仍必须遵守仓库约定 `workspaceKey = workspaceIdentity?.trim() || workspacePath`，
 *   否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分；
 * - **剩余缺口**：CLI agent 进程当前没有 workspaceIdentity 来源
 *   （`RunACodeProtocolAgentOptions` 只有 cwd/env/…，也无对应环境变量），因此该字段实际
 *   退化为 workspacePath。这里保证的是"拿到 identity 就正确透传"，而不是"identity 一定存在"。
 *   若将来审计需要真实远端身份，需在 spawn 或协议层把 identity 传给 agent，不在本阶段范围。
 */
export function createOfficialMcpAuthHeadersPort(input: {
  resolveContext: () => OfficialMcpAuthRequestContext | undefined;
  resolveWorkspace: (input: {
    workspaceIdentity?: string;
    workspacePath?: string;
  }) => ACodeWorkspaceRef | undefined;
}): OfficialMcpAuthHeadersPort {
  return {
    async resolveHeaders(request) {
      const context = input.resolveContext();
      const workspace = input.resolveWorkspace({
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
      });
      if (!context || !workspace) {
        return { ok: false, reason: "official_auth_unavailable" };
      }
      requestSequence += 1;
      const params = {
        mcpKey: request.mcpKey,
        pluginId: request.pluginId,
        requestId: `official-mcp-auth:${requestSequence}`,
        targetOrigin: request.targetOrigin,
        workspace,
      };
      const requestOptions = request.signal ? { signal: request.signal } : {};
      try {
        try {
          // M2-4 dual-form（§2.3）：v4 先行，-32601 回落 legacy；wire 形态逐字同形。
          return await context.requestClient(
            V4_METHODS.interactionRequestOfficialMcpAuthHeaders,
            params,
            v4OfficialMcpAuthHeadersResponseSchema,
            requestOptions,
          );
        } catch (error) {
          // 只有 -32601 能证明该 host 缺 v4 inbound 分支（能力偏斜）；其余错误交给外层
          // catch-all 归为 official_auth_unavailable（本端口既有契约：失败走返回值不抛异常）。
          if (!(error instanceof ProtocolRequestError && error.code === -32601)) {
            throw error;
          }
          // 偏斜期 legacy 保留路径（M3 删除）。
          return await context.requestClient(
            LEGACY_SKEW_FALLBACK_METHODS.interactionRequestOfficialMcpAuthHeaders,
            params,
            v4OfficialMcpAuthHeadersResponseSchema,
            requestOptions,
          );
        }
      } catch {
        // host 不可达/协议错误：按不可用处理。错误详情不带出（可能含请求上下文），
        // host 侧已记录不含秘密的分类日志。
        return { ok: false, reason: "official_auth_unavailable" };
      }
    },
  };
}
