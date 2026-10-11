import assert from "node:assert/strict";
import test from "node:test";
import { executeCommandNeedsCollapse } from "../src/ToolCallBlocks/renderers/execute-command-area.js";

/**
 * execute 工具卡命令折叠的阈值（packages/ui/specs/chat-small-ux-file-icons.md §1）：
 * 超约 2 行（160 字符或多于 2 个物理行）才值得给「展开/折叠」按钮。
 */

test("短命令与缺席命令不折叠", () => {
  assert.equal(executeCommandNeedsCollapse(undefined), false);
  assert.equal(executeCommandNeedsCollapse(""), false);
  assert.equal(executeCommandNeedsCollapse("pnpm test"), false);
  assert.equal(executeCommandNeedsCollapse("git status --short".repeat(5)), false);
});

test("超过 160 字符的单行命令折叠", () => {
  const long = `echo ${"a".repeat(200)}`;
  assert.equal(long.length > 160, true);
  assert.equal(executeCommandNeedsCollapse(long), true);
});

test("多于两个物理行的命令折叠，恰好两行不折叠", () => {
  assert.equal(executeCommandNeedsCollapse("line1\nline2"), false);
  assert.equal(executeCommandNeedsCollapse("line1\nline2\nline3"), true);
});
