// 投影窗口双上限与 turn 轻量索引的单测（specs/renderer-memory-budget.md 规则 3）。
// 运行：TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/tests/projection-window-limits.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECTION_WINDOW_MAX_BYTES,
  PROJECTION_WINDOW_MAX_ROWS,
  ConversationProjectionStore,
  estimateRowBytes,
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
  trimProjectionWindowToLimits,
} from "../src/v4/conversationProjectionStore.ts";
import { ConversationTurnIndex, TURN_INDEX_MAX_ENTRIES } from "../src/v4/conversationTurnIndex.ts";

const LOG_EPOCH = "epoch-1";
const SUBSCRIPTION_ID = "sub-1";

function makeRow(rowId, overrides = {}) {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    kind: "assistantText",
    text: "hello",
    createdAt: rowId,
    createdAtSeq: rowId,
    ...overrides,
  };
}

function makeUserInputRow(rowId, text) {
  return makeRow(rowId, { kind: "userInput", text, origin: "realUser" });
}

function makeSnapshot({ window, totalCount, firstRowId, seq = 1, logEpoch = LOG_EPOCH }) {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch,
    seq,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "none",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {},
    inputRouting: { mode: "startNow" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: false },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window, totalCount, firstRowId },
  };
}

function makeFrame(payload, { fromSeq = 0, toSeq = 1 } = {}) {
  return {
    topic: "conversation/s-1",
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq,
    toSeq,
    sentAt: 0,
    payload,
  };
}

/**
 * 最小 fake transport：只实现 store 构造与 loadOlder/loadAllOlder 用到的方法；
 * 其余方法 throw 以暴露越界调用。
 */
function makeFakeTransport({ rowsRange } = {}) {
  const calls = { rowsRange: [] };
  const transport = {
    subscribe: async () => ({
      ack: { subscriptionId: SUBSCRIPTION_ID, mode: "snapshot", logEpoch: LOG_EPOCH },
    }),
    activate: () => {},
    resync: async () => ({
      ack: { subscriptionId: SUBSCRIPTION_ID, mode: "resume", logEpoch: LOG_EPOCH },
    }),
    unsubscribe: async () => {},
    sendCommand: async () => assert.fail("sendCommand 不在本次测试范围"),
    queryCommands: async () => assert.fail("queryCommands 不在本次测试范围"),
    rowsRange: async (params) => {
      calls.rowsRange.push(params);
      return rowsRange(params);
    },
    plans: async () => ({
      atLogEpoch: LOG_EPOCH,
      atSeq: 0,
      atRevision: 0,
      plans: [],
    }),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  };
  for (const method of [
    "workflowRunEvents",
    "workflowRuns",
    "workflowRunArtifacts",
    "workflowRunArtifactData",
    "workflowRunArtifactRead",
    "workflowRunWorkspace",
    "workflowRunNodeResult",
    "fileChanges",
    "fileRewindPreview",
    "attachmentPut",
    "attachmentRead",
    "attachmentReadRange",
  ]) {
    transport[method] = async () => assert.fail(`${method} 不在本次测试范围`);
  }
  return { transport, calls };
}

async function makeConnectedStore(transport) {
  const store = new ConversationProjectionStore("conversation/s-1", transport);
  await store.connect();
  return store;
}

function applySnapshot(store, snapshot) {
  store.handleFrame(makeFrame({ kind: "snapshot", snapshot }, { toSeq: snapshot.seq }), {
    deliveryKind: "initial",
  });
}

function assertContiguousAscending(window) {
  for (let i = 1; i < window.length; i++) {
    assert.ok(
      window[i].rowId > window[i - 1].rowId,
      `window 必须是 rowId 严格升序的连续窗口，index=${i}`,
    );
  }
}

// ── 纯函数：estimateRowBytes ──

test("estimateRowBytes 对含 base64 dataUrl 的 row 按原长度计数", () => {
  const base64 = "Q".repeat(1000);
  const row = {
    rowId: 7,
    turnId: "turn-7",
    kind: "toolCall",
    toolCallId: "call-1",
    toolName: "cua.screenshot",
    status: "success",
    inputText: "",
    input: { screenshot: { dataUrl: `data:image/png;base64,${base64}` } },
    createdAt: 1,
    createdAtSeq: 7,
  };
  const expected =
    "turn-7".length + // 6
    "toolCall".length + // 8
    "call-1".length + // 6
    "cua.screenshot".length + // 14
    "success".length + // 7
    0 + // inputText 为空串
    ("data:image/png;base64,".length + base64.length); // dataUrl 按原长度计入（键名不计）
  assert.equal(expected, 1063);
  assert.equal(estimateRowBytes(row), expected);
  // 重复调用稳定（按行对象身份缓存），且不修改 row。
  assert.equal(estimateRowBytes(row), estimateRowBytes(row));
  assert.deepEqual(Object.keys(row).length, 10);
});

