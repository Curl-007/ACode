import { useCallback, useEffect, useState } from "react";
import type {
  GitRefRangeDiffReason,
  GitRefRangeDiffResult,
  GitRefRangeDiffStat,
  GitRefRangeFileChange,
} from "@acode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { logger } from "@/logger.js";
import {
  buildTeamReviewDiffLines,
  TEAM_REVIEW_DIFF_MAX_LINES,
  type TeamPanelReview,
  type TeamReviewUnavailableReason,
} from "@/v4/teamReviewModel.js";

/**
 * 按需读取团队验收的 ref-range diff（R3）。三条不变量：
 * 1. **钉住 SHA**：baseRef/headRef 逐字取 `review.baseCommit` / `review.headCommit`，绝不回落
 *    `HEAD` 或工作区分支（契约 B；EI-9 不悄悄换掉审的对象）；
 * 2. **断连不发起 RPC**：与 useGitRepository 同款 `shouldEnableWorkspaceRpc` 门控；
 * 3. **不缓存跨会话**：结果只活在当前展开详情内，切换 review / 卸载即丢弃。
 * 读取分两次：范围（无 `path`）取文件清单/stat；选中文件（带 `path`）取该文件 patch。
 */

/** 加载分级（EI-98）：100ms 内零反馈 → 100ms 后禁用态 → 1s 后 spinner → 3s 后阶段文字。 */
export type TeamReviewDiffPhase = "quiet" | "waiting" | "spinner" | "staged";

export interface TeamReviewRangeState {
  status: "idle" | "loading" | "ok" | "no_changes" | "unavailable";
  reason?: TeamReviewUnavailableReason;
  summary?: string | null;
  files: GitRefRangeFileChange[];
  /** 结构化清单被整段丢弃（失步标记，EI-97）；与 status 正交，UI 优先呈现它。 */
  filesTruncated: boolean;
  stat: GitRefRangeDiffStat | null;
}

export interface TeamReviewFileState {
  status: "idle" | "loading" | "ok" | "unavailable";
  reason?: TeamReviewUnavailableReason;
  summary?: string | null;
  patchLines: readonly string[];
  truncatedPatch: boolean;
}

export interface UseTeamReviewDiffOptions {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  /** 选中的验收条目；null = 详情未展开（不发任何 RPC）。 */
  review: TeamPanelReview | null;
}

export interface UseTeamReviewDiffResult {
  range: TeamReviewRangeState;
  file: TeamReviewFileState;
  selectedPath: string | null;
  selectFile: (path: string | null) => void;
  reload: () => void;
  loadingPhase: TeamReviewDiffPhase;
  loadingStage: "files" | "diff";
}

const IDLE_RANGE: TeamReviewRangeState = { status: "idle", files: [], filesTruncated: false, stat: null };
const IDLE_FILE: TeamReviewFileState = { status: "idle", patchLines: [], truncatedPatch: false };

/** 前置阻断（不发起 RPC 就要显示的不可用态）：钉住的 SHA 缺失 / 插件声明不可用。 */
function preflightReason(review: TeamPanelReview): TeamReviewUnavailableReason | undefined {
  if (!review.baseCommit || !review.headCommit) return "pinnedMissing";
  if (review.diffAvailable === false) return review.unavailableReason ?? "unknown";
  return undefined;
}

function summaryField(result: GitRefRangeDiffResult): { summary?: string } {
  return typeof result.summary === "string" && result.summary ? { summary: result.summary } : {};
}

/** git reason → UI reason；`ok` / `no_changes` 不是不可用态。 */
function unavailableReason(reason: GitRefRangeDiffReason): TeamReviewUnavailableReason | undefined {
  return reason === "ok" || reason === "no_changes" ? undefined : reason;
}

function toRangeState(result: GitRefRangeDiffResult): TeamReviewRangeState {
  if (result.reason === "ok") {
    return {
      status: "ok",
      files: result.files,
      filesTruncated: result.filesTruncated,
      stat: result.stat,
    };
  }
  if (result.reason === "no_changes") {
    return { status: "no_changes", files: [], filesTruncated: false, stat: result.stat };
  }
  return {
    status: "unavailable",
    reason: unavailableReason(result.reason) ?? "unknown",
    ...summaryField(result),
    files: result.files,
    filesTruncated: result.filesTruncated,
    stat: result.stat,
  };
}

