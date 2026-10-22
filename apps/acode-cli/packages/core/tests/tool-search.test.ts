// ============================================================
// tool-search wave 1a 单测（specs/tool-search.md 测试矩阵 core/contracts 行）
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolSearchInputJsonSchema,
  ToolSearchAnnouncementSchema,
  PersistedToolSearchContentSchema,
  TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  type ModelToolContract,
} from "@acode/contracts";
import { searchTools } from "../src/tool/search/search.js";
import { collectToolSearchHistory } from "../src/tool/search/history.js";
import {
  buildToolExposure,
  computeCompactPromotedTools,
  isDeferredTool,
  resolveToolSearchMode,
} from "../src/tool/search/exposure.js";
import { resolveDeferredToolCallTarget } from "../src/tool/handlers/deferred-tool-call.js";
import {
  hydrateCompactDiscovery,
  hydrateToolSearchAnnouncement,
  hydrateToolSearchContent,
} from "../src/agent/tool-search-hydration.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

// -----------------------------------------------
// 测试基元
// -----------------------------------------------

function tool(name: string, description?: string): ModelToolContract {
  return { name, inputSchema: { type: "object" }, ...(description ? { description } : {}) };
}

function toolResultEntry(
  toolName: string,
  content: RuntimeMessageEntry extends { kind: "attachment" } ? never : unknown,
): RuntimeMessageEntry {
  return {
    kind: "message",
    message: {
      role: "tool",
      toolName,
      toolCallId: `call-${toolName}-${Math.random().toString(36).slice(2, 6)}`,
      content: content as never,
    },
    metadata: { source: "shared_context" },
  } as RuntimeMessageEntry;
}

function assistantEntry(): RuntimeMessageEntry {
  return {
    kind: "message",
    message: { role: "assistant", content: "ok" },
    metadata: { source: "shared_context" },
  } as RuntimeMessageEntry;
}

function ref(toolName: string) {
  return { type: "tool_reference" as const, toolName };
}

const FACTS = { supportsToolCall: true };

// -----------------------------------------------
// 搜索算法（R5：select/关键词/加权/截断/稳定序）
// -----------------------------------------------

test("searchTools: select 直选按名称与别名精确命中", () => {
  const catalog = [
    { name: "TodoWrite", deferred: true },
    { name: "CronCreate", aliases: ["cron_create"], deferred: true },
    { name: "Read", deferred: false },
  ];
  assert.deepEqual(searchTools("select:TodoWrite,CronCreate", catalog), [
    "TodoWrite",
    "CronCreate",
  ]);
  assert.deepEqual(searchTools("select:cron_create", catalog), ["CronCreate"]);
  // 直选常驻工具也允许（返回定义供参考）
  assert.deepEqual(searchTools("select:Read", catalog), ["Read"]);
  assert.deepEqual(searchTools("select:NoSuchTool", catalog), []);
});

test("searchTools: 关键词加权 名称 > searchHint > description", () => {
  const catalog = [
    { name: "SessionSearch", deferred: true, description: "unrelated text" },
    { name: "Digest", deferred: true, searchHint: "session summary", description: "x" },
    { name: "Other", deferred: true, description: "search the session store" },
  ];
  const results = searchTools("session search", catalog);
  // 名称命中权重最高排第一；searchHint 命中第二；仅 description 命中最后。
  assert.equal(results[0], "SessionSearch");
  assert.equal(results[1], "Digest");
  assert.equal(results[2], "Other");
});

test("searchTools: 只返回 deferred 候选且截断到 max_results，同分稳定序", () => {
  const catalog = [
    { name: "ToolA", deferred: true, description: "widget" },
    { name: "ToolB", deferred: true, description: "widget" },
    { name: "ToolC", deferred: true, description: "widget" },
    { name: "Resident", deferred: false, description: "widget" },
  ];
  const results = searchTools("widget", catalog, 2);
  assert.deepEqual(results, ["ToolA", "ToolB"]); // 截断 + 目录顺序稳定
  assert.ok(!results.includes("Resident"));
});

test("searchTools: +term 是名称硬过滤", () => {
  const catalog = [
    { name: "mcp__slack__send_message", deferred: true, mcp: { serverName: "slack", toolName: "send_message" } },
    { name: "SendMessage", deferred: true, description: "team messaging" },
  ];
  assert.deepEqual(searchTools("+slack send", catalog), ["mcp__slack__send_message"]);
});

// -----------------------------------------------
// 模式解析与启用判定（R1/R2/R12）
// -----------------------------------------------

