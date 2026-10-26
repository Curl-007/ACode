// i18n 词条对齐守护：en-US 与 zh-CN 的键集必须完全一致。
//
// 根因（2026-10-27 实测发现）：`settings.memory.viewer.disabled` 只存在于 en-US，
// zh-CN 缺失。缺失词条不会报错——`intl.formatMessage` 找不到键时回退为**键名字符串**，
// 于是中文用户看到 `settings.memory.viewer.disabled` 这样的原始键名。这类缺陷静默、
// 无类型报错、无测试拦截，只能靠机械化对齐守护发现。
//
// 该守护是「模式类防护」而非一次性检查：任何后续新增词条（含并发多功能批次）只要漏一侧
// 就在此变红，不需要人工 grep 两个 6000+ 键的文件。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LOCALE_DIR = join(here, "..", "src", "i18n", "locales");

/**
 * 提取词条键。词典是 `export default { "key": "value", ... }` 形态，键在行首两空格缩进。
 * 值可能折行（长文案），故只匹配「行首缩进 + 引号键 + 冒号」这一形状，不解析值。
 */
function extractKeys(localeFile) {
  const source = readFileSync(join(LOCALE_DIR, localeFile), "utf8");
  const keys = [...source.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
  return keys;
}

test("en-US 与 zh-CN 词条键集完全一致（缺失即中文用户看到原始键名）", () => {
  const enKeys = extractKeys("en-US.ts");
  const zhKeys = extractKeys("zh-CN.ts");

  // 先断言提取本身有效：键数量级应稳定在数千，防止正则被词典格式改动悄悄打空。
  assert.ok(enKeys.length > 1000, `en-US 键提取异常（仅 ${enKeys.length}）——正则可能失配`);
  assert.ok(zhKeys.length > 1000, `zh-CN 键提取异常（仅 ${zhKeys.length}）——正则可能失配`);

  const enSet = new Set(enKeys);
  const zhSet = new Set(zhKeys);

  const missingInZh = enKeys.filter((k) => !zhSet.has(k));
  const missingInEn = zhKeys.filter((k) => !enSet.has(k));

  assert.deepEqual(
    missingInZh,
    [],
    `zh-CN 缺 ${missingInZh.length} 个词条（中文用户会看到原始键名）：${missingInZh.join(", ")}`,
  );
  assert.deepEqual(
    missingInEn,
    [],
    `en-US 缺 ${missingInEn.length} 个词条：${missingInEn.join(", ")}`,
  );
});

test("词典内无重复键（重复键会让后者静默覆盖前者）", () => {
  for (const localeFile of ["en-US.ts", "zh-CN.ts"]) {
    const keys = extractKeys(localeFile);
    const seen = new Set();
    const duplicates = [];
    for (const key of keys) {
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }
    assert.deepEqual(
      duplicates,
      [],
      `${localeFile} 存在 ${duplicates.length} 个重复键：${duplicates.join(", ")}`,
    );
  }
});

// 注：**不**守护「值非空」。空值在 i18n 里是合法且必要的——英文常无需后缀而中文需要，
// 例如 `automations.form.schedule.minuteSuffix`（中文「分钟」/ 英文 ""）、
// `settings.modelProvider.codingPlan.purchase.fromPriceSuffix`（中文「起」/ 英文 ""）。
// 把空值判为缺陷会误伤这些有意为之的语言不对称，故只守护键集对齐与重复键。
