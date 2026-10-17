import type {
  JsonSchema,
  McpToolAnnotations,
  McpToolDescriptor,
} from "@acode/contracts";

export function normalizeMcpToolDescriptor(
  serverName: string,
  tool: unknown,
  timeoutMs?: number,
  official?: boolean,
): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  return {
    serverName,
    toolName,
    name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
    description: typeof record.description === "string" ? record.description : undefined,
    timeoutMs,
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: isRecord(record.outputSchema) ? (record.outputSchema as JsonSchema) : undefined,
    annotations: normalizeAnnotations(record.annotations),
    // 只有 http 官方 MCP 的 tool error 标识才被信任——那种形态的响应来自已校验 origin 的
    // ACode 后端，插件伪造不了（判据与代价见 mcp.port.ts 的 official 字段说明）。
    ...(official ? { official: true } : {}),
  };
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  };
}

function normalizeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  return {
    readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
    destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
    idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
    openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
  };
}

function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/**
 * 模型面工具名长度上限（specs/mcp-protocol-negotiation-increments.md R3）。
 * 128 = MCP SDK 对 server 侧工具名的校验上限（`/^[A-Za-z0-9._-]{1,128}$/`）与
 * provider API 工具名限制的同级量级；ACode 的模型面名字带 `mcp__server__tool`
 * 前缀，更容易越界，因此在注册边界按**完整模型面名**判定。
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 128;

/** 完整模型面名（含 mcp__ 前缀）是否超过 128 字符上限。 */
export function exceedsMcpToolNameLimit(descriptor: McpToolDescriptor): boolean {
  const modelName = descriptor.name ?? descriptor.toolName;
  return modelName.length > MCP_TOOL_NAME_MAX_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
