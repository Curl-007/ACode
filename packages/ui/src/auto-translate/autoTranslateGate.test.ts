import assert from "node:assert/strict";
import test from "node:test";
import { shouldKeepTranslation, shouldTranslateOutgoingText } from "./autoTranslateGate.js";
import { AUTO_TRANSLATE_INPUT_MAX_CHARS, type AutoTranslateSettings } from "@acode/shared";

const MODEL = { providerId: "zai", modelId: "glm-4.7" };

function settings(overrides: Partial<AutoTranslateSettings> = {}): AutoTranslateSettings {
  return {
    enabled: true,
    mode: "translate",
    modelSelection: MODEL,
    ...overrides,
  };
}

test("语义表 #1：开关关（settings null / enabled=false）一律不翻译", () => {
  assert.equal(shouldTranslateOutgoingText({ settings: null, text: "你好" }), false);
  assert.equal(shouldTranslateOutgoingText({ settings: undefined, text: "你好" }), false);
  assert.equal(
    shouldTranslateOutgoingText({ settings: settings({ enabled: false }), text: "你好" }),
    false,
  );
});

test("语义表 #2：开关开 + 模型未选（null）→ 直接放行原文，不发起调用", () => {
  assert.equal(
    shouldTranslateOutgoingText({
      settings: settings({ modelSelection: null }),
      text: "你好",
    }),
    false,
  );
});

test("语义表 #5：开关开 + 已选模型 + 正常中文文本 → 翻译", () => {
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "你好" }), true);
});

test("空 / 全空白文本不翻译", () => {
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "" }), false);
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "  \n " }), false);
});

test("slash 命令不进翻译门禁", () => {
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "/help" }), false);
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "  /compact  " }), false);
  // 正文以 / 开头但不是命令的极端形态（如路径）也按命令处理：PRD 首字符判定。
  assert.equal(shouldTranslateOutgoingText({ settings: settings(), text: "/usr/bin" }), false);
});

test("超上限文本不翻译（回退原文，不截断）", () => {
  assert.equal(
    shouldTranslateOutgoingText({
      settings: settings(),
      text: "a".repeat(AUTO_TRANSLATE_INPUT_MAX_CHARS + 1),
    }),
    false,
  );
  assert.equal(
    shouldTranslateOutgoingText({
      settings: settings(),
      text: "a".repeat(AUTO_TRANSLATE_INPUT_MAX_CHARS),
    }),
    true,
  );
});

test("竞态裁决：revision 一致 → 保留译文", () => {
  assert.equal(shouldKeepTranslation({ startRevision: 7, currentRevision: 7 }), true);
});

test("竞态裁决：revision 不匹配 → 丢弃译文（用户后续操作已取代发送）", () => {
  assert.equal(shouldKeepTranslation({ startRevision: 7, currentRevision: 8 }), false);
  assert.equal(shouldKeepTranslation({ startRevision: 7, currentRevision: 6 }), false);
});
