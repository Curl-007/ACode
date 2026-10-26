// U07 目录索引与窗口外跳转的纯逻辑单测（specs/conversation-index-navigation.md）。
// 运行：TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/tests/conversation-index-navigation.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INDEX_FOCUS_MAX_REQUESTS_PER_JUMP,
  INDEX_FOCUS_TAIL_FLOOR_ROWS,
  clampRowsRangeLimit,
  isIndexFocusResponseApplicable,
  planIndexFocusPage,
  resolveIndexDirectory,
  resolveIndexFocusBudget,
  resolveIndexFocusCommit,
  resolveIndexFocusNextAction,
  resolveIndexFocusOutcome,
  resolveIndexFocusReconciliation,
  resolveIndexFocusRows,
  resolveRunningTurnRowCount,
  resolveUnitIndexForRowId,
  trimIndexFocusRows,
} from "../src/v4/conversationIndexNavigation.ts";

const MAX_ROWS = 1200;
const MAX_BYTES = 32 * 1024 * 1024;

// ── 定向单页定位（spec 规则 2 / U07-A1）──

test("planIndexFocusPage: beforeRowId = 目标 rowId + 1（服务端 slice(-limit) 使目标为末页行）", () => {
  const page = planIndexFocusPage(4200, 200);
  assert.equal(page.beforeRowId, 4201);
  assert.equal(page.limit, 200);
});

test("planIndexFocusPage: limit 恒被 rowsRangeMaxLimit(200) 夹住，不超上限", () => {
  assert.equal(planIndexFocusPage(1, 500).limit, 200);
  assert.equal(planIndexFocusPage(1, 200).limit, 200);
  assert.equal(planIndexFocusPage(1, 0).limit, 1, "非法上限回落到最小合法值 1");
  assert.equal(clampRowsRangeLimit(Number.NaN), 1);
});

test("planIndexFocusPage: 尾部第 0 行也可定向（beforeRowId = 1）", () => {
  assert.equal(planIndexFocusPage(0, 200).beforeRowId, 1);
});

// ── 共享信封预算（spec「窗口语义裁决」+ 不变量 1）──

