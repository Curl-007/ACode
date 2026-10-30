import { resolveWorkspaceKey } from "@acode/shared";

// automation 管理面调用的 workspace 归属解析（2026-10-30 自 automationService.ts 拆出）。
// 纯函数叶子：跨 workspace 隔离校验的唯一定义点，service 与后续管理面复用。

/** 写/单查操作的 workspace 归属；用于跨 workspace 隔离校验。 */
export interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope → workspaceKey；缺省返回 undefined（不加归属过滤，供 scheduler/host 跨 workspace 用）。 */
export function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}
