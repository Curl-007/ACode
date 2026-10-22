import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * specs/post-compact-read-state.md 真实链路 E2E：真 AgentRuntime + 真 sqlite store +
 * 真 compactActiveConversation 管线（选择/摘要请求/持久化/边界事件/提醒构建/修剪）+
 * 真 Read/Edit handler（真 Node fs adapter）。唯一桩件是摘要文本的 model.generateText。
 *
 * 场景（对应用户报告的缺陷形态）：
 * - 文件 A（小）：真实 Read 过，压缩后状态必须保留 → 真实 Edit 不再报 FILE_NOT_READ；
 * - 文件 B（大，>5k token 投影上限）：真实 Read 过但只拿「too large」引用提醒 →
 *   状态清除 → 真实 Edit 报 FILE_NOT_READ（与提醒文案 "Use Read tool" 自洽）。
 */

const { AgentRuntime } = await import("../packages/core/src/runtime/agent-runtime.ts");
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { createInMemorySessionEventStore } = await import(
  "../packages/contracts/src/events/in-memory-session-event-store.ts"
);
const { readToolEntry } = await import("../packages/core/src/tool/handlers/read.ts");
const { editToolEntry } = await import("../packages/core/src/tool/handlers/edit.ts");
const { EditErrorCode } = await import("../packages/contracts/src/tools/edit.ts");
const { createNodeFileSystemAdapter } = await import("../packages/adapters/src/fs/index.ts");
const { createReadFileStateKey } = await import("../packages/core/src/tool/read-file-state.ts");

const trace = {
  attributes: {},
  sessionId: "sess_post_compact_e2e",
  spanId: "span_post_compact_e2e",
  traceId: "trace_post_compact_e2e",
};

const stubModel = {
  providerId: "test",
  modelId: "test",
  options: {},
  properties: { contextWindow: 100_000, inputFormat: { supportsText: true } },
  optionSpecs: { maxOutputTokens: { max: 1000 }, reasoningLevel: { values: [] } },
  generateText: async () => ({
    text: "Summary: the conversation read two files and finished round three.",
    finishReason: "stop",
    usage: {},
  }),
};

test("E2E: 真实压缩后，投影/尾巴可见文件的真实 Edit 不再误报未读；too-large 文件如实清除", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acode-post-compact-e2e-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  await store.createSession({
    directory: dir,
    id: trace.sessionId,
    projectID: "proj_post_compact_e2e",
    slug: "post-compact-e2e",
    title: "post compact e2e",
    version: "v4",
  });
  const runtime = new AgentRuntime(
    trace.sessionId,
    { mode: "build", workingDirectory: dir, modelSelection: { providerId: "test", modelId: "test" } },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => stubModel,
      sessionStore: store,
      traceContext: trace,
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  // ── 真实文件与真实 Read（状态由真 handler 写入 runtime 的 readFileState）──
  const fileA = join(dir, "small-visible.txt");
  const fileB = join(dir, "huge-summarized.txt");
  await writeFile(fileA, "alpha\nbeta\n", "utf8");
  // 30k 字符 ≈ 10k token：高于提醒的单文件投影上限（5k），低于 Read 输出上限（25k），
  // 真实 Read 完整成功且 isPartialView=false，压缩后落入「too large」引用分支。
  await writeFile(fileB, `header\n${"b".repeat(30_000)}\n`, "utf8");

  const readFileState = runtime["readFileState"];
  const fsPort = createNodeFileSystemAdapter();
  const toolContext = (toolCallId) => ({
    toolCallId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    sessionId: trace.sessionId,
    abortSignal: new AbortController().signal,
    fileSystemPort: fsPort,
    workingDirectory: dir,
    workspaceRoot: dir,
    readFileState,
  });

  await readToolEntry.handler({ file_path: fileB }, toolContext("tc-read-b"));
  await readToolEntry.handler({ file_path: fileA }, toolContext("tc-read-a"));
  const keyA = createReadFileStateKey(fileA, 1, undefined);
  const keyB = createReadFileStateKey(fileB, 1, undefined);
  assert.equal(readFileState.has(keyA), true, "前置：真实 Read 已写入 A 的状态");
  assert.equal(readFileState.has(keyB), true, "前置：真实 Read 已写入 B 的状态");
  assert.equal(readFileState.get(keyB).isPartialView, false, "前置：B 未被 token 上限截断");

  // ── 种子历史：三轮，两个 Read 各在自己的组里 ──
  runtime["messageHistory"].replaceMessages([
    { message: { role: "user", content: "round one: read the huge file" } },
    {
      message: {
        role: "assistant",
        content: "reading the huge file",
        toolCalls: [{ id: "tc-b", name: "Read", input: { file_path: fileB } }],
      },
    },
    { message: { role: "tool", content: "1\theader", toolCallId: "tc-b", toolName: "Read" } },
    { message: { role: "user", content: "round two: read the small file" } },
    {
      message: {
        role: "assistant",
        content: "reading the small file",
        toolCalls: [{ id: "tc-a", name: "Read", input: { file_path: fileA } }],
      },
    },
    {
      message: {
        role: "tool",
        content: "1\talpha\n2\tbeta",
        toolCallId: "tc-a",
        toolName: "Read",
      },
    },
    { message: { role: "user", content: "round three" } },
    { message: { role: "assistant", content: "done" } },
  ]);

  // ── 真实压缩管线 ──
  const events = [];
  const compactResult = await runtime.compactActiveConversation(undefined, trace, events, {
    model: stubModel,
  });
  assert.equal(compactResult.outcome, "compacted", `压缩必须真实发生：${compactResult.outcome}`);

  // ── R1：A 保留（内容投影或 preserved tail 任一口径），B 清除（too-large 引用）──
  assert.equal(readFileState.has(keyA), true, "压缩后 A 的已读状态必须保留（修复前被整表清空）");
  assert.equal(readFileState.has(keyB), false, "压缩后 too-large 的 B 必须清除，与引用提醒文案自洽");

  // ── 真实 Edit：A 直接可编辑（修复前这里必报 FILE_NOT_READ）──
  const editA = await editToolEntry.handler(
    { file_path: fileA, old_string: "alpha", new_string: "ALPHA" },
    toolContext("tc-edit-a"),
  );
  assert.notEqual(editA?.result, false, `压缩后首次 Edit 不得误报：${JSON.stringify(editA)}`);
  assert.equal(await readFile(fileA, "utf8"), "ALPHA\nbeta\n", "Edit 真实落盘");

  // ── 真实 Edit：B 如实拒绝，错误码契约不变 ──
  const editB = await editToolEntry.handler(
    { file_path: fileB, old_string: "header", new_string: "HEADER" },
    toolContext("tc-edit-b"),
  );
  assert.equal(editB.result, false);
  assert.equal(editB.errorCode, EditErrorCode.FILE_NOT_READ);
  assert.match(editB.message, /has not been read yet/);
  assert.equal((await readFile(fileB, "utf8")).startsWith("header\n"), true, "B 未被修改");
});
