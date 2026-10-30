// syncTaskMeta 的归并写入：合并已有行状态（标题覆盖、终态保护、unread 单调），
// 并在首次获得 cron / off-peak 标记时归入对应系统分组。
// 原 taskIndexRepo.ts syncTaskMetaWithGroupedAdmission 原样迁入，改为接收 sqlite 句柄；
// 调用方（本体）负责 ensureReady 与按 task 的写入串行链。
import type { DatabaseSync } from "node:sqlite";
import type { ACodeTaskMeta } from "@acode/shared";
import { rowToMeta } from "#src/session/task-index/taskRowMapping.js";
import {
  getTaskRow,
  shouldPreserveNewerTerminalStatus,
  writeRecord,
} from "#src/session/task-index/taskRecordWrites.js";
import {
  ensureCronGroupMembership,
  ensureOffPeakGroupMembership,
  initializeGroupedTaskAtTopReady,
} from "#src/session/task-index/taskGroupingMemberships.js";

export interface TaskIndexSyncMetaParams {
  meta: ACodeTaskMeta;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  titleOverridden?: boolean;
  // 调用方可以从 snapshot.messages 计算正文，传进来同步刷新 searchable_text。
  // 不传则保留 sqlite 已有的 searchable_text（在 writeRecord 里兜底）。
  searchableText?: string;
}

export function syncTaskMetaWithGroupedAdmissionReady(
  database: DatabaseSync,
  params: TaskIndexSyncMetaParams,
  initializeGroupedAtTop: boolean,
): { meta: ACodeTaskMeta; initializedGroupedOrder: boolean } {
  if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
  try {
    const existing = getTaskRow(database, params.meta);
    const existingMeta = existing ? rowToMeta(existing) : null;
    const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
    // snapshot 来源的 updatedAt 是 runtime sessionStore 里的"最后一次结构变更"时间，
    // 不一定包含 session.titleUpdated / turn.completed 这些事件触发的 Date.now() 增量。
    // 如果这里直接用 params.meta.updatedAt 覆盖，会把刚刚走 applyAgentPatch 写入的更新时间戳冲回旧值，
    // 表现为新会话第一次 prompt 后又被压回列表底部。这里取与 sqlite 已有值的 max，保证单调不回退。
    const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
    const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
      existingMeta,
      params.meta,
    );
    const meta: ACodeTaskMeta = {
      ...params.meta,
      // agent 只负责 session 核心标题，用户手动重命名属于 app 侧 task 状态。
      // 同步 agent snapshot 时保留已覆盖标题，避免后台状态刷新把用户标题冲掉。
      title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
      titleOverridden,
      // turn.completed 会先通过 applyAgentPatch 写入较新的 completed/error。
      // 随后到达的 protocol snapshot 可能仍带较旧 running；如果这里降级 status，
      // 手机 replayable 切回 task 时就会把已完成任务恢复成“工作中”。
      status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
      lastError: preserveExistingTerminalStatus
        ? existingMeta?.lastError
        : params.meta.lastError,
      target: Object.prototype.hasOwnProperty.call(params.meta, "target")
        ? params.meta.target
        : existingMeta?.target,
      // Claude Code 导入升级成真实 ACode session 后，protocol snapshot
      // 本身不知道迁移来源。同步运行态快照时保留已有 migrationSource，避免
      // 列表过滤和后续切模型把导入任务重新当成普通 ACode 任务。
      migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
      // 同步运行态快照时保留已有 cron automation 身份：运行态 protocol snapshot 的 meta 不带 cron 标记，
      // 不用已存值兜底会在后续 sync 时把 cron 身份冲掉，导致 icon / 分组 / 关联查询失效。
      cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
      // off-peak 身份同款兜底：快照不带标记时保全既有归属。
      offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
      updatedAt,
      unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
    };
    const persistedMeta = writeRecord(database, {
      meta,
      pinned: params.pinned ?? existing?.pinned === 1,
      archived: params.archived ?? existing?.archived === 1,
      deleted: params.deleted ?? existing?.deleted === 1,
      titleOverridden,
      searchableText: params.searchableText,
    });
    // cron session 首次获得 cronAutomationId 时归入固定 cron 分组。
    // 会话内 CronCreate 是给已有 task 补 cron 标记，不能只判断 !existing，否则左侧列表不会归入定时任务分组。
    // INSERT OR IGNORE 不覆盖已有成员关系——用户后续把它拖出 cron 组后不会被自动拖回。
    if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
      ensureCronGroupMembership(database, meta);
    }
    // 闲时会话首次获得 offPeakTaskId 时归入固定闲时系统分组（机制同 cron）。
    if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
      ensureOffPeakGroupMembership(database, meta);
    }
    // root draft 首发过去先提交 task row，再另一次写 sort_order；
    // sessions-index 在两次写之间公开 task 时，Renderer 会把缺序节点补到末尾。
    const initializedGroupedOrder = initializeGroupedAtTop
      ? initializeGroupedTaskAtTopReady(database, meta)
      : false;
    if (initializeGroupedAtTop) database.exec("COMMIT");
    return { meta: persistedMeta, initializedGroupedOrder };
  } catch (error) {
    if (initializeGroupedAtTop) database.exec("ROLLBACK");
    throw error;
  }
}
