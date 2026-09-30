import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * D4 验收测试：TodoWrite 依赖字段最小形态。
 *
 * 覆盖规格 apps/acode-cli/specs/todo-dependency-fields.md 的 R1–R6 与验收场景 1–10：
 * - 场景 1/2：环检测（点名 id 序列、不静默断边）、悬空引用与派生 id 引用报错；
 * - 场景 3：available 过滤与 summary 计数一致；
 * - 场景 4：旧格式（三字段）向后兼容快照；
 * - 场景 5/6：真实 SQLite 往返一致 + migration 0023 + 前向兼容/回滚不丢依赖；
 * - 场景 7：metadata 上界（报错不截断）与纯标注语义；
 * - 场景 8：不恢复单 in_progress 硬约束；
 * - 场景 9：CLI 之外投影不回归（tool-plan-adapter 采用稳定 id、全有或全无判定不破、
 *   services 位置派生 id 与 CLI 规范化同形的源码级防漂移）；
 * - 场景 10：并发写最后写入者胜；
 * - R6：工具描述三条 bullet + "# Delegating work" 纪律节的 todo 一句话（随工具面门控）。
 *
 * J2-1 适配（specs/todo-confidence-semantics.md「D4 测试适配记录」）：完成门槛让
 * 「新生 completed 项无置信度」从成功变为拒绝——场景 3/5 的 completed 项补
 * completionConfidence，场景 4 改为 grandfather 重发形态（三字段逐字节断言原样保留），
 * 场景 6 的 legacyRow 补 confidence_json 列。其余场景不受影响。
 */

const {
  TodoWriteInputSchema,
  TodoReadOutputSchema,
  TodoWriteOutputSchema,
  normalizeTodos,
  detectTodoCycle,
  computeAvailable,
  derivedTodoId,
  TODO_METADATA_MAX_KEYS,
  TODO_METADATA_MAX_KEY_CHARS,
  TODO_METADATA_MAX_SERIALIZED_BYTES,
} = await import("../packages/contracts/src/tools/todo.ts");
const { todoReadToolEntry, todoWriteToolEntry } = await import(
  "../packages/core/src/tool/handlers/todo.ts"
);
const { decodeTodoRow, encodeTodoDeps } = await import(
  "../packages/adapters/src/storage/session-store/codecs.ts"
);
const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { mapTodoItem } = await import(
  "../packages/bootstrap/src/acode-protocol/session-mapper.ts"
);
const { buildDelegatingWorkGroupSection } = await import(
  "../packages/core/src/context/dynamic-sections.ts"
);
const { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } = await import(
  "../../../packages/shared/src/tool-plan-adapter.ts"
);
const { acodeSessionTodoItemSchema } = await import(
  "../../../packages/shared/src/acode-protocol/index.ts"
);

// —— 构造器与假 store ——

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

function contextFor(store, sessionId = "ses_d4_test") {
  return { sessionId, sessionStore: store, toolCallId: "tc_d4_test" };
}

