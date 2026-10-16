// ============================================================
// Fleet Proposals - own_initiative 提案卡的预算/判重/过期纯规则
// (apps/acode-cli/specs/session-fleet.md 第二批 R11)
// ============================================================
// 提案 = 不启动的启动请求：own_initiative 的 StartSession 产出一张提案卡
// （registry 存储），用户点击/口头启动后凭 proposal_id 消费启动。定量规则
// 全部在本模块（纯函数，存储归 registry）：
// - 每回合每发起会话 ≤ FLEET_PROPOSAL_MAX_PER_TURN 张（launcher+turnId 键）；
// - 同一事项不重复（归一 title 判重）；
// - 一周过期（FLEET_PROPOSAL_TTL_MS），过期提案不可启动、不占预算；
// - 「绝不用于反正就要做的事」是描述义务（模型面），无结构判据。

import { randomUUID } from "node:crypto";
import type { FleetPermissionMode, FleetRejectReason, SessionId } from "@acode/contracts";

/** 每回合每发起会话的提案上限（spec 批 2 R11）。 */
export const FLEET_PROPOSAL_MAX_PER_TURN = 3;
/** 提案过期时长：一周。 */
export const FLEET_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FleetProposalRecord {
  /** `prop_<uuid>`：用户点头后 StartSession 凭它启动（所有权 = launcherSessionId）。 */
  readonly id: string;
  readonly launcherSessionId: SessionId;
  /** 产出提案的回合（预算键；缺席回合归入兜底键，仍受限）。 */
  readonly turnKey: string;
  readonly title: string;
  readonly prompt: string;
  readonly background?: string;
  readonly permissionMode?: FleetPermissionMode;
  readonly useWorktree?: boolean;
  readonly branchName?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type FleetProposalRejection = {
  ok: false;
  reason: Extract<
    FleetRejectReason,
    "proposal_budget_exceeded" | "proposal_duplicate" | "proposal_expired" | "proposal_unknown"
  >;
  message: string;
};

/** 归一 title（判重键）：小写 + 折叠空白 + 截 120——「同一事项」的定量近似。 */
export function normalizeFleetProposalTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

export function isFleetProposalExpired(proposal: FleetProposalRecord, now: number): boolean {
  return now >= proposal.expiresAt;
}

/**
 * 准入判定（新提案登记前）：预算与判重都只数**未过期**的提案——过期卡不占
 * 预算也不再挡同事项的新卡（一周窗口就是提案的生命周期）。
 */
export function evaluateFleetProposalAdmission(input: {
  openProposals: readonly FleetProposalRecord[];
  launcherSessionId: string;
  turnKey: string;
  title: string;
  now: number;
}): { ok: true } | FleetProposalRejection {
  const open = input.openProposals.filter(
    (proposal) =>
      proposal.launcherSessionId === input.launcherSessionId &&
      !isFleetProposalExpired(proposal, input.now),
  );
  const normalized = normalizeFleetProposalTitle(input.title);
  if (open.some((proposal) => normalizeFleetProposalTitle(proposal.title) === normalized)) {
    return {
      ok: false,
      reason: "proposal_duplicate",
      message:
        `An open proposal for "${input.title}" already exists - never propose the same thing twice. ` +
        "Reference the existing proposal_id, or wait for the user's decision on it.",
    };
  }
  const thisTurn = open.filter((proposal) => proposal.turnKey === input.turnKey);
  if (thisTurn.length >= FLEET_PROPOSAL_MAX_PER_TURN) {
    return {
      ok: false,
      reason: "proposal_budget_exceeded",
      message:
        `Proposal budget exhausted: at most ${FLEET_PROPOSAL_MAX_PER_TURN} own-initiative proposals per turn, ` +
        `and ${thisTurn.length} are already open from this turn. Finish the work you proposed, or let the user pick first.`,
    };
  }
  return { ok: true };
}

/** 新提案构造（id/过期时刻在这里定；存储归 registry）。 */
export function buildFleetProposal(input: {
  launcherSessionId: SessionId;
  turnKey: string;
  title: string;
  prompt: string;
  background?: string;
  permissionMode?: FleetPermissionMode;
  useWorktree?: boolean;
  branchName?: string;
  now: number;
}): FleetProposalRecord {
  return {
    id: `prop_${randomUUID()}`,
    launcherSessionId: input.launcherSessionId,
    turnKey: input.turnKey,
    title: input.title,
    prompt: input.prompt,
    ...(input.background === undefined ? {} : { background: input.background }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
    ...(input.branchName === undefined ? {} : { branchName: input.branchName }),
    createdAt: input.now,
    expiresAt: input.now + FLEET_PROPOSAL_TTL_MS,
  };
}

/**
 * proposal_id 消费判定（启动前）：id 无记录 / 属于别的会话 → proposal_unknown
 * （所有权封闭同款语义：只认本 transcript 成功产出的 id）；已过期 →
 * proposal_expired（顺手删除由调用方执行，纯函数不做副作用）。
 */
export function resolveFleetProposalForLaunch(input: {
  proposal: FleetProposalRecord | undefined;
  callerSessionId: string;
  now: number;
}): { ok: true; proposal: FleetProposalRecord } | FleetProposalRejection {
  const proposal = input.proposal;
  if (!proposal || String(proposal.launcherSessionId) !== input.callerSessionId) {
    return {
      ok: false,
      reason: "proposal_unknown",
      message:
        "No open proposal with that id was registered by YOUR own_initiative call in this transcript. " +
        "Proposal ids are ownership credentials like session ids - never inferred from titles or narration.",
    };
  }
  if (isFleetProposalExpired(proposal, input.now)) {
    return {
      ok: false,
      reason: "proposal_expired",
      message:
        `Proposal "${proposal.title}" expired (proposals live one week). ` +
        "If the work is still worth doing, propose it again with own_initiative.",
    };
  }
  return { ok: true, proposal };
}