test("resolveToolSearchMode: off 直通；native 显式报错；auto 落 local", () => {
  assert.equal(resolveToolSearchMode("off", FACTS), "off");
  assert.throws(() => resolveToolSearchMode("native", FACTS), /not implemented/);
  assert.equal(resolveToolSearchMode("auto", FACTS), "local");
  // defaultEnabled 恒 false（ACode 无 coding-plan 面）：capability 在场也不升 native。
  assert.equal(
    resolveToolSearchMode("auto", {
      supportsToolCall: true,
      capability: { protocolSupported: true, defaultEnabled: false },
    }),
    "local",
  );
});

test("resolveToolSearchMode: 模型不支持工具调用时 local 报错、auto 降 off", () => {
  assert.throws(() => resolveToolSearchMode("local", { supportsToolCall: false }), /tool calls/);
  assert.equal(resolveToolSearchMode("auto", { supportsToolCall: false }), "off");
});

test("isDeferredTool: 控制工具/原生/alwaysLoad 永不 defer；MCP 默认 defer", () => {
  assert.equal(isDeferredTool(tool(TOOL_SEARCH_NAME), { shouldDefer: true } as never), false);
  assert.equal(isDeferredTool(tool(DEFERRED_TOOL_CALL_NAME), { shouldDefer: true } as never), false);
  assert.equal(
    isDeferredTool(tool("X"), { shouldDefer: true, alwaysLoad: true } as never),
    false,
  );
  assert.equal(isDeferredTool(tool("X"), { shouldDefer: true } as never), true);
  assert.equal(
    isDeferredTool(tool("mcp__s__t"), {
      mcpPresentation: { serverName: "s", toolName: "t" },
    } as never),
    true,
  );
  assert.equal(isDeferredTool({ ...tool("X"), providerNative: { kind: "web_search" } as never }, { shouldDefer: true } as never), false);
});

// -----------------------------------------------
// 请求投影（R7）与 off 红线
// -----------------------------------------------

function exposureInput(mode: "off" | "local", entries: RuntimeMessageEntry[] = []) {
  const resident = tool("Read");
  const deferredA = tool("TodoWrite", "todo list");
  const deferredB = tool("CronCreate", "cron");
  const controls = [tool(TOOL_SEARCH_NAME), tool(DEFERRED_TOOL_CALL_NAME)];
  const tools = [resident, deferredA, deferredB, ...controls];
  const registry = {
    get: (name: string) =>
      ({
        metadata: {
          name,
          shouldDefer: name === "TodoWrite" || name === "CronCreate",
        },
      }) as never,
  };
  return { tools, registry, entries, mode };
}

test("off 红线：mode=off 时 tools 为全量目录、entries 原样（引用共享）", () => {
  const entries = [toolResultEntry(TOOL_SEARCH_NAME, [ref("TodoWrite")])];
  const input = exposureInput("off", entries);
  const result = buildToolExposure({ facts: FACTS, ...input });
  assert.equal(result.enabled, false);
  assert.deepEqual(
    result.tools.map((t) => t.name).sort(),
    ["CronCreate", DEFERRED_TOOL_CALL_NAME, "Read", "TodoWrite", TOOL_SEARCH_NAME],
  );
  // off 不注册控制工具时目录也应原样（此处控制工具在目录内，仍全量发送）。
  assert.equal(result.entries.length, entries.length);
  assert.equal(result.context.enabled, false);
  assert.equal(result.context.mode, "off");
});

test("off 模式下历史 tool_reference 被移除为占位文本", () => {
  const entries = [toolResultEntry(TOOL_SEARCH_NAME, [ref("TodoWrite")])];
  const result = buildToolExposure({ facts: FACTS, ...exposureInput("off", entries) });
  const content = (result.entries[0] as { message: { content: unknown[] } }).message.content;
  assert.equal(content.length, 1);
  assert.match(String((content[0] as { text: string }).text), /not enabled/);
});

test("local 启用判定：无 deferred → off + no_deferred_tools；控制工具被禁 → tool_unavailable", () => {
  const allResident = [tool("Read"), tool(TOOL_SEARCH_NAME), tool(DEFERRED_TOOL_CALL_NAME)];
  const residentRegistry = { get: () => ({ metadata: { name: "x" } }) as never };
  const r1 = buildToolExposure({
    facts: FACTS,
    mode: "local",
    tools: allResident,
    registry: residentRegistry,
    entries: [],
  });
  assert.equal(r1.enabled, false);
  assert.equal(r1.reason, "no_deferred_tools");

  const r2 = buildToolExposure({
    facts: FACTS,
    mode: "local",
    tools: [tool("Read"), tool("TodoWrite")], // 控制工具被作用域禁用（缺席）
    registry: {
      get: (name: string) => ({ metadata: { name, shouldDefer: name === "TodoWrite" } }) as never,
    },
    entries: [],
  });
  assert.equal(r2.enabled, false);
  assert.equal(r2.reason, "tool_unavailable");
});

