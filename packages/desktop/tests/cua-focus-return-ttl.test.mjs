/**
 * CUA 面板焦点归还 TTL（specs/embedded-content-focus-yield.md §4）单测。
 *
 * 锚定不变量：
 * - show 前捕获前台 OS 窗口句柄 + 时间戳；dismiss 后 TTL（30s，严格大于）内归还；
 * - 超过 30s 不再归还（用户已走远，抢焦点是打扰）；
 * - 记录一次性消费：归还 / 过期 / 抛错路径都清空，绝不二次归还；
 * - bridge 缺席、句柄不可得、读取/归还抛错全部 fail-soft，不阻断面板生命周期。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { createCuaPanelFocusReturnCoordinator, CUA_PANEL_FOCUS_RETURN_TTL_MS } =
  await import("../src/main/cuaPipFocusRouter.ts");

test("TTL 常量 = 30s", () => {
  assert.equal(CUA_PANEL_FOCUS_RETURN_TTL_MS, 30_000);
});

function createHarness({ handle = 0x1234, captureThrows = false, restoreThrows = false } = {}) {
  const calls = { capture: 0, restore: [] };
  let clock = 1_000_000;
  const bridge = {
    getForegroundWindowHandle() {
      calls.capture += 1;
      if (captureThrows) throw new Error("native capture failed");
      return handle;
    },
    focusWindowByHandle(value) {
      if (restoreThrows) throw new Error("native restore failed");
      calls.restore.push(value);
      return true;
    },
  };
  const coordinator = createCuaPanelFocusReturnCoordinator({
    bridge,
    now: () => clock,
  });
  return {
    calls,
    bridge,
    coordinator,
    advance(ms) {
      clock += ms;
    },
  };
}

test("show 前捕获、29s 后 dismiss → 归还句柄，记录一次性消费", () => {
  const h = createHarness({ handle: 0xabcd });
  h.coordinator.captureForegroundBeforeShow();
  assert.equal(h.coordinator.hasPendingReturn(), true);

  h.advance(29_000);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, [0xabcd], "TTL 内归还捕获的句柄");
  assert.equal(h.coordinator.hasPendingReturn(), false, "记录已消费");

  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, [0xabcd], "重复 dismiss 是 no-op（绝不二次归还）");
});

test("TTL 边界：恰好 30_000ms 仍归还（判定是严格大于）", () => {
  const h = createHarness();
  h.coordinator.captureForegroundBeforeShow();
  h.advance(CUA_PANEL_FOCUS_RETURN_TTL_MS);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.equal(h.calls.restore.length, 1, "恰好 30s 不算过期");
});

test("超过 30s 不再归还，且记录被丢弃", () => {
  const h = createHarness();
  h.coordinator.captureForegroundBeforeShow();
  h.advance(CUA_PANEL_FOCUS_RETURN_TTL_MS + 1);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, [], "过期不抢焦点");
  assert.equal(h.coordinator.hasPendingReturn(), false, "过期记录同样一次性消费");
});

test("捕获失败（bridge 抛错）→ 无记录，restore no-op", () => {
  const h = createHarness({ captureThrows: true });
  h.coordinator.captureForegroundBeforeShow();
  assert.equal(h.coordinator.hasPendingReturn(), false);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, []);
});

test("句柄不可得（null / 0 / 非有限数）→ 无记录", () => {
  for (const handle of [null, 0, Number.NaN]) {
    const h = createHarness({ handle });
    h.coordinator.captureForegroundBeforeShow();
    assert.equal(h.coordinator.hasPendingReturn(), false, `handle=${String(handle)} 不记录`);
  }
});

test("bridge 缺席 → 捕获/归还全链 fail-soft no-op", () => {
  const coordinator = createCuaPanelFocusReturnCoordinator({ bridge: null });
  coordinator.captureForegroundBeforeShow();
  assert.equal(coordinator.hasPendingReturn(), false);
  coordinator.restoreForegroundAfterDismiss(); // 不抛即通过
  const bare = createCuaPanelFocusReturnCoordinator();
  bare.captureForegroundBeforeShow();
  bare.restoreForegroundAfterDismiss();
  assert.equal(bare.hasPendingReturn(), false);
});

test("归还抛错 → 不外抛，记录仍被消费", () => {
  const h = createHarness({ restoreThrows: true });
  h.coordinator.captureForegroundBeforeShow();
  h.advance(1_000);
  h.coordinator.restoreForegroundAfterDismiss(); // 不抛即通过
  assert.equal(h.coordinator.hasPendingReturn(), false);
});

test("discardPendingReturn：异常路径丢弃记录不归还", () => {
  const h = createHarness();
  h.coordinator.captureForegroundBeforeShow();
  h.coordinator.discardPendingReturn();
  assert.equal(h.coordinator.hasPendingReturn(), false);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, []);
});

test("重复捕获以最近一次为准（句柄与时间戳都刷新）", () => {
  const h = createHarness({ handle: 0x1111 });
  h.coordinator.captureForegroundBeforeShow();
  h.advance(20_000);
  // 第二次 show：前台窗口已换、时间戳刷新——旧记录不得复活。
  h.bridge.getForegroundWindowHandle = () => 0x2222;
  h.coordinator.captureForegroundBeforeShow();
  h.advance(20_000);
  h.coordinator.restoreForegroundAfterDismiss();
  assert.deepEqual(h.calls.restore, [0x2222], "归还最近捕获的句柄（距第二次捕获 20s < TTL）");
});
