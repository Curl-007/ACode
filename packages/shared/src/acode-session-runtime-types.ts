// session runtime 状态 wire 类型（apiRetry/contextUsage/runtimeState）。M4 从 acode-protocol-legacy-types.ts 中立迁移。

import { z } from "zod";
import { acodeDeliveryKindSchema, acodeSessionGoalVerificationSchema, acodeSessionGoalVerificationTimelineSchema } from "./acode-session-types.js";

const nonEmptyString = z.string().trim().min(1);

export const acodeSessionContextCacheUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    latestHitRate: z.number().nonnegative().nullable().optional(),
    hitRateRequestCount: z.number().int().nonnegative().optional(),
    totalInputTokens: z.number().int().nonnegative().optional(),
    totalCacheReadTokens: z.number().int().nonnegative().optional(),
    totalCacheWriteTokens: z.number().int().nonnegative().optional(),
    hitRate: z.number().nonnegative().nullable(),
    // prompt-cache miss 归因计数快照（apps/acode-cli/specs/prompt-cache-diagnostics.md R4）。
    // 开放 record 不复刻 CLI 因集枚举——CLI 未来加因不需要再动本镜像（版本偏斜安全）；
    // 必须与 CLI 生产侧同一提交加宽，否则 v4 客户端 strict 校验整帧拒收。
    missCauses: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();

export const acodeContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);

export const acodeContextUsageBreakdownItemSchema = z
  .object({
    source: acodeContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();

export const acodeContextUsageBreakdownSchema = z.array(acodeContextUsageBreakdownItemSchema);

export const acodeSessionContextUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: nonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    cache: acodeSessionContextCacheUsageSchema.optional(),
    breakdown: acodeContextUsageBreakdownSchema.optional(),
  })
  .strict();

export type ACodeSessionContextUsage = z.infer<typeof acodeSessionContextUsageSchema>;

export const acodeSessionApiRetryStatusSchema = z
  .object({
    kind: z.literal("api_retry"),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();

export const acodeSessionAutoResumeStatusSchema = z
  .object({
    kind: z.literal("auto_resume"),
    attempt: z.number().int().positive(),
    maxResumes: z.number().int().nonnegative(),
    resumeDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();

export const acodeSessionApiRetrySlotSchema = z.union([
  acodeSessionApiRetryStatusSchema,
  acodeSessionAutoResumeStatusSchema,
]);

export type ACodeSessionApiRetrySlotValue = z.infer<typeof acodeSessionApiRetrySlotSchema>;

export type ACodeContextUsageBreakdownItem = z.infer<typeof acodeContextUsageBreakdownItemSchema>;

export const acodeSessionRuntimeStateSchema = z
  .object({
    eventSeq: z.number().int().nonnegative(),
    stateRevision: z.number().int().nonnegative(),
    deliveryKind: acodeDeliveryKindSchema.optional(),
    activeTurnId: nonEmptyString.optional(),
    activeTurnKind: z.enum(["regular", "compact", "rewind"]).optional(),
    pendingRequestIds: z.array(nonEmptyString),
    apiRetry: acodeSessionApiRetrySlotSchema.nullable().optional(),
    contextUsage: acodeSessionContextUsageSchema.optional(),
    goalVerifications: z.array(acodeSessionGoalVerificationSchema).optional(),
    goalVerificationTimeline: z.array(acodeSessionGoalVerificationTimelineSchema).optional(),
  })
  .strict();

export type ACodeSessionRuntimeState = z.infer<typeof acodeSessionRuntimeStateSchema>;

export type ACodeSessionActiveTurnKind = NonNullable<ACodeSessionRuntimeState["activeTurnKind"]>;
