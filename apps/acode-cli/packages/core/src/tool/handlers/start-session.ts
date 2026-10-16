// ============================================================
// StartSession Tool Handler
// ============================================================
// agent 启动一个**用户可见的后台会话**（一等对象：title/status/started_at/
// last_activity/archived），返回 session_id 确立所有权（specs/session-fleet.md
// R2/R3）。进程面复用既有后台代理机制（SubagentPort，同进程 child runtime +
// 会话 JSONL + runtime-task 条目 + 完成通知链）；与 Agent 工具的分工：Agent =
// 一次性委托（要结论），StartSession = 长活会话（可跟进/列/移交/调权/归档）。
//
// 批 2（spec R11-R14）：initiation 三值闭集——offer（阻塞式确认卡，经
// resolvePermissionCapability 的 requiresUserInteraction 走既有 ask 通道）/
// user_asked（立即启动）/ own_initiative（提案卡：不启动，registry 存储，
// 预算 ≤3/回合、同事项判重、一周过期，用户点头后凭 proposal_id 消费启动）。

import {
  START_SESSION_TOOL_NAME,
  StartSessionInputJsonSchema,
  StartSessionInputSchema,
  StartSessionOutputJsonSchema,
  StartSessionOutputSchema,
  type StartSessionInput,
  type StartSessionOutput,
} from "@acode/contracts";
import type {
  ToolEntry,
  ToolHandler,
  ToolRuntimePermissionCapability,
} from "../types.js";
import { launchFleetSession } from "../../fleet/session-launch.js";
import { projectFleetPermissionMode } from "../../fleet/projection.js";
import {
  buildFleetProposal,
  evaluateFleetProposalAdmission,
  resolveFleetProposalForLaunch,
  type FleetProposalRecord,
} from "../../fleet/proposals.js";
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
  "initiation says whose task this is:",
  '- "offer": a task the user named in their latest message. This is the one call that waits - the user gets a blocking card asking "New session" or "Do it here" (approve = start it, deny = handle it in this session), so give it its own message with nothing else in flight.',
  '- "user_asked": the user asked in words for separate, parallel or background work - it starts now, one session per independent piece. A task the user\'s message tells you to do is NEVER own_initiative; decide which of the three applies in the first message of the turn.',
  '- "own_initiative": work you propose yourself (something you noticed, or a follow-up your own answer turned up). It starts NOTHING: it registers a proposal card the user may start later (a click, or telling you to start it - then call this tool again with that proposal_id). At most 3 proposals per turn, never the same thing twice, they expire after a week, and never propose what you are about to do anyway.',
  "",
  "- A follow-up you name gets a card, not just a sentence: when your reply tells the user some work is a follow-up, a separate change or for later, and it is real work worth its own session, propose it with own_initiative before you end the turn. The card is how you ask for their OK - do not leave \"needs your confirmation\" in prose instead.",
  "- The new session starts FRESH (it sees nothing of this conversation; forking context is not available). Give it background (>= 80 characters: the overall goal, decisions and constraints so far, how this piece fits) whenever the task is not fully self-contained; background complements the prompt, never replaces it. Every brief names the files/area it touches and what done looks like, in your own words - never \"based on the findings\".",
  "- Sessions that write code go one at a time per set of files - two writers must never touch the same files at once. use_worktree:false runs in the current checkout with no overwrite protection, so when its edits may overlap yours or another session's, pass use_worktree:true. Read-only pieces may run in parallel here.",
  "- The returned session_id is the ownership credential: fleet tools (SendToSession, ListSessions, HandOffToSession, SetSessionPermissionMode, ArchiveSession, DeleteSessions) only accept ids that YOUR successful StartSession/HandOffToSession call returned in this transcript. Failed or refused calls establish no ownership; titles are never inferred as ids.",
  "- Each started session also gets a short name in the result. ListSessions is the ONLY way to look up sessions you started - use the id from it, never a search and never a guessed id.",
  "- permission_mode can never be above your current mode (tighten-only). 'plan' starts a read-only planning session; omit it to inherit your current mode.",
  "- The session runs in the background and you are notified with its report when its turn completes. A note is that report, not proof: check the result or diff before telling the user it is done. Route follow-ups with SendToSession - it already holds the context; a new session starts from zero.",
  "- Before each fleet tool call, state in one line what you are starting and why.",
].join("\n");