function parseFailure(input) {
  const result = TodoWriteInputSchema.safeParse(input);
  assert.equal(result.success, false, "expected schema failure");
  return result.error.issues.map((issue) => issue.message).join("\n");
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-d4-todo-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStore(fn) {
  return withTempDir(async (dir) => {
    const store = createSqliteSessionStore({ dbPath: join(dir, "session.db") });
    try {
      await store.createSession({
        id: "ses_d4_test",
        projectID: "prj_d4",
        slug: "d4",
        directory: dir,
        title: "d4 todo deps",
        version: "0.16.9",
      });
      return await fn(store, dir);
    } finally {
      store.close();
    }
  });
}

// —— 场景 1：环检测（R3） ——

test("(场景1) 二元环 / 自引用 / 三元环即时 schema 报错并点名 id 序列；链式无环通过", () => {
  const twoCycle = parseFailure({
    todos: [
      item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
      item("b", "pending", "high", { id: "b", blockedBy: ["a"] }),
    ],
  });
  assert.match(twoCycle, /a → b → a/);

  const selfCycle = parseFailure({
    todos: [item("a", "pending", "high", { id: "a", blockedBy: ["a"] })],
  });
  assert.match(selfCycle, /a → a/);

  const threeCycle = parseFailure({
    todos: [
      item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
      item("b", "pending", "high", { id: "b", blockedBy: ["c"] }),
      item("c", "pending", "high", { id: "c", blockedBy: ["a"] }),
    ],
  });
  assert.match(threeCycle, /a → b → c → a/);

  // 链式 c←b←a 无环：
  const chain = TodoWriteInputSchema.safeParse({
    todos: [
      item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
      item("b", "pending", "high", { id: "b", blockedBy: ["c"] }),
      item("c", "pending", "high", { id: "c" }),
    ],
  });
  assert.equal(chain.success, true, JSON.stringify(chain.error?.issues ?? []));
});

test("(场景1) 不静默断边：成环输入报错时 updateTodos 未被调用、旧表无变化", async () => {
  const store = fakeStore([item("old", "pending", "high")]);
  let updates = 0;
  store.updateTodos = async () => {
    updates += 1;
  };
  await assert.rejects(
    todoWriteToolEntry.handler(
      {
        todos: [
          item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
          item("b", "pending", "high", { id: "b", blockedBy: ["a"] }),
        ],
      },
      contextFor(store),
    ),
  );
  assert.equal(updates, 0);
  assert.deepEqual(store.snapshot(), [item("old", "pending", "high")]);
});

// —— 场景 2：悬空引用与派生 id 引用（R1） ——

test("(场景2) 悬空引用报错；引用缺显式 id 的项（只会命中派生 id）报错并要求写 id", () => {
  const dangling = parseFailure({
    todos: [item("a", "pending", "high", { id: "a", blockedBy: ["missing"] })],
  });
  assert.match(dangling, /unknown id "missing"/);

  const derivedOnly = parseFailure({
    todos: [item("a", "pending", "high", { blockedBy: ["todo-1"] }), item("b")],
  });
  assert.match(derivedOnly, /position-derived id/);
  assert.match(derivedOnly, /explicit id/);

  // 显式 id 与派生 id 撞车 / 显式 id 重复：
  const collision = parseFailure({
    todos: [item("a", "pending", "high", { id: "todo-1" }), item("b")],
  });
  assert.match(collision, /collides with the position-derived id/);
  const duplicate = parseFailure({
    todos: [item("a", "pending", "high", { id: "x" }), item("b", "pending", "high", { id: "x" })],
  });
  assert.match(duplicate, /unique within the list/);
});

// —— 场景 3：available 过滤（R4） ——

test("(场景3) available：pending 且未阻塞/阻塞项全 completed 才 available；in_progress/completed 永不", () => {
  const todos = normalizeTodos([
    item("free", "pending"), // available
    item("released", "pending", "medium", { id: "r", blockedBy: ["done"] }), // 依赖全 completed → available
    item("done", "completed", "medium", { id: "done" }),
    item("blocked", "pending", "medium", { id: "b", blockedBy: ["doing"] }), // doing 是 in_progress → 不 available
    item("doing", "in_progress", "medium", { id: "doing" }),
    item("empty-deps", "pending", "medium", { blockedBy: [] }), // 空数组 → available
  ]);
  assert.deepEqual(computeAvailable(todos), [true, true, false, false, false, true]);

  // 防御：引用解析不到按未解除处理（写入合法性校验后不可达）。
  const orphan = normalizeTodos([item("x", "pending", "medium", { id: "x", blockedBy: ["gone"] })]);
  assert.deepEqual(computeAvailable(orphan), [false]);
});

test("(场景3) handler 输出：逐项 available 与 summary.available 计数一致，且过输出 schema", async () => {
  const store = fakeStore();
  const output = await todoWriteToolEntry.handler(
    {
      todos: [
        item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
        // J2-1：新生 completed 项需携带过线的 completionConfidence（完成门槛）。
        item("b", "completed", "high", { id: "b", completionConfidence: "verified" }),
        item("c", "in_progress", "high", { id: "c" }),
        item("d", "pending", "high"),
      ],
    },
    contextFor(store),
  );
  assert.deepEqual(
    output.todos.map((todo) => todo.available),
    [true, false, false, true], // a 的阻塞项 b 已 completed → 解除
  );
  assert.deepEqual(output.summary, {
    total: 4,
    pending: 2,
    inProgress: 1,
    completed: 1,
    available: 2,
  });
  assert.equal(output.summary.available, output.todos.filter((t) => t.available).length);
  // 模拟 executor/validation.ts 的 runtimeOutputSchema 强制校验：
  assert.equal(TodoWriteOutputSchema.safeParse(output).success, true);
});

test("(场景3) TodoRead 输出同样带逐项 available 且过输出 schema", async () => {
  const store = fakeStore([
    { content: "a", status: "pending", priority: "high", id: "a", blockedBy: ["b"] },
    { content: "b", status: "completed", priority: "high", id: "b" },
  ]);
  const output = await todoReadToolEntry.handler({}, contextFor(store));
  assert.deepEqual(
    output.todos.map((todo) => todo.available),
    [true, false],
  );
  assert.equal(TodoReadOutputSchema.safeParse(output).success, true);
});

// —— 场景 4：旧格式向后兼容（R5） ——

test("(场景4) 旧格式三字段：写入成功、三字段逐字节不变、四计数与旧实现一致、只额外铸派生 id", async () => {
  const legacy = [
    item("write spec", "completed", "high"),
    item("implement", "in_progress", "high"),
    item("test", "pending", "medium"),
  ];
  // J2-1 适配：legacy 含新生 completed 项会被完成门槛拒绝；本场景改为 grandfather
  // 重发形态——prior 种子 = 同一份 legacy 列表（升级前已存在的 completed 存量项），
  // 三字段逐字节断言与计数断言原样保留，恰好钉住 R3 豁免条款与 R2「无观测不物化」。
  const store = fakeStore(structuredClone(legacy));
  const output = await todoWriteToolEntry.handler({ todos: structuredClone(legacy) }, contextFor(store));

  // 旧实现的四个计数（total/pending/inProgress/completed）逐项不变：
  assert.deepEqual(output.summary, {
    total: 3,
    pending: 1,
    inProgress: 1,
    completed: 1,
    available: 1, // 无 blockedBy 的 pending 项恒 available（R5 零回归基线）
  });
  // 持久化内容 = 三字段逐字节等于提交值 + 规范化只额外铸 todo-<index>：
  assert.deepEqual(store.snapshot(), [
    { ...legacy[0], id: "todo-0" },
    { ...legacy[1], id: "todo-1" },
    { ...legacy[2], id: "todo-2" },
  ]);
  assert.deepEqual(
    output.todos.map(({ available, ...todo }) => todo),
    store.snapshot(),
  );
});

test("(R5) strip 行为显式化：三个新键被解析，仍未知的键继续 strip；顶层仍 strict", () => {
  const parsed = TodoWriteInputSchema.parse({
    todos: [item("a", "pending", "high", { id: "a", blockedBy: [], metadata: { k: 1 }, nope: 1 })],
  });
  assert.deepEqual(parsed.todos[0], {
    content: "a",
    status: "pending",
    priority: "high",
    id: "a",
    blockedBy: [],
    metadata: { k: 1 },
  });
  assert.ok(!("nope" in parsed.todos[0]));
  assert.equal(TodoWriteInputSchema.safeParse({ todos: [], extra: 1 }).success, false);
});

// —— 场景 5/6：真实 SQLite 往返与 migration ——

test("(场景5) 往返一致：write → read → 逐字段相等（含 id/blockedBy/metadata），协议投影三字段仍在", async () => {
  await withStore(async (store) => {
    const submitted = [
      item("a", "pending", "high", { id: "a", blockedBy: ["b"], metadata: { est: "2h", tags: ["x"] } }),
      // J2-1：新生 completed 项需携带过线的 completionConfidence（完成门槛）。
      item("b", "completed", "high", { id: "b", completionConfidence: "verified" }),
      item("legacy shape"),
    ];
    const output = await todoWriteToolEntry.handler(
      { todos: structuredClone(submitted) },
      contextFor(store),
    );
    const readBack = await store.readTodos({ sessionID: "ses_d4_test" });
    assert.deepEqual(readBack, output.todos.map(({ available, ...todo }) => todo));
    assert.deepEqual(readBack[0], submitted[0]);
    // J2-1：读回比提交多一个工具追加的 confidenceHistory（工具自有轨迹，R2）。
    assert.deepEqual(readBack[1], { ...submitted[1], confidenceHistory: ["verified"] });
    assert.deepEqual(readBack[2], { ...submitted[2], id: "todo-2" });

    // R5 协议投影（bootstrap session-mapper）：三字段仍在。
    const projected = readBack.map(mapTodoItem);
    assert.deepEqual(projected[0], submitted[0]);
    assert.equal(projected[2].id, "todo-2");

    // 根协议 schema（packages/shared，升级裁决 (a) 的最小加宽）接受新字段、仍拒绝未知键：
    assert.equal(acodeSessionTodoItemSchema.safeParse(projected[0]).success, true);
    assert.equal(
      acodeSessionTodoItemSchema.safeParse({ ...projected[0], unknown: 1 }).success,
      false,
    );
  });
});

test("(场景6) migration 0023 已登记执行；旧行 deps_json=null 读回等价旧格式；脏/前向数据整列忽略", async () => {
  await withStore(async (store) => {
    assert.ok(store.debugMigrationIds().includes("0023_todo_deps_json"));

    const legacyRow = {
      session_id: "s",
      content: "old",
      status: "pending",
      priority: "high",
      position: 0,
      time_created: 0,
      time_updated: 0,
      deps_json: null,
      confidence_json: null, // J2-1（migration 0024）：新列旧行同为 null。
    };
    assert.deepEqual(decodeTodoRow(legacyRow), {
      content: "old",
      status: "pending",
      priority: "high",
    });
    // 回滚场景的等价性：旧 decode 显式挑字段，读到新列也忽略——新 decode 对坏 JSON /
    // 未来成员（strict safeParse 失败）同样整列忽略，依赖成为惰性数据，重新升级原样读回。
    assert.deepEqual(decodeTodoRow({ ...legacyRow, deps_json: "not json{" }), {
      content: "old",
      status: "pending",
      priority: "high",
    });
    assert.deepEqual(decodeTodoRow({ ...legacyRow, deps_json: '{"id":"a","future":1}' }), {
      content: "old",
      status: "pending",
      priority: "high",
    });
    assert.equal(encodeTodoDeps({ content: "x", status: "pending", priority: "low" }), null);
  });
});

test("(场景6) 升级后再开库：migration 不重复执行，已写入的 deps_json 原样读回", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "session.db");
    const first = createSqliteSessionStore({ dbPath });
    await first.createSession({
      id: "ses_d4_test",
      projectID: "prj_d4",
      slug: "d4",
      directory: dir,
      title: "d4",
      version: "0.16.9",
    });
    await first.updateTodos({
      sessionID: "ses_d4_test",
      todos: [item("a", "pending", "high", { id: "a", blockedBy: ["b"] }), item("b", "pending", "high", { id: "b" })],
    });
    first.close();

    const second = createSqliteSessionStore({ dbPath });
    try {
      assert.deepEqual(await second.readTodos({ sessionID: "ses_d4_test" }), [
        { content: "a", status: "pending", priority: "high", id: "a", blockedBy: ["b"] },
        { content: "b", status: "pending", priority: "high", id: "b" },
      ]);
    } finally {
      second.close();
    }
  });
});

