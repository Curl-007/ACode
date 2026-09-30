import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * J2-1 验收测试：todo 完成置信度语义。
 *
 * 覆盖规格 apps/acode-cli/specs/todo-confidence-semantics.md 的 R1–R6 与验收场景 1–8：
 * - 场景 1：批量盖章（pending→completed / born-completed / 不足值）被拒、点名 id、
 *   updateTodos 未调用、旧表无变化；
 * - 场景 2：validated/verified 通过；grandfather 豁免（prior 已 completed 重发不受检）；
 *   重开后再完成重新受检；
 * - 场景 3：模型自报 confidenceHistory 一律 strip（数组与垃圾形状都静默丢弃）；
 * - 场景 4：追加语义（爬升/连续去重/滑动窗口/无观测不物化）；
 * - 场景 5：旧格式读写正常 + confidence_json 旧行/坏数据整列忽略 + 三代历史结果宽容解析；
 * - 场景 6：报错文案与工具描述不泄露枚举排序/门槛边界；
 * - 场景 7：真实 SQLite 持久化往返 + migration 0024 + 协议投影不带新字段（R7 收缩现状）；
 * - 场景 8：输出视图携带 history、过输出 schema、summary 五计数不受影响。
 *
 * 对抗复核修复批次（2026-09-30，specs/todo-confidence-semantics.md 实施记录第 6 条）：
 * - F1：grandfather 豁免与 R2 轨迹继承收紧为 id+content 双匹配——剪枝补位/重排洗白、
 *   显式 id 换内容被拒；存量 completed 原样重发仍豁免；轨迹不随内容变更继承（标 F1）；
 * - F2：工具描述指引措辞与门槛报错同源（"run the checks first"），不用 validat* 词根
 *   （场景6/R6 描述测试钉住）。
 */

const {
  TODO_CONFIDENCE_HISTORY_MAX,
  TodoWriteInputSchema,
  TodoReadOutputSchema,
  TodoWriteOutputSchema,
  appendConfidenceObservation,
  completionConfidencePassesGate,
  completionGateErrorMessage,
  findCompletionGateViolations,
  normalizeTodos,
  todoItemsFromToolResultContent,
} = await import("../packages/contracts/src/tools/todo.ts");
const { todoReadToolEntry, todoWriteToolEntry } = await import(
  "../packages/core/src/tool/handlers/todo.ts"
);
const { decodeTodoRow, encodeTodoConfidence } = await import(
  "../packages/adapters/src/storage/session-store/codecs.ts"
);
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { mapTodoItem } = await import(
  "../packages/bootstrap/src/acode-protocol/session-mapper.ts"
);

// —— 构造器与假 store（与 todo-dependency-fields.test.mjs 同款约定） ——

const SESSION_ID = "ses_j21_test";

function item(content, status = "pending", priority = "medium", extra = {}) {
  return { content, status, priority, ...extra };
}

function fakeStore(initial = []) {
  let current = structuredClone(initial);
  const store = {
    updateCalls: 0,
    snapshot: () => structuredClone(current),
    readTodos: async () => structuredClone(current),
    updateTodos: async ({ todos }) => {
      current = structuredClone(todos);
      store.updateCalls += 1;
    },
  };
  return store;
}

function contextFor(store, sessionId = SESSION_ID) {
  return { sessionId, sessionStore: store, toolCallId: "tc_j21_test" };
}

async function rejection(promise) {
  return promise.then(
    () => undefined,
    (error) => error,
  );
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-j21-todo-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStore(fn) {
  return withTempDir(async (dir) => {
    const dbPath = join(dir, "session.db");
    const store = createSqliteSessionStore({ dbPath });
    try {
      await store.createSession({
        id: SESSION_ID,
        projectID: "prj_j21",
        slug: "j21",
        directory: dir,
        title: "j21 todo confidence",
        version: "0.16.9",
      });
      return await fn(store, dir, dbPath);
    } finally {
      store.close();
    }
  });
}

// —— 场景 1：批量盖章被拒且点名 id（R3） ——

test("(场景1) pending→completed 无置信度：InvalidInput 点名 id，updateTodos 未调用、旧表无变化", async () => {
  const prior = [item("ship it", "pending", "high", { id: "a" })];
  const store = fakeStore(prior);
  const error = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("ship it", "completed", "high", { id: "a" })] },
      contextFor(store),
    ),
  );
  assert.ok(error, "expected rejection");
  assert.equal(error.type, "invalid_input");
  assert.match(error.message, /"a"/);
  assert.deepEqual(error.context.todoIds, ["a"]);
  assert.equal(error.recoverable, true);
  assert.equal(store.updateCalls, 0);
  assert.deepEqual(store.snapshot(), prior);
});

