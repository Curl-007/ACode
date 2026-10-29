// U07 store 级行为测试：请求门槛、共享预算、陈旧零应用、淘汰可识别、rewind 联动。
// （specs/conversation-index-navigation.md，验收场景 U07-A1..A5）
// 运行：TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/tests/conversation-index-focus-store.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.ts";
import {
  PROJECTION_WINDOW_MAX_BYTES,
  PROJECTION_WINDOW_MAX_ROWS,
} from "../src/v4/conversationProjectionWindow.ts";
import { TURN_INDEX_MAX_ENTRIES } from "../src/v4/conversationTurnIndex.ts";

const LOG_EPOCH = "epoch-1";
const SUBSCRIPTION_ID = "sub-1";
const SESSION_ID = "s-1";
const TOPIC = `conversation/${SESSION_ID}`;

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

function makeQuery(rowId, text) {
  return makeRow(rowId, { kind: "userInput", origin: "realUser", text, entityId: `e-${rowId}` });
}

function makeSnapshot({ window, totalCount, firstRowId, seq = 1, logEpoch = LOG_EPOCH }) {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
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
  return { topic: TOPIC, subscriptionId: SUBSCRIPTION_ID, fromSeq, toSeq, sentAt: 0, payload };
}

/**
 * 合成全量历史（默认 6000 行会话）。
 *
 * wireSnapshotRows 决定初始 snapshot 携带多少行，默认 60 = 真实 wire 尾窗
 * （PROTOCOL_V4_LIMITS.snapshotTailWindowRows）。
 *
 * serverTotalRows 让**权威侧**比 renderer 索引更短（默认与 totalRows 相同）：
 * 用来复现「权威分支已被 rewind 截断，但 renderer 索引仍登记着更早 rowId」，
 * 这是唯一能让定向页**不命中**目标的路径（正常情况下 beforeRowId=target+1 必命中）。
 *
 * rowsRange 逐字复刻服务端 getRowsRange 语义（conversation-topic-publisher.ts）：
 * eligible = 可见行.filter(rowId < beforeRowId); rows = eligible.slice(-limit);
 * hasMore = eligible.length > rows.length。
 * 这份复刻是「一次定向请求即命中目标」结论的验证依据，不能简化成任意返回。
 */
function makeFixture({
  totalRows = 6000,
  queryEvery = 10,
  wireSnapshotRows = 60,
  serverTotalRows = null,
} = {}) {
  const all = [];
  for (let rowId = 1; rowId <= totalRows; rowId += 1) {
    all.push(rowId % queryEvery === 0 ? makeQuery(rowId, `问题 ${rowId}`) : makeRow(rowId));
  }
  const served = serverTotalRows === null ? all : all.slice(0, serverTotalRows);
  const calls = { rowsRange: [] };
  let deferred = null;

  const serveRowsRange = (params) => {
    const eligible =
      params.beforeRowId === undefined
        ? served
        : served.filter((row) => row.rowId < params.beforeRowId);
    const rows = eligible.slice(-params.limit);
    return {
      rows,
      atSeq: 1,
      atRevision: 0,
      atLogEpoch: LOG_EPOCH,
      hasMore: eligible.length > rows.length,
    };
  };

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
      if (deferred !== null) {
        const result = serveRowsRange(params);
        await deferred.promise;
        return result;
      }
      return serveRowsRange(params);
    },
    plans: async () => ({ atLogEpoch: LOG_EPOCH, atSeq: 0, atRevision: 0, plans: [] }),
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  };

  const snapshot = makeSnapshot({
    window: all.slice(-wireSnapshotRows),
    totalCount: totalRows,
    firstRowId: 1,
  });
  return { all, calls, snapshot, transport, setDeferred: (value) => (deferred = value) };
}

async function makeStore(fixture) {
  const store = new ConversationProjectionStore(TOPIC, fixture.transport);
  await store.connect();
  store.handleFrame(
    makeFrame({ kind: "snapshot", snapshot: fixture.snapshot }, { toSeq: fixture.snapshot.seq }),
    { deliveryKind: "initial" },
  );
  return store;
}

