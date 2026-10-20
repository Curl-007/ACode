// ============================================================
// tool-search wave 1b 接线单测（specs/tool-search.md R6/R8/R9/R10）
// ============================================================
// 覆盖四个接线点：compact 提升写侧、冷恢复水合三恢复点、DeferredToolCall
// 包装标记持久化与请求渲染恢复、embedded-search 分支重注册透传。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMessageId,
  createPartId,
  createRootTraceContext,
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type ModelToolContract,
} from "@acode/contracts";
import { buildManualCompactBoundary } from "../src/compact/manual.js";
import {
  collectToolSearchHistory,
  compactDiscoveryMetadata,
} from "../src/tool/search/history.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import {
  createMessageHistory,
  cloneModelInputMessage,
  toModelToolCall,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { completedToolPartMetadata } from "../src/runtime/methods/tool-part-metadata.js";
import { refreshBranchAwareBuiltInTools } from "../src/runtime/methods/embedded-search-branch.js";
import { createToolRegistry } from "../src/tool/registry.js";

// -----------------------------------------------
// 测试基元（跟随 tool-search.test.ts 风格）
// -----------------------------------------------

function tool(name: string, description?: string): ModelToolContract {
  return { name, inputSchema: { type: "object" }, ...(description ? { description } : {}) };
}

const FACTS = { supportsToolCall: true };

function deferredRegistry(deferredNames: readonly string[]) {
  return {
    get: (name: string) =>
      ({
        metadata: { name, shouldDefer: deferredNames.includes(name) },
      }) as never,
  };
}

const CONTROL_TOOLS = [tool(TOOL_SEARCH_NAME), tool(DEFERRED_TOOL_CALL_NAME)];

/** 最小 MessageWithParts 夹具：hydrator 只读 info.role/source/metadata 与 parts。 */
function messageFixture(
  role: "user" | "assistant",
  parts: Record<string, unknown>[],
  infoExtra: Record<string, unknown> = {},
) {
  return {
    info: { id: createMessageId(), role, time: { created: Date.now() }, ...infoExtra },
    parts: parts.map((part) => ({
      id: createPartId(),
      sessionID: "sess_test",
      messageID: "msg_test",
      ...part,
    })),
  };
}

function toolPartFixture(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool",
    callID: `call-${Math.random().toString(36).slice(2, 8)}`,
    tool: "TodoWrite",
    state: {
      status: "completed",
      input: { todos: ["x"] },
      output: "done",
      time: { start: 1, end: 2 },
    },
    ...overrides,
  };
}

function countWarnLogger() {
  const state = { warns: 0 };
  return {
    state,
    logger: { warn: () => (state.warns += 1) } as never,
  };
}

async function hydrate(messages: unknown[], logger?: unknown) {
  const history = createMessageHistory();
  await hydrateMessageHistoryFromSession({
    history,
    messages: messages as never,
    ...(logger ? { logger: logger as never } : {}),
  });
  return history;
}

function toolEntries(entries: readonly RuntimeMessageEntry[]) {
  return entries.filter(
    (entry) => entry.kind !== "attachment" && entry.message.role === "tool",
  ) as Array<{ message: Record<string, never> & { content: unknown; toolName?: string } }>;
}

// -----------------------------------------------
// 接线点 1：compact 提升写侧（R8/R10）
// -----------------------------------------------

test("compact 写侧：发现名称进边界 payload；无发现时字段缺席", () => {
  const traceContext = createRootTraceContext({});
  const base = {
    boundaryId: "b1",
    preCompactTokenCount: 10,
    summarizedMessageCount: 2,
    summaryMessageId: createMessageId(),
    traceContext,
  };
  const withDiscovery = buildManualCompactBoundary({
    ...base,
    preCompactDiscoveredTools: ["TodoWrite", "CronCreate"],
  });
  assert.deepEqual(withDiscovery.preCompactDiscoveredTools, ["TodoWrite", "CronCreate"]);

  // 无发现（含默认 off）：字段缺席——off 路径边界 payload 字节零变化。
  const empty = buildManualCompactBoundary({ ...base, preCompactDiscoveredTools: [] });
  assert.equal("preCompactDiscoveredTools" in empty, false);
  const absent = buildManualCompactBoundary(base);
  assert.equal("preCompactDiscoveredTools" in absent, false);
});

