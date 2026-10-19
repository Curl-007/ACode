// 只读工具折叠分组回归（UX 波 D2 校验：omp read-tool-group 对应物 = 既有 exploreGroup，
// specs 台账⑩章勘误后以本测试钉住语义）：连续 ≥2 个只读工具（file-read/search/只读 shell）
// 折叠为 Explore 父卡；单个不折叠；写工具切断分组；分组身份锚定首个子工具（流式稳定）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAssistantWorkRenderItems } from "../src/v4/conversationAssistantWorkItems.js";
import type { ToolCallRow } from "@acode/shared/acode-protocol-v4";

const VISIBILITY = {
  messageStreamShowReasoning: true,
  messageStreamFirstReasoningRowId: undefined,
} as const;

let nextRowId = 1;
function toolRow(toolName: string, input: Record<string, unknown>): ToolCallRow {
  const rowId = nextRowId++;
  return {
    kind: "toolCall",
    rowId,
    turnId: 1,
    toolCallId: `call-${rowId}`,
    toolName,
    status: "success",
    inputText: JSON.stringify(input),
    input,
  } as unknown as ToolCallRow;
}

function readRow(path: string): ToolCallRow {
  return toolRow("Read", { file_path: path });
}

test("连续两个 Read 折叠为 exploreGroup，子项保序", () => {
  const items = buildAssistantWorkRenderItems(
    [readRow("/repo/a.ts"), readRow("/repo/b.ts")],
    VISIBILITY,
  );
  assert.equal(items.length, 1);
  const group = items[0];
  assert.equal(group?.kind, "exploreGroup");
  if (group?.kind === "exploreGroup") {
    assert.equal(group.rows.length, 2);
    assert.equal(group.node.childToolCalls.length, 2);
    assert.equal(group.node.toolCall.status, "completed");
    // 身份锚定首个子工具：追加子项不改变 key（流式展开状态稳定）。
    assert.equal(group.key, `explore:${group.rows[0]?.rowId}`);
  }
});

test("单个 Read 不折叠（保持原工具卡语义）", () => {
  const items = buildAssistantWorkRenderItems([readRow("/repo/a.ts")], VISIBILITY);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "row");
});

test("Read+Grep+Glob 混合只读序列同组折叠；写工具切断分组", () => {
  const rows = [
    readRow("/repo/a.ts"),
    toolRow("Grep", { pattern: "foo" }),
    toolRow("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }),
    toolRow("Glob", { pattern: "**/*.ts" }),
    readRow("/repo/b.ts"),
  ];
  const items = buildAssistantWorkRenderItems(rows, VISIBILITY);
  // [exploreGroup(Read+Grep), row(Edit), exploreGroup(Glob+Read)]
  assert.equal(items.length, 3);
  assert.equal(items[0]?.kind, "exploreGroup");
  assert.equal(items[1]?.kind, "row");
  assert.equal(items[2]?.kind, "exploreGroup");
});

test("运行尾段：stageTailIsRunning 时分组父状态为 in_progress", () => {
  const items = buildAssistantWorkRenderItems(
    [readRow("/repo/a.ts"), { ...readRow("/repo/b.ts"), status: "running" } as ToolCallRow],
    VISIBILITY,
    { stageTailIsRunning: true },
  );
  const group = items[0];
  assert.equal(group?.kind, "exploreGroup");
  if (group?.kind === "exploreGroup") {
    assert.equal(group.node.toolCall.status, "in_progress");
  }
});

test("关闭开关时逐项平铺（ENABLE 开关是真实控制面）", () => {
  const items = buildAssistantWorkRenderItems(
    [readRow("/repo/a.ts"), readRow("/repo/b.ts")],
    VISIBILITY,
    { enableExploreGrouping: false },
  );
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "row"));
});