test("(场景1) born-completed（空 store 首写即 completed）与不足值同样被拒；多违规全点名", async () => {
  const empty = fakeStore();
  const born = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("done already", "completed", "high", { id: "n" })] },
      contextFor(empty),
    ),
  );
  assert.ok(born);
  assert.match(born.message, /"n"/);
  assert.equal(empty.updateCalls, 0);

  // 不足值（plausible）：与缺失共用单一文案模板（区分两者会泄露边界，R3）。
  const weak = fakeStore([item("a", "pending", "high", { id: "a" })]);
  const weakError = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("a", "completed", "high", { id: "a", completionConfidence: "plausible" })] },
      contextFor(weak),
    ),
  );
  assert.ok(weakError);
  assert.match(weakError.message, /"a"/);
  assert.equal(
    weakError.message.replace(/"a"/g, '"X"'),
    born.message.replace(/"n"/g, '"X"'),
    "缺失与不足必须共用单一模板",
  );
  assert.equal(weak.updateCalls, 0);

  // 多个违规一次点名全部 id：
  const many = fakeStore([
    item("a", "pending", "high", { id: "a" }),
    item("b", "in_progress", "high", { id: "b" }),
  ]);
  const manyError = await rejection(
    todoWriteToolEntry.handler(
      {
        todos: [
          item("a", "completed", "high", { id: "a" }),
          item("b", "completed", "high", { id: "b", completionConfidence: "speculative" }),
        ],
      },
      contextFor(many),
    ),
  );
  assert.ok(manyError);
  assert.match(manyError.message, /^todos "a", "b" are/);
  assert.deepEqual(manyError.context.todoIds, ["a", "b"]);
});

// —— 场景 2：validated/verified 通过；grandfather 豁免；重开重检（R3） ——

test("(场景2) validated/verified 标 completed 通过", async () => {
  const store = fakeStore([
    item("a", "pending", "high", { id: "a" }),
    item("b", "in_progress", "high", { id: "b" }),
  ]);
  const output = await todoWriteToolEntry.handler(
    {
      todos: [
        item("a", "completed", "high", { id: "a", completionConfidence: "validated" }),
        item("b", "completed", "high", { id: "b", completionConfidence: "verified" }),
      ],
    },
    contextFor(store),
  );
  assert.equal(output.summary.completed, 2);
  assert.equal(store.updateCalls, 1);
});

test("(场景2) grandfather 豁免：prior 已 completed（升级前存量、无置信度）原样重发成功且不物化 history", async () => {
  const legacy = [item("old", "completed", "high", { id: "o" })];
  const store = fakeStore(legacy);
  const output = await todoWriteToolEntry.handler(
    { todos: [item("old", "completed", "high", { id: "o" })] },
    contextFor(store),
  );
  assert.equal(output.summary.completed, 1);
  assert.deepEqual(store.snapshot(), legacy, "不得物化 confidenceHistory/completionConfidence 键");
  assert.ok(!("confidenceHistory" in store.snapshot()[0]));
});

test("(场景2) 重开后再完成重新受检（completed→pending→completed 无置信度被拒）", async () => {
  const store = fakeStore([
    item("a", "completed", "high", { id: "a", completionConfidence: "verified" }),
  ]);
  // 重开：
  await todoWriteToolEntry.handler(
    { todos: [item("a", "pending", "high", { id: "a" })] },
    contextFor(store),
  );
  // 再次完成但无置信度 → 拒绝：
  const error = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("a", "completed", "high", { id: "a" })] },
      contextFor(store),
    ),
  );
  assert.ok(error);
  assert.match(error.message, /"a"/);
});