test("resolveIndexFocusBudget: 常态（尾部 60 行）不动尾部，焦点拿满剩余预算", () => {
  const budget = resolveIndexFocusBudget({
    tailRowCount: 60,
    tailRetainBytesProvider: () => 60_000,
    focusRowCount: 0,
    incomingRowCount: 200,
    runningTurnRowCount: 5,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assert.equal(budget.tailTrimmed, false, "证据 2：信封未争用时零代价，不裁尾");
  assert.equal(budget.tailRetainRows, 60);
  assert.equal(budget.focusRowCapacity, MAX_ROWS - 60);
  assert.ok(budget.focusRowCapacity >= 200, "焦点容量足够容纳一次定向页");
});

test("resolveIndexFocusBudget: 焦点 + 尾部合计不破 1200 行信封（断言总和，不逐份）", () => {
  // 争用场景：尾部已 1200 行，再要焦点 200 行 → 必须裁尾，总和仍 ≤1200。
  const budget = resolveIndexFocusBudget({
    tailRowCount: MAX_ROWS,
    tailRetainBytesProvider: (rows) => rows * 100,
    focusRowCount: 0,
    incomingRowCount: 200,
    runningTurnRowCount: 3,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assert.equal(budget.tailTrimmed, true);
  // 总和不变量：尾部保留 + 焦点容量 == 信封上限。
  assert.equal(budget.tailRetainRows + budget.focusRowCapacity, MAX_ROWS);
  assert.ok(budget.tailRetainRows >= INDEX_FOCUS_TAIL_FLOOR_ROWS);
  assert.ok(budget.focusRowCapacity >= 200, "裁尾后焦点仍装得下本次页");
});

test("resolveIndexFocusBudget: 裁尾下限按运行中 turn 抬高，永不裁进当前运行 turn（证据 3）", () => {
  const budget = resolveIndexFocusBudget({
    tailRowCount: MAX_ROWS,
    tailRetainBytesProvider: (rows) => rows * 100,
    focusRowCount: 0,
    incomingRowCount: 200,
    // 运行中 turn 有 150 行，远超 60 下限。
    runningTurnRowCount: 150,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assert.ok(
    budget.tailRetainRows >= 150,
    `尾部保留 ${budget.tailRetainRows} 行必须 ≥ 运行中 turn 的 150 行，否则丢流式增量`,
  );
});

test("resolveIndexFocusBudget: 字节侧同样受 32 MiB 信封约束（tailRetainBytes 传入）", () => {
  const halfBudget = MAX_BYTES / 2;
  const budget = resolveIndexFocusBudget({
    tailRowCount: 60,
    // 尾部 60 行已占半个字节信封。
    tailRetainBytesProvider: () => halfBudget,
    focusRowCount: 0,
    incomingRowCount: 10,
    runningTurnRowCount: 1,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assert.equal(budget.focusByteCapacity, halfBudget, "焦点字节容量 = 信封 − 尾部占用");
  assert.ok(budget.focusByteCapacity > 0);
});

test("resolveIndexFocusBudget: 焦点侧超容量时从头部丢最旧（focusDropHeadRows）", () => {
  const budget = resolveIndexFocusBudget({
    tailRowCount: 60,
    tailRetainBytesProvider: () => 0,
    focusRowCount: MAX_ROWS - 60, // 焦点已满
    incomingRowCount: 50,
    runningTurnRowCount: 1,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
  });
  assert.equal(budget.focusRowCapacity, MAX_ROWS - 60);
  assert.equal(budget.focusDropHeadRows, 50, "并入 50 行需从焦点头部丢 50 行以守住信封");
});

test("resolveIndexFocusCommit: 运行中 turn 占满信封时焦点让位，合计仍 ≤ maxRows", () => {
  // 极端形态：单个运行中 turn 就有 1200 行（长工具链）。尾部下限被抬到 1200，
  // 焦点容量为 0 —— 此时必须整体让位，否则焦点+尾部会突破信封（回归：曾算出 1201）。
  const merged = Array.from({ length: 200 }, (_, i) => ({ rowId: i + 1 }));
  const commit = resolveIndexFocusCommit({
    merged,
    tailFirstRowId: 10_000,
    tailRowCount: MAX_ROWS,
    tailRetainBytes: (rows) => rows * 100,
    runningTurnRowCount: MAX_ROWS, // 运行中 turn 占满整个信封
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
    byteOf: () => 100,
  });
  assert.equal(commit.rows.length, 0, "焦点必须整体让位给运行中 turn");
  assert.equal(commit.focusBytes, 0);
  assert.equal(commit.tailTrimmed, false, "不裁尾：裁进运行中 turn 会丢 row.delta 增量");
  assert.ok(commit.rows.length + commit.tailRetainRows <= MAX_ROWS, "合计不得突破信封");
});

// ── 焦点合并规范（升序 + 去重 + 严格早于尾部首行，spec 不变量 3）──

test("resolveIndexFocusRows: 升序、去重、剔除 ≥ 尾部首行的重叠行", () => {
  // continueFocusOlder 前插的页可能与已有焦点行重叠，且到达顺序不保证升序。
  const merged = [
    { rowId: 300 },
    { rowId: 100 },
    { rowId: 300 }, // 重复
    { rowId: 200 },
    { rowId: 500 }, // 已在权威尾部（tailFirstRowId=500）→ 必须让位，避免重复渲染
  ];
  const result = resolveIndexFocusRows(merged, 500);
  assert.deepEqual(
    result.map((row) => row.rowId),
    [100, 200, 300],
  );
});

test("resolveIndexFocusRows: tailFirstRowId=null（尾部为空）时保留全部升序行", () => {
  const result = resolveIndexFocusRows([{ rowId: 3 }, { rowId: 1 }], null);
  assert.deepEqual(
    result.map((row) => row.rowId),
    [1, 3],
  );
});

test("resolveIndexFocusRows: 全部行都 ≥ 尾部首行时返回空（焦点被尾部完全吸收）", () => {
  const result = resolveIndexFocusRows([{ rowId: 500 }, { rowId: 600 }], 500);
  assert.deepEqual(result, []);
});

// ── 共享信封提交（焦点 + 尾部合计不超信封，spec 量化门槛）──

test("resolveIndexFocusCommit: 信封未争用时不裁尾（tailTrimmed=false）", () => {
  const merged = Array.from({ length: 200 }, (_, i) => ({ rowId: i + 1 }));
  const commit = resolveIndexFocusCommit({
    merged,
    tailFirstRowId: 1000,
    tailRowCount: 60,
    tailRetainBytes: () => 60_000,
    runningTurnRowCount: 1,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
    byteOf: () => 100,
  });
  assert.equal(commit.tailTrimmed, false);
  assert.equal(commit.rows.length, 200);
  assert.equal(commit.focusBytes, 20_000);
});

test("resolveIndexFocusCommit: 争用时裁尾让位，焦点+尾部合计 ≤ maxRows（断言总和）", () => {
  const merged = Array.from({ length: 400 }, (_, i) => ({ rowId: i + 1 }));
  const commit = resolveIndexFocusCommit({
    merged,
    tailFirstRowId: 5000,
    tailRowCount: MAX_ROWS, // 尾部已封顶
    tailRetainBytes: (rows) => rows * 100,
    runningTurnRowCount: 1,
    maxRows: MAX_ROWS,
    maxBytes: MAX_BYTES,
    byteOf: () => 100,
  });
  assert.equal(commit.tailTrimmed, true, "尾部封顶时必须裁尾给焦点腾位");
  assert.ok(commit.tailRetainRows >= INDEX_FOCUS_TAIL_FLOOR_ROWS);
  assert.ok(commit.rows.length > 0, "焦点必须拿到预算");
  // 焦点裁剪后落在 focusRowCapacity 内，与保留尾部合计不破信封。
  assert.ok(commit.rows.length + commit.tailRetainRows <= MAX_ROWS);
});

test("resolveIndexFocusCommit: 焦点侧超容量从头裁，保留末行（目标行），字节账目正确", () => {
  const merged = Array.from({ length: 500 }, (_, i) => ({ rowId: i + 1 }));
  const commit = resolveIndexFocusCommit({
    merged,
    tailFirstRowId: 10_000,
    tailRowCount: 60,
    tailRetainBytes: () => 0,
    runningTurnRowCount: 1,
    maxRows: 300, // 强制信封争用，焦点容量 = 300 - 60 = 240
    maxBytes: MAX_BYTES,
    byteOf: () => 100,
  });
  assert.ok(commit.rows.length <= 240, `焦点 ${commit.rows.length} 行必须 ≤ 容量 240`);
  assert.equal(commit.rows.at(-1).rowId, 500, "定向页目标（末行）必须保留");
  assert.equal(commit.focusBytes, commit.rows.length * 100);
});

test("trimIndexFocusRows: 容量为 0 时整体让位（返回空），不保留末行——守住合计信封", () => {
  // 运行中 turn 占满 1200 行 → tailFloor=1200 → focusRowCapacity=0。
  // 此时若沿用「至少保留末行」，焦点+尾部会突破信封（实测 1200+1=1201）。
  const rows = [{ rowId: 1 }, { rowId: 2 }, { rowId: 3 }];
  const result = trimIndexFocusRows(rows, { maxRows: 0, maxBytes: 1e9 }, () => 10);
  assert.deepEqual(result.rows, []);
  assert.equal(result.droppedHead, rows.length);
  assert.equal(result.bytes, 0);
});

test("trimIndexFocusRows: 字节容量为 0 时同样整体让位", () => {
  const rows = [{ rowId: 1 }];
  const result = trimIndexFocusRows(rows, { maxRows: 100, maxBytes: 0 }, () => 10);
  assert.deepEqual(result.rows, []);
});

// ── 焦点裁剪（末行优先，目标行是末页行）──

test("trimIndexFocusRows: 未超限时原样返回（新数组，droppedHead=0）", () => {
  const rows = [{ rowId: 1 }, { rowId: 2 }, { rowId: 3 }];
  const result = trimIndexFocusRows(rows, { maxRows: 10, maxBytes: 1e9 }, () => 10);
  assert.equal(result.rows.length, 3);
  assert.equal(result.droppedHead, 0);
});

test("trimIndexFocusRows: 超行数上限从头丢最旧，保留末行（目标行）", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ rowId: i + 1 }));
  const result = trimIndexFocusRows(rows, { maxRows: 200, maxBytes: 1e9 }, () => 1);
  assert.equal(result.rows.length, 200);
  assert.equal(result.droppedHead, 50);
  assert.equal(result.rows.at(-1).rowId, 250, "末行（定向页目标）必须保留");
  assert.equal(result.rows[0].rowId, 51);
});

test("trimIndexFocusRows: 超字节上限从头丢，至少留一行", () => {
  const rows = [
    { rowId: 1, text: "a".repeat(500) },
    { rowId: 2, text: "b".repeat(500) },
  ];
  const result = trimIndexFocusRows(
    rows,
    { maxRows: 100, maxBytes: 600 },
    (row) => row.text.length,
  );
  assert.equal(result.rows.length, 1, "单行即超预算时保留末行，不裁成空");
  assert.equal(result.rows[0].rowId, 2);
});

// ── 运行中 turn 行数（证据 3 的实况下限）──

test("resolveRunningTurnRowCount: 按 turnId 分组，非「最后一个 turnHeader 之后」", () => {
  const window = [
    { turnId: "a" },
    { turnId: "a" },
    { turnId: "b" },
    { turnId: "b" },
    { turnId: "b" },
  ];
  assert.equal(resolveRunningTurnRowCount(window), 3, "末行 turnId=b，共 3 行");
});

test("resolveRunningTurnRowCount: 空窗口返回 0", () => {
  assert.equal(resolveRunningTurnRowCount([]), 0);
});

// ── 陈旧结果零应用（spec 规则 7 / U07-A3）──

test("isIndexFocusResponseApplicable: 全部匹配 → applicable", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-1",
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, true);
  assert.equal(result.reason, null);
});

test("isIndexFocusResponseApplicable: 会话切换 → session（U07-A3）", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-2",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-1",
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "session");
});