test("estimateRowBytes 数组与嵌套对象内的字符串都计入", () => {
  const row = {
    rowId: 1,
    turnId: "t",
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    workSegments: [{ segmentId: "abc" }],
    createdAt: 1,
    createdAtSeq: 1,
  };
  const expected =
    "t".length +
    "turnHeader".length +
    "userInput".length +
    "completedSuccess".length +
    "abc".length;
  assert.equal(estimateRowBytes(row), expected);
});

// ── 纯函数：trimProjectionWindowToLimits ──

test("未超限时裁剪返回原引用且无淘汰", () => {
  const rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
  const result = trimProjectionWindowToLimits(rows);
  assert.equal(result.window, rows);
  assert.equal(result.evicted.length, 0);
});

test("超行数上限裁头：window[0] 为原窗口内部行，尾部保留", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => makeRow(i + 1));
  const result = trimProjectionWindowToLimits(rows);
  assert.equal(result.window.length, PROJECTION_WINDOW_MAX_ROWS);
  assert.equal(result.window[0].rowId, 1001);
  assert.equal(result.window.at(-1).rowId, 5000);
  assert.equal(result.evicted.length, 1000);
  assert.equal(result.evicted[0].rowId, 1);
  assertContiguousAscending(result.window);
});

test("超字节上限裁头：裁剪后字节与行数同时满足上限", () => {
  const bigText = "A".repeat(200_000);
  const rows = Array.from({ length: 700 }, (_, i) => makeRow(i + 1, { text: bigText }));
  const result = trimProjectionWindowToLimits(rows);
  let bytes = 0;
  for (const row of result.window) bytes += estimateRowBytes(row);
  assert.ok(bytes <= PROJECTION_WINDOW_MAX_BYTES, "裁剪后字节必须回到上限内");
  assert.ok(result.window.length <= PROJECTION_WINDOW_MAX_ROWS);
  assert.ok(result.window[0].rowId > 1, "必须从头部裁掉最旧行");
  assert.equal(result.window.at(-1).rowId, 700, "尾行必须保留");
  assertContiguousAscending(result.window);
});

test("单行超字节预算时保留尾行不裁出空窗口", () => {
  const huge = makeRow(1, { text: "B".repeat(PROJECTION_WINDOW_MAX_BYTES + 1) });
  const result = trimProjectionWindowToLimits([huge]);
  assert.equal(result.window.length, 1);
  assert.equal(result.window[0].rowId, 1);
});

// ── 纯函数：shouldAutoLoadIncompleteLeadingTurn 封顶守卫 ──

test("窗口封顶后首 turn 缺 header 不再自动补拉", () => {
  const buildRows = (count) =>
    Array.from({ length: count }, (_, i) =>
      makeRow(i + 1001, { turnId: "turn-A", kind: "assistantText" }),
    );
  const belowCap = makeSnapshot({ window: buildRows(3999), totalCount: 5000, firstRowId: 1 });
  const atCap = makeSnapshot({ window: buildRows(4000), totalCount: 5000, firstRowId: 1 });
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(belowCap, false), true);
  assert.equal(shouldAutoLoadIncompleteLeadingTurn(atCap, false), false);
});

// ── store 级：snapshot 提交裁剪与游标语义 ──

test("snapshot 超行数上限裁头：hasOlderRows/loadOlder 游标语义保持正确", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => makeRow(i + 1));
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 5000, firstRowId: 1 }));

  const snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window.length, PROJECTION_WINDOW_MAX_ROWS);
  assert.equal(snapshot.rows.window[0].rowId, 1001, "window[0] 必须是原窗口内部行");
  assert.equal(snapshot.rows.window.at(-1).rowId, 5000);
  assert.equal(hasOlderRows(snapshot), true, "裁剪后仍有更早历史可拉");
  await store.close();
});

test("封顶窗口 loadOlder 游标连续：beforeRowId 始终取自 window[0]，空转不丢游标", async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => makeRow(i + 1));
  const { transport, calls } = makeFakeTransport({
    rowsRange: async ({ beforeRowId, limit }) => {
      const end = beforeRowId - 1;
      const start = Math.max(1, end - limit + 1);
      return {
        rows: Array.from({ length: end - start + 1 }, (_, i) => makeRow(start + i)),
        atSeq: 0,
        atRevision: 0,
        atLogEpoch: LOG_EPOCH,
        hasMore: start > 1,
      };
    },
  });
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 5000, firstRowId: 1 }));

  await store.loadOlder();
  const firstCall = calls.rowsRange[0];
  assert.equal(firstCall.beforeRowId, 1001, "游标必须是裁剪后的 window[0]");
  assert.equal(firstCall.limit, 60);

  const snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window.length, PROJECTION_WINDOW_MAX_ROWS, "封顶后窗口行数不变");
  assert.equal(snapshot.rows.window[0].rowId, 1001, "拉回行全部被裁掉，游标不漂移");
  assert.equal(store.getState().loadingOlder, false);
  assert.equal(hasOlderRows(snapshot), true, "分页仍可继续");

  // 游标连续：再次 loadOlder 仍以当前 window[0] 为 beforeRowId。
  await store.loadOlder();
  assert.equal(calls.rowsRange[1].beforeRowId, 1001);
  await store.close();
});

