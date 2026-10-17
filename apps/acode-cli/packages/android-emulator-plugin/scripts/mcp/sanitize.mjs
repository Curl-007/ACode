/**
 * 设备文本净化层（specs/device-ui-text-sanitize.md）——设备侧文本进入模型上下文
 * 之前的递归 sanitize。
 *
 * 为什么需要：模拟器/真机的 UI 文本、设备名、日志与命令输出都是**不可信输入**
 * （app 可以把自己的无障碍标签写成任意文本）。不净化的直接转述会把不可见码点
 * （双向控制符、蒙古元音符、零宽字符、行分隔符、代理区码点、Default_Ignorable
 * 全族）带进模型上下文——它们可以视觉伪装文本、跨行走私指令、破坏下游渲染与
 * 日志对齐；超长串还会挤占上下文。
 *
 * 机制形态参照外部成熟实现的公开行为（可见字符上限 + 8× 扫描硬上限 + 不可见
 * 码点闭集过滤 + 硬件键名闭集词表），实现全部自撰。
 *
 * 复用纪律：本文件是 canonical 版本（ios-simulator-plugin）；
 * android-emulator-plugin/scripts/mcp/sanitize.mjs 是同源 vendored 副本。
 * 修改必须双份同步（spec「复用与同步纪律」），两插件独立分发、无运行时共享
 * import 路径，vendoring 是刻意选择而不是重复代码债。
 */

/** 短字段上限（设备名、状态、标识符类）：256 可见字符。 */
export const DEVICE_TEXT_MAX_VISIBLE_CHARS = 256;
/** 输出文本类上限（stderr、错误消息、路径/URL 回显）：4096 可见字符。 */
export const DEVICE_OUTPUT_MAX_VISIBLE_CHARS = 4096;
/** 大块输出类上限（命令 stdout、日志行）：32768 可见字符。 */
export const DEVICE_BULK_OUTPUT_MAX_VISIBLE_CHARS = 32_768;
/** 扫描硬上限倍率：最多扫描 maxVisibleChars × 8 个码点（不可见字符海不得拖死扫描）。 */
export const DEVICE_TEXT_SCAN_MULTIPLIER = 8;
/** 截断标记（可见字符预算用尽或扫描触顶时追加，模型能看出文本被截过）。 */
export const DEVICE_TEXT_TRUNCATION_MARKER = "…[truncated]";

const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;

/**
 * 不可见码点判定（闭集 + Default_Ignorable 全滤）：
 * - C0 控制符（< 0x20）与 DEL + C1（0x7F–0x9F）；
 * - U+180E 蒙古元音符（Mongolian Vowel Separator，历史上是空白、现为格式符，
 *   经典的视觉不可见走私位）；
 * - U+2028 / U+2029 行/段分隔符（JSON 字符串里的换行走私位）；
 * - 代理区 D800–DFFF（孤立代理项，破坏 UTF-8 下游）；
 * - U+FFF9–FFFB 行间注解符；
 * - Unicode Default_Ignorable_Code_Point 全族（零宽空格/连接符、双向控制符、
 *   变体选择符、Hangeul 填充符、Tags 区等——正则属性类兜底，随 Unicode 版本更新）。
 */
export function isInvisibleCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return true;
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x180e ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    DEFAULT_IGNORABLE_PATTERN.test(String.fromCodePoint(codePoint))
  );
}

/**
 * 单串净化：过滤全部不可见码点，保留至多 maxVisibleChars 个可见字符。
 * 扫描硬上限 = maxVisibleChars × 8 个码点：由不可见字符组成的超长串在触顶时
 * 立即停止（既不给 DoS 面，也不静默扫完全串）。按码点迭代，代理对不被劈开。
 * 返回 { text, truncated }：truncated = 可见预算用尽或扫描触顶且仍有剩余内容。
 */