test("isIndexFocusResponseApplicable: 订阅换代 → generation（U07-A3）", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 6,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-1",
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "generation");
});

test("isIndexFocusResponseApplicable: logEpoch 变化（rewind/换代）→ epoch", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-2",
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "epoch");
});

test("isIndexFocusResponseApplicable: 单飞 supersede（focusId 不匹配）→ request", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-1",
    requestFocusId: 3,
    currentFocusId: 4, // 已被更新的定位请求取代
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "request");
});

test("isIndexFocusResponseApplicable: store 关闭 → closed", () => {
  const result = isIndexFocusResponseApplicable({
    closed: true,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: "epoch-1",
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "closed");
});

test("isIndexFocusResponseApplicable: currentLogEpoch=null（无快照）→ epoch", () => {
  const result = isIndexFocusResponseApplicable({
    closed: false,
    requestSessionId: "s-1",
    currentSessionId: "s-1",
    requestGeneration: 5,
    currentGeneration: 5,
    requestLogEpoch: "epoch-1",
    currentLogEpoch: null,
    requestFocusId: 3,
    currentFocusId: 3,
  });
  assert.equal(result.applicable, false);
  assert.equal(result.reason, "epoch");
});

// ── 请求门槛：一次跳转 ≤3，超范围必须显式动作（spec 规则 3）──

test("resolveIndexFocusNextAction: 命中目标 → none", () => {
  assert.equal(
    resolveIndexFocusNextAction({ requestsUsed: 1, targetFound: true, hasMore: true }),
    "none",
  );
});

test("resolveIndexFocusNextAction: 未命中但还有更早 → continue-older（交给用户点击）", () => {
  assert.equal(
    resolveIndexFocusNextAction({ requestsUsed: 1, targetFound: false, hasMore: true }),
    "continue-older",
  );
  assert.equal(
    resolveIndexFocusNextAction({ requestsUsed: 2, targetFound: false, hasMore: true }),
    "continue-older",
  );
});

test("resolveIndexFocusNextAction: 达到 3 请求上限 → range-exhausted（不再后台遍历）", () => {
  assert.equal(
    resolveIndexFocusNextAction({
      requestsUsed: INDEX_FOCUS_MAX_REQUESTS_PER_JUMP,
      targetFound: false,
      hasMore: true,
    }),
    "range-exhausted",
  );
  assert.equal(INDEX_FOCUS_MAX_REQUESTS_PER_JUMP, 3);
});

test("resolveIndexFocusNextAction: 服务端已到头（hasMore=false）未命中 → none（收敛 target-missing）", () => {
  // U07-A4：目标被 rewind/edit 移除后，eligible 已不含它，收敛为确定终态不重试。
  assert.equal(
    resolveIndexFocusNextAction({ requestsUsed: 1, targetFound: false, hasMore: false }),
    "none",
  );
});

// ── 终态裁决（spec 接口封闭枚举 + no-budget 优先级）──

test("resolveIndexFocusOutcome: 命中 → focused/ok", () => {
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 200,
    committedRowCount: 200,
    targetFound: true,
    nextAction: "none",
  });
  assert.deepEqual(o, { status: "focused", nextAction: "none", targetFound: true, code: "ok" });
});

