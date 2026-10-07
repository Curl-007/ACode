// 工作流创作工具的技能加载检查。
// CreateWorkflow、AmendWorkflow、SaveWorkflow 和 EvalWorkflowSnippet 的工具描述保持简短，
// facade 与写作规则由 `dynamic-workflows` 技能提供；RunWorkflow 同理，由 `script-workflows`
// 技能提供。提交脚本前必须加载**对应那一份**技能：会话历史里没有成功的
// `Skill(<name>)` 调用时，resolveInput 直接拒绝，避免进入 hook 或显示无效确认窗。
//
// 为什么两套技能不能互相顶替：两种 DSL 的头部规则是**相反**的——dwf 脚本被包进函数体，
// `export` 会触发 TS1184；脚本工作流必须以 `export const meta = {...}` 开头。加载错的那份
// 不会报「技能不对」，只会让模型写出编译/解析不过的脚本，然后进自修复循环越修越乱。
//
// 判据来自模型当前可见的 messageHistory。compaction 移除技能正文及对应调用后，需要重新加载；
// resume/rewind 则随历史一起恢复该判据，不维护第二份会话状态。
// 探针缺席表示当前装配未提供技能加载检查，此时不设置无法满足的前提。

import { DYNAMIC_WORKFLOW_SKILL_NAME, RUN_WORKFLOW_SKILL_NAME } from "@acode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * 「技能未加载」的稳定错误码。与工具的入参级 400 分开：调用方要能不靠文本区分「参数给错了」
 * 与「先去读技能」——前者改参数，后者多一次 Skill 调用。两套工作流共用同一个码，
 * 因为「先去读技能」这个动作对两者是同一件事。
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** 门在场时的判据；单独导出供探针实现复用。 */
export function isDynamicWorkflowSkillLoaded(context: ToolInputResolutionContext): boolean {
  return isWorkflowSkillLoaded(context, DYNAMIC_WORKFLOW_SKILL_NAME);
}

/** 按技能名判定，两套工作流共用。`?? true` 的语义见文件头（探针缺席即放行）。 */
export function isWorkflowSkillLoaded(
  context: ToolInputResolutionContext,
  skillName: string,
): boolean {
  return context.hasLoadedSkill?.(skillName) ?? true;
}

/**
 * 没读过技能就拒绝。返回 `undefined` 表示放行：技能已加载，或本会话没有探针（见文件头）。
 *
 * @param toolName 拒绝文案里点名的工具，让模型知道重试哪一个。
 */
export function requireDynamicWorkflowSkill(
  context: ToolInputResolutionContext,
  toolName: string,
): ToolHandlerFailure | undefined {
  return requireWorkflowSkill(context, toolName, DYNAMIC_WORKFLOW_SKILL_NAME);
}

/**
 * {@link requireDynamicWorkflowSkill} 的按技能名版本。dwf 那四个工具走上面的薄封装，
 * RunWorkflow 直接调这一个——两套的拒绝文案必须各自点名自己的技能，否则模型会去加载
 * 另一套的规则（见文件头）。
 */
export function requireWorkflowSkill(
  context: ToolInputResolutionContext,
  toolName: string,
  skillName: string,
): ToolHandlerFailure | undefined {
  if (isWorkflowSkillLoaded(context, skillName)) return undefined;
  return {
    result: false,
    errorCode: WORKFLOW_SKILL_NOT_LOADED_CODE,
    message: `${toolName} needs the \`${skillName}\` skill loaded in this session before it accepts a script. Call the Skill tool with skill "${skillName}" first — it carries the script API this tool's scripts are checked against, the authoring rules and this tool's full contract — then call ${toolName} again. Nothing was started.`,
  };
}

/** CreateWorkflow 的例外：按名字跑一个保存的工作流不是写脚本，不需要技能。 */
export function createWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  const runsSavedOnly =
    fields.saved !== undefined && fields.script === undefined && fields.path === undefined;
  return !runsSavedOnly;
}

/** AmendWorkflow 的例外：只改设定（`path` 与 `script` 都不带）沿用前驱的脚本，不是写脚本。 */
export function amendWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  return fields.script !== undefined || fields.path !== undefined;
}

/**
 * RunWorkflow 的例外，与上面两条同一判据形状：**只有提交脚本字节才需要技能**。
 *
 * - `name`（跑一个预定义工作流）→ 免技能：脚本是既有的，模型没有在创作；
 * - 只带 `resumeFromRunId`（续跑一个已有 run）→ 免技能：跑的是库里存着的脚本；
 * - `script` 或 `scriptPath` → 需要技能：`scriptPath` 也算，因为它的用途正是
 *   「改了那个文件再交回来」，改就是创作。
 */
export function runWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  if (fields.script !== undefined || fields.scriptPath !== undefined) return true;
  // 走到这里 script/scriptPath 都缺席：name 或 resumeFromRunId 至少有一个
  // （四个全缺由 schema 的 superRefine 挡掉，不该由技能门来报）。
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