test("compact 写侧→读侧 roundtrip：collect → metadata → payload → hydrateCompactDiscovery", async () => {
  // 历史里的发现事实（ToolSearch 结果引用）经写侧纯函数进边界 payload。
  const entries = [
    {
      kind: "message",
      message: {
        role: "tool",
        toolName: TOOL_SEARCH_NAME,
        toolCallId: "call-s1",
        content: [{ type: "tool_reference", toolName: "TodoWrite" }],
      },
      metadata: { source: "shared_context" },
    } as RuntimeMessageEntry,
  ];
  const discovered = collectToolSearchHistory(entries).discovered;
  const discovery = compactDiscoveryMetadata({
    boundaryId: "b9",
    preCompactDiscoveredTools: [...discovered].sort(),
  });
  const payload = buildManualCompactBoundary({
    ...discovery,
    preCompactTokenCount: 5,
    summarizedMessageCount: 1,
    summaryMessageId: createMessageId(),
    traceContext: createRootTraceContext({}),
  });
  assert.deepEqual(payload.preCompactDiscoveredTools, ["TodoWrite"]);

  // 冷恢复：持久化 payload 经水合回填发现集合。
  const history = await hydrate([
    messageFixture("user", [
      { type: "text", text: "compact summary", synthetic: true },
      { type: "compaction", auto: false, trigger: "manual", compactBoundary: payload },
    ]),
  ]);
  const restored = history.borrowReadOnlyRuntimeEntries();
  const boundaryEntry = restored.find((entry) => entry.metadata?.compactBoundary !== undefined);
  assert.ok(boundaryEntry);
  assert.deepEqual(boundaryEntry!.metadata!.compactBoundary!.preCompactDiscoveredTools, [
    "TodoWrite",
  ]);
  // 读侧汇合：回填后的历史再次收集，发现集合恢复。
  const recollected = collectToolSearchHistory(restored);
  assert.deepEqual([...recollected.discovered], ["TodoWrite"]);
  assert.deepEqual([...recollected.preCompactDiscoveredTools], ["TodoWrite"]);
});

// -----------------------------------------------
// 接线点 2：水合三恢复点（R10）
// -----------------------------------------------

test("水合 roundtrip：持久化 ToolSearch content → hydrate → local 投影恢复引用展开", async () => {
  const history = await hydrate([
    messageFixture("assistant", [
      toolPartFixture({
        tool: TOOL_SEARCH_NAME,
        state: {
          status: "completed",
          input: { query: "select:TodoWrite", max_results: 5 },
          output: '{"matches":["TodoWrite"]}',
          metadata: {
            modelContent: [{ type: "tool_reference", toolName: "TodoWrite" }],
          },
          time: { start: 1, end: 2 },
        },
      }),
    ]),
  ]);
  const entries = history.borrowReadOnlyRuntimeEntries();
  const resultEntry = toolEntries(entries)[0]!;
  // 恢复的是真实引用块，不是 output 摘要文本。
  assert.deepEqual(resultEntry.message.content, [
    { type: "tool_reference", toolName: "TodoWrite" },
  ]);

  // 引用经 local 投影在真实结果位置展开为 functions 容器。
  const exposure = buildToolExposure({
    facts: FACTS,
    mode: "local",
    tools: [tool("Read"), tool("TodoWrite", "todo list"), ...CONTROL_TOOLS],
    registry: deferredRegistry(["TodoWrite"]),
    entries: [...entries],
  });
  assert.equal(exposure.enabled, true);
  const projected = toolEntries(exposure.entries)[0]!;
  const blocks = projected.message.content as Array<{ type: string; text?: string }>;
  const container = blocks.find((block) => block.text?.startsWith("<functions>"));
  assert.ok(container, "expected functions container");
  assert.ok(container!.text!.includes('"name":"TodoWrite"'));
});

test("水合回退：非法持久化 content 回退 legacy output 并 warn 一次", async () => {
  const { state, logger } = countWarnLogger();
  const history = await hydrate(
    [
      messageFixture("assistant", [
        toolPartFixture({
          tool: TOOL_SEARCH_NAME,
          state: {
            status: "completed",
            input: { query: "x", max_results: 5 },
            output: "legacy summary text",
            metadata: { modelContent: [{ type: "bogus" }] },
            time: { start: 1, end: 2 },
          },
        }),
      ]),
    ],
    logger,
  );
  const entries = history.borrowReadOnlyRuntimeEntries();
  assert.equal(toolEntries(entries)[0]!.message.content, "legacy summary text");
  assert.equal(state.warns, 1);
});