test("(R3) 门槛纯函数：只检新转移、born-completed 受检、rank 谓词边界", () => {
  const prior = normalizeTodos([
    item("done", "completed", "high", { id: "done" }),
    item("open", "pending", "high", { id: "open" }),
  ]);
  const submitted = normalizeTodos([
    item("done", "completed", "high", { id: "done" }), // grandfather → 豁免
    item("open", "completed", "high", { id: "open" }), // 新转移无置信度 → 违规
    item("new", "completed", "high", { id: "new", completionConfidence: "verified" }), // 过线
  ]);
  assert.deepEqual(findCompletionGateViolations(submitted, prior), [{ id: "open", index: 1 }]);

  assert.equal(completionConfidencePassesGate(undefined), false);
  assert.equal(completionConfidencePassesGate("speculative"), false);
  assert.equal(completionConfidencePassesGate("plausible"), false);
  assert.equal(completionConfidencePassesGate("validated"), true);
  assert.equal(completionConfidencePassesGate("verified"), true);
});

// —— 对抗复核 F1：grandfather 豁免 × 位置派生 id（id+content 双匹配） ——

test("(F1) 门槛纯函数：豁免要求 id+content 双匹配，同 id 换内容视为新完成转移", () => {
  const prior = normalizeTodos([
    item("old task", "completed", "high", { id: "stable", completionConfidence: "verified" }),
  ]);
  // 同 id 换内容：id-only 豁免下是免检令牌，双匹配下是新完成转移 → 违规
  const swapped = normalizeTodos([item("new task", "completed", "high", { id: "stable" })]);
  assert.deepEqual(findCompletionGateViolations(swapped, prior), [{ id: "stable", index: 0 }]);
  // 同 id 同 content 原样重发（升级前存量形态）：豁免不变
  const resent = normalizeTodos([item("old task", "completed", "high", { id: "stable" })]);
  assert.deepEqual(findCompletionGateViolations(resent, prior), []);
});

test("(F1) 剪枝+补位完成：剪掉已完成项后 pending 项补位到同派生 id，无置信度被拒", async () => {
  const prior = [
    item("first", "completed", "high", { completionConfidence: "verified" }), // todo-0
    item("second", "pending", "high"), // todo-1
  ];
  const store = fakeStore(prior);
  // 整理列表：剪掉 first → second 补位到 todo-0 并标 completed（无置信度）。
  // id-only 豁免下此写入会洗白成功；双匹配下补位项是新完成转移。
  const error = await rejection(
    todoWriteToolEntry.handler({ todos: [item("second", "completed", "high")] }, contextFor(store)),
  );
  assert.ok(error, "expected rejection");
  assert.match(error.message, /"todo-0"/);
  assert.equal(store.updateCalls, 0, "门槛拒绝时持久化零写入");
  assert.deepEqual(store.snapshot(), prior, "旧表无变化");
});

test("(F1) 重排洗白：pending 项重排占住已完成项的原派生 id，无置信度被拒", async () => {
  const prior = [
    item("alpha", "completed", "high", { completionConfidence: "verified" }), // todo-0
    item("beta", "pending", "high"), // todo-1
  ];
  const store = fakeStore(prior);
  const error = await rejection(
    todoWriteToolEntry.handler(
      {
        todos: [
          item("beta", "completed", "high"), // 占住 todo-0（alpha 的位置 id），无置信度
          item("alpha", "completed", "high", { completionConfidence: "verified" }), // 顺延 todo-1，带证据
        ],
      },
      contextFor(store),
    ),
  );
  assert.ok(error);
  assert.match(error.message, /"todo-0"/);
  assert.equal(store.updateCalls, 0);
});

test("(F1) 显式 id 换内容：不再继承豁免，同 id 新完成转移必须重新携带证据", async () => {
  const store = fakeStore([
    item("old task", "completed", "high", { id: "stable", completionConfidence: "verified" }),
  ]);
  const error = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("new task", "completed", "high", { id: "stable" })] },
      contextFor(store),
    ),
  );
  assert.ok(error);
  assert.match(error.message, /"stable"/);
  assert.equal(store.updateCalls, 0);
});

test("(F1) 升级兼容：存量 completed（派生 id、无置信度）原样重发仍豁免", async () => {
  const legacy = [item("legacy done", "completed", "high")]; // 派生 todo-0
  const store = fakeStore(structuredClone(legacy));
  const output = await todoWriteToolEntry.handler(
    { todos: [item("legacy done", "completed", "high")] },
    contextFor(store),
  );
  assert.equal(output.summary.completed, 1);
  assert.equal(store.updateCalls, 1);
  const stored = store.snapshot()[0];
  assert.ok(!("confidenceHistory" in stored), "不物化 history");
  assert.ok(!("completionConfidence" in stored), "不物化置信度键");
});