// —— 场景 7：metadata 上界与纯标注（R2） ——

test("(场景7) metadata 上界各自报错不截断；非 JSON 值拒绝；纯标注不参与任何判定", () => {
  const manyKeys = Object.fromEntries(
    Array.from({ length: TODO_METADATA_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
  );
  assert.match(parseFailure({ todos: [item("a", "pending", "high", { metadata: manyKeys })] }), /key/i);

  const longKey = { ["k".repeat(TODO_METADATA_MAX_KEY_CHARS + 1)]: 1 };
  assert.match(parseFailure({ todos: [item("a", "pending", "high", { metadata: longKey })] }), /key/i);

  const big = { blob: "x".repeat(TODO_METADATA_MAX_SERIALIZED_BYTES + 1) };
  assert.match(
    parseFailure({ todos: [item("a", "pending", "high", { metadata: big })] }),
    /not truncated/,
  );

  for (const [label, metadata] of [
    ["function", { fn: () => 1 }],
    ["Date", { at: new Date(0) }],
    ["class instance", { m: new Map() }],
    ["NaN", { n: Number.NaN }],
    ["undefined member", { u: undefined }],
  ]) {
    assert.match(
      parseFailure({ todos: [item("a", "pending", "high", { metadata })] }),
      /non-JSON|JSON-serializable/,
      label,
    );
  }
  const circular = {};
  circular.self = circular;
  assert.match(
    parseFailure({ todos: [item("a", "pending", "high", { metadata: circular })] }),
    /JSON-serializable/,
  );

  // 纯标注：带不带 metadata，available / 环检测 / 计数完全一致。
  const base = [
    item("a", "pending", "high", { id: "a", blockedBy: ["b"] }),
    item("b", "completed", "high", { id: "b" }),
  ];
  const withMeta = base.map((todo, i) => (i === 0 ? { ...todo, metadata: { note: "x" } } : todo));
  assert.deepEqual(computeAvailable(normalizeTodos(withMeta)), computeAvailable(normalizeTodos(base)));
  assert.equal(detectTodoCycle(normalizeTodos(withMeta)), undefined);
  const ok = TodoWriteInputSchema.safeParse({ todos: withMeta });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues ?? []));
});

