import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * T2-7 A 面验证（apps/acode-cli/specs/scheduled-manual-trigger-activation.md）：
 * 远程手动触发的用户激活语义。
 *
 * 两层被测面：
 * 1. 共享纯守卫（packages/shared/src/automation-manual-trigger.ts）——闭集 reason、
 *    新鲜窗、origin 语义（R1/R2/R4/R5）；
 * 2. service 咽喉（packages/services/src/session/automationService.ts runNow）——
 *    拒绝发生在 repo claim 之前（不产生 run 行、不占 single-flight 锁），
 *    兼容窗（trigger 缺席）行为与现状一致。
 *
 * repo 用注入 stub（AutomationService 构造参数），不触 sqlite。
 */

const {
  resolveAutomationManualTriggerAdmission,
  AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS,
  AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS,
  AUTOMATION_MANUAL_TRIGGER_REJECT_REASONS,
  AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES,
} = await import("../../../packages/shared/src/automation-manual-trigger.ts");

const { AutomationService } =
  await import("../../../packages/services/src/session/automationService.ts");
const { AutomationManualTriggerRejectedError } =
  await import("../../../packages/services/src/session/automationManualTrigger.ts");

const NOW = 1_800_000_000_000;

function validActivation(overrides = {}) {
  return { source: "ui_button", activatedAt: NOW - 1_000, ...overrides };
}

// ---------- 纯守卫（R1/R2/R4/R5） ----------

test("guard: remote origin without activation is rejected with activation_required", () => {
  const admission = resolveAutomationManualTriggerAdmission({ origin: "remote" }, NOW);
  assert.deepEqual(admission, { admitted: false, reason: "activation_required" });
});

test("guard: remote origin with valid activation is admitted", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    { origin: "remote", activation: validActivation() },
    NOW,
  );
  assert.equal(admission.admitted, true);
  assert.equal(admission.origin, "remote");
  assert.deepEqual(admission.activation, validActivation());
});

test("guard: activation older than TTL is rejected with activation_expired", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    {
      origin: "remote",
      activation: validActivation({
        activatedAt: NOW - AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS - 1,
      }),
    },
    NOW,
  );
  assert.deepEqual(admission, { admitted: false, reason: "activation_expired" });
});

test("guard: activation inside TTL window is admitted", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    {
      origin: "remote",
      activation: validActivation({
        activatedAt: NOW - AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS + 1_000,
      }),
    },
    NOW,
  );
  assert.equal(admission.admitted, true);
});

test("guard: future activatedAt beyond clock skew is rejected with activation_expired", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    {
      origin: "remote",
      activation: validActivation({
        activatedAt: NOW + AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS + 60_000,
      }),
    },
    NOW,
  );
  assert.deepEqual(admission, { admitted: false, reason: "activation_expired" });
});

test("guard: unknown activation source is rejected with activation_source_unknown", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    { origin: "remote", activation: validActivation({ source: "cron_scheduler" }) },
    NOW,
  );
  assert.deepEqual(admission, { admitted: false, reason: "activation_source_unknown" });
});

test("guard: malformed activation shapes are rejected with activation_malformed", () => {
  for (const activation of [
    "yes",
    42,
    null,
    [],
    { source: "ui_button" },
    { source: "ui_button", activatedAt: Number.NaN },
    { source: "ui_button", activatedAt: "now" },
    { source: 7, activatedAt: NOW },
    { source: "ui_button", activatedAt: NOW, interactionId: 99 },
  ]) {
    const admission = resolveAutomationManualTriggerAdmission(
      { origin: "remote", activation },
      NOW,
    );
    assert.deepEqual(
      admission,
      { admitted: false, reason: "activation_malformed" },
      `activation=${JSON.stringify(activation)}`,
    );
  }
});

test("guard: local_ui origin without activation is admitted (local UI is the user-action surface)", () => {
  const admission = resolveAutomationManualTriggerAdmission({ origin: "local_ui" }, NOW);
  assert.equal(admission.admitted, true);
  assert.equal(admission.origin, "local_ui");
});