test("resolveIndexFocusOutcome: 未命中且 eligible 到头 → target-missing（U07-A4）", () => {
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 200,
    committedRowCount: 200,
    targetFound: false,
    nextAction: "none",
  });
  assert.equal(o.status, "target-missing");
  assert.equal(o.code, "target-missing");
});

test("resolveIndexFocusOutcome: 到 3 请求上限 → range-exhausted", () => {
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 600,
    committedRowCount: 600,
    targetFound: false,
    nextAction: "range-exhausted",
  });
  assert.equal(o.status, "range-exhausted");
  assert.equal(o.nextAction, "range-exhausted");
});

test("resolveIndexFocusOutcome: 未命中但还能续拉 → focused + continue-older（非终态）", () => {
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 200,
    committedRowCount: 200,
    targetFound: false,
    nextAction: "continue-older",
  });
  assert.equal(o.status, "focused");
  assert.equal(o.nextAction, "continue-older");
  assert.equal(o.code, "ok");
});

test("resolveIndexFocusOutcome: no-budget 优先于 target-missing（有行可放却一行没放下）", () => {
  // 信封被运行中 turn 占满：merged 有行、committed 为 0，且目标自然「没找到」。
  // 必须报 no-budget 而非 target-missing —— 否则 UI 会引导用户去重试一个
  // 在当前预算下永远不可能成功的定位。
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 200,
    committedRowCount: 0,
    targetFound: false,
    nextAction: "none",
  });
  assert.equal(o.status, "no-budget");
  assert.equal(o.code, "no-budget");
  assert.equal(o.nextAction, "none");
  assert.equal(o.targetFound, false);
});

