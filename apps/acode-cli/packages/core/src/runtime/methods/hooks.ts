import { HookEventName } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type { HookEventName as HookEventNameType } from "@acode/contracts";
import { formatHookContextEntryHeader } from "../../hooks/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getRuntimeLifecyclePort } from "../runtime-lifecycle.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

// T1-6 扩展事件面（specs/hook-event-surface.md）的触发函数拆到 hooks-extended.ts：
// 事件扩到 17 个后本文件越过 400 行架构 ratchet，按仓库惯例拆分；再导出保持公开
// API 与导入路径兼容——模块内消费者与守护测试仍从 "./hooks.js" 导入，不感知拆分。
export * from "./hooks-extended.js";

const MAX_STOP_HOOK_CONTINUATIONS = 3;

const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  const lifecycle = getRuntimeLifecyclePort(this);
  // activate 可能跨 await；先领取再执行，避免并发 startup/resume 重复运行 Hook，失败时在 catch 释放以便重试。
  if (!lifecycle.tryClaimSessionStartHook()) return EMPTY_HOOK_RESULT;

  try {
    await this.workspaceHookAdmission?.activate(source, signal);
    if (!this.hookRunner) {
      lifecycle.commitSessionStartHook();
      return EMPTY_HOOK_RESULT;
    }

    const selectedModel = model ?? this.getSessionModelSelection();
    const result = await this.hookRunner.run(
      {
        agentName: this.config.agentName,
        cwd: this.workingDirectory,
        hookEventName: HookEventName.SessionStart,
        mode: this.getMode(),
        model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
        sessionId: this.sessionId,
        source,
        timestamp: new Date().toISOString(),
        traceId: traceContext.traceId,
        turnId: traceContext.turnId,
      },
      { matchValue: source, signal },
    );
    lifecycle.commitSessionStartHook();
    return result;
  } catch (error) {
    lifecycle.releaseSessionStartHookClaim();
    throw error;
  }
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export function injectHookAdditionalContextIntoMessageHistory(
  this: AgentRuntimeInternal,
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
  additionalContextSources?: readonly (string | undefined)[],
): RuntimeMessageEntry | undefined {
  if (additionalContexts.length === 0) return undefined;
  const entry = systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(
      eventName,
      additionalContexts,
      additionalContextSources,
    ),
  );
  this.messageHistory.addEntries([entry]);
  return entry;
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
  sources?: readonly (string | undefined)[],
): string {
  // 条目头带来源 hook 名标注（specs/hook-additional-context-hardening.md）；无来源时
  // 与旧版 `#N` 逐字节一致。
  const body = additionalContexts
    .map((context, index) => `${formatHookContextEntryHeader(index, sources)}\n${context}`)
    .join("\n\n");
  return truncateForHook(
    [`${eventName} hook additional context: `, body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
