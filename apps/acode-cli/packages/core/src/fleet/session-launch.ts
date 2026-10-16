// ============================================================
// Fleet Session Launch - StartSession / HandOffToSession(新建) 共用编排
// (apps/acode-cli/specs/session-fleet.md R2/R3/R5)
// ============================================================
// 所有权封闭的结构性保证在这里：**登记发生在 launch 成功返回之后**——报错/被拒
// 的调用不产生舰队记录（spec R3）。进程面复用既有后台代理机制（SubagentPort，
// 同进程 child runtime + 会话 JSONL + runtime-task 条目 + 完成通知链），舰队只
// 叠加生命周期层（记录/所有权/note/归档），不另起第二条进程面。
//
// 失败语义分层（worktree 三工具同款裁决）：业务边界 → 拒绝结果（闭集 reason）；
// 基础设施故障 → fail-loud 上抛。

import { randomUUID } from "node:crypto";
import {
  AgentLaunchFailureReason,
  createSessionId,
  isCoreError,
  type AgentOutput,
  type CollaborationMode,
  type Model,
  type SessionId,
  type SessionModePort,
  type SessionStorePort,
  type SubagentPort,
  type TraceContext,
} from "@acode/contracts";
import type { FleetPermissionMode, FleetRejectReason } from "@acode/contracts";
import { GENERAL_PURPOSE_AGENT_TYPE } from "../subagent/general-purpose.js";
import type { FleetRegistry, FleetSessionRecord } from "./registry.js";
import { resolveFleetLaunchMode, resolveLauncherEffectiveMode } from "./mode-policy.js";
import {
  adoptFleetWorktreeForChild,
  provisionFleetWorktree,
  releaseFleetWorktreeProvision,
  type FleetWorktreeDeps,
  type FleetWorktreeProvision,
} from "./worktree-provision.js";

/**
 * plan 档 vessel（spec R2）：bundled `Plan` preset（bundled-skills/agents/Plan.md，
 * frontmatter `permissionMode: plan`）——派生链把 plan 地板烘进 profile，
 * resolveSubagentPermissionMode 的 `case "plan"` 让 child 以 planEnabled 启动，
 * 权限服务结构性拒绝非只读动作。profile 缺席 → launch 抛 UnknownAgentType，
 * 折成 plan_profile_unavailable 拒绝（诚实探测，不预检派生链）。
 */
export const FLEET_PLAN_VESSEL_AGENT_TYPE = "Plan";

export interface FleetLaunchInput {
  title: string;
  prompt: string;
  permissionMode?: FleetPermissionMode;
  useWorktree?: boolean;
  branchName?: string;
}

export interface FleetLaunchContext {
  callerSessionId: SessionId;
  toolCallId: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
  signal: AbortSignal;
  subagentPort: SubagentPort;
  sessionModePort?: SessionModePort;
  sessionStore?: SessionStorePort;
  registry: FleetRegistry;
  model?: Model;
  /** 测试注入（worktree manager/ledger/时钟）；生产走缺省单例。 */
  worktreeDeps?: FleetWorktreeDeps;
  /** 测试注入：覆盖发起者有效模式推导。 */
  launcherEffectiveMode?: CollaborationMode;
  now?: () => number;
}

export type FleetLaunchResult =
  | {
      outcome: "started";
      record: FleetSessionRecord;
      /** 一次性前台策略宿主把后台派发重写为前台：launch 同步完成（R2 末段）。 */
      synchronous: boolean;
      worktree?: FleetWorktreeProvision;
    }
  | { outcome: "rejected"; reason: FleetRejectReason; message: string };

