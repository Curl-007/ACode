import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * dontAsk 模式可达表面验收（specs/permission-adjudication-batch2.md 接线项 1/2/3，
 * 波 2 接线波 WI2-A）：contracts 联合、CLI 词汇面（--mode 白名单走 cli-types 类型 +
 * command-center 归一）、TUI /mode 菜单词汇、子代理严苛度序排位、cron 调度闭集、
 * 会话存储解码面。service 层的 dontAsk 裁决行为由 permission-adjudication-batch2
 * 测试族钉住，本文件只钉「接线后各表面词汇一致」。
 */

const { moreRestrictiveMode } = await import(
  "../packages/core/src/subagent/nesting-policy.ts"
);
const { isFleetModeEscalation } = await import("../packages/core/src/fleet/mode-policy.ts");
const {
  formatAvailableCommandCenterModes,
  normalizeSwitchableCommandCenterMode,
} = await import("../packages/cli/src/command-center/modes.ts");
const { PERMISSION_ADJUDICATION_MODES } = await import(
  "../packages/core/src/permission/dont-ask-mode.ts"
);
const { CronAutomationSchema } = await import("../packages/contracts/src/tools/automation.ts");
const { isCollaborationMode } = await import(
  "../packages/adapters/src/storage/session-store/codecs.ts"
);

// ── 接线项 3：严苛度序排位（裁决记录见 specs/subagent-nesting-budget.md 修订记录 1）──

test("MODE_SEVERITY：auto < dontAsk < plan < edit < build < yolo（moreRestrictiveMode 单源）", () => {
  assert.equal(moreRestrictiveMode("dontAsk", "plan"), "dontAsk");
  assert.equal(moreRestrictiveMode("auto", "dontAsk"), "auto");
  assert.equal(moreRestrictiveMode("build", "dontAsk"), "dontAsk");
  assert.equal(moreRestrictiveMode("dontAsk", "yolo"), "dontAsk");
  assert.equal(moreRestrictiveMode("plan", "edit"), "plan");
  // 既有档位相对序不回退。
  assert.equal(moreRestrictiveMode("edit", "build"), "edit");
  assert.equal(moreRestrictiveMode("build", "yolo"), "build");
  // fail-closed 缺省语义不变。
  assert.equal(moreRestrictiveMode(undefined, undefined), "auto");
});

test("舰队升权判定：dontAsk 发起者请求 plan/build 均按高于发起者拒绝（fail-closed 收紧）", () => {
  assert.equal(isFleetModeEscalation("dontAsk", "plan"), true);
  assert.equal(isFleetModeEscalation("dontAsk", "build"), true);
  // dontAsk 相对更宽档是升权方向反转：build 发起者请求 dontAsk 不算升权（是收紧，
  // launch 面按既有 mode_tightening_unsupported 裁决，不在本测试范围）。
  assert.equal(isFleetModeEscalation("build", "dontAsk"), false);
});

// ── 接线项 2：可达表面词汇 ────────────────────────────────────────────

test("command-center /mode 表面：dontAsk 进可切换集，输入大小写不敏感、输出规范词汇", () => {
  assert.equal(normalizeSwitchableCommandCenterMode("dontask"), "dontAsk");
  assert.equal(normalizeSwitchableCommandCenterMode(" DontAsk "), "dontAsk");
  assert.equal(normalizeSwitchableCommandCenterMode("yolo"), "yolo");
  assert.equal(normalizeSwitchableCommandCenterMode("bogus"), undefined);
  assert.match(formatAvailableCommandCenterModes(), /dontAsk/);
});

test("权限层裁决词汇全集含 dontAsk（PERMISSION_ADJUDICATION_MODES 单一来源）", () => {
  assert.ok(PERMISSION_ADJUDICATION_MODES.includes("dontAsk"));
  assert.equal(PERMISSION_ADJUDICATION_MODES.length, 6);
});

// ── cron 调度面（WI2-B 移交件 2）：contracts 闭集收词后透传不再投影 build ──

test("CronAutomationSchema.mode 闭集含 dontAsk（automation-port 过渡映射退役的契约前提）", () => {
  const parsed = CronAutomationSchema.safeParse({
    automationId: "cron_1",
    title: "nightly",
    cronExpr: "0 3 * * *",
    prompt: "run checks",
    enabled: true,
    lifecycleStatus: "active",
    runCount: 0,
    recurring: true,
    mode: "dontAsk",
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.mode, "dontAsk");
  // 既有四档不回退。
  for (const mode of ["build", "edit", "plan", "yolo"]) {
    assert.equal(
      CronAutomationSchema.safeParse({
        automationId: "cron_1",
        title: "t",
        cronExpr: "0 3 * * *",
        prompt: "p",
        enabled: true,
        lifecycleStatus: "active",
        runCount: 0,
        recurring: true,
        mode,
      }).success,
      true,
    );
  }
});

// ── 会话存储解码面：dontAsk 会话 resume 不被静默降级 ──────────────────

test("isCollaborationMode 收词 dontAsk（落库模式解码面）", () => {
  assert.equal(isCollaborationMode("dontAsk"), true);
  assert.equal(isCollaborationMode("dontask"), false);
  assert.equal(isCollaborationMode("build"), true);
  assert.equal(isCollaborationMode("bogus"), false);
});