function toFileState(result: GitRefRangeDiffResult): TeamReviewFileState {
  const reason = unavailableReason(result.reason);
  if (reason !== undefined) {
    return { status: "unavailable", reason, ...summaryField(result), patchLines: [], truncatedPatch: false };
  }
  if (result.patch === null) return { status: "ok", patchLines: [], truncatedPatch: false };
  return {
    status: "ok",
    patchLines: buildTeamReviewDiffLines(result.patch),
    truncatedPatch: result.patch.split(/\r?\n/).length > TEAM_REVIEW_DIFF_MAX_LINES,
  };
}

function useLoadingPhase(active: boolean): TeamReviewDiffPhase {
  const [phase, setPhase] = useState<TeamReviewDiffPhase>("quiet");
  useEffect(() => {
    if (!active) {
      setPhase("quiet");
      return;
    }
    const timers = [
      setTimeout(() => setPhase("waiting"), 100),
      setTimeout(() => setPhase("spinner"), 1000),
      setTimeout(() => setPhase("staged"), 3000),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
      setPhase("quiet");
    };
  }, [active]);
  return phase;
}

export function useTeamReviewDiff(options: UseTeamReviewDiffOptions): UseTeamReviewDiffResult {
  const { workspacePath, workspaceIdentity, remoteSessionId, remoteTarget, review } = options;
  const { gitService } = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId ?? null,
    workspaceIdentity ?? null,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId: resolvedRemoteSessionId,
    remoteTarget,
  });
  const [range, setRange] = useState<TeamReviewRangeState>(IDLE_RANGE);
  const [file, setFile] = useState<TeamReviewFileState>(IDLE_FILE);
  const [reloadToken, setReloadToken] = useState(0);
  // 选择与所属 review 绑定：换条目后 selectedPath 自动派生为 null，无需重置副作用。
  const reviewKey = review
    ? `${review.taskId}\u0000${review.baseCommit ?? ""}\u0000${review.headCommit ?? ""}`
    : "";
  const [selection, setSelection] = useState<{ key: string; path: string | null }>({
    key: "",
    path: null,
  });
  const selectedPath = selection.key === reviewKey ? selection.path : null;
  const selectFile = useCallback(
    (path: string | null) => setSelection({ key: reviewKey, path }),
    [reviewKey],
  );
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const blocked = review ? preflightReason(review) : undefined;
  const baseCommit = review?.baseCommit;
  const headCommit = review?.headCommit;
  const fileFetchable = Boolean(
    review && blocked === undefined && workspaceRpcEnabled && baseCommit && headCommit && selectedPath,
  );

  useEffect(() => {
    if (!review) {
      setRange(IDLE_RANGE);
      return;
    }
    if (blocked !== undefined) {
      setRange({ ...IDLE_RANGE, status: "unavailable", reason: blocked });
      return;
    }
    if (!workspaceRpcEnabled) {
      setRange({ ...IDLE_RANGE, status: "unavailable", reason: "disconnected" });
      return;
    }
    if (!baseCommit || !headCommit) return;
    let cancelled = false;
    setRange({ ...IDLE_RANGE, status: "loading" });
    gitService
      .getRefRangeDiff({ workspacePath, baseRef: baseCommit, headRef: headCommit })
      .then((result) => {
        if (!cancelled) setRange(toRangeState(result));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[TeamReview] 读取验收 diff 范围失败", error);
        setRange({ ...IDLE_RANGE, status: "unavailable", reason: "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, [reviewKey, reloadToken, baseCommit, headCommit, blocked, workspaceRpcEnabled, workspacePath, gitService]);

  useEffect(() => {
    if (!fileFetchable || !baseCommit || !headCommit || selectedPath === null) {
      setFile(IDLE_FILE);
      return;
    }
    let cancelled = false;
    setFile({ ...IDLE_FILE, status: "loading" });
    gitService
      .getRefRangeDiff({ workspacePath, baseRef: baseCommit, headRef: headCommit, path: selectedPath })
      .then((result) => {
        if (!cancelled) setFile(toFileState(result));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[TeamReview] 读取验收单文件 diff 失败", error);
        setFile({ ...IDLE_FILE, status: "unavailable", reason: "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, [fileFetchable, reloadToken, baseCommit, headCommit, selectedPath, workspacePath, gitService]);

  const loadingPhase = useLoadingPhase(range.status === "loading" || file.status === "loading");
  return {
    range,
    file,
    selectedPath,
    selectFile,
    reload,
    loadingPhase,
    loadingStage: range.status === "loading" ? "files" : "diff",
  };
}