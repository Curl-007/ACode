// `queryAppUsage` 按日聚合 SQL 断言（apps/acode-cli/specs/usage-statusbar-port.md §3.4）。
//
// 状态栏「今日合计」明细依赖 model_usage 的按日 input/output/cacheRead/请求数四个分项；
// 这里只建查询实际读取的三张表——手写 schema 比跑全部迁移快，也不会因迁移演进变成假绿。

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { queryAppUsage } from "../src/storage/session-store/repositories/usage.js";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
const SINCE = NOW - 7 * DAY_MS;

function db(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    create table model_usage (
      id text primary key,
      session_id text not null,
      model_id text,
      status text not null,
      started_at integer not null,
      time_to_first_token_ms integer,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_creation_input_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0,
      computed_total_tokens integer not null default 0
    );
    create table turn_usage (
      session_id text not null,
      status text not null,
      started_at integer not null,
      duration_ms integer
    );
    create table tool_usage (
      tool_name text not null,
      status text not null,
      started_at integer not null,
      duration_ms integer
    );
  `);
  return database;
}

async function query(database: DatabaseSync) {
  return queryAppUsage(database, { since: SINCE, until: NOW, tzOffsetMs: 0 });
}

test("按日聚合带输入/输出/缓存读/请求数（状态栏「今日合计」分项）", async () => {
  const database = db();
  const insert = database.prepare(
    `insert into model_usage (
       id, session_id, status, started_at, computed_total_tokens,
       input_tokens, output_tokens, cache_read_input_tokens
     ) values (?, 's1', 'completed', ?, ?, ?, ?, ?)`,
  );
  insert.run("u1", NOW - DAY_MS + 1_000, 300, 120, 180, 100);
  insert.run("u2", NOW - DAY_MS + 2_000, 200, 80, 120, 60);
  const result = await query(database);
  assert.equal(result.days.length, 1);
  const day = result.days[0];
  assert.ok(day);
  assert.equal(day.totalTokens, 500);
  assert.equal(day.inputTokens, 200);
  assert.equal(day.outputTokens, 300);
  assert.equal(day.cacheReadTokens, 160);
  assert.equal(day.modelRequestCount, 2);
});

test("按日分桶不跨日合并（本地日偏移与 totals 同一过滤条件）", async () => {
  const database = db();
  const insert = database.prepare(
    `insert into model_usage (id, session_id, status, started_at, computed_total_tokens)
     values (?, 's1', 'completed', ?, ?)`,
  );
  insert.run("u1", NOW - DAY_MS + 1_000, 100);
  insert.run("u2", NOW - 2 * DAY_MS + 1_000, 200);
  const result = await query(database);
  assert.equal(result.days.length, 2);
  const buckets = [...result.days].sort((left, right) => left.dayIndex - right.dayIndex);
  assert.equal(buckets[0]?.totalTokens, 200);
  assert.equal(buckets[1]?.totalTokens, 100);
  assert.equal(buckets[1]?.modelRequestCount, 1);
  assert.equal(buckets[1]?.inputTokens, 0);
});
