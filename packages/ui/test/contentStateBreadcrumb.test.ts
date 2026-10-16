import assert from "node:assert/strict";
import test from "node:test";
import {
  areContentBreadcrumbPayloadsEqual,
  bucketComposerBlockCount,
  bucketRowsHeldCount,
  bucketTranscriptMessageCount,
  buildContentBreadcrumbPayload,
  createContentStateBreadcrumbReporter,
  normalizeContentRouteKind,
  runWithPrintCallReporting,
} from "../src/lib/contentStateBreadcrumb.js";

/**
 * renderer 内容状态面包屑 ui 侧（desktop specs/main-stall-diagnostics.md R11/R12）：
 * 分桶边界、route kind 归一、payload 形状、周期上报器与 print 上报包裹助手。
 * 闭集与阈值必须与 desktop src/main/contentBreadcrumb.ts 副本一致（spec 为唯一事实源）。
 */

test("route kind 归一：闭集成员原样，其余归 other（不猜未知面）", () => {
  assert.equal(normalizeContentRouteKind("chat"), "chat");
  assert.equal(normalizeContentRouteKind("settings"), "settings");
  assert.equal(normalizeContentRouteKind("browser"), "browser");
  assert.equal(normalizeContentRouteKind("other"), "other");
  assert.equal(normalizeContentRouteKind("cowork"), "other");
  assert.equal(normalizeContentRouteKind(""), "other");
  assert.equal(normalizeContentRouteKind(null), "other");
  assert.equal(normalizeContentRouteKind(7), "other");
});

test("transcript 消息数分桶边界：0/1/10/11/50/51/200/201", () => {
  assert.equal(bucketTranscriptMessageCount(0), "zero");
  assert.equal(bucketTranscriptMessageCount(-3), "zero", "非法计数按 0");
  assert.equal(bucketTranscriptMessageCount(Number.NaN), "zero");
  assert.equal(bucketTranscriptMessageCount(1), "small");
  assert.equal(bucketTranscriptMessageCount(10), "small");
  assert.equal(bucketTranscriptMessageCount(11), "medium");
  assert.equal(bucketTranscriptMessageCount(50), "medium");
  assert.equal(bucketTranscriptMessageCount(51), "large");
  assert.equal(bucketTranscriptMessageCount(200), "large");
  assert.equal(bucketTranscriptMessageCount(201), "huge");
});

test("composer 块数分桶边界：0/1/3/4", () => {
  assert.equal(bucketComposerBlockCount(0), "zero");
  assert.equal(bucketComposerBlockCount(1), "few");
  assert.equal(bucketComposerBlockCount(3), "few");
  assert.equal(bucketComposerBlockCount(4), "many");
});

test("持有行数分桶边界：0/1/50/51/500/501", () => {
  assert.equal(bucketRowsHeldCount(0), "zero");
  assert.equal(bucketRowsHeldCount(1), "small");
  assert.equal(bucketRowsHeldCount(50), "small");
  assert.equal(bucketRowsHeldCount(51), "medium");
  assert.equal(bucketRowsHeldCount(500), "medium");
  assert.equal(bucketRowsHeldCount(501), "large");
});

test("payload 构造：snake_case wire 形状 + 变化检测", () => {
  const payload = buildContentBreadcrumbPayload({
    routeKind: "chat",
    transcriptMessageCount: 12,
    composerBlockCount: 4,
    rowsHeldCount: 60,
  });
  assert.deepEqual(payload, {
    route_kind: "chat",
    transcript_msgs_bucket: "medium",
    composer_blocks_bucket: "many",
    rows_held_bucket: "medium",
  });
  assert.equal(areContentBreadcrumbPayloadsEqual(payload, { ...payload }), true);
  assert.equal(
    areContentBreadcrumbPayloadsEqual(payload, { ...payload, route_kind: "settings" }),
    false,
  );
});

test("上报器：start 立发一条，每 tick 重发（即使内容没变），stop 幂等", () => {
  const sent = [];
  const ticks = [];
  let timerCallback = null;
  const reporter = createContentStateBreadcrumbReporter({
    sample: () => ({
      routeKind: "chat",
      transcriptMessageCount: 1,
      composerBlockCount: 0,
      rowsHeldCount: 0,
    }),
    send: (payload) => sent.push(payload),
    intervalMs: 5_000,
    setIntervalFn: (callback, ms) => {
      timerCallback = callback;
      ticks.push(ms);
      return { fake: "handle" };
    },
    clearIntervalFn: () => {
      timerCallback = null;
    },
  });
  reporter.start();
  reporter.start(); // 幂等：不叠加第二个 timer
  assert.deepEqual(ticks, [5_000]);
  assert.equal(sent.length, 1, "start 立即先发一条（main 无需等首个 tick）");
  timerCallback?.();
  timerCallback?.();
  assert.equal(sent.length, 3, "内容没变也重发：stamp age 只反映上报器停摆");
  reporter.stop();
  reporter.stop(); // 幂等
  assert.equal(timerCallback, null);
  reporter.reportOnce();
  assert.equal(sent.length, 4, "stop 后仍可手动补发（如页面隐藏前）");
});

test("上报器 fail-open：sample/send 抛错静默跳过，不炸 interval", () => {
  let mode = "throw-sample";
  const sent = [];
  let timerCallback = null;
  const reporter = createContentStateBreadcrumbReporter({
    sample: () => {
      if (mode === "throw-sample") throw new Error("sample boom");
      return {
        routeKind: "settings",
        transcriptMessageCount: 0,
        composerBlockCount: 0,
        rowsHeldCount: 0,
      };
    },
    send: (payload) => {
      if (mode === "throw-send") throw new Error("send boom");
      sent.push(payload);
    },
    setIntervalFn: (callback) => {
      timerCallback = callback;
      return {};
    },
    clearIntervalFn: () => {},
  });
  reporter.start(); // sample 抛错：start 不炸
  assert.equal(sent.length, 0);
  mode = "throw-send";
  timerCallback?.(); // send 抛错：tick 不炸
  mode = "ok";
  timerCallback?.();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].route_kind, "settings");
  reporter.stop();
});

test("print 上报包裹：前 true 后 false；action 抛错时 finally 仍发结束上报", () => {
  const reports = [];
  const result = runWithPrintCallReporting(
    (printing) => reports.push(printing),
    () => "printed",
  );
  assert.equal(result, "printed");
  assert.deepEqual(reports, [true, false]);

  reports.length = 0;
  assert.throws(
    () =>
      runWithPrintCallReporting(
        (printing) => reports.push(printing),
        () => {
          throw new Error("print boom");
        },
      ),
    /print boom/u,
  );
  assert.deepEqual(
    reports,
    [true, false],
    "结束上报丢失只能等 main 侧 10min 自愈，必须 finally 保证",
  );

  // report 自身抛错不影响用户动作
  reports.length = 0;
  const value = runWithPrintCallReporting(
    () => {
      throw new Error("transport down");
    },
    () => 42,
  );
  assert.equal(value, 42);
});