// —— 场景 8：不恢复单 in_progress 硬约束 ——

test("(场景8) 两个 in_progress 写入成功（schema 硬约束保持注释状态）", () => {
  const result = TodoWriteInputSchema.safeParse({
    todos: [item("a", "in_progress", "high"), item("b", "in_progress", "high")],
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues ?? []));
});

// —— 场景 9：CLI 之外的投影不回归 ——

test("(场景9) tool-plan-adapter：稳定 id 被采用；新字段不触发全有或全无失败；输出形状同样可解析", () => {
  const input = {
    todos: [
      item("a", "pending", "high", { id: "task-a", blockedBy: ["task-b"], metadata: { k: 1 } }),
      item("b", "completed", "high", { id: "task-b" }),
    ],
  };
  const fromInput = extractPlanStepsFromToolInput({ title: "TodoWrite", kind: "TodoWrite", input });
  assert.ok(fromInput, "all-or-nothing must not trip on blockedBy/metadata");
  assert.equal(fromInput.length, 2);
  assert.equal(fromInput[0].id, "task-a"); // :44 readString(value.id) ?? title → 采用稳定 id
  assert.equal(fromInput[1].id, "task-b");

  // handler 的新输出形状（逐项 available + summary.available）经输出侧解析仍完整：
  const outputContent = JSON.stringify({
    oldTodos: [],
    todos: input.todos.map((todo, index) => ({ ...todo, available: index === 1 })),
    summary: { total: 2, pending: 1, inProgress: 0, completed: 1, available: 1 },
  });
  const fromOutput = extractPlanStepsFromToolOutput({
    title: "TodoWrite",
    kind: "TodoWrite",
    output: outputContent,
  });
  assert.ok(fromOutput);
  assert.equal(fromOutput.length, 2);
  assert.equal(fromOutput[0].id, "task-a");
});

