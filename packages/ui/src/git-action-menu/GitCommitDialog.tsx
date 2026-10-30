/**
 * GitActionMenu 的提交弹窗（批次 6 外迁）。
 *
 * 逐字迁移自 `GitActionMenu.tsx`（原行 188-580 的 `GitCommitDialog`），props 契约保持不变；
 * 表单主体按 400 行上限再切到 `GitCommitDialogBody.tsx`（受控渲染），本文件只保留
 * 弹窗 shell / 键盘导航 / 派生状态。主文件仍持有全部 state 与 mutation 编排。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog.js";
import { getGitBranchCommitTotals } from "@/git-branch-switcher/display.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { CloudUploadIcon, GitCommitIcon, LoaderIcon } from "lucide-react";
import {
  TID_GIT_COMMIT_DIALOG,
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  isCommitMessageTextAreaTarget,
  type CommitDialogActionId,
  type GitCommitDialogProps,
} from "@/git-action-menu/gitActionMenuDialogsModel.js";
import {
  GitCommitDialogBody,
  type GitCommitDialogAction,
} from "@/git-action-menu/GitCommitDialogBody.js";

export function GitCommitDialog({
  open,
  loading,
  state,
  workspacePath,
  message,
  error,
  mutationPending,
  generationPending,
  includeUnstaged,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onIncludeUnstagedChange,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useACodeIntl();
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const messageReady = message.trim().length > 0;
  const actionPending = mutationPending || generationPending;
  const selectedFiles = state ? getCommitDialogFiles(state, includeUnstaged) : [];
  const stagePaths = state ? getCommitDialogStagePaths(state, includeUnstaged) : [];
  const dirtyFileCount = state ? getCommitDialogStagePaths(state, true).length : 0;
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedFiles);
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  const hasUnstagedChanges = Boolean(state?.unstagedFiles.length);
  const commitActionDisabled =
    actionPending || !hasSelectedChanges || (!hasIdentity && state?.identity !== null);
  const pushOnlyDisabled = actionPending || !pushEnabled;
  const commitShortcutLabel = formatCommandShortcutLabel("⏎");
  const commitActions = useMemo<GitCommitDialogAction[]>(
    () => [
      {
        id: "commit" as const,
        icon: <GitCommitIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commit",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmit,
      },
      {
        id: "commitAndPush" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commitAndPush",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmitAndPush,
      },
      {
        id: "push" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.push",
        }),
        disabled: pushOnlyDisabled,
        loading: false,
        onSelect: onPushOnly,
      },
    ],
    [
      commitActionDisabled,
      intl,
      mutationPending,
      onPushOnly,
      onSubmit,
      onSubmitAndPush,
      pushOnlyDisabled,
    ],
  );

  useEffect(() => {
    if (open) {
      setSelectedActionId("commit");
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      messageInputFocusedOnOpenRef.current = false;
      return;
    }
    if (loading || !state || actionPending || messageInputFocusedOnOpenRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 打开弹窗后的默认焦点要落在提交信息里，方便立即编辑或生成后微调。
      messageTextareaRef.current?.focus();
      messageInputFocusedOnOpenRef.current = true;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [actionPending, loading, open, state]);

  useEffect(() => {
    // 弹窗加载 Git 状态前提交动作会短暂不可用，不能在 loading 阶段把默认选择跳到推送。
    if (!open || loading || !state || actionPending) {
      return;
    }

    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (selectedAction && !selectedAction.disabled) {
      return;
    }

    const firstEnabledAction = commitActions.find((action) => !action.disabled);
    if (firstEnabledAction && firstEnabledAction.id !== selectedActionId) {
      setSelectedActionId(firstEnabledAction.id);
    }
  }, [actionPending, commitActions, loading, open, selectedActionId, state]);

  const triggerSelectedAction = useCallback(() => {
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (!selectedAction || selectedAction.disabled) {
      return;
    }
    selectedAction.onSelect();
  }, [commitActions, selectedActionId]);

  const selectAdjacentAction = useCallback(
    (direction: 1 | -1) => {
      setSelectedActionId((currentActionId) => {
        const enabledActions = commitActions.filter((action) => !action.disabled);
        if (enabledActions.length === 0) {
          return currentActionId;
        }

        const currentIndex = enabledActions.findIndex((action) => action.id === currentActionId);
        if (currentIndex === -1) {
          return enabledActions[0]?.id ?? currentActionId;
        }

        const nextIndex =
          (currentIndex + direction + enabledActions.length) % enabledActions.length;
        return enabledActions[nextIndex]?.id ?? currentActionId;
      });
    },
    [commitActions],
  );

  const handleActionCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
    },
    [selectAdjacentAction],
  );

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (
        isCommitMessageTextAreaTarget(event.target) &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        // 输入框保持焦点时也允许切换下方 Command 操作，避免键盘流断掉。
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (!matchesPrimaryShortcut(event, "Enter")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerSelectedAction();
    },
    [selectAdjacentAction, triggerSelectedAction],
  );

  const handleActionSelect = useCallback(
    (actionId: CommitDialogActionId) => {
      commitActions.find((action) => action.id === actionId)?.onSelect();
    },
    [commitActions],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_COMMIT_DIALOG}
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden border-popover-border bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(event) => {
          if (!loading && state && !actionPending) {
            event.preventDefault();
          }
        }}
      >
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            className="space-y-0"
            onKeyDownCapture={handleDialogKeyDown}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              triggerSelectedAction();
            }}
          >
            <GitCommitDialogBody
              workspacePath={workspacePath}
              summary={state.summary}
              dirtyFileCount={dirtyFileCount}
              onRefreshGit={onRefreshGit}
              numberFormatter={numberFormatter}
              displayAdded={displayAdded}
              displayRemoved={displayRemoved}
              messageTextareaRef={messageTextareaRef}
              message={message}
              actionPending={actionPending}
              messageReady={messageReady}
              hasSelectedChanges={hasSelectedChanges}
              hasIdentity={hasIdentity}
              identityPresent={state.identity !== null}
              generationPending={generationPending}
              onMessageChange={onMessageChange}
              onGenerateMessage={onGenerateMessage}
              includeUnstaged={includeUnstaged}
              hasUnstagedChanges={hasUnstagedChanges}
              fileCount={fileCount}
              onIncludeUnstagedChange={onIncludeUnstagedChange}
              error={error}
              selectedActionId={selectedActionId}
              onSelectedActionIdChange={setSelectedActionId}
              onActionKeyDown={handleActionCommandKeyDown}
              commitActions={commitActions}
              commitShortcutLabel={commitShortcutLabel}
              onActionSelect={handleActionSelect}
            />
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

