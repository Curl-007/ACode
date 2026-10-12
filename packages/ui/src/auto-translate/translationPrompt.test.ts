import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranslationUserMessage,
  isTranslationOutputExcessive,
  normalizeTranslationOutput,
  resolveTranslationSystemPrompt,
} from "./translationPrompt.js";
import { AUTO_TRANSLATE_INPUT_MAX_CHARS } from "@acode/shared";

test("构造：空与全空白输入返回 null", () => {
  assert.equal(buildTranslationUserMessage(""), null);
  assert.equal(buildTranslationUserMessage("   \n\t "), null);
});

test("构造：超上限输入返回 null（不截断、不拆分）", () => {
  assert.equal(buildTranslationUserMessage("a".repeat(AUTO_TRANSLATE_INPUT_MAX_CHARS + 1)), null);
});

test("构造：正常输入产出 <chat_message> 包裹", () => {
  const message = buildTranslationUserMessage("  帮我修复这个 bug  ");
  assert.ok(message);
  assert.ok(message.startsWith("<chat_message>\n"));
  assert.ok(message.endsWith("\n</chat_message>"));
  assert.ok(message.includes("帮我修复这个 bug"));
});

test("构造：恰在上限的输入不拒绝", () => {
  const exact = "a".repeat(AUTO_TRANSLATE_INPUT_MAX_CHARS);
  const message = buildTranslationUserMessage(exact);
  assert.ok(message);
  assert.ok(message.includes(exact));
});

test("system prompt：两模式文本差异正确且润色模式多一条规则", () => {
  const translate = resolveTranslationSystemPrompt("translate");
  const polish = resolveTranslationSystemPrompt("translate-polish");
  assert.ok(translate.includes("You translate the user's chat message"));
  assert.ok(polish.includes("translate and polish"));
  assert.ok(polish.includes("Polish for grammar and clarity"));
  assert.ok(!translate.includes("Polish for grammar and clarity"));
  // 共同的保真规则两模式都在。
  assert.ok(translate.includes("Preserve technical terms, file paths"));
  assert.ok(polish.includes("Preserve technical terms, file paths"));
});

test("规整：剥代码围栏", () => {
  assert.equal(normalizeTranslationOutput("```\nFix the bug\n```"), "Fix the bug");
  assert.equal(normalizeTranslationOutput("```text\nFix the bug\n```"), "Fix the bug");
});

test("规整：剥四类成对引号", () => {
  assert.equal(normalizeTranslationOutput('"Fix the bug"'), "Fix the bug");
  assert.equal(normalizeTranslationOutput("'Fix the bug'"), "Fix the bug");
  assert.equal(normalizeTranslationOutput("\u201cFix the bug\u201d"), "Fix the bug");
  assert.equal(normalizeTranslationOutput("\u300cFix the bug\u300d"), "Fix the bug");
  // 单侧引号不是包裹噪声，保留。
  assert.equal(normalizeTranslationOutput('"Fix the bug'), '"Fix the bug');
});

test("规整：空输出返回 null", () => {
  assert.equal(normalizeTranslationOutput(""), null);
  assert.equal(normalizeTranslationOutput("   \n  "), null);
  assert.equal(normalizeTranslationOutput("```\n\n```"), null);
});

test("超长判定：译文 > 输入×2 + 200 视为漂移", () => {
  const input = "a".repeat(100);
  assert.equal(isTranslationOutputExcessive(420, input.length), true);
  assert.equal(isTranslationOutputExcessive(400, input.length), false);
  // 长输入下同样成立（斜率 2 + 偏置 200）。
  const longInput = "a".repeat(2_000);
  assert.equal(isTranslationOutputExcessive(4_201, longInput.length), true);
  assert.equal(isTranslationOutputExcessive(4_200, longInput.length), false);
});
