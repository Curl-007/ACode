import { useCallback } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { logger } from "@/logger.js";

/**
 * 待审批团队的「填入批准语」链路（SPEC-012 R9）。
 *
 * 不变量：
 * 1. 写入**只**经 `requestComposerTextInsert`（AGENTS.md 禁止第二条写输入框的路径）；
 * 2. **不触发发送**——与片段插入同一条通道、同一语义，用户看一眼自己按回车；
 * 3. mode = `append`：不覆盖用户已经打了一半的草稿；
 * 4. 身份必须一起传：composer 按 `workspaceIdentity` 优先的键（`resolveWorkspaceStateKey`）
 *    读写，只传 path 会让请求落到 path 桶、在远程/隔离工作区永远不被消费（见本 hook 的
 *    回归测试与 docs/prd/fix-spec-012-implementation-gaps.md §1.1）。
 *
 * 批准动作本身仍由用户在对话里做出、队长调 `agent_teams_approve_plan`；UI 不直接调
 * 插件工具（SPEC-003 的只读业务边界）。
 */
export function useTeamApprovalDraft() {
  // `useOptionalTabStore`（而非 `useTabStore`）：团队卡允许在无 Root/TabStoreProvider 的
  // 展示组件里独立渲染（既有 TeamWorkflowPresentation.test 就是这么渲染的）。该 hook 无
  // 独立读取（无 navigator）通道，Provider 缺席时回退空 tab 状态并走下方 warn 分支。
  const activeWorkspacePath = useOptionalTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useOptionalTabStore((state) => state.activeWorkspaceIdentity);
  const insertApprovalText = useCallback(
    (text: string) => {
      if (!activeWorkspacePath) {
        logger.warn("[TeamApproval] 无活跃工作区，批准语未写入输入框");
        return;
      }
      useACodeSessionStore
        .getState()
        .requestComposerTextInsert(
          activeWorkspacePath,
          text,
          activeWorkspaceIdentity ?? undefined,
          undefined,
          "append",
        );
    },
    [activeWorkspacePath, activeWorkspaceIdentity],
  );
  return { insertApprovalText };
}