test("local tools 投影：只含常驻+控制，deferred schema 不进 tools", () => {
  const result = buildToolExposure({ facts: FACTS, ...exposureInput("local") });
  assert.equal(result.enabled, true);
  const names = result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [DEFERRED_TOOL_CALL_NAME, "Read", TOOL_SEARCH_NAME]);
  // ToolSearch 描述被 local 文案覆盖
  const ts = result.tools.find((t) => t.name === TOOL_SEARCH_NAME)!;
  assert.match(ts.description ?? "", /DeferredToolCall/);
});

test("local 投影：多引用混合文本按顺序展开、连续引用合并单容器、不输出空容器", () => {
  const input = exposureInput("local");
  const entry = toolResultEntry(TOOL_SEARCH_NAME, [
    { type: "text", text: "found:" },
    ref("TodoWrite"),
    ref("CronCreate"),
  ]);
  const result = buildToolExposure({ facts: FACTS, ...input, entries: [entry] });
  const projected = result.entries[0] as { message: { content: { type: string; text?: string }[] } };
  const texts = projected.message.content.map((b) => b.text ?? b.type);
  // text("found:") + functions 容器 + loaded 提醒
  assert.equal(projected.message.content[0]!.text, "found:");
  const container = projected.message.content[1]!.text!;
  assert.match(container, /^<functions>\n/);
  assert.ok(container.includes('"name":"TodoWrite"'));
  assert.ok(container.includes('"name":"CronCreate"'));
  // 顺序保持：TodoWrite 定义在 CronCreate 之前
  assert.ok(container.indexOf("TodoWrite") < container.indexOf("CronCreate"));
  assert.equal(projected.message.content.length, 3);
  assert.ok(texts[2]!.includes("Loaded:"));
});

test("local 投影：失效引用（工具已移除）降级为占位文本，无空容器", () => {
  const input = exposureInput("local");
  const entry = toolResultEntry(TOOL_SEARCH_NAME, [ref("RemovedTool")]);
  const result = buildToolExposure({ facts: FACTS, ...input, entries: [entry] });
  const projected = result.entries[0] as { message: { content: { text?: string }[] } };
  assert.equal(projected.message.content.length, 1);
  assert.match(projected.message.content[0]!.text ?? "", /no longer available/);
});

test("local 投影：稳定前缀——未变化的 entry 复用原对象引用", () => {
  const input = exposureInput("local");
  const untouched = assistantEntry();
  const searchEntry = toolResultEntry(TOOL_SEARCH_NAME, [ref("TodoWrite")]);
  const result = buildToolExposure({
    facts: FACTS,
    ...input,
    entries: [untouched, searchEntry],
  });
  assert.equal(result.entries[0], untouched); // 同一引用
  assert.notEqual(result.entries[1], searchEntry); // 被展开的才复制
});

test("发现集合：引用与 compact 边界元数据都进 discovered", () => {
  const entries: RuntimeMessageEntry[] = [
    toolResultEntry(TOOL_SEARCH_NAME, [ref("TodoWrite")]),
    {
      kind: "message",
      message: { role: "user", content: "compact" },
      metadata: {
        source: "shared_context",
        compactBoundary: { boundaryId: "b1", preCompactDiscoveredTools: ["CronCreate"] },
      },
    } as RuntimeMessageEntry,
  ];
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(entries);
  assert.deepEqual([...discovered].sort(), ["CronCreate", "TodoWrite"]);
  assert.deepEqual([...preCompactDiscoveredTools], ["CronCreate"]);
});

test("compact 检查点提升：已发现的 deferred 工具在 local 下不再 defer", () => {
  const promoted = computeCompactPromotedTools(new Set(["TodoWrite", "Gone"]), [
    { name: "TodoWrite", deferred: true },
    { name: "CronCreate", deferred: true },
  ]);
  assert.deepEqual(promoted, ["TodoWrite"]);

  const entries: RuntimeMessageEntry[] = [
    {
      kind: "message",
      message: { role: "user", content: "compact" },
      metadata: {
        source: "shared_context",
        compactBoundary: { preCompactDiscoveredTools: ["TodoWrite"] },
      },
    } as RuntimeMessageEntry,
  ];
  const result = buildToolExposure({ facts: FACTS, ...exposureInput("local"), entries });
  // TodoWrite 提升为普通 tools；CronCreate 仍 deferred 不进 tools
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("TodoWrite"));
  assert.ok(!names.includes("CronCreate"));
  assert.ok(names.includes(TOOL_SEARCH_NAME)); // 全部提升后控制入口仍在
});

// -----------------------------------------------
// DeferredToolCall 准入矩阵（R6）
// -----------------------------------------------