test("(F1) 轨迹不随内容变更继承：同 id 换内容 + 合格证据，history 从本次观测重新开始", async () => {
  const store = fakeStore([
    item("old task", "completed", "high", {
      id: "stable",
      completionConfidence: "verified",
      confidenceHistory: ["speculative", "verified"],
    }),
  ]);
  // 先拒：换内容 = 新完成转移，无证据零写入。
  const firstAttempt = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("new task", "completed", "high", { id: "stable" })] },
      contextFor(store),
    ),
  );
  assert.ok(firstAttempt);
  assert.equal(store.updateCalls, 0);
  // 携带合格证据重发：写入成功，但轨迹只含本次观测，不继承旧内容的 ["speculative","verified"]。
  const output = await todoWriteToolEntry.handler(
    {
      todos: [item("new task", "completed", "high", { id: "stable", completionConfidence: "validated" })],
    },
    contextFor(store),
  );
  assert.deepEqual(output.todos[0].confidenceHistory, ["validated"]);
  assert.deepEqual(store.snapshot()[0].confidenceHistory, ["validated"]);
});

test("(F1) 剪枝补位项带合格证据：写入成功且不继承被剪项的轨迹（防伪爬升）", async () => {
  const store = fakeStore([
    item("first", "completed", "high", {
      completionConfidence: "verified",
      confidenceHistory: ["verified"],
    }), // todo-0
    item("second", "pending", "high"), // todo-1
  ]);
  const output = await todoWriteToolEntry.handler(
    { todos: [item("second", "completed", "high", { completionConfidence: "validated" })] },
    contextFor(store),
  );
  assert.equal(output.summary.completed, 1);
  assert.deepEqual(output.todos[0].confidenceHistory, ["validated"], "补位项从空轨迹重新开始");
});

// —— 场景 3：history 忽略模型自报字段（R2） ——

test("(场景3) 模型自报 confidenceHistory 被 strip：数组与垃圾形状都静默丢弃、不失败", () => {
  const withArray = TodoWriteInputSchema.parse({
    todos: [item("a", "pending", "high", { id: "a", confidenceHistory: ["verified", "verified"] })],
  });
  assert.ok(!("confidenceHistory" in withArray.todos[0]));
  const withGarbage = TodoWriteInputSchema.parse({
    todos: [item("a", "pending", "high", { confidenceHistory: "verified" })],
  });
  assert.ok(!("confidenceHistory" in withGarbage.todos[0]));
  const withObject = TodoWriteInputSchema.parse({
    todos: [item("a", "pending", "high", { confidenceHistory: { fake: true } })],
  });
  assert.ok(!("confidenceHistory" in withObject.todos[0]));
});

test("(场景3) 写入后存储轨迹只含工具追加的观测，与自报值无关", async () => {
  const store = fakeStore();
  await todoWriteToolEntry.handler(
    {
      todos: [
        item("a", "pending", "high", {
          id: "a",
          completionConfidence: "plausible",
          confidenceHistory: ["verified", "verified"],
        }),
      ],
    },
    contextFor(store),
  );
  assert.deepEqual(store.snapshot()[0].confidenceHistory, ["plausible"]);
});

// —— 场景 4：追加语义（R2） ——

test("(场景4) appendConfidenceObservation：无观测不物化、连续去重、爬升追加、滑动窗口保留最新", () => {
  assert.equal(appendConfidenceObservation(undefined, undefined), undefined);
  assert.deepEqual(appendConfidenceObservation(["plausible"], undefined), ["plausible"]);
  assert.deepEqual(appendConfidenceObservation(undefined, "plausible"), ["plausible"]);
  assert.deepEqual(appendConfidenceObservation(["plausible"], "plausible"), ["plausible"]);
  assert.deepEqual(appendConfidenceObservation(["speculative"], "plausible"), [
    "speculative",
    "plausible",
  ]);
  // 非连续重复保留（震荡是轨迹信息，jcode 同款只 dedupe 末位）：
  assert.deepEqual(appendConfidenceObservation(["plausible", "speculative"], "plausible"), [
    "plausible",
    "speculative",
    "plausible",
  ]);
  // 滑动窗口：16 条 + 新观测 → 保留最新 16 条、最旧被移出：
  const full = Array.from({ length: TODO_CONFIDENCE_HISTORY_MAX }, (_, i) =>
    i % 2 === 0 ? "speculative" : "plausible",
  );
  const windowed = appendConfidenceObservation(full, "validated");
  assert.equal(windowed.length, TODO_CONFIDENCE_HISTORY_MAX);
  assert.equal(windowed[windowed.length - 1], "validated");
  assert.deepEqual(windowed, [...full.slice(1), "validated"]);
  // 纯函数不改入参：
  assert.equal(full.length, TODO_CONFIDENCE_HISTORY_MAX);
});

