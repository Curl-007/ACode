/**
 * GitActionMenu 提交/推送流程的纯决策表（批次 7 外迁）。
 *
 * 逐字迁出 `GitActionMenu.tsx` 里 `handleCommitAction` / `handleGenerateCommitMessage` 与
 * trigger 派生值的**判定部分**——这些判定原先夹在 async 编排里，无法在无 DOM 环境下覆盖。
 * 本模块只回答「该走哪条分支 / 该用哪个 toast key」，副作用（RPC、setState、日志）仍留在
 * `useGitActionMenuCommitDialog` / `useGitActionMenuPush` / `useGitActionMenuController`。
 *
 * 与原实现逐条对应：
 * - `getCommitDialogStagePaths` 仍是文件集合的唯一来源（本模块只做 includeUnstaged 的路径投影）；
 * - 身份缺失判定必须先于「无变更」判定（原顺序：identity → stagePaths），`resolveCommitPreflight`
 *   用两个独立输入保持该优先级；
 * - 提交信息为空才自动生成（`trim()` 为空）。
 */
import type { GitCommitDialogState } from "@/git-action-menu/gitActionMenuDialogsModel.js";
import { getCommitDialogStagePaths } from "@/git-action-menu/gitActionMenuDialogsModel.js";

export interface CommitStagePlan {
  /** 提交动作覆盖的文件集合（staged-only 时只有已暂存）。 */
  stagePaths: string[];
  /** 需要先 `stagePaths` 的路径；staged-only 提交不暂存任何东西。 */
  pathsToStage: string[];
}

/** 提交前对文件集合的投影：includeUnstaged 决定是否把未暂存文件纳入提交与暂存。 */
export function resolveCommitStagePlan(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): CommitStagePlan {
  const stagePaths = getCommitDialogStagePaths(state, includeUnstaged);
  return {
    stagePaths,
    pathsToStage: includeUnstaged ? stagePaths : [],
  };
}

/** 提交/生成动作的前置门。identity 优先于 no-changes（与原编排的判断顺序一致）。 */
export type CommitPreflightOutcome = "identity-missing" | "no-changes" | "ready";

export function resolveCommitPreflight(options: {
  hasIdentity: boolean;
  stagePathCount: number;
}): CommitPreflightOutcome {
  if (!options.hasIdentity) {
    return "identity-missing";
  }
  if (options.stagePathCount === 0) {
    return "no-changes";
  }
  return "ready";
}

/** 提交信息为空（trim 后）时才需要自动生成；已有内容一律尊重用户输入。 */
export function shouldGenerateCommitMessage(commitMessage: string): boolean {
  return commitMessage.trim().length === 0;
}

/** 提交成功的 toast key：commitAndPush 有独立文案。 */
export function resolveCommitSuccessToastId(pushAfterCommit: boolean): string {
  return pushAfterCommit
    ? "git.actionMenu.commitDialog.toast.commitAndPushSuccess"
    : "git.actionMenu.commitDialog.toast.success";
}

/**
 * 提交失败时的错误 key：
 * - 尚未提交成功 → 通用 requestFailed；
 * - 已提交成功但随后的 push 失败 → 专用 pushAfterCommitFailed（此时提交已经落地，不能误导用户重试提交）。
 */
export function resolveCommitFailureErrorId(options: {
  committed: boolean;
  pushAfterCommit: boolean;
}): string {
  return options.committed && options.pushAfterCommit
    ? "git.actionMenu.commitDialog.error.pushAfterCommitFailed"
    : "git.actionMenu.commitDialog.error.requestFailed";
}

/** 顶部主按钮的三态图标：pending 时直接替换动作图标（避免额外 loading 图标挤宽紧凑头部）。 */
export type GitActionMenuTriggerIconKind = "pending" | "push" | "commit";

export function resolveTriggerIconKind(options: {
  triggerPending: boolean;
  primaryActionId: "commit" | "push" | null;
}): GitActionMenuTriggerIconKind {
  if (options.triggerPending) {
    return "pending";
  }
  return options.primaryActionId === "push" ? "push" : "commit";
}

/** 主按钮禁用条件：不可用 / 有 pending / 没有可执行的主动作。 */
export function resolveTriggerDisabled(options: {
  actionAvailable: boolean;
  triggerPending: boolean;
  primaryActionId: "commit" | "push" | null;
}): boolean {
  return !options.actionAvailable || options.triggerPending || options.primaryActionId === null;
}
