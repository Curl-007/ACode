import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Managed Policy 每键元数据三字段试点测试（T2-s5② 先行件）。
 *
 * 覆盖 packages/shared/specs/managed-policy-key-metadata.md 验收场景 1/3/4/5：
 * 注册表完整性（与实际 wire 键集双向对账）、三字段闭集、冻结不变量、
 * warn 谓词语义（只复述既有 hasContent 语义）、访问器边界（含原型链键）、
 * 既有消费路径回归（policy wire 形态不混入元数据）。
 * 验收场景 2（类型约束：新增键未补元数据即 typecheck 报错）由全覆盖映射
 * `ManagedPolicyKeyMetadataRegistry` + tsc 保证，运行时不重复校验。
 *
 * 仅用 mkdtemp 临时目录 + env 覆盖，绝不触碰真实 OS 托管路径。
 */

const {
  loadManagedPolicyFile,
  ACODE_MANAGED_POLICY_FILE_ENV,
  MANAGED_POLICY_KEY_METADATA,
  getManagedPolicyKeyMetadata,
} = await import("../src/node/managedPolicy.ts");

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-managed-policy-meta-"));
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

// spec R2 的两个闭集；测试独立手写一份，注册表若被扩/改值这里必须同步（漂移即失败）。
const REDACT_MODES = new Set(["hash", "keep"]);
const CONSUMER_SCOPES = new Set(["cli-permission-floor", "host-bot-permission"]);

test("registry keys match the actual policy wire keys in both directions", async () => {
  await withTempDir(async (dir) => {
    // 五键全部署，status=ok 的 policy 键集就是 wire 事实源（spec 验收场景 1）。
    const filePath = writePolicy(dir, {
      permissions: {
        deny: [{ toolName: "Bash" }],
        ask: [{ toolName: "WebFetch" }],
        disallowedTools: ["Task"],
        disableBypassPermissionsMode: true,
        requireLocalPermissionApproval: true,
      },
    });
    const result = loadFrom(filePath);
    assert.equal(result.status, "ok");
    const wireKeys = Object.keys(result.policy).sort();
    const registryKeys = Object.keys(MANAGED_POLICY_KEY_METADATA).sort();
    assert.deepEqual(registryKeys, wireKeys);
  });
});

test("every key carries the three metadata fields with closed-set values", () => {
  for (const [key, metadata] of Object.entries(MANAGED_POLICY_KEY_METADATA)) {
    assert.ok(REDACT_MODES.has(metadata.redact), `${key}.redact 越出闭集`);
    assert.ok(Array.isArray(metadata.support?.scopes), `${key}.support.scopes 缺失`);
    assert.ok(metadata.support.scopes.length > 0, `${key}.support.scopes 为空`);
    for (const scope of metadata.support.scopes) {
      assert.ok(CONSUMER_SCOPES.has(scope), `${key} scope "${scope}" 越出闭集`);
    }
    assert.equal(typeof metadata.predicates?.warn, "function", `${key}.predicates.warn 缺失`);
  }
});

test("per-key metadata matches the spec R3 table", () => {
  // 规则/工具名可含内部工具名 → hash；布尔无敏感内容 → keep。
  for (const key of ["deny", "ask", "disallowedTools"]) {
    assert.equal(MANAGED_POLICY_KEY_METADATA[key].redact, "hash", `${key}.redact`);
    assert.deepEqual([...MANAGED_POLICY_KEY_METADATA[key].support.scopes], [
      "cli-permission-floor",
    ]);
  }
  assert.equal(MANAGED_POLICY_KEY_METADATA.disableBypassPermissionsMode.redact, "keep");
  assert.deepEqual(
    [...MANAGED_POLICY_KEY_METADATA.disableBypassPermissionsMode.support.scopes],
    ["cli-permission-floor"],
  );
  // requireLocalPermissionApproval 仅 host 消费（CLI 接受但忽略、不进 floor）。
  assert.equal(MANAGED_POLICY_KEY_METADATA.requireLocalPermissionApproval.redact, "keep");
  assert.deepEqual(
    [...MANAGED_POLICY_KEY_METADATA.requireLocalPermissionApproval.support.scopes],
    ["host-bot-permission"],
  );
});

