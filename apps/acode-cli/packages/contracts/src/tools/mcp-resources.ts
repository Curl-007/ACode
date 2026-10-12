// MCP 资源拉取工具的输出契约（specs/mcp-sampling-resources.md）。
// schema 住 contracts 而不是 core：toToolJsonSchema 的 zod 版本与 contracts 同源
// （core 的 z 是 v4，直接喂会形状错配——与 write-visualization-fragment 同一惯例）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const McpListResourcesOutputSchema = z
  .object({
    resources: z.array(
      z.object({
        uri: z.string(),
        name: z.string().optional(),
        mimeType: z.string().optional(),
        description: z.string().optional(),
      }),
    ),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const McpListResourcesOutputJsonSchema = toToolJsonSchema(McpListResourcesOutputSchema);

export const McpReadResourceOutputSchema = z
  .object({
    uri: z.string().optional(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    base64: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const McpReadResourceOutputJsonSchema = toToolJsonSchema(McpReadResourceOutputSchema);
