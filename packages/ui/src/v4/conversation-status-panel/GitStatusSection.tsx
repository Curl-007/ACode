/**
 * ConversationStatusPanel 的环境（Git）分区（批次 6 外迁，第一批）。
 *
 * `GitStatusSection` 逐字迁移自 `ConversationStatusPanel.tsx`（原行 312-410），只做展示：
 * 无 tick、无 memo、无滚动策略。实时语义（Impl 投影）仍留在主文件。
 */
import type { GitChangeSourceId, GitRepositorySummary, ACodeTaskChangeSummary } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";
import { FileDiffIcon } from "lucide-react";
import { StatusSection } from "@/v4/conversation-status-panel/StatusSectionShell.js";

export function GitStatusSection({
  activeTaskChangeSummary,
  gitSummary,
  gitWorktreeReviewSourceId,
  model,
  onOpenGitReview,
  onRefreshGit,
  separated,
  workspaceIdentity,
  workspacePath,
  useVerticalFloatingPanels,
}: {
  activeTaskChangeSummary?: ACodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary | null | undefined;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  model: ConversationStatusPanelModel;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onRefreshGit?: () => void;
  separated: boolean;
  workspaceIdentity?: string;
  workspacePath: string;
  useVerticalFloatingPanels: boolean;
}) {
  const { intl } = useACodeIntl();
  const git = model.git;
  if (!git || !gitSummary || !onRefreshGit) {
    return null;
  }
  const hasChanges = git.added + git.removed > 0;
  const canOpenReview = Boolean(onOpenGitReview && gitSummary.isRepository);

  return (
    <StatusSection
      section="environment"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.environment" })}
      trailing={(isOpen) =>
        isOpen ? null : (
          <span className="shrink-0 font-mono text-ui-sm tabular-nums">
            <span className={cn("text-[var(--color-diff-added)]", !hasChanges && "opacity-50")}>
              +{git.added}
            </span>{" "}
            <span className={cn("text-[var(--color-diff-removed)]", !hasChanges && "opacity-50")}>
              -{git.removed}
            </span>
          </span>
        )
      }
    >
      <div className="space-y-0">
        {/* V4 状态面板迁移时只保留了 Changes 的静态展示，
            没有继续透传旧版 Git review 回调，导致规范中的审阅入口不可点击。 */}
        <button
          type="button"
          disabled={!canOpenReview}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
            canOpenReview
              ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
              : "cursor-default opacity-50",
          )}
          onClick={() => {
            onOpenGitReview?.(gitWorktreeReviewSourceId ?? undefined);
          }}
        >
          <FileDiffIcon className="size-4 shrink-0 text-[var(--color-foreground)]" />
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.changes" })}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-[var(--color-diff-added)]">+{git.added}</span>{" "}
            <span className="text-[var(--color-diff-removed)]">-{git.removed}</span>
          </span>
        </button>
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={gitSummary}
          dirtyFileCount={git.dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="w-full px-0 pt-0"
          triggerClassName="flex h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] [&>span]:max-w-[calc(100%-3.5rem)] [&_svg:first-child]:text-[var(--color-foreground)]"
          popoverClassName="w-72 max-w-[calc(100vw-2rem)]"
          branchListClassName="max-h-56"
          popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
          showFooterActions
        />
        <GitActionMenu
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitSummary}
          activeTaskChangeSummary={activeTaskChangeSummary ?? null}
          onRefreshGit={onRefreshGit}
          triggerLayout="status-row"
          className="w-full"
        />
      </div>
    </StatusSection>
  );
}
