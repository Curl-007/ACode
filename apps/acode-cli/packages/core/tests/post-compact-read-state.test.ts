// specs/post-compact-read-state.md 验收场景 1/2：压缩后已读状态按「模型可见」口径修剪——
// preserved tail 的 Read/Write/Edit 目标与内容投影提醒保留，摘要侧与「too large」引用清除；
// 路径匹配走统一归一化；reminder 包装函数行为与既有语义一致。
import assert from "node:assert/strict";
import test from "node:test";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@acode/shared";
import {
  buildPostCompactReadStateReminderEntries,
  pruneReadFileStateAfterCompact,
  selectPostCompactReadStateReminders,
} from "../src/runtime/helpers/compact-post-reminders.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

function seedState(
  state: ReadFileStateMap,
  path: string,
  content: string,
  overrides: Partial<ReadFileStateEntry> = {},
): void {
  state.set(createReadFileStateKey(path, 1, undefined), {
    path,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: "Read",
    ...overrides,
  });
}

function assistantToolEntry(
  toolCalls: Array<{ name: string; input: unknown }>,
): RuntimeMessageEntry {
  return {
    message: {
      role: "assistant",
      content: [],
      toolCalls: toolCalls.map((toolCall, index) => ({
        id: `tc-${index}`,
        name: toolCall.name,
        input: toolCall.input,
      })),
    },
  } as RuntimeMessageEntry;
}

function attachmentContents(entries: RuntimeMessageEntry[]): string[] {
  return entries
    .filter((entry): entry is Extract<RuntimeMessageEntry, { kind: "attachment" }> =>
      "kind" in entry ? entry.kind === "attachment" : false,
    )
    .map((entry) => entry.content);
}

test("prune: preserved tail 的 Read/Write/Edit 目标保留，摘要侧读取清除", () => {
  const state: ReadFileStateMap = new Map();
  seedState(state, "/repo/src/read.ts", "read content");
  seedState(state, "/repo/src/written.ts", "written content", { sourceTool: "Write" });
  seedState(state, "/repo/src/edited.ts", "edited content", { sourceTool: "Edit" });
  seedState(state, "/repo/src/summarized-away.ts", "only in summary");

  const preserved = [
    assistantToolEntry([
      { name: "Read", input: { file_path: "/repo/src/read.ts" } },
      { name: "Write", input: { file_path: "/repo/src/written.ts", content: "written content" } },
    ]),
    assistantToolEntry([{ name: "Edit", input: { file_path: "/repo/src/edited.ts" } }]),
  ];

  const result = pruneReadFileStateAfterCompact({
    preservedEntries: preserved,
    readFileState: state,
  });

  assert.equal(result.retainedCount, 3);
  assert.equal(result.removedCount, 1);
  assert.equal(state.has(createReadFileStateKey("/repo/src/read.ts", 1, undefined)), true);
  assert.equal(state.has(createReadFileStateKey("/repo/src/written.ts", 1, undefined)), true);
  assert.equal(state.has(createReadFileStateKey("/repo/src/edited.ts", 1, undefined)), true);
  assert.equal(
    state.has(createReadFileStateKey("/repo/src/summarized-away.ts", 1, undefined)),
    false,
  );
});

test("prune: 内容投影文件保留，「too large」引用提醒文件清除", () => {
  const state: ReadFileStateMap = new Map();
  const smallContent = "hello world"; // ceil(11/3)=4 tokens
  const hugeContent = "x".repeat(90 * ESTIMATED_TOKEN_CHAR_DIVISOR); // 90 tokens
  // readAt 决定候选排序（新→旧）：钉住小文件先被选中投影，避免同刻排序不定。
  seedState(state, "/repo/small.ts", smallContent, { readAt: new Date(2_000) });
  seedState(state, "/repo/huge.ts", hugeContent, { readAt: new Date(1_000) });

  const selection = selectPostCompactReadStateReminders({
    maxFileApproxTokens: 10,
    readFileState: state,
  });

  // 小文件内容投影，大文件只留引用提醒（自身指引重新 Read）。
  const contents = attachmentContents(selection.entries);
  assert.equal(contents.length, 2);
  assert.match(contents[0]!, /Result of calling the Read tool:/);
  assert.match(contents[1]!, /too large to include/);
  assert.equal(selection.contentProjectedPaths.size, 1);

  const result = pruneReadFileStateAfterCompact({
    contentProjectedPaths: selection.contentProjectedPaths,
    readFileState: state,
  });
  assert.equal(result.retainedCount, 1);
  assert.equal(result.removedCount, 1);
  assert.equal(state.has(createReadFileStateKey("/repo/small.ts", 1, undefined)), true);
  assert.equal(state.has(createReadFileStateKey("/repo/huge.ts", 1, undefined)), false);
});

