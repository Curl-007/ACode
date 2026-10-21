import type { TeamMember, TeamState } from "./state/types.js";

/**
 * 调用者身份：从 MCP tools/call 的 _meta["com.acode/request-context"] 推导。
 * main → 队长候选（须 team.captainSessionId 匹配）；subagent → 成员候选（须名册存在）。
 * 冒烟/裸 JSON-RPC 没有 _meta：允许显式 caller 参数降级，返回值带警告。
 */

export interface CallerIdentity {
  sessionId?: string;
  runtimeScope?: "main" | "subagent";
  workspaceKey?: string;
  degraded: boolean;
}

export interface ExplicitCaller {
  name?: string;
  role?: "captain" | "member";
}

export function resolveCallerIdentity(params: {
  meta?: unknown;
  explicitCaller?: ExplicitCaller;
}): { identity: CallerIdentity; memberName?: string } {
  const requestContext = readRequestContext(params.meta);
  if (requestContext) {
    const identity: CallerIdentity = {
      sessionId: pickString(requestContext.session_id),
      runtimeScope: pickScope(requestContext.runtime_scope),
      workspaceKey: pickString(requestContext.workspace_key),
      degraded: false,
    };
    return { identity };
  }
  // 降级：仅手动冒烟路径。ACode 注入的 _meta 永远命中上一分支。
  const explicit = params.explicitCaller;
  if (explicit?.role === "captain" || (!explicit?.role && !explicit?.name)) {
    return { identity: { degraded: true, sessionId: "smoke-captain", runtimeScope: "main" } };
  }
  if (explicit?.name) {
    return {
      identity: { degraded: true, sessionId: `smoke-${explicit.name}`, runtimeScope: "subagent" },
      memberName: explicit.name,
    };
  }
  return { identity: { degraded: true } };
}

function readRequestContext(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const record = meta as Record<string, unknown>;
  const nested = record["com.acode/request-context"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : record;
  const sessionId = pickString(source.session_id);
  const scope = pickScope(source.runtime_scope);
  if (sessionId || scope) return source;
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickScope(value: unknown): "main" | "subagent" | undefined {
  return value === "main" || value === "subagent" ? value : undefined;
}

export function captainOk(team: TeamState, identity: CallerIdentity): boolean {
  if (identity.runtimeScope !== "main") return false;
  if (identity.degraded) return identity.sessionId === "smoke-captain";
  return team.captainSessionId === identity.sessionId;
}

/**
 * 成员校验（宽松语义，见 PRD §23 修正 A）：runtime_scope=subagent + 名册存在该成员。
 * 续跑会重建 child session id，严格绑定不可行；伪造风险由 scope + workspace 隔离兜底。
 */
export function memberNameFromIdentity(
  team: TeamState,
  identity: CallerIdentity,
  fallbackName?: string,
): string | undefined {
  if (fallbackName && identity.degraded) {
    const member = team.members.find((item) => item.name === fallbackName);
    return member && member.status !== "removed" ? member.name : undefined;
  }
  if (identity.runtimeScope !== "subagent") return undefined;
  return findBoundMemberBySession(team, identity.sessionId)?.name;
}

/**
 * ACode 宿主 child session id 的构造规则：`sess_subagent_<agentId>`（core subagent runner），
 * 续跑复用同一 id。
 */
export function subagentSessionIdForAgent(agentId: string): string {
  return `sess_subagent_${agentId}`;
}

/**
 * 按调用方 sessionId 找已绑定成员。
 * 修复原因：bind_member 只拿得到 agentId，boundSessionId 在生产代码里从未被写入真实值，
 * 旧判定 `boundSessionId === sessionId` 恒不成立，成员侧工具全部报 caller_not_member。
 * 修复依据：宿主 child session id 由 agentId 确定性派生，因此未显式记录 boundSessionId 时
 * 按 agentId 推导比对；每个成员 agentId 唯一（bind 时已校验），多个成员并发时也不会串号。
 */
export function findBoundMemberBySession(
  team: { members: readonly TeamMember[] },
  sessionId: string | undefined,
): TeamMember | undefined {
  if (!sessionId) return undefined;
  return team.members.find((member) => {
    if (member.status !== "bound") return false;
    if (member.boundSessionId) return member.boundSessionId === sessionId;
    return member.agentId !== undefined && subagentSessionIdForAgent(member.agentId) === sessionId;
  });
}

/**
 * 调用方**参与**的活跃团队列表（0.2 多团队寻址的判据）：
 * - main 会话：captainSessionId 匹配的团队（含接管后的）；
 * - subagent 会话：名册中存在按 sess_subagent_<agentId> 派生会话绑定的成员的团队
 *   （降级冒烟身份按 memberNameHint 匹配，与 requireMember 的降级路径同语义）。
 * 返回的顺序即 listTeams 的 createdAt 序；0/1/≥2 三种形态由调用方分别处理。
 */
export function teamsCallerParticipatesIn(
  teams: readonly TeamState[],
  identity: CallerIdentity,
  degradedMemberNameHint?: string,
): TeamState[] {
  if (identity.runtimeScope !== "main" && identity.runtimeScope !== "subagent") return [];
  return teams.filter((team) => {
    if (identity.runtimeScope === "main") {
      return team.captainSessionId === identity.sessionId;
    }
    if (findBoundMemberBySession(team, identity.sessionId)) return true;
    // 降级冒烟身份：与 requireMember 的 memberNameHint 路径同语义。
    if (identity.degraded && degradedMemberNameHint) {
      const member = team.members.find(
        (item) => item.name === degradedMemberNameHint && item.status !== "removed",
      );
      return Boolean(member);
    }
    return false;
  });
}