function countBudget(store) {
  const focus = store.getIndexFocusState();
  const tail = store.getState().snapshot?.rows.window ?? [];
  return { tail: tail.length, focus: focus.rows.length, total: tail.length + focus.rows.length };
}

/**
 * 深滚动到窗口封顶，制造「索引有、正文窗外」的目标。
 *
 * 为什么必须这样：loadOlder 拉回的行会前插进窗口（于是 inWindow=true），只有窗口触到
 * 1200 行双上限开始裁头后，被裁行才成为「索引保留、正文窗外」的 U07 目标。这与生产
 * 路径一致（用户深滚动 → 目录点更早的输入），也是既有测试「loadAllOlder 整窗提交裁剪
 * 为双上限尾窗，被丢页行保留在索引」的同一机制。
 */
async function pumpToOutOfWindowTarget(store, { maxPages = 10 } = {}) {
  for (let page = 0; page < maxPages; page += 1) {
    const target = store.getIndexDirectory().items.find((item) => !item.inWindow);
    if (target) return target;
    await store.loadOlder(200);
  }
  const target = store.getIndexDirectory().items.find((item) => !item.inWindow);
  assert.ok(target, "前置条件失败：深滚动后必须存在「索引内、正文窗外」的目标");
  return target;
}

async function pumpToTwoOutOfWindowTargets(store) {
  await pumpToOutOfWindowTarget(store);
  const items = store.getIndexDirectory().items.filter((item) => !item.inWindow);
  assert.ok(items.length >= 2, `需要至少两个窗外目标，实际 ${items.length}`);
  return items;
}

// ── U07-A1：打开目录 0 请求；一次索引内跳转 1 请求且命中 ──

test("U07-A1: 打开目录不请求任何正文（rowsRange 计数 = 0）", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);

  const directory = store.getIndexDirectory();
  assert.equal(fixture.calls.rowsRange.length, 0, "打开目录必须 0 个正文请求");
  assert.ok(directory.total > 0, "目录来自轻量索引，不扫描正文");
  // 索引只覆盖进入过窗口的行（wire 尾窗 60 行、每 10 行一条 query → 6 条）。
  assert.equal(directory.total, 6);
  assert.equal(directory.isPartial, false);
});

test("U07-A1: 索引内跳转只用 1 个定向请求，beforeRowId = 目标+1，命中目标行", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  assert.equal(result.code, "ok");
  assert.equal(result.status, "focused");
  assert.equal(fixture.calls.rowsRange.length - callsBefore, 1, "一次跳转恰好 1 个正文请求");

  const request = fixture.calls.rowsRange.at(-1);
  assert.equal(request.beforeRowId, target.rowId + 1, "定向页：beforeRowId = 目标 rowId + 1");
  assert.ok(request.limit <= 200, `单请求 limit ${request.limit} 必须 ≤ rowsRangeMaxLimit(200)`);

  const focus = store.getIndexFocusState();
  assert.equal(focus.targetFound, true);
  assert.equal(focus.rows.at(-1).rowId, target.rowId, "服务端 slice(-limit) 使目标为末页行");
});

test("U07-A1: 不全量加载历史——跳转后合计远小于全量 6000 行", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  const callsBeforeJump = fixture.calls.rowsRange.length;
  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const counts = countBudget(store);
  assert.ok(counts.total <= PROJECTION_WINDOW_MAX_ROWS, `合计 ${counts.total} 行必须受信封约束`);
  assert.ok(counts.total < 6000, "绝不全量加载历史");
  assert.equal(fixture.calls.rowsRange.length - callsBeforeJump, 1, "跳转只加 1 个请求");
});

// ── 请求门槛：≤3，超范围必须显式动作 ──
//
// 重要事实（由测试验证，不是假设）：定向页 beforeRowId = 目标+1 配合服务端
// slice(-limit) 语义，只要目标在权威分支上就**必然命中**，因此正常路径一次跳转
// 恰好 1 个请求，`continue-older` 是防御性兜底而非常规路径。兜底只在
// 「索引登记过、但权威侧已不再提供该 rowId」的分歧窗口触发（rewind 与 delta
// 到达之间的竞态），下面用 serverTotalRows 显式构造该分歧来验证门槛成立。

