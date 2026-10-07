import { resolveWorkspaceKey } from "@acode/shared";

interface HostWorkspaceTaskContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface HostWorkspaceTaskCountEvent extends HostWorkspaceTaskContext {
  runningTaskCount: number;
}

export function createHostWorkspaceTaskTracker(
  report: (event: HostWorkspaceTaskCountEvent) => void,
  reportTotal?: (totalRunningTaskCount: number) => void,
): {
  begin: (taskId: string, context: HostWorkspaceTaskContext) => boolean;
  finish: (taskId: string, context: HostWorkspaceTaskContext) => void;
  getRunningTaskCount: (context: HostWorkspaceTaskContext) => number;
  getTotalRunningTaskCount: () => number;
  clearWorkspace: (context: HostWorkspaceTaskContext) => void;
  beginUnattributedRpc: () => void;
  finishUnattributedRpc: () => void;
} {
  const entries = new Map<
    string,
    { context: HostWorkspaceTaskContext; activeTaskIds: Set<string> }
  >();
  let totalRunningTaskCount = 0;
  // 无归属 RPC 计数：sendPrompt 在 task meta 缺失/参数畸形时的兜底，只覆盖 RPC
  // 生命周期（调用→ACK）。无法伪造 workspace identity，故不进 workspace 桶、
  // 不参与释放裁决，只进 host 级总量（specs/host-running-task-count.md）。
  // 收编自 host/index.ts 的模块级影子计数器 untrackedPromptRpcCount——此前同一
  // 「有没有任务在跑」事实双写两处，加减散落在 Proxy 包装器三个位置。
  let unattributedRpcCount = 0;

  function emitTotal(): void {
    reportTotal?.(totalRunningTaskCount + unattributedRpcCount);
  }

  function reportEntry(entry: {
    context: HostWorkspaceTaskContext;
    activeTaskIds: Set<string>;
  }): void {
    report({ ...entry.context, runningTaskCount: entry.activeTaskIds.size });
    emitTotal();
  }

  return {
    getRunningTaskCount(context) {
      return entries.get(resolveWorkspaceKey(context))?.activeTaskIds.size ?? 0;
    },

    getTotalRunningTaskCount() {
      return totalRunningTaskCount + unattributedRpcCount;
    },

    begin(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey) ?? {
        context,
        activeTaskIds: new Set<string>(),
      };
      if (entry.activeTaskIds.has(taskId)) {
        return false;
      }
      entry.activeTaskIds.add(taskId);
      totalRunningTaskCount += 1;
      entries.set(workspaceKey, entry);
      reportEntry(entry);
      return true;
    },

    finish(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry?.activeTaskIds.delete(taskId)) {
        return;
      }
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - 1);
      if (entry.activeTaskIds.size === 0) {
        entries.delete(workspaceKey);
      }
      // sendPrompt resolve 只是 ACK，不能代表 Agent 已空闲。计数只由 task ready
      // 事件结束，避免共享 WSL Host 在关闭 workspace 时误杀仍在执行工具的 Agent。
      reportEntry(entry);
    },

    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry) {
        return;
      }
      entries.delete(workspaceKey);
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - entry.activeTaskIds.size);
      entry.activeTaskIds.clear();
      reportEntry(entry);
    },

    beginUnattributedRpc() {
      unattributedRpcCount += 1;
      emitTotal();
    },

    finishUnattributedRpc() {
      unattributedRpcCount = Math.max(0, unattributedRpcCount - 1);
      emitTotal();
    },
  };
}