test("resolveIndexFocusOutcome: merged 本就为空时不误报 no-budget（空页 → target-missing）", () => {
  // mergedRowCount=0 说明服务端确实没有可返回的行，不是预算不足。
  const o = resolveIndexFocusOutcome({
    mergedRowCount: 0,
    committedRowCount: 0,
    targetFound: false,
    nextAction: "none",
  });
  assert.equal(o.status, "target-missing", "空页应收敛为 target-missing，不是 no-budget");
});

// ── 尾部前插后的焦点让位裁决（spec 不变量 3 / U07-A2）──

test("resolveIndexFocusReconciliation: 无重叠 → changed=false（不得换 state 引用）", () => {
  const rows = [{ rowId: 100 }, { rowId: 200 }];
  const r = resolveIndexFocusReconciliation({
    rows,
    tailFirstRowId: 500,
    targetRowId: 200,
    byteOf: () => 10,
  });
  assert.deepEqual(r, { changed: false });
});

test("resolveIndexFocusReconciliation: 焦点为空 → changed=false", () => {
  const r = resolveIndexFocusReconciliation({
    rows: [],
    tailFirstRowId: 500,
    targetRowId: null,
    byteOf: () => 10,
  });
  assert.deepEqual(r, { changed: false });
});

test("resolveIndexFocusReconciliation: 尾部前插覆盖部分焦点行 → 只保留更早部分并重算账目", () => {
  const rows = [{ rowId: 100 }, { rowId: 200 }, { rowId: 300 }];
  const r = resolveIndexFocusReconciliation({
    rows,
    tailFirstRowId: 250, // 尾部现在从 250 开始，200/300 中 300 落进尾部
    targetRowId: 100,
    byteOf: () => 10,
  });
  assert.equal(r.changed, true);
  assert.equal(r.resetToIdle, false);
  assert.deepEqual(
    r.rows.map((x) => x.rowId),
    [100, 200],
  );
  assert.equal(r.focusBytes, 20);
  assert.equal(r.targetFound, true, "目标仍在保留集合内");
});

