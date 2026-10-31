// LexicalChatInput 批次 5 外迁（lexicalChatInputDecisions）的接缝内决策表测试。纯函数。
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHINESE_SLASH_ALIAS,
  shouldNormalizeLeadingChineseSlashAliasInput,
  shouldResetLexicalEditorAfterSubmit,
  shouldSubmitLexicalEnter,
  shouldSubmitLexicalModifiedEnter,
} from "../src/lexical-chat-input/lexicalChatInputDecisions.js";

test("shouldSubmitLexicalEnter：enterSubmits 总闸", () => {
  assert.equal(shouldSubmitLexicalEnter({ enterSubmits: false, text: "hi" }), false);
  assert.equal(shouldSubmitLexicalEnter({ enterSubmits: true, text: "hi" }), true);
});

test("shouldSubmitLexicalEnter：修饰键与 IME 组合态全部拦截", () => {
  for (const modifier of [
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
  ]) {
    assert.equal(shouldSubmitLexicalEnter({ enterSubmits: true, text: "hi", ...modifier }), false);
  }
});

test("shouldSubmitLexicalEnter：空文本仅 allowSubmitWhenEmpty 放行", () => {
  assert.equal(shouldSubmitLexicalEnter({ enterSubmits: true, text: "" }), false);
  assert.equal(shouldSubmitLexicalEnter({ enterSubmits: true, text: "   " }), false);
  assert.equal(
    shouldSubmitLexicalEnter({ enterSubmits: true, text: "", allowSubmitWhenEmpty: true }),
    true,
  );
});

test("shouldSubmitLexicalModifiedEnter：ctrl/meta 必按、shift 互斥", () => {
  const base = { modifiedEnterSubmits: true, text: "hi" };
  assert.equal(shouldSubmitLexicalModifiedEnter({ ...base, ctrlKey: true }), true);
  assert.equal(shouldSubmitLexicalModifiedEnter({ ...base, metaKey: true }), true);
  assert.equal(shouldSubmitLexicalModifiedEnter(base), false);
  assert.equal(
    shouldSubmitLexicalModifiedEnter({ ...base, ctrlKey: true, shiftKey: true }),
    false,
  );
  assert.equal(
    shouldSubmitLexicalModifiedEnter({ ...base, ctrlKey: true, isComposing: true }),
    false,
  );
  // 总闸关闭时一律不提交。
  assert.equal(
    shouldSubmitLexicalModifiedEnter({ ...base, ctrlKey: true, modifiedEnterSubmits: false }),
    false,
  );
  // 空文本。
  assert.equal(shouldSubmitLexicalModifiedEnter({ ...base, ctrlKey: true, text: "" }), false);
  assert.equal(
    shouldSubmitLexicalModifiedEnter({
      ...base,
      ctrlKey: true,
      text: "",
      allowSubmitWhenEmpty: true,
    }),
    true,
  );
});

test("shouldResetLexicalEditorAfterSubmit：仅显式 false 阻止重置", () => {
  assert.equal(shouldResetLexicalEditorAfterSubmit(false), false);
  assert.equal(shouldResetLexicalEditorAfterSubmit(true), true);
  assert.equal(shouldResetLexicalEditorAfterSubmit(undefined), true);
});

test("shouldNormalizeLeadingChineseSlashAliasInput：顿号→斜杠四条件", () => {
  const base = {
    data: CHINESE_SLASH_ALIAS,
    inputType: "insertText",
    isAtEditorStart: true,
  };
  assert.equal(shouldNormalizeLeadingChineseSlashAliasInput(base), true);
  assert.equal(
    shouldNormalizeLeadingChineseSlashAliasInput({ ...base, data: "/" }),
    false,
  );
  assert.equal(
    shouldNormalizeLeadingChineseSlashAliasInput({ ...base, inputType: "insertCompositionText" }),
    false,
  );
  assert.equal(
    shouldNormalizeLeadingChineseSlashAliasInput({ ...base, isAtEditorStart: false }),
    false,
  );
  assert.equal(
    shouldNormalizeLeadingChineseSlashAliasInput({ ...base, isComposing: true }),
    false,
  );
  assert.equal(shouldNormalizeLeadingChineseSlashAliasInput({ ...base, data: null }), false);
});
