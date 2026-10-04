import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@acode/contracts";
import { decodeJson } from "../json.js";
import { touchSession } from "./sessions.js";

// K2 对话内 Swarm 任务图 R6（specs/swarm-task-graph.md「未做与取舍」#5 附录）：plan 的
// SQLite 行存储——对齐 todo 链路的「每 session 一行（组）专用存储」形态，不是第二存储
// 引擎。行内容是 SwarmTaskPlan 的 JSON 序列化（schema 校验在 core plan-store 的 hydrate
// 边界做，本层只搬运字节：唯一写入路径纪律——写入的是调用方给的已提交快照）。
//
// 值类型刻意是 unknown：core 侧 duck-typing seam（swarm/runtime-binding.ts，K4 先例）
// 读出后经 SwarmTaskPlanSchema 校验才采用，坏行不静默进 runtime 状态面。

export async function readSwarmPlan(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<unknown> {
  const row = db
    .prepare("select plan_json from swarm_plan where session_id = ?")
    .get(input.sessionID) as { plan_json: string } | undefined;
  if (row === undefined) return null;
  return decodeJson(row.plan_json) ?? null;
}

export async function writeSwarmPlan(
  db: DatabaseSync,
  input: { plan: unknown; sessionID: SessionId },
): Promise<void> {
  const now = Date.now();
  db.prepare(
    `
    insert into swarm_plan (session_id, plan_json, time_created, time_updated)
    values (?, ?, ?, ?)
    on conflict(session_id) do update set
      plan_json = excluded.plan_json,
      time_updated = excluded.time_updated
    `,
  ).run(input.sessionID, JSON.stringify(input.plan), now, now);
  touchSession(db, input.sessionID, now);
}

export async function clearSwarmPlan(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<void> {
  db.prepare("delete from swarm_plan where session_id = ?").run(input.sessionID);
  touchSession(db, input.sessionID, Date.now());
}
