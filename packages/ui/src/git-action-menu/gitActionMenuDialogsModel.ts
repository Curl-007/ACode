/**
 * GitActionMenu 弹窗族的共享契约（批次 6 外迁）。
 *
 * 承载 commit/push 两个弹窗共用的类型、测试锚点常量与纯决策函数——逐字迁移自
 * `GitActionMenu.tsx` 顶部，零行为改动。主文件与三个弹窗叶子都从这里 import，
 * 避免常量/类型在多个叶子重复声明。
 */
import type { ACodeTaskChangeSummary, GitIdentity, GitRepositorySummary } from "@acode/shared";
import type { buildGitBranchCommitPreviewFiles } from "@/git-branch-switcher/display.js";

export type GitCommitPreviewFile = ReturnType<typeof buildGitBranchCommitPreviewFiles>[number];

export const COMMIT_DIALOG_ACTION_IDS = ["commit", "commitAndPush", "push"] as const;
export const GIT_COMMIT_MESSAGE_TEXTAREA_ID = "git-action-menu-commit-message";
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";

export type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];

export function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

export function isCommitDialogActionId(value: string): value is CommitDialogActionId {
  return COMMIT_DIALOG_ACTION_IDS.includes(value as CommitDialogActionId);
}

export function isCommitMessageTextAreaTarget(
  target: EventTarget | null,
): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.id === GIT_COMMIT_MESSAGE_TEXTAREA_ID;
}

export interface GitCommitDialogState {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  activeTaskChangeSummary: ACodeTaskChangeSummary | null;
  stagedFiles: GitCommitPreviewFile[];
  unstagedFiles: GitCommitPreviewFile[];
}

export interface GitCommitDialogProps {
  open: boolean;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

export function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  return includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles;
}

export function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): string[] {
  return Array.from(
    new Set(getCommitDialogFiles(state, includeUnstaged).map((file) => file.stagePath)),
  );
}
