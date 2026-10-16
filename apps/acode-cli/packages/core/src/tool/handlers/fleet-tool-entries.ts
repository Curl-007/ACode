// ============================================================
// 会话舰队工具族清单
// ============================================================
// 从 index.ts 的 builtInTools 抽出（架构 ratchet 单文件 ≤400 行，与 dwf 工具族
// 抽出手法同款）：族成员、顺序与注释逐字保留，index.ts 以展开方式在原位置消费——
// 注册顺序与 registerBuiltInTools 过滤链语义不变。

import type { ToolEntry } from "../types.js";
import { startSessionToolEntry } from "./start-session.js";
import { sendToSessionToolEntry } from "./send-to-session.js";
import { listSessionsToolEntry } from "./list-sessions.js";
import { handOffToSessionToolEntry } from "./hand-off-to-session.js";
import { setSessionPermissionModeToolEntry } from "./set-session-permission-mode.js";
import { archiveSessionToolEntry } from "./archive-session.js";
import { deleteSessionsToolEntry } from "./delete-sessions.js";

export const fleetToolEntries: ToolEntry[] = [
  // 会话舰队（specs/session-fleet.md R1）：无注册门——对任何会话自洽，端口缺席由
  // handler fail-closed（接线故障 throw / 业务边界闭集拒绝），worktree 三工具同款。
  // 变更面在 automation/off-peak 派发轮双层收敛：handler 守卫拒绝（unattended_turn）
  // + turn-loop-state FLEET_MUTATION_TOOL_NAMES 隐藏名单（spec R1 纵深防御，已接线）。
  // 所有权封闭（R3）保证多会话进程（桌面 host）里各 transcript 只见自己的舰队。
  startSessionToolEntry,
  sendToSessionToolEntry,
  listSessionsToolEntry,
  handOffToSessionToolEntry,
  setSessionPermissionModeToolEntry,
  archiveSessionToolEntry,
  deleteSessionsToolEntry,
];
