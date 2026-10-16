// MCP resources 拉取面（mcp.port.ts 拆分产物，2026-10-15；specs/mcp-sampling-resources.md）。

/** 一个 MCP 资源的清单条目（resources/list 的投影；specs/mcp-sampling-resources.md）。 */
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

/** resources/read 的结果：文本与 base64 二选一（二进制资源走 base64）。 */
export interface McpReadResourceResult {
  uri: string;
  mimeType?: string;
  text?: string;
  base64?: string;
}
