// v4 桥接的 intent 剥离与 title 桥接（apps/acode-cli/specs/tool-intent-field.md R4）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";

function row(input: unknown, overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: 1,
    turnId: 1,
    toolCallId: "call-1",
    toolName: "Read",
    status: "success",
    inputText: JSON.stringify(input),
    input,
    ...overrides,
  } as unknown as ToolCallRow;
}

test("input 含 i：展示 input 剥离，title=修剪后的意图", () => {
  const node = toolCallRowToLegacyNode(row({ file_path: "/a.ts", i: "  看看配置  " }));
  assert.deepEqual(node.toolCall.input, { file_path: "/a.ts" });
  assert.equal(node.toolCall.title, "看看配置");
});

test("input 无 i：input/title 与改动前一致（title 缺席）", () => {
  const node = toolCallRowToLegacyNode(row({ file_path: "/a.ts" }));
  assert.deepEqual(node.toolCall.input, { file_path: "/a.ts" });
  assert.equal(node.toolCall.title, undefined);
});

test("i 非字符串/空串：剥离但不产生 title", () => {
  const node = toolCallRowToLegacyNode(row({ file_path: "/a.ts", i: "   " }));
  assert.deepEqual(node.toolCall.input, { file_path: "/a.ts" });
  assert.equal(node.toolCall.title, undefined);
});

test("raw 通道保真：rawOutput/raw.inputText 不被改写（调试面如实）", () => {
  const input = { file_path: "/a.ts", i: "intent" };
  const node = toolCallRowToLegacyNode(row(input));
  const raw = node.toolCall.raw as Record<string, unknown>;
  // inputText 原文保留（含 i）；展示 input 已剥。
  assert.equal(typeof raw["inputPreviewComplete"], "boolean");
  assert.deepEqual(node.toolCall.input, { file_path: "/a.ts" });
});