test("DeferredToolCall 准入：未启用/常驻/未知目标/畸形入参拒绝，deferred 目标放行", () => {
  const context = {
    toolSearch: {
      mode: "local" as const,
      enabled: true,
      catalog: [
        { name: "TodoWrite", deferred: true },
        { name: "Read", deferred: false },
        { name: TOOL_SEARCH_NAME, deferred: false },
      ],
      discovered: new Set<string>(),
    },
  };
  assert.equal(resolveDeferredToolCallTarget({ name: "TodoWrite", input: {} }, context).ok, true);
  const resident = resolveDeferredToolCallTarget({ name: "Read", input: {} }, context);
  assert.equal(resident.ok, false);
  assert.match((resident as { reason: string }).reason, /not a deferred tool/);
  // 防伪纪律：拒绝文案不回显请求名（外部可控字符串不得原样回流进模型回执/轨迹）。
  assert.ok(!(resident as { reason: string }).reason.includes("Read"));
  const control = resolveDeferredToolCallTarget({ name: TOOL_SEARCH_NAME, input: {} }, context);
  assert.equal(control.ok, false);
  assert.equal(
    resolveDeferredToolCallTarget({ name: "Ghost", input: {} }, context).ok,
    false,
  );
  assert.equal(resolveDeferredToolCallTarget({ name: "TodoWrite" }, context).ok, false); // 缺 input
  assert.equal(
    resolveDeferredToolCallTarget({ name: "TodoWrite", input: {}, extra: 1 }, context).ok,
    false,
  ); // strict
  // 未启用（context 缺席）拒绝
  assert.equal(resolveDeferredToolCallTarget({ name: "TodoWrite", input: {} }, {}).ok, false);
  const enabled = resolveDeferredToolCallTarget({ name: "TodoWrite", input: { a: 1 } }, context);
  assert.deepEqual(enabled, { ok: true, name: "TodoWrite", input: { a: 1 } });
});

// -----------------------------------------------
// 水合（R10）
// -----------------------------------------------

test("hydrateToolSearchContent: 合法返回引用块；非法回退 undefined 并 warn 一次", () => {
  const valid = [{ type: "tool_reference", toolName: "TodoWrite" }];
  assert.deepEqual(hydrateToolSearchContent(valid), valid);
  assert.equal(hydrateToolSearchContent(undefined), undefined);
  let warns = 0;
  const logger = { warn: () => (warns += 1) } as never;
  assert.equal(hydrateToolSearchContent([], logger), undefined); // min 1 拒绝
  assert.equal(hydrateToolSearchContent([{ type: "bogus" }], logger), undefined);
  assert.equal(warns, 2);
});

test("hydrateCompactDiscovery / hydrateToolSearchAnnouncement", () => {
  const discovery = hydrateCompactDiscovery({
    boundaryId: "b1",
    trigger: "manual",
    preCompactTokenCount: 2,
    summarizedMessageCount: 3,
    traceId: "trace-1",
    preCompactDiscoveredTools: ["TodoWrite"],
  });
  assert.deepEqual(discovery?.preCompactDiscoveredTools, ["TodoWrite"]);
  assert.equal(hydrateCompactDiscovery({ bogus: true }), undefined);

  const delta = { addedNames: ["A"], removedNames: [], readdedNames: ["A"] };
  assert.deepEqual(hydrateToolSearchAnnouncement(delta), delta);
  // readded ⊄ added → schema 拒绝
  assert.equal(
    hydrateToolSearchAnnouncement({ addedNames: [], removedNames: [], readdedNames: ["A"] }),
    undefined,
  );
});

// -----------------------------------------------
// contracts schema（测试矩阵 contracts 行）
// -----------------------------------------------

test("ToolSearchInputJsonSchema: 模型侧双 required", () => {
  assert.deepEqual(ToolSearchInputJsonSchema.required, ["query", "max_results"]);
});

test("ToolSearchAnnouncementSchema: readded ⊆ added 是 schema 级不变量", () => {
  assert.equal(
    ToolSearchAnnouncementSchema.safeParse({
      addedNames: ["A"],
      removedNames: [],
      readdedNames: ["A"],
    }).success,
    true,
  );
  assert.equal(
    ToolSearchAnnouncementSchema.safeParse({
      addedNames: ["A"],
      removedNames: [],
      readdedNames: ["B"],
    }).success,
    false,
  );
});

test("PersistedToolSearchContentSchema: 空数组拒绝，text|tool_reference 混合接受", () => {
  assert.equal(PersistedToolSearchContentSchema.safeParse([]).success, false);
  assert.equal(
    PersistedToolSearchContentSchema.safeParse([
      { type: "text", text: "hi" },
      { type: "tool_reference", toolName: "A" },
    ]).success,
    true,
  );
});