test("resolveIndexFocusReconciliation: 焦点被完全吸收 → resetToIdle=true", () => {
  const rows = [{ rowId: 100 }, { rowId: 200 }];
  const r = resolveIndexFocusReconciliation({
    rows,
    tailFirstRowId: 50, // 尾部首行比全部焦点行都早 → 焦点整体落进尾部
    targetRowId: 100,
    byteOf: () => 10,
  });
  assert.deepEqual(r, { changed: true, resetToIdle: true });
});

test("resolveIndexFocusReconciliation: 目标被让位后 targetFound 归 false", () => {
  const rows = [{ rowId: 100 }, { rowId: 300 }];
  const r = resolveIndexFocusReconciliation({
    rows,
    tailFirstRowId: 250,
    targetRowId: 300, // 目标行本身落进了尾部
    byteOf: () => 5,
  });
  assert.equal(r.changed, true);
  assert.equal(r.resetToIdle, false);
  assert.deepEqual(
    r.rows.map((x) => x.rowId),
    [100],
  );
  assert.equal(r.targetFound, false);
  assert.equal(r.focusBytes, 5);
});

test("resolveIndexFocusReconciliation: tailFirstRowId=null（尾部为空）→ 焦点全保留", () => {
  const rows = [{ rowId: 100 }, { rowId: 200 }];
  const r = resolveIndexFocusReconciliation({
    rows,
    tailFirstRowId: null,
    targetRowId: 200,
    byteOf: () => 1,
  });
  assert.deepEqual(r, { changed: false });
});

// ── 目录视图：0 请求、覆盖范围、淘汰可识别（spec 规则 1/6，U07-A5）──

function entry(rowId, kind, origin, extra = {}) {
  return { rowId, kind, ...(origin ? { origin } : {}), ...extra };
}

test("resolveIndexDirectory: 只收 realUser userInput，其余 kind/origin 排除", () => {
  const entries = [
    entry(1, "userInput", "realUser", { summary: "q1" }),
    entry(2, "assistantText"),
    entry(3, "userInput", "background", { summary: "系统上下文" }),
    entry(4, "userInput", "realUser", { summary: "q2" }),
    entry(5, "toolCall"),
  ];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: 3,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.equal(directory.total, 2, "只保留 realUser userInput");
  assert.deepEqual(
    directory.items.map((item) => item.rowId),
    [1, 4],
  );
});