test("(场景4) 跨三次写入的证据爬升轨迹（75→85→95 的语义枚举等价物）", async () => {
  const store = fakeStore();
  const context = contextFor(store);
  const write = (status, completionConfidence) =>
    todoWriteToolEntry.handler(
      { todos: [item("a", status, "high", { id: "a", completionConfidence })] },
      context,
    );

  const first = await write("pending", "speculative");
  assert.deepEqual(first.todos[0].confidenceHistory, ["speculative"]);
  const second = await write("in_progress", "plausible");
  assert.deepEqual(second.todos[0].confidenceHistory, ["speculative", "plausible"]);
  // 同值重发不产生虚假中间步骤：
  const repeat = await write("in_progress", "plausible");
  assert.deepEqual(repeat.todos[0].confidenceHistory, ["speculative", "plausible"]);
  const third = await write("completed", "validated");
  assert.deepEqual(third.todos[0].confidenceHistory, ["speculative", "plausible", "validated"]);
  assert.deepEqual(store.snapshot()[0].confidenceHistory, ["speculative", "plausible", "validated"]);
});

// —— 场景 5：旧格式读写正常（R4/R5） ——

test("(场景5) 旧格式列表（无新字段、无新完成转移）首写成功、存储逐字节 = 提交值 + 派生 id", async () => {
  const legacy = [item("plan", "in_progress", "high"), item("test", "pending", "medium")];
  const store = fakeStore();
  const output = await todoWriteToolEntry.handler(
    { todos: structuredClone(legacy) },
    contextFor(store),
  );
  assert.deepEqual(store.snapshot(), [
    { ...legacy[0], id: "todo-0" },
    { ...legacy[1], id: "todo-1" },
  ]);
  assert.ok(!("confidenceHistory" in store.snapshot()[0]));
  assert.ok(!("completionConfidence" in store.snapshot()[0]));
  assert.deepEqual(output.summary, {
    total: 2,
    pending: 1,
    inProgress: 1,
    completed: 0,
    available: 1,
  });
});

test("(场景5) confidence_json 旧行 null / 坏 JSON / 前向数据整列忽略；空形状编码为 null", () => {
  const legacyRow = {
    session_id: "s",
    content: "old",
    status: "pending",
    priority: "high",
    position: 0,
    time_created: 0,
    time_updated: 0,
    deps_json: null,
    confidence_json: null,
  };
  const expected = { content: "old", status: "pending", priority: "high" };
  assert.deepEqual(decodeTodoRow(legacyRow), expected);
  assert.deepEqual(decodeTodoRow({ ...legacyRow, confidence_json: "not json{" }), expected);
  // strict 校验失败（未来成员）→ 整列忽略（回滚 =「忽略该列」，不牵连 deps_json）：
  assert.deepEqual(
    decodeTodoRow({
      ...legacyRow,
      confidence_json: '{"completionConfidence":"validated","futureMember":1}',
    }),
    expected,
  );
  // deps_json 与 confidence_json 互不牵连：坏的 confidence 列不影响 D4 字段读回。
  assert.deepEqual(
    decodeTodoRow({
      ...legacyRow,
      deps_json: '{"id":"a"}',
      confidence_json: '{"confidenceHistory":["nope"]}',
    }),
    { content: "old", status: "pending", priority: "high", id: "a" },
  );
  assert.equal(encodeTodoConfidence({ content: "x", status: "pending", priority: "low" }), null);
  assert.equal(
    encodeTodoConfidence({ content: "x", status: "pending", priority: "low", confidenceHistory: [] }),
    null,
    "空数组 history 不物化",
  );
  assert.equal(
    encodeTodoConfidence({
      content: "x",
      status: "completed",
      priority: "low",
      completionConfidence: "verified",
      confidenceHistory: ["plausible", "verified"],
    }),
    JSON.stringify({ completionConfidence: "verified", confidenceHistory: ["plausible", "verified"] }),
  );
});