export function sanitizeDeviceTextWithFlag(text, maxVisibleChars = DEVICE_TEXT_MAX_VISIBLE_CHARS) {
  if (typeof text !== "string" || text === "") return { text: "", truncated: false };
  const limit = Number.isInteger(maxVisibleChars) && maxVisibleChars > 0 ? maxVisibleChars : 1;
  const scanBudget = limit * DEVICE_TEXT_SCAN_MULTIPLIER;
  let out = "";
  let visible = 0;
  let scanned = 0;
  let truncated = false;
  for (const char of text) {
    scanned += 1;
    if (scanned > scanBudget) {
      truncated = true;
      break;
    }
    if (isInvisibleCodePoint(char.codePointAt(0))) continue;
    if (visible >= limit) {
      truncated = true;
      break;
    }
    out += char;
    visible += 1;
  }
  return { text: out, truncated };
}

/** 单串净化（只取文本）。 */
export function sanitizeDeviceText(text, maxVisibleChars = DEVICE_TEXT_MAX_VISIBLE_CHARS) {
  return sanitizeDeviceTextWithFlag(text, maxVisibleChars).text;
}

/**
 * 递归净化：对象/数组逐层下探，字符串按上限净化并追加截断标记；键同样净化；
 * `__proto__` 键跳过（不把原型污染面搬进输出对象）；数字/布尔/null 原样通过；
 * 深度护栏 maxDepth（默认 32）防循环引用与病态嵌套拖死递归。
 */
export function sanitizeDeviceTextDeep(value, options = {}) {
  const maxVisibleChars = options.maxVisibleChars ?? DEVICE_TEXT_MAX_VISIBLE_CHARS;
  const maxDepth = options.maxDepth ?? 32;

  function walk(node, depth) {
    if (typeof node === "string") {
      const { text, truncated } = sanitizeDeviceTextWithFlag(node, maxVisibleChars);
      return truncated ? `${text}${DEVICE_TEXT_TRUNCATION_MARKER}` : text;
    }
    if (Array.isArray(node)) {
      if (depth >= maxDepth) return "[max depth reached]";
      return node.map((item) => walk(item, depth + 1));
    }
    if (node !== null && typeof node === "object") {
      if (depth >= maxDepth) return "[max depth reached]";
      const out = {};
      for (const [key, item] of Object.entries(node)) {
        if (key === "__proto__") continue;
        out[sanitizeDeviceText(key, maxVisibleChars)] = walk(item, depth + 1);
      }
      return out;
    }
    return node;
  }

  return walk(value, 0);
}

/**
 * 硬件键名闭集词表：canonical 名 → { iosButton?, androidKeycode? }。
 * 键名类 API 只接受本词表（fail-closed：词表外一律拒绝），设备助手侧不做
 * 自由文本 → 按键的映射。变体（大小写、下划线/连字符/空格）由
 * resolveHardwareKeyName 归一后查表。
 */
export const HARDWARE_KEY_VOCABULARY = Object.freeze({
  home: Object.freeze({ iosButton: "home", androidKeycode: 3 }),
  back: Object.freeze({ androidKeycode: 4 }),
  recents: Object.freeze({ androidKeycode: 187 }),
  lock: Object.freeze({ iosButton: "lock", androidKeycode: 26 }),
  volumeup: Object.freeze({ iosButton: "volumeUp", androidKeycode: 24 }),
  volumedown: Object.freeze({ iosButton: "volumeDown", androidKeycode: 25 }),
  side: Object.freeze({ iosButton: "side" }),
});

/** 词表的 canonical 名清单（错误文案点名用）。 */
export const HARDWARE_KEY_NAMES = Object.freeze(Object.keys(HARDWARE_KEY_VOCABULARY));

/**
 * 归一并解析硬件键名：trim → 小写 → 去掉 `_`/`-`/空格 分隔（volume_up、
 * Volume-Up、volumeUp 同键）。词表外返回 undefined（fail-closed，调用方必须
 * 显式报错而不是静默丢弃——模型需要知道哪个名字不被接受）。
 */
export function resolveHardwareKeyName(name) {
  if (typeof name !== "string") return undefined;
  const canonical = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (canonical === "") return undefined;
  return HARDWARE_KEY_VOCABULARY[canonical];
}
