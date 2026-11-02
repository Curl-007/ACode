import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamReviewEntry } from "../src/components/TeamReviewEntry.js";
import { TeamReviewList } from "../src/components/TeamReviewList.js";
import { TeamReviewDetail } from "../src/components/TeamReviewDetail.js";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { buildConversationStatusPanelTeam } from "../src/v4/teamPanelModel.js";
import type { TeamPanelReview } from "../src/v4/teamReviewModel.js";
import type { TeamReviewRangeState, TeamReviewFileState } from "../src/hooks/useTeamReviewDiff.js";

const localeResource = getLocaleMessagesResource("en-US");
if (localeResource.state === "pending") await localeResource.promise;

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ACodeIntlProvider, { initialLocale: "en-US", children: node }),
  );
}

const stateKey = "agent-teams@acode-plugins-official:agent-teams";

function teamWith(countInReview: number) {
  return buildConversationStatusPanelTeam({
    [stateKey]: {
      v: 1,
      teamId: "team-1",
      goal: "ship",
      status: "active",
      counts: { done: 0, inProgress: 0, todo: 0, inReview: countInReview, failed: 0, blocked: 0 },
      members: [],
      tasks: [],
      readyTaskIds: [],
      blockedByFailedQuality: [],
    },
  })!;
}

const RANGE_EMPTY: TeamReviewRangeState = {
  status: "idle",
  files: [],
  filesTruncated: false,
  stat: null,
};
const FILE_EMPTY: TeamReviewFileState = { status: "idle", patchLines: [], truncatedPatch: false };

function detail(review: TeamPanelReview, range = RANGE_EMPTY, file = FILE_EMPTY): string {
  return render(
    createElement(TeamReviewDetail, {
      review,
      range,
      file,
      selectedPath: null,
      loadingPhase: "quiet",
      loadingStage: "files",
      onSelectFile: () => {},
      onReload: () => {},
    }),
  );
}

test("review entry is absent without pending tasks or without an opener", () => {
  assert.equal(render(createElement(TeamReviewEntry, { team: teamWith(0), onOpen: () => {} })), "");
  assert.equal(render(createElement(TeamReviewEntry, { team: teamWith(3) })), "");
  const html = render(createElement(TeamReviewEntry, { team: teamWith(3), onOpen: () => {} }));
  assert.match(html, /3 awaiting review/u);
  assert.match(html, /data-testid="team-review-entry"/u);
});

test("review list groups by status and folds long groups by default", () => {
  const short = render(
    createElement(TeamReviewList, {
      reviews: [
        { taskId: "t-1", member: "dev", status: "in_review" },
        { taskId: "t-2", member: "qa", status: "merged" },
      ] as TeamPanelReview[],
      expandedTaskId: "t-1",
      onToggleReview: () => {},
    }),
  );
  assert.match(short, /data-review-group="in_review"/u);
  assert.match(short, /data-review-group="merged"/u);
  assert.match(short, /data-review-task-id="t-1"/u);
  // 行上「查看 diff」带 aria-expanded（展开态）。英文文案里含引号被转义，只断言 aria 属性。
  assert.match(short, /aria-expanded="true"/u);
  const long = Array.from({ length: 6 }, (_, i) => ({
    taskId: `t-${i}`,
    member: "dev",
    status: "merged",
  })) as TeamPanelReview[];
  const folded = render(
    createElement(TeamReviewList, { reviews: long, expandedTaskId: null, onToggleReview: () => {} }),
  );
  assert.match(folded, /data-review-group="merged"/u);
  assert.match(folded, /aria-expanded="false"/u);
  assert.doesNotMatch(folded, /data-review-task-id="t-0"/u);
});

test("review detail hidden pieces: no check row, no_changes copy, reason-driven unavailable text", () => {
  const review: TeamPanelReview = {
    taskId: "t-1",
    member: "dev",
    status: "in_review",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
  };
  const plain = detail(review);
  // 无 check → 该行缺席（不显示空框、不编造通过）。
  assert.doesNotMatch(plain, /data-testid="team-review-check"/u);
  const noChanges = detail(review, { ...RANGE_EMPTY, status: "no_changes", stat: null });
  assert.match(noChanges, /data-testid="team-review-no-changes"/u);
  assert.doesNotMatch(noChanges, /data-testid="team-review-diff-retry"/u);
  const unresolved = detail(review, {
    ...RANGE_EMPTY,
    status: "unavailable",
    reason: "ref_unresolved",
  });
  assert.match(unresolved, /data-reason="ref_unresolved"/u);
  assert.match(unresolved, /worktree was cleaned up and the commits are unreachable/u);
  assert.match(unresolved, /data-testid="team-review-diff-retry"/u);
  const pinnedMissing = detail(review, {
    ...RANGE_EMPTY,
    status: "unavailable",
    reason: "pinnedMissing",
  });
  assert.match(pinnedMissing, /agent_teams_review_member_diff/u);
  assert.doesNotMatch(pinnedMissing, /data-testid="team-review-diff-retry"/u);
  const truncatedFiles = detail(review, { ...RANGE_EMPTY, status: "ok", filesTruncated: true });
  assert.match(truncatedFiles, /data-testid="team-review-files-truncated"/u);
  assert.match(truncatedFiles, /data-testid="team-review-files-retry"/u);
});

test("review detail renders the check row, file list and bounded diff", () => {
  const review: TeamPanelReview = {
    taskId: "t-1",
    member: "dev",
    status: "merged",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    check: {
      command: "pnpm test",
      exitCode: 1,
      passed: false,
      summary: "1 failing",
      truncated: true,
      ranAt: "now",
    },
  };
  const html = detail(
    review,
    {
      status: "ok",
      files: [{ path: "src/a.ts", originalPath: null, kind: "modified", added: 3, removed: 2 }],
      filesTruncated: false,
      stat: { added: 3, removed: 2, fileCount: 1 },
    },
    { status: "ok", patchLines: ["@@ -1 +1 @@", "-old", "+new"], truncatedPatch: true },
  );
  assert.match(html, /data-testid="team-review-check"/u);
  assert.match(html, /data-check-passed="false"/u);
  assert.match(html, /Checks failed/u);
  assert.match(html, /Exit code 1/u);
  assert.match(html, /Output truncated/u);
  assert.match(html, /data-testid="team-review-files"/u);
  assert.match(html, /src\/a\.ts/u);
  assert.match(html, /data-testid="team-review-diff"/u);
  assert.match(html, /data-truncated="true"/u);
});