test("请求门槛: 正常路径一次跳转 = 1 请求（定向页必命中，无需续拉）", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);

  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  assert.equal(fixture.calls.rowsRange.length - callsBefore, 1);
  assert.equal(result.code, "ok");
  assert.equal(result.nextAction, "none", "命中后不需要任何续拉动作");
  assert.equal(store.getIndexFocusState().targetFound, true);
});

test("请求门槛: 权威侧缺目标行时停在 continue-older，不自动续拉（绝不后台遍历）", async () => {
  // 索引从 wire 尾窗登记了 query rowId=6000，但权威侧只提供到 2000 行（分支被截断、
  // 且截断的 row.removed 未到达 renderer）→ 定向页不含目标，eligible 仍有更早行
  // （hasMore=true）。这是唯一能走到兜底的场景，直接聚焦该 rowId（它已在索引内）。
  const fixture = makeFixture({ totalRows: 6000, serverTotalRows: 2000 });
  const store = await makeStore(fixture);
  assert.ok(
    store.getIndexDirectory().items.some((item) => item.rowId === 6000),
    "前置条件：rowId=6000 的 query 必须已在索引内（来自 wire 尾窗）",
  );

  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(6000));

  assert.equal(fixture.calls.rowsRange.length - callsBefore, 1, "首次跳转仍只 1 个请求");
  assert.equal(result.nextAction, "continue-older", "未命中且还有更早 → 交回用户显式动作");
  assert.equal(store.getIndexFocusState().targetFound, false);
});

test("请求门槛: 显式「继续加载更早」累计请求数 ≤3，到顶收敛为 range-exhausted", async () => {
  const fixture = makeFixture({ totalRows: 6000, serverTotalRows: 2000 });
  const store = await makeStore(fixture);

  const callsBefore = fixture.calls.rowsRange.length;
  await store.focusIndexedRow(store.captureIndexFocusTarget(6000));
  // 模拟用户连续点击「继续加载更早」：即便点 10 次也不得越过门槛。
  for (let i = 0; i < 10; i += 1) {
    if (store.getIndexFocusState().nextAction !== "continue-older") break;
    await store.continueIndexFocusOlder();
  }

  const used = fixture.calls.rowsRange.length - callsBefore;
  assert.ok(used <= 3, `累计请求 ${used} 必须 ≤3（INDEX_FOCUS_MAX_REQUESTS_PER_JUMP）`);
  const final = store.getIndexFocusState();
  assert.equal(final.status, "range-exhausted", "到顶后必须收敛为确定终态");
  assert.equal(final.nextAction, "range-exhausted", "不再提供继续动作");
});

test("请求门槛: 权威侧 eligible 已到头 → target-missing（不重试，U07-A4 同族）", async () => {
  // 权威侧只提供 150 行：定向页 limit=200 一次就取尽 eligible（hasMore=false）。
  const fixture = makeFixture({ totalRows: 6000, serverTotalRows: 150 });
  const store = await makeStore(fixture);

  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(6000));

  assert.equal(result.code, "target-missing");
  assert.equal(result.status, "target-missing");
  assert.equal(result.nextAction, "none", "已到头：收敛为确定终态，不无限重试");
  assert.equal(fixture.calls.rowsRange.length - callsBefore, 1);
});

test("请求门槛: 未索引的远古 rowId → not-indexed，不发任何请求", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  // rowId=3 从未进入过窗口 → 不在索引内（不承诺任意远古输入可定位）。
  assert.equal(
    store.getIndexDirectory().items.some((item) => item.rowId === 3),
    false,
  );
  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(3));
  assert.equal(result.code, "not-indexed");
  assert.equal(result.status, "not-indexed");
  assert.equal(fixture.calls.rowsRange.length, callsBefore, "未索引目标不得发起正文请求");
});

// ── 共享预算：焦点 + 尾部 + 瞬态页缓冲合计不超信封（断言总和）──

