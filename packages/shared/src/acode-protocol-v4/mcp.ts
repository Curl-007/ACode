import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-protocol-legacy-types.js";
import {
  acodeMcpReconnectSuspensionSchema,
  acodeProtocolMcpServerSchema,
} from "../acode-protocol-shared.js";

// MCP server 状态列表的 v4 面（apps/acode-cli/specs/m2-6-workflows-skills-mcp.md）。
//
// 形状与 legacy `acodeMcpList*` 逐字 parity；server/重连悬挂零件取自中性叶
// acode-protocol-shared.js（command.ts 同先例），status kind / failure kind 在本地结构化
// 再声明（不反向 import legacy barrel），parity 由 protocol-boundary 测试钉住。
//
// mode 语义（迁移不变量）：`status` 只读运行态（OAuth 轮询隔离，不触发 replace 收敛）；
// `connect`（缺省）执行 replace 收敛并 revalidate 连接池条目。

const nonEmptyString = z.string().trim().min(1);

export const v4McpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);
export type V4McpServerStatusKind = z.infer<typeof v4McpServerStatusKindSchema>;

// 值域与 legacy MCP_SERVER_FAILURE_KINDS 逐字一致（测试逐字钉住）。
export const V4_MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  "official_origin_untrusted",
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;
export const v4McpServerFailureKindSchema = z.enum(V4_MCP_SERVER_FAILURE_KINDS);
export type V4McpServerFailureKind = z.infer<typeof v4McpServerFailureKindSchema>;

export const v4McpServerStatusSnapshotSchema = z
  .object({
    status: v4McpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: v4McpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    reconnectSuspension: acodeMcpReconnectSuspensionSchema.optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();
export type V4McpServerStatusSnapshot = z.infer<typeof v4McpServerStatusSnapshotSchema>;

export const v4McpListModeSchema = z.enum(["connect", "status"]);
export type V4McpListMode = z.infer<typeof v4McpListModeSchema>;

export const v4McpListParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    mcpServers: z.array(acodeProtocolMcpServerSchema).optional(),
    mode: v4McpListModeSchema.default("connect"),
  })
  .strict();
export type V4McpListParams = z.infer<typeof v4McpListParamsSchema>;

export const v4McpListResultSchema = z
  .object({
    statuses: z.record(z.string(), v4McpServerStatusSnapshotSchema),
  })
  .strict();
export type V4McpListResult = z.infer<typeof v4McpListResultSchema>;
