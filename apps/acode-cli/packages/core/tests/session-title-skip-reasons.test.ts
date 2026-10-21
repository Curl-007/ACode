// specs/session-title-generation.md 验收场景 1-2：标题生成启用面与静默跳过留痕。
// 根因回归：桌面链路 config.titleGeneration 缺省曾静默跳过（零日志），标题永久
// 停留 first_input 截断原文。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { maybeStartSessionTitleGeneration } from "../src/runtime/methods/session-title.js";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createInMemorySessionEventStore } from "../../contracts/src/events/in-memory-session-event-store.js";

const trace = {
  attributes: {},
  sessionId: "sess_title_skip",
  spanId: "span_title_skip",
  traceId: "trace_title_skip",
} as never;

interface LogRecord {
  level: string;
  message: string;
  details?: Record<string, unknown>;
}

function captureLogger() {
  const records: LogRecord[] = [];
  const make = (): unknown => ({
    debug: (message: string, details?: Record<string, unknown>) =>
      records.push({ level: "debug", message, details }),
    info: (message: string, details?: Record<string, unknown>) =>
      records.push({ level: "info", message, details }),
    warn: (message: string, details?: Record<string, unknown>) =>
      records.push({ level: "warn", message, details }),
    error: (message: string, details?: Record<string, unknown>) =>
      records.push({ level: "error", message, details }),
    child: () => make(),
  });
  return { records, logger: make() as Record<string, unknown> };
}

async function fixture(
  t: import("node:test").TestContext,
  config: Record<string, unknown>,
  modelText = "Nicely Generated Title",
) {
  const dir = await mkdtemp(join(tmpdir(), "acode-title-skip-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "sessions.db") });
  await store.createSession({
    directory: dir,
    id: "sess_title_skip",
    projectID: "proj_title",
    slug: "title-skip",
    title: "seed title",
    version: "v4",
  });
  const capture = captureLogger();
  const stubModel: Record<string, unknown> = {
    providerId: "test",
    modelId: "test",
    options: {},
    properties: { contextWindow: 100_000, inputFormat: { supportsText: true } },
    optionSpecs: { maxOutputTokens: { max: 1000 }, reasoningLevel: { values: [] } },
    generateText: async () => ({ text: modelText, finishReason: "stop", usage: {} }),
  };
  // sidecar 会 baseModel.bind(auxiliary options)：stub 必须自返。
  stubModel.bind = () => stubModel;
  const runtime = new AgentRuntime(
    "sess_title_skip",
    { mode: "build", workingDirectory: dir, ...config },
    {
      eventStore: createInMemorySessionEventStore(),
      logger: capture.logger as never,
      modelFactory: () => stubModel as never,
      sessionStore: store,
      traceContext: trace,
    },
  );
  t.after(async () => {
    runtime.beginShutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { capture, runtime, store };
}

function skipReasons(capture: { records: LogRecord[] }): string[] {
  return capture.records
    .filter(
      (record) =>
        record.level === "debug" && record.details?.event === "session_title_generation.skipped",
    )
    .map((record) => String(record.details?.reason));
}

test("title: config 缺省 → 静默跳过留痕 config_absent（根因回归钉）", async (t) => {
  const { capture, runtime } = await fixture(t, {});
  const started = maybeStartSessionTitleGeneration.call(
    runtime,
    "long enough first input for title generation",
    "msg_1" as never,
    trace,
  );
  assert.equal(started, false);
  assert.deepEqual(skipReasons(capture), ["config_absent"]);
});

test("title: 显式禁用 → reason disabled（automation 语义不变）", async (t) => {
  const { capture, runtime } = await fixture(t, { titleGeneration: { enabled: false } });
  const started = maybeStartSessionTitleGeneration.call(
    runtime,
    "long enough first input for title generation",
    "msg_1" as never,
    trace,
  );
  assert.equal(started, false);
  assert.deepEqual(skipReasons(capture), ["disabled"]);
});

test("title: 短首发输入 → reason short_input（不覆盖可读短标题）", async (t) => {
  const { capture, runtime } = await fixture(t, { titleGeneration: {} });
  const started = maybeStartSessionTitleGeneration.call(runtime, "hi", "msg_1" as never, trace);
  assert.equal(started, false);
  assert.deepEqual(skipReasons(capture), ["short_input"]);
});

test("title: 非首轮 → reason not_first_turn", async (t) => {
  const { capture, runtime } = await fixture(t, { titleGeneration: {} });
  (runtime as unknown as { turnNumber: number }).turnNumber = 1;
  const started = maybeStartSessionTitleGeneration.call(
    runtime,
    "long enough first input for title generation",
    "msg_1" as never,
    trace,
  );
  assert.equal(started, false);
  assert.deepEqual(skipReasons(capture), ["not_first_turn"]);
});

test("title: 启用面完整时 sidecar 生成并迁移 title_source=generated", async (t) => {
  const { capture, runtime, store } = await fixture(t, {
    titleGeneration: {},
    modelSelection: { providerId: "test", modelId: "test" },
  });
  const started = maybeStartSessionTitleGeneration.call(
    runtime,
    "fix the session title generation pipeline end to end",
    "msg_1" as never,
    trace,
  );
  assert.equal(started, true);
  const deadline = Date.now() + 5_000;
  let session: { titleSource?: string; title?: string } | null = null;
  while (Date.now() < deadline) {
    session = (await store.getSession("sess_title_skip")) as typeof session;
    if (session?.titleSource === "generated") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    session?.titleSource,
    "generated",
    `标题来源必须迁移为 generated；全部留痕：${JSON.stringify(capture.records)}`,
  );
  assert.equal(session?.title, "Nicely Generated Title");
});