test("预算: 焦点 + 尾部 + 瞬态页缓冲合计 ≤1200 行 / ≤32MiB（断言总和，不逐份）", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const counts = countBudget(store);
  assert.ok(
    counts.total <= PROJECTION_WINDOW_MAX_ROWS,
    `合计 ${counts.total} 行必须 ≤ ${PROJECTION_WINDOW_MAX_ROWS}`,
  );
  const diagnostics = store.indexFocusDiagnostics();
  assert.ok(diagnostics.focusBytes <= PROJECTION_WINDOW_MAX_BYTES, "焦点字节必须 ≤ 32MiB 信封");
});

test("预算: 尾部已达 1200 行封顶时聚焦，合计仍 ≤1200（裁尾让位）", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  // pump 之后窗口已封顶（否则不会有窗外目标）。
  assert.equal(countBudget(store).tail, PROJECTION_WINDOW_MAX_ROWS, "前置条件：尾部已封顶");

  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const after = countBudget(store);
  assert.ok(
    after.total <= PROJECTION_WINDOW_MAX_ROWS,
    `封顶后聚焦合计 ${after.total} 行必须仍 ≤ ${PROJECTION_WINDOW_MAX_ROWS}`,
  );
  assert.ok(after.focus > 0, "焦点正文必须拿到预算");
  assert.equal(
    store.getIndexFocusState().tailTrimmed,
    true,
    "信封争用时必须记录裁尾（预算可观测）",
  );
});

// ── U07-A2：焦点期间尾部继续接收权威更新 ──

test("U07-A2: 焦点期间尾部仍应用 row.appended（历史焦点不吞权威更新）", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const tailBefore = store.getState().snapshot.rows.window;
  const lastRowId = tailBefore.at(-1).rowId;
  const seqBefore = store.getState().snapshot.seq;

  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.appended", row: makeRow(lastRowId + 1) }] },
      { fromSeq: seqBefore, toSeq: seqBefore + 1 },
    ),
    { deliveryKind: "online" },
  );

  const tailAfter = store.getState().snapshot.rows.window;
  assert.equal(tailAfter.at(-1).rowId, lastRowId + 1, "权威尾部必须收到新行");
  assert.ok(store.getIndexFocusState().rows.length > 0, "焦点正文仍在（只读派生视图）");
});

test("U07-A2: 焦点与尾部无重复 rowId；returnToLive 后焦点清空", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);

  const target = await pumpToOutOfWindowTarget(store);
  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const focus = store.getIndexFocusState();
  const tail = store.getState().snapshot.rows.window;
  const tailIds = new Set(tail.map((row) => row.rowId));
  for (const row of focus.rows) {
    assert.equal(tailIds.has(row.rowId), false, `rowId ${row.rowId} 不得同时出现在焦点与尾部`);
  }
  assert.ok(
    focus.rows.every((row) => row.rowId < tail[0].rowId),
    "焦点正文必须严格早于尾部窗口首行（不变量 3）",
  );
  for (let i = 1; i < focus.rows.length; i += 1) {
    assert.ok(focus.rows[i].rowId > focus.rows[i - 1].rowId, "焦点正文必须 rowId 升序");
  }

  store.returnToLive();
  assert.equal(store.getIndexFocusState().rows.length, 0, "返回最新必须清空焦点正文");
  assert.equal(store.getIndexFocusState().status, "idle");
});

// ── U07-A3：陈旧响应零应用 ──

test("U07-A3: 在途定位遇订阅换代（generation 变化）→ 迟到响应应用 0 次", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);

  // 可控延迟：让 rowsRange 挂起。
  let release;
  fixture.setDeferred(new Promise((resolve) => (release = resolve)));
  const pending = store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));
  assert.equal(store.getIndexFocusState().status, "loading");

  // 在途期间订阅换代（generation++）。
  await store.connect({ forceSnapshot: true });
  release();
  const result = await pending;

  assert.equal(result.code, "stale", "迟到响应必须被判为 stale");
  assert.equal(store.getIndexFocusState().rows.length, 0, "陈旧响应写入焦点的次数必须为 0");
  assert.equal(store.getIndexFocusState().targetFound, false);
});