test("(场景5) todoItemsFromToolResultContent：D4 前 / D4 后 / J2-1 后三代结果形状照常解析", () => {
  const preD4 = JSON.stringify({ todos: [{ content: "a", status: "pending", priority: "high" }] });
  assert.deepEqual(todoItemsFromToolResultContent(preD4), [
    { content: "a", status: "pending", priority: "high" },
  ]);

  const d4Era = JSON.stringify({
    todos: [
      { content: "a", status: "pending", priority: "high", id: "a", blockedBy: [], available: true },
    ],
  });
  assert.deepEqual(todoItemsFromToolResultContent(d4Era), [
    { content: "a", status: "pending", priority: "high", id: "a", blockedBy: [] },
  ]);

  const j21Era = JSON.stringify({
    todos: [
      {
        content: "a",
        status: "completed",
        priority: "high",
        id: "a",
        completionConfidence: "verified",
        confidenceHistory: ["plausible", "verified"],
        available: false,
      },
    ],
  });
  assert.deepEqual(todoItemsFromToolResultContent(j21Era), [
    {
      content: "a",
      status: "completed",
      priority: "high",
      id: "a",
      completionConfidence: "verified",
      confidenceHistory: ["plausible", "verified"],
    },
  ]);

  // 宽容解析不带存储窗口上限：超窗口的历史结果（未来版本放宽后回滚）仍可解析。
  const overCap = JSON.stringify({
    todos: [
      {
        content: "a",
        status: "pending",
        priority: "high",
        confidenceHistory: Array.from({ length: TODO_CONFIDENCE_HISTORY_MAX + 5 }, (_, i) =>
          i % 2 === 0 ? "speculative" : "plausible",
        ),
      },
    ],
  });
  const parsed = todoItemsFromToolResultContent(overCap);
  assert.ok(parsed);
  assert.equal(parsed[0].confidenceHistory.length, TODO_CONFIDENCE_HISTORY_MAX + 5);
});

// —— 场景 6：报错文案不泄露枚举边界（R3/R6） ——

const LEAK_PATTERN = /speculative|plausible|validated|verified|threshold|at least|rank|order|≥|>=|\b9[6-9]\b|\b100\b/i;

test("(场景6) 违规文案：点名 id、指引证据动作、不含枚举值/阈值/排序词汇", async () => {
  for (const violations of [
    [{ id: "a", index: 0 }],
    [
      { id: "a", index: 0 },
      { id: "b", index: 1 },
    ],
  ]) {
    const message = completionGateErrorMessage(violations);
    assert.ok(!LEAK_PATTERN.test(message), `message leaks gate boundary: ${message}`);
    for (const violation of violations) {
      assert.ok(message.includes(`"${violation.id}"`));
    }
    assert.match(message, /completion evidence/);
    assert.match(message, /completionConfidence/);
  }
  // handler 实际抛出的消息同样过保密检查（不是只查纯函数模板）：
  const store = fakeStore([item("a", "pending", "high", { id: "a" })]);
  const error = await rejection(
    todoWriteToolEntry.handler(
      { todos: [item("a", "completed", "high", { id: "a" })] },
      contextFor(store),
    ),
  );
  assert.ok(error);
  assert.ok(!LEAK_PATTERN.test(error.message), `handler message leaks: ${error.message}`);
});

