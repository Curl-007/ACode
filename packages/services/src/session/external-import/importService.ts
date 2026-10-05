import { access, constants } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { ACodeTaskMeta } from "@acode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { claudeCodeExternalSessionAdapter } from "#src/session/external-import/adapters/claudeCode.js";
import { codexExternalSessionAdapter } from "#src/session/external-import/adapters/codex.js";
import { cursorExternalSessionAdapter } from "#src/session/external-import/adapters/cursor.js";
import { geminiCliExternalSessionAdapter } from "#src/session/external-import/adapters/geminiCli.js";
import { opencodeExternalSessionAdapter } from "#src/session/external-import/adapters/opencode.js";
import { buildImportedExternalTaskFile, buildImportedExternalTaskId } from "#src/session/external-import/importTaskFile.js";
import { IMPORT_DISCOVER_DEFAULT_LIMIT } from "#src/session/external-import/importGuards.js";
import { persistImportedClaudeTask } from "#src/session/claude-native/persistImportedClaudeTask.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type {
  ExternalImportFailedSource,
  ExternalImportResult,
  ExternalSessionSource,
  ExternalSessionSourceAdapter,
  ExternalSessionSummary,
} from "#src/session/external-import/types.js";

const logger = createServiceLogger("external-import");

/** 全部已注册来源 adapter；adapter 均为无状态对象，可安全共享。 */
export function getExternalSessionSourceAdapters(): Record<
  ExternalSessionSource,
  ExternalSessionSourceAdapter
> {
  return {
    "claude-code": claudeCodeExternalSessionAdapter,
    "openai-codex": codexExternalSessionAdapter,
    "gemini-cli": geminiCliExternalSessionAdapter,
    opencode: opencodeExternalSessionAdapter,
    cursor: cursorExternalSessionAdapter,
  };
}

/**
 * R4 多来源并行发现：Promise.allSettled，单来源失败不拖垮整轮（失败来源记入
 * failedSources 并 warn），汇总后按 lastActivityTs 降序、可选 limit 截断。
 * adapters 参数供测试注入桩（生产缺省用注册表）。
 */
export async function discoverExternalSessions(params: {
  sources?: ExternalSessionSource[];
  sinceTs?: number;
  limit?: number;
  workspacePath?: string;
  adapters?: ExternalSessionSourceAdapter[];
}): Promise<{ summaries: ExternalSessionSummary[]; failedSources: ExternalImportFailedSource[] }> {
  const registry = getExternalSessionSourceAdapters();
  const adapters =
    params.adapters ??
    (params.sources ?? (Object.keys(registry) as ExternalSessionSource[])).map(
      (source) => registry[source],
    );

  const settled = await Promise.allSettled(
    adapters.map((adapter) =>
      adapter.discoverSessions({
        sinceTs: params.sinceTs,
        limit: params.limit,
        workspacePath: params.workspacePath,
      }),
    ),
  );

  const summaries: ExternalSessionSummary[] = [];
  const failedSources: ExternalImportFailedSource[] = [];
  settled.forEach((outcome, index) => {
    const adapter = adapters[index] as ExternalSessionSourceAdapter;
    if (outcome.status === "fulfilled") {
      summaries.push(...outcome.value);
      return;
    }
    const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    logger.warn(undefined, `外部来源发现失败 source=${adapter.source}`, outcome.reason);
    failedSources.push({ source: adapter.source, error });
  });

  summaries.sort((left, right) => right.lastActivityTs - left.lastActivityTs);
  // R4：时间范围/上限沿用既有 UI 语义；未显式传上限时用与 UI 同源的缺省 500。
  const effectiveLimit =
    typeof params.limit === "number" && params.limit > 0 ? params.limit : IMPORT_DISCOVER_DEFAULT_LIMIT;
  return { summaries: summaries.slice(0, effectiveLimit), failedSources };
}

