import {
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
} from "@acode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";

interface PermissionHookInputRecheckResult {
  brokerResult?: PermissionBrokerResult;
  permissionDecision?: PermissionDecisionResult;
}

export async function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  requestId: string;
  signal?: AbortSignal;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<PermissionHookInputRecheckResult> {
  const baseRuntimePermissionContext = resolveRuntimePermissionContext(input.deps);
  // R6 边界⑥收口（spec npm-script-body-scan.md R1/R5）：hook 改写后的命令可能指向
  // 不同的 script/选择器，复核必须**重新预取**，与首次判定同源同语义。
  const capabilityContextExtra = await input.entry.resolvePermissionCapabilityContextAsync?.(
    input.modifiedInput,
    baseRuntimePermissionContext,
  );
  const runtimePermissionContext = {
    ...baseRuntimePermissionContext,
    ...(capabilityContextExtra ?? {}),
  };
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // 与首次判定同源：hook 改过 input 之后，草稿免确认仍要按同一个工作目录复核。
    workingDirectory: input.deps.getWorkingDirectory(),
    // 安全加固 P2：hook 可能把路径改写到工作区外——熔断器复核必须拿到同一个根。
    workspaceRoot: input.deps.getWorkspaceRoot(),
    // 对抗复审 N3：复核与首次判定必须是同一调用方身份，否则 hook 改写后命中的反射门
    // 挑战键会换一个身份，门把已通过反射的命令重新拒一遍（反之也防跨身份借用挑战）。
    sessionId: input.deps.sessionId,
    // R6 边界⑥收口：script 体 map（deny 级熔断与反射门从这里拿注入）。
    ...(runtimePermissionContext.packageScripts
      ? { packageScripts: runtimePermissionContext.packageScripts }
      : {}),
    // 对抗验证 F1②：扫描覆盖证据同源透传（与首次判定同一语义）。
    ...(runtimePermissionContext.scannedDirectories
      ? { scannedDirectories: runtimePermissionContext.scannedDirectories }
      : {}),
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory: input.deps.getWorkingDirectory(),
    workspaceRoot: input.deps.getWorkspaceRoot(),
  });

  if (decision.decision === "deny") {
    return {
      brokerResult: { decision: "deny", reason: decision.reason },
      permissionDecision: decision,
    };
  }
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      // 安全加固 P2：hook 改写 input 后命中旁路免疫熔断器（如路径被改到工作区外）
      // 必须重新走确认——改写后的危险性正是熔断器要拦的，不能沿用改写前的放行。
      !decision.ruleId.startsWith("breaker.") &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory: input.deps.getWorkingDirectory(),
        workspaceRoot: input.deps.getWorkspaceRoot(),
      }))
  ) {
    return {};
  }

  const suggestedPermissionUpdates =
    rulePolicy?.suggestedPermissionUpdates ??
    buildDefaultPermissionUpdates(input.toolCall.name, input.modifiedInput);
  const brokerResult = await input.deps.permissionBroker.requestPermission(
    {
      input: input.modifiedInput,
      mode: input.mode,
      reason: decision.reason ?? `Tool ${input.toolCall.name} requires approval`,
      requestId: input.requestId,
      requestedAt: new Date(),
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sessionId: input.deps.sessionId,
      sideEffectScope: decision.sideEffectScope,
      suggestedPermissionUpdates,
      toolCallId: input.toolCall.id as PermissionBrokerRequest["toolCallId"],
      toolName: input.toolCall.name,
      traceId: input.traceContext.traceId,
      turnId: input.traceContext.turnId ?? input.deps.turnId,
    },
    {
      signal: input.signal,
      timeoutMs: input.deps.permissionTimeoutMs,
    },
  );
  return { brokerResult, permissionDecision: decision };
}
