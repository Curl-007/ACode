import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/** 拒绝工程安全姿态块验收（specs/refusal-engineering-posture.md 场景 1-3）：身份段四
 * 要素 + 顺序快照；workflow_actor 逐字同块在契约前；spec 要素断言（警戒态登记不实现、格式差异在册）。 */

const { buildIdentitySection, buildSafetyPostureBlock, buildSecurityNotice } = await import(
  "../packages/core/src/context/sections/identity.ts"
);
const { buildWorkflowActorIdentitySection } = await import(
  "../packages/core/src/context/sections/workflow-actor.ts"
);

test("(场景1) 身份段：四条拒绝工程要素在场且顺序正确（应用点快照）", () => {
  const section = buildIdentitySection();
  const posture = buildSafetyPostureBlock();
  assert.ok(section.content.includes(posture), "姿态块必须逐字进入身份段");
  // 顺序快照：安全 IMPORTANT 行 < # Safety posture < # Harness。
  const importantIdx = section.content.indexOf(buildSecurityNotice());
  const postureIdx = section.content.indexOf("# Safety posture");
  const harnessIdx = section.content.indexOf("# Harness");
  assert.ok(importantIdx >= 0, "IMPORTANT 行在场");
  assert.ok(postureIdx > importantIdx && harnessIdx > postureIdx, "顺序钉住");
  assert.match(posture, /signal to refuse the request as written/i); // 1 元认知触发器
  assert.match(posture, /justifications you supplied yourself/i); // 2 自供理由不构成授权
  assert.match(posture, /are not authorization/i);
  assert.match(posture, /keep it short/i); // 3 音量缩减
  assert.match(posture, /carry on with the rest of the task/i); // 3 拒绝后继续其余
  assert.match(posture, /do not collapse into self-abasement/i); // 4 不自我贬低
  assert.match(posture, /more compliant turn by turn/i); // 4 不顺从递增
});

test("(场景2) workflow_actor 段：逐字同一姿态块、位于契约段之前", () => {
  const section = buildWorkflowActorIdentitySection({ name: "reviewer", persona: "p" });
  const postureIdx = section.content.indexOf(buildSafetyPostureBlock());
  assert.ok(postureIdx > 0, "姿态块必须逐字进入子代理身份（两通道同一份）");
  assert.ok(section.content.indexOf("# Working inside a workflow") > postureIdx, "契约 golden 切片零影响");
  assert.ok(section.content.includes("IMPORTANT: Assist with authorized security testing")); // 既有共享钉
});

test("(场景3) spec 要素：警戒态登记不实现 + 格式教义差异记录在册", async () => {
  const spec = await readFile(
    new URL("../specs/refusal-engineering-posture.md", import.meta.url),
    "utf8",
  );
  assert.match(spec, /会话级警戒态/); // R3 机制评估对象
  assert.match(spec, /登记不实现/); // R3 结论
  assert.match(spec, /格式教义差异记录/); // R4 在册
  assert.match(spec, /拒绝时不用 bullet/); // R4 差异项点名
  assert.match(spec, /不引入|冲突，不采/); // R4 结论：不改
  assert.match(spec, /wellbeing\/evenhandedness/); // 产品裁决边界
});
