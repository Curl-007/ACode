import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * review §7 盲区 2：水合（hydrate）端到端恢复测试。
 *
 * 近期高频改动区（只被间接覆盖）：
 *   - daf32bee：resume 水合镜像 live 修剪——preserved tail 与 range/partial 读取跨 resume 恢复；
 *   - b3779769 / 66a11532：压缩后已读状态按「模型可见」口径修剪、win32 大小写。
 *
 * 真实缺陷形态（这些测试防回归）：一个压缩过又续开的会话，preserved tail 里模型**看得见**的
 * Read 若在 resume 水合时没恢复 readFileState，续聊后对同一文件的真实 Edit/ApplyPatch 会误报
 * FILE_NOT_READ——而模型明明在上下文里看得见那次读取。这是 daf32bee 修的真实 bug。
 *
 * 与既有测试的分工：
 *   - packages/core/tests/read-file-state-hydration.test.ts：用**合成 metadata** 断言水合后 map 内容；
 *   - post-compact-edit-e2e.test.mjs：走 **live 压缩管线**（非 resume 水合）断言 Edit 不误报；
 *   - 本文件：**真实 Read handler → 真实 metadata → 真实 compact 边界 → hydrateReadFileStateFromSession
 *     → 真实 Edit handler** 的完整 resume 链路，断言「水合出的状态真的能驱动写工具」，两端都是真 IO。
 *
 * 无固定 sleep；临时目录经 t.after 清理；Windows 路径由 read-state 专用归一化折叠大小写（既有实现），
 * 断言用真实 fs adapter 往返，不依赖平台分支。
 */

const { readToolEntry } = await import("../packages/core/src/tool/handlers/read.ts");
const { editToolEntry } = await import("../packages/core/src/tool/handlers/edit.ts");
const { hydrateReadFileStateFromSession } = await import(
  "../packages/core/src/agent/read-file-state-hydrator.ts"
);
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { createReadFileStateKey } = await import("../packages/core/src/tool/read-file-state.ts");
const { EditErrorCode } = await import("../packages/contracts/src/tools/edit.ts");

const fsPort = createNodeFileSystemAdapter();

function toolContext(dir, readFileState, toolCallId, recordMetadata) {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: fsPort,
    readFileState,
    sessionId: "sess-hydrate-e2e",
    spanId: "span-hydrate-e2e",
    toolCallId,
    traceId: "trace-hydrate-e2e",
    workingDirectory: dir,
    workspaceRoot: dir,
    ...(recordMetadata ? { recordReadFileStateMetadata: recordMetadata } : {}),
  };
}

/** 用真实 Read handler 读一个文件，返回 (output, 持久化 metadata)——metadata 就是运行时会写库的那份。 */
async function realReadWithMetadata(dir, filePath, readInput = {}) {
  const liveState = new Map();
  let captured;
  const output = await readToolEntry.handler(
    { file_path: filePath, ...readInput },
    toolContext(dir, liveState, "tc-read", (metadata) => {
      captured = metadata;
    }),
  );
  assert.ok(captured, `真实 Read 必须产出可持久化的 read-state metadata：${filePath}`);
  return { captured, liveState, output };
}

/** 组装一个带 compact 边界的会话历史：Read part 携真实 metadata，落在 preserved tail 内。 */
function assistantReadMessage(id, filePath, readInput, metadata) {
  return {
    info: { id, role: "assistant" },
    parts: [
      {
        callID: `${id}-call`,
        id: `${id}-part`,
        state: {
          input: readInput,
          metadata: { readFileState: metadata },
          output: { filePath, type: "text" },
          status: "completed",
        },
        tool: "Read",
        type: "tool",
      },
    ],
  };
}

function plainMessage(id, role) {
  return { info: { id, role }, parts: [] };
}

function boundaryMessage(id, preservedSegment) {
  return {
    info: { id, role: "user" },
    parts: [{ compactBoundary: { preservedSegment }, id: `${id}-boundary`, type: "compaction" }],
  };
}

async function hydrate(dir, messages) {
  const resumeState = new Map();
  const result = await hydrateReadFileStateFromSession({
    messages,
    readFileState: resumeState,
    workingDirectory: dir,
    workspaceRoot: dir,
  });
  return { resumeState, result };
}

// ── 1. 核心回归：preserved tail 内真实 Read 水合后，真实 Edit 不误报 FILE_NOT_READ ──

