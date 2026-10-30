import assert from "node:assert/strict";
import test from "node:test";
import type { GitRepositorySummary } from "@acode/shared";
import {
  COMMIT_DIALOG_ACTION_IDS,
  GIT_COMMIT_MESSAGE_TEXTAREA_ID,
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  gitCommitActionItemTestId,
  isCommitDialogActionId,
  isCommitMessageTextAreaTarget,
  type GitCommitDialogState,
} from "../src/git-action-menu/gitActionMenuDialogsModel.js";

/**
 * GitActionMenu 批次 6 外迁（gitActionMenuDialogsModel.ts）的决策表单测。
 * 覆盖：action id 守卫与 testid 生成 × 提交文件集合的两态 × stage 路径去重
 * × textarea 事件目标判定；纯函数零 DOM（textarea 判定用最小桩对象）。
 */

type PreviewFile = GitCommitDialogState["stagedFiles"][number];

const file = (path: string): PreviewFile =>
  ({ path, stagePath: path, added: 1, removed: 0, status: "modified" } as unknown as PreviewFile);

const state = (staged: string[], unstaged: string[]): GitCommitDialogState => ({
  summary: { isDirty: true } as unknown as GitRepositorySummary,
  identity: null,
  activeTaskChangeSummary: null,
  stagedFiles: staged.map(file),
  unstagedFiles: unstaged.map(file),
});

test("COMMIT_DIALOG_ACTION_IDS：三态动作 id 顺序固定", () => {
  assert.deepEqual([...COMMIT_DIALOG_ACTION_IDS], ["commit", "commitAndPush", "push"]);
});

test("gitCommitActionItemTestId：以动作 id 结尾的稳定 e2e 锚点", () => {
  assert.equal(gitCommitActionItemTestId("commit"), "git-commit-action-item-commit");
  assert.equal(
    gitCommitActionItemTestId("commitAndPush"),
    "git-commit-action-item-commitAndPush",
  );
  assert.equal(gitCommitActionItemTestId("push"), "git-commit-action-item-push");
});

test("isCommitDialogActionId：只认三个合法 id", () => {
  for (const id of COMMIT_DIALOG_ACTION_IDS) {
    assert.equal(isCommitDialogActionId(id), true);
  }
  for (const invalid of ["", "Commit", "pushOnly", "commit-push"]) {
    assert.equal(isCommitDialogActionId(invalid), false);
  }
});

test("getCommitDialogFiles：不包含未暂存时只取 staged", () => {
  const files = getCommitDialogFiles(state(["a", "b"], ["c"]), false);
  assert.deepEqual(
    files.map((item) => item.path),
    ["a", "b"],
  );
});

test("getCommitDialogFiles：包含未暂存时 unstaged 排在前面", () => {
  const files = getCommitDialogFiles(state(["a", "b"], ["c", "d"]), true);
  assert.deepEqual(
    files.map((item) => item.path),
    ["c", "d", "a", "b"],
  );
});

test("getCommitDialogStagePaths：按 stagePath 去重并保持顺序", () => {
  const duplicated = state(["same", "other"], ["same"]);
  assert.deepEqual(getCommitDialogStagePaths(duplicated, true), ["same", "other"]);
  assert.deepEqual(getCommitDialogStagePaths(duplicated, false), ["same", "other"]);
});

test("getCommitDialogStagePaths：空集合返回空数组", () => {
  assert.deepEqual(getCommitDialogStagePaths(state([], []), true), []);
  assert.deepEqual(getCommitDialogStagePaths(state([], []), false), []);
});

test("isCommitMessageTextAreaTarget：只认目标 id 匹配的 textarea", () => {
  // node 环境没有 HTMLTextAreaElement 构造器；用一次性最小构造器钉住 instanceof 链路
  // （被测函数只做 instanceof + id 比较，不触达任何 DOM API）。
  const globals = globalThis as Record<string, unknown>;
  const hadCtor = "HTMLTextAreaElement" in globals;
  const previousCtor = globals.HTMLTextAreaElement;
  class StubTextArea {
    id = "";
  }
  globals.HTMLTextAreaElement = StubTextArea;
  try {
    const make = (id: string) => {
      const element = new StubTextArea();
      element.id = id;
      return element as unknown as EventTarget;
    };
    assert.equal(isCommitMessageTextAreaTarget(null), false);
    assert.equal(isCommitMessageTextAreaTarget(make(GIT_COMMIT_MESSAGE_TEXTAREA_ID)), true);
    assert.equal(isCommitMessageTextAreaTarget(make("other")), false);
    assert.equal(isCommitMessageTextAreaTarget({} as EventTarget), false);
  } finally {
    if (hadCtor) globals.HTMLTextAreaElement = previousCtor;
    else delete globals.HTMLTextAreaElement;
  }
});

test("GIT_COMMIT_MESSAGE_TEXTAREA_ID：与 label htmlFor 同源常量", () => {
  assert.equal(GIT_COMMIT_MESSAGE_TEXTAREA_ID, "git-action-menu-commit-message");
});
