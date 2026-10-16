// ============================================================
// StartSession Tool Handler
// ============================================================
// agent 启动一个**用户可见的后台会话**（一等对象：title/status/started_at/
// last_activity/archived），返回 session_id 确立所有权（specs/session-fleet.md
// R2/R3）。进程面复用既有后台代理机制（SubagentPort，同进程 child runtime +
// 会话 JSONL + runtime-task 条目 + 完成通知链）；与 Agent 工具的分工：Agent =
// 一次性委托（要结论），StartSession = 长活会话（可跟进/列/移交/调权/归档）。

import {
  START_SESSION_TOOL_NAME,
  StartSessionInputJsonSchema,
  StartSessionInputSchema,
  StartSessionOutputJsonSchema,
  StartSessionOutputSchema,
  type StartSessionInput,
  type StartSessionOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { launchFleetSession } from "../../fleet/session-launch.js";
import { projectFleetPermissionMode } from "../../fleet/projection.js";
import {
  FLEET_MAX_OUTPUT_BYTES,
  fleetCancellation,
  fleetRejection,
  fleetResultBudget,
  fleetTimeout,
  fleetTrace,
  formatFleetModelContent,
  requireFleetPort,
  resolveFleetRegistry,
  resolveFleetTraceContext,
  fleetUnattendedRejection,
  type FleetToolDeps,
} from "./session-fleet-shared.js";

const START_SESSION_TIMEOUT_MS = 300_000;

const START_SESSION_DESCRIPTION = [
  "Start a new background session the user can see and manage: a first-class parallel session with its own title, transcript, and lifecycle - not a one-shot delegation.",
  "",
  "When to use: the work should run alongside this conversation as its own session (an independent task the user may inspect or steer later). For a one-shot delegation where you only need the conclusion, use the Agent tool instead.",
  "",
  "- The returned session_id is the ownership credential: fleet tools (SendToSession, ListSessions, HandOffToSession, SetSessionPermissionMode, ArchiveSession, DeleteSessions) only accept ids that YOUR successful StartSession/HandOffToSession call returned in this transcript. Failed or refused calls establish no ownership; titles are never inferred as ids.",
  "- permission_mode can never be above your current mode (tighten-only). 'plan' starts a read-only planning session; omit it to inherit your current mode.",
  "- use_worktree: true isolates the session in a fresh git worktree cut from the current HEAD; uncommitted changes in the checkout are NOT carried over.",
  "- The session runs in the background and you are notified with its report when its turn completes. Route follow-ups with SendToSession - it already holds the context; a new session starts from zero.",
  "- Before each fleet tool call, state in one line what you are starting and why.",
].join("\n");

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = StartSessionInputSchema.parse(input) as StartSessionInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies StartSessionOutput;
    const subagentPort = requireFleetPort(
      context.subagentPort,
      context,
      START_SESSION_TOOL_NAME,
      "SubagentPort",
    );
    const registry = resolveFleetRegistry(deps);

    const result = await launchFleetSession(
      {
        title: parsed.title,
        prompt: parsed.prompt,
        ...(parsed.permission_mode === undefined ? {} : { permissionMode: parsed.permission_mode }),
        ...(parsed.use_worktree === undefined ? {} : { useWorktree: parsed.use_worktree }),
        ...(parsed.branch_name === undefined ? {} : { branchName: parsed.branch_name }),
      },
      {
        callerSessionId: context.sessionId,
        toolCallId: context.toolCallId,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
        trace: resolveFleetTraceContext(context),
        signal: context.abortSignal,
        subagentPort,
        ...(context.sessionModePort ? { sessionModePort: context.sessionModePort } : {}),
        ...(context.sessionStore ? { sessionStore: context.sessionStore } : {}),
        registry,
        ...(context.model ? { model: context.model } : {}),
        ...(deps.worktreeDeps ? { worktreeDeps: deps.worktreeDeps } : {}),
      },
    );

    if (result.outcome === "rejected") {
      return fleetRejection(result.reason, result.message) satisfies StartSessionOutput;
    }

    const { record, synchronous } = result;
    const mode = projectFleetPermissionMode(record.mode);
    const message = [
      `Started fleet session "${record.title}" (${String(record.sessionId)}).`,
      synchronous
        ? "This host runs dispatches in the foreground, so the session already completed its first turn synchronously; its report is in the completion output and follow-ups resume it."
        : "It is running in the background; you will be notified with its report when the turn completes.",
      `Route follow-ups with SendToSession using session_id '${String(record.sessionId)}' - it keeps its context.`,
      record.worktree
        ? `Isolated worktree: ${record.worktree.path} on branch ${record.worktree.branch} (uncommitted changes in the checkout were not carried over).`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");

    return {
      outcome: "started",
      session_id: String(record.sessionId),
      task_id: record.agentId,
      title: record.title,
      ...(mode === undefined ? {} : { mode }),
      ...(record.worktree
        ? {
            worktree_path: record.worktree.path,
            branch: record.worktree.branch,
            ...(result.worktree ? { base_ref: result.worktree.baseRef } : {}),
          }
        : {}),
      message,
    } satisfies StartSessionOutput;
  };
}

const baseEntry = {
  capability: "Start a user-visible background fleet session and take ownership of it",
  metadata: {
    name: START_SESSION_TOOL_NAME,
    description: START_SESSION_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // 会话启动写 store/台账并注册生命周期对象，绝不与兄弟工具并发。
    concurrentSafe: false,
    maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  formatModelContent: formatFleetModelContent,
  inputSchema: StartSessionInputJsonSchema,
  outputSchema: StartSessionOutputJsonSchema,
  runtimeInputSchema: StartSessionInputSchema,
  runtimeOutputSchema: StartSessionOutputSchema,
  permission: {
    permission: "fleet.session.start",
    reason: "StartSession launches a background child runtime as a user-visible fleet session",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: fleetResultBudget(),
  timeout: fleetTimeout(START_SESSION_TIMEOUT_MS),
  cancellation: fleetCancellation("StartSession was cancelled before the session launch settled"),
  trace: fleetTrace(),
} satisfies Omit<ToolEntry, "handler">;

/** 工厂：测试注入 registry/worktree deps；装配面用缺省 entry（无注册门，spec R1）。 */
export function createStartSessionToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const startSessionToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};
