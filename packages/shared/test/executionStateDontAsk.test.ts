import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executionPermissionModeSchema,
  resolveExecutionState,
} from "../src/execution-state.js";
import { submissionModeSchema } from "../src/acode-protocol-v4/submission.js";

// dontAsk 静默降级回归钉（permission-adjudication-batch2 R1 可达面）：
// --mode dontAsk 曾在此规范化边界被 safeParse 丢弃回落 build（E2E 决策日志实证）。
test("resolveExecutionState 保留 dontAsk，不再静默回落 build", () => {
  assert.equal(resolveExecutionState({ mode: "dontAsk" }).mode, "dontAsk");
  // 未知值仍然回落 current（既有 fail-safe 语义不变）。
  assert.equal(resolveExecutionState({ mode: "nonsense" }).mode, "build");
  assert.equal(
    resolveExecutionState({ mode: "nonsense" }, { mode: "yolo", planEnabled: false }).mode,
    "yolo",
  );
  // dontAsk 不携带 plan 语义。
  assert.equal(resolveExecutionState({ mode: "dontAsk" }).planEnabled, false);
});

test("execution/submission 两个模式枚举均收 dontAsk，且与既有档位兼容", () => {
  assert.equal(executionPermissionModeSchema.safeParse("dontAsk").success, true);
  assert.equal(submissionModeSchema.safeParse("dontAsk").success, true);
  for (const mode of ["build", "edit", "yolo"]) {
    assert.equal(executionPermissionModeSchema.safeParse(mode).success, true);
  }
  for (const mode of ["build", "edit", "plan", "yolo"]) {
    assert.equal(submissionModeSchema.safeParse(mode).success, true);
  }
  // auto 仍不进用户 Submission（Runtime 内部状态语义不变）。
  assert.equal(submissionModeSchema.safeParse("auto").success, false);
});
