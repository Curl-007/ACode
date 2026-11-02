import { useState } from "react";
import type { GitRefRangeDiffStat, GitRefRangeFileChange } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useACodeStoreWithDefault } from "@/store/StoreProvider.js";
import {
  teamReviewUnavailableMessageId,
  teamReviewUnavailableRetryable,
  type TeamPanelReview,
  type TeamPanelReviewCheck,
  type TeamReviewUnavailableReason,
} from "@/v4/teamReviewModel.js";
import type {
  TeamReviewDiffPhase,
  TeamReviewFileState,
  TeamReviewRangeState,
} from "@/hooks/useTeamReviewDiff.js";

/**
 * 验收详情（R3）：检查结果行 + 文件列表 + 选中文件的 unified-diff 文本。
 *
 * 纯展示：读取状态由 useTeamReviewDiff 传入（结果只活在当前展开内，不缓存）。
 * 纪律：一律**按 reason** 选不可用文案（不匹配 summary 字符串）；diff 文本走
 * `codePreviewSettings.fontSizePx` + font-mono（DESIGN.md 的 diff 例外），不新增断点。
 * 检查结果缺席时整行不渲染——不显示空框、不编造「通过」。
 */

const KIND_DOT: Record<GitRefRangeFileChange["kind"], string> = {
  added: "bg-[var(--color-diff-added)]",
  modified: "bg-[var(--color-warning)]",
  deleted: "bg-[var(--color-diff-removed)]",
  renamed: "bg-[var(--color-icon-blue)]",
};