test("resolveIndexDirectory: 按 rowId 重排（loadOlder 会把更早行登记在更晚行之后）", () => {
  const entries = [
    entry(900, "userInput", "realUser", { summary: "较晚" }),
    entry(100, "userInput", "realUser", { summary: "较早" }),
    entry(500, "userInput", "realUser", { summary: "中间" }),
  ];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.deepEqual(
    directory.items.map((item) => item.rowId),
    [100, 500, 900],
    "登记序不等于全序，目录必须按 rowId 升序",
  );
});

test("resolveIndexDirectory: inWindow 标记（≥ tailFirstRowId 已在尾部窗口，跳转无需请求）", () => {
  const entries = [
    entry(100, "userInput", "realUser", { summary: "窗外" }),
    entry(500, "userInput", "realUser", { summary: "窗内" }),
  ];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: 400,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  const byId = new Map(directory.items.map((item) => [item.rowId, item]));
  assert.equal(byId.get(100).inWindow, false);
  assert.equal(byId.get(500).inWindow, true);
});

test("resolveIndexDirectory: 淘汰可识别——evictedCount>0 → isPartial（U07-A5）", () => {
  const entries = [entry(1, "userInput", "realUser", { summary: "q1" })];
  const partial = resolveIndexDirectory(entries, 42, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.equal(partial.isPartial, true);
  assert.equal(partial.evictedCount, 42);

  const full = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.equal(full.isPartial, false);
});

test("resolveIndexDirectory: 覆盖范围（oldest/newestIndexedRowId）含非 query 行", () => {
  const entries = [
    entry(50, "userInput", "realUser", { summary: "q" }),
    entry(10, "assistantText"),
    entry(999, "toolCall"),
  ];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.equal(directory.oldestIndexedRowId, 10);
  assert.equal(directory.newestIndexedRowId, 999);
  assert.equal(directory.maxEntries, 8000);
});

test("resolveIndexDirectory: 空 summary 回落到 fallbackSummary，copy 权威 turnId/entityId", () => {
  const entries = [
    entry(1, "userInput", "realUser", { summary: "   ", turnId: "t-1", entityId: "e-1" }),
  ];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "用户问题",
  });
  assert.equal(directory.items[0].summary, "用户问题");
  assert.equal(directory.items[0].turnId, "t-1", "复制自权威行，非 UI 推断");
  assert.equal(directory.items[0].entityId, "e-1");
});

test("resolveIndexDirectory: turnId/entityId 缺席时为 null（兼容旧帧，不猜测）", () => {
  const entries = [entry(1, "userInput", "realUser", { summary: "q" })];
  const directory = resolveIndexDirectory(entries, 0, {
    tailFirstRowId: null,
    maxEntries: 8000,
    fallbackSummary: "(空)",
  });
  assert.equal(directory.items[0].turnId, null);
  assert.equal(directory.items[0].entityId, null);
});

// ── rowId → unit index（timeline 派生事实，不反推）──

test("resolveUnitIndexForRowId: 命中含该 rowId 的 unit", () => {
  const units = [
    { renderRows: [{ rowId: 1 }, { rowId: 2 }] },
    { renderRows: [{ rowId: 3 }] },
    { renderRows: [{ rowId: 4 }, { rowId: 5 }] },
  ];
  assert.equal(resolveUnitIndexForRowId(units, 4), 2);
  assert.equal(resolveUnitIndexForRowId(units, 1), 0);
});

test("resolveUnitIndexForRowId: 未命中返回 null（不猜测性跳转）", () => {
  const units = [{ renderRows: [{ rowId: 1 }] }];
  assert.equal(resolveUnitIndexForRowId(units, 999), null);
  assert.equal(resolveUnitIndexForRowId([], 1), null);
});
