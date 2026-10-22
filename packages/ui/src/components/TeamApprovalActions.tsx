import { CheckIcon, CopyIcon, ListChecksIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useTeamApprovalDraft } from "@/hooks/useTeamApprovalDraft.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { teamApprovalText } from "@/v4/teamWorkflowPresentation.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";

/**
 * 待审批（draft）团队的操作行（SPEC-012 R9）：
 * - 「填入批准语」把批准语经 composer 唯一通道写进输入框（不自动发送）；
 * - 「复制批准语」写剪贴板（既有 navigator.clipboard 手法，Web 与桌面同源）；
 * - 「查看计划」打开团队侧栏。
 * 不提供「面板内批准」——那会让 UI 从只读投影变成调度入口（P4，另立 spec）。
 */
export function TeamApprovalActions({
  team,
  onOpenPlan,
}: {
  team: ConversationStatusPanelTeam;
  onOpenPlan?: () => void;
}) {
  const { intl } = useACodeIntl();
  const { insertApprovalText } = useTeamApprovalDraft();
  const [copied, setCopied] = useState(false);
  const text = teamApprovalText(team.teamId);
  const copy = async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        // 无剪贴板能力不再静默返回（PRD fix-spec-012 §3）：点了几何零反馈会被当成按钮坏了。
        toast(intl.formatMessage({ id: "chat.statusPanel.agentTeams.copyPanelUrlFailed" }));
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      logger.warn("[TeamApproval] 复制批准语失败", error);
      toast(intl.formatMessage({ id: "chat.statusPanel.agentTeams.copyPanelUrlFailed" }));
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-t border-card-border pt-1.5 text-ui-sm"
      data-testid="team-approval-actions"
    >
      <Button
        size="sm"
        variant="ghost"
        data-testid="team-approval-fill"
        onClick={() => insertApprovalText(text)}
      >
        <CheckIcon aria-hidden className="size-3.5" />
        {intl.formatMessage({ id: "teamPanel.timeline.fillApproval" })}
      </Button>
      <Button size="sm" variant="ghost" data-testid="team-approval-copy" onClick={copy}>
        <CopyIcon aria-hidden className="size-3.5" />
        {intl.formatMessage({
          id: copied ? "teamPanel.timeline.copied" : "teamPanel.timeline.copyApproval",
        })}
      </Button>
      {onOpenPlan ? (
        <Button size="sm" variant="ghost" onClick={onOpenPlan}>
          <ListChecksIcon aria-hidden className="size-3.5" />
          {intl.formatMessage({ id: "teamPanel.timeline.viewPlan" })}
        </Button>
      ) : null}
    </div>
  );
}