test("prune: preserved tail 里的 Read 被提醒跳过，但状态仍保留（双盲修复的回归钉）", () => {
  const state: ReadFileStateMap = new Map();
  seedState(state, "/repo/src/visible.ts", "visible content");
  const preserved = [
    assistantToolEntry([{ name: "Read", input: { file_path: "/repo/src/visible.ts" } }]),
  ];

  const selection = selectPostCompactReadStateReminders({
    preservedEntries: preserved,
    readFileState: state,
  });
  // 模型仍看得见原始 Read → 不重复投影。
  assert.equal(selection.entries.length, 0);
  assert.equal(selection.contentProjectedPaths.size, 0);

  const result = pruneReadFileStateAfterCompact({
    contentProjectedPaths: selection.contentProjectedPaths,
    preservedEntries: preserved,
    readFileState: state,
  });
  // 但状态必须保留——修复前这里被整表清空，Edit 对上下文里可见的读取报 FILE_NOT_READ。
  assert.equal(result.retainedCount, 1);
  assert.equal(state.has(createReadFileStateKey("/repo/src/visible.ts", 1, undefined)), true);
});

test("prune: 相对路径按 workingDirectory 解析后与绝对路径条目匹配", () => {
  // win32 上 resolve() 会给无盘符绝对路径补当前盘符，夹具必须平台一致：
  // 条目与 workingDirectory 同形，toolCall 用相对路径。
  const isWin = process.platform === "win32";
  const workingDirectory = isWin ? "C:\\repo" : "/repo";
  const entryPath = isWin ? "C:\\repo\\src\\relative.ts" : "/repo/src/relative.ts";
  const state: ReadFileStateMap = new Map();
  seedState(state, entryPath, "content");
  const preserved = [
    assistantToolEntry([{ name: "Read", input: { file_path: "src/relative.ts" } }]),
  ];

  const result = pruneReadFileStateAfterCompact({
    preservedEntries: preserved,
    readFileState: state,
    workingDirectory,
  });
  assert.equal(result.retainedCount, 1);
  assert.equal(result.removedCount, 0);
});

test("prune: win32 盘符别名/分隔符变体视为同一路径", { skip: process.platform !== "win32" }, () => {
  const state: ReadFileStateMap = new Map();
  seedState(state, "C:\\repo\\src\\win.ts", "content");
  const preserved = [
    assistantToolEntry([{ name: "Read", input: { file_path: "/c/repo/src/win.ts" } }]),
  ];

  const result = pruneReadFileStateAfterCompact({
    preservedEntries: preserved,
    readFileState: state,
  });
  assert.equal(result.retainedCount, 1);
});

test("prune: 空表零计数不抛错", () => {
  const state: ReadFileStateMap = new Map();
  const result = pruneReadFileStateAfterCompact({ readFileState: state });
  assert.deepEqual(result, { removedCount: 0, retainedCount: 0 });
});

test("select: 包装函数与 select 的 entries 一致，.git 路径跳过不回退", () => {
  const state: ReadFileStateMap = new Map();
  seedState(
    state,
    process.platform === "win32" ? "C:\\repo\\.git\\index" : "/repo/.git/index",
    "binary-ish",
  );
  seedState(state, "/repo/normal.ts", "content");

  const selection = selectPostCompactReadStateReminders({ readFileState: state });
  const wrapped = buildPostCompactReadStateReminderEntries({ readFileState: state });
  assert.deepEqual(wrapped, selection.entries);
  // .git 条目不进提醒也不进投影路径。
  assert.equal(selection.entries.length, 1);
  assert.equal(selection.contentProjectedPaths.size, 1);
});
