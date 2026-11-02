import { useCallback } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { logger } from "@/logger.js";

/**
 * 团队动作的 composer 写入通道（唯一）。
 *
 * 不变量（SPEC-012 R9 / 批次 4 R4）：
 * 1. 写入**只**经 `requestComposerTextInsert`（AGENTS.md 禁止第二条写输入框的路径）；
 * 2. **不触发发送**——与片段插入同一语义，用户看一眼自己按回车；
 * 3. mode = `append`：不覆盖用户已经打了一半的草稿；
 * 4. 身份必须一起传：composer 按 `workspaceIdentity` 优先的键读写，只传 path 会让请求落到
 *    path 桶、在远程/隔离工作区永远不被消费（见 useTeamApprovalDraft 的回归测试）；
 * 5. target 显式取值优先（面板型容器带自己的 scope），缺席回退当前活跃工作区。
 */
export interface TeamComposerInsertTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}

export function useTeamComposerInsert() {
  // `useOptionalTabStore`（而非 `useTabStore`）：团队卡 / 面板要能在无 Root/TabStoreProvider
  // 的展示场景里独立渲染（既有 TeamWorkflowPresentation.test 就这么渲染）。Provider 缺席时
  // 回退空 tab 状态并走下方 warn 分支。
  const activeWorkspacePath = useOptionalTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useOptionalTabStore((state) => state.activeWorkspaceIdentity);
  const insertTeamText = useCallback(
    (text: string, target?: TeamComposerInsertTarget): boolean => {
      const workspacePath = target?.workspacePath ?? activeWorkspacePath;
      const workspaceIdentity = target?.workspaceIdentity ?? activeWorkspaceIdentity;
      if (!workspacePath) {
        logger.warn("[TeamComposer] 无活跃工作区，团队文案未写入输入框");
        return false;
      }
      useACodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          text,
          workspaceIdentity ?? undefined,
          undefined,
          "append",
        );
      return true;
    },
    [activeWorkspacePath, activeWorkspaceIdentity],
  );
  return { insertTeamText };
}