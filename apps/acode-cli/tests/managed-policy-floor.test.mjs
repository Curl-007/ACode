import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P2 的验收测试：托管策略地板（managed policy floor, strictest-wins）。
 *
 * 覆盖规格 apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md
 * 的 R1/R3 与验收场景 1–7。仅用 mkdtemp 临时目录 + ACODE_MANAGED_POLICY_FILE 覆盖，
 * 绝不触碰真实 OS 托管路径。
 */

const { loadManagedPolicyFloor } = await import(
  "../packages/adapters/src/config/managed-policy.ts"
);
const { mergeConfigs, createPrioritizedConfig } = await import(
  "../packages/adapters/src/config/config-merger.ts"
);
const { ConfigScope } = await import("../packages/contracts/src/index.ts");
const { PermissionService } = await import("../packages/core/src/permission/service.ts");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-p2-policy-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePolicy(dir, content) {
  const filePath = join(dir, "managed-settings.json");
  writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return filePath;
}

function loadFrom(filePath, extra = {}) {
  return loadManagedPolicyFloor({
    env: { ACODE_MANAGED_POLICY_FILE: filePath },
    ...extra,
  });
}

test("(1) no policy file: floor is undefined and nothing changes", async () => {
  await withTempDir(async (dir) => {
    const result = loadManagedPolicyFloor({
      env: { ACODE_MANAGED_POLICY_FILE: join(dir, "missing.json") },
    });
    assert.equal(result.floor, undefined);
    assert.deepEqual(result.diagnostics, []);
  });
});

test("(2) valid policy parses into a tightening-only floor", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      schemaVersion: 1,
      permissions: {
        deny: [{ toolName: "Bash", ruleContent: "curl:*" }],
        ask: [{ toolName: "WebFetch" }],
        disallowedTools: ["Task"],
        disableBypassPermissionsMode: true,
      },
    });
    const { floor, diagnostics } = loadFrom(filePath);
    assert.deepEqual(diagnostics, []);
    assert.ok(floor);
    assert.deepEqual(floor.deny, [{ toolName: "Bash", ruleContent: "curl:*" }]);
    assert.deepEqual(floor.ask, [{ toolName: "WebFetch" }]);
    assert.deepEqual(floor.disallowedTools, ["Task"]);
    assert.equal(floor.disableBypassPermissionsMode, true);
  });
});

test("(3) empty policy file behaves as not deployed", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { schemaVersion: 1, permissions: {} });
    const { floor, diagnostics } = loadFrom(filePath);
    assert.equal(floor, undefined, "empty policy must not create a Policy merge source");
    assert.deepEqual(diagnostics, []);
  });
});

test("(4) allow-style or unknown keys are rejected, not silently dropped", async () => {
  await withTempDir(async (dir) => {
    // allow 类键：策略地板永远不能成为放宽通道。
    const allowPath = writePolicy(dir, { permissions: { allow: [{ toolName: "Bash" }] } });
    const allowResult = loadFrom(allowPath);
    assert.ok(allowResult.floor, "invalid policy must fail closed, not be ignored");
    assert.equal(allowResult.floor.disableBypassPermissionsMode, true, "minimal lockdown expected");
    assert.equal(allowResult.diagnostics.length, 1);
    assert.equal(allowResult.diagnostics[0].code, "config_managed_policy_invalid");
    assert.equal(allowResult.diagnostics[0].severity, "error");

    // 未知键同样拒绝（strict schema）。
    const unknownPath = writePolicy(dir, { permissions: { deny: [], surprise: true } });
    const unknownResult = loadFrom(unknownPath);
    assert.equal(unknownResult.floor.disableBypassPermissionsMode, true);
    assert.equal(unknownResult.diagnostics[0].code, "config_managed_policy_invalid");
  });
});

test("(5) malformed JSON fails closed to minimal lockdown", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, "{ not json");
    const { floor, diagnostics } = loadFrom(filePath);
    assert.equal(floor.disableBypassPermissionsMode, true);
    assert.deepEqual(floor.deny, []);
    assert.equal(diagnostics[0].code, "config_managed_policy_invalid");
  });
});

test("(6) packaged runtime ignores the env override (P1-7 philosophy)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      permissions: { disallowedTools: ["Bash"], disableBypassPermissionsMode: true },
    });
    // 非打包态：env 覆盖生效。
    assert.ok(loadFrom(filePath).floor);
    // 打包态：同一 env 指向被忽略，回落 OS 托管路径（测试机上不存在）→ 无地板。
    const packaged = loadManagedPolicyFloor({
      env: { ACODE_MANAGED_POLICY_FILE: filePath },
      isPackaged: true,
      // 显式给一个必然不存在的平台路径，避免测试机恰好在 /etc/acode 放了文件。
      platform: "linux",
    });
    assert.equal(packaged.floor, undefined, "packaged runtime must not honor user-space env");
    assert.equal(packaged.filePath, "/etc/acode/managed-settings.json");
  });
});

