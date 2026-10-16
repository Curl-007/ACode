import assert from "node:assert/strict";
import test from "node:test";
import {
  acodeOffPeakCreateParamsSchema,
  acodeOffPeakPermissionModeSchema,
  acodeTaskModeSchema,
} from "@acode/shared";
import { buildAutomationModeOption } from "../src/settings/automationAgentConfigOptions.js";

// WI2-D 微收尾①：Automations / Off-peak 表单权限档扩集 dontAsk（权限批 2 R1，
// 「拒绝代替询问」的无人值守安全档）。本测试钉住两件事：
// 1. 表单选项源（AUTOMATION_MODE_VALUES 经 buildAutomationModeOption 投影）提供 dontAsk；
// 2. 保存链路两侧 schema 不再拒绝该值——
//    - Automations：services automationRepo.assertValidAutomationMode 走 acodeTaskModeSchema
//      （Repo 是绕过 RPC 时的最终持久化边界）；CLI 侧 contracts CronAutomationSchema.mode
//      与 automation-port 透传已在前序接线扩集；
//    - Off-peak：会话内创建协议 acodeOffPeakCreateParamsSchema.permissionMode 走
//      acodeOffPeakPermissionModeSchema。

test("automation mode picker offers dontAsk alongside the four legacy modes", () => {
  const option = buildAutomationModeOption("dontAsk");
  const values = option.options?.map((entry) => entry.value) ?? [];
  assert.deepEqual(values, ["build", "edit", "plan", "yolo", "dontAsk"]);
  // 选中值必须原样保留：编辑既有 dontAsk 任务时表单不得回退到默认档。
  assert.equal(option.currentValue, "dontAsk");
});

test("every offered automation mode passes the persistence-boundary schema", () => {
  const option = buildAutomationModeOption("build");
  for (const entry of option.options ?? []) {
    const parsed = acodeTaskModeSchema.safeParse(entry.value);
    assert.equal(
      parsed.success,
      true,
      `automation mode "${entry.value}" 被 acodeTaskModeSchema 拒绝，保存链路会断`,
    );
  }
  // dontAsk 单独点名：本测试的核心断言，防止未来扩集时被批量循环掩盖。
  assert.equal(acodeTaskModeSchema.safeParse("dontAsk").success, true);
});

test("off-peak create chain accepts dontAsk permission mode", () => {
  assert.equal(acodeOffPeakPermissionModeSchema.safeParse("dontAsk").success, true);
  const params = acodeOffPeakCreateParamsSchema.safeParse({
    title: "nightly refactor",
    prompt: "run the nightly refactor",
    permissionMode: "dontAsk",
  });
  assert.equal(params.success, true);
});
