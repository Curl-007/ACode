// 推荐 Prompt 的延迟可信解析需要知道用户是否在等待期间编辑了 Composer。
// revision 只存在 renderer 内存中，不进入草稿持久化、协议或远程同步；workspace identity
// 使用与 Zustand 草稿相同的 workspaceKey，避免本地路径和远程身份串写。
const revisionByWorkspaceKey = new Map<string, number>();
const listenersByWorkspaceKey = new Map<string, Set<() => void>>();

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  return revisionByWorkspaceKey.get(getWorkspaceKey(workspacePath, workspaceIdentity)) ?? 0;
}

export function advanceComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const nextRevision = (revisionByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
  revisionByWorkspaceKey.set(workspaceKey, nextRevision);
  const listeners = listenersByWorkspaceKey.get(workspaceKey);
  if (listeners) {
    for (const listener of [...listeners]) listener();
  }
  return nextRevision;
}

/**
 * 订阅草稿 revision 变化（memo 化子树的展示态探针用：只在关心的布尔翻转时触发
 * 重渲染，避免逐键重渲染工具栏——E2E D2 回归）。返回退订函数；最后一个监听器
 * 退出即清 key，Map 不随 workspace 增长泄漏。
 */
export function subscribeToComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  listener: () => void,
): () => void {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  let listeners = listenersByWorkspaceKey.get(workspaceKey);
  if (!listeners) {
    listeners = new Set();
    listenersByWorkspaceKey.set(workspaceKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByWorkspaceKey.get(workspaceKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByWorkspaceKey.delete(workspaceKey);
  };
}