test("(7) merge: policy unions disallowedTools and never wipes inherited permission fields", () => {
  // A. User → Policy（无 Project 层）：稀疏的 Policy 补丁不得抹掉继承的 mode/allowedTools。
  const userThenPolicy = mergeConfigs(
    createPrioritizedConfig(
      {
        permission: {
          mode: "build",
          allowedTools: ["Read"],
          disallowedTools: ["user-banned"],
          autoApproveHighRisk: false,
          allowMediumRiskInAuto: false,
        },
      },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      {
        permission: {
          disallowedTools: ["policy-banned"],
          policy: {
            deny: [],
            ask: [],
            disallowedTools: ["policy-banned"],
            disableBypassPermissionsMode: true,
          },
        },
      },
      ConfigScope.Policy,
    ),
  );
  assert.equal(userThenPolicy.permission.mode, "build", "policy patch must preserve mode");
  assert.deepEqual(userThenPolicy.permission.allowedTools, ["Read"]);
  assert.deepEqual(userThenPolicy.permission.disallowedTools, ["user-banned", "policy-banned"]);
  assert.equal(userThenPolicy.permission.policy.disableBypassPermissionsMode, true);

  // B. 三层并集：strictest-wins，任何一层都清不掉其它层的禁用项。
  const merged = mergeConfigs(
    createPrioritizedConfig(
      { permission: { disallowedTools: ["user-banned"] } },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      { permission: { disallowedTools: ["project-banned"] } },
      ConfigScope.Project,
    ),
    createPrioritizedConfig(
      {
        permission: {
          disallowedTools: ["policy-banned"],
          policy: { deny: [], ask: [], disallowedTools: ["policy-banned"], disableBypassPermissionsMode: false },
        },
      },
      ConfigScope.Policy,
    ),
  );
  assert.deepEqual(
    [...merged.permission.disallowedTools].sort(),
    ["policy-banned", "project-banned", "user-banned"].sort(),
  );
  assert.ok(merged.permission.policy, "policy floor must survive the merge into RuntimeConfig");
});

// ── PermissionService 决策层（R3 优先级） ─────────────────────────────

function makeService(policyFloor, overrides = {}) {
  return new PermissionService({
    allowedTools: new Set(overrides.allowedTools ?? []),
    disallowedTools: new Set(overrides.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(policyFloor ? { policyFloor } : {}),
  });
}

function ctx(toolName, mode, extra = {}) {
  return { toolName, input: {}, riskLevel: "medium", mode, ...extra };
}

const NO_FLOOR = undefined;
const FLOOR = {
  deny: [{ toolName: "Bash", ruleContent: "curl:*" }],
  ask: [{ toolName: "WebFetch" }],
  disallowedTools: [],
  disableBypassPermissionsMode: false,
};

test("(8) policy deny beats yolo, project allow and allowedTools", () => {
  const service = makeService(FLOOR, { allowedTools: ["Bash"] });
  const decision = service.checkPermission(
    ctx("Bash", "yolo", { input: { command: "curl http://evil.example" } }),
    undefined,
    { version: 1, allow: [{ toolName: "Bash" }] },
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.policy.deny");
});

test("(9) policy ask still asks under yolo", () => {
  const service = makeService(FLOOR);
  const decision = service.checkPermission(ctx("WebFetch", "yolo"));
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "rule.policy.ask");
});

test("(10) disableBypassPermissionsMode: yolo no longer fast-allows side effects", () => {
  const service = makeService({ ...FLOOR, disableBypassPermissionsMode: true });
  // 有副作用的写入在 yolo 下落到 build 判定 → ask，而不是 mode.yolo 直通。
  const decision = service.checkPermission(
    ctx("Write", "yolo", { input: { file_path: "inside.txt" } }),
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.equal(decision.decision, "ask");
  assert.notEqual(decision.ruleId, "mode.yolo");
});

test("(10b) without the policy flag yolo still fast-allows the same call", () => {
  const service = makeService(NO_FLOOR);
  const decision = service.checkPermission(
    ctx("Write", "yolo", { input: { file_path: "inside.txt" } }),
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("(11) disallowedTools now denies under yolo (R3 step 2 tightening)", () => {
  const service = makeService(NO_FLOOR, { disallowedTools: ["Bash"] });
  const decision = service.checkPermission(ctx("Bash", "yolo", { input: { command: "ls" } }));
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("(12) no policy floor: yolo behaves exactly as before", () => {
  const service = makeService(NO_FLOOR);
  assert.equal(service.checkPermission(ctx("Bash", "yolo", { input: { command: "ls" } })).ruleId, "mode.yolo");
  assert.equal(service.isBypassPermissionsModeDisabled(), false);
  const withFloor = makeService({ ...FLOOR, disableBypassPermissionsMode: true });
  assert.equal(withFloor.isBypassPermissionsModeDisabled(), true);
});
