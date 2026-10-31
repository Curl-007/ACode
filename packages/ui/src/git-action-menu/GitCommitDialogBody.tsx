/**
 * GitActionMenu 提交弹窗的表单体（批次 6 外迁）。
 *
 * 从 `GitCommitDialog.tsx` 按 400 行上限再切一刀：分支头 / 提交信息输入 / 包含未暂存开关 /
 * 操作 Command 四段 JSX 逐字迁入，全部受控（值 + 回调由 `GitCommitDialog` 持有）。
 * 键盘导航与弹窗 shell 仍留在宿主。
 */
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import type { GitRepositorySummary } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { AlertCircleIcon, CheckIcon, LoaderIcon, SparklesIcon } from "lucide-react";
import {
  GIT_COMMIT_MESSAGE_TEXTAREA_ID,
  TID_GIT_COMMIT_ACTION_COMMAND,
  TID_GIT_COMMIT_GENERATE_BUTTON,
  TID_GIT_COMMIT_INCLUDE_UNSTAGED,
  TID_GIT_COMMIT_MESSAGE_INPUT,
  gitCommitActionItemTestId,
  isCommitDialogActionId,
  type CommitDialogActionId,
} from "@/git-action-menu/gitActionMenuDialogsModel.js";

export interface GitCommitDialogAction {
  id: CommitDialogActionId;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  loading: boolean;
  onSelect: () => void;
}

export interface GitCommitDialogBodyProps {
  workspacePath: string;
  summary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  numberFormatter: Intl.NumberFormat;
  displayAdded: number;
  displayRemoved: number;
  messageTextareaRef: RefObject<HTMLTextAreaElement | null>;
  message: string;
  actionPending: boolean;
  messageReady: boolean;
  hasSelectedChanges: boolean;
  hasIdentity: boolean;
  identityPresent: boolean;
  generationPending: boolean;
  onMessageChange: (nextValue: string) => void;
  onGenerateMessage: () => void;
  includeUnstaged: boolean;
  hasUnstagedChanges: boolean;
  fileCount: number;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  error: string | null;
  selectedActionId: CommitDialogActionId;
  onSelectedActionIdChange: (nextValue: CommitDialogActionId) => void;
  onActionKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  commitActions: readonly GitCommitDialogAction[];
  commitShortcutLabel: string;
  onActionSelect: (actionId: CommitDialogActionId) => void;
}