test("公告水合：runtimeMessage 增量事实重建 attachment；非法 delta 按 legacy 处理", async () => {
  const delta = { addedNames: ["TodoWrite"], removedNames: [], readdedNames: [] };
  const history = await hydrate([
    messageFixture("user", [
      {
        type: "text",
        text: "The following deferred tools are available via ToolSearch.",
        synthetic: true,
        metadata: {
          source: "tool_search_announcement",
          visibility: "model-only",
          runtimeMessage: { source: "tool_search_announcement", toolSearchAnnouncement: delta },
        },
      },
    ]),
  ]);
  const entries = history.borrowReadOnlyRuntimeEntries();
  assert.equal(entries.length, 1);
  const attachment = entries[0]!;
  assert.equal(attachment.kind, "attachment");
  assert.equal(attachment.metadata?.source, "tool_search_announcement");
  assert.deepEqual(attachment.metadata?.toolSearchAnnouncement, delta);

  // readded ⊄ added：schema 拒绝 → 按 legacy synthetic 恢复（不 fail、不建公告事实）。
  const broken = await hydrate([
    messageFixture("user", [
      {
        type: "text",
        text: "announcement body",
        synthetic: true,
        metadata: {
          source: "tool_search_announcement",
          runtimeMessage: {
            source: "tool_search_announcement",
            toolSearchAnnouncement: { addedNames: [], removedNames: [], readdedNames: ["A"] },
          },
        },
      },
    ]),
  ]);
  const brokenEntries = broken.borrowReadOnlyRuntimeEntries();
  assert.ok(
    brokenEntries.every(
      (entry) => entry.kind === "attachment" || entry.metadata?.toolSearchAnnouncement === undefined,
    ),
  );
});

// -----------------------------------------------
// 接线点 3：包装标记持久化 + 请求渲染恢复（R6/R10）
// -----------------------------------------------

test("wrapper：带标记 part 水合后渲染恢复包装形态、内部标记剥离", async () => {
  const history = await hydrate([
    messageFixture("assistant", [
      toolPartFixture({
        tool: "TodoWrite",
        metadata: { modelCallWrapper: DEFERRED_TOOL_CALL_NAME },
        state: {
          status: "completed",
          input: { todos: ["x"] },
          output: "done",
          time: { start: 1, end: 2 },
        },
      }),
    ]),
  ]);
  const entries = history.borrowReadOnlyRuntimeEntries();
  // 内部历史统一用目标名 + 严格字面量标记。
  const assistant = entries.find(
    (entry) => entry.kind !== "attachment" && entry.message.role === "assistant",
  )!;
  const call = (assistant.message as { toolCalls?: Array<Record<string, unknown>> }).toolCalls![0]!;
  assert.equal(call.name, "TodoWrite");
  assert.equal(call.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);
  const resultMessage = toolEntries(entries)[0]!.message as unknown as Record<string, unknown>;
  assert.equal(resultMessage.toolName, "TodoWrite");
  assert.equal(resultMessage.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);

  // 既有 provider render 遍历恢复包装形态：外层名 + {name, input}，标记剥离。
  const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: false });
  const renderedAssistant = messages.find((message) => message.role === "assistant")!;
  const renderedCall = (
    renderedAssistant.toolCalls as Array<Record<string, unknown>> | undefined
  )![0]!;
  assert.equal(renderedCall.name, DEFERRED_TOOL_CALL_NAME);
  assert.deepEqual(renderedCall.input, { name: "TodoWrite", input: { todos: ["x"] } });
  assert.equal("modelCallWrapper" in renderedCall, false);
  const renderedResult = messages.find((message) => message.role === "tool")!;
  assert.equal(renderedResult.toolName, DEFERRED_TOOL_CALL_NAME);
  assert.equal("modelCallWrapper" in renderedResult, false);
});