test("hydrate(1): preserved tail 内的真实 Read 跨 resume 水合——真实 Edit 不误报 FILE_NOT_READ", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-tail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, "visible.ts");
  await writeFile(file, "alpha\nbeta\n", "utf8");
  const { captured } = await realReadWithMetadata(dir, file);

  // preserved tail = [m1(head), m2(tail=Read)]，边界 mB 锚定在 m2 之后。
  const messages = [
    plainMessage("m0", "user"),
    plainMessage("m1", "user"),
    assistantReadMessage("m2", file, { file_path: file }, captured),
    boundaryMessage("mB", { anchorMessageId: "mB", headMessageId: "m1", tailMessageId: "m2" }),
    plainMessage("m3", "assistant"),
  ];

  const { resumeState, result } = await hydrate(dir, messages);
  const key = createReadFileStateKey(file, 1, undefined);
  assert.equal(resumeState.has(key), true, "preserved tail 里模型可见的 Read 必须水合恢复（daf32bee）");
  assert.ok(result.restoredCount >= 1, "restoredCount 必须计入这次恢复");

  // 真实 Edit：修复前这里必报 FILE_NOT_READ（水合丢了 preserved tail 的读取）。
  const edit = await editToolEntry.handler(
    { file_path: file, new_string: "ALPHA", old_string: "alpha" },
    toolContext(dir, resumeState, "tc-edit"),
  );
  assert.notEqual(edit?.result, false, `水合后真实 Edit 不得误报：${JSON.stringify(edit)}`);
  assert.equal(await readFile(file, "utf8"), "ALPHA\nbeta\n", "Edit 真实落盘");
});

// ── 2. 边界尊重：preserved head 之前的 Read 被修剪，真实 Edit 如实 FILE_NOT_READ ──

test("hydrate(2): preserved head 之前的 Read 被修剪——水合不恢复，真实 Edit 如实报 FILE_NOT_READ", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-pruned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const prunedFile = join(dir, "pruned.ts");
  const keptFile = join(dir, "kept.ts");
  await writeFile(prunedFile, "old\n", "utf8");
  await writeFile(keptFile, "new\n", "utf8");
  const prunedRead = await realReadWithMetadata(dir, prunedFile);
  const keptRead = await realReadWithMetadata(dir, keptFile);

  // m_old（Read prunedFile）在 preserved head（m1）之前 → 被压缩修剪，模型看不见。
  const messages = [
    assistantReadMessage("m_old", prunedFile, { file_path: prunedFile }, prunedRead.captured),
    plainMessage("m1", "user"),
    assistantReadMessage("m2", keptFile, { file_path: keptFile }, keptRead.captured),
    boundaryMessage("mB", { anchorMessageId: "mB", headMessageId: "m1", tailMessageId: "m2" }),
    plainMessage("m3", "assistant"),
  ];

  const { resumeState } = await hydrate(dir, messages);
  const prunedKey = createReadFileStateKey(prunedFile, 1, undefined);
  const keptKey = createReadFileStateKey(keptFile, 1, undefined);
  assert.equal(resumeState.has(prunedKey), false, "preserved head 之前被修剪的读取不得水合（模型看不见）");
  assert.equal(resumeState.has(keptKey), true, "preserved tail 内的读取必须水合");

  // 被修剪的文件：真实 Edit 如实报 FILE_NOT_READ（与「模型看不见这次读取」自洽）。
  const editPruned = await editToolEntry.handler(
    { file_path: prunedFile, new_string: "OLD", old_string: "old" },
    toolContext(dir, resumeState, "tc-edit-pruned"),
  );
  assert.equal(editPruned.result, false);
  assert.equal(editPruned.errorCode, EditErrorCode.FILE_NOT_READ, "修剪掉的读取应报 FILE_NOT_READ");
  assert.equal(await readFile(prunedFile, "utf8"), "old\n", "文件未被修改");

  // 保留的文件：真实 Edit 成功。
  const editKept = await editToolEntry.handler(
    { file_path: keptFile, new_string: "NEW", old_string: "new" },
    toolContext(dir, resumeState, "tc-edit-kept"),
  );
  assert.notEqual(editKept?.result, false, `保留 tail 的文件 Edit 不应误报：${JSON.stringify(editKept)}`);
});

// ── 3. range Read 跨 resume 按 metadata 窗口原样恢复（不退回未读）──────────────

test("hydrate(3): 真实 range Read 跨 resume 按窗口 key 恢复（不退回未读态）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-range-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, "many.ts");
  await writeFile(file, Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n"), "utf8");
  // 真实 range 读取：offset=5, limit=3。
  const { captured } = await realReadWithMetadata(dir, file, { offset: 5, limit: 3 });
  assert.equal(captured.offset, 5, "前置：metadata 记录 range offset");
  assert.equal(captured.limit, 3, "前置：metadata 记录 range limit");

  const messages = [
    assistantReadMessage("m1", file, { file_path: file, offset: 5, limit: 3 }, captured),
  ];
  const { resumeState, result } = await hydrate(dir, messages);
  // 恢复到 range 窗口 key（offset=5, limit=3），而非丢弃。
  const rangeKey = createReadFileStateKey(file, 5, 3);
  assert.equal(resumeState.has(rangeKey), true, "range 视图必须按 metadata 窗口跨 resume 恢复（daf32bee）");
  assert.equal(result.restoredCount, 1);
  const restored = resumeState.get(rangeKey);
  assert.equal(restored.offset, 5);
  assert.equal(restored.limit, 3);
  // 全量 key 不应被伪造（range 读取不等于全量已读）。
  assert.equal(resumeState.has(createReadFileStateKey(file, 1, undefined)), false);
});

