// ============================================================
// 协调者只读预设的宿主侧派生（specs/coordinator-readonly-preset.md R2/R4/R5）
// ============================================================
// 状态所有者（spec「状态所有者与事件顺序」）：
//   插件（唯一权威：团队 JSON captainSessionId）
//     → adapter（pluginId 权威注入，不解释内容）
//     → 宿主会话：本模块从插件状态通知 / 重放的 PluginStateUpdated 派生队长基准
//       → setSessionCoordinatorBasis（core 会话级 store）
//       → PermissionContext.coordinatorReadOnly（两处构造点）
//       → PermissionService 2.5 判定 → deny rule.coordinator.readonly
//
// 只用一个安全事实字段 `state.teams[].captainSessionId`（R2.1）：不解插件业务状态、
// 不读插件私有磁盘布局、不落第二份编排台账（R8.4 / EI-48）。
//
// 逃生阀（R5）：唯一来源 = 插件 userConfig `captainReadOnly`（三级默认：显式配置 >
// 持久值 > 硬编码 true）。判定不可得绝不自动回退到逃生阀（R5.1 / EI-149）。

import {
  AGENT_TEAMS_PLUGIN_STATE_TOPIC,
  deriveCoordinatorBasisFromPluginState,
  isAgentTeamsPluginId,
  setSessionCoordinatorBasis,
} from "@acode/core";
import { SessionEventType } from "@acode/contracts";
import type {
  McpPluginStateNotification,
  PluginMetadata,
  SessionEvent,
} from "@acode/contracts";

const AGENT_TEAMS_PLUGIN_NAME = "agent-teams";

/**
 * R5.1 逃生阀判定：读插件 userConfig `captainReadOnly`（经配置面展开的 configuredOptions）。
 * 仅**用户显式关闭**（=== false）才放开；缺席（未配置）按硬编码回落 true = 施加预设。
 * 不新增环境变量（R5.4）。
 */
export function resolveCaptainReadOnlyEnabled(
  plugins: readonly PluginMetadata[] | undefined,
): boolean {
  const plugin = plugins?.find((item) => item.name === AGENT_TEAMS_PLUGIN_NAME);
  return plugin?.configuredOptions?.captainReadOnly !== false;
}

/** 通知是否来自 agent-teams 状态通道：主题匹配 + 插件身份匹配（不绑定 marketplace 字面量）。 */
function isAgentTeamsStateNotification(notification: McpPluginStateNotification): boolean {
  return (
    notification.key === AGENT_TEAMS_PLUGIN_STATE_TOPIC &&
    isAgentTeamsPluginId(notification.pluginId)
  );
}

/**
 * 实时路径（R2.2/R2.3/R2.4）：插件状态通知到达即派生并写入本会话基准。
 * 逃生阀放开（enabled=false）时不施加；调用方仍照旧落 PluginStateUpdated 会话事件
 * （本函数只负责派生写路径，不改动既有事件桥接）。
 */
export function applyCoordinatorBasisFromNotification(input: {
  notification: McpPluginStateNotification;
  sessionId: string;
  enabled: boolean;
}): void {
  if (!input.enabled) return;
  if (!isAgentTeamsStateNotification(input.notification)) return;
  setSessionCoordinatorBasis(
    input.sessionId,
    deriveCoordinatorBasisFromPluginState(input.notification.state, input.sessionId),
  );
}

/**
 * 会话恢复 / 重连（R2.5 / Q3）：按重放的 PluginStateUpdated 事件重建基准，取最后一条
 * agent-teams 状态。不新增持久化面——重放流为空时基准维持（R4.1 粘性局限已登记 Q3）。
 */
export function rebuildCoordinatorBasisFromEvents(input: {
  events: readonly SessionEvent[];
  sessionId: string;
  enabled: boolean;
}): void {
  if (!input.enabled) return;
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
  if (!found) return;
  setSessionCoordinatorBasis(
    input.sessionId,
    deriveCoordinatorBasisFromPluginState(lastState, input.sessionId),
  );
}