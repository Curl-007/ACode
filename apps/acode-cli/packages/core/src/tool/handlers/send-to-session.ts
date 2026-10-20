// ============================================================
// SendToSession Tool Handler
// ============================================================
// 跟进消息路由到**持有上下文的既有舰队会话**（specs/session-fleet.md R6）：
// session_id 寻址（绝不按显示名）+ 所有权封闭（R3）+ 归档门（archived →
// session_archived，指引改读历史）。路由复用既有 SubagentPort.sendMessage：
// running → queued/steered；terminal → resumed_background（resume 重锚发起者
// 当前模式——R4 结构性不变量）。与既有 SendMessage 的分工：那边是 agentId
// 寻址的后台代理面，这边是舰队 session_id 寻址面（多担所有权与归档门）。

import {
  SEND_TO_SESSION_TOOL_NAME,
  SendToSessionInputJsonSchema,
  SendToSessionInputSchema,
  SendToSessionOutputJsonSchema,
  SendToSessionOutputSchema,
  type SendToSessionInput,
  type SendToSessionOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
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

const SEND_TO_SESSION_TIMEOUT_MS = 10_000;

const SEND_TO_SESSION_DESCRIPTION = [
  "Send a follow-up message to a fleet session you started, routing it to the session that already holds the context.",
  "",
  "- Address it by the session_id your own StartSession/HandOffToSession call returned in this transcript - never by display title. Prefer this over StartSession for follow-ups: the target session already has the repo, branch, worktree, and conversation context; a new session starts from zero.",
  "",
  "If the session already finished its turn, the message resumes it in the background and you will be notified when it completes again. Archived sessions refuse delivery; their transcripts remain readable via ReadSessionContext.",
].join("\n");

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = SendToSessionInputSchema.parse(input) as SendToSessionInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies SendToSessionOutput;
    const port = context.subagentPort;
    const sendMessage = requireFleetPort(
      port?.sendMessage?.bind(port),
      context,
      SEND_TO_SESSION_TOOL_NAME,
      "SubagentPort.sendMessage",
    );
    const registry = resolveFleetRegistry(deps);

    const ownership = registry.resolveOwned(context.sessionId, parsed.session_id);
    if (!ownership.ok) {
      return fleetRejection(ownership.reason, ownership.message) satisfies SendToSessionOutput;
    }
    const { record } = ownership;

    const result = await sendMessage(
      {
        sessionId: context.sessionId,
        turnId: context.turnId,
        parentToolCallId: context.toolCallId,
        to: record.agentId,
        summary: parsed.summary ?? `Follow-up for fleet session ${record.title}`,
        message: parsed.message,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
        trace: resolveFleetTraceContext(context),
      },
      { signal: context.abortSignal },
    );

    if (result.status !== "success") {
      return fleetRejection(
        "delivery_failed",
        `Delivery to fleet session "${parsed.session_id}" failed: ${result.error ?? "unknown error"}.`,
      ) satisfies SendToSessionOutput;
    }

    registry.update(record.sessionId, (current) => ({
      ...current,
      lastActivityAt: Date.now(),
    }));

    const message =
      result.delivery === "resumed_background"
        ? `Follow-up delivered to fleet session "${record.title}" (${parsed.session_id}); it finished its previous turn, so the message resumed it in the background. You will be notified when it completes.`
        : `Follow-up delivered to fleet session "${record.title}" (${parsed.session_id}) as '${result.delivery ?? "queued"}'.`;

    return {
      outcome: "sent",
      session_id: parsed.session_id,
      ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
      message,
    } satisfies SendToSessionOutput;
  };
}

const baseEntry = {
  capability: "Route a follow-up message to an owned fleet session",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: SEND_TO_SESSION_TOOL_NAME,
    description: SEND_TO_SESSION_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEND_TO_SESSION_TIMEOUT_MS,
    maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  formatModelContent: formatFleetModelContent,
  inputSchema: SendToSessionInputJsonSchema,
  outputSchema: SendToSessionOutputJsonSchema,
  runtimeInputSchema: SendToSessionInputSchema,
  runtimeOutputSchema: SendToSessionOutputSchema,
  permission: {
    permission: "fleet.session.message",
    reason: "SendToSession writes a message into an owned fleet session queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: fleetResultBudget(),
  timeout: fleetTimeout(SEND_TO_SESSION_TIMEOUT_MS),
  cancellation: fleetCancellation("SendToSession was cancelled before delivery status returned"),
  trace: fleetTrace(),
} satisfies Omit<ToolEntry, "handler">;

export function createSendToSessionToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const sendToSessionToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};