function aggregateSkippedReasons(result: ExternalImportResult): void {
  const counts = new Map<string, number>();
  for (const item of result.skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  result.skippedReasons = [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

async function workspacePathExists(workspacePath: string): Promise<boolean> {
  try {
    await access(workspacePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// F4：与 claude-native 链路（claudeNativeSessionImportService.ts 的同款私有实现）
// 逐条一致的归一比较：resolve+normalize 消除 "./" 与分隔符差异，win32 大小写不敏感。
// claude-native 是互斥写区不能提取导出，这里承载 external-import 自己的一份。
function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 单来源批量导入（R3/R4）：解析 → 幂等去重 → 复用既有落库链路
 * （buildImportedExternalTaskFile + persistImportedClaudeTask）。
 * 结构化结果 imported/skipped/skippedReasons/failed，UI 可解释（R2）。
 */
export async function importExternalSessions(params: {
  source: ExternalSessionSource;
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  onTaskImported?: (meta: ACodeTaskMeta) => void;
}): Promise<ExternalImportResult> {
  const adapter = getExternalSessionSourceAdapters()[params.source];
  const sessionIds = [...new Set(params.sessionIds.map((item) => item.trim()).filter(Boolean))];
  const result: ExternalImportResult = {
    imported: [],
    skipped: [],
    skippedReasons: [],
    failed: [],
  };

  logger.info(
    undefined,
    `开始导入外部 session source=${params.source} workspaceFilter=${params.workspacePath ?? "all"} count=${sessionIds.length}`,
  );

  // 幂等去重键：origin（source+sourceSessionId）由确定性 taskId 承载（见 importTaskFile）。
  // 一次性加载现有任务 id 集合，重复导入 → skipped(already_imported)，不产生双份任务。
  // F6：去重集只收活任务（includeDeleted 缺省 false）——用户删除导入任务后重导走
  // 下游 persist 的恢复语义（archived:false/deleted:false，任务重新可见），已删除行
  // 不得再拦截重导入。
  let existingTaskIds: Set<string>;
  try {
    existingTaskIds = new Set(
      (await params.taskIndexRepo.listTaskMetas({})).map((meta) => meta.taskId),
    );
  } catch (error) {
    logger.warn(undefined, "加载任务索引失败，本轮导入跳过幂等去重", error);
    existingTaskIds = new Set();
  }

  for (const sessionId of sessionIds) {
    try {
      let record;
      try {
        record = await adapter.parseSession({ sourceSessionId: sessionId });
      } catch (error) {
        // 解析层错误（含路径穿越拒绝、文件损坏）逐会话隔离，不拖垮整轮。
        result.failed.push({
          source: params.source,
          sourceSessionId: sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (record.messages.length === 0) {
        result.skipped.push({
          source: params.source,
          sourceSessionId: sessionId,
          reason: "no_visible_messages",
        });
        continue;
      }

      // F4：record.cwd 与过滤 workspacePath 归一比较后不一致 → skip（对齐 claude 链路
      // claudeNativeSessionImportService 的既有守卫先例），避免把过滤 workspace 的
      // identity 错绑到 cwd 指向的另一个 workspace 任务上。record.cwd 缺失时不过此关，
      // 走下方“回退到导入目标 workspace”的既有路径（此时 identity 绑定仍然正确）。
      // 注意与 F5 的分工：workspace 过滤是导入时的选择条件，不是会话身份的一部分。
      if (
        record.cwd &&
        params.workspacePath &&
        normalizePathForComparison(record.cwd) !== normalizePathForComparison(params.workspacePath)
      ) {
        result.skipped.push({
          source: params.source,
          sourceSessionId: sessionId,
          reason: "workspace-mismatch",
          workspacePath: record.cwd,
        });
        continue;
      }

      const taskId = buildImportedExternalTaskId(record);
      if (existingTaskIds.has(taskId)) {
        result.skipped.push({
          source: params.source,
          sourceSessionId: sessionId,
          reason: "already_imported",
        });
        continue;
      }

      // 新来源 cwd 缺失时回退到导入目标 workspace；两者都没有则无法定位落盘目录。
      const targetWorkspacePath = record.cwd ?? params.workspacePath;
      if (!targetWorkspacePath) {
        result.skipped.push({
          source: params.source,
          sourceSessionId: sessionId,
          reason: "workspace_unknown",
        });
        continue;
      }
      if (!(await workspacePathExists(targetWorkspacePath))) {
        result.skipped.push({
          source: params.source,
          sourceSessionId: sessionId,
          reason: "workspace_path_missing",
          workspacePath: targetWorkspacePath,
        });
        continue;
      }

      const sessionFile = buildImportedExternalTaskFile(
        record.cwd ? record : { ...record, cwd: targetWorkspacePath },
        taskId,
      );
      // 复用既有 claude 落库链路（函数名带 claude 但实现是通用的 legacy snapshot 写入 +
      // 任务索引同步）；新来源没有 createSession 续聊路径——importedHistory 协议当前
      // 只接受 claudeCode 来源，等协议扩展后再接（spec 附录）。
      // F4：identity 只在设置了过滤 workspace 时绑定——上面的 workspace-mismatch 守卫
      // 保证此时任务的落盘 workspace（record.cwd 或回退的 params.workspacePath）与过滤
      // workspace 归一一致，不会把 identity 套到别的路径上。
      const meta = await persistImportedClaudeTask({
        taskIndexRepo: params.taskIndexRepo,
        sessionFile,
        workspaceIdentity: params.workspacePath ? params.workspaceIdentity : undefined,
      });
      existingTaskIds.add(taskId);
      params.onTaskImported?.(meta);
      result.imported.push({
        source: params.source,
        sourceSessionId: sessionId,
        taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(undefined, `导入外部 session 失败 source=${params.source} session=${sessionId}`, error);
      result.failed.push({ source: params.source, sourceSessionId: sessionId, error: reason });
    }
  }

  aggregateSkippedReasons(result);
  logger.info(
    undefined,
    `外部 session 导入完成 source=${params.source} imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
  );
  return result;
}
