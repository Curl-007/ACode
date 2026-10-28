import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-protocol-legacy-types.js";
import { modelSelectionSchema } from "../model-selection.js";

// workspace 运行时面的 v4 域零件（M2-8，specs/m2-8-workspace-provider-process.md）：
// readPresentation（展示面只读）+ generateText / cancelGenerateText（workspace 级一次性
// LLM 执行面，operationId 键控取消）。workspace 级、无会话；不投影、不订阅。
//
// 形状纪律：与 legacy barrel 的 workspace/readPresentation、workspace/generateText、
// workspace/cancelGenerateText 段**逐字 parity**（同字段、同 strict、同值域），消费者语义
// 零变化；不反向 import legacy barrel（protocol-boundary 纪律），两侧形状由
// packages/shared/tests/protocol-boundary.test.mjs 钉住。
//
// acodeSessionModeSchema / acodeSlashCommandSchema 不在 v4-imports-legacy-protocol 白名单
// （前者居 legacy-types 但未登记，后者居 barrel），按「结构化再声明」纪律本地逐字定义
// （plugins-queries.ts 的 deliveryKind 先例），值域 parity 由协议测试逐字钉住。

const nonEmptyString = z.string().trim().min(1);

// 与 acode-protocol-legacy-types.ts 的 acodeSessionModeSchema 逐字同值（白名单未登记，
// 本地再声明）。
export const v4WorkspaceSessionModeSchema = z.enum([
  "plan",
  "build",
  "edit",
  "yolo",
  "auto",
  "dontAsk",
]);
export type V4WorkspaceSessionMode = z.infer<typeof v4WorkspaceSessionModeSchema>;

// 与 legacy barrel 的 acodeSlashCommandSchema 逐字同值（barrel 全禁，本地再声明）。
export const v4WorkspaceSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();
export type V4WorkspaceSlashCommand = z.infer<typeof v4WorkspaceSlashCommandSchema>;

// ── v4/workspace/readPresentation ──
export const v4WorkspaceReadPresentationParamsSchema = z
  .object({ workspace: acodeWorkspaceRefSchema })
  .strict();
export type V4WorkspaceReadPresentationParams = z.infer<
  typeof v4WorkspaceReadPresentationParamsSchema
>;
export const v4WorkspacePresentationSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    mode: v4WorkspaceSessionModeSchema,
    slashCommands: z.array(v4WorkspaceSlashCommandSchema),
  })
  .strict();
export type V4WorkspacePresentation = z.infer<typeof v4WorkspacePresentationSchema>;

// ── v4/workspace/generateText ──
export const v4WorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();
export type V4WorkspaceModelToolCall = z.infer<typeof v4WorkspaceModelToolCallSchema>;
export const v4WorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(v4WorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);
export type V4WorkspaceModelMessage = z.infer<typeof v4WorkspaceModelMessageSchema>;
export const v4WorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type V4WorkspaceModelTool = z.infer<typeof v4WorkspaceModelToolSchema>;

export const v4WorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(v4WorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(v4WorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "prompt 或 messages 至少需要提供一个",
  });
export type V4WorkspaceGenerateTextParams = z.infer<typeof v4WorkspaceGenerateTextParamsSchema>;
export const v4WorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(v4WorkspaceModelToolCallSchema).optional(),
    // 可选以兼容仍在运行的旧 app-server；新 CLI 始终返回结构化结束原因。
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type V4WorkspaceGenerateTextResult = z.infer<typeof v4WorkspaceGenerateTextResultSchema>;

// ── v4/workspace/cancelGenerateText ──
// 取消注册表按 operationId 键控（server.ts 的 workspaceGenerateTextControllers）。
export const v4WorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();
export type V4WorkspaceCancelGenerateTextParams = z.infer<
  typeof v4WorkspaceCancelGenerateTextParamsSchema
>;
export const v4WorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();
export type V4WorkspaceCancelGenerateTextResult = z.infer<
  typeof v4WorkspaceCancelGenerateTextResultSchema
>;
