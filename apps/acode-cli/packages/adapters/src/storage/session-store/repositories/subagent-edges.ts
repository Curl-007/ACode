import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@acode/contracts";
import { touchSession } from "./sessions.js";

// 编排方案 Phase 1（specs/subagent-topology-persistence.md R2/R4/R5）：agent 拓扑边的
// SQLite 行存储。纯函数 + db 第一参（swarm-plans.ts 先例形状）；行是标量列，status
// 词表校验在 core 派生层（edge-persistence.ts R9）做，本层只搬运字节。
//
// 终态 first-wins（R2）用 SQL 的 `on conflict … where` 守卫表达，不留读-改-写窗口：
// 与 runtime-task registry 的终态纪律（specs/subagent-terminal-first-wins.md）同一条
// 裁决的两个投影面。spawn 重臂（R2）走无条件 upsert——resume 复用同一 agentId 是合法
// 的新生命，对齐 registry register() 的重臂语义。

/** subagent_edge 行的读出形状（列名原样 snake_case；消费侧防御性读取）。 */
export interface SubagentEdgeRow {
  agent_id: string;
  parent_session_id: string;
  child_session_id: string | null;
  agent_type: string | null;
  parent_tool_call_id: string | null;
  description: string | null;
  background: number;
  model: string | null;
  output_file: string | null;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  total_tokens: number | null;
  error: string | null;
}

export interface SubagentEdgeUpsertInput {
  agentId: string;
  agentType?: string | null;
  background?: boolean;
  childSessionId?: string | null;
  description?: string | null;
  endedAt?: number | null;
  error?: string | null;
  model?: string | null;
  outputFile?: string | null;
  parentSessionId: SessionId;
  parentToolCallId?: string | null;
  startedAt?: number | null;
  status: string;
  totalTokens?: number | null;
}

export interface SubagentEdgeSettleInput {
  agentId: string;
  background?: boolean;
  childSessionId?: string | null;
  endedAt: number;
  error?: string | null;
  outputFile?: string | null;
  parentSessionId: SessionId;
  status: string;
  totalTokens?: number | null;
}

/** spawn / 重臂：插入或整行重置（终态字段一并清空，R2）。 */
export async function upsertSubagentEdge(
  db: DatabaseSync,
  input: SubagentEdgeUpsertInput,
): Promise<void> {
  const now = Date.now();
  db.prepare(
    `
    insert into subagent_edge (
      agent_id, parent_session_id, child_session_id, agent_type, parent_tool_call_id,
      description, background, model, output_file, status, started_at, ended_at,
      total_tokens, error
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(agent_id) do update set
      parent_session_id = excluded.parent_session_id,
      child_session_id = excluded.child_session_id,
      agent_type = excluded.agent_type,
      parent_tool_call_id = excluded.parent_tool_call_id,
      description = excluded.description,
      background = excluded.background,
      model = excluded.model,
      output_file = excluded.output_file,
      status = excluded.status,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      total_tokens = excluded.total_tokens,
      error = excluded.error
    `,
  ).run(
    input.agentId,
    input.parentSessionId,
    input.childSessionId ?? null,
    input.agentType ?? null,
    input.parentToolCallId ?? null,
    input.description ?? null,
    input.background === true ? 1 : 0,
    input.model ?? null,
    input.outputFile ?? null,
    input.status,
    input.startedAt ?? null,
    input.endedAt ?? null,
    input.totalTokens ?? null,
    input.error ?? null,
  );
  touchSession(db, input.parentSessionId, now);
}

/**
 * 终态结算（first-wins，R2）：行存在且已是终态 → 拒绝覆盖，返回 false；行存在且
 * running → 更新终态字段；行缺失（spawn 边写入曾失败）→ 直插终态行，started_at
 * 诚实置 NULL（不可知）。计量/输出/子会话 id 用 coalesce 保留既有非空值。
 */
export async function settleSubagentEdge(
  db: DatabaseSync,
  input: SubagentEdgeSettleInput,
): Promise<boolean> {
  const result = db
    .prepare(
      `
    insert into subagent_edge (
      agent_id, parent_session_id, child_session_id, background, output_file,
      status, started_at, ended_at, total_tokens, error
    )
    values (?, ?, ?, ?, ?, ?, null, ?, ?, ?)
    on conflict(agent_id) do update set
      status = excluded.status,
      ended_at = excluded.ended_at,
      total_tokens = coalesce(excluded.total_tokens, subagent_edge.total_tokens),
      error = excluded.error,
      output_file = coalesce(excluded.output_file, subagent_edge.output_file),
      child_session_id = coalesce(excluded.child_session_id, subagent_edge.child_session_id)
    where subagent_edge.status = 'running'
    `,
    )
    .run(
      input.agentId,
      input.parentSessionId,
      input.childSessionId ?? null,
      input.background === true ? 1 : 0,
      input.outputFile ?? null,
      input.status,
      input.endedAt,
      input.totalTokens ?? null,
      input.error ?? null,
    );
  const applied = Number(result.changes) > 0;
  if (applied) touchSession(db, input.parentSessionId, Date.now());
  return applied;
}

/** 按父会话列边（读侧合成 / 审计）。 */
export async function listSubagentEdges(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<SubagentEdgeRow[]> {
  return db
    .prepare(
      `select * from subagent_edge where parent_session_id = ?
       order by coalesce(started_at, 0) asc, agent_id asc`,
    )
    .all(input.sessionID) as unknown as SubagentEdgeRow[];
}

/**
 * 整棵子树（Codex list_thread_spawn_descendants 对位物）：沿
 * parent_session_id → child_session_id 递归展开。depth 上限 32 + 外层 limit 是
 * 腐坏行成环时的止损（当前硬深度 1 下树只有一层；未来放开嵌套时 maxDepth 另有闸）。
 */
export async function listSubagentDescendants(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<Array<SubagentEdgeRow & { depth: number }>> {
  return db
    .prepare(
      `
    with recursive tree as (
      select e.*, 1 as depth from subagent_edge e where e.parent_session_id = ?
      union all
      select e.*, t.depth + 1
      from subagent_edge e
      join tree t on e.parent_session_id = t.child_session_id
      where t.depth < 32
    )
    select * from tree order by depth asc, coalesce(started_at, 0) asc, agent_id asc
    limit 4096
    `,
    )
    .all(input.sessionID) as unknown as Array<SubagentEdgeRow & { depth: number }>;
}

/**
 * resume 收敛（R4）：把该父会话残留的 running 边一次性收口为 lost——崩溃后后台子
 * 进程已死、真实终态不可知，诚实标注而非留假 running。只动 running（幂等；终态行
 * 不可触碰，first-wins 纪律的收敛面延伸）。不 touchSession：resume 本身会触会话。
 */
export async function convergeNonTerminalSubagentEdges(
  db: DatabaseSync,
  input: { now?: number; sessionID: SessionId },
): Promise<number> {
  const result = db
    .prepare(
      `update subagent_edge
       set status = 'lost', ended_at = ?, error = 'session_resumed'
       where parent_session_id = ? and status = 'running'`,
    )
    .run(input.now ?? Date.now(), input.sessionID);
  return Number(result.changes);
}