test("(场景6/R6) 工具描述：新增两条 bullet；不披露哪个值过门槛", () => {
  const description = todoWriteToolEntry.metadata.description;
  assert.match(description, /`completionConfidence` records the evidence behind an item's completion/);
  assert.match(description, /report it from what you actually observed/);
  assert.match(description, /without sufficient completion evidence is rejected with the item named/);
  assert.match(description, /tool-maintained `confidenceHistory`/);
  assert.match(description, /any `confidenceHistory` you submit is ignored/);
  // 门槛边界保密：描述不点名任何枚举值、不出现 threshold/at least（枚举语义只在 schema
  // describe 里，那是字段含义而非门槛披露）：
  assert.ok(!/`(speculative|plausible|validated|verified)`/.test(description));
  assert.ok(!/threshold|at least/i.test(description));
  // 对抗复核 F2：指引措辞与门槛报错同源（"run the checks"），不用 validat* 词根
  // （与过线值 validated 同源，避免向模型暗示门槛边界）：
  assert.ok(!/validat/i.test(description));
  assert.match(description, /run the checks first/);
  // D4 既有 bullet 保留：
  assert.match(description, /Send the full list each call/);
  assert.match(description, /`blockedBy` lists ids from the same submitted list/);
});

// —— 场景 7：持久化往返（R5） ——

test("(场景7) migration 0024 已登记；爬升两次写入 → readTodos 逐字段相等；协议投影不带新字段", async () => {
  await withStore(async (store) => {
    assert.ok(store.debugMigrationIds().includes("0024_todo_confidence_json"));
    const context = contextFor(store);
    await todoWriteToolEntry.handler(
      { todos: [item("a", "pending", "high", { id: "a", completionConfidence: "speculative" })] },
      context,
    );
    const output = await todoWriteToolEntry.handler(
      { todos: [item("a", "completed", "high", { id: "a", completionConfidence: "validated" })] },
      context,
    );
    const expected = {
      content: "a",
      status: "completed",
      priority: "high",
      id: "a",
      completionConfidence: "validated",
      confidenceHistory: ["speculative", "validated"],
    };
    assert.deepEqual(await store.readTodos({ sessionID: SESSION_ID }), [expected]);
    assert.deepEqual(output.todos[0], { ...expected, available: false });

    // R7 收缩现状钉住：协议投影（bootstrap mapTodoItem 显式重建）不携带新字段——
    // 后续批次按 spec R7 方案透传时，本断言应随实现同批更新。
    assert.deepEqual(mapTodoItem(expected), {
      content: "a",
      status: "completed",
      priority: "high",
      id: "a",
    });
  });
});

test("(场景7) 关库重开：confidence_json 原样读回（含 grandfather 旧行 null 列）", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "session.db");
    const first = createSqliteSessionStore({ dbPath });
    await first.createSession({
      id: SESSION_ID,
      projectID: "prj_j21",
      slug: "j21",
      directory: dir,
      title: "j21",
      version: "0.16.9",
    });
    await first.updateTodos({
      sessionID: SESSION_ID,
      todos: [
        {
          content: "a",
          status: "completed",
          priority: "high",
          id: "a",
          completionConfidence: "verified",
          confidenceHistory: ["plausible", "verified"],
        },
        { content: "old", status: "completed", priority: "low" },
      ],
    });
    first.close();

    const second = createSqliteSessionStore({ dbPath });
    try {
      // repository 是哑持久化（不规范化）：直接 updateTodos 写入的无 id 项读回仍无 id，
      // 派生 id 由 handler/视图层铸造（D4 纪律同款）。
      assert.deepEqual(await second.readTodos({ sessionID: SESSION_ID }), [
        {
          content: "a",
          status: "completed",
          priority: "high",
          id: "a",
          completionConfidence: "verified",
          confidenceHistory: ["plausible", "verified"],
        },
        { content: "old", status: "completed", priority: "low" },
      ]);
    } finally {
      second.close();
    }
  });
});

// —— 场景 8：输出面与 schema（R4） ——

test("(场景8) 输出视图携带 history、过 runtimeOutputSchema 强制校验；summary 五计数不受新字段影响", async () => {
  const store = fakeStore();
  const context = contextFor(store);
  const output = await todoWriteToolEntry.handler(
    {
      todos: [
        item("a", "completed", "high", { id: "a", completionConfidence: "verified" }),
        item("b", "pending", "high", { id: "b" }),
      ],
    },
    context,
  );
  assert.deepEqual(output.todos[0].confidenceHistory, ["verified"]);
  assert.equal(output.todos[1].confidenceHistory, undefined);
  assert.deepEqual(output.summary, {
    total: 2,
    pending: 1,
    inProgress: 0,
    completed: 1,
    available: 1,
  });
  // 模拟 executor/validation.ts 的 runtimeOutputSchema 强制校验：
  assert.equal(TodoWriteOutputSchema.safeParse(output).success, true);

  const readOutput = await todoReadToolEntry.handler({}, context);
  assert.deepEqual(readOutput.todos[0].confidenceHistory, ["verified"]);
  assert.equal(TodoReadOutputSchema.safeParse(readOutput).success, true);
});
