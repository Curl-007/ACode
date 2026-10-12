import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runTasksDatabaseMigrations,
  applyTaskDatabaseMigration,
} from "#src/session/tasksDatabase/migrations.js";

test("未知迁移 ID 必须抛错，不得退回「执行最后一个迁移的 SQL」", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-unknown-migration-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    // 先跑出完整 schema，再确认未知 ID 既不写账本也不建表——旧写法会拿 0005 的
    // PROMPT_SNIPPETS_MIGRATION_SQL 当兜底（全是 CREATE TABLE IF NOT EXISTS，静默 no-op）。
    runTasksDatabaseMigrations(db);
    const before = db
      .prepare("SELECT count(*) AS n FROM tasks_schema_migration")
      .get() as unknown as { n: number };
    // 故意传未实现的 ID：类型层已被 default 分支的穷尽性检查拦住，这里用 cast 模拟
    // 「账本里有本构建不认识的 ID」——升级后回滚、或旧构建读到新账本时真实存在。
    const unknownId = "0006_not_implemented" as Parameters<typeof applyTaskDatabaseMigration>[1];
    assert.throws(
      () => applyTaskDatabaseMigration(db, unknownId),
      /Unimplemented task database migration: 0006_not_implemented/,
    );
    const after = db
      .prepare("SELECT count(*) AS n FROM tasks_schema_migration")
      .get() as unknown as { n: number };
    assert.equal(after.n, before.n, "未知迁移不得写账本");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("迁移 0005_prompt_snippets 落账本并建出两张表，且二次执行幂等", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-migration-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    runTasksDatabaseMigrations(db);
    const ledger = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
      .all() as unknown as Array<{ id: string }>;
    assert.equal(
      ledger.some((row) => row.id === "0005_prompt_snippets"),
      true,
      "账本里必须有 0005_prompt_snippets",
    );
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('snippets','builtin_snippet_usage') ORDER BY name",
      )
      .all() as unknown as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((row) => row.name),
      ["builtin_snippet_usage", "snippets"],
    );
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_snippets_workspace_use','idx_snippets_workspace_name') ORDER BY name",
      )
      .all() as unknown as Array<{ name: string }>;
    assert.deepEqual(
      indexes.map((row) => row.name),
      ["idx_snippets_workspace_name", "idx_snippets_workspace_use"],
    );
    // checksum 短路：第二次执行不报错、不重复插入。
    runTasksDatabaseMigrations(db);
    const count = db
      .prepare("SELECT count(*) AS n FROM tasks_schema_migration WHERE id='0005_prompt_snippets'")
      .get() as unknown as { n: number };
    assert.equal(count.n, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("唯一索引拒绝同 workspace 的同名片段（忽略大小写与首尾空白）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snippets-unique-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    runTasksDatabaseMigrations(db);
    const insert = db.prepare(
      `INSERT INTO snippets
       (snippet_id, workspace_key, name, category, content, kind, use_count, last_used_at, created_at, updated_at)
       VALUES (?, ?, ?, '', 'c', 'prompt', 0, NULL, 1, 1)`,
    );
    insert.run("snp_a", "/ws", "Code Review");
    assert.throws(() => insert.run("snp_b", "/ws", "  code review  "));
    // 不同工作区同名允许。
    insert.run("snp_c", "/ws2", "Code Review");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
