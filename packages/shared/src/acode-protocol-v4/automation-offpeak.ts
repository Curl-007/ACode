// M2-7 automation/offPeak 七法（inbound RPC）的 v4 wire schema
//（spec apps/acode-cli/specs/m2-7-automation-offpeak.md）。
//
// 迁移依据：这七个方法是 agent/CLI → host 方向的纯请求/响应真 RPC（无 announce+ack、
// 无通知面），与 M2-4 browser 四法同型。wire 形态与 legacy acode-protocol barrel 逐字一致——
// 本批只换方法名（transport.ts V4_METHODS 登记），不换载荷，偏斜期（新 CLI+旧 host /
// 旧 CLI+新 host）两形态共存时语义逐点等价。
//
// 边界纪律：本文件不得 import legacy barrel（acode-protocol 目录的 index 聚合件）。
// - 中立面（modelSelection / acodeTaskMode / botDeliveryTarget）直导中立叶；
// - 其余形态在本叶逐字重声明（legacy 私有件 nonEmptyString/timestampMsSchema 同形重声明于下）。
import { z } from "zod";
import { acodeTaskModeSchema } from "../acode-task-mode-schema.js";
import { acodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { modelSelectionSchema } from "../model-selection.js";

const nonEmptyString = z.string().trim().min(1);
const timestampMsSchema = z.number().int().nonnegative();

export const v4AutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type V4AutomationScheduleRule = z.infer<typeof v4AutomationScheduleRuleSchema>;

/** 会话侧长间隔周期 carrier 的 unit 枚举（与 scheduleRule.unit 同集）。 */
export const v4AutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);
export type V4AutomationIntervalUnit = z.infer<typeof v4AutomationIntervalUnitSchema>;

export const v4AutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: acodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: v4AutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type V4AutomationProtocol = z.infer<typeof v4AutomationProtocolSchema>;

export const v4AutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: acodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    botDeliveryTarget: acodeAutomationBotDeliveryTargetSchema.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // 会话侧自定义重复 carrier：每 N 分钟/小时/天/周/月/年均通过此字段归一化为权威 scheduleRule，
    // cronExpr 仅作合法兼容展示。
    intervalUnit: v4AutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit 与 interval 必须配对提交（只传一个无法确定真实间隔）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // 周期 carrier 与一次性相对延迟语义冲突，禁止同传。
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type V4AutomationCreateParams = z.infer<typeof v4AutomationCreateParamsSchema>;

export const v4AutomationCreateResultSchema = z
  .object({ automation: v4AutomationProtocolSchema })
  .strict();
export type V4AutomationCreateResult = z.infer<typeof v4AutomationCreateResultSchema>;

export const v4AutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // 会话侧自定义重复 carrier（同 create 侧语义）。
    intervalUnit: v4AutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对提交（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type V4AutomationUpdateParams = z.infer<typeof v4AutomationUpdateParamsSchema>;

export const v4AutomationUpdateResultSchema = z
  .object({ automation: v4AutomationProtocolSchema })
  .strict();
export type V4AutomationUpdateResult = z.infer<typeof v4AutomationUpdateResultSchema>;

export const v4AutomationListParamsSchema = z.object({}).strict();
export type V4AutomationListParams = z.infer<typeof v4AutomationListParamsSchema>;
export const v4AutomationListResultSchema = z
  .object({ automations: z.array(v4AutomationProtocolSchema) })
  .strict();
export type V4AutomationListResult = z.infer<typeof v4AutomationListResultSchema>;

export const v4AutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();
export type V4AutomationCheckTaskBindingParams = z.infer<
  typeof v4AutomationCheckTaskBindingParamsSchema
>;
export const v4AutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();
export type V4AutomationCheckTaskBindingResult = z.infer<
  typeof v4AutomationCheckTaskBindingResultSchema
>;

export const v4AutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();
export type V4AutomationDeleteParams = z.infer<typeof v4AutomationDeleteParamsSchema>;
export const v4AutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type V4AutomationDeleteResult = z.infer<typeof v4AutomationDeleteResultSchema>;

// ---- Off-Peak（闲时任务）会话内创建协议 ----
// 与 automation 兄弟并列（独立域，禁止互相复用标记/表）。workspace 由 host 端从
// 当前 session 注入，不进协议参数（对称 automation/create）。permissionMode 只开放产品
// 五档词表（含 P1 dontAsk：闲时无人值守场景「拒绝代替询问」是显式产品档位）；
// 缺省解析在 host 端（yolo / allowed_models 末位 / 最高推理档）。
export const v4OffPeakPermissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "dontAsk"]);
export type V4OffPeakPermissionMode = z.infer<typeof v4OffPeakPermissionModeSchema>;

export const v4OffPeakCreateParamsSchema = z
  .object({
    title: nonEmptyString,
    prompt: nonEmptyString,
    permissionMode: v4OffPeakPermissionModeSchema.optional(),
    model: nonEmptyString.optional(),
    thoughtLevel: nonEmptyString.optional(),
    // 会话内创建绑定当前会话（对齐 automation/create 的 targetTaskId），由 CLI 端口填入。
    boundSessionId: nonEmptyString.optional(),
  })
  .strict();
export type V4OffPeakCreateParams = z.infer<typeof v4OffPeakCreateParamsSchema>;

// 协议侧任务快照：轮尾卡片与 OffPeakList 的最小字段面。
// 不暴露 serverTicketId（跨边界禁带）。
export const v4OffPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["queued", "paused", "running", "completed", "failed", "cancelled"]),
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type V4OffPeakTaskSnapshot = z.infer<typeof v4OffPeakTaskSnapshotSchema>;

// 失败分类跨协议保真（镜像 shared OffPeakTaskCreateResult 的判别联合，错误不降级为字符串）。
// model 白名单预校失败复用 client_validation 分类 + errorCode "model_not_allowed"，不扩分类枚举。
export const v4OffPeakCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: v4OffPeakTaskSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      failureStage: z.enum(["client_validation", "ticket_request", "local_persist"]),
      errorCategory: z.enum([
        "client_validation",
        "eligibility_3101",
        "quota_3103",
        "network",
        "invalid_response",
        "local_persist",
        "unknown",
      ]),
      errorCode: z.string(),
    })
    .strict(),
]);
export type V4OffPeakCreateResult = z.infer<typeof v4OffPeakCreateResultSchema>;

export const v4OffPeakListParamsSchema = z.object({}).strict();
export type V4OffPeakListParams = z.infer<typeof v4OffPeakListParamsSchema>;
export const v4OffPeakListResultSchema = z
  .object({ tasks: z.array(v4OffPeakTaskSnapshotSchema) })
  .strict();
export type V4OffPeakListResult = z.infer<typeof v4OffPeakListResultSchema>;
