import assert from "node:assert/strict";
import test from "node:test";
import { PlatformChannels } from "../src/channels.js";
import type {
  FindInPageDispatchPayload,
  FindInPageReportPayload,
  FindInPageRequest,
  FindInPageResult,
} from "../src/channels.js";

// 页内查找二期 shared 类型兼容锁定（specs: packages/desktop/specs/find-in-page.md 接口节）。
// 类型断言在编译期由 tsc 验证（本文件随包 typecheck 跑）；运行时锁定通道常量字面量，
// 防改名破坏 main/preload/renderer 三端契约。

test("二期通道常量字面量（main/preload/renderer 三端契约）", () => {
  assert.equal(PlatformChannels.FindInPageProviderActive, "acode:find-in-page-provider-active");
  assert.equal(PlatformChannels.FindInPageDispatch, "acode:find-in-page-dispatch");
  assert.equal(PlatformChannels.FindInPageReport, "acode:find-in-page-report");
  assert.equal(PlatformChannels.FindInPageClear, "acode:find-in-page-clear");
  // 一期通道不受二期扩展影响。
  assert.equal(PlatformChannels.FindInPage, "acode:find-in-page");
  assert.equal(PlatformChannels.StopFindInPage, "acode:stop-find-in-page");
  assert.equal(PlatformChannels.EndFindInPageSession, "acode:end-find-in-page-session");
  assert.equal(PlatformChannels.OpenFindInPage, "acode:open-find-in-page");
});

test("FindInPageResult 向后兼容：一期形态字面量仍可赋值（provider 维度字段全部可选）", () => {
  // 一期形态（无 provider 维度字段）——原生路仍返回这个形状。
  const legacy: FindInPageResult = { activeIndex: 0, total: 0 };
  const legacyHit: FindInPageResult = { activeIndex: 3, total: 12 };
  // 二期扩展形态。
  const extended: FindInPageResult = {
    activeIndex: 1,
    total: 4,
    activeInRenderedWindow: false,
    hasUnsearchableRegions: true,
  };
  const partial: FindInPageResult = { activeIndex: 2, total: 2, activeInRenderedWindow: true };
  assert.equal(legacy.activeIndex, 0);
  assert.equal(legacyHit.total, 12);
  assert.equal(extended.activeInRenderedWindow, false);
  assert.equal(partial.hasUnsearchableRegions, undefined);
});

test("FindInPageRequest 形态不变（二期只扩 Result 与新增通道载荷）", () => {
  const request: FindInPageRequest = { text: "查找", findNext: true };
  const withForward: FindInPageRequest = { text: "abc", findNext: false, forward: false };
  assert.equal(request.forward, undefined);
  assert.equal(withForward.forward, false);
});

test("dispatch/report 载荷契约：epoch 必填，report 复用扩展 Result", () => {
  const dispatch: FindInPageDispatchPayload = {
    epoch: 7,
    text: "abc",
    findNext: true,
    forward: true,
  };
  const report: FindInPageReportPayload = {
    epoch: 7,
    result: { activeIndex: 1, total: 1, activeInRenderedWindow: true },
  };
  assert.equal(dispatch.epoch, report.epoch);
  assert.equal(report.result.total, 1);
});
