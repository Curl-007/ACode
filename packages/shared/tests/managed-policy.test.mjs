import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Managed Policy 单一来源加载器测试（安全加固 P2 / R3.1）。
 *
 * 覆盖 packages/services/specs/bot-permission-local-approval.md R3 与
 * apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R1：
 * canonical schema、strict 拒绝、判别式结果（missing/invalid/empty/ok）、
 * 新增可选收紧键 requireLocalPermissionApproval、OS 路径解析与打包态 env 门禁。
 *
 * 仅用 mkdtemp 临时目录 + env 覆盖，绝不触碰真实 OS 托管路径。
 */

const { loadManagedPolicyFile, resolveManagedPolicyFilePath, ACODE_MANAGED_POLICY_FILE_ENV } =
  await import("../src/node/managedPolicy.ts");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-managed-policy-"));
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
  return loadManagedPolicyFile({ env: { [ACODE_MANAGED_POLICY_FILE_ENV]: filePath }, ...extra });
}

test("missing file reports status=missing with no policy", async () => {
  await withTempDir(async (dir) => {
    const result = loadFrom(join(dir, "absent.json"));
    assert.equal(result.status, "missing");
    assert.equal(result.policy, undefined);
    assert.equal(result.invalidKind, undefined);
  });
});

test("empty permissions object reports status=empty (treated as not deployed)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { schemaVersion: 1, permissions: {} });
    const result = loadFrom(filePath);
    assert.equal(result.status, "empty");
    assert.equal(result.policy, undefined);
  });
});

test("valid tightening policy reports status=ok with frozen policy data", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      schemaVersion: 1,
      permissions: {
        deny: [{ toolName: "Bash", ruleContent: "rm -rf *" }],
        disallowedTools: ["WebFetch"],
        disableBypassPermissionsMode: true,
      },
    });
    const result = loadFrom(filePath);
    assert.equal(result.status, "ok");
    assert.equal(result.policy.deny.length, 1);
    assert.equal(result.policy.deny[0].toolName, "Bash");
    assert.deepEqual(result.policy.disallowedTools, ["WebFetch"]);
    assert.equal(result.policy.disableBypassPermissionsMode, true);
    assert.equal(result.policy.requireLocalPermissionApproval, false);
  });
});

test("requireLocalPermissionApproval alone counts as content (status=ok)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      permissions: { requireLocalPermissionApproval: true },
    });
    const result = loadFrom(filePath);
    assert.equal(result.status, "ok");
    assert.equal(result.policy.requireLocalPermissionApproval, true);
    // CLI-only fields default to empty/false so the host gate can read this key in isolation.
    assert.deepEqual(result.policy.deny, []);
    assert.equal(result.policy.disableBypassPermissionsMode, false);
  });
});

test("requireLocalPermissionApproval=false with no other content is empty", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      permissions: { requireLocalPermissionApproval: false },
    });
    assert.equal(loadFrom(filePath).status, "empty");
  });
});

test("allow-style key is rejected (status=invalid, schema kind)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { permissions: { allow: [{ toolName: "Bash" }] } });
    const result = loadFrom(filePath);
    assert.equal(result.status, "invalid");
    assert.equal(result.invalidKind, "schema");
    assert.equal(result.policy, undefined);
    assert.ok(result.invalidReason && result.invalidReason.length > 0);
  });
});

test("unknown top-level key is rejected (strict schema)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { permissions: { deny: [] }, surprise: 1 });
    const result = loadFrom(filePath);
    assert.equal(result.status, "invalid");
    assert.equal(result.invalidKind, "schema");
  });
});

test("malformed JSON reports status=invalid with json kind", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, "{ not json ");
    const result = loadFrom(filePath);
    assert.equal(result.status, "invalid");
    assert.equal(result.invalidKind, "json");
  });
});

test("invalid reason never echoes file content for schema failures", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { permissions: { allow: [{ toolName: "SecretInternalTool" }] } });
    const result = loadFrom(filePath);
    assert.equal(result.status, "invalid");
    // schema issue text names the offending path, not the rejected value's payload.
    assert.ok(!result.invalidReason.includes("SecretInternalTool"));
  });
});

test("path resolution honors platform defaults and env override", () => {
  assert.equal(
    resolveManagedPolicyFilePath({ platform: "win32", env: { ProgramData: "D:\\PD" } }),
    join("D:\\PD", "ACode", "managed-settings.json"),
  );
  assert.equal(
    resolveManagedPolicyFilePath({ platform: "darwin", env: {} }),
    "/Library/Application Support/ACode/managed-settings.json",
  );
  assert.equal(
    resolveManagedPolicyFilePath({ platform: "linux", env: {} }),
    "/etc/acode/managed-settings.json",
  );
  assert.equal(
    resolveManagedPolicyFilePath({ env: { [ACODE_MANAGED_POLICY_FILE_ENV]: "/tmp/x.json" } }),
    "/tmp/x.json",
  );
});

test("packaged runtime ignores env override (P1-7 philosophy)", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, { permissions: { disallowedTools: ["Bash"] } });
    const packaged = loadManagedPolicyFile({
      env: { [ACODE_MANAGED_POLICY_FILE_ENV]: filePath },
      isPackaged: true,
      platform: "linux",
    });
    // packaged 落到 /etc/acode/... 而非 env 注入路径；测试机上该路径不存在 → missing。
    assert.equal(packaged.filePath, "/etc/acode/managed-settings.json");
    assert.notEqual(packaged.filePath, filePath);
  });
});