test("未封顶窗口 loadOlder：游标推进且合并后仍是连续尾窗", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => makeRow(i + 4501));
  const { transport, calls } = makeFakeTransport({
    rowsRange: async ({ beforeRowId, limit }) => {
      const end = beforeRowId - 1;
      const start = Math.max(1, end - limit + 1);
      return {
        rows: Array.from({ length: end - start + 1 }, (_, i) => makeRow(start + i)),
        atSeq: 0,
        atRevision: 0,
        atLogEpoch: LOG_EPOCH,
        hasMore: start > 1,
      };
    },
  });
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 5000, firstRowId: 1 }));

  await store.loadOlder(200);
  assert.equal(calls.rowsRange[0].beforeRowId, 4501);
  let snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window[0].rowId, 4301);
  assertContiguousAscending(snapshot.rows.window);

  await store.loadOlder(200);
  snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window[0].rowId, 4101);
  assertContiguousAscending(snapshot.rows.window);
  await store.close();
});

test("snapshot 超字节上限裁头", async () => {
  const bigText = "A".repeat(200_000);
  const rows = Array.from({ length: 700 }, (_, i) => makeRow(i + 1, { text: bigText }));
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 700, firstRowId: 1 }));

  const snapshot = store.getState().snapshot;
  let bytes = 0;
  for (const row of snapshot.rows.window) bytes += estimateRowBytes(row);
  assert.ok(bytes <= PROJECTION_WINDOW_MAX_BYTES);
  assert.ok(snapshot.rows.window.length < 700);
  assert.equal(snapshot.rows.window.at(-1).rowId, 700);
  assertContiguousAscending(snapshot.rows.window);
  await store.close();
});

test("delta 路径行数触顶时同样裁头", async () => {
  const rows = Array.from({ length: PROJECTION_WINDOW_MAX_ROWS }, (_, i) => makeRow(i + 1));
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 4000, firstRowId: 1 }));
  assert.equal(store.getState().snapshot.rows.window.length, PROJECTION_WINDOW_MAX_ROWS);

  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.appended", row: makeRow(4001) }] },
      { fromSeq: 1, toSeq: 2 },
    ),
    { deliveryKind: "online" },
  );
  const snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window.length, PROJECTION_WINDOW_MAX_ROWS, "追加一行后仍封顶");
  assert.equal(snapshot.rows.window.at(-1).rowId, 4001, "新行必须保留");
  assert.equal(snapshot.rows.window[0].rowId, 2, "从头部裁掉最旧行");
  assertContiguousAscending(snapshot.rows.window);
  await store.close();
});

// ── store 级：turn 轻量索引 ──

test("被裁 turn 仍在 turn 索引中，userInput 行带 120 字符摘要", async () => {
  const rows = [];
  for (let i = 1; i <= 5000; i++) {
    rows.push(i % 2 === 0 ? makeUserInputRow(i, `问题 ${i}：${"长".repeat(300)}`) : makeRow(i));
  }
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 5000, firstRowId: 1 }));

  const index = store.getTurnIndexEntries();
  assert.equal(index.length, 5000, "窗口行全部登记（含被裁剪的头部行）");
  const evictedEntry = index.find((entry) => entry.rowId === 1);
  assert.ok(evictedEntry, "被裁剪的行必须仍在索引中");
  assert.equal(evictedEntry.kind, "assistantText");
  const inputEntry = index.find((entry) => entry.rowId === 2);
  assert.equal(inputEntry.kind, "userInput");
  assert.equal(inputEntry.origin, "realUser");
  assert.equal(inputEntry.summary.length, 120);
  assert.equal(inputEntry.summary, rows[1].text.slice(0, 120));
  assert.equal(store.turnIndexSize(), 5000);
  await store.close();
});

test("delta 追加的行进入索引；row.removed 不复活旧条目", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 10, firstRowId: 1 }));

  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.appended", row: makeUserInputRow(11, "新问题") }] },
      { fromSeq: 1, toSeq: 2 },
    ),
    { deliveryKind: "online" },
  );
  const index = store.getTurnIndexEntries();
  assert.equal(index.length, 11);
  const appended = index.find((entry) => entry.rowId === 11);
  assert.equal(appended.summary, "新问题");
  await store.close();
});