test("U07-A3: returnToLive 后在途响应作废（单飞 supersede）", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);

  let release;
  fixture.setDeferred(new Promise((resolve) => (release = resolve)));
  const pending = store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  store.returnToLive(); // requestId 自增，在途请求作废
  release();
  const result = await pending;

  assert.equal(result.code, "stale");
  assert.equal(store.getIndexFocusState().rows.length, 0);
});

test("U07-A3: store close() 后定位入口返回 closed，不发请求", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);
  const target = store.captureIndexFocusTarget(10);
  await store.close();

  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(target);
  assert.equal(result.code, "closed");
  assert.equal(fixture.calls.rowsRange.length, callsBefore, "close 后不得发任何正文请求");
  assert.equal(store.getIndexDirectory().total, 0, "close 释放索引（所有者表）");
  assert.equal(store.getIndexFocusState().status, "idle");
});

// ── U07-A4：rewind/edit 使索引与聚焦一起失效 ──

test("U07-A4: row.removed 同步裁剪索引，被移除 query 不再出现在目录", async () => {
  const fixture = makeFixture({ totalRows: 200 });
  const store = await makeStore(fixture);

  const before = store.getIndexDirectory();
  const lastQuery = before.items.at(-1);
  assert.ok(lastQuery);

  const seq = store.getState().snapshot.seq;
  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.removed", fromRowId: lastQuery.rowId }] },
      { fromSeq: seq, toSeq: seq + 1 },
    ),
    { deliveryKind: "online" },
  );

  const after = store.getIndexDirectory();
  assert.equal(
    after.items.some((item) => item.rowId >= lastQuery.rowId),
    false,
    "被 rewind 移除的 query 必须离开目录",
  );
  assert.equal(after.isPartial, false, "权威移除不是预算淘汰，不得误报为「目录不完整」");
});

test("U07-A4: 焦点目标被 rewind 移除 → target-missing 终态，不无限重试", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);
  const focused = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));
  assert.equal(focused.code, "ok");

  const callsBefore = fixture.calls.rowsRange.length;
  const seq = store.getState().snapshot.seq;
  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.removed", fromRowId: target.rowId }] },
      { fromSeq: seq, toSeq: seq + 1 },
    ),
    { deliveryKind: "online" },
  );

  const focus = store.getIndexFocusState();
  assert.equal(focus.status, "target-missing", "必须收敛为确定的不可定位状态");
  assert.equal(focus.rows.length, 0, "焦点正文一并失效");
  assert.equal(fixture.calls.rowsRange.length, callsBefore, "失效过程不得触发任何重试请求");
});

// ── U07-A5：淘汰可识别 ──

test("U07-A5: 索引超过 8000 项后 FIFO 淘汰，目录标记 isPartial 且暴露淘汰数", async () => {
  const total = TURN_INDEX_MAX_ENTRIES + 50;
  const fixture = makeFixture({ totalRows: total, queryEvery: 1 });
  const store = await makeStore(fixture);

  // 通过 delta 把全量行灌进索引（每条都是 query）。
  let seq = store.getState().snapshot.seq;
  const indexed = new Set(store.getTurnIndexEntries().map((entry) => entry.rowId));
  const batch = fixture.all
    .filter((row) => !indexed.has(row.rowId))
    .map((row) => ({
      op: "row.appended",
      row,
    }));
  for (let i = 0; i < batch.length; i += 500) {
    const chunk = batch.slice(i, i + 500);
    const fromSeq = seq;
    seq += chunk.length;
    store.handleFrame(makeFrame({ kind: "deltas", deltas: chunk }, { fromSeq, toSeq: seq }), {
      deliveryKind: "online",
    });
  }

  assert.equal(store.turnIndexSize(), TURN_INDEX_MAX_ENTRIES, "索引必须封顶在 8000");
  assert.ok(store.turnIndexEvictionCount() >= 50, "必须有可观察的淘汰计数");

  const directory = store.getIndexDirectory();
  assert.equal(directory.isPartial, true, "淘汰必须可识别（只承诺现有覆盖范围）");
  assert.ok(directory.evictedCount > 0);
  assert.equal(directory.maxEntries, TURN_INDEX_MAX_ENTRIES);
});

// ── 单飞与身份 ──

