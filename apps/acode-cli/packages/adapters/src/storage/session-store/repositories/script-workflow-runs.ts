import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CreateScriptWorkflowRunInput,
  RecordScriptWorkflowActivityUsageInput,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStats,
  ScriptWorkflowRunStatus,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowRunInput,
} from "@acode/contracts";
import { encodeJson } from "../json.js";
import {
  decodeDefinition,
  decodeRun,
  type WorkflowDefinitionRow,
  type WorkflowRunRow,
} from "./script-workflow-codecs.js";
import { isWorkflowSessionOwner } from "./workflow-run-owner.js";

export async function upsertScriptWorkflowDefinition(
  db: DatabaseSync,
  input: UpsertScriptWorkflowDefinitionInput,
): Promise<ScriptWorkflowDefinitionRecord> {
  const now = Date.now();
  db.prepare(
    `
      insert into workflow_definition (
        id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        source = excluded.source,
        scope = excluded.scope,
        trusted = excluded.trusted,
        enabled = excluded.enabled,
        script_path = excluded.script_path,
        script_hash = excluded.script_hash,
        meta_json = excluded.meta_json,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.name,
    input.source,
    input.scope ?? (input.source === "builtin" ? "builtin" : "explicit"),
    input.trusted === true ? 1 : 0,
    input.enabled === false ? 0 : 1,
    input.scriptPath ?? null,
    input.scriptHash,
    JSON.stringify(input.meta),
    now,
    now,
  );
  return mustGetDefinition(db, input.id);
}

export async function createScriptWorkflowRun(
  db: DatabaseSync,
  input: CreateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  const now = Date.now();
  db.prepare(
    `
      insert into workflow_run (
        id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash,
        args_json, args_hash, status, current_phase, budget_total, budget_spent,
        stats_json, failure_json, result_json, time_created, time_started, time_updated, time_completed,
        tool_call_id, workspace_identity, remote_session_id, owner_token, owner_generation
      ) values (?, ?, ?, 'script', ?, ?, ?, ?, ?, ?, ?, null, ?, 0, ?, null, null, ?, null, ?, null, ?, ?, ?, ?, ?)
      `,
  ).run(
    input.id,
    input.definitionId ?? null,
    input.name,
    input.parentSessionId ?? null,
    input.cwd,
    input.scriptPath ?? null,
    input.scriptHash,
    encodeJson(input.args),
    input.argsHash ?? null,
    input.status ?? "pending",
    input.budgetTotal ?? null,
    encodeJson(input.stats),
    now,
    now,
    input.toolCallId ?? null,
    input.workspaceIdentity ?? null,
    input.remoteSessionId ?? null,
    input.ownerToken ?? null,
    input.ownerGeneration ?? null,
  );
  return mustGetRun(db, input.id);
}

export async function updateScriptWorkflowRun(
  db: DatabaseSync,
  input: UpdateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  // 元数据更新不能把 await 前读到的统计写回：phase/status 与 activity 入账可以并发，
  // 全列覆写会丢掉刚提交的真实用量。这里只写调用方显式拥有的字段。
  const columns: string[] = ["time_updated = ?"];
  const values: SQLInputValue[] = [Date.now()];
  const setColumn = (column: string, value: SQLInputValue): void => {
    columns.push(`${column} = ?`);
    values.push(value);
  };
  if (input.status !== undefined) setColumn("status", input.status);
  if (input.currentPhase !== undefined) setColumn("current_phase", input.currentPhase);
  if (input.budgetSpent !== undefined) setColumn("budget_spent", input.budgetSpent);
  if (input.stats !== undefined) setColumn("stats_json", encodeJson(input.stats));
  if (input.failure !== undefined) setColumn("failure_json", encodeJson(input.failure));
  if (input.result !== undefined) setColumn("result_json", encodeJson(input.result));
  if (input.startedAt !== undefined) setColumn("time_started", input.startedAt);
  if (input.completedAt !== undefined) setColumn("time_completed", input.completedAt);
  const ownerWhere =
    input.ownerToken !== undefined && input.ownerGeneration !== undefined
      && input.ownerTakeover !== true
      ? " and owner_token = ? and owner_generation = ?"
      : "";
  if (
    input.ownerTakeover === true &&
    input.ownerToken !== undefined &&
    input.ownerGeneration !== undefined
  ) {
    const current = db
      .prepare("select parent_session_id from workflow_run where id = ?")
      .get(input.id) as { parent_session_id: string | null } | undefined;
    if (
      !current?.parent_session_id ||
      !isWorkflowSessionOwner(db, {
        parentSessionId: current.parent_session_id,
        ownerToken: input.ownerToken,
        ownerGeneration: input.ownerGeneration,
      })
    ) {
      throw new Error(`Stale workflow owner takeover rejected: ${input.id}`);
    }
  }
  const takeoverValues: SQLInputValue[] =
    input.ownerTakeover === true &&
    input.ownerToken !== undefined &&
    input.ownerGeneration !== undefined
      ? [input.ownerToken, input.ownerGeneration]
      : [];
  const takeoverColumns = takeoverValues.length > 0 ? ", owner_token = ?, owner_generation = ?" : "";
  const ownerWhereValues: SQLInputValue[] = ownerWhere
    ? [input.ownerToken!, input.ownerGeneration!]
    : [];
  const result = db
    .prepare(`update workflow_run set ${columns.join(", ")}${takeoverColumns} where id = ?${ownerWhere}`)
    .run(
      ...values,
      ...takeoverValues,
      input.id,
      ...ownerWhereValues,
    );
  if (ownerWhere && result.changes === 0) {
    throw new Error(`Stale workflow owner write rejected: ${input.id}`);
  }
  return mustGetRun(db, input.id);
}

/** 同一事务提交 run 累计值和 activity 用量事件，避免中途失败或重启重试时重复计数。 */
export async function recordScriptWorkflowActivityUsage(
  db: DatabaseSync,
  input: RecordScriptWorkflowActivityUsageInput,
): Promise<ScriptWorkflowRunRecord> {
  db.exec("begin immediate");
  try {
    const activity = db
      .prepare("select id from workflow_activity where id = ? and run_id = ?")
      .get(input.activityId, input.runId);
    if (!activity) throw new Error(`Workflow activity does not belong to run: ${input.activityId}`);
    const existing = db
      .prepare(
        `select id from workflow_event
         where run_id = ? and type = 'workflow_usage' and activity_id = ?
         limit 1`,
      )
      .get(input.runId, input.activityId) as { id: string } | undefined;
    const current = getRunSync(db, input.runId);
    if (!current) throw new Error(`Workflow run not found: ${input.runId}`);
    if (existing) {
      db.exec("commit");
      return current;
    }

    const stats = mergeStats(current.stats ?? emptyStats(), input.delta);
    const spentTokens = current.budgetSpent + input.delta.tokens.total;
    const now = Date.now();
    db.prepare(
      `update workflow_run set
           budget_spent = ?, stats_json = ?, time_updated = ?
         where id = ?${
           input.ownerToken !== undefined && input.ownerGeneration !== undefined
             ? " and owner_token = ? and owner_generation = ?"
             : ""
         }`,
    ).run(
      spentTokens,
      encodeJson(stats),
      now,
      input.runId,
      ...(input.ownerToken !== undefined && input.ownerGeneration !== undefined
        ? [input.ownerToken, input.ownerGeneration]
        : []),
    );
    if (input.ownerToken !== undefined && input.ownerGeneration !== undefined) {
      const ownerRow = db
        .prepare("select changes() as changes")
        .get() as { changes: number } | undefined;
      if (!ownerRow || ownerRow.changes === 0) throw new Error(`Stale workflow owner write rejected: ${input.runId}`);
    }
    const sequenceRow = db
      .prepare(
        "select coalesce(max(sequence), 0) + 1 as next_sequence from workflow_event where run_id = ?",
      )
      .get(input.runId) as { next_sequence: number } | undefined;
    const sequence = sequenceRow?.next_sequence ?? 1;
    db.prepare(
      `insert into workflow_event (
           id, run_id, sequence, type, phase, activity_id, payload_json, time_created
         ) values (?, ?, ?, 'workflow_usage', null, ?, ?, ?)`,
    ).run(input.eventId, input.runId, sequence, input.activityId, encodeJson({ spentTokens }), now);
    db.exec("commit");
    return mustGetRun(db, input.runId);
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}

export async function getScriptWorkflowRun(
  db: DatabaseSync,
  runId: string,
): Promise<ScriptWorkflowRunRecord | null> {
  const row = db.prepare("select * from workflow_run where id = ?").get(runId) as
    | WorkflowRunRow
    | undefined;
  return row ? decodeRun(row) : null;
}

export async function listScriptWorkflowRuns(
  db: DatabaseSync,
  input: {
    cwd?: string;
    limit?: number;
    /**
     * 按发起会话过滤。冷回放必须是会话作用域的——`workflowRuns` 投影按会话物化，
     * 把别的会话的 run 回放进来等于让一个会话看见另一个会话的工作流。
     * 此前只有 `cwd`，而一个项目目录会被许多会话共用，顶不掉这个作用域。
     */
    parentSessionId?: string;
    statuses?: readonly ScriptWorkflowRunStatus[];
  } = {},
): Promise<ScriptWorkflowRunRecord[]> {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (input.cwd) {
    clauses.push("cwd = ?");
    values.push(input.cwd);
  }
  if (input.parentSessionId) {
    clauses.push("parent_session_id = ?");
    values.push(input.parentSessionId);
  }
  if (input.statuses && input.statuses.length > 0) {
    clauses.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
    values.push(...input.statuses);
  }
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  if (limit !== undefined) values.push(limit);
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitSql = limit === undefined ? "" : " limit ?";
  const rows = db
    .prepare(`select * from workflow_run ${where} order by time_updated desc, id desc${limitSql}`)
    .all(...values) as unknown as WorkflowRunRow[];
  return rows.map(decodeRun);
}

async function mustGetDefinition(
  db: DatabaseSync,
  definitionId: string,
): Promise<ScriptWorkflowDefinitionRecord> {
  const row = db.prepare("select * from workflow_definition where id = ?").get(definitionId) as
    | WorkflowDefinitionRow
    | undefined;
  if (!row) throw new Error(`Workflow definition not found after write: ${definitionId}`);
  return decodeDefinition(row);
}

async function mustGetRun(db: DatabaseSync, runId: string): Promise<ScriptWorkflowRunRecord> {
  const run = await getScriptWorkflowRun(db, runId);
  if (!run) throw new Error(`Workflow run not found after write: ${runId}`);
  return run;
}

function getRunSync(db: DatabaseSync, runId: string): ScriptWorkflowRunRecord | null {
  const row = db.prepare("select * from workflow_run where id = ?").get(runId) as
    | WorkflowRunRow
    | undefined;
  return row ? decodeRun(row) : null;
}

function emptyStats(): ScriptWorkflowRunStats {
  return {
    agentCalls: 0,
    cachedAgentCalls: 0,
    failedAgentCalls: 0,
    toolCalls: 0,
    tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0, total: 0 },
  };
}

function mergeStats(
  current: ScriptWorkflowRunStats,
  delta: ScriptWorkflowRunStats,
): ScriptWorkflowRunStats {
  return {
    agentCalls: current.agentCalls + delta.agentCalls,
    cachedAgentCalls: current.cachedAgentCalls + delta.cachedAgentCalls,
    failedAgentCalls: current.failedAgentCalls + delta.failedAgentCalls,
    toolCalls: current.toolCalls + delta.toolCalls,
    tokens: {
      cacheRead: current.tokens.cacheRead + delta.tokens.cacheRead,
      cacheWrite: current.tokens.cacheWrite + delta.tokens.cacheWrite,
      input: current.tokens.input + delta.tokens.input,
      output: current.tokens.output + delta.tokens.output,
      reasoning: current.tokens.reasoning + delta.tokens.reasoning,
      total: current.tokens.total + delta.tokens.total,
    },
  };
}
