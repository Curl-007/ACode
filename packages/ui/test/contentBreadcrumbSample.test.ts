import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveContentRouteKind,
  sampleContentState,
} from "../src/app-shell/contentBreadcrumbSample.js";
import {
  countComposerTextBlocks,
  publishComposerContentGauge,
  readComposerContentGauge,
  resetComposerContentGaugeForTest,
} from "../src/v4/composer/composerContentGauge.js";
import { buildContentBreadcrumbPayload } from "../src/lib/contentStateBreadcrumb.js";

/**
 * app-shell 面包屑采样折算（desktop specs/main-stall-diagnostics.md R11 的接线侧）：
 * tabStore activeTab kind → route kind，projection 汇总 → transcript/持有行数，
 * composer gauge → 块数；非 chat 面必须把 composer 块数归零（gauge 卸载不清零）。
 */

test("route kind 折算：settings tab → settings，workspace tab → chat，其余 → other", () => {
  assert.equal(resolveContentRouteKind("settings"), "settings");
  assert.equal(resolveContentRouteKind("workspace"), "chat");
  assert.equal(resolveContentRouteKind(null), "other");
  assert.equal(resolveContentRouteKind(undefined), "other");
  assert.equal(resolveContentRouteKind("browser"), "other", "tabStore 无此 kind，不猜");
});

test("采样折算：字段各自落到对应来源，非法计数按 0", () => {
  const sample = sampleContentState({
    activeTabKind: "workspace",
    projectionRows: 42,
    projectionTurnIndexEntries: 7,
    composerBlockCount: 3,
  });
  assert.deepEqual(sample, {
    routeKind: "chat",
    transcriptMessageCount: 7,
    composerBlockCount: 3,
    rowsHeldCount: 42,
  });

  const invalid = sampleContentState({
    activeTabKind: "workspace",
    projectionRows: Number.NaN,
    projectionTurnIndexEntries: -5,
    composerBlockCount: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(invalid, {
    routeKind: "chat",
    transcriptMessageCount: 0,
    composerBlockCount: 0,
    rowsHeldCount: 0,
  });
});

test("非 chat 面 composer 块数归零：gauge 不随 composer 卸载清零，采样侧必须自己收敛", () => {
  const sample = sampleContentState({
    activeTabKind: "settings",
    projectionRows: 10,
    projectionTurnIndexEntries: 2,
    composerBlockCount: 9,
  });
  assert.equal(sample.routeKind, "settings");
  assert.equal(sample.composerBlockCount, 0);
  assert.equal(sample.rowsHeldCount, 10, "projection 汇总不受 route 影响");
});

test("折算产物直接进 wire payload：桶化在 lib 侧完成，采样侧只给原始计数", () => {
  const payload = buildContentBreadcrumbPayload(
    sampleContentState({
      activeTabKind: "workspace",
      projectionRows: 1200,
      projectionTurnIndexEntries: 201,
      composerBlockCount: 4,
    }),
  );
  assert.deepEqual(payload, {
    route_kind: "chat",
    transcript_msgs_bucket: "huge",
    composer_blocks_bucket: "many",
    rows_held_bucket: "large",
  });
});

test("composer gauge：非空行计块，空白正文为 0，读写往返一致", () => {
  assert.equal(countComposerTextBlocks(""), 0);
  assert.equal(countComposerTextBlocks("   \n \n"), 0);
  assert.equal(countComposerTextBlocks("hello"), 1);
  assert.equal(countComposerTextBlocks("a\n\nb\nc"), 3, "空行不计块");

  resetComposerContentGaugeForTest();
  assert.equal(readComposerContentGauge(), 0);
  publishComposerContentGauge("one\ntwo");
  assert.equal(readComposerContentGauge(), 2);
  publishComposerContentGauge("");
  assert.equal(readComposerContentGauge(), 0, "清空正文后回到 zero 桶");
  resetComposerContentGaugeForTest();
});
