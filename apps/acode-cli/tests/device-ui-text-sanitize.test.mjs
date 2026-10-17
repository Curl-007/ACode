import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * 设备 UI 文本净化层（specs/device-ui-text-sanitize.md）验收测试：
 * 不可见码点闭集、可见字符上限与 8× 扫描硬上限、递归净化（含 __proto__ 与键
 * 净化）、硬件键名闭集词表、vendored 副本字节一致（同步纪律）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const IOS_SANITIZE = join(here, "..", "packages", "ios-simulator-plugin", "scripts", "mcp", "sanitize.mjs");
const ANDROID_SANITIZE = join(
  here,
  "..",
  "packages",
  "android-emulator-plugin",
  "scripts",
  "mcp",
  "sanitize.mjs",
);

const {
  DEVICE_TEXT_MAX_VISIBLE_CHARS,
  DEVICE_TEXT_SCAN_MULTIPLIER,
  DEVICE_TEXT_TRUNCATION_MARKER,
  HARDWARE_KEY_NAMES,
  HARDWARE_KEY_VOCABULARY,
  isInvisibleCodePoint,
  resolveHardwareKeyName,
  sanitizeDeviceText,
  sanitizeDeviceTextDeep,
  sanitizeDeviceTextWithFlag,
} = await import(pathToFileURL(IOS_SANITIZE).href);

test("R2 不可见码点闭集：C0/C1/蒙古元音符/行分隔符/代理区/行间注解/Default_Ignorable", () => {
  const invisible = [
    0x00, 0x09, 0x1f, // C0
    0x7f, 0x80, 0x9f, // DEL + C1
    0x180e, // 蒙古元音符
    0x2028, 0x2029, // 行/段分隔符
    0xd800, 0xdbff, 0xdc00, 0xdfff, // 代理区
    0xfff9, 0xfffa, 0xfffb, // 行间注解
    0x200b, 0x200e, 0x200f, // 零宽空格 / LRM / RLM（Default_Ignorable）
    0x202a, 0x202e, // 双向控制符（Default_Ignorable）
    0x2060, 0xfeff, // word joiner / BOM（Default_Ignorable）
    0xfe0f, // 变体选择符（Default_Ignorable）
    0x3164, // Hangeul 填充符（Default_Ignorable）
    0xe0001, // Tags 区（Default_Ignorable）
  ];
  for (const codePoint of invisible) {
    assert.equal(
      isInvisibleCodePoint(codePoint),
      true,
      `U+${codePoint.toString(16).toUpperCase()} 必须判为不可见`,
    );
  }
  for (const codePoint of [0x41, 0x20, 0x7e, 0x4e2d, 0x1f600]) {
    assert.equal(isInvisibleCodePoint(codePoint), false, `U+${codePoint.toString(16)} 是可见字符`);
  }
  // fail-closed：非法码点按不可见处理。
  assert.equal(isInvisibleCodePoint(0x110000), true);
  assert.equal(isInvisibleCodePoint(Number.NaN), true);
});

test("R2 双向重排攻击样本：控制符消失、可见字符保留原序", () => {
  assert.equal(sanitizeDeviceText("abc\u202edel"), "abcdel");
  assert.equal(sanitizeDeviceText("a\u200bb\u200ec"), "abc");
});

test("R2 上限与截断：257 可见字符截到 256 + 标记；扫描硬上限不被不可见字符海拖死", () => {
  const atLimit = "x".repeat(DEVICE_TEXT_MAX_VISIBLE_CHARS);
  const flagAtLimit = sanitizeDeviceTextWithFlag(atLimit);
  assert.equal(flagAtLimit.text, atLimit);
  assert.equal(flagAtLimit.truncated, false);

  const overLimit = "x".repeat(DEVICE_TEXT_MAX_VISIBLE_CHARS + 1);
  const flagOver = sanitizeDeviceTextWithFlag(overLimit);
  assert.equal(flagOver.text, atLimit);
  assert.equal(flagOver.truncated, true);

  // 1 万个零宽字符（远超 256×8 扫描预算）后跟可见文本：扫描触顶即止，输出为空。
  const invisibleSea = "\u200b".repeat(10_000) + "SMUGGLED";
  const seaFlag = sanitizeDeviceTextWithFlag(invisibleSea);
  assert.equal(seaFlag.text, "");
  assert.equal(seaFlag.truncated, true);
  assert.ok(DEVICE_TEXT_SCAN_MULTIPLIER === 8, "扫描倍率是 spec 定值");
});

test("R1 递归净化：嵌套结构逐层净化、键也净化、__proto__ 丢弃、标量原样", () => {
  // JSON.parse 是产生 own `__proto__` 键的标准形态（真实注入面：设备侧 JSON 里
  // 带 __proto__ 键，透传即污染输出对象原型）。
  const plain = JSON.parse(
    JSON.stringify({
      device: { name: "iPhone\u202e 16", state: "Booted" },
      lines: ["ok\u200b", "bad\u2028line"],
      count: 3,
      okFlag: true,
      nothing: null,
      ["proto\u200bkey"]: "value",
    }),
  );
  Object.defineProperty(plain, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const sanitized = sanitizeDeviceTextDeep(plain);
  assert.equal(sanitized.device.name, "iPhone 16");
  assert.deepEqual(sanitized.lines, ["ok", "badline"]);
  assert.equal(sanitized.count, 3);
  assert.equal(sanitized.okFlag, true);
  assert.equal(sanitized.nothing, null);
  assert.equal(sanitized.protokey, "value", "键中的不可见码点被滤除");
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "__proto__"), false);
  assert.equal(sanitized.polluted, undefined, "输出对象不得携带 __proto__ 键");
  assert.equal({}.polluted, undefined, "Object.prototype 不得被污染");

  // 截断标记在深层字符串上同样生效。
  const deep = sanitizeDeviceTextDeep({ a: { b: ["y".repeat(300)] } });
  assert.ok(deep.a.b[0].endsWith(DEVICE_TEXT_TRUNCATION_MARKER));
  assert.equal(
    deep.a.b[0].length,
    DEVICE_TEXT_MAX_VISIBLE_CHARS + DEVICE_TEXT_TRUNCATION_MARKER.length,
  );
});

test("R3 硬件键名闭集：变体归一命中；词表外 fail-closed", () => {
  assert.equal(resolveHardwareKeyName("HOME"), HARDWARE_KEY_VOCABULARY.home);
  assert.equal(resolveHardwareKeyName("volume_up"), HARDWARE_KEY_VOCABULARY.volumeup);
  assert.equal(resolveHardwareKeyName("Volume-Up"), HARDWARE_KEY_VOCABULARY.volumeup);
  assert.equal(resolveHardwareKeyName("  back "), HARDWARE_KEY_VOCABULARY.back);
  assert.equal(resolveHardwareKeyName("power"), undefined);
  assert.equal(resolveHardwareKeyName(""), undefined);
  assert.equal(resolveHardwareKeyName(42), undefined);
  assert.ok(HARDWARE_KEY_NAMES.includes("lock"));
  // android keycode 映射齐备（key_event 的 key_name 路径依赖）。
  for (const name of ["home", "back", "recents", "lock", "volumeup", "volumedown"]) {
    assert.equal(typeof HARDWARE_KEY_VOCABULARY[name].androidKeycode, "number", name);
  }
});

test("R4 vendored 副本与 canonical 逐字节一致（双份同步纪律）", () => {
  const canonical = readFileSync(IOS_SANITIZE);
  const vendored = readFileSync(ANDROID_SANITIZE);
  assert.ok(canonical.equals(vendored), "android 副本必须与 ios canonical 逐字节一致");
});
