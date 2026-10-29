/* eslint-disable max-lines -- 顶部 Git 操作集中承载 trigger 状态机与 mutation 编排；commit/push 弹窗已批次 6 外迁到 git-action-menu/，编排已批次 7 收口进 useGitActionMenuController。 */
import type {
  GitCommitMessageConversationContext,
  GitRepositorySummary,
  ACodeTaskChangeSummary,
} from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { TID_GIT_ACTION_TRIGGER } from "@/git-action-menu/gitActionMenuDialogsModel.js";
import { GitCommitDialog } from "@/git-action-menu/GitCommitDialog.js";
import { GitPushDialog } from "@/git-action-menu/GitPushDialog.js";
import {
  resolveTriggerIconKind,
  type GitActionMenuTriggerIconKind,
} from "@/git-action-menu/gitActionMenuCommitFlow.js";
import { useGitActionMenuController } from "@/git-action-menu/useGitActionMenuController.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { ArrowUpFromLine, GitCommitIcon, LoaderIcon } from "lucide-react";

interface GitActionMenuProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary?: ACodeTaskChangeSummary | null;
  commitMessageConversationContext?: GitCommitMessageConversationContext | null;
  onRefreshGit: () => void;
  className?: string;
  triggerIconOnly?: boolean;
  triggerLayout?: "header" | "status-row";
}

/** 主按钮左侧图标：pending 时直接替换动作图标，避免在紧凑头部里额外追加 loading 图标把按钮挤宽。 */
function GitActionMenuTriggerIcon({ kind }: { kind: GitActionMenuTriggerIconKind }) {
  if (kind === "pending") {
    return <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />;
  }
  return kind === "push" ? (
    <ArrowUpFromLine className="size-4 text-foreground" />
  ) : (
    <GitCommitIcon className="size-4 text-foreground" />
  );
}

export function GitActionMenu({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary = null,
  commitMessageConversationContext = null,
  onRefreshGit,
  className,
  triggerIconOnly = false,
  triggerLayout = "header",
}: GitActionMenuProps) {
  const { intl } = useACodeIntl();
  const controller = useGitActionMenuController({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    gitSummary,
    activeTaskChangeSummary,
    commitMessageConversationContext,
    onRefreshGit,
  });
  const {
    closeCommitDialog,
    closePushDialog,
    commitDialogLoading,
    commitDialogOpen,
    commitDialogState,
    commitError,
    commitIncludeUnstaged,
    commitMessage,
    commitMessageGenerationPending,
    currentBranchLabel,
    handleCommitAndPushSubmit,
    handleCommitSubmit,
    handleGenerateCommitMessage,
    handlePrimaryAction,
    handlePushSubmit,
    mutationPending,
    openPushDialog,
    primaryActionDisabled,
    primaryActionId,
    pushDialogOpen,
    pushEnabled,
    pushError,
    refreshCommitDialogAfterBranchChange,
    setCommitIncludeUnstaged,
    setCommitMessage,
    triggerPending,
  } = controller;

  const isStatusRowTrigger = triggerLayout === "status-row";
  const triggerIconKind = resolveTriggerIconKind({ triggerPending, primaryActionId });

  return (
    <>
      <div
        onClick={isStatusRowTrigger && !triggerIconOnly ? handlePrimaryAction : undefined}
        className={cn(
          // macOS/Windows 小窗口下，顶部 Git 主按钮的中文文案会和分支入口、窗口控制区挤在同一行。
          // 在 header 容器变窄时只隐藏主按钮文字，保留图标入口，避免丢失核心 Git 操作。
          // transition-all 会把 scrollbar-color 等非合成属性也启动动画，
          // 进而触发整页 UpdateLayoutTree；Git 入口只需要颜色反馈，不动画尺寸和滚动条属性。
          "flex h-7 items-center overflow-hidden rounded-lg border border-border bg-input transition-colors hover:border-border-hover @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:justify-center",
          triggerIconOnly && "w-7 justify-center",
          isStatusRowTrigger &&
            "h-8 w-full justify-start rounded-lg border-0 bg-transparent hover:border-transparent hover:bg-hover @max-[560px]/workspace-header:w-full @max-[560px]/workspace-header:justify-start",
          className,
        )}
      >
        <Button
          data-testid={TID_GIT_ACTION_TRIGGER}
          type="button"
          variant="ghost"
          size="default"
          disabled={primaryActionDisabled}
          aria-label={intl.formatMessage({
            id: "git.actionMenu.trigger.ariaLabel",
          })}
          className={cn(
            "h-7 rounded-lg border-0 gap-1 px-1.5 @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:px-0 @max-[560px]/workspace-header:[&>span]:hidden",
            triggerIconOnly && "w-7 px-0 [&>span]:hidden",
            isStatusRowTrigger &&
              "h-8 min-w-0 w-full justify-start gap-2 px-2 text-left text-ui-base hover:bg-transparent hover:text-foreground @max-[560px]/workspace-header:w-auto @max-[560px]/workspace-header:[&>span]:inline",
          )}
          onClick={isStatusRowTrigger && !triggerIconOnly ? undefined : handlePrimaryAction}
        >
          <GitActionMenuTriggerIcon kind={triggerIconKind} />
          <span className={cn(isStatusRowTrigger && "min-w-0 truncate")}>
            {intl.formatMessage({ id: "git.actionMenu.trigger" })}
          </span>
        </Button>
      </div>

      <GitCommitDialog
        open={commitDialogOpen}
        loading={commitDialogLoading}
        state={commitDialogState}
        workspacePath={workspacePath}
        message={commitMessage}
        error={commitError}
        mutationPending={mutationPending}
        generationPending={commitMessageGenerationPending}
        includeUnstaged={commitIncludeUnstaged}
        pushEnabled={pushEnabled}
        onRefreshGit={refreshCommitDialogAfterBranchChange}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeCommitDialog();
          }
        }}
        onMessageChange={setCommitMessage}
        onIncludeUnstagedChange={setCommitIncludeUnstaged}
        onGenerateMessage={() => {
          void handleGenerateCommitMessage();
        }}
        onSubmit={() => {
          void handleCommitSubmit();
        }}
        onSubmitAndPush={() => {
          void handleCommitAndPushSubmit();
        }}
        onPushOnly={() => {
          closeCommitDialog();
          openPushDialog();
        }}
      />

      <GitPushDialog
        open={pushDialogOpen}
        gitSummary={gitSummary}
        currentBranchLabel={currentBranchLabel}
        pushEnabled={pushEnabled}
        error={pushError}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closePushDialog();
          }
        }}
        onSubmit={() => {
          void handlePushSubmit();
        }}
      />
    </>
  );
}