export function GitCommitDialogBody({
  workspacePath,
  summary,
  dirtyFileCount,
  onRefreshGit,
  numberFormatter,
  displayAdded,
  displayRemoved,
  messageTextareaRef,
  message,
  actionPending,
  messageReady,
  hasSelectedChanges,
  hasIdentity,
  identityPresent,
  generationPending,
  onMessageChange,
  onGenerateMessage,
  includeUnstaged,
  hasUnstagedChanges,
  fileCount,
  onIncludeUnstagedChange,
  error,
  selectedActionId,
  onSelectedActionIdChange,
  onActionKeyDown,
  commitActions,
  commitShortcutLabel,
  onActionSelect,
}: GitCommitDialogBodyProps) {
  const { intl } = useACodeIntl();
  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={summary}
          dirtyFileCount={dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="min-w-0 px-0 pt-0"
          triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground [&>span]:max-w-48"
          popoverSide="bottom"
          popoverClassName="w-80"
          branchListClassName="max-h-56"
          showFooterActions={false}
        />
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-ui-base">
          <span className="text-diff-added">+{numberFormatter.format(displayAdded)}</span>
          <span className="text-diff-removed">-{numberFormatter.format(displayRemoved)}</span>
        </div>
      </div>

      <div className="min-h-36 px-4 pb-2">
        <label htmlFor={GIT_COMMIT_MESSAGE_TEXTAREA_ID} className="sr-only">
          {intl.formatMessage({
            id: "git.actionMenu.commitDialog.messageLabel",
          })}
        </label>
        <div className="relative">
          <Textarea
            ref={messageTextareaRef}
            data-testid={TID_GIT_COMMIT_MESSAGE_INPUT}
            id={GIT_COMMIT_MESSAGE_TEXTAREA_ID}
            value={message}
            disabled={actionPending}
            placeholder={intl.formatMessage({
              id: "git.actionMenu.commitDialog.messagePlaceholder",
            })}
            className="field-sizing-fixed min-h-28 rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-ui-base font-medium text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-ui-base"
            onChange={(event) => {
              onMessageChange(event.target.value);
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid={TID_GIT_COMMIT_GENERATE_BUTTON}
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onGenerateMessage}
                disabled={actionPending || !hasSelectedChanges || (!hasIdentity && identityPresent)}
                aria-label={intl.formatMessage({
                  id: messageReady
                    ? "git.actionMenu.commitDialog.regenerate"
                    : "git.actionMenu.commitDialog.generate",
                })}
                className="absolute right-0 top-1.5 text-foreground-subtle hover:text-foreground"
              >
                {generationPending ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <SparklesIcon className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" sideOffset={6}>
              {intl.formatMessage({
                id: messageReady
                  ? "git.actionMenu.commitDialog.regenerate"
                  : "git.actionMenu.commitDialog.generate",
              })}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          role="checkbox"
          data-testid={TID_GIT_COMMIT_INCLUDE_UNSTAGED}
          aria-checked={includeUnstaged}
          disabled={actionPending || !hasUnstagedChanges}
          onClick={() => onIncludeUnstagedChange(!includeUnstaged)}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base font-medium transition-colors",
            actionPending || !hasUnstagedChanges
              ? "cursor-default text-foreground-subtle"
              : "cursor-pointer text-foreground hover:bg-menu-hover",
          )}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-sm border",
                includeUnstaged
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-transparent",
              )}
            >
              <CheckIcon className="size-3.5" />
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage({
              id: "git.actionMenu.commitDialog.includeUnstaged",
            })}
          </span>
          <span className="shrink-0 text-ui-base font-normal text-foreground-subtle">
            {intl.formatMessage(
              {
                id: "git.actionMenu.commitDialog.changesValue",
              },
              {
                count: numberFormatter.format(fileCount),
              },
            )}
          </span>
        </button>
      </div>

      <div className="border-t border-border/50 px-2.5 py-2">
        {!hasIdentity ? (
          <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <p>
              {intl.formatMessage({
                id: "git.actionMenu.commitDialog.identityMissing",
              })}
            </p>
          </div>
        ) : null}

        {error ? <p className="px-3 py-1.5 text-ui-base text-destructive">{error}</p> : null}

        <Command
          data-testid={TID_GIT_COMMIT_ACTION_COMMAND}
          shouldFilter={false}
          loop
          tabIndex={0}
          value={selectedActionId}
          onValueChange={(nextValue) => {
            if (isCommitDialogActionId(nextValue)) {
              onSelectedActionIdChange(nextValue);
            }
          }}
          onKeyDown={onActionKeyDown}
          aria-label={intl.formatMessage({
            id: "git.actionMenu.trigger.ariaLabel",
          })}
          className="rounded-none bg-transparent p-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <CommandList className="max-h-none scroll-py-1">
            {commitActions.map((action) => (
              <CommandItem
                key={action.id}
                data-testid={gitCommitActionItemTestId(action.id)}
                value={action.id}
                disabled={action.disabled}
                onSelect={() => {
                  if (!action.disabled) {
                    onActionSelect(action.id);
                  }
                }}
                className={cn(
                  "h-9 px-2.5 py-1.5 font-medium",
                  action.disabled ? "cursor-default text-foreground-subtlest" : "text-foreground",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {action.loading ? <LoaderIcon className="size-4 animate-spin" /> : action.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {selectedActionId === action.id ? (
                  <CommandShortcut>{commitShortcutLabel}</CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </div>
    </>
  );
}
