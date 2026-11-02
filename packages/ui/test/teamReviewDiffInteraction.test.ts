import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@acode/services";
import type { GitRefRangeDiffRequest, GitRefRangeDiffResult } from "@acode/shared";
import "./helpers/minimal-dom-shim.js";
import { MiniDocument } from "./helpers/minimal-dom-shim.js";
import { useTeamReviewDiff, type UseTeamReviewDiffResult } from "../src/hooks/useTeamReviewDiff.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import type { TeamPanelReview } from "../src/v4/teamReviewModel.js";

/**
 * 验收 diff 读取的接线与入参断言（R3/R11）。
 *
 * 这里不做 UI 交互 E2E（spec「未做」#5 已登记），只钉住最容易悄悄错的两件事：
 * 1. **钉住 SHA**：请求逐字带 `review.baseCommit` / `review.headCommit`，全文不出现 `HEAD`；
 * 2. **断连不发起 RPC**：`shouldEnableWorkspaceRpc` 为假时一次调用都不产生。
 * 其余用源文本断言钉住页签显隐、组序与唯一写入通道。
 */

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const REVIEW: TeamPanelReview = {
  taskId: "t-1",
  member: "dev",
  status: "in_review",
  baseCommit: BASE,
  headCommit: HEAD,
};

const OK_RESULT: GitRefRangeDiffResult = {
  baseRef: BASE,
  headRef: HEAD,
  resolvedBase: BASE,
  resolvedHead: HEAD,
  availability: "patch",
  reason: "ok",
  files: [{ path: "src/a.ts", originalPath: null, kind: "modified", added: 1, removed: 1 }],
  filesTruncated: false,
  stat: { added: 1, removed: 1, fileCount: 1 },
  patch: "@@ -1 +1 @@\n-old\n+new",
  summary: null,
};

