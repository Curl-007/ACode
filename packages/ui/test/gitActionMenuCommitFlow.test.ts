import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCommitFailureErrorId,
  resolveCommitPreflight,
  resolveCommitStagePlan,
  resolveCommitSuccessToastId,
  resolveTriggerDisabled,
  resolveTriggerIconKind,
  shouldGenerateCommitMessage,
} from "../src/git-action-menu/gitActionMenuCommitFlow.js";
import type { GitCommitDialogState } from "../src/git-action-menu/gitActionMenuDialogsModel.js";

/**
 * GitActionMenu 批次 7 外迁（gitActionMenuCommitFlow.ts）的决策表单测。
 *
 * 覆盖从 `handleCommitAction` / `handleGenerateCommitMessage` 里抽出的纯判定：
 * 提交前置门优先级（identity → no-changes → ready）× 暂存计划投影 ×
 * 自动生成提交信息条件 × 成功/失败 toast key × trigger 三态图标与禁用条件。
 */

const file = (stagePath: string) => ({
  stagePath,
  path: stagePath,
  status: "modified" as const,
});

const state = (
  overrides: Partial<GitCommitDialogState> = {},
): GitCommitDialogState =>
  ({
    summary: { isDirty: true },
    identity: { name: "n", email: "e" },
    activeTaskChangeSummary: null,
    stagedFiles: [file("a.ts")],
    unstagedFiles: [file("b.ts")],
    ...overrides,
  }) as unknown as GitCommitDialogState;

// ---- resolveCommitStagePlan ----

test("暂存计划：includeUnstaged=true 时提交集 = 未暂存 + 已暂存，且全部需要暂存", () => {
  const plan = resolveCommitStagePlan(state(), true);
  assert.deepEqual(plan.stagePaths, ["b.ts", "a.ts"]);
  assert.deepEqual(plan.pathsToStage, ["b.ts", "a.ts"]);
});

test("暂存计划：includeUnstaged=false 时只提交已暂存，且不暂存任何东西", () => {
  const plan = resolveCommitStagePlan(state(), false);
  assert.deepEqual(plan.stagePaths, ["a.ts"]);
  assert.deepEqual(plan.pathsToStage, []);
});

test("暂存计划：stagePath 重复项去重（同一路径 staged/unstaged 双份只提交一次）", () => {
  const plan = resolveCommitStagePlan(
    state({ stagedFiles: [file("same.ts")], unstagedFiles: [file("same.ts")] }),
    true,
  );
  assert.deepEqual(plan.stagePaths, ["same.ts"]);
});

test("暂存计划：空文件集合产出空计划（不抛错）", () => {
  const plan = resolveCommitStagePlan(state({ stagedFiles: [], unstagedFiles: [] }), true);
  assert.deepEqual(plan, { stagePaths: [], pathsToStage: [] });
});

// ---- resolveCommitPreflight ----

test("前置门：缺 identity 优先报 identity-missing（即使同时无变更）", () => {
  assert.equal(resolveCommitPreflight({ hasIdentity: false, stagePathCount: 0 }), "identity-missing");
});

test("前置门：有 identity 但无变更 → no-changes", () => {
  assert.equal(resolveCommitPreflight({ hasIdentity: true, stagePathCount: 0 }), "no-changes");
});

test("前置门：有 identity 且有变更 → ready", () => {
  assert.equal(resolveCommitPreflight({ hasIdentity: true, stagePathCount: 2 }), "ready");
});

test("前置门：缺 identity 但有变更仍先报 identity-missing（顺序不可交换）", () => {
  assert.equal(resolveCommitPreflight({ hasIdentity: false, stagePathCount: 3 }), "identity-missing");
});

// ---- shouldGenerateCommitMessage ----

test("提交信息为空（含纯空白）才自动生成", () => {
  assert.equal(shouldGenerateCommitMessage(""), true);
  assert.equal(shouldGenerateCommitMessage("   \n\t "), true);
});

test("提交信息有实际内容时不覆盖用户输入", () => {
  assert.equal(shouldGenerateCommitMessage("fix: something"), false);
  assert.equal(shouldGenerateCommitMessage("  fix: x  "), false);
});

// ---- toast / error key ----

test("成功 toast：commitAndPush 用专用文案，单独提交用普通文案", () => {
  assert.equal(
    resolveCommitSuccessToastId(true),
    "git.actionMenu.commitDialog.toast.commitAndPushSuccess",
  );
  assert.equal(resolveCommitSuccessToastId(false), "git.actionMenu.commitDialog.toast.success");
});

test("失败 key：已提交但 push 失败 → pushAfterCommitFailed（不误导用户重试提交）", () => {
  assert.equal(
    resolveCommitFailureErrorId({ committed: true, pushAfterCommit: true }),
    "git.actionMenu.commitDialog.error.pushAfterCommitFailed",
  );
});

test("失败 key：未提交成功 → 通用 requestFailed（四种组合的其余三种）", () => {
  assert.equal(
    resolveCommitFailureErrorId({ committed: false, pushAfterCommit: true }),
    "git.actionMenu.commitDialog.error.requestFailed",
  );
  assert.equal(
    resolveCommitFailureErrorId({ committed: true, pushAfterCommit: false }),
    "git.actionMenu.commitDialog.error.requestFailed",
  );
  assert.equal(
    resolveCommitFailureErrorId({ committed: false, pushAfterCommit: false }),
    "git.actionMenu.commitDialog.error.requestFailed",
  );
});

// ---- trigger 三态图标 / 禁用 ----

test("trigger 图标：pending 优先于动作图标（紧凑头部不追加 loading 图标）", () => {
  assert.equal(resolveTriggerIconKind({ triggerPending: true, primaryActionId: "push" }), "pending");
  assert.equal(resolveTriggerIconKind({ triggerPending: true, primaryActionId: "commit" }), "pending");
  assert.equal(resolveTriggerIconKind({ triggerPending: true, primaryActionId: null }), "pending");
});

test("trigger 图标：非 pending 时按主动作切换 push / commit", () => {
  assert.equal(
    resolveTriggerIconKind({ triggerPending: false, primaryActionId: "push" }),
    "push",
  );
  assert.equal(
    resolveTriggerIconKind({ triggerPending: false, primaryActionId: "commit" }),
    "commit",
  );
});

test("trigger 图标：无主动作时回退 commit 图标（不显示空白图标位）", () => {
  assert.equal(resolveTriggerIconKind({ triggerPending: false, primaryActionId: null }), "commit");
});

test("trigger 禁用：不可用 / pending / 无主动作 三者任一即禁用", () => {
  assert.equal(
    resolveTriggerDisabled({ actionAvailable: false, triggerPending: false, primaryActionId: "commit" }),
    true,
  );
  assert.equal(
    resolveTriggerDisabled({ actionAvailable: true, triggerPending: true, primaryActionId: "commit" }),
    true,
  );
  assert.equal(
    resolveTriggerDisabled({ actionAvailable: true, triggerPending: false, primaryActionId: null }),
    true,
  );
});

test("trigger 禁用：三条件全部不成立才可点", () => {
  assert.equal(
    resolveTriggerDisabled({ actionAvailable: true, triggerPending: false, primaryActionId: "push" }),
    false,
  );
});