/** 消费提案启动时的输入合成（提案自带 brief；调用只带 proposal_id）。 */
interface ResolvedLaunchInput {
  title: string;
  prompt: string;
  background?: string;
  permissionMode?: StartSessionInput["permission_mode"];
  useWorktree?: boolean;
  branchName?: string;
}

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = StartSessionInputSchema.parse(input) as StartSessionInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies StartSessionOutput;
    const registry = resolveFleetRegistry(deps);
    const now = Date.now();

    // ── 路径 1：proposal_id 消费（用户已点头；所有权 = 本 transcript 产出） ──
    let consumedProposal: FleetProposalRecord | undefined;
    let launchInput: ResolvedLaunchInput;
    if (parsed.proposal_id !== undefined) {
      const stored = registry.getProposal(parsed.proposal_id);
      const resolution = resolveFleetProposalForLaunch({
        proposal: stored,
        callerSessionId: context.sessionId,
        now,
      });
      if (!resolution.ok) {
        // 过期提案顺手除名（生命周期卫生；unknown 不动别人的/不存在的记录）。
        if (resolution.reason === "proposal_expired" && stored) {
          registry.removeProposal(stored.id);
        }
        return fleetRejection(resolution.reason, resolution.message) satisfies StartSessionOutput;
      }
      consumedProposal = resolution.proposal;
      launchInput = {
        title: consumedProposal.title,
        prompt: consumedProposal.prompt,
        ...(consumedProposal.background === undefined
          ? {}
          : { background: consumedProposal.background }),
        ...(consumedProposal.permissionMode === undefined
          ? {}
          : { permissionMode: consumedProposal.permissionMode }),
        ...(consumedProposal.useWorktree === undefined
          ? {}
          : { useWorktree: consumedProposal.useWorktree }),
        ...(consumedProposal.branchName === undefined
          ? {}
          : { branchName: consumedProposal.branchName }),
      };
    } else if (parsed.initiation === "own_initiative") {
      // ── 路径 2：own_initiative 提案（不启动；预算/判重/过期在 proposals.ts） ──
      if (parsed.title === undefined || parsed.prompt === undefined) {
        return fleetRejection(
          "start_needs_brief",
          "An own_initiative proposal needs its own title and prompt: the proposal card is the complete brief the user approves, and it may be started a week later when nobody remembers this turn.",
        ) satisfies StartSessionOutput;
      }
      const turnKey = context.turnId ?? "__no_turn__";
      const admission = evaluateFleetProposalAdmission({
        openProposals: registry.listProposalsByLauncher(context.sessionId),
        launcherSessionId: context.sessionId,
        turnKey,
        title: parsed.title,
        now,
      });
      if (!admission.ok) {
        return fleetRejection(admission.reason, admission.message) satisfies StartSessionOutput;
      }
      const proposal = buildFleetProposal({
        launcherSessionId: context.sessionId,
        turnKey,
        title: parsed.title,
        prompt: parsed.prompt,
        ...(parsed.background === undefined ? {} : { background: parsed.background }),
        ...(parsed.permission_mode === undefined
          ? {}
          : { permissionMode: parsed.permission_mode }),
        ...(parsed.use_worktree === undefined ? {} : { useWorktree: parsed.use_worktree }),
        ...(parsed.branch_name === undefined ? {} : { branchName: parsed.branch_name }),
        now,
      });
      registry.registerProposal(proposal);
      return {
        outcome: "proposed",
        proposal_id: proposal.id,
        proposal_expires_at: new Date(proposal.expiresAt).toISOString(),
        title: proposal.title,
        message:
          `Proposed "${proposal.title}" (proposal_id ${proposal.id}; expires ${new Date(proposal.expiresAt).toISOString()}). ` +
          "Nothing was started. The user can approve the card or tell you to start it - then call StartSession again with this proposal_id. " +
          "Carry on with your turn; do not wait on the proposal.",
      } satisfies StartSessionOutput;
    } else {
      // ── 路径 3：offer（已经过阻塞确认卡 = 权限 ask 放行）/ user_asked / 缺席 ──
      if (parsed.title === undefined || parsed.prompt === undefined) {
        return fleetRejection(
          "start_needs_brief",
          "Starting a session needs a title and a self-contained prompt (or a proposal_id registered by an earlier own_initiative call). The new session has no other context.",
        ) satisfies StartSessionOutput;
      }
      launchInput = {
        title: parsed.title,
        prompt: parsed.prompt,
        ...(parsed.background === undefined ? {} : { background: parsed.background }),
        ...(parsed.permission_mode === undefined
          ? {}
          : { permissionMode: parsed.permission_mode }),
        ...(parsed.use_worktree === undefined ? {} : { useWorktree: parsed.use_worktree }),
        ...(parsed.branch_name === undefined ? {} : { branchName: parsed.branch_name }),
      };
    }

    const subagentPort = requireFleetPort(
      context.subagentPort,
      context,
      START_SESSION_TOOL_NAME,
      "SubagentPort",
    );
    const result = await launchFleetSession(
      {
        title: launchInput.title,
        prompt: launchInput.prompt,
        ...(launchInput.background === undefined ? {} : { background: launchInput.background }),
        ...(launchInput.permissionMode === undefined
          ? {}
          : { permissionMode: launchInput.permissionMode }),
        ...(launchInput.useWorktree === undefined ? {} : { useWorktree: launchInput.useWorktree }),
        ...(launchInput.branchName === undefined ? {} : { branchName: launchInput.branchName }),
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
      // launch 失败/被拒：提案保留可重试（消费只在成功后发生，spec 批 2 R11）。
      return fleetRejection(result.reason, result.message) satisfies StartSessionOutput;
    }

    const { record, synchronous } = result;
    if (consumedProposal) {
      registry.removeProposal(consumedProposal.id);
    }
    const mode = projectFleetPermissionMode(record.mode);
    const message = [
      `Started fleet session "${record.title}" (${String(record.sessionId)}${record.name ? `, name: ${record.name}` : ""}).`,
      parsed.initiation === "offer"
        ? "The user approved starting this as its own session."
        : undefined,
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
      ...(record.name ? { name: record.name } : {}),
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

/**
 * 动态能力位（spec 批 2 R11 offer = 阻塞式确认卡）：initiation:"offer" 置
 * requiresUserInteraction → 权限服务在 yolo 直通**之前**强制 ask（既有
 * tool.userInteraction 通道，set-session-permission-mode 升权同款机制）。
 * 用户 allow = 「New session」，deny = 「Do it here」——handler 只在批准后运行。
 * 必拒的调用不置位（不为必拒调用打断用户，set-mode 先例）：缺 title/prompt
 * 或走 proposal 消费的调用由 handler 拒绝面自会收口。
 */
function resolveStartSessionCapability(input: unknown): ToolRuntimePermissionCapability | undefined {
  const parsed = StartSessionInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  if (parsed.data.initiation !== "offer") return undefined;
  if (parsed.data.proposal_id !== undefined) return undefined;
  if (parsed.data.title === undefined || parsed.data.prompt === undefined) return undefined;
  return { requiresUserInteraction: true };
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
  resolvePermissionCapability: resolveStartSessionCapability,
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
