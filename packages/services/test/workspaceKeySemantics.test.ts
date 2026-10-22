import assert from "node:assert/strict";
import test from "node:test";

import { getWorkspaceKey } from "../src/bots/workspaceHelpers.js";

/**
 * 身份 key 语义守护（review R3 EI-2）：services 内的 workspace 身份 key 已收敛到
 * shared 的 resolveWorkspaceKey（唯一权威实现），本测试经 services 侧薄封装
 * getWorkspaceKey 钉住其语义，防止后续任一处漏 trim / 改判空造成静默分叉。
 *
 * 规则：identity 有非空 trim 值 → 用 identity；identity 为 undefined / 空串 /
 * 纯空白 → 回退 workspacePath。
 */

test("身份 key：identity 有值时用 trim 后的 identity", () => {
  assert.equal(getWorkspaceKey("D:/repo", "remote-identity-abc"), "remote-identity-abc");
});

test("身份 key：identity 带首尾空白时 trim 后使用", () => {
  assert.equal(getWorkspaceKey("D:/repo", "  remote-identity-abc  "), "remote-identity-abc");
});

test("身份 key：identity 为 undefined 时回退 workspacePath", () => {
  assert.equal(getWorkspaceKey("D:/repo", undefined), "D:/repo");
});

test("身份 key：identity 为空串时回退 workspacePath", () => {
  assert.equal(getWorkspaceKey("D:/repo", ""), "D:/repo");
});

test("身份 key：identity 为纯空白时回退 workspacePath", () => {
  assert.equal(getWorkspaceKey("D:/repo", "   "), "D:/repo");
});
