// ============================================================
// ToolSearch / DeferredToolCall - 工具按需检索契约（wave 1a）
// ============================================================
// 契约来源：apps/acode-cli/specs/tool-search.md R1/R5/R6/R9/R10。
// 本文件是两个控制工具（ToolSearch、DeferredToolCall）与请求投影共享的
// 唯一契约面：模式取值域、公告/引用/持久化 schema、模型侧 JSON schema、
// 能力探测与执行上下文类型。core 的搜索/投影/handler 与 adapters 的
// capability 解析都只从这里读常量与类型，不允许第二份登记。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { JsonSchema } from "../model/index.js";

// -----------------------------------------------
// 名称与模式（R1）
// -----------------------------------------------

export const TOOL_SEARCH_NAME = "ToolSearch";
export const DEFERRED_TOOL_CALL_NAME = "DeferredToolCall";

export const ToolSearchModeSchema = z.enum(["auto", "native", "local", "off"]);
export type ToolSearchMode = z.infer<typeof ToolSearchModeSchema>;
/** auto 在请求准备时解析为 native/local/off 之一；解析后不再出现 auto。 */
export type ResolvedToolSearchMode = Exclude<ToolSearchMode, "auto">;

export const TOOL_SEARCH_DEFAULT_RESULTS = 5;
/** 波 2 native 实装才消费的 Anthropic beta 标识；波 1 只登记不发送。 */
export const TOOL_SEARCH_BETA = "advanced-tool-use-2025-11-20";

// -----------------------------------------------
// 公告（R9）
// -----------------------------------------------

/**
 * deferred 目录名称清单的增量公告事实。readded ⊆ added 是 schema 级不变量：
 * 「重新可用」必然是「本轮新增列出」的子集，违反即数据损坏，safeParse 拒绝。
 */
export const ToolSearchAnnouncementSchema = z
  .object({
    addedNames: z.array(z.string().min(1)),
    removedNames: z.array(z.string().min(1)),
    readdedNames: z.array(z.string().min(1)),
  })
  .strict()
  .refine((delta) => delta.readdedNames.every((name) => delta.addedNames.includes(name)), {
    message: "Readded tool names must be included in addedNames",
  });
export type ToolSearchAnnouncement = z.infer<typeof ToolSearchAnnouncementSchema>;

// -----------------------------------------------
// 工具引用内容与持久化（R7/R10）
// -----------------------------------------------

/**
 * 模型可见历史里的真实引用块：历史与 state.metadata.modelContent 只保存
 * 引用（名称），schema 快照由请求投影按当前定义即时展开，不持久化。
 */
export const ToolReferenceContentSchema = z
  .object({
    type: z.literal("tool_reference"),
    toolName: z.string().min(1),
  })
  .strict();
export type ToolReferenceContent = z.infer<typeof ToolReferenceContentSchema>;

/** ToolSearch 结果的持久化形态：text 提示或 tool_reference 序列，至少一块。 */
export const PersistedToolSearchContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      ToolReferenceContentSchema,
    ]),
  )
  .min(1);
export type PersistedToolSearchContent = z.infer<typeof PersistedToolSearchContentSchema>;

// -----------------------------------------------
// ToolSearch 输入/输出（R5）
// -----------------------------------------------

export const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    ),
  max_results: z
    .number()
    .optional()
    .default(TOOL_SEARCH_DEFAULT_RESULTS)
    .describe("Maximum number of results to return (default: 5)"),
});
export type ToolSearchInput = z.infer<typeof ToolSearchInputSchema>;

export const ToolSearchOutputSchema = z.object({
  matches: z.array(z.string()),
  query: z.string(),
  total_deferred_tools: z.number(),
});
export type ToolSearchOutput = z.infer<typeof ToolSearchOutputSchema>;

export const ToolSearchInputJsonSchema: JsonSchema = {
  ...toToolJsonSchema(ToolSearchInputSchema),
  // 模型侧双 required（spec R5）：转换器会把带默认值的字段视为可选，但模型必须
  // 显式给出 max_results，避免不同 provider 对缺省字段的解释分叉；执行侧仍先补默认值。
  required: ["query", "max_results"],
};
export const ToolSearchOutputJsonSchema: JsonSchema = toToolJsonSchema(ToolSearchOutputSchema);

// -----------------------------------------------
// DeferredToolCall 输入（R6）
// -----------------------------------------------

/** 严格 { name, input }：包装只转发目标名与内层参数，不允许附加字段。 */
export const DeferredToolCallInputSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.unknown()),
  })
  .strict();
export type DeferredToolCallInput = z.infer<typeof DeferredToolCallInputSchema>;
export const DeferredToolCallInputJsonSchema: JsonSchema = toToolJsonSchema(
  DeferredToolCallInputSchema,
);

/**
 * part metadata 上的包装标记是严格字面量 "DeferredToolCall"（R6）：内部历史/
 * 持久化统一用目标工具名，标记只用于请求渲染时恢复包装形态。
 */
export const ModelCallWrapperSchema = z.literal(DEFERRED_TOOL_CALL_NAME);
export type ModelCallWrapper = z.infer<typeof ModelCallWrapperSchema>;

// -----------------------------------------------
// 能力探测与执行上下文（R2/R8）
// -----------------------------------------------

/** wire 能力事实：protocolSupported 波 1 只登记；defaultEnabled 恒 false（ACode 无 coding-plan 面）。 */
export interface ToolSearchCapability {
  readonly protocolSupported: boolean;
  readonly defaultEnabled: boolean;
}

/** 搜索候选：请求准备时从完整工具目录投影，deferred 标记已含 compact 提升结果。 */
export interface ToolSearchCandidate {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly description?: string;
  readonly searchHint?: string;
  readonly deferred: boolean;
}

/**
 * executor 侧搜索上下文（R8）：请求准备单点生成、随执行注入，是 ToolSearch
 * 准入与 DeferredToolCall 准入的共同事实源；不生成公告、不写历史。
 */
export interface ToolSearchExecutionContext {
  readonly mode: ResolvedToolSearchMode;
  readonly enabled: boolean;
  readonly catalog: readonly ToolSearchCandidate[];
  readonly discovered: ReadonlySet<string>;
}
