import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 任务级沟通偏好持续性验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/task-preference-persistence-prompt.md 的 R1–R2
 * 与验收场景 1：三要素在场、位于沟通指导区、既有各段逐字保留、无 CJK。
 */

const { buildDynamicBehaviorSection } = await import(
  "../packages/core/src/context/dynamic-sections.ts"
);

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

test("(场景1/R1) 偏好持续性三要素在场，位于沟通指导区", () => {
  const content = buildDynamicBehaviorSection().content;
  // 要素 1：任务级持续偏好，不是一次性请求：
  assert.ok(content.includes("treat it as an active preference for the whole task, not a one-turn request"));
  // 要素 2：新事件到来不静默回落默认风格：
  assert.ok(content.includes("Keep following it as new events arrive"));
  assert.ok(content.includes("don't silently revert to your default style mid-task"));
  // 要素 3：偏好管「怎么说」，不豁免「必须说」（与既有完整性/如实汇报纪律的边界）：
  assert.ok(content.includes("The preference governs how you talk, not whether you report"));
  assert.ok(
    content.includes("delivering everything the user needs in your final message and reporting outcomes faithfully still take precedence"),
  );
  // 位置：沟通指导区内、"Match the response to the question" 段之后：
  assert.ok(
    content.indexOf("Match the response to the question") <
      content.indexOf("When the user sets a communication preference"),
  );
});

test("(场景1/R2) 既有各段逐字保留（抽查关键句），新增段无 CJK", () => {
  const content = buildDynamicBehaviorSection().content;
  assert.ok(content.includes("# Communicating with the user"));
  assert.ok(content.includes("Lead with the outcome."));
  assert.ok(content.includes("Being readable and being concise are different things"));
  assert.ok(
    content.includes("Write code that reads like the surrounding code: match its comment density"),
  );
  assert.ok(content.includes("Only write a code comment to state a constraint"));
  assert.ok(content.includes("For actions that are hard to reverse or outward-facing"));
  assert.ok(content.includes("Treat verification as proving the change works"));
  const preferencePart = content.slice(
    content.indexOf("When the user sets a communication preference"),
    content.indexOf("Write code that reads like the surrounding code"),
  );
  assert.ok(preferencePart.length > 0);
  assert.ok(!CJK_PATTERN.test(preferencePart));
});
