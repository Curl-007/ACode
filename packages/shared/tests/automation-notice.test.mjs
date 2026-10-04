import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * heartbeat 通知决策协议的纯函数单测
 *（packages/desktop/specs/automation-heartbeat-protocol.md R2）。
 * 解析器是 host settle 与 bots 终态两个评估点的唯一语义来源，fail-safe 必须钉死：
 * 缺失/非法 → absent（消费方按默认安静处理）。
 */

const {
  AUTOMATION_NOTICE_BUFFER_MAX_CHARS,
  AUTOMATION_NOTICE_INSTRUCTION,
  appendAutomationNoticeTail,
  parseAutomationNotice,
} = await import("../src/automation-notice.ts");

test("parse: 标准 NOTIFY / DONT_NOTIFY 标签", () => {
  assert.equal(
    parseAutomationNotice("All checks passed. <automation-notice>NOTIFY</automation-notice>"),
    "notify",
  );
  assert.equal(
    parseAutomationNotice("Routine sync done. <automation-notice>DONT_NOTIFY</automation-notice>"),
    "dont_notify",
  );
});

test("parse: 大小写与标签内空白不敏感", () => {
  assert.equal(parseAutomationNotice("<automation-notice>notify</automation-notice>"), "notify");
  assert.equal(
    parseAutomationNotice("<automation-notice>  dont_notify  </automation-notice>"),
    "dont_notify",
  );
});

test("parse: 缺失/非法一律 absent（fail-safe 默认安静）", () => {
  assert.equal(parseAutomationNotice(""), "absent");
  assert.equal(parseAutomationNotice("no tag at all"), "absent");
  assert.equal(parseAutomationNotice("<automation-notice>NOTIFY"), "absent"); // 未闭合
  assert.equal(parseAutomationNotice("<automation-notice>MAYBE</automation-notice>"), "absent");
  assert.equal(parseAutomationNotice("<other-notice>NOTIFY</other-notice>"), "absent");
});

test("parse: 多标签取最后一个（last-match，bots 跨 run 复用订阅时取最新决策）", () => {
  assert.equal(
    parseAutomationNotice(
      "<automation-notice>NOTIFY</automation-notice> then later <automation-notice>DONT_NOTIFY</automation-notice>",
    ),
    "dont_notify",
  );
  assert.equal(
    parseAutomationNotice(
      "<automation-notice>DONT_NOTIFY</automation-notice> final <automation-notice>NOTIFY</automation-notice>",
    ),
    "notify",
  );
});

test("tail buffer: 上限内原样累积，超限只保留尾部且决策仍可解析", () => {
  let tail = "";
  tail = appendAutomationNoticeTail(tail, "hello ");
  tail = appendAutomationNoticeTail(tail, "world");
  assert.equal(tail, "hello world");

  const chunk = "x".repeat(1024);
  let big = "";
  for (let i = 0; i < 40; i += 1) {
    big = appendAutomationNoticeTail(big, chunk);
  }
  big = appendAutomationNoticeTail(big, "<automation-notice>NOTIFY</automation-notice>");
  assert.ok(big.length <= AUTOMATION_NOTICE_BUFFER_MAX_CHARS);
  assert.ok(big.endsWith("</automation-notice>"));
  assert.equal(parseAutomationNotice(big), "notify");
});

test("instruction: 后缀拼接形态 + 恰好一对决策标签示例 + 恒英文", () => {
  // 注入是「作者 prompt + 指令段」后缀拼接：必须以换行开头，不粘连作者文本。
  assert.ok(AUTOMATION_NOTICE_INSTRUCTION.startsWith("\n"));
  const notifyExamples =
    AUTOMATION_NOTICE_INSTRUCTION.match(/<automation-notice>NOTIFY<\/automation-notice>/g) ?? [];
  const dontExamples =
    AUTOMATION_NOTICE_INSTRUCTION.match(/<automation-notice>DONT_NOTIFY<\/automation-notice>/g) ??
    [];
  assert.equal(notifyExamples.length, 1);
  assert.equal(dontExamples.length, 1);
  assert.equal(/[\u4e00-\u9fff]/.test(AUTOMATION_NOTICE_INSTRUCTION), false);
  // 自身可被解析器识别（示例标签 last-match 为 DONT_NOTIFY——指令尾部即该示例）。
  assert.equal(parseAutomationNotice(AUTOMATION_NOTICE_INSTRUCTION), "dont_notify");
});
