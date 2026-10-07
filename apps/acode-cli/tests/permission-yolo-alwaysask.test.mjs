// 批次 C11（R17.1）：完全访问（yolo）放行工作流族 alwaysAsk 的回归钉。
// 裁决前 ask 压过一切放行分支（yolo 也不跳）；裁决后 yolo 在服务层放行，但 plan 生效、
// 策略地板 disableBypassPermissionsMode、项目 deny 三者仍压过它。四条边界逐条钉死，
// 任何一条被改松都会在这里红。
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../packages/core/src/permission/service.ts";

const TOOL = "RunWorkflow";

function context(mode, extra = {}) {
  return { toolName: TOOL, input: {}, riskLevel: "low", mode, ...extra };
}

// 工作流族（CreateWorkflow / RunWorkflow / AmendWorkflow / SaveWorkflow）自报的能力形状。
const alwaysAsk = { alwaysAsk: true };

function floorService(disableBypassPermissionsMode) {
  return new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    policyFloor: {
      deny: [],
      ask: [],
      disallowedTools: [],
      disableBypassPermissionsMode,
    },
  });
}

test("yolo 放行 alwaysAsk：回 allow 且 ruleId 点名模式", () => {
  const svc = new PermissionService();
  const r = svc.checkPermission(context("yolo"), alwaysAsk);
  assert.equal(r.decision, "allow");
  assert.equal(r.ruleId, "mode.yolo.alwaysAsk");
  assert.equal(r.allowed, true);
  assert.equal(r.escalated, false);
});

test("build 模式仍 ask：alwaysAsk 对普通模式语义不变", () => {
  const svc = new PermissionService();
  const r = svc.checkPermission(context("build"), alwaysAsk);
  assert.equal(r.decision, "ask");
  assert.equal(r.escalated, true);
  assert.equal(r.alwaysAsk, true);
});

test("yolo 但 plan 生效：不放行", () => {
  const svc = new PermissionService();
  const r = svc.checkPermission(context("yolo", { planEnabled: true }), alwaysAsk);
  assert.equal(r.decision, "ask");
});

test("yolo 但策略地板禁旁路：不放行", () => {
  const r = floorService(true).checkPermission(context("yolo"), alwaysAsk);
  assert.equal(r.decision, "ask");
});

test("地板未禁旁路时 yolo 照常放行（对照上一条，证明钉的是地板不是 yolo）", () => {
  const r = floorService(false).checkPermission(context("yolo"), alwaysAsk);
  assert.equal(r.decision, "allow");
});

test("yolo + 项目 deny：deny 压过一切放行", () => {
  const svc = new PermissionService();
  const r = svc.checkPermission(context("yolo"), alwaysAsk, {
    version: 1,
    deny: [{ toolName: TOOL }],
  });
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "rule.project.deny");
});