export async function launchFleetSession(
  input: FleetLaunchInput,
  ctx: FleetLaunchContext,
): Promise<FleetLaunchResult> {
  const launcherMode =
    ctx.launcherEffectiveMode ?? resolveLauncherEffectiveMode(ctx.sessionModePort);
  const decision = resolveFleetLaunchMode({ requested: input.permissionMode, launcherMode });
  if (decision.kind === "rejected") {
    return { outcome: "rejected", reason: decision.reason, message: decision.message };
  }
  const agentType =
    decision.kind === "plan_vessel" ? FLEET_PLAN_VESSEL_AGENT_TYPE : GENERAL_PURPOSE_AGENT_TYPE;
  const modeLineage: FleetSessionRecord["modeLineage"] =
    decision.kind === "plan_vessel" ? "plan" : "ceiling";

  // worktree 必须在 launch 之前 provision：child runtime 的 workingDirectory 在
  // 构造期定死，launch 之后再进就晚了（spec R2）。
  let provision: FleetWorktreeProvision | undefined;
  if (input.useWorktree === true) {
    const tempKey = `fleet_${randomUUID()}`;
    const provisioned = await provisionFleetWorktree(
      {
        repoDir: ctx.workingDirectory,
        tempKey,
        slugSource: input.branchName ?? input.title,
      },
      ctx.worktreeDeps ?? {},
    );
    if (!provisioned.ok) {
      return {
        outcome: "rejected",
        reason: "worktree_rejected",
        message: `use_worktree was rejected (${provisioned.reason}): ${provisioned.message}`,
      };
    }
    provision = provisioned.provision;
  }

  let output: AgentOutput;
  try {
    output = await ctx.subagentPort.launch(
      {
        sessionId: ctx.callerSessionId,
        parentToolCallId: ctx.toolCallId,
        agentType,
        description: input.title,
        prompt: input.prompt,
        workingDirectory: provision?.path ?? ctx.workingDirectory,
        workspaceRoot: ctx.workspaceRoot,
        trace: ctx.trace,
        runInBackground: true,
      },
      {
        signal: ctx.signal,
        ...(ctx.model ? { model: ctx.model } : {}),
      },
    );
  } catch (error) {
    if (provision) {
      await releaseFleetWorktreeProvision({ provision }, ctx.worktreeDeps ?? {});
    }
    return mapLaunchFailure(error, agentType);
  }

  // ── 到此 launch 已成功返回：所有权确立（R3 结构性保证） ──
  const agentId = output.agentId;
  const childSessionId =
    output.status === "async_launched"
      ? (output.childSessionId as SessionId)
      : createSessionId(`subagent_${agentId}`);
  const now = (ctx.now ?? Date.now)();
  const record: FleetSessionRecord = {
    sessionId: childSessionId,
    agentId,
    title: input.title,
    agentType,
    launchedBySessionId: ctx.callerSessionId,
    launchedByToolCallId: ctx.toolCallId,
    startedAt: now,
    mode: decision.mode,
    modeLineage,
    lastActivityAt: now,
    archived: false,
    ...(provision ? { worktree: { path: provision.path, branch: provision.branch } } : {}),
  };
  ctx.registry.register(record);

  if (provision) {
    try {
      await adoptFleetWorktreeForChild({ provision, childSessionId }, ctx.worktreeDeps ?? {});
    } catch {
      // 重键失败是台账卫生问题，不回滚已确立的会话：绑定留在临时键上，围栏按
      // 路径键仍然生效（写围栏不依赖 sessionId），残键由后续 enter 的
      // worktree-missing 语义与收割面兜住。
    }
  }

  // 标题落库 best-effort（spec R2）：内存记录是舰队事实源，store 面服务冷目录。
  if (ctx.sessionStore) {
    void ctx.sessionStore
      .updateSession({
        id: childSessionId,
        title: input.title,
        titleSource: "custom",
        timeUpdated: now,
      })
      .catch(() => undefined);
  }

  return {
    outcome: "started",
    record,
    synchronous: output.status === "completed",
    ...(provision ? { worktree: provision } : {}),
  };
}

/**
 * launch 抛错 → 业务拒绝（既有闭集 reason 折算）或 fail-loud 上抛。
 * UnknownAgentType 只对 Plan vessel 折成 plan_profile_unavailable；
 * general-purpose 缺席是宿主装配故障，不是可改道的业务边界。
 */
function mapLaunchFailure(error: unknown, agentType: string): FleetLaunchResult {
  if (isCoreError(error)) {
    const reason = error.context?.reason;
    if (reason === AgentLaunchFailureReason.BackgroundUnavailable) {
      return {
        outcome: "rejected",
        reason: "background_unavailable",
        message:
          "Background session launch is refused in this context (idle-time or single-execution model override). " +
          "Fleet sessions are background by design; use the Agent tool in the foreground instead.",
      };
    }
    if (
      reason === AgentLaunchFailureReason.UnknownAgentType &&
      agentType === FLEET_PLAN_VESSEL_AGENT_TYPE
    ) {
      return {
        outcome: "rejected",
        reason: "plan_profile_unavailable",
        message:
          'The bundled Plan agent profile (the read-only vessel for permission_mode:"plan") is not available on this host. ' +
          "Omit permission_mode to inherit your current mode.",
      };
    }
  }
  throw error;
}