test("registry, entries, support and predicates are all frozen", () => {
  assert.ok(Object.isFrozen(MANAGED_POLICY_KEY_METADATA));
  for (const metadata of Object.values(MANAGED_POLICY_KEY_METADATA)) {
    assert.ok(Object.isFrozen(metadata));
    assert.ok(Object.isFrozen(metadata.support));
    assert.ok(Object.isFrozen(metadata.support.scopes));
    assert.ok(Object.isFrozen(metadata.predicates));
  }
});

test("accessor returns the registry entry for closed-set keys", () => {
  assert.equal(getManagedPolicyKeyMetadata("deny"), MANAGED_POLICY_KEY_METADATA.deny);
  assert.equal(
    getManagedPolicyKeyMetadata("requireLocalPermissionApproval"),
    MANAGED_POLICY_KEY_METADATA.requireLocalPermissionApproval,
  );
});

test("accessor returns undefined (not throw) for keys outside the closed set", () => {
  // 放宽键与未知键不存在于注册表；原型链键也必须落在 undefined 分支（hasOwn 判定）。
  for (const key of ["allow", "permissions", "toString", "__proto__", "constructor", ""]) {
    assert.equal(getManagedPolicyKeyMetadata(key), undefined, `key "${key}" 应返回 undefined`);
  }
});

test("warn fires only on deployed-but-no-effect values and names the key path", async () => {
  await withTempDir(async (dir) => {
    const filePath = writePolicy(dir, {
      permissions: {
        deny: [{ toolName: "Bash", ruleContent: "SecretInternalPattern" }],
        requireLocalPermissionApproval: true,
      },
    });
    const result = loadFrom(filePath);
    assert.equal(result.status, "ok");
    const policy = result.policy;

    // 列表键：非空 → 无警告；空数组 → 警告（等同未部署，只收紧不放宽）。
    const denyWarn = getManagedPolicyKeyMetadata("deny").predicates.warn;
    assert.equal(denyWarn(policy.deny, policy), undefined);
    const denyMessage = denyWarn(Object.freeze([]), policy);
    assert.equal(typeof denyMessage, "string");
    assert.ok(denyMessage.includes("permissions.deny"));
    // 警告文案不回显任何规则内容（与 redact:"hash" 同一纪律）。
    assert.ok(!denyMessage.includes("SecretInternalPattern"));
    for (const key of ["ask", "disallowedTools"]) {
      const warn = getManagedPolicyKeyMetadata(key).predicates.warn;
      assert.equal(warn(policy.deny, policy), undefined, `${key} 非空列表不应警告`);
      assert.ok(warn(Object.freeze([]), policy).includes(`permissions.${key}`));
    }

    // 布尔键：true → 无警告；显式 false → 警告（无放宽效果，等同未部署）。
    for (const key of ["disableBypassPermissionsMode", "requireLocalPermissionApproval"]) {
      const warn = getManagedPolicyKeyMetadata(key).predicates.warn;
      assert.equal(warn(true, policy), undefined, `${key}=true 不应警告`);
      const message = warn(false, policy);
      assert.equal(typeof message, "string");
      assert.ok(message.includes(`permissions.${key}`));
    }

    // 纯函数：重复求值一致；冻结入参不抛（无副作用）。
    assert.equal(denyWarn(Object.freeze([]), policy), denyMessage);
    assert.doesNotThrow(() => denyWarn(Object.freeze([]), Object.freeze(policy)));
  });
});

test("existing consumer wire shape is unchanged: no metadata leaks into results", async () => {
  await withTempDir(async (dir) => {
    // 消费方（services botPermissionLocalApproval / CLI adapters floor 映射）按
    // status/filePath/policy/invalidKind 判别；试点不得混入新字段（spec R5）。
    const okPath = writePolicy(dir, { permissions: { disallowedTools: ["Bash"] } });
    const ok = loadFrom(okPath);
    assert.deepEqual(Object.keys(ok).sort(), ["filePath", "policy", "status"]);
    assert.deepEqual(Object.keys(ok.policy).sort(), [
      "ask",
      "deny",
      "disableBypassPermissionsMode",
      "disallowedTools",
      "requireLocalPermissionApproval",
    ]);

    const invalidPath = writePolicy(dir, "{ not json ");
    const invalid = loadFrom(invalidPath);
    assert.deepEqual(Object.keys(invalid).sort(), [
      "filePath",
      "invalidKind",
      "invalidReason",
      "status",
    ]);

    const missing = loadFrom(join(dir, "absent.json"));
    assert.deepEqual(Object.keys(missing).sort(), ["filePath", "status"]);
  });
});
