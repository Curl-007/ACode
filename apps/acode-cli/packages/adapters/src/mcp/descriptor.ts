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

/**
 * 单个工具的原始注册身份：`(serverName, toolName)` 未经过 sanitizer 的原值。
 * sanitizer 是有损的（`a.b`/`a-b`、`c-d`/`c.d` 折叠到同一形态），模型面名撞名时
 * 只有原始身份能区分两个来源。
 */
export interface McpToolNameCollision {
  name: string;
  kept: { serverName: string; toolName: string };
  dropped: { serverName: string; toolName: string };
}

/**
 * 模型面名撞名时的确定性赢家（specs/mcp-startup-gate-breaker.md R4）。
 *
 * 为什么需要：`normalizeMcpToolDescriptor` 的 sanitizer 是有损映射，两个不同来源
 * （例如 server `a.b` + tool `c-d` 与 server `a-b` + tool `c.d`）会 mint 出同一个
 * 模型面名。注册面如果按数组顺序先到先得，重连后 append 顺序可能翻转，工具归属
 * 随之漂移——模型拿到的同一工具名背后换了一个 server。赢家规则 = 原始身份键
 * `serverName\0toolName` 字典序较小者，与数组顺序、重连先后无关。
 *
 * 同源重复（同一 server/tool 出现两次，例如 server 端清单重复项）静默去重，不算
 * 碰撞。**必须**在长度上限剔除之后、写入注册投影之前调用（与
 * `exceedsMcpToolNameLimit` 组成注册边界的完整检查序列）。
 */
export function deduplicateMcpToolDescriptors(
  tools: readonly McpToolDescriptor[],
): { tools: McpToolDescriptor[]; collisions: McpToolNameCollision[] } {
  const deduplicated: McpToolDescriptor[] = [];
  const collisions: McpToolNameCollision[] = [];
  const registered = new Map<
    string,
    { tool: McpToolDescriptor; originKey: string; index: number }
  >();

  for (const tool of tools) {
    const originKey = `${tool.serverName}\u0000${tool.toolName}`;
    const existing = registered.get(tool.name ?? tool.toolName);
    if (!existing) {
      registered.set(tool.name ?? tool.toolName, { tool, originKey, index: deduplicated.length });
      deduplicated.push(tool);
      continue;
    }

    if (existing.originKey === originKey) continue;

    // 确定性赢家与遭遇顺序无关：重连/后台替换不得翻转归属。
    const keepExisting = existing.originKey < originKey;
    const winner = keepExisting ? existing.tool : tool;
    const loser = keepExisting ? tool : existing.tool;
    if (!keepExisting) {
      deduplicated[existing.index] = tool;
      existing.tool = tool;
      existing.originKey = originKey;
    }
    collisions.push({
      name: tool.name ?? tool.toolName,
      kept: { serverName: winner.serverName, toolName: winner.toolName },
      dropped: { serverName: loser.serverName, toolName: loser.toolName },
    });
  }

  return { tools: deduplicated, collisions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
