/**
 * GitActionMenu 的 trigger 状态机 + mutation 编排（批次 7 外迁，模式 B）。
 *
 * 主组件原先的 10 个 state / 7 个派生值 / 12 个回调收口到这里。提交弹窗的状态与读取/生成
 * 编排在 `useGitActionMenuCommitDialog.ts`（本 hook 首版 563 行超 400，按职责再切一刀），
 * 本 hook 负责 trigger 派生、提交动作编排与推送弹窗。
 *
 * 判定部分在 `gitActionMenuCommitFlow.ts`（纯决策表，可无 DOM 单测）；本 hook 只做副作用编排
 * （RPC 调用 / setState / logger / toast）。hook 内部顺序与 deps 逐字对齐迁移前。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ACodeTaskChangeSummary,
  GitCommitMessageConversationContext,
  GitRepositorySummary,
} from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import {
  canUseGitActionMenu,
  resolveGitActionMenuPrimaryAction,
} from "@/git-action-menu/display.js";
import {
  resolveCommitFailureErrorId,
  resolveCommitPreflight,
  resolveCommitStagePlan,
  resolveCommitSuccessToastId,
  resolveTriggerDisabled,
  shouldGenerateCommitMessage,
} from "@/git-action-menu/gitActionMenuCommitFlow.js";
import { useGitActionMenuCommitDialog } from "@/git-action-menu/useGitActionMenuCommitDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export interface GitActionMenuControllerInput {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary: ACodeTaskChangeSummary | null;
  commitMessageConversationContext: GitCommitMessageConversationContext | null;
  onRefreshGit: () => void;
}

export function useGitActionMenuController({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary,
  commitMessageConversationContext,
  onRefreshGit,
}: GitActionMenuControllerInput) {
  const { gitService } = useServices();
  const { intl } = useACodeIntl();
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);

  const commitDialog = useGitActionMenuCommitDialog({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    gitSummary,
    activeTaskChangeSummary,
    commitMessageConversationContext,
    onRefreshGit,
  });
  const {
    closeCommitDialog,
    commitDialogLoading,
    commitDialogOpen,
    commitDialogState,
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
    setCommitError,
    setCommitIncludeUnstaged,
    setCommitMessage,
    setCommitMessageGenerationPending,
  } = commitDialog;

  const actionAvailable = canUseGitActionMenu(gitSummary);
  const triggerPending = mutationPending || commitMessageGenerationPending || commitDialogLoading;
  const primaryActionId = useMemo(
    () =>
      resolveGitActionMenuPrimaryAction({
        actionAvailable,
        commitEnabled: gitSummary.isDirty,
        pushEnabled,
      }),
    [actionAvailable, gitSummary.isDirty, pushEnabled],
  );
  const primaryActionDisabled = resolveTriggerDisabled({
    actionAvailable,
    triggerPending,
    primaryActionId,
  });

  useEffect(() => {
    // 顶部 commit 入口改成“始终展示、异常时置灰”后，
    // 这里记录低频可用性日志，方便继续区分是仓库探测失败，
    // 还是 UI 交互本身出现了禁用/启用状态不一致。
    logger.info("[GitActionMenu] 顶部 Git 操作入口可用性变化", {
      workspacePath,
      available: actionAvailable,
      primaryActionDisabled,
      primaryActionId,
      isGitAvailable: gitSummary.isGitAvailable,
      isRepository: gitSummary.isRepository,
      headRefType: gitSummary.headRefType,
      branchName: gitSummary.branchName,
      trackingBranchName: gitSummary.trackingBranchName,
      isDirty: gitSummary.isDirty,
    });
  }, [
    gitSummary.branchName,
    gitSummary.headRefType,
    gitSummary.isDirty,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    gitSummary.trackingBranchName,
    actionAvailable,
    primaryActionId,
    primaryActionDisabled,
    workspacePath,
  ]);

  const closePushDialog = useCallback(() => {
    setPushDialogOpen(false);
    setPushError(null);
  }, []);

  const openPushDialog = useCallback(() => {
    setPushError(null);
    setPushDialogOpen(true);
  }, []);

  const pushCurrentBranch = useCallback(
    async (options?: { showToast?: boolean }) => {
      const result = await gitService.push({ workspacePath });
      logger.info("[GitActionMenu] 推送更改成功", {
        workspacePath,
        branchName: result.branchName,
        trackingBranchName: result.trackingBranchName,
        remoteName: result.remoteName,
        setUpstream: result.setUpstream,
      });
      if (options?.showToast !== false) {
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.toast.success" },
            {
              target:
                result.trackingBranchName?.trim() ||
                result.branchName?.trim() ||
                currentBranchLabel,
            },
          ),
        );
      }
      return result;
    },
    [currentBranchLabel, gitService, intl, workspacePath],
  );

  const handleCommitAction = useCallback(
    async (options?: { pushAfterCommit?: boolean }) => {
      if (!commitDialogState) {
        return;
      }

      const hasIdentity = hasGitCommitIdentity(commitDialogState.identity);
      const includeUnstaged = commitIncludeUnstaged;
      const { stagePaths, pathsToStage } = resolveCommitStagePlan(commitDialogState, includeUnstaged);
      // 判定顺序与迁移前逐字一致：先 identity、再 no-changes（两步都用同一份 stagePaths）。
      const preflight = resolveCommitPreflight({
        hasIdentity,
        stagePathCount: stagePaths.length,
      });
      if (preflight === "identity-missing") {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.identityMissing",
          }),
        );
        return;
      }

      if (preflight === "no-changes") {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.error.noChanges",
          }),
        );
        return;
      }

      let nextCommitMessage = commitMessage.trim();
      if (shouldGenerateCommitMessage(nextCommitMessage)) {
        setCommitError(null);
        setCommitMessageGenerationPending(true);
        try {
          nextCommitMessage = await generateCommitMessage(commitDialogState, includeUnstaged);
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
          return;
        } finally {
          setCommitMessageGenerationPending(false);
        }
      }

      setCommitError(null);
      setMutationPending(true);
      let committed = false;

      try {
        logger.info("[GitActionMenu] 开始提交当前更改", {
          workspacePath,
          branchName: gitSummary.branchName,
          selectedPathCount: stagePaths.length,
          stagedPathCount: pathsToStage.length,
          includeUnstaged,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        if (pathsToStage.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: pathsToStage,
          });
        }
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths: stagePaths,
          stagedOnly: !includeUnstaged,
        });
        committed = true;

        if (options?.pushAfterCommit) {
          await pushCurrentBranch({ showToast: false });
        }

        logger.info("[GitActionMenu] 提交当前更改成功", {
          workspacePath,
          branchName: gitSummary.branchName,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        toast(
          intl.formatMessage({
            id: resolveCommitSuccessToastId(Boolean(options?.pushAfterCommit)),
          }),
        );
        closeCommitDialog();
        onRefreshGit();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 提交当前更改失败", {
          workspacePath,
          error: message,
          committed,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        setCommitError(
          intl.formatMessage(
            {
              id: resolveCommitFailureErrorId({
                committed,
                pushAfterCommit: Boolean(options?.pushAfterCommit),
              }),
            },
            { error: message },
          ),
        );
        if (committed) {
          onRefreshGit();
        }
      } finally {
        setMutationPending(false);
      }
    },
    [
      closeCommitDialog,
      commitIncludeUnstaged,
      commitDialogState,
      commitMessage,
      generateCommitMessage,
      gitService,
      gitSummary.branchName,
      intl,
      onRefreshGit,
      pushCurrentBranch,
      setCommitError,
      setCommitMessage,
      setCommitMessageGenerationPending,
      workspacePath,
    ],
  );

  const handleCommitSubmit = useCallback(async () => {
    await handleCommitAction();
  }, [handleCommitAction]);

  const handleCommitAndPushSubmit = useCallback(async () => {
    await handleCommitAction({ pushAfterCommit: true });
  }, [handleCommitAction]);

  const handlePushSubmit = useCallback(async () => {
    if (!pushEnabled) {
      return;
    }

    setMutationPending(true);
    setPushError(null);

    try {
      await pushCurrentBranch();
      closePushDialog();
      onRefreshGit();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 推送更改失败", {
        workspacePath,
        error: message,
      });
      setPushError(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [closePushDialog, intl, onRefreshGit, pushCurrentBranch, pushEnabled, workspacePath]);

  const handlePrimaryAction = useCallback(() => {
    if (primaryActionDisabled) {
      return;
    }

    if (primaryActionId === "push") {
      openPushDialog();
      return;
    }
    void openCommitDialog();
  }, [openCommitDialog, openPushDialog, primaryActionId, primaryActionDisabled]);

  return {
    actionAvailable,
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
  };
}

export type GitActionMenuController = ReturnType<typeof useGitActionMenuController>;
