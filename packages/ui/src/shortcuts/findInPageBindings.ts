/**
 * 页内查找固定绑定（specs: packages/desktop/specs/find-in-page.md）。
 *
 * 从 bindings.ts 同目录姊妹模块承载（conflicts.ts / label.ts 同一拆分先例：
 * bindings.ts 受 400 行 max-lines 硬闸，键位消费面按职责外置）；依赖方向单向
 * 指向 bindings.ts 内核，不成环。
 *
 * 一期不进 SHORTCUT_COMMANDS 可配置命令表（不可改键），由 FindInPageOverlay 的
 * window capture 监听直接消费。冲突过闸（单测锁定，见 test/findInPage.test.ts）：
 * 裸 F1-F12 在 conflicts.ts 保留键黑名单内，可配置命令永远无法占用 F3；
 * Shift+F3 不在黑名单，理论上可被用户录制到 global 命令——现有命令默认绑定与
 * F3/Shift+F3 零相交，用户改键占用属 spec 已记录的已知边界。
 */
import type { KeyboardShortcutPlatformInfo } from "@/lib/keyboardShortcuts.js";
import { matchesShortcutBinding, type ShortcutBindingEvent } from "./bindings.js";

export const FIND_IN_PAGE_BINDINGS = {
  /** 打开查找栏；查找栏已开时 = 下一处。 */
  next: "F3",
  /** 上一处。 */
  previous: "Shift+F3",
} as const;

/**
 * 键盘事件 → 页内查找导航意图；null = 未命中。
 * IME 组合、长按 repeat、多余修饰键噪声由内核 matchesShortcutBinding 统一过滤；
 * 录制态（isShortcutRecordingActive）由调用方短路（与 useAppKeyboard 同一纪律）。
 */
export function matchFindInPageBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): "next" | "previous" | null {
  // 先判裸 F3 再判 Shift+F3 是安全的：裸键绑定要求修饰键精确匹配（shift 不符即不命中）。
  if (matchesShortcutBinding(event, FIND_IN_PAGE_BINDINGS.next, platformInfo)) {
    return "next";
  }
  if (matchesShortcutBinding(event, FIND_IN_PAGE_BINDINGS.previous, platformInfo)) {
    return "previous";
  }
  return null;
}
