import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookJSONOutput,
  type HookPermissionDecision,
  type HookSpecificOutput,
} from "@acode/contracts";
import type { HookRunResult } from "./types.js";

// 防滥用上限（specs/hook-additional-context-hardening.md）：hook 输出是不可信外部文本，
// 注入面直达模型上下文——单条 8KB 截断、单次事件派发最多保留 8 条。来源 hook 名标注
// 走平行 sources 数组 + formatter 层渲染，additionalContexts 内容本体不因标注改变
// （plugin-hook-middleware spec 的「合并结果逐一不变」守护约束）。
export const HOOK_ADDITIONAL_CONTEXT_MAX_CHARS = 8_192;
export const HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN = 8;
const ADDITIONAL_CONTEXT_TRUNCATED_SUFFIX = "...[truncated]";
const ADDITIONAL_CONTEXT_SOURCE_NAME_MAX_CHARS = 80;

export function processHookOutput(
  expectedEvent: HookEventName,
  output: HookJSONOutput | void,
): HookRunResult {
  const result: HookRunResult = {
    additionalContexts: [],
  };
  if (!output) return result;

  if (output.continue === false && expectedEvent !== HookEventName.Stop) {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason;
    if (shouldPreventContinuation(expectedEvent)) {
      result.preventContinuation = true;
    }
    if (isPermissionEvent(expectedEvent)) {
      result.permissionBehavior = "deny";
    }
  }
  if (expectedEvent === HookEventName.Stop && output.continue === true) {
    result.stopShouldContinue = true;
    result.stopReason = output.stopReason ?? output.reason;
  }
  if (output.decision === "approve" && isPermissionEvent(expectedEvent)) {
    result.permissionBehavior = "allow";
  }
  if (output.decision === "block") {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason ?? output.systemMessage;
    if (isPermissionEvent(expectedEvent)) result.permissionBehavior = "deny";
    if (shouldPreventContinuation(expectedEvent)) result.preventContinuation = true;
    if (expectedEvent === HookEventName.Stop) {
      result.stopShouldContinue = true;
      if (output.systemMessage) result.additionalContexts.push(output.systemMessage);
      if (output.reason) result.additionalContexts.push(output.reason);
    }
  }
  if (output.additionalContext) result.additionalContexts.push(output.additionalContext);
  if (output.additional_context) result.additionalContexts.push(output.additional_context);

  const specific = output.hookSpecificOutput;
  if (!specific) return result;
  if (specific.hookEventName !== expectedEvent) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook returned wrong event name", {
      context: {
        expectedEvent,
        hookEventName: specific.hookEventName,
      },
      recoverable: true,
    });
  }

  applyHookSpecificOutput(result, specific);
  return result;
}

export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
  mergeHookAdditionalContexts(target, next);
  if (next.blockRequested) {
    target.blockRequested = true;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  if (next.preventContinuation) {
    target.preventContinuation = true;
    target.stopReason = next.stopReason;
  }
  if (next.stopShouldContinue !== undefined) {
    target.stopShouldContinue = next.stopShouldContinue;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  if (next.updatedInput !== undefined) {
    target.updatedInput = next.updatedInput;
  }
  if (next.permissionRequestResult) {
    target.permissionRequestResult = next.permissionRequestResult;
  }
  if (next.hookPermissionDecisionReason) {
    target.hookPermissionDecisionReason = next.hookPermissionDecisionReason;
  }
  if (next.permissionBehavior) {
    target.permissionBehavior = mergePermissionBehavior(
      target.permissionBehavior,
      next.permissionBehavior,
    );
  }
}

export function matchesHookMatcher(
  matchValue: string | undefined,
  matcher: string | undefined,
): boolean {
  if (!matcher || matcher === "*") return true;
  if (!matchValue) return false;
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) {
    return matcher.split("|").includes(matchValue);
  }
  try {
    return new RegExp(matcher).test(matchValue);
  } catch {
    return false;
  }
}

function isPermissionEvent(event: HookEventName): boolean {
  return event === HookEventName.PreToolUse || event === HookEventName.PermissionRequest;
}

function applyHookSpecificOutput(result: HookRunResult, specific: HookSpecificOutput): void {
  switch (specific.hookEventName) {
    case HookEventName.PreToolUse:
      if (specific.permissionDecision) {
        result.permissionBehavior = specific.permissionDecision;
        result.hookPermissionDecisionReason = specific.permissionDecisionReason;
      }
      if ("updatedInput" in specific && specific.updatedInput !== undefined) {
        result.updatedInput = specific.updatedInput;
      }
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
    case HookEventName.PermissionRequest:
      if (specific.decision) {
        result.permissionRequestResult = specific.decision;
      }
      break;
    case HookEventName.PostToolUse:
    case HookEventName.PostToolUseFailure:
    case HookEventName.PostToolBatch:
    case HookEventName.PreCompact:
    case HookEventName.PostCompact:
    case HookEventName.PreModelSwitch:
    case HookEventName.PostModelSwitch:
    case HookEventName.SessionEnd:
    case HookEventName.StopFailure:
    case HookEventName.TaskCreated:
    case HookEventName.TaskCompleted:
    case HookEventName.CwdChanged:
    case HookEventName.UserPromptSubmit:
    case HookEventName.SessionStart:
    case HookEventName.Stop:
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
  }
}