test("wrapper：未标记 part 不受影响（off 红线同形）", async () => {
  const history = await hydrate([
    messageFixture("assistant", [toolPartFixture({ tool: "TodoWrite" })]),
  ]);
  const entries = history.borrowReadOnlyRuntimeEntries();
  const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: false });
  const renderedAssistant = messages.find((message) => message.role === "assistant")!;
  const renderedCall = (
    renderedAssistant.toolCalls as Array<Record<string, unknown>> | undefined
  )![0]!;
  assert.equal(renderedCall.name, "TodoWrite");
  assert.deepEqual(renderedCall.input, { todos: ["x"] });
  const renderedResult = messages.find((message) => message.role === "tool")!;
  assert.equal(renderedResult.toolName, "TodoWrite");
});

test("wrapper：toModelToolCall 纯函数 + 历史复制保留标记", () => {
  const plain = { id: "c1", name: "Read", input: {} };
  assert.equal(toModelToolCall(plain), plain); // 未标记恒等
  const marked = { id: "c2", name: "TodoWrite", input: { a: 1 }, modelCallWrapper: "DeferredToolCall" as const };
  assert.deepEqual(toModelToolCall(marked), {
    id: "c2",
    name: DEFERRED_TOOL_CALL_NAME,
    input: { name: "TodoWrite", input: { a: 1 } },
  });
  // 历史复制/分支恢复保留（R6）：clone 不丢消息级标记。
  const cloned = cloneModelInputMessage({
    role: "tool",
    content: "ok",
    toolCallId: "c2",
    toolName: "TodoWrite",
    modelCallWrapper: "DeferredToolCall",
  });
  assert.equal(cloned.modelCallWrapper, DEFERRED_TOOL_CALL_NAME);
});

test("wrapper：completedToolPartMetadata 持久化引用型 modelContent，字符串型不落", () => {
  const withRefs = completedToolPartMetadata({
    modelContent: [{ type: "tool_reference", toolName: "TodoWrite" }],
  } as never);
  assert.deepEqual((withRefs as Record<string, unknown>).modelContent, [
    { type: "tool_reference", toolName: "TodoWrite" },
  ]);
  const withString = completedToolPartMetadata({ modelContent: "plain text" } as never);
  assert.equal("modelContent" in (withString as Record<string, unknown>), false);
  const without = completedToolPartMetadata({} as never);
  assert.equal("modelContent" in (without as Record<string, unknown>), false);
});

// -----------------------------------------------
// 接线点 4：embedded-search 分支透传（R4/R12）
// -----------------------------------------------

test("embedded 分支刷新：includeToolSearch 透传，控制工具仍在；off 不注册", () => {
  const localRegistry = createToolRegistry();
  refreshBranchAwareBuiltInTools({
    registry: localRegistry,
    config: { toolSearchMode: "local" },
    cachedTools: null,
  } as never);
  assert.ok(localRegistry.get(TOOL_SEARCH_NAME), "ToolSearch 应随分支刷新保留");
  assert.ok(localRegistry.get(DEFERRED_TOOL_CALL_NAME), "DeferredToolCall 应随分支刷新保留");

  const offRegistry = createToolRegistry();
  refreshBranchAwareBuiltInTools({
    registry: offRegistry,
    config: {},
    cachedTools: null,
  } as never);
  assert.equal(offRegistry.get(TOOL_SEARCH_NAME), undefined);
  assert.equal(offRegistry.get(DEFERRED_TOOL_CALL_NAME), undefined);
});

// -----------------------------------------------
// 子代理继承钉（specs/tool-search.md R3：fork/子 Agent 继承父 Runtime 策略）
// -----------------------------------------------
// child runtime config 是装配闭包内的显式逐字段构造（无导出面可行为直测），按仓库
// 惯例源码断言钉住继承分支（同 packages/services/test/scriptWorkflowModeFieldChain
// 的钉法）。fork 面不需要钉：session-fork 留在同一 runtime（config 天然共享）；
// workflow_child 经 bootstrap workflow-facade 的 `...deps.runtimeConfig` 整体展开
// 结构性继承；bootstrap fork-edit-retry 的 record 物化走 appRuntimePreferences 兜底。
test("subagent child runtime config 条件继承 toolSearchMode（缺席不写字段，零行为变化）", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/runtime/methods/subagent.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\.\.\.\(this\.config\.toolSearchMode === undefined\s*\? \{\}\s*: \{ toolSearchMode: this\.config\.toolSearchMode \}\)/,
    "child config 必须条件透传父档位（含显式 off）；父缺席时不写字段 = child 按缺席即 off",
  );
});
