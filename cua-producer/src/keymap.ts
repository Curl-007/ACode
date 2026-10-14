/**
 * chord/键名 → VK 封闭映射表（specs/windows-helper-producer.md §10.9）。
 *
 * 纯 TS、零依赖（§10.11 模块规则①：不得 import native-driver）；CI 常驻单测覆盖封闭集。
 * 纪律：SDK `normalizeKeyChord` 已做平台归一，producer **不信任**、按本封闭词汇重解析；
 * 未知键名 → undefined（wire 层 invalid_request 固定字面量，绝不猜测 VK）。
 * 文本输入不走本表（sendText KEYEVENTF_UNICODE 布局无关）；本表只服务命名键/chord
 * （pressKeys VK 序列）。
 *
 * chord 文法：`+` 连接修饰键与主键（如 ctrl+shift+a、alt+f4、enter）；最后一个 token 是
 * 主键（可以是修饰键自身，如裸 "ctrl"），之前的 token 必须全部是修饰键 {ctrl,alt,shift,win}；
 * 大小写不敏感（归一小写后查表——封闭词汇不变）；重复修饰键拒绝。
 * 序列形态（§10.2 modifiers 语义的同构展开）：修饰键 down → 主键 down → 主键 up →
 * 修饰键 up（逆序）；hold_seconds 的等待发生在 down 段与 up 段之间（native pressKeys）。
 */

export interface KeySequenceEntry {
  vk: number;
  up: boolean;
}

/** 修饰键封闭词汇（§10.2）→ VK。 */
const MODIFIER_VK: Readonly<Record<string, number>> = Object.freeze({
  ctrl: 0x11, // VK_CONTROL
  alt: 0x12, // VK_MENU
  shift: 0x10, // VK_SHIFT
  win: 0x5b, // VK_LWIN
});

/** 主键封闭集（§10.9：a-z、0-9、f1-f24、命名键、方向键、常见标点与反引号）→ VK。 */
const KEY_VK: Readonly<Record<string, number>> = Object.freeze({
  // 字母（VK 与 ASCII 大写同值）
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4a,
  k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50, q: 0x51, r: 0x52, s: 0x53, t: 0x54,
  u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  // 数字（主行）
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
  "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
  // 功能键 F1–F24（F13–F24 = 0x7C–0x87；f13 是 --pointer 烟测的无害键，§15.2）
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b, f13: 0x7c, f14: 0x7d, f15: 0x7e, f16: 0x7f,
  f17: 0x80, f18: 0x81, f19: 0x82, f20: 0x83, f21: 0x84, f22: 0x85, f23: 0x86, f24: 0x87,
  // 命名键
  esc: 0x1b, tab: 0x09, space: 0x20, enter: 0x0d, backspace: 0x08, delete: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  // 方向键
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  // 常见标点（US 布局 VK_OEM_*；§10.9 封闭集：- = [ ] \ ; ' , . / 与反引号）
  "-": 0xbd, "=": 0xbb, "[": 0xdb, "]": 0xdd, "\\": 0xdc, ";": 0xba, "'": 0xde,
  ",": 0xbc, ".": 0xbe, "/": 0xbf, "`": 0xc0,
  // 修饰键也可作主键（裸 "ctrl" / "ctrl+shift" 形态：按下即抬起）
  ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b,
});

/**
 * 解析规范化 chord → pressKeys 序列（[downs…, ups…]，holdMs 等待发生在两段之间）。
 * 任何未知键名/空 token/重复修饰键/非字符串 → undefined（invalid_request，绝不猜 VK）。
 */
export function parseKeyChord(text: unknown): KeySequenceEntry[] | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const tokens = normalized.split("+");
  if (tokens.some((token) => token.length === 0)) return undefined;  // 空 token（"a++b"/"+a"/"a+"）
  const main = tokens[tokens.length - 1] as string;
  const modifiers = tokens.slice(0, -1);
  const mainVk = KEY_VK[main];
  if (mainVk === undefined) return undefined;
  const seen = new Set<string>();
  const downs: KeySequenceEntry[] = [];
  for (const modifier of modifiers) {
    const vk = MODIFIER_VK[modifier];
    if (vk === undefined) return undefined;      // 前置 token 必须是修饰键
    if (seen.has(modifier)) return undefined;    // 重复修饰键拒绝
    seen.add(modifier);
    downs.push({ vk, up: false });
  }
  downs.push({ vk: mainVk, up: false });
  // up 段 = down 段整体逆序（主键先抬、修饰键 LIFO 释放——与 held 注册表的释放纪律同构）。
  const ups: KeySequenceEntry[] = [...downs].reverse().map((entry) => ({ vk: entry.vk, up: true }));
  return [...downs, ...ups];
}

/** paste 的 Ctrl+V 固定序列（§10.9：clipboardWriteText → Ctrl+V 注入）。 */
export const PASTE_CHORD_SEQUENCE: readonly KeySequenceEntry[] = Object.freeze(
  parseKeyChord("ctrl+v") as KeySequenceEntry[],
);
