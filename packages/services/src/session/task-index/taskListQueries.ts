// tasks 表列表查询：扁平列表、删除 tombstone、cron 关联查询与分页搜索。
// 原 taskIndexRepo.ts 对应公开方法的实现体原样迁入，改为接收 sqlite 句柄。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeProvider, ACodeTaskMeta } from "@acode/shared";
import type {
  ACodeTaskListQuery,
  ACodeTaskListResult,
} from "#src/session/acodeTaskListTypes.js";
import type { TaskIndexRow } from "#src/session/task-index/taskIndexRows.js";
import { rowToMeta, rowToTaskListItem } from "#src/session/task-index/taskRowMapping.js";
import { normalizeWorkspaceKeys, workspaceKey } from "#src/session/task-index/taskGrouping.js";

export function appendACodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ACodeProvider,
): void {
  // 列表按当前 runtime provider 过滤；历史导入来源不改变此边界。
  where.push("provider = ?");
  args.push(provider);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

export function listTaskMetasReady(
  database: DatabaseSync,
  params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  },
): ACodeTaskMeta[] {
  // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
  // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
  const targetWorkspaceKey = params.workspacePath
    ? workspaceKey({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      })
    : null;
  const rows = database
    .prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        cron_automation_id,
        off_peak_task_id,
        created_at,
        updated_at,
        unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      FROM tasks
      WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        AND (@include_deleted = 1 OR deleted = 0)
        -- 按请求指定的 runtime provider 过滤；迁移来源另存于 migration_source。
        AND (@provider IS NULL OR provider = @provider)
        AND (@pinned IS NULL OR pinned = @pinned)
        AND (@archived IS NULL OR archived = @archived)
      ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
    )
    .all({
      workspace_key: targetWorkspaceKey,
      include_deleted: params.includeDeleted ? 1 : 0,
      provider: params.provider ?? null,
      pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
      archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
    }) as unknown as TaskIndexRow[];
  return rows.map(rowToMeta);
}

export function listDeletedTaskIdsReady(
  database: DatabaseSync,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ACodeProvider;
  },
): string[] {
  const workspaceKeyValue = workspaceKey({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  const rows = database
    .prepare(
      `SELECT task_id
      FROM tasks
      WHERE workspace_key = @workspace_key
        AND deleted = 1
        AND (@provider IS NULL OR provider = @provider)
      ORDER BY task_id`,
    )
    .all({
      workspace_key: workspaceKeyValue,
      provider: params.provider ?? null,
    }) as Array<{ task_id: string }>;
  return rows.map((row) => row.task_id);
}

export function listSessionsByAutomationReady(
  database: DatabaseSync,
  automationId: string,
): ACodeTaskMeta[] {
  const rows = database
    .prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        cron_automation_id,
        off_peak_task_id,
        created_at,
        updated_at,
        unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      FROM tasks
      WHERE cron_automation_id = @automation_id
        AND deleted = 0
      ORDER BY created_at DESC, task_id DESC`,
    )
    .all({ automation_id: automationId }) as unknown as TaskIndexRow[];
  return rows.map(rowToMeta);
}

export function queryTaskListReady(
  database: DatabaseSync,
  params: ACodeTaskListQuery & { provider?: ACodeProvider },
): ACodeTaskListResult {
  const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
  if (workspaceKeys.length === 0) {
    return { items: [], total: 0, hasMore: false };
  }

  const search = params.search?.trim();
  const normalizedSearchLike =
    search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
  const where = ["deleted = 0", `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`];
  const args: Array<string | number> = [...workspaceKeys];
  if (params.provider) {
    appendACodeAgentIndexedProviderFilter(where, args, params.provider);
  }
  if (params.kind === "pinned") {
    where.push("pinned = 1", "archived = 0");
  } else if (params.kind === "archived") {
    where.push("archived = 1");
  } else {
    where.push("pinned = 0", "archived = 0");
  }
  if (normalizedSearchLike) {
    // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
    // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
    where.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)");
  }

  if (normalizedSearchLike) {
    args.push(normalizedSearchLike, normalizedSearchLike);
  }
  const whereClause = where.join(" AND ");
  const totalRow = database
    .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
    .get(...args) as { total: number } | undefined;
  const total = totalRow?.total ?? 0;

  const limit = normalizeLimit(params.limit);
  const listArgs: Array<string | number> = [...args];
  if (limit !== null) {
    listArgs.push(limit);
  }
  const orderBy =
    params.sortBy === "created"
      ? "created_at DESC, updated_at DESC, task_id DESC"
      : "updated_at DESC, created_at DESC, task_id DESC";
  const rows = database
    .prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        cron_automation_id,
        off_peak_task_id,
        created_at,
        updated_at,
        unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json
      FROM tasks
      WHERE ${whereClause}
      ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
    )
    .all(...listArgs) as unknown as TaskIndexRow[];
  const workspacePurposeByKey = new Map(
    params.workspaceScopes.flatMap((scope) =>
      scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
    ),
  );

  return {
    items: rows.map((row) => {
      const item = rowToTaskListItem(row, search ?? null);
      const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
      return workspacePurpose ? { ...item, workspacePurpose } : item;
    }),
    total,
    hasMore: total > rows.length,
  };
}
