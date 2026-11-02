// ============================================================
// 宿主团队唤醒的宿主侧派生（apps/acode-cli/specs/host-team-wake.md R4/R8/R9）
// ============================================================
// 状态所有者：插件（权威：TeamState.wakeSeq / mailbox / 任务终态）
//   → 插件面板快照 wakePending（additive 窄投影，R1）
//   → adapter（pluginId 权威注入，不解释内容）
//   → 本模块：从插件状态通知 / 重放的 PluginStateUpdated 解析规范化 intent，
//     只把 intent 交给**队长会话**的 runtime（applyTeamWakeIntent）。
// 通道 = 既有 `acode-plugin-state:` MCP logging 通知（R0 选项 b），
// 不建文件 watcher、不读插件磁盘布局、不落第二份编排台账（EI-48）。
//
// 路由：一个 App 只持有自己会话的 runtime；插件通知按工作区广播给共享同一 MCP 连接的
// 所有会话。`lookupRuntime(captainSessionId)` 只在「本会话就是队长」时返回 runtime，
// 非队长会话因此天然不注入（不另起 Agent / Host / 会话，§8 第 6 条）。

import {
  AGENT_TEAMS_PLUGIN_STATE_TOPIC,
  isAgentTeamsPluginId,
  parseTeamWakeIntents,
  type TeamWakeIntent,
} from "@acode/core";
import { SessionEventType } from "@acode/contracts";
import type { McpPluginStateNotification, SessionEvent } from "@acode/contracts";

/** 队长 runtime 的最小消费面（optional 成员先例：缺席 = 宿主未装配，不猜测）。 */
export interface TeamWakeRuntimeLike {
  applyTeamWakeIntent?: (intent: TeamWakeIntent) => void;
}

interface TeamWakeDispatchInput {
  /** 本 App 的会话 id；lookupRuntime 只在命中队长时才返回 runtime。 */
  sessionId: string;
  lookupRuntime: (captainSessionId: string) => TeamWakeRuntimeLike | undefined;
  /** 固定时钟注入（测试用 EI-121）；缺省 Date.now()。 */
  nowMs?: number;
}

/** 通知是否来自 agent-teams 状态通道（主题 + 插件身份，不绑定 marketplace 字面量）。 */
function isAgentTeamsStateNotification(notification: McpPluginStateNotification): boolean {
  return (
    notification.key === AGENT_TEAMS_PLUGIN_STATE_TOPIC && isAgentTeamsPluginId(notification.pluginId)
  );
}

/** 把 intent 交给队长 runtime；返回实际派发的 intent（诊断/测试观察面）。 */
function dispatchTeamWakeIntents(
  intents: readonly TeamWakeIntent[],
  input: TeamWakeDispatchInput,
): TeamWakeIntent[] {
  const dispatched: TeamWakeIntent[] = [];
  for (const intent of intents) {
    const runtime = input.lookupRuntime(intent.captainSessionId);
    if (!runtime?.applyTeamWakeIntent) continue;
    try {
      runtime.applyTeamWakeIntent(intent);
      dispatched.push(intent);
    } catch {
      // containment：派发失败不影响既有 PluginStateUpdated 事件桥接。
    }
  }
  return dispatched;
}

/**
 * 实时路径（R4）：插件状态通知到达即解析 wakePending → 派发 intent。
 * 未命中队长（队长已停止 / 非本会话）→ 不注入、不报错；消息留箱，投影面由 UI 依
 * 既有 sessionControl 派生 wakeHint（R8/R10，零协议新增）。
 */
export function applyTeamWakeFromNotification(input: {
  notification: McpPluginStateNotification;
  sessionId: string;
  enabled: boolean;
  lookupRuntime: (captainSessionId: string) => TeamWakeRuntimeLike | undefined;
  nowMs?: number;
}): TeamWakeIntent[] {
  if (!input.enabled) return [];
  if (!isAgentTeamsStateNotification(input.notification)) return [];
  const intents = parseTeamWakeIntents(input.notification.state, input.nowMs ?? Date.now());
  return dispatchTeamWakeIntents(intents, input);
}

/**
 * 会话恢复 / 重连（R9）：按重放的 PluginStateUpdated 事件取最后一条 agent-teams 状态，
 * 重新派生待唤醒。世代号（EI-59）+ 宿主内存 ack 约束下至多再注入一次；邮箱已读的
 * 快照 → wakePending 触发集空 → 无注入（emptiness guard）。不新增持久化面。
 */
export function redispatchTeamWakeFromEvents(input: {
  events: readonly SessionEvent[];
  sessionId: string;
  enabled: boolean;
  lookupRuntime: (captainSessionId: string) => TeamWakeRuntimeLike | undefined;
  nowMs?: number;
}): TeamWakeIntent[] {
  if (!input.enabled) return [];
  let lastState: unknown;
  let found = false;
  for (const event of input.events) {
    if (event.type !== SessionEventType.PluginStateUpdated) continue;
    const payload = event.payload as { pluginId?: unknown; key?: unknown; state?: unknown };
    if (typeof payload.pluginId !== "string" || !isAgentTeamsPluginId(payload.pluginId)) continue;
    if (payload.key !== AGENT_TEAMS_PLUGIN_STATE_TOPIC) continue;
    lastState = payload.state;
    found = true;
  }
  if (!found) return [];
  const intents = parseTeamWakeIntents(lastState, input.nowMs ?? Date.now());
  return dispatchTeamWakeIntents(intents, input);
}