test("guard: absent trigger context is admitted via compat window (R5)", () => {
  for (const trigger of [undefined, {}]) {
    const admission = resolveAutomationManualTriggerAdmission(trigger, NOW);
    assert.equal(admission.admitted, true);
    assert.equal(admission.origin, "compat_untagged");
  }
});

test("guard: garbage activation has no compat exemption even for local_ui (R5)", () => {
  const admission = resolveAutomationManualTriggerAdmission(
    {
      origin: "local_ui",
      activation: validActivation({
        activatedAt: NOW - AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS - 1,
      }),
    },
    NOW,
  );
  assert.deepEqual(admission, { admitted: false, reason: "activation_expired" });
});

test("guard: closed sets are frozen vocabulary (single source of truth)", () => {
  assert.deepEqual(
    [...AUTOMATION_MANUAL_TRIGGER_REJECT_REASONS],
    [
      "activation_required",
      "activation_expired",
      "activation_source_unknown",
      "activation_malformed",
    ],
  );
  assert.deepEqual([...AUTOMATION_MANUAL_TRIGGER_ACTIVATION_SOURCES], ["ui_button"]);
  assert.equal(AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS, 300_000);
  assert.equal(AUTOMATION_MANUAL_TRIGGER_CLOCK_SKEW_MS, 60_000);
});

// ---------- service 咽喉（runNow 强制点） ----------

function createServiceHarness() {
  const calls = { get: 0, runNow: 0 };
  const automation = { automationId: "auto-1", title: "t", lifecycleStatus: "active" };
  const repo = {
    async get() {
      calls.get += 1;
      return automation;
    },
    async runNow() {
      calls.runNow += 1;
      return { automation, run: { runId: "auto-1:manual:x", trigger: "manual" } };
    },
  };
  return { service: new AutomationService(repo), calls };
}

test("service: remote trigger without activation throws before touching the repo", async () => {
  const { service, calls } = createServiceHarness();
  await assert.rejects(
    () => service.runNow("auto-1", undefined, { origin: "remote" }),
    (error) => {
      assert.ok(error instanceof AutomationManualTriggerRejectedError);
      assert.equal(error.reason, "activation_required");
      assert.equal(error.automationId, "auto-1");
      return true;
    },
  );
  // 拒绝必须发生在 claim 之前：不产生 run 行、不占 single-flight 锁，甚至不读定义。
  assert.equal(calls.get, 0);
  assert.equal(calls.runNow, 0);
});

test("service: remote trigger with valid activation produces the manual run", async () => {
  const { service, calls } = createServiceHarness();
  const result = await service.runNow("auto-1", undefined, {
    origin: "remote",
    activation: { source: "ui_button", activatedAt: Date.now() - 1_000 },
  });
  assert.ok(result);
  assert.equal(result.run.trigger, "manual");
  assert.equal(calls.runNow, 1);
});

test("service: compat window keeps the legacy two-argument call working", async () => {
  const { service, calls } = createServiceHarness();
  const result = await service.runNow("auto-1");
  assert.ok(result);
  assert.equal(calls.runNow, 1);
});

test("service: local_ui origin without activation is admitted", async () => {
  const { service, calls } = createServiceHarness();
  const result = await service.runNow("auto-1", undefined, { origin: "local_ui" });
  assert.ok(result);
  assert.equal(calls.runNow, 1);
});

test("service: stale activation is rejected for any origin", async () => {
  const { service, calls } = createServiceHarness();
  await assert.rejects(
    () =>
      service.runNow("auto-1", undefined, {
        origin: "local_ui",
        activation: {
          source: "ui_button",
          activatedAt: Date.now() - AUTOMATION_MANUAL_TRIGGER_ACTIVATION_TTL_MS - 60_000,
        },
      }),
    (error) => {
      assert.ok(error instanceof AutomationManualTriggerRejectedError);
      assert.equal(error.reason, "activation_expired");
      return true;
    },
  );
  assert.equal(calls.runNow, 0);
});