/** 去注释后再做源文本断言：注释里写「绝不回落 HEAD」不应被当成代码里的 HEAD 使用。 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
}

async function sourceOf(relative: string): Promise<string> {
  return await readFile(new URL(relative, import.meta.url), "utf8");
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountDiff(options: {
  review: TeamPanelReview | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  calls: GitRefRangeDiffRequest[];
}): { ref: { current: UseTeamReviewDiffResult | null }; unmount: () => void } {
  const doc = new MiniDocument();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const ref: { current: UseTeamReviewDiffResult | null } = { current: null };
  function Probe() {
    ref.current = useTeamReviewDiff({
      workspacePath: "/w",
      workspaceIdentity: options.workspaceIdentity ?? null,
      remoteSessionId: options.remoteSessionId ?? null,
      review: options.review,
    });
    return null;
  }
  const services = {
    gitService: {
      getRefRangeDiff: async (params: GitRefRangeDiffRequest) => {
        options.calls.push(params);
        return OK_RESULT;
      },
    },
  } as unknown as IServiceAccessor;
  flushSync(() =>
    root.render(
      createElement(ServiceProvider, {
        services,
        children: createElement(
          TabStoreProvider,
          null,
          createElement(Probe),
        ),
      }),
    ),
  );
  return {
    ref,
    unmount: () => flushSync(() => root.unmount()),
  };
}

test("range read pins both SHAs and never falls back to HEAD", async () => {
  const calls: GitRefRangeDiffRequest[] = [];
  const mounted = mountDiff({ review: REVIEW, calls });
  try {
    await tick();
    flushSync(() => {});
    assert.deepEqual(calls[0], { workspacePath: "/w", baseRef: BASE, headRef: HEAD });
    assert.equal("path" in (calls[0] ?? {}), false);
    // 逐字钉住：introduced 里不出现 HEAD（防日后有人加回落兜底）。
    assert.doesNotMatch(JSON.stringify(calls), /HEAD/u);
  } finally {
    mounted.unmount();
  }
});

test("selecting a file refetches that path with the same pinned SHAs", async () => {
  const calls: GitRefRangeDiffRequest[] = [];
  const mounted = mountDiff({ review: REVIEW, calls });
  try {
    await tick();
    flushSync(() => {});
    flushSync(() => mounted.ref.current!.selectFile("src/a.ts"));
    await tick();
    flushSync(() => {});
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {
      workspacePath: "/w",
      baseRef: BASE,
      headRef: HEAD,
      path: "src/a.ts",
    });
    assert.equal(mounted.ref.current!.selectedPath, "src/a.ts");
    assert.doesNotMatch(JSON.stringify(calls), /HEAD/u);
  } finally {
    mounted.unmount();
  }
});

test("no RPC is issued while the remote workspace is disconnected", async () => {
  const calls: GitRefRangeDiffRequest[] = [];
  const mounted = mountDiff({ review: REVIEW, workspaceIdentity: "remote:/w", calls });
  try {
    await tick();
    flushSync(() => {});
    assert.equal(calls.length, 0);
    assert.equal(mounted.ref.current!.range.status, "unavailable");
    assert.equal(mounted.ref.current!.range.reason, "disconnected");
  } finally {
    mounted.unmount();
  }
});

test("missing pinned commits or a plugin declared-unavailable diff never issues an RPC", async () => {
  const calls: GitRefRangeDiffRequest[] = [];
  const pinnedMissing = mountDiff({ review: { ...REVIEW, headCommit: undefined }, calls });
  try {
    await tick();
    flushSync(() => {});
    assert.equal(calls.length, 0);
    assert.equal(pinnedMissing.ref.current!.range.reason, "pinnedMissing");
  } finally {
    pinnedMissing.unmount();
  }
  const declared = mountDiff({
    review: { ...REVIEW, diffAvailable: false, unavailableReason: "worktree_cleaned" },
    calls,
  });
  try {
    await tick();
    flushSync(() => {});
    assert.equal(calls.length, 0);
    assert.equal(declared.ref.current!.range.reason, "worktree_cleaned");
  } finally {
    declared.unmount();
  }
});

test("hook code gates on shouldEnableWorkspaceRpc and pins the SHA parameters", async () => {
  const code = stripComments(await sourceOf("../src/hooks/useTeamReviewDiff.ts"));
  assert.match(code, /shouldEnableWorkspaceRpc/u);
  assert.match(code, /baseRef: baseCommit/u);
  assert.match(code, /headRef: headCommit/u);
  assert.doesNotMatch(code, /HEAD/u);
});

test("review tab only appears for a non-empty reviews[] and honors the landing focusTab", async () => {
  const code = await sourceOf("../src/app-shell/TeamSidePaneView.tsx");
  assert.match(code, /team\.reviews\.length > 0 \? \(\["review"\] as PanelTab\[\]\)/u);
  assert.match(code, /tab\.focusTab \?\? "overview"/u);
});

test("task board lists the review group first", async () => {
  const code = await sourceOf("../src/app-shell/TeamSidePaneTasks.tsx");
  assert.ok(
    code.indexOf('["review"') < code.indexOf('["inProgress"'),
    "待验收分组必须排在任务板分组序最前",
  );
});

test("composer actions only insert text and never send or offer accept/merge", async () => {
  const actions = stripComments(await sourceOf("../src/components/TeamReviewActions.tsx"));
  assert.match(actions, /insertTeamText/u);
  assert.doesNotMatch(actions, /accept|merge|合并|接受/u);
  const insertHook = stripComments(await sourceOf("../src/hooks/useTeamComposerInsert.ts"));
  assert.match(insertHook, /requestComposerTextInsert/u);
  assert.match(insertHook, /"append"/u);
  assert.doesNotMatch(insertHook, /\.send(Text)?\(/u);
});

test("team card hosts the review entry and the shared metrics row", async () => {
  const code = await sourceOf("../src/components/TeamWorkflowCard.tsx");
  assert.match(code, /<TeamReviewEntry/u);
  assert.match(code, /<TeamAcceptanceMetricsRow/u);
});