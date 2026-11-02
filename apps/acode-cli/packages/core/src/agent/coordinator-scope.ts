// ============================================================
// 协调者（AgentTeams 队长）只读作用域（specs/coordinator-readonly-preset.md R2/R4）
// ============================================================
// 「哪个会话是队长」的权威来源 = 插件状态通知里已声明的 `state.teams[].captainSessionId`
// （R2.1；宿主只取这一个安全事实字段，不解插件业务状态、不读插件私有磁盘布局，
// 不落第二份编排台账 —— EI-48 / R8.4）。宿主在**运行时**把派生结果写进本会话级 store，
// 权限面经 `snapshotSessionCoordinatorScope` 每次裁决取快照（与 skill-activation-scope
// 同型的「store 是缓存不是事实源」哲学）。
//
// 粘性（R4.1 / EI-4）：一旦为某会话建立过「协调者」判定，本进程内粘性只读——任何后续
// 「判定不可得」不得解除，保持只读并标记 identity_missing；解除只能由 R2.3 的正向解除
// 证据（新状态显示本会话不再是任何活跃团队队长）触发。从未建立过判定的会话遇到不可得
// 不施加预设（R4.2，不因缺证据把普通主会话误锁为只读）。
//
// 持久化（Q3 裁决）：仅内存 + 由 PluginStateUpdated 重放重建，不新增持久面；恢复期
// 「判定不可得」窗口的粘性语义局限已在 spec/Q3 登记。

import type { SessionId } from "@acode/contracts";
import {
  COORDINATOR_DISALLOWED_TOOLS,
  type CoordinatorScope,
} from "../permission/coordinator-readonly.js";

/** 插件裸名（官方实存 id = `${name}@acode-plugins-official`，见插件发现 `id: name@marketplace`）。 */
export const AGENT_TEAMS_PLUGIN_ID = "agent-teams";
/** 插件状态主题（通知的 `key`；快照键 = `${pluginId}:${key}`）。 */
export const AGENT_TEAMS_PLUGIN_STATE_TOPIC = "agent-teams";

/** 插件身份判据：裸名或任意 marketplace 下的 `agent-teams@*`（身份与 marketplace 解耦）。 */
export function isAgentTeamsPluginId(pluginId: string): boolean {
  return pluginId === AGENT_TEAMS_PLUGIN_ID || pluginId.startsWith(`${AGENT_TEAMS_PLUGIN_ID}@`);
}

/**
 * 从整张 `pluginStates` 快照里找一个 agent-teams 状态键（`${pluginId}:agent-teams`）。
 * 多个身份（不同 marketplace）并存时取 key 字典序第一个——与 UI 投影
 * （teamPanelModel 的 `:agent-teams` 后缀匹配）同一裁决，不绑定单一 marketplace 字面量。
 */
export function findAgentTeamsPluginStateKey(
  pluginStates: Record<string, unknown>,
): string | undefined {
  const suffix = `:${AGENT_TEAMS_PLUGIN_STATE_TOPIC}`;
  const keys = Object.keys(pluginStates)
    .filter(
      (key) =>
        key.endsWith(suffix) &&
        isAgentTeamsPluginId(key.slice(0, key.length - suffix.length)),
    )
    .sort();
  return keys[0];
}

interface CoordinatorBasisEntry {
  /** 由 R2.1 派生置真、R2.3 派生置假；一旦写入即粘性（undefined 不覆盖，R4.1）。 */
  readonly basis: boolean;
  /** R4.1 粘性期遇到「判定不可得」的标记；正向再确认（basis 置真）清空。 */
  identityMissing: boolean;
}

const bindings = new Map<string, CoordinatorBasisEntry>();

/**
 * 唯一写入口：写入会话级队长基准（R4.1）。
 * - `true` / `false`：正向证据，覆盖既有值（true 同时清空 identity_missing）。
 * - `undefined`：判定不可得——**不覆盖**既有值；已建立为只读的会话保持只读并标记
 *   identity_missing（R4.1）；从未建立 / 已解除的会话保持原状（R4.2，不施加）。
 */
export function setSessionCoordinatorBasis(
  sessionId: SessionId | string,
  basis: boolean | undefined,
): void {
  const key = String(sessionId);
  const current = bindings.get(key);
  if (basis === undefined) {
    if (current?.basis === true) current.identityMissing = true;
    return;
  }
  if (current && current.basis === basis) {
    if (basis) current.identityMissing = false;
    return;
  }
  bindings.set(key, { basis, identityMissing: false });
}

/** 权限面只读查询：basis 为真 → 只读作用域；否则 undefined（不施加 / 零行为变化）。 */
export function snapshotSessionCoordinatorScope(
  sessionId: SessionId | string,
): CoordinatorScope | undefined {
  const entry = bindings.get(String(sessionId));
  if (!entry || entry.basis !== true) return undefined;
  return entry.identityMissing
    ? { tools: COORDINATOR_DISALLOWED_TOOLS, identityMissing: true }
    : { tools: COORDINATOR_DISALLOWED_TOOLS };
}

/** 会话终结 / 测试隔离的清除（进程亡故 = 缓存亡故，与台账哲学一致）。 */
export function clearSessionCoordinatorScope(sessionId: SessionId | string): void {
  bindings.delete(String(sessionId));
}

/** 测试与启动装配的整表清除（避免跨用例泄漏）。 */
export function clearAllSessionCoordinatorScopes(): void {
  bindings.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * R2.1 派生（纯函数）：单个 agent-teams 状态快照 → 本会话是否为队长。
 * `teams[]` 是活跃集（draft/active/paused）；归档项不进 `teams[]`（R2.3，显式排除
 * `primary` / `recentEnded` 展示投影）。
 * 判定不可得 → undefined（形状不符 / teams 缺席 / 非对象 / 状态为 null）——按 R3 失效
 * 模式表，重放重建时据此走 R4 粘性。
 */
export function deriveCoordinatorBasisFromPluginState(
  state: unknown,
  sessionId: SessionId | string,
): boolean | undefined {
  if (!isRecord(state)) return undefined;
  const teams = state.teams;
  if (!Array.isArray(teams)) return undefined;
  const target = String(sessionId);
  return teams.some(
    (team) => isRecord(team) && String(team.captainSessionId ?? "") === target,
  );
}

/**
 * R2.5 重放重建：整张 `pluginStates` 快照 → 本会话队长基准。
 * 无 agent-teams 状态键（从未推送 / 旧插件）→ undefined。键按身份+主题匹配
 * （不绑定官方 marketplace 字面量）。
 */
export function deriveCoordinatorBasisFromPluginStates(
  pluginStates: Record<string, unknown> | null | undefined,
  sessionId: SessionId | string,
): boolean | undefined {
  if (!isRecord(pluginStates)) return undefined;
  const stateKey = findAgentTeamsPluginStateKey(pluginStates);
  if (stateKey === undefined) return undefined;
  return deriveCoordinatorBasisFromPluginState(pluginStates[stateKey], sessionId);
}