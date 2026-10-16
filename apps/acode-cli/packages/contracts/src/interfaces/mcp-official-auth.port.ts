// MCP 官方鉴权注入与信任判定端口（mcp.port.ts 拆分产物，2026-10-15）。

import type { OfficialMcpAuthPortFailureReason } from "@acode/shared";

/**
 * 端口层失败分类（"不发任何请求"的几类）。
 * `official_mcp_origin_untrusted` 可能来自 adapter 本地校验，也可能来自 host 侧二次校验。
 */
export type OfficialMcpAuthFailureReason = OfficialMcpAuthPortFailureReason;

export type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * MCP adapter 消费身份头的依赖注入端口。
 * adapter 不直接依赖 `packages/services`；Agent 进程经该端口向 host 索取本次请求的身份头。
 *
 * 失败必须走返回值而非抛异常，调用方禁止从错误文本解析原因。
 * `workspaceIdentity` / `workspacePath` / `pluginId` / `mcpKey` / `targetOrigin`
 * 仅用于路由、二次校验与审计，**不参与凭证选择**——凭证是 host 全局状态。
 */
export interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}

/**
 * 官方 MCP 信任判定。
 *
 * 规则只有一条：**目标 origin 逐字符等于当前 ACode API origin（https、无 username/password）**，
 * 另有仅放开 http loopback 的本地自测开关。`pluginId` / `mcpKey` 传进来只用于日志与凭证解析
 * 归属，**不影响判定结果**——曾经的"必须是官方 marketplace 插件"那道检查已于 2026-08 移除
 * （它让官方插件在发布前无法对真实端点自测，而第三方插件本可用 hook 读到同一份凭证，
 * 并非真实屏障）。
 *
 * 实现在 `@acode/shared`：host 与 adapter 共用同一份，避免一侧放行一侧拒绝。
 * 异步是为了让 host 侧能按 settings 覆盖解析 origin。
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
    detail?: string;
    trusted: boolean;
  }>;
}