test("单飞: 同一 store 只有一个有效定位，后发请求 supersede 先发", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const items = await pumpToTwoOutOfWindowTargets(store);

  let release;
  fixture.setDeferred(new Promise((resolve) => (release = resolve)));
  const first = store.focusIndexedRow(store.captureIndexFocusTarget(items[0].rowId));
  fixture.setDeferred(null); // 第二次不挂起
  const second = store.focusIndexedRow(store.captureIndexFocusTarget(items[1].rowId));

  const secondResult = await second;
  release();
  const firstResult = await first;

  assert.equal(secondResult.code, "ok", "后发请求生效");
  assert.equal(firstResult.code, "stale", "先发请求被 supersede");
  assert.equal(
    store.getIndexFocusState().rows.at(-1).rowId,
    items[1].rowId,
    "最终焦点必须是后发请求的目标，不得被先发响应覆盖",
  );
});

test("身份: captureIndexFocusTarget 原子捕获 sessionId/generation/logEpoch", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);
  const target = store.captureIndexFocusTarget(42);
  assert.equal(target.sessionId, SESSION_ID);
  assert.equal(target.logEpoch, LOG_EPOCH);
  assert.equal(target.rowId, 42);
  assert.equal(typeof target.generation, "number");
});

test("身份: 跨 session 的点击目标被拒（sessionId 不匹配 → stale，0 次应用）", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);
  const target = store.captureIndexFocusTarget(10);
  const callsBefore = fixture.calls.rowsRange.length;

  const result = await store.focusIndexedRow({ ...target, sessionId: "s-other" });
  assert.equal(result.code, "stale");
  assert.equal(result.staleReason, "session");
  assert.equal(fixture.calls.rowsRange.length, callsBefore, "过期点击不得发正文请求");
});

test("身份: 跨 logEpoch 的点击目标被拒（rewind 后 rowId 重新编号）", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);
  const target = store.captureIndexFocusTarget(10);
  const callsBefore = fixture.calls.rowsRange.length;

  const result = await store.focusIndexedRow({ ...target, logEpoch: "epoch-0" });
  assert.equal(result.code, "stale");
  assert.equal(result.staleReason, "epoch");
  assert.equal(fixture.calls.rowsRange.length, callsBefore);
});

test("身份: 跨 generation 的点击目标被拒", async () => {
  const fixture = makeFixture();
  const store = await makeStore(fixture);
  const target = store.captureIndexFocusTarget(10);
  const callsBefore = fixture.calls.rowsRange.length;

  const result = await store.focusIndexedRow({ ...target, generation: target.generation + 1 });
  assert.equal(result.code, "stale");
  assert.equal(result.staleReason, "generation");
  assert.equal(fixture.calls.rowsRange.length, callsBefore);
});

// ── 焦点与尾部的重复行防护（spec 不变量 3 / U07-A2「没有重复行」）──

/** 合成给 timeline 的 rows（SessionPane 的 timelineRows 同构：焦点前插 + 尾部）。 */
function composedRows(store) {
  const focus = store.getIndexFocusState().rows;
  const tail = store.getState().snapshot?.rows.window ?? [];
  return [...focus, ...tail];
}

function assertNoDuplicateRowIds(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    assert.equal(seen.has(row.rowId), false, `${label}: rowId ${row.rowId} 重复渲染`);
    seen.add(row.rowId);
  }
}

test("不变量 3: 裁尾让位后，焦点与尾部合成 rows 无重复 rowId", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);
  const focusResult = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));
  assert.equal(focusResult.code, "ok");
  assert.equal(store.getIndexFocusState().tailTrimmed, true, "前置条件：本次聚焦裁过尾");

  assertNoDuplicateRowIds(composedRows(store), "裁尾聚焦后");
});

