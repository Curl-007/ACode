// ============================================================
// HandOffToSession Tool Handler
// ============================================================
// 任务移交（specs/session-fleet.md R5）：把正在做的任务整体移交既有/新建舰队
// 会话，并登记 report-back 订阅——被移交会话每收口一个回合，其最新报告前
// 400 字符落进舰队记录（ListSessions 的 latest_note + TUI 一行态）。
//
// 推送面裁决（R5）：发起会话的模型可见推送复用既有后台完成通知链（全量报告、
// handback 信任包装、notified 去重）；400 字符 note 是舰队自有定量截断面，
// 不另开第二推送通道（那需要 runtime 通知缝，spec 非目标 #4）。

import {
  HAND_OFF_TO_SESSION_TOOL_NAME,
  HandOffToSessionInputJsonSchema,
  HandOffToSessionInputSchema,
  HandOffToSessionOutputJsonSchema,
  HandOffToSessionOutputSchema,
  type HandOffToSessionInput,
  type HandOffToSessionOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { launchFleetSession } from "../../fleet/session-launch.js";
import { subscribeFleetReportBack } from "../../fleet/notes.js";
import {
  FLEET_MAX_OUTPUT_BYTES,
  fleetCancellation,
  fleetRejection,
  fleetResultBudget,
  fleetTimeout,
  fleetTrace,
  fleetUnattendedRejection,
  formatFleetModelContent,
  requireFleetPort,
  resolveFleetRegistry,
  resolveFleetTraceContext,
  type FleetToolDeps,
} from "./session-fleet-shared.js";

const HAND_OFF_TIMEOUT_MS = 300_000;

const HAND_OFF_TO_SESSION_DESCRIPTION = [
  "Hand the task you are working on over to another session - either an existing fleet session you own, or a new one created for it.",
  "",
  "When to use: the user sent a new direction mid-task and the current work belongs in its own session; or a piece of the work is self-contained and should continue in parallel while you handle something here.",
  "",
  "- With session_id: the hand-off prompt is delivered to that session (it keeps its context). Without session_id: a NEW session is started from title + prompt (title required) and you own it like a StartSession result.",
  "- A NEW session starts fresh and sees nothing of this conversation: state what was done, what remains, and where the materials live (branch/worktree paths) in the prompt, and pass background (>= 80 characters: overall goal, decisions and constraints so far, how the piece fits) whenever the task is not fully self-contained.",
  "- Handing off is not abandoning: the brief names the files/area and what done looks like, in your own words.",
  "- After the hand-off, each time the target session completes a turn, the first 400 characters of its latest report are recorded as a note on it (visible via ListSessions); the full report still arrives through the standard completion notification. A note is that report, not proof: check the result or diff before telling the user it is done.",
].join("\n");

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = HandOffToSessionInputSchema.parse(input) as HandOffToSessionInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies HandOffToSessionOutput;
    const registry = resolveFleetRegistry(deps);
    const runtimeTaskRegistry = requireFleetPort(
      context.runtimeTaskRegistry,
      context,
      HAND_OFF_TO_SESSION_TOOL_NAME,
      "RuntimeTaskRegistry",
    );

    // ── 既有会话：所有权 + 归档门 → 既有 sendMessage 队列 ──
    if (parsed.session_id !== undefined) {
      const port = context.subagentPort;
      const sendMessage = requireFleetPort(
        port?.sendMessage?.bind(port),
        context,
        HAND_OFF_TO_SESSION_TOOL_NAME,
        "SubagentPort.sendMessage",
      );
      const ownership = registry.resolveOwned(context.sessionId, parsed.session_id);
      if (!ownership.ok) {
        return fleetRejection(ownership.reason, ownership.message) satisfies HandOffToSessionOutput;
      }
      const { record } = ownership;
      const result = await sendMessage(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          parentToolCallId: context.toolCallId,
          to: record.agentId,
          summary: `Task hand-off to fleet session ${record.title}`,
          message: parsed.prompt,
          workingDirectory: context.workingDirectory,
          workspaceRoot: context.workspaceRoot,
          trace: resolveFleetTraceContext(context),
        },
        { signal: context.abortSignal },
      );
      if (result.status !== "success") {
        return fleetRejection(
          "delivery_failed",
          `Hand-off delivery to fleet session "${parsed.session_id}" failed: ${result.error ?? "unknown error"}.`,
        ) satisfies HandOffToSessionOutput;
      }
      registry.update(record.sessionId, (current) => ({
        ...current,
        lastActivityAt: Date.now(),
      }));
      subscribeFleetReportBack(
        {
          registry,
          runtimeTaskRegistry,
          ...(deps.notePollIntervalMs === undefined ? {} : { intervalMs: deps.notePollIntervalMs }),
        },
        {
          sessionId: record.sessionId,
          agentId: record.agentId,
          originSessionId: context.sessionId,
        },
      );
      return {
        outcome: "handed_off",
        session_id: String(record.sessionId),
        task_id: record.agentId,
        created: false,
        message:
          `Task handed off to fleet session "${record.title}" (${String(record.sessionId)}). ` +
          REPORT_BACK_SENTENCE,
      } satisfies HandOffToSessionOutput;
    }

    // ── 新建会话：完整走 R2 launch（所有权凭成功返回确立）→ 订阅 ──
    if (parsed.title === undefined) {
      return fleetRejection(
        "new_session_needs_title",
        "Handing off to a NEW session requires a title. Pass session_id to hand off to an existing fleet session, or add a title for the new one.",
      ) satisfies HandOffToSessionOutput;
    }
    const subagentPort = requireFleetPort(
      context.subagentPort,
      context,
      HAND_OFF_TO_SESSION_TOOL_NAME,
      "SubagentPort",
    );
    const result = await launchFleetSession(
      {
        title: parsed.title,
        prompt: parsed.prompt,
        ...(parsed.background === undefined ? {} : { background: parsed.background }),
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
      return fleetRejection(result.reason, result.message) satisfies HandOffToSessionOutput;
    }
    const { record } = result;
    subscribeFleetReportBack(
      {
        registry,
        runtimeTaskRegistry,
        ...(deps.notePollIntervalMs === undefined ? {} : { intervalMs: deps.notePollIntervalMs }),
      },
      {
        sessionId: record.sessionId,
        agentId: record.agentId,
        originSessionId: context.sessionId,
      },
    );
    return {
      outcome: "handed_off",
      session_id: String(record.sessionId),
      task_id: record.agentId,
      created: true,
      message: `Task handed off to NEW fleet session "${record.title}" (${String(record.sessionId)}). ${REPORT_BACK_SENTENCE}`,
    } satisfies HandOffToSessionOutput;
  };
}

const REPORT_BACK_SENTENCE =
  "Each time it completes a turn, the first 400 characters of its latest report are recorded as a note on the session (ListSessions shows it); the full report arrives through the standard completion notification.";

const baseEntry = {
  capability: "Hand the current task off to an existing or new fleet session",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: HAND_OFF_TO_SESSION_TOOL_NAME,
    description: HAND_OFF_TO_SESSION_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  formatModelContent: formatFleetModelContent,
  inputSchema: HandOffToSessionInputJsonSchema,
  outputSchema: HandOffToSessionOutputJsonSchema,
  runtimeInputSchema: HandOffToSessionInputSchema,
  runtimeOutputSchema: HandOffToSessionOutputSchema,
  permission: {
    permission: "fleet.session.handoff",
    reason:
      "HandOffToSession routes the current task into a fleet session and subscribes report-back notes",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: fleetResultBudget(),
  timeout: fleetTimeout(HAND_OFF_TIMEOUT_MS),
  cancellation: fleetCancellation("HandOffToSession was cancelled before the hand-off settled"),
  trace: fleetTrace(),
} satisfies Omit<ToolEntry, "handler">;

export function createHandOffToSessionToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const handOffToSessionToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};