test("store close() 清空 turn 索引", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => makeRow(i + 1));
  const { transport } = makeFakeTransport({});
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: rows, totalCount: 10, firstRowId: 1 }));
  assert.ok(store.turnIndexSize() > 0);
  await store.close();
  assert.equal(store.getTurnIndexEntries().length, 0);
  assert.equal(store.turnIndexSize(), 0);
  assert.equal(store.turnIndexEvictionCount(), 0);
  assert.equal(store.turnIndexByteEstimate(), 0);
});

// ── store 级：loadAllOlder 整窗提交受双上限约束 ──

test("loadAllOlder 整窗提交裁剪为双上限尾窗，被丢页行保留在索引", async () => {
  const tailRows = Array.from({ length: 40 }, (_, i) => makeRow(i + 4961));
  const { transport, calls } = makeFakeTransport({
    rowsRange: async ({ beforeRowId, limit }) => {
      const end = beforeRowId - 1;
      const start = Math.max(1, end - limit + 1);
      const rows = [];
      for (let rowId = start; rowId <= end; rowId++) {
        // 每 100 行放一条 realUser query，保证 hydrated 判定通过。
        rows.push(
          rowId % 100 === 0 ? makeUserInputRow(rowId, `历史问题 ${rowId}`) : makeRow(rowId),
        );
      }
      return { rows, atSeq: 0, atRevision: 0, atLogEpoch: LOG_EPOCH, hasMore: start > 1 };
    },
  });
  const store = await makeConnectedStore(transport);
  applySnapshot(store, makeSnapshot({ window: tailRows, totalCount: 5000, firstRowId: 1 }));

  const result = await store.loadAllOlder();
  assert.equal(result.status, "hydrated");
  const snapshot = store.getState().snapshot;
  assert.equal(snapshot.rows.window.length, PROJECTION_WINDOW_MAX_ROWS, "提交窗口受行数上限约束");
  assert.equal(snapshot.rows.window[0].rowId, 1001);
  assert.equal(snapshot.rows.window.at(-1).rowId, 5000);
  assertContiguousAscending(snapshot.rows.window);
  assert.ok(calls.rowsRange.length > 20, "分页必须覆盖全部历史");

  const index = store.getTurnIndexEntries();
  assert.equal(index.length, 5000, "所有拉取过的行（含被丢弃分页与被裁行）都在索引中");
  assert.ok(
    index.some((entry) => entry.rowId === 1),
    "最早的历史行必须保留目录依据",
  );
  assert.ok(index.some((entry) => entry.rowId === 4961));
  assert.equal(store.getState().loadingOlder, false);
  await store.close();
});

// ── ConversationTurnIndex 类 ──

test("turn 索引上限 20000 条：超限丢最旧", () => {
  const index = new ConversationTurnIndex();
  for (let rowId = 1; rowId <= TURN_INDEX_MAX_ENTRIES + 5; rowId++) {
    index.addRow(makeRow(rowId));
  }
  assert.equal(index.size, TURN_INDEX_MAX_ENTRIES);
  assert.equal(index.evictionCount, 5);
  assert.equal(index.snapshotEntries()[0].rowId, 6, "最旧的 5 条被淘汰");
  assert.equal(index.snapshotEntries().at(-1).rowId, TURN_INDEX_MAX_ENTRIES + 5);
});

test("turn 索引同 rowId 去重，淘汰后允许重新登记", () => {
  const index = new ConversationTurnIndex();
  const row = makeRow(2, { kind: "userInput", origin: "realUser", text: "q" });
  index.addRow(row);
  index.addRow(row);
  assert.equal(index.size, 1, "row.upserted / snapshot 重放不重复占额度");
  // 填满上限：rowId 3..20001，随后加入 rowId=1 挤掉最旧的 rowId=2。
  for (let rowId = 3; rowId <= TURN_INDEX_MAX_ENTRIES + 1; rowId++) {
    index.addRow(makeRow(rowId));
  }
  assert.equal(index.size, TURN_INDEX_MAX_ENTRIES);
  assert.equal(index.evictionCount, 0);
  index.addRow(makeRow(1));
  assert.equal(index.evictionCount, 1);
  assert.ok(!index.snapshotEntries().some((entry) => entry.rowId === 2), "最旧条目被淘汰");
  // 淘汰后去重集合同步收缩，同 rowId 允许重新登记。
  index.addRow(makeRow(2));
  assert.ok(index.snapshotEntries().some((entry) => entry.rowId === 2));
});

test("turn 索引 clear() 释放全部条目与字节估算", () => {
  const index = new ConversationTurnIndex();
  index.addRow(makeUserInputRow(1, "问题"));
  assert.ok(index.byteEstimate > 0);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.evictionCount, 0);
  assert.equal(index.byteEstimate, 0);
  assert.equal(index.snapshotEntries().length, 0);
});