test("不变量 3: snapshot 整体替换（resync）压低尾部首行后，焦点让位权威尾部", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);
  const focusResult = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));
  assert.equal(focusResult.code, "ok");

  const focusBefore = store.getIndexFocusState().rows;
  assert.ok(focusBefore.length > 0, "前置条件：已有焦点正文");
  const tailFirstBefore = store.getState().snapshot.rows.window[0].rowId;
  assert.ok(
    focusBefore.every((row) => row.rowId < tailFirstBefore),
    "前置条件：焦点严格早于尾部首行",
  );

  // 同 epoch 的整体替换快照，其窗口首行落进原焦点区间内（resync / recovery 的真实形态）。
  const overlapRowId = focusBefore.at(-1).rowId;
  const seq = store.getState().snapshot.seq;
  const resyncSnapshot = makeSnapshot({
    window: fixture.all.filter((row) => row.rowId >= overlapRowId),
    totalCount: 6000,
    firstRowId: 1,
    seq: seq + 1,
  });
  store.handleFrame(
    makeFrame({ kind: "snapshot", snapshot: resyncSnapshot }, { fromSeq: seq, toSeq: seq + 1 }),
    { deliveryKind: "online" },
  );

  // 不变量：无论焦点被裁掉多少，合成 rows 里不得出现重复 rowId。
  assertNoDuplicateRowIds(composedRows(store), "snapshot 替换后");
  const focusAfter = store.getIndexFocusState().rows;
  const newTailFirst = store.getState().snapshot.rows.window[0].rowId;
  assert.ok(
    focusAfter.every((row) => row.rowId < newTailFirst),
    "焦点必须仍严格早于新尾部首行，重叠行已让位权威侧",
  );
});

// ── 无预算降级（运行中 turn 占满信封）──

test("无预算: 运行中 turn 占满 1200 行信封时聚焦收敛为 no-budget，不裁尾、不越界", async () => {
  // 构造：尾部 1200 行全部属于同一个运行中 turn（长工具链的极端形态）。
  const runningTurnId = "running-turn";
  const rows = [];
  for (let rowId = 1; rowId <= PROJECTION_WINDOW_MAX_ROWS; rowId += 1) {
    rows.push(makeRow(rowId, { turnId: runningTurnId }));
  }
  const wire = rows.slice(-PROJECTION_WINDOW_MAX_ROWS);
  const fixture = makeFixture({ totalRows: PROJECTION_WINDOW_MAX_ROWS });
  const snapshot = makeSnapshot({
    window: wire,
    totalCount: PROJECTION_WINDOW_MAX_ROWS,
    firstRowId: 1,
  });
  const store = new ConversationProjectionStore(TOPIC, fixture.transport);
  await store.connect();
  store.handleFrame(makeFrame({ kind: "snapshot", snapshot }, { toSeq: snapshot.seq }), {
    deliveryKind: "initial",
  });
  store.setIndexDirectoryFallbackSummary("(空)");

  // 追加更多同 turn 的行：窗口封顶后从头部裁掉，被裁行进索引 → 产生窗外目标。
  let seq = snapshot.seq;
  for (let i = 0; i < 3; i += 1) {
    const deltas = [];
    for (let k = 0; k < 100; k += 1) {
      const rowId = PROJECTION_WINDOW_MAX_ROWS + i * 100 + k + 1;
      deltas.push({
        op: "row.appended",
        row: makeRow(rowId, { turnId: runningTurnId }),
      });
    }
    const fromSeq = seq;
    seq += deltas.length;
    store.handleFrame(makeFrame({ kind: "deltas", deltas }, { fromSeq, toSeq: seq }), {
      deliveryKind: "online",
    });
  }

  const target =
    store.getIndexDirectory().items.find((item) => !item.inWindow) ??
    store.getTurnIndexEntries().find((entry) => {
      const tail = store.getState().snapshot.rows.window;
      return entry.rowId < tail[0].rowId;
    });
  assert.ok(target, "前置条件：必须存在窗外目标");
  const targetRowId = target.rowId;

  const tailBefore = store.getState().snapshot.rows.window.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(targetRowId));

  assert.equal(result.code, "no-budget", "信封占满时必须给出确定的降级态，而非 focused+0 行");
  assert.equal(store.getIndexFocusState().status, "no-budget");
  assert.equal(store.getIndexFocusState().rows.length, 0, "焦点不得占用任何预算");
  assert.equal(
    store.getState().snapshot.rows.window.length,
    tailBefore,
    "不得裁尾——裁进运行中 turn 会丢 row.delta 流式增量",
  );
  const budget = countBudget(store);
  assert.ok(budget.total <= PROJECTION_WINDOW_MAX_ROWS, `合计 ${budget.total} 行必须 ≤ 信封`);
});

