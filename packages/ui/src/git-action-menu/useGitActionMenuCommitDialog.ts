/**
 * GitActionMenu 提交弹窗的状态与读取/生成编排（批次 7 外迁，模式 B 第一刀）。
 *
 * 收口 `GitActionMenu.tsx` 原主组件内的提交弹窗 7 个 state 与
 * `closeCommitDialog` / `loadCommitDialogState` / `openCommitDialog` /
 * `refreshCommitDialogAfterBranchChange` / `generateCommitMessage` /
 * `handleGenerateCommitMessage`。deps 与日志打点逐字保留。
 */
import { useCallback, useMemo, useState } from "react";
import type {
  ACodeTaskChangeSummary,
  GitCommitMessageConversationContext,
  GitRepositorySummary,
} from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchCommitPreviewFiles,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { canPushGitBranch } from "@/git-action-menu/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import {
  getCommitDialogFiles,
  type GitCommitDialogState,
} from "@/git-action-menu/gitActionMenuDialogsModel.js";
import { resolveCommitStagePlan } from "@/git-action-menu/gitActionMenuCommitFlow.js";
import { useServices } from "@/hooks/useServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export interface GitActionMenuCommitDialogInput {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary: ACodeTaskChangeSummary | null;
  commitMessageConversationContext: GitCommitMessageConversationContext | null;
  onRefreshGit: () => void;
}

export function useGitActionMenuCommitDialog({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary,
  commitMessageConversationContext,
  onRefreshGit,
}: GitActionMenuCommitDialogInput) {
  const { gitService } = useServices();
  const { intl, locale } = useACodeIntl();
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogLoading, setCommitDialogLoading] = useState(false);
  const [commitDialogState, setCommitDialogState] = useState<GitCommitDialogState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitIncludeUnstaged, setCommitIncludeUnstaged] = useState(true);
  const [commitMessageGenerationPending, setCommitMessageGenerationPending] = useState(false);

  const commitEnabled = gitSummary.isDirty;
  const pushEnabled = canPushGitBranch(gitSummary);
  const currentBranchLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [gitSummary.branchName, gitSummary.headRefType, intl],
  );

  const closeCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogLoading(false);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    setCommitMessageGenerationPending(false);
  }, []);

  const loadCommitDialogState = useCallback(
    async (options?: { resetMessage?: boolean }) => {
      setCommitDialogLoading(true);
      setCommitError(null);
      if (options?.resetMessage) {
        setCommitMessage("");
      }

      try {
        const refreshResult = await gitService.refresh({
          workspacePath,
          includeIdentity: true,
        });
        const rawUnstagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.unstagedChanges);
        const rawStagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.stagedChanges);
        const unstagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawUnstagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        const stagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawStagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        setCommitDialogState({
          summary: refreshResult.summary,
          activeTaskChangeSummary,
          identity: refreshResult.identity,
          stagedFiles,
          unstagedFiles,
        });
        setCommitIncludeUnstaged(unstagedFiles.length > 0);
        setCommitDialogLoading(false);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 读取提交弹窗状态失败", {
          workspacePath,
          error: message,
        });
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.commitDialog.error.requestFailed" },
            { error: message },
          ),
        );
        closeCommitDialog();
      }
    },
    [activeTaskChangeSummary, closeCommitDialog, gitService, intl, workspacePath],
  );

  const openCommitDialog = useCallback(async () => {
    setCommitDialogOpen(true);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    await loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState]);

  const refreshCommitDialogAfterBranchChange = useCallback(() => {
    onRefreshGit();
    void loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState, onRefreshGit]);

  const generateCommitMessage = useCallback(
    async (state: GitCommitDialogState, includeUnstaged: boolean): Promise<string> => {
      const files = getCommitDialogFiles(state, includeUnstaged);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: files.length,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
        includeUnstaged,
        conversationMessageCount: commitMessageConversationContext?.messages.length ?? 0,
      });

      const result = await gitService.generateCommitMessage({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        locale,
        includeUnstaged,
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
        ...(commitMessageConversationContext
          ? { conversationContext: commitMessageConversationContext }
          : {}),
      });

      logger.info("[GitActionMenu] 提交消息生成成功", {
        workspacePath,
        branchName: gitSummary.branchName,
        providerId: result.providerId,
        model: result.model,
      });
      return result.message;
    },
    [
      commitMessageConversationContext,
      gitService,
      gitSummary.branchName,
      locale,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!commitDialogState) {
      return;
    }

    const { stagePaths } = resolveCommitStagePlan(commitDialogState, commitIncludeUnstaged);
    if (stagePaths.length === 0) {
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.noChanges",
        }),
      );
      return;
    }

    setCommitError(null);
    setCommitMessageGenerationPending(true);

    try {
      const nextCommitMessage = await generateCommitMessage(
        commitDialogState,
        commitIncludeUnstaged,
      );
      setCommitMessage(nextCommitMessage);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 生成提交消息失败", {
        workspacePath,
        branchName: gitSummary.branchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.generateFailed",
        }),
      );
    } finally {
      setCommitMessageGenerationPending(false);
    }
  }, [
    commitIncludeUnstaged,
    commitDialogState,
    generateCommitMessage,
    gitSummary.branchName,
    intl,
    workspacePath,
  ]);

  return {
    closeCommitDialog,
    commitDialogLoading,
    commitDialogOpen,
    commitDialogState,
    commitEnabled,
    commitError,
    commitIncludeUnstaged,
    commitMessage,
    commitMessageGenerationPending,
    currentBranchLabel,
    generateCommitMessage,
    handleGenerateCommitMessage,
    openCommitDialog,
    pushEnabled,
    refreshCommitDialogAfterBranchChange,
    setCommitDialogState,
    setCommitError,
    setCommitIncludeUnstaged,
    setCommitMessage,
    setCommitMessageGenerationPending,
  };
}

export type GitActionMenuCommitDialogController = ReturnType<typeof useGitActionMenuCommitDialog>;
