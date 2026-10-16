// ============================================================
// Fleet Projection - ListSessions 行投影（权限信息最小化）
// (apps/acode-cli/specs/session-fleet.md R3/R9)
// ============================================================
// 列表作用域本身最小化：只有「调用方自身行 + 调用方所有的舰队行」两类，
// permissionMode 只出现在这两类行上——结构上不存在第三类行可泄漏。

import type { CollaborationMode, SessionId } from "@acode/contracts";
import type { FleetPermissionMode, FleetSessionStatus, ListSessionsRow } from "@acode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/contract.js";
import { isTerminalRuntimeTask } from "../runtime-task/contract.js";
import type { FleetSessionRecord } from "./registry.js";

const REQUESTABLE_MODES: readonly string[] = ["plan", "build", "edit", "yolo"];

/** auto 是内部档，不投影进模型面（行上 permission_mode 缺席）。 */
export function projectFleetPermissionMode(
  mode: CollaborationMode,
): FleetPermissionMode | undefined {
  return REQUESTABLE_MODES.includes(mode) ? (mode as FleetPermissionMode) : undefined;
}

export function projectFleetSessionStatus(
  record: FleetSessionRecord,
  runtimeTaskRegistry: RuntimeTaskRegistry | undefined,
): FleetSessionStatus {
  if (record.archived) return "archived";
  const task = runtimeTaskRegistry?.get(record.agentId);
  if (!task) return "lost"; // 条目消失而记录仍在 = 进程级异常，诚实报 lost
  if (!isTerminalRuntimeTask(task)) return "running";
  return task.status as FleetSessionStatus;
}

export interface FleetListProjectionInput {
  callerSessionId: SessionId;
  callerMode: CollaborationMode;
  records: readonly FleetSessionRecord[];
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

/** self 行恒 running（调用方正在这个回合里）；舰队行按 runtime-task 投影。 */
export function buildFleetListRows(input: FleetListProjectionInput): ListSessionsRow[] {
  const selfMode = projectFleetPermissionMode(input.callerMode);
  const selfRow: ListSessionsRow = {
    session_id: String(input.callerSessionId),
    kind: "self",
    title: "current session (you)",
    status: "running",
    ...(selfMode === undefined ? {} : { permission_mode: selfMode }),
  };
  const fleetRows = input.records.map((record) => {
    const mode = projectFleetPermissionMode(record.mode);
    return {
      session_id: String(record.sessionId),
      kind: "fleet" as const,
      title: record.title,
      status: projectFleetSessionStatus(record, input.runtimeTaskRegistry),
      ...(mode === undefined ? {} : { permission_mode: mode }),
      started_at: new Date(record.startedAt).toISOString(),
      last_activity: new Date(record.lastActivityAt).toISOString(),
      task_id: record.agentId,
      ...(record.worktree ? { worktree_path: record.worktree.path } : {}),
      ...(record.latestNote ? { latest_note: record.latestNote.text } : {}),
    } satisfies ListSessionsRow;
  });
  return [selfRow, ...fleetRows];
}