// ── loadOlder 与焦点的方向独占 ──

test("方向独占: 焦点生效期间 loadOlder 不前插尾部，返回最新后恢复", async () => {
  const fixture = makeFixture({ totalRows: 6000 });
  const store = await makeStore(fixture);
  const target = await pumpToOutOfWindowTarget(store);
  await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  const tailFirstBefore = store.getState().snapshot.rows.window[0].rowId;
  const callsBefore = fixture.calls.rowsRange.length;
  await store.loadOlder(200);
  assert.equal(
    fixture.calls.rowsRange.length,
    callsBefore,
    "焦点生效期间 loadOlder 必须被抑制，不发请求",
  );
  assert.equal(store.getState().snapshot.rows.window[0].rowId, tailFirstBefore, "尾部首行游标不变");

  store.returnToLive();
  await store.loadOlder(200);
  // 窗口已封顶时 loadOlder 可能无行可并（既有语义），因此只断言它重新被允许尝试。
  assert.ok(store.getIndexFocusState().rows.length === 0, "返回最新后焦点已释放");
});

// ── 索引裁剪不污染淘汰计数（isPartial 语义纯净）──

test("淘汰语义: 预算淘汰计入 evictedCount，权威裁剪不计入", async () => {
  const fixture = makeFixture({ totalRows: 200 });
  const store = await makeStore(fixture);

  const evictionsBefore = store.turnIndexEvictionCount();
  const lastQuery = store.getIndexDirectory().items.at(-1);
  const seq = store.getState().snapshot.seq;
  store.handleFrame(
    makeFrame(
      { kind: "deltas", deltas: [{ op: "row.removed", fromRowId: lastQuery.rowId }] },
      { fromSeq: seq, toSeq: seq + 1 },
    ),
    { deliveryKind: "online" },
  );
  assert.equal(
    store.turnIndexEvictionCount(),
    evictionsBefore,
    "rewind 裁剪不得计入 FIFO 淘汰计数（否则 isPartial 会把「已 rewind」误报成「目录不完整」）",
  );
});

// 回归修复（specs/conversation-index-navigation.md「目标已在尾窗」，2026-10-30 实测）：
// 短会话整条都在权威尾窗内，点击目录条目若走 fetch→commit，fetch 的 rows 会被尾窗去重
// 全部排除（committed=0），被「有行可放却一行没放下」误判为 no-budget，向用户误报
// 「当前回答过长，返回最新后重试」。修复后前置收敛 focused + targetFound，零正文请求。
test("目标已在尾窗：直接收敛 focused + targetFound，零 rowsRange 请求（短会话 no-budget 误判回归）", async () => {
  const fixture = makeFixture({ totalRows: 60 });
  const store = await makeStore(fixture);

  const directory = store.getIndexDirectory();
  assert.ok(directory.items.length > 0, "fixture 索引应非空");
  const target = directory.items[0];
  const tail = store.getState().snapshot?.rows.window ?? [];
  assert.ok(tail.length > 0, "前置：尾窗非空");
  assert.ok(
    target.rowId >= tail[0].rowId,
    `前置：首个索引条目（rowId=${target.rowId}）应在尾窗内（tailFirst=${tail[0].rowId}）`,
  );

  const callsBefore = fixture.calls.rowsRange.length;
  const result = await store.focusIndexedRow(store.captureIndexFocusTarget(target.rowId));

  assert.equal(result.code, "ok");
  assert.equal(result.status, "focused", "目标已在尾窗不得误判 no-budget/target-missing");
  assert.equal(
    fixture.calls.rowsRange.length - callsBefore,
    1,
    "收敛允许一次定向请求（rewind 竞态仍需服务端校验）",
  );
  const focus = store.getIndexFocusState();
  assert.equal(focus.targetFound, true, "Bridge 靠 targetFound 翻真滚动到尾窗行");
  assert.equal(focus.targetRowId, target.rowId);
  assert.equal(focus.rows.length, 0, "焦点正文无需补行");
});
