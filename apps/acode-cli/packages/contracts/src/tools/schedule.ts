// ============================================================
// Schedule tool contract - K6 Ambient 预算感知调度（specs/ambient-budget-scheduler.md R2）
// ============================================================
// 机制参照 jcode (MIT) crates/jcode-ambient-types（ScheduledItem/ScheduleTarget 三态），
// 自撰 TypeScript 契约。与 cron 域 / 闲时排队域的 schema 互相独立镜像，
// 禁止复用（spec 红线：三域语义正交，不合并存储、不合并调度器）。
//
// 与 cron 定时工具的分工（R2 语义重叠处的提示词引导）：
// - 周期性 / 用户手填 cron 表达式 → cron 域工具；
// - 一次性、由 agent 在对话中受托创建（"8 分钟后提醒我"、"今晚再检查一次构建"）→ Schedule。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const SCHEDULE_TOOL_NAME = "Schedule";

/** target 三态（R2）：ambient=后台 agent cycle；session=投回当前会话的提醒；spawn=fork 新任务。 */
export const ScheduleTargetSchema = z.enum(["ambient", "session", "spawn"]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

export const SchedulePrioritySchema = z.enum(["low", "normal", "high"]);
export type SchedulePriority = z.infer<typeof SchedulePrioritySchema>;

/** 队列项的模型可见投影（Schedule list 的返回元素；claim 等执行面字段不暴露给模型）。 */
export const ScheduledItemSummarySchema = z
  .object({
    scheduleId: nonEmptyString,
    wakeAtMs: z.number().int().nonnegative(),
    priority: SchedulePrioritySchema,
    target: ScheduleTargetSchema,
    taskDescription: nonEmptyString,
    context: z.string().optional(),
    relevantFiles: z.array(nonEmptyString).optional(),
  })
  .strict();
export type ScheduledItemSummary = z.infer<typeof ScheduledItemSummarySchema>;

export const ScheduleInputSchema = z
  .object({
    action: z
      .enum(["create", "list", "cancel"])
      .describe("create schedules a new wake-up, list shows pending schedules, cancel removes one by scheduleId."),
    wakeInMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .optional()
      .describe(
        "Relative delay from now in whole minutes (1-1440). For any 'in N minutes/hours' phrasing, always set this and omit wakeAt; the host anchors to its real current clock, so never compute an absolute time yourself.",
      ),
    wakeAt: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Absolute wake time as an ISO 8601 string. Use only when the user names an outright wall-clock time ('tomorrow 9am', '21:30'); for relative delays use wakeInMinutes instead.",
      ),
    priority: SchedulePrioritySchema.optional().describe("Urgency when several items become due at once; default normal."),
    target: ScheduleTargetSchema.optional().describe(
      "ambient (default) runs a budget-aware background agent cycle; session posts a visible reminder back into the current conversation at wake time (no agent); spawn forks a new background task to do the work.",
    ),
    taskDescription: nonEmptyString.optional().describe(
      "What to do at wake time. Required for action=create; write it as a self-contained instruction (reminder text for target=session, work order otherwise).",
    ),
    context: z.string().optional().describe("Optional background the wake-up may rely on (established decisions, links, prior findings)."),
    relevantFiles: z
      .array(nonEmptyString)
      .optional()
      .describe("Optional workspace-relative file paths the wake-up should look at first."),
    scheduleId: nonEmptyString.optional().describe("Required for action=cancel; the id returned by create."),
    all: z
      .boolean()
      .optional()
      .describe(
        "For action=list only: set true to list schedules from every session in this workspace instead of just this conversation's own. Default false.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    // taskDescription 只对 create 有信息量，但 spec R2 把它定为主键级必填字段——
    // 在 superRefine 收口而不是放开 schema，让 create 缺描述在解析层即失败。
    if (value.action === "create") {
      if (!value.taskDescription) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskDescription"],
          message: "taskDescription is required for action=create",
        });
      }
      if (value.wakeInMinutes === undefined && value.wakeAt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wakeInMinutes"],
          message: "exactly one of wakeInMinutes or wakeAt is required for action=create",
        });
      }
      if (value.wakeInMinutes !== undefined && value.wakeAt !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wakeAt"],
          message: "wakeInMinutes and wakeAt are mutually exclusive",
        });
      }
    }
    if (value.action === "cancel" && !value.scheduleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleId"],
        message: "scheduleId is required for action=cancel",
      });
    }
  });
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export const ScheduleInputJsonSchema = toToolJsonSchema(ScheduleInputSchema);

export const ScheduleCreateOutputSchema = z
  .object({
    scheduleId: nonEmptyString,
    item: ScheduledItemSummarySchema,
    message: nonEmptyString,
  })
  .strict();
export type ScheduleCreateOutput = z.infer<typeof ScheduleCreateOutputSchema>;
export const ScheduleCreateOutputJsonSchema = toToolJsonSchema(ScheduleCreateOutputSchema);

export const ScheduleListOutputSchema = z
  .object({
    items: z.array(ScheduledItemSummarySchema),
    message: nonEmptyString,
  })
  .strict();
export type ScheduleListOutput = z.infer<typeof ScheduleListOutputSchema>;
export const ScheduleListOutputJsonSchema = toToolJsonSchema(ScheduleListOutputSchema);

export const ScheduleCancelOutputSchema = z
  .object({
    cancelled: z.boolean(),
    message: nonEmptyString,
  })
  .strict();
export type ScheduleCancelOutput = z.infer<typeof ScheduleCancelOutputSchema>;
export const ScheduleCancelOutputJsonSchema = toToolJsonSchema(ScheduleCancelOutputSchema);

/** 工具统一输出（按 action 分支投影；executor 的 runtimeOutputSchema 用同一份校验）。 */
export const ScheduleOutputSchema = z.union([
  ScheduleCreateOutputSchema,
  ScheduleListOutputSchema,
  ScheduleCancelOutputSchema,
]);
export type ScheduleOutput = z.infer<typeof ScheduleOutputSchema>;
export const ScheduleOutputJsonSchema = toToolJsonSchema(ScheduleOutputSchema);
