import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P2 补丁项的验收测试：策略地板的进程级结构化继承。
 * 覆盖 apps/acode-cli/specs/subagent-policy-floor-inheritance.md 场景 1–6。
 *
 * 守护的性质：Explore 子代理 / memory agent 用 defaultPermissionConfig 自建的
 * PermissionService 实例必须自动携带进程级策略地板；memory 便利放行不得撤销
 * 安全地板类 ask；子代理模式不可被 request 抬升。
 */

const { PermissionService, defaultPermissionConfig } = await import(
  "../packages/core/src/permission/service.ts"
);
const {
  setProcessManagedPolicyFloor,
  getProcessManagedPolicyFloor,
  resetProcessManagedPolicyFloorForTest,
} = await import("../packages/core/src/permission/process-policy-floor.ts");
const { applyMemoryFilePermission } = await import(
  "../packages/core/src/tool/executor/memory-file-permission.ts"
);
const { resolveSubagentPermissionMode } = await import(
  "../packages/core/src/runtime/methods/subagent.ts"
);

const FLOOR = {
  deny: [{ toolName: "Bash", ruleContent: "curl:*" }],
  ask: [{ toolName: "WebFetch" }],
  disallowedTools: [],
  disableBypassPermissionsMode: false,
};

function ctx(toolName, mode, extra = {}) {
  return { toolName, input: {}, riskLevel: "medium", mode, ...extra };
}

// 每个测试后重置进程地板，防止跨用例泄漏。
function withProcessFloor(floor, fn) {
  setProcessManagedPolicyFloor(floor);
  try {
    return fn();
  } finally {
    resetProcessManagedPolicyFloorForTest();
  }
}

test("(1) process floor reaches defaultPermissionConfig instances (Explore/memory shape)", () => {
  withProcessFloor(FLOOR, () => {
    // 与 subagent.ts / project-memory-agent.ts 完全相同的构造形态。
    const service = new PermissionService(defaultPermissionConfig);
    const denied = service.checkPermission(
      ctx("Bash", "yolo", { input: { command: "curl http://evil.example" } }),
    );
    assert.equal(denied.decision, "deny");
    assert.equal(denied.ruleId, "rule.policy.deny");

    const asked = service.checkPermission(ctx("WebFetch", "yolo"));
    assert.equal(asked.decision, "ask");
    assert.equal(asked.ruleId, "rule.policy.ask");
  });
});

