import { useEffect, useState } from "react";
import type { ACodeTaskMeta } from "@acode/shared";
import { useACodeSessionService } from "@/hooks/useACodeSessionService.js";
import { mapSessionHeaderMetaToTaskMeta } from "@/v4/mapSessionHeaderMetaToTaskMeta.js";

function resolveImmediateActiveTaskSnapshotMeta(
  previousSnapshotMeta: ACodeTaskMeta | null,
  taskId: string | null,
  taskMetaFromLists?: ACodeTaskMeta | null,
) {
  if (!taskId || taskMetaFromLists) {
    return null;
  }

  // pin / archive task 切换时，如果目标任务一开始不在列表数据源里，
  // 新 snapshot 还没返回前不能继续沿用上一条任务的 snapshot meta。
  // 否则 Header 会先显示旧标题，再被异步结果改正，体感上就像“名称慢半拍”。
  // 这里只允许复用“同一个 taskId”的旧 snapshot，跨任务切换时立刻清空。
  return previousSnapshotMeta?.taskId === taskId ? previousSnapshotMeta : null;
}

/**
 * 为当前激活 task 提供一层 snapshot meta 兜底。
 *
 * archived task 不在普通 taskListCache / pinnedTasks 数据源里，
 * 直接打开时 App 只靠列表元数据会拿不到标题、provider、traceId 等字段。
 * 这里在列表里找不到当前任务时，额外读取一次 snapshot.meta 作为展示兜底，
 * 只服务当前激活任务，不把 archived task 混回普通列表。
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: ACodeTaskMeta | null,
) {
  const acodeSessionService = useACodeSessionService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [snapshotMeta, setSnapshotMeta] = useState<ACodeTaskMeta | null>(null);

  useEffect(() => {
    let cancelled = false;

    setSnapshotMeta((currentSnapshotMeta) =>
      resolveImmediateActiveTaskSnapshotMeta(currentSnapshotMeta, taskId, taskMetaFromLists),
    );

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    if (taskMetaFromLists) {
      return () => {
        cancelled = true;
      };
    }

    void acodeSessionService
      // active header 只需要 session meta/标题兜底。走 v4 归档冷读（specs/v4-session-header-meta.md）：
      // 只回 header 元数据，不带消息整包，且**不激活会话运行时**（归档任务的 workspace 进程可能已回收）。
      // 这是 legacy M1 的两个真投影消费方之一，就此从 acodeSessionProjection 收口。
      .readSessionHeaderMeta({
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        // found=false 是正常竞态（归档 ID 已清理 / 列表数据源缺席），归一成 null——
        // 与迁移前 .catch(()=>setSnapshotMeta(null)) 同一语义，不让 header 保留上一个任务的残留。
        setSnapshotMeta(result.found && result.meta ? mapSessionHeaderMetaToTaskMeta(result.meta) : null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [acodeSessionService, taskId, taskMetaFromLists, workspaceIdentity, workspacePath]);

  return snapshotMeta;
}
