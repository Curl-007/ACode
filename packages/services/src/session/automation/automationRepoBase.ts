import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import type { AutomationRow } from "#src/session/automation/automationRows.js";

// AutomationRepo 的库连接生命周期基座（2026-10-30 自 automationRepo.ts 拆出）。
// Node-only 叶子：顶层 createRequire("node:sqlite") 与目录创建只能留在 Node 侧，
// 本文件及全部仓库分段均不得被浏览器安全叶子导入。

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/**
 * 连接生命周期与行读写基座：持有 tasks-index.sqlite（WAL、多进程安全）连接，
 * 子类分段（CRUD / 认领 / 派发结算 / 运行历史）共享同一份连接与 getRow/writeRow。
 */
export class AutomationRepoBase {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // db 路径不能从进程级全局 _dataBaseDir（getTasksIndexDatabasePath）解析：
  // vitest threads 池会在同一进程并发跑多个测试文件，各文件的 setDataBaseDir(tempDir)
  // 互相覆盖全局值，导致 repo 与裸 SQL 操作在并发窗口内写进真实库 ~/.acode/v2（历史脏数据
  // /tmp/ws 系列即因此污染）。改为构造期固定一份 dbPath，测试通过依赖注入传入临时库路径，
  // 生产路径不传则回退 getTasksIndexDatabasePath，向后兼容。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
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

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
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
    // Worker 已完成该路径的原始准备，业务连接不再重复全表修复。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
  }

  protected getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // workspaceKey 传入时强制归属校验（写/单查路径,防跨 workspace 越界）；省略=不加过滤,
  // 供 scheduler/host 跨 workspace 的调度状态机使用。
  protected getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
    return row ?? null;
  }

  protected writeRow(row: AutomationRow): void {
    this.getDatabase()
      .prepare(
        `UPDATE automations SET
          title = @title, cron_expr = @cron_expr, prompt = @prompt, model = @model, provider = @provider,
          model_selection = @model_selection,
          mode = @mode, thought_level = @thought_level,
          recurring = @recurring, max_runs = @max_runs, end_at = @end_at,
          schedule_rule = @schedule_rule,
          schedule_edited_by_user = @schedule_edited_by_user,
          next_run_at = @next_run_at, lifecycle_status = @lifecycle_status,
          dispatch_attempts = @dispatch_attempts, retry_at = @retry_at, dispatch_status = @dispatch_status,
          enabled = @enabled, updated_at = @updated_at
        WHERE automation_id = @automation_id`,
      )
      .run({
        automation_id: row.automation_id,
        title: row.title,
        cron_expr: row.cron_expr,
        prompt: row.prompt,
        model: row.model,
        provider: row.provider,
        model_selection: row.model_selection,
        mode: row.mode,
        thought_level: row.thought_level,
        recurring: row.recurring,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule: row.schedule_rule,
        schedule_edited_by_user: row.schedule_edited_by_user,
        next_run_at: row.next_run_at,
        lifecycle_status: row.lifecycle_status,
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        dispatch_status: row.dispatch_status,
        enabled: row.enabled,
        updated_at: row.updated_at,
      });
  }
}