function mergePermissionBehavior(
  current: HookPermissionDecision | undefined,
  next: HookPermissionDecision,
): HookPermissionDecision {
  if (current === "deny" || next === "deny") return "deny";
  if (current === "ask" || next === "ask") return "ask";
  return next;
}

function shouldPreventContinuation(event: HookEventName): boolean {
  // 阻断类事件闭集（specs/hook-event-surface.md「失败语义」）：这些事件的
  // continue:false / decision:"block" / 退出码 2 必须让触发点拒绝对应动作。
  // PreCompact ⇒ 放弃压缩；PreModelSwitch ⇒ 保持 previous selection。
  return (
    event === HookEventName.PreToolUse ||
    event === HookEventName.PermissionRequest ||
    event === HookEventName.UserPromptSubmit ||
    event === HookEventName.PreCompact ||
    event === HookEventName.PreModelSwitch
  );
}

/**
 * 防滥用硬化（specs/hook-additional-context-hardening.md）：runner 环节结算点
 * （runner-link.ts dispatchHookLink）是 hook 输出 → additionalContexts 的唯一收集
 * 写入路径，在 merge 前对每条 context 做 8KB 头部截断，并写入来源 hook 名
 * （单行折叠 + 80 字符截断，防 hook 名携带换行伪造多行标签）。
 * 条数上限在 mergeHookRunResult 实施（全部产出都经合并点）。
 */
export function hardenHookAdditionalContexts(result: HookRunResult, hookName: string): void {
  if (result.additionalContexts.length === 0) return;
  const source = formatHookContextSourceName(hookName);
  result.additionalContexts = result.additionalContexts.map(truncateHookAdditionalContext);
  result.additionalContextSources = result.additionalContexts.map(() => source);
}

/**
 * 注入格式化层的条目头（两个 formatter 单源共用）：无来源 → `#N`（与存量输出逐字节
 * 一致）；有来源 → `#N (hook: <名>)`。
 */
export function formatHookContextEntryHeader(
  index: number,
  sources?: readonly (string | undefined)[],
): string {
  const source = sources?.[index];
  return source === undefined ? `#${index + 1}` : `#${index + 1} (hook: ${source})`;
}

// 次数上限 + 来源对齐（单一合并写入路径）：单次事件派发最多保留
// HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN 条，超出部分静默丢弃（合并点保持纯函数，
// 无 logger）；任一侧携带 sources 时另一侧以 undefined 占位补齐，维持
// 「sources 存在时与 contexts 索引对齐」不变式。
function mergeHookAdditionalContexts(target: HookRunResult, next: HookRunResult): void {
  if (next.additionalContexts.length === 0) return;
  const room = HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN - target.additionalContexts.length;
  if (room <= 0) return;
  const acceptedCount = Math.min(room, next.additionalContexts.length);
  if (target.additionalContextSources !== undefined || next.additionalContextSources !== undefined) {
    const targetSources = (target.additionalContextSources ??= target.additionalContexts.map(
      () => undefined,
    ));
    for (let index = 0; index < acceptedCount; index += 1) {
      targetSources.push(next.additionalContextSources?.[index]);
    }
  }
  for (let index = 0; index < acceptedCount; index += 1) {
    target.additionalContexts.push(next.additionalContexts[index]);
  }
}

function truncateHookAdditionalContext(context: string): string {
  if (context.length <= HOOK_ADDITIONAL_CONTEXT_MAX_CHARS) return context;
  const keepChars = HOOK_ADDITIONAL_CONTEXT_MAX_CHARS - ADDITIONAL_CONTEXT_TRUNCATED_SUFFIX.length;
  return `${context.slice(0, keepChars)}${ADDITIONAL_CONTEXT_TRUNCATED_SUFFIX}`;
}

function formatHookContextSourceName(hookName: string): string {
  const singleLine = hookName.replace(/\s+/gu, " ").trim();
  if (singleLine.length === 0) return "hook";
  return singleLine.length > ADDITIONAL_CONTEXT_SOURCE_NAME_MAX_CHARS
    ? `${singleLine.slice(0, ADDITIONAL_CONTEXT_SOURCE_NAME_MAX_CHARS)}…`
    : singleLine;
}
