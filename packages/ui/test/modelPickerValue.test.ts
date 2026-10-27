import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeCustomModelValue,
  parseModelPickerValue as parseSharedModelSelection,
} from "@acode/shared";
import { formatModelPickerValue, parseModelPickerValue } from "../src/lib/modelPickerValue.js";

/**
 * 模型选择器字符串工具的行为网——**legacy M1 迁移的头号陷阱所在**。
 *
 * 为什么这批测试是 M1 的先决条件而非可选项：review 2026-10-26 的 M1 调研实测，全仓**没有任何**
 * 测试引用这些函数，故 `pnpm --filter @acode/ui test` 对迁移的对错恒绿——那道验收门提供零保护力。
 *
 * 头号不变量：UI 版 `parseModelPickerValue` **不是** shared 版的 re-export，它先解码展示态
 * `custom:provider:model`。若把消费方 import 天真改指 `@acode/shared`，`custom:` 值会**静默抛错**，
 * 自定义模型选择当场坏掉，而现有测试一个都不会红。
 *
 * 已 mutation 验证非空转：模拟该 naive 迁移（让 parseModelPickerValue 直接落 shared）→ 本文件
 * 两条【陷阱】测试变红；还原后绿。
 */

test("parseModelPickerValue: 标准 provider/model 串与 shared 同解", () => {
  assert.deepEqual(parseModelPickerValue("zai/glm-4.7"), {
    providerId: "zai",
    modelId: "glm-4.7",
  });
  assert.deepEqual(parseModelPickerValue("zai/glm-4.7"), parseSharedModelSelection("zai/glm-4.7"));
});

test("parseModelPickerValue: ':' 不是 reasoning 分隔符，整段留在 modelId（与 shared 一致）", () => {
  // reasoning 分隔符是 '$'（ACODE_MODEL_REASONING_SEPARATOR），不是 ':'。故 'glm-4.7:high'
  // 里没有分隔符，整体是 modelId。钉住 UI 与 shared 在这一形态上同解——迁移后不得变。
  assert.deepEqual(parseModelPickerValue("zai/glm-4.7:high"), {
    providerId: "zai",
    modelId: "glm-4.7:high",
  });
  assert.deepEqual(
    parseModelPickerValue("zai/glm-4.7:high"),
    parseSharedModelSelection("zai/glm-4.7:high"),
  );
});

test("parseModelPickerValue: '$' 是 reasoning 分隔符，parse 后拆进 options.reasoningLevel", () => {
  // 与上一条对照：'$' 才是真分隔符。钉住这条防止把 '$' 形态误当普通字符。
  assert.deepEqual(parseModelPickerValue("zai/glm-4.7$high"), {
    providerId: "zai",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high" },
  });
  assert.deepEqual(
    parseModelPickerValue("zai/glm-4.7$high"),
    parseSharedModelSelection("zai/glm-4.7$high"),
  );
});

test("【陷阱】parseModelPickerValue: custom: 展示态由 UI 解码，shared 会抛错", () => {
  const encoded = encodeCustomModelValue("zai", "glm-4.7");
  assert.equal(encoded, "custom:zai:glm-4.7", "encode 形态是展示态 custom:provider:model");

  // UI 版：解码成严格 providerId/modelId 结构（协议要求）。
  assert.deepEqual(parseModelPickerValue(encoded), {
    providerId: "zai",
    modelId: "glm-4.7",
  });

  // shared 版：同一串**抛错**（custom:zai:glm-4.7 无 '/' 分隔符）。
  // 这条就是 M1 迁移的真实风险面：把消费方 import 改指 @acode/shared 会让自定义模型当场坏掉。
  assert.throws(
    () => parseSharedModelSelection(encoded),
    /缺少 Provider/,
    "shared 版必须对 custom: 串抛错——若它开始支持，本包装就失去理由，需重新评估迁移",
  );
});

test("【陷阱】parseModelPickerValue: legacy builtin: 三段形态也走 UI 解码", () => {
  // decodeCustomModelValue 对 custom:builtin:<provider>:<model> 有专门分支：
  // providerId 保留 'builtin:<provider>' 两段。迁移后必须保持这一 legacy 兼容形态。
  assert.deepEqual(parseModelPickerValue("custom:builtin:openai:gpt-4o"), {
    providerId: "builtin:openai",
    modelId: "gpt-4o",
  });
  assert.throws(() => parseSharedModelSelection("custom:builtin:openai:gpt-4o"));
});

test("parseModelPickerValue: 仅 provider 无 model 的 custom 串回落 shared 并抛错（现状，非 UI 特有）", () => {
  // decodeCustomModelValue('custom:provideronly') 返回 { providerId } 而无 modelName，
  // 故 UI 的 `customModel?.providerId && customModel.modelName` 守卫不成立 → 回落 shared → 抛错。
  // 钉住现状：这不是 UI 与 shared 的差异（两者都抛），迁移不改变这一行为。
  assert.throws(() => parseModelPickerValue("custom:provideronly"), /缺少 Provider/);
  assert.throws(() => parseSharedModelSelection("custom:provideronly"), /缺少 Provider/);
});

test("parseModelPickerValue: URL 编码的 provider/model 名被正确解码", () => {
  // encode 走 encodeURIComponent，故含特殊字符的模型名必须能往返。
  const encoded = encodeCustomModelValue("my provider", "model/with:special");
  assert.deepEqual(parseModelPickerValue(encoded), {
    providerId: "my provider",
    modelId: "model/with:special",
  });
});

test("formatModelPickerValue: 选型 → 'provider/model'；undefined → 空串", () => {
  assert.equal(formatModelPickerValue({ providerId: "zai", modelId: "glm-4.7" }), "zai/glm-4.7");
  assert.equal(formatModelPickerValue(undefined), "");
});

test("formatModelPickerValue: 与 parseModelPickerValue 对标准形态往返一致", () => {
  // 往返不变量：format(parse(x)) === x（仅对标准形态成立；custom: 形态不往返，见下）。
  assert.equal(formatModelPickerValue(parseModelPickerValue("zai/glm-4.7")), "zai/glm-4.7");
  // custom: 展示态**不**往返（format 产出 provider/model，不还原 custom: 前缀）——
  // 钉住现状，防止迁移时被误当作 bug「修好」而改变既有 UI 行为。
  assert.equal(formatModelPickerValue(parseModelPickerValue("custom:zai:glm-4.7")), "zai/glm-4.7");
});

test("reasoningLevel 往返：format 用 '$' 分隔符，parse 原样拆回 options.reasoningLevel", () => {
  const formatted = formatModelPickerValue({
    providerId: "zai",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high" },
  });
  // ACODE_MODEL_REASONING_SEPARATOR === "$"（实测 model-selection.ts:34）。
  assert.equal(formatted, "zai/glm-4.7$high");
  assert.deepEqual(parseModelPickerValue(formatted), {
    providerId: "zai",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high" },
  });
});
