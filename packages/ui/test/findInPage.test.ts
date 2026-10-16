import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUT_COMMANDS } from "@acode/shared";
import {
  matchesShortcutBinding,
  resolveEffectiveShortcutBindings,
} from "../src/shortcuts/bindings.js";
import {
  FIND_IN_PAGE_BINDINGS,
  matchFindInPageBinding,
} from "../src/shortcuts/findInPageBindings.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "../src/shortcuts/conflicts.js";
import {
  FIND_IN_PAGE_DEBOUNCE_MS,
  FIND_IN_PAGE_REFOCUS_DELAY_MS,
  FIND_IN_PAGE_SELECT_QUIET_MS,
  isFindInPageCloseEscape,
  meetsFindInPageThreshold,
  shouldSelectOnProgrammaticFocus,
  shouldShowFindCounter,
} from "../src/find-in-page/findInPageModel.js";

/**
 * 页内查找一期的 renderer 纯规则与快捷键过闸
 * （specs: packages/desktop/specs/find-in-page.md 验收 1/4/5/10/11）。
 */

function keyEvent(overrides = {}) {
  return {
    key: "F3",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function escapeEvent(overrides = {}) {
  return {
    key: "Escape",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

test("CJK 感知起搜阈值：拉丁 3 字符起搜，CJK 单字即搜", () => {
  assert.equal(meetsFindInPageThreshold("ab"), false);
  assert.equal(meetsFindInPageThreshold("abc"), true);
  assert.equal(meetsFindInPageThreshold(""), false);
  assert.equal(meetsFindInPageThreshold("中"), true);
  assert.equal(meetsFindInPageThreshold("の"), true);
  assert.equal(meetsFindInPageThreshold("カ"), true);
  assert.equal(meetsFindInPageThreshold("한"), true);
  assert.equal(meetsFindInPageThreshold("a中"), true);
  // 与 main 侧镜像同规则：长度边界 >2。
  assert.equal(meetsFindInPageThreshold("a中c".slice(0, 2)), true); // "a中"：长度 2 但含 CJK
});

test("时延常量：防抖 250ms / 重聚焦 100ms / select 闸 400ms", () => {
  assert.equal(FIND_IN_PAGE_DEBOUNCE_MS, 250);
  assert.equal(FIND_IN_PAGE_REFOCUS_DELAY_MS, 100);
  assert.equal(FIND_IN_PAGE_SELECT_QUIET_MS, 400);
});

test("计数显示门：过阈值且结果已回才显示", () => {
  assert.equal(shouldShowFindCounter("abc", true), true);
  assert.equal(shouldShowFindCounter("abc", false), false);
  assert.equal(shouldShowFindCounter("ab", true), false);
  assert.equal(shouldShowFindCounter("中", true), true);
  assert.equal(shouldShowFindCounter("", true), false);
});

test("程序性聚焦 select() 闸：距上次击键 >400ms 才全选", () => {
  assert.equal(shouldSelectOnProgrammaticFocus(1000, 1400), false); // 恰 400ms 不触发
  assert.equal(shouldSelectOnProgrammaticFocus(1000, 1401), true);
  assert.equal(shouldSelectOnProgrammaticFocus(0, 10_000), true); // 从未击键
});

test("Escape 关闭判定：无修饰、非 repeat、非 IME 组合", () => {
  assert.equal(isFindInPageCloseEscape(escapeEvent()), true);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ shiftKey: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ ctrlKey: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ altKey: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ metaKey: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ repeat: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ isComposing: true })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ keyCode: 229 })), false);
  assert.equal(isFindInPageCloseEscape(escapeEvent({ key: "Enter" })), false);
});

test("F3/Shift+F3 固定绑定匹配：key 与 code 双通道、噪声过滤", () => {
  assert.equal(FIND_IN_PAGE_BINDINGS.next, "F3");
  assert.equal(FIND_IN_PAGE_BINDINGS.previous, "Shift+F3");
  assert.equal(matchFindInPageBinding(keyEvent()), "next");
  assert.equal(matchFindInPageBinding(keyEvent({ shiftKey: true })), "previous");
  // 修饰键精确匹配：Ctrl+F3 / Alt+F3 不命中。
  assert.equal(matchFindInPageBinding(keyEvent({ ctrlKey: true })), null);
  assert.equal(matchFindInPageBinding(keyEvent({ altKey: true })), null);
  assert.equal(matchFindInPageBinding(keyEvent({ metaKey: true })), null);
  // IME / repeat 噪声（内核统一过滤）。
  assert.equal(matchFindInPageBinding(keyEvent({ repeat: true })), null);
  assert.equal(matchFindInPageBinding(keyEvent({ isComposing: true })), null);
  assert.equal(matchFindInPageBinding(keyEvent({ keyCode: 229 })), null);
  // 非 US 布局 / key 不可信时按 event.code 兜底。
  assert.equal(matchFindInPageBinding(keyEvent({ key: "Unidentified", code: "F3" })), "next");
  assert.equal(
    matchFindInPageBinding(keyEvent({ key: "Unidentified", code: "F3", shiftKey: true })),
    "previous",
  );
  // 其他键不误命中。
  assert.equal(matchFindInPageBinding(keyEvent({ key: "F4" })), null);
  assert.equal(matchFindInPageBinding(keyEvent({ key: "f", code: "KeyF" })), null);
});

test("冲突过闸：命令表默认绑定与 F3/Shift+F3 零相交", () => {
  const effective = resolveEffectiveShortcutBindings();
  for (const entry of SHORTCUT_COMMANDS) {
    for (const binding of effective[entry.id] ?? []) {
      assert.equal(
        isSamePhysicalBinding(binding, FIND_IN_PAGE_BINDINGS.next),
        false,
        `${entry.id} 的默认绑定 ${binding} 与 F3 物理等价`,
      );
      assert.equal(
        isSamePhysicalBinding(binding, FIND_IN_PAGE_BINDINGS.previous),
        false,
        `${entry.id} 的默认绑定 ${binding} 与 Shift+F3 物理等价`,
      );
    }
  }
});

test("冲突过闸：裸 F3 在保留黑名单内，global 命令改键无法占用", () => {
  const conflict = checkShortcutBindingConflict("toggleSidebar", FIND_IN_PAGE_BINDINGS.next);
  assert.equal(conflict?.kind, "reserved");
  const appleConflict = checkShortcutBindingConflict("toggleSidebar", FIND_IN_PAGE_BINDINGS.next, undefined, {
    platformInfo: { platform: "MacIntel", userAgent: "Macintosh" },
  });
  assert.equal(appleConflict?.kind, "reserved");
  // 固定绑定自身可被内核匹配（防止保留黑名单意外挡住 F3 字符串解析）。
  assert.equal(matchesShortcutBinding(keyEvent(), FIND_IN_PAGE_BINDINGS.next), true);
});
