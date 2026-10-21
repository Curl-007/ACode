import { z } from "zod";
import { submissionModeSchema } from "./acode-protocol-v4/submission.js";

const nonEmptyString = z.string().trim().min(1);

/** 固定模型只保存身份；档位是独立的默认值，不在这里冗余快照。 */
export const newTaskDefaultModelSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
  })
  .strict();

/**
 * 新建任务默认值。
 *
 * 每项为 `null` 表示「跟随默认」，含义按项不同（见 docs/specs/new-task-defaults.md 第 2 条）：
 * 权限模式与模型沿用最近一次已接纳提交，推理强度用目标模型声明档位的第一项（或
 * `defaultReasoningLevelPick` 指定的取法）。因此这里不把 `null` 命名为
 * "follow last used"：推理强度本来就不继承上一任务。
 *
 * 目标仓当前没有模型速度运行时（`ModelSelection.options` 只有 `reasoningLevel`），
 * `speed` 仅作为 additive 持久化字段保留：旧/新版本设置文件互读不报错，运行时由纯函数
 * 忽略写入，待独立 speed spec 落地后再恢复应用。
 *
 * `enabled` 为 false 时整份设置不生效，行为与升级前逐项一致；默认值保证旧 setting.json
 * 无需一次性迁移函数即可补齐。
 */
export const newTaskDefaultsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: submissionModeSchema.nullable().default(null),
    model: newTaskDefaultModelSchema.nullable().default(null),
    reasoningLevel: nonEmptyString.nullable().default(null),
    speed: nonEmptyString.nullable().default(null),
  })
  // 未知字段丢弃不报错：绿色版与 dev 版共用 setting.json，新版本加字段不能让旧版本整份读失败。
  .strip();

export type NewTaskDefaultModel = z.infer<typeof newTaskDefaultModelSchema>;
export type NewTaskDefaults = z.infer<typeof newTaskDefaultsSchema>;

export const DEFAULT_NEW_TASK_DEFAULTS: NewTaskDefaults = {
  enabled: false,
  mode: null,
  model: null,
  reasoningLevel: null,
  speed: null,
};

/**
 * 新建任务「跟随默认」时的推理强度取法：列表第一项、最高档（最后一项），
 * 或某个具体档位（目标模型不支持时由 provider 层降级）。
 */
export type DefaultReasoningLevelPick =
  | "first"
  | "highest"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * 设置页可固定的权限模式；`plan` 是 composer 里的独立勾选项，不作为默认值固定。
 * 目标仓权限模式含 `dontAsk`，与 build/edit/yolo 一样可固定。
 */
export const NEW_TASK_DEFAULT_MODE_IDS = ["build", "edit", "yolo", "dontAsk"] as const;
export type NewTaskDefaultModeId = (typeof NEW_TASK_DEFAULT_MODE_IDS)[number];

/** 把存储中的模式归一化为可固定的权限模式；不可固定的值按「跟随默认」处理。 */
export function normalizeNewTaskDefaultMode(
  mode: NewTaskDefaults["mode"],
): NewTaskDefaultModeId | null {
  if (!mode || mode === "plan") return null;
  return (NEW_TASK_DEFAULT_MODE_IDS as readonly string[]).includes(mode)
    ? (mode as NewTaskDefaultModeId)
    : null;
}