// ── 4. partial-view metadata 水合后，真实 Edit 报「截断视图」文案（区别于未读）──

test("hydrate(4): partial-view 读取水合后 isPartialView 保持——真实 Edit 报截断文案而非未读", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-partial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, "partial.ts");
  await writeFile(file, "alpha\nbeta\n", "utf8");
  const { captured } = await realReadWithMetadata(dir, file);
  // 表示「这次 Read 被 token 上限截断」：真实 truncatedByTokenCap 读取会置 isPartialView=true，
  // 这是 metadata 里唯一的差异位；水合与 Edit 链路必须据此报「截断视图」而非「从未读过」。
  const partialMetadata = { ...captured, isPartialView: true };

  const messages = [assistantReadMessage("m1", file, { file_path: file }, partialMetadata)];
  const { resumeState } = await hydrate(dir, messages);
  const key = createReadFileStateKey(file, 1, undefined);
  assert.equal(resumeState.get(key)?.isPartialView, true, "水合必须保持 isPartialView（跨 resume）");

  const edit = await editToolEntry.handler(
    { file_path: file, new_string: "ALPHA", old_string: "alpha" },
    toolContext(dir, resumeState, "tc-edit-partial"),
  );
  assert.equal(edit.result, false);
  assert.equal(edit.errorCode, EditErrorCode.FILE_NOT_READ, "错误码维持 FILE_NOT_READ 契约");
  assert.match(edit.message, /truncated view/u, "文案必须说明是截断视图，而非未读");
  assert.doesNotMatch(edit.message, /has not been read yet/u, "不得复用未读文案");
  assert.equal(await readFile(file, "utf8"), "alpha\nbeta\n", "文件未被修改");
});

// ── 5. 基线：无 compact 边界的会话，两次真实 Read 都水合，真实 Edit 都成功 ─────

test("hydrate(5): 无 compact 边界的会话——全部真实 Read 水合，真实 Edit 全部成功", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-nobound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fileA = join(dir, "a.ts");
  const fileB = join(dir, "b.ts");
  await writeFile(fileA, "aaa\n", "utf8");
  await writeFile(fileB, "bbb\n", "utf8");
  const readA = await realReadWithMetadata(dir, fileA);
  const readB = await realReadWithMetadata(dir, fileB);

  const messages = [
    plainMessage("m0", "user"),
    assistantReadMessage("m1", fileA, { file_path: fileA }, readA.captured),
    assistantReadMessage("m2", fileB, { file_path: fileB }, readB.captured),
  ];
  const { resumeState, result } = await hydrate(dir, messages);
  assert.equal(result.restoredCount, 2, "无边界会话两次读取都应恢复");
  assert.equal(resumeState.has(createReadFileStateKey(fileA, 1, undefined)), true);
  assert.equal(resumeState.has(createReadFileStateKey(fileB, 1, undefined)), true);

  const editA = await editToolEntry.handler(
    { file_path: fileA, new_string: "AAA", old_string: "aaa" },
    toolContext(dir, resumeState, "tc-edit-a"),
  );
  const editB = await editToolEntry.handler(
    { file_path: fileB, new_string: "BBB", old_string: "bbb" },
    toolContext(dir, resumeState, "tc-edit-b"),
  );
  assert.notEqual(editA?.result, false, `A 的 Edit 不应误报：${JSON.stringify(editA)}`);
  assert.notEqual(editB?.result, false, `B 的 Edit 不应误报：${JSON.stringify(editB)}`);
});

// ── 6. stale 守卫跨 resume 等价：水合后文件被外部改动，真实 Edit 报 STALE_FILE ──

test("hydrate(6): 水合后文件被外部改动——stale 守卫跨 resume 生效，真实 Edit 报 STALE_FILE", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-hydrate-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, "stale.ts");
  await writeFile(file, "original\n", "utf8");
  const { captured } = await realReadWithMetadata(dir, file);

  const messages = [assistantReadMessage("m1", file, { file_path: file }, captured)];
  const { resumeState } = await hydrate(dir, messages);
  assert.equal(resumeState.has(createReadFileStateKey(file, 1, undefined)), true, "前置：已水合");

  // 模拟外部（用户/formatter/linter）在 resume 后改动了文件——mtime 前进 + size 变化。
  await writeFile(file, "original-but-changed-by-user\n", "utf8");

  const edit = await editToolEntry.handler(
    { file_path: file, new_string: "edited", old_string: "original" },
    toolContext(dir, resumeState, "tc-edit-stale"),
  );
  assert.equal(edit.result, false, "外部改动后 Edit 必须被 stale 守卫拦下");
  assert.equal(edit.errorCode, EditErrorCode.STALE_FILE, "水合恢复的 freshness metadata 必须驱动 stale 判定");
  assert.match(edit.message, /modified since read/u);
});