function CheckRow({ check }: { check: TeamPanelReviewCheck }) {
  const { intl } = useACodeIntl();
  const [expanded, setExpanded] = useState(false);
  const label = intl.formatMessage({
    id: check.passed ? "teamPanel.review.check.passed" : "teamPanel.review.check.failed",
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-2 py-1.5"
      data-testid="team-review-check"
      data-check-passed={String(check.passed)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
        <span
          className={cn(
            "shrink-0 rounded-sm px-1 font-medium",
            check.passed
              ? "bg-[var(--color-success)]/15 text-[var(--color-success)]"
              : "bg-[var(--color-destructive)]/15 text-[var(--color-destructive)]",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
          {check.command}
        </span>
        <span className="shrink-0 tabular-nums text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "teamPanel.review.check.exitCode" }, { code: check.exitCode })}
        </span>
        {check.truncated ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "teamPanel.review.check.truncated" })}
          </span>
        ) : null}
      </div>
      {check.summary ? (
        <div className="min-w-0">
          <p
            className={cn(
              "whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground-subtle",
              !expanded && "line-clamp-3",
            )}
          >
            {check.summary}
          </p>
          <button
            className="rounded-md text-ui-xs text-foreground-subtlest outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="team-review-check-toggle"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {intl.formatMessage({
              id: expanded
                ? "teamPanel.review.check.collapse"
                : "teamPanel.review.check.expand",
            })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UnavailableBlock({
  reason,
  summary,
  onReload,
}: {
  reason: TeamReviewUnavailableReason;
  summary?: string | null;
  onReload: () => void;
}) {
  const { intl } = useACodeIntl();
  const retryable = teamReviewUnavailableRetryable(reason);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-foreground-subtle"
      data-testid="team-review-diff-unavailable"
      data-reason={reason}
    >
      <p className="min-w-0 break-words">
        {intl.formatMessage({ id: teamReviewUnavailableMessageId(reason) })}
      </p>
      {summary ? (
        <p className="min-w-0 break-words text-ui-xs text-foreground-subtlest">{summary}</p>
      ) : null}
      {retryable ? (
        <button
          className="self-start rounded-md px-1.5 text-ui-xs text-foreground-subtle outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="team-review-diff-retry"
          type="button"
          onClick={onReload}
        >
          {intl.formatMessage({ id: "teamPanel.review.retry" })}
        </button>
      ) : null}
    </div>
  );
}

function FileList({
  files,
  stat,
  selectedPath,
  onSelectFile,
}: {
  files: readonly GitRefRangeFileChange[];
  stat: GitRefRangeDiffStat | null;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
}) {
  const { intl } = useACodeIntl();
  if (files.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid="team-review-files">
      <p className="px-1 text-ui-xs text-foreground-subtlest">
        {intl.formatMessage(
          { id: "teamPanel.review.filesTitle" },
          {
            count: stat?.fileCount ?? files.length,
            added: stat?.added ?? 0,
            removed: stat?.removed ?? 0,
          },
        )}
      </p>
      {files.map((file) => (
        <button
          className={cn(
            "flex min-h-7 min-w-0 items-center gap-2 rounded-lg px-1.5 text-left text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            selectedPath === file.path
              ? "bg-selected text-foreground"
              : "text-foreground-subtle hover:bg-[var(--color-hover)]",
          )}
          data-review-file={file.path}
          key={file.path}
          type="button"
          onClick={() => onSelectFile(selectedPath === file.path ? null : file.path)}
        >
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", KIND_DOT[file.kind])} />
          <span className="min-w-0 flex-1 truncate" title={file.path}>
            {file.path}
          </span>
          <span className="shrink-0 tabular-nums text-ui-xs">
            <span className="text-[var(--color-diff-added)]">+{file.added}</span>{" "}
            <span className="text-[var(--color-diff-removed)]">−{file.removed}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function TeamReviewDetail({
  review,
  range,
  file,
  selectedPath,
  loadingPhase,
  loadingStage,
  onSelectFile,
  onReload,
}: {
  review: TeamPanelReview;
  range: TeamReviewRangeState;
  file: TeamReviewFileState;
  selectedPath: string | null;
  loadingPhase: TeamReviewDiffPhase;
  loadingStage: "files" | "diff";
  onSelectFile: (path: string | null) => void;
  onReload: () => void;
}) {
  const { intl } = useACodeIntl();
  // diff 文本是非 text-ui-* 的例外：走代码预览字号（与 LightweightDiffPreview / GitPane 同源）。
  const codePreviewSettings = useACodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const loadingLabel = (): string | null => {
    if (loadingPhase !== "staged") return null;
    return intl.formatMessage({
      id: loadingStage === "files" ? "teamPanel.review.loadingFiles" : "teamPanel.review.loadingDiff",
    });
  };
  const stageLabel = loadingLabel();
  return (
    <div className="flex min-w-0 flex-col gap-2 pl-1" data-testid="team-review-detail">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-ui-xs text-foreground-subtlest">
        <span className="font-mono">{review.taskId}</span>
        <span>{review.member}</span>
        {review.baseCommit && review.headCommit ? (
          <span className="min-w-0 truncate font-mono" title={`${review.baseCommit}..${review.headCommit}`}>
            {review.baseCommit.slice(0, 7)}..{review.headCommit.slice(0, 7)}
          </span>
        ) : null}
      </div>
      {review.check ? <CheckRow check={review.check} /> : null}
      {range.status === "unavailable" ? (
        <UnavailableBlock
          reason={range.reason ?? "unknown"}
          {...(range.summary ? { summary: range.summary } : {})}
          onReload={onReload}
        />
      ) : null}
      {range.status === "no_changes" ? (
        <p
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-foreground-subtle"
          data-testid="team-review-no-changes"
        >
          {intl.formatMessage({ id: "teamPanel.review.noChanges" })}
        </p>
      ) : null}
      {range.filesTruncated ? (
        <div
          className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-foreground-subtle"
          data-testid="team-review-files-truncated"
        >
          <p className="min-w-0 break-words">
            {intl.formatMessage({ id: "teamPanel.review.filesTruncated" })}
          </p>
          <button
            className="self-start rounded-md px-1.5 text-ui-xs outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="team-review-files-retry"
            type="button"
            onClick={onReload}
          >
            {intl.formatMessage({ id: "teamPanel.review.retry" })}
          </button>
        </div>
      ) : null}
      {range.status === "loading" ? (
        <p
          className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle"
          data-testid="team-review-loading"
          data-phase={loadingPhase}
        >
          {loadingPhase === "spinner" || loadingPhase === "staged" ? (
            <span
              aria-hidden
              className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-foreground-subtlest border-t-transparent"
            />
          ) : null}
          {stageLabel ?? (loadingPhase === "quiet" ? null : "…")}
        </p>
      ) : null}
      {range.status === "ok" && !range.filesTruncated ? (
        <FileList
          files={range.files}
          stat={range.stat}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ) : null}
      {file.status === "loading" ? (
        <p
          className="flex min-w-0 items-center gap-2 text-ui-sm text-foreground-subtle"
          data-testid="team-review-file-loading"
          data-phase={loadingPhase}
        >
          {loadingPhase === "spinner" || loadingPhase === "staged" ? (
            <span
              aria-hidden
              className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-foreground-subtlest border-t-transparent"
            />
          ) : null}
          {intl.formatMessage({ id: "teamPanel.review.loadingDiff" })}
        </p>
      ) : null}
      {file.status === "unavailable" ? (
        <UnavailableBlock
          reason={file.reason ?? "unknown"}
          {...(file.summary ? { summary: file.summary } : {})}
          onReload={onReload}
        />
      ) : null}
      {file.status === "ok" && file.patchLines.length > 0 ? (
        <div
          className="min-w-0 max-h-[60vh] overflow-auto rounded-lg border border-border bg-background"
          data-testid="team-review-diff"
          data-truncated={String(file.truncatedPatch)}
        >
          <LightweightDiffPreview codePreviewSettings={codePreviewSettings} lines={file.patchLines} />
        </div>
      ) : null}
      {file.status === "ok" && file.patchLines.length === 0 && selectedPath ? (
        <p className="text-ui-sm text-foreground-subtlest" data-testid="team-review-binary">
          {intl.formatMessage({ id: "teamPanel.review.noChanges" })}
        </p>
      ) : null}
    </div>
  );
}