test("(2) disableBypassPermissionsMode via process floor constrains Explore's default yolo", () => {
  withProcessFloor({ ...FLOOR, disableBypassPermissionsMode: true }, () => {
    const service = new PermissionService(defaultPermissionConfig);
    assert.equal(service.isBypassPermissionsModeDisabled(), true);
    // Explore 缺省 yolo + 副作用写入：直通失效，落 build 判定 → ask。
    const decision = service.checkPermission(
      ctx("Write", "yolo", { input: { file_path: "notes.md" } }),
      { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
    );
    assert.equal(decision.decision, "ask");
    assert.notEqual(decision.ruleId, "mode.yolo");
    // 只读工具照常放行（Explore 的本职不受影响）。
    const read = service.checkPermission(ctx("Read", "yolo", { input: { file_path: "a.ts" } }), {
      readOnly: true,
      destructive: false,
      sideEffectScope: "none",
      needsApproval: false,
    });
    assert.equal(read.decision, "allow");
  });
});

test("(3) explicit config.policyFloor wins; reset stops leakage", () => {
  const explicitFloor = {
    deny: [{ toolName: "Task" }],
    ask: [],
    disallowedTools: [],
    disableBypassPermissionsMode: false,
  };
  withProcessFloor(FLOOR, () => {
    const service = new PermissionService({
      ...defaultPermissionConfig,
      policyFloor: explicitFloor,
    });
    // 显式地板的 deny 生效。
    assert.equal(service.checkPermission(ctx("Task", "build")).ruleId, "rule.policy.deny");
    // 进程地板的规则不叠加（显式优先，非并集——单一事实源是显式配置）。
    const bashDecision = service.checkPermission(
      ctx("Bash", "yolo", { input: { command: "curl http://x" } }),
    );
    assert.notEqual(bashDecision.ruleId, "rule.policy.deny");
  });
  // reset 后：无地板进程，defaultPermissionConfig 实例回到改动前行为。
  assert.equal(getProcessManagedPolicyFloor(), undefined);
  const bare = new PermissionService(defaultPermissionConfig);
  assert.equal(bare.checkPermission(ctx("Bash", "yolo", { input: { command: "curl http://x" } })).ruleId, "mode.yolo");
  assert.equal(bare.isBypassPermissionsModeDisabled(), false);
});

test("(4) memory convenience override never undoes security-floor asks", () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-p2-memory-"));
  try {
    const memoryRoot = join(dir, "memory");
    mkdirSync(memoryRoot, { recursive: true });
    const memoryFile = join(memoryRoot, "note.md");
    writeFileSync(memoryFile, "# note\n", "utf-8");
    const base = {
      executionInput: { file_path: memoryFile },
      memoryRoot,
      toolName: "Write",
      workingDirectory: dir,
      workspaceRoot: dir,
    };
    const decisionWith = (ruleId, extra = {}) => ({
      decision: "ask",
      allowed: false,
      escalated: true,
      mode: "build",
      ruleId,
      riskLevel: "medium",
      ...extra,
    });

    // 安全地板类 ask：策略 ask 与熔断器 ask 都必须存活。
    const policyAsk = applyMemoryFilePermission({ ...base, decision: decisionWith("rule.policy.ask") });
    assert.equal(policyAsk.decision, "ask");
    assert.equal(policyAsk.ruleId, "rule.policy.ask");

    const breakerAsk = applyMemoryFilePermission({
      ...base,
      decision: decisionWith("breaker.pathEscapeWrite"),
    });
    assert.equal(breakerAsk.decision, "ask");
    assert.equal(breakerAsk.ruleId, "breaker.pathEscapeWrite");

    // 零回归：模式推导的 ask 对 memory .md 目标仍照常升级 allow。
    const buildAsk = applyMemoryFilePermission({
      ...base,
      decision: decisionWith("mode.build.sideEffect"),
    });
    assert.equal(buildAsk.decision, "allow");
    assert.equal(buildAsk.ruleId, "memory.file.markdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(5) subagent mode ceiling: request cannot escalate to yolo/bypass", () => {
  // 显式全权限档 → 回落父模式（default 分支）。
  assert.equal(resolveSubagentPermissionMode("build", "yolo", false), "build");
  assert.equal(resolveSubagentPermissionMode("edit", "bypassPermissions", false), "edit");
  assert.equal(resolveSubagentPermissionMode("build", "yolo", true), "build");
  // undefined：Explore 缺省 yolo（设计保留），非 Explore 继承父模式。
  assert.equal(resolveSubagentPermissionMode("build", undefined, true), "yolo");
  assert.equal(resolveSubagentPermissionMode("edit", undefined, false), "edit");
  // auto/plan 覆盖照旧（只会更严：auto 当前全拒、plan 只读）。
  assert.equal(resolveSubagentPermissionMode("build", "auto", false), "auto");
  assert.equal(resolveSubagentPermissionMode("build", "plan", false), "plan");
});

test("(6) no floor registered: behavior identical to pre-change", () => {
  resetProcessManagedPolicyFloorForTest();
  const service = new PermissionService(defaultPermissionConfig);
  assert.equal(service.checkPermission(ctx("Bash", "yolo", { input: { command: "ls" } })).ruleId, "mode.yolo");
  assert.equal(service.checkPermission(ctx("WebFetch", "yolo")).ruleId, "mode.yolo");
});
