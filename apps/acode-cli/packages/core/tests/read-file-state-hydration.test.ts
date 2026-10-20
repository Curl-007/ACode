// specs/post-compact-read-state.md 验收场景 6（R5）：resume/rewind 水合镜像 live 修剪
// 口径——preserved segment 内的读取、range/partial 视图按 metadata 原样恢复；
// 无 metadata 不恢复且 range 入参单独计数；Write 恢复路径零回归。
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@acode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../src/tool/read-file-state-metadata.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

function stateEntry(
  path: string,
  content: string,
  overrides: Partial<ReadFileStateEntry> = {},
): ReadFileStateEntry {
  return {
    path,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(1_000),
    sourceTool: "Read",
    revisionId: "rev-1",
    mtimeMs: 5_000,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    ...overrides,
  };
}

function readMetadata(entry: ReadFileStateEntry, toolName: "Read" | "Write" = "Read") {
  return {
    readFileState: createReadFileStateMetadataFromEntry({
      completedAt: new Date(2_000),
      entry,
      toolName,
    }),
  };
}

function assistantToolMessage(
  id: string,
  tool: string,
  toolInput: unknown,
  metadata: unknown,
): MessageWithParts {
  return {
    info: { id, role: "assistant" },
    parts: [
      {
        id: `${id}-part`,
        type: "tool",
        tool,
        state: { status: "completed", input: toolInput, output: { type: "text" }, metadata },
      },
    ],
  } as unknown as MessageWithParts;
}

function plainMessage(id: string, role: "user" | "assistant"): MessageWithParts {
  return { info: { id, role }, parts: [] } as unknown as MessageWithParts;
}

function boundaryMessage(
  id: string,
  preservedSegment: { headMessageId: string; tailMessageId: string; anchorMessageId: string },
): MessageWithParts {
  return {
    info: { id, role: "user" },
    parts: [
      {
        id: `${id}-boundary`,
        type: "compaction",
        compactBoundary: { preservedSegment },
      },
    ],
  } as unknown as MessageWithParts;
}

function hydrate(messages: MessageWithParts[]) {
  const readFileState: ReadFileStateMap = new Map();
  return hydrateReadFileStateFromSession({
    messages,
    readFileState,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
  }).then((result) => ({ result, readFileState }));
}

test("hydration: preserved segment 内的 Read 跨 resume 恢复（R5 镜像 live 修剪）", async () => {
  const entry = stateEntry("/repo/a.ts", "alpha\n");
  const messages = [
    plainMessage("m0", "user"),
    assistantToolMessage("m1", "Read", { file_path: "/repo/a.ts" }, readMetadata(entry)),
    boundaryMessage("mB", { headMessageId: "m0", tailMessageId: "m1", anchorMessageId: "mB" }),
    plainMessage("m2", "assistant"),
  ];

  const { result, readFileState } = await hydrate(messages);
  const restored = readFileState.get(createReadFileStateKey("/repo/a.ts", 1, undefined));
  assert.equal(result.restoredCount, 1);
  assert.ok(restored, "preserved tail 里模型可见的读取必须恢复");
  assert.equal(restored!.mtimeMs, 5_000, "freshness metadata 透传，stale 守卫与 live 等价");
  assert.equal(restored!.revisionId, "rev-1");
});

test("hydration: range Read 按 metadata 窗口原样恢复", async () => {
  const entry = stateEntry("/repo/range.ts", "window\n", { offset: 10, limit: 20 });
  const messages = [
    assistantToolMessage(
      "m1",
      "Read",
      { file_path: "/repo/range.ts", offset: 10, limit: 20 },
      readMetadata(entry),
    ),
  ];

  const { result, readFileState } = await hydrate(messages);
  const restored = readFileState.get(createReadFileStateKey("/repo/range.ts", 10, 20));
  assert.equal(result.restoredCount, 1);
  assert.ok(restored, "range 视图不再被跨 resume 丢弃");
  assert.equal(restored!.offset, 10);
  assert.equal(restored!.limit, 20);
});

test("hydration: partial-view metadata 恢复后 isPartialView 保持 true", async () => {
  const entry = stateEntry("/repo/partial.ts", "truncated\n", { isPartialView: true });
  const messages = [
    assistantToolMessage("m1", "Read", { file_path: "/repo/partial.ts" }, readMetadata(entry)),
  ];

  const { readFileState } = await hydrate(messages);
  const restored = readFileState.get(createReadFileStateKey("/repo/partial.ts", 1, undefined));
  assert.equal(restored?.isPartialView, true, "写工具据此报 partial-view 文案（R3）");
});

test("hydration: 无 metadata 不恢复，range 入参单独计数", async () => {
  const messages = [
    assistantToolMessage("m1", "Read", { file_path: "/repo/range.ts", offset: 5 }, undefined),
    assistantToolMessage("m2", "Read", { file_path: "/repo/full.ts" }, undefined),
  ];

  const { result, readFileState } = await hydrate(messages);
  assert.equal(result.restoredCount, 0);
  assert.equal(result.skippedRangeReadCount, 1, "仅 range 入参计数，日志口径不变");
  assert.equal(readFileState.size, 0);
});

test("hydration: Write part 恢复路径零回归", async () => {
  const entry = stateEntry("/repo/written.ts", "written\n", { sourceTool: "Write" });
  const messages = [
    assistantToolMessage(
      "m1",
      "Write",
      { file_path: "/repo/written.ts", content: "written\n" },
      readMetadata(entry, "Write"),
    ),
  ];

  const { result, readFileState } = await hydrate(messages);
  const restored = readFileState.get(createReadFileStateKey("/repo/written.ts", 1, undefined));
  assert.equal(result.restoredCount, 1);
  assert.equal(restored?.sourceTool, "Write");
});
