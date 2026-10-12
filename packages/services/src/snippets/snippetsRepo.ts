import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY,
  PROMPT_SNIPPET_MAX_USE_COUNT,
  type PromptSnippet,
  type PromptSnippetKind,
} from "@acode/shared";
import type { PromptSnippetBuiltinUsageEntry } from "./snippets.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface SnippetRow {
  snippet_id: string;
  workspace_key: string;
  name: string;
  category: string;
  content: string;
  kind: string;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSnippet(row: SnippetRow): PromptSnippet {
  return {
    snippetId: row.snippet_id,
    workspaceKey: row.workspace_key,
    name: row.name,
    category: row.category,
    content: row.content,
    kind: row.kind === "suffix" ? "suffix" : "prompt",
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SnippetWriteRow {
  snippetId: string;
  workspaceKey: string;
  name: string;
  category: string;
  content: string;
  kind: PromptSnippetKind;
  now: number;
}

/**
 * 片段的 SQLite 读写。
 *
 * 与 `TaskIndexRepo` 共库（`tasks-index.sqlite`）但**独立连接**：任务索引连接带
 * `PRAGMA foreign_keys = ON`，而片段表无外键依赖；独立连接避免与任务索引的长事务争锁。
 * 迁移 runner 有 checksum 短路，同库多连接各自调用是幂等的。
 */
export class SnippetsRepo {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}

  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  getDatabasePath(): string {
    return this.dbPath ?? this.startupDbPath ?? getTasksIndexDatabasePath();
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // 关闭失败不覆盖真正的调用错误。
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    runTasksDatabaseMigrations(this.getDatabase());
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("SnippetsRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  /** 当前 workspaceKey 可见的片段：本工作区 + `__global__`。排序由调用方统一投影。 */
  async listVisible(workspaceKey: string): Promise<PromptSnippet[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM snippets
         WHERE workspace_key = ? OR workspace_key = ?
         ORDER BY use_count DESC, COALESCE(last_used_at, 0) DESC, name ASC, snippet_id ASC`,
      )
      .all(workspaceKey, PROMPT_SNIPPET_GLOBAL_WORKSPACE_KEY) as unknown as SnippetRow[];
    return rows.map(rowToSnippet);
  }

  async findById(snippetId: string): Promise<PromptSnippet | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare("SELECT * FROM snippets WHERE snippet_id = ?")
      .get(snippetId) as unknown as SnippetRow | undefined;
    return row ? rowToSnippet(row) : null;
  }

  /**
   * 按 `(workspace_key, lower(trim(name)))` 查重。命中时返回既有行，供 Service 报同名错误。
   * 唯一索引是最终防线，这里的查询只用于给出明确错误而不是 SQLite 约束异常。
   */
  async findByNameKey(workspaceKey: string, nameKey: string): Promise<PromptSnippet | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM snippets
         WHERE workspace_key = ? AND lower(trim(name)) = ?
         LIMIT 1`,
      )
      .get(workspaceKey, nameKey) as unknown as SnippetRow | undefined;
    return row ? rowToSnippet(row) : null;
  }

  async insert(row: SnippetWriteRow): Promise<PromptSnippet> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `INSERT INTO snippets
         (snippet_id, workspace_key, name, category, content, kind, use_count, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(
        row.snippetId,
        row.workspaceKey,
        row.name,
        row.category,
        row.content,
        row.kind,
        row.now,
        row.now,
      );
    const created = await this.findById(row.snippetId);
    if (!created) {
      throw new Error("片段写入后读取失败");
    }
    return created;
  }

  /**
   * 更新内容字段。SQL 刻意**不含** `use_count` / `last_used_at`：
   * 编辑片段改名不能让使用次数归零（验收 F23）。
   */
  async update(row: SnippetWriteRow): Promise<PromptSnippet | null> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `UPDATE snippets
         SET name = ?, category = ?, content = ?, kind = ?, updated_at = ?
         WHERE snippet_id = ?`,
      )
      .run(row.name, row.category, row.content, row.kind, row.now, row.snippetId);
    if (result.changes === 0) {
      return null;
    }
    return this.findById(row.snippetId);
  }

  /** 不存在时影响 0 行，不报错（幂等删除）。 */
  async deleteById(snippetId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase().prepare("DELETE FROM snippets WHERE snippet_id = ?").run(snippetId);
  }

  /**
   * 计数自增。`use_count < 上限` 才自增，`last_used_at` 始终更新。
   * 用 SQL 内自增而不是读改写，避免多窗口同时插入丢计数（验收 E14）。
   */
  async incrementUseCount(snippetId: string, now: number): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE snippets
         SET use_count = use_count + 1, last_used_at = ?
         WHERE snippet_id = ? AND use_count < ?`,
      )
      .run(now, snippetId, PROMPT_SNIPPET_MAX_USE_COUNT);
    // 达到上限后上面的 UPDATE 不命中；仍需刷新 last_used_at（产品规则 §3.5）。
    this.getDatabase()
      .prepare("UPDATE snippets SET last_used_at = ? WHERE snippet_id = ? AND use_count >= ?")
      .run(now, snippetId, PROMPT_SNIPPET_MAX_USE_COUNT);
  }

  /** 内置条目计数（独立表，孤儿行无害）。 */
  async incrementBuiltinUseCount(snippetId: string, now: number): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `INSERT INTO builtin_snippet_usage (snippet_id, use_count, last_used_at)
         VALUES (?, 1, ?)
         ON CONFLICT(snippet_id) DO UPDATE SET
           use_count = CASE
             WHEN builtin_snippet_usage.use_count < ${PROMPT_SNIPPET_MAX_USE_COUNT}
               THEN builtin_snippet_usage.use_count + 1
             ELSE builtin_snippet_usage.use_count
           END,
           last_used_at = excluded.last_used_at`,
      )
      .run(snippetId, now);
  }

  async listBuiltinUsage(): Promise<PromptSnippetBuiltinUsageEntry[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT snippet_id, use_count, last_used_at FROM builtin_snippet_usage")
      .all() as unknown as Array<{
      snippet_id: string;
      use_count: number;
      last_used_at: number | null;
    }>;
    return rows.map((row) => ({
      snippetId: row.snippet_id,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
    }));
  }
}
