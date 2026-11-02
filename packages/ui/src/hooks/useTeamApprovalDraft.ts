import { useCallback } from "react";
import { useTeamComposerInsert } from "@/hooks/useTeamComposerInsert.js";

/**
 * 待审批团队的「填入批准语」链路（SPEC-012 R9）。
 *
 * 迁移到 `useTeamComposerInsert` 之上的薄包装（单一实现，不复制 composer 通道逻辑）：
 * 只写 composer、不自动发送、mode = `append`、身份一起传——不变量见被包装 hook 的头注。
 * 批准动作本身仍由用户在对话里做出、队长调 `agent_teams_approve_plan`；UI 不直接调插件工具。
 */
export function useTeamApprovalDraft() {
  const { insertTeamText } = useTeamComposerInsert();
  const insertApprovalText = useCallback(
    (text: string) => {
      insertTeamText(text);
    },
    [insertTeamText],
  );
  return { insertApprovalText };
}