test("(场景9) services 位置派生 id 与 CLI 规范化铸法逐字同形（源码级防漂移，R7 跨包项收口前）", () => {
  const source = readFileSync(
    new URL("../../../packages/services/src/acode-agent/acodeTaskServiceAdapter.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("id: `todo-${index}`"), "sessionTodosToPlanSteps 的派生法变了");
  assert.equal(derivedTodoId(0), "todo-0");
  assert.equal(derivedTodoId(3), "todo-3");
  assert.deepEqual(
    normalizeTodos([item("a"), item("b")]).map((todo) => todo.id),
    ["todo-0", "todo-1"],
  );
});

// —— 场景 10：并发写 ——

test("(场景10) 并发 TodoWrite 最后写入者胜；各自输出只反映自己那次提交的快照", async () => {
  await withStore(async (store) => {
    const context = contextFor(store);
    const first = todoWriteToolEntry.handler(
      { todos: [item("first", "pending", "high", { id: "f" })] },
      context,
    );
    const second = todoWriteToolEntry.handler(
      { todos: [item("second", "pending", "high", { id: "s" })] },
      context,
    );
    const [outA, outB] = await Promise.all([first, second]);
    assert.deepEqual(outA.todos.map((t) => t.content), ["first"]);
    assert.deepEqual(outB.todos.map((t) => t.content), ["second"]);
    const final = await store.readTodos({ sessionID: "ses_d4_test" });
    const matches = (name) => final.length === 1 && final[0].content === name;
    assert.ok(matches("first") || matches("second"), "final state must equal one whole submission");
  });
});

// —— R6：提示词纪律 ——

test("(R6) TodoWrite 描述新增 id/blockedBy/metadata 三条调用细节 bullet", () => {
  const description = todoWriteToolEntry.metadata.description;
  assert.match(description, /stable `id` \(unique within the list\)/);
  assert.match(description, /position-derived id like `todo-0`/);
  assert.match(description, /`blockedBy` lists ids from the same submitted list/);
  assert.match(description, /must carry an explicit `id`/);
  assert.match(description, /dependency cycles are rejected/);
  assert.match(description, /`available`/);
  assert.match(description, /`metadata` is a bounded annotation object/);
  assert.match(description, /never affects ordering or counts/);
  // 既有 bullet 保留（「恰一个 in_progress」维持提示级，不升级为硬约束）：
  assert.match(description, /Keep one item `in_progress` at a time/);
  assert.match(description, /Send the full list each call/);
});

test("(R6) '# Delegating work' 纪律节追加 todo 依赖一句话，且随 todo 工具面门控", () => {
  const withTodos = buildDelegatingWorkGroupSection(["Agent", "TodoRead", "TodoWrite", "Bash"]);
  assert.ok(withTodos);
  assert.ok(withTodos.content.includes("# Delegating work"));
  // 一句话覆盖三条纪律：最小可用 id 优先 / 开工前核对 blockedBy 已清空 / 更新前重读防陈旧。
  assert.match(withTodos.content, /smallest id that is currently available/);
  assert.match(withTodos.content, /`blockedBy` has cleared before you start/);
  assert.match(withTodos.content, /re-read the list via TodoRead before your next TodoWrite/);
  assert.match(withTodos.content, /stale state/);

  // todo 工具不在面 → 该句不出现（不指向不存在的工具）；派发纪律本体不受影响：
  const noTodos = buildDelegatingWorkGroupSection(["Agent", "Bash"]);
  assert.ok(noTodos);
  assert.ok(!noTodos.content.includes("blockedBy"));
  assert.match(noTodos.content, /background by default/);

  // 表缺席 / 无派发工具 → 整节仍不出现（既有 R3 严格方向不变）：
  assert.equal(buildDelegatingWorkGroupSection(undefined), null);
  assert.equal(buildDelegatingWorkGroupSection(["TodoRead", "TodoWrite"]), null);
});
