import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERMISSION_RULE_WHERE_BY_STORAGE,
  permissionRuleStorageKindSchema,
  permissionRuleWhereInfoSchema,
  permissionRuleWhereSchema,
  resolvePermissionRuleWhere,
} from "../src/acode-protocol-v4/permission-rule-where.js";

/**
 * 权限规则 where 三态叶子验收（specs/protocol-attachment-typed-errors.md R6 验收场景 6）。
 * 协议类型只落 informational 面；权威映射与规则枚举在 P1 的 core/src/permission（spec W5）。
 */

test("R6: where 三态闭集；闭集外值拒绝", () => {
  assert.deepEqual(permissionRuleWhereSchema.options, ["persistent", "session", "readonly"]);
  assert.equal(permissionRuleWhereSchema.safeParse("temporary").success, false);
});

test("R6: 映射表覆盖全部存储类别，且与 resolvePermissionRuleWhere 一致", () => {
  for (const storage of permissionRuleStorageKindSchema.options) {
    const where = resolvePermissionRuleWhere(storage);
    assert.equal(where, PERMISSION_RULE_WHERE_BY_STORAGE[storage]);
    assert.ok(permissionRuleWhereSchema.safeParse(where).success);
  }
  // 语义抽查：设置文件 = persistent；会话内存（含 TTL）= session；托管/地板/breaker = readonly。
  assert.equal(resolvePermissionRuleWhere("projectRuleset"), "persistent");
  assert.equal(resolvePermissionRuleWhere("sessionRules"), "session");
  assert.equal(resolvePermissionRuleWhere("policyFloor"), "readonly");
  assert.equal(resolvePermissionRuleWhere("managedPolicy"), "readonly");
  assert.equal(resolvePermissionRuleWhere("breaker"), "readonly");
});

test("R6: 规则回显 strict；rule 原文 VERBATIM（控制字符不被协议层清洗）", () => {
  const info = {
    rule: "Bash(rm\u0000 -rf /tmp/x\u0007)",
    behavior: "deny" as const,
    where: "readonly" as const,
  };
  const parsed = permissionRuleWhereInfoSchema.safeParse(info);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.rule, info.rule, "协议层不得转义/清洗——显示层责任");
  }
  assert.equal(
    permissionRuleWhereInfoSchema.safeParse({ ...info, source: "policySettings" }).success,
    false,
    "strict：未知键拒绝",
  );
});

test("R6: notInEffect=true 必须 readonly（managed pin 的行不可编辑）", () => {
  assert.equal(
    permissionRuleWhereInfoSchema.safeParse({
      rule: "Bash(npm run *)",
      behavior: "allow",
      where: "readonly",
      notInEffect: true,
    }).success,
    true,
  );
  const violation = permissionRuleWhereInfoSchema.safeParse({
    rule: "Bash(npm run *)",
    behavior: "allow",
    where: "persistent",
    notInEffect: true,
  });
  assert.equal(violation.success, false);
  // notInEffect 缺席/false 不受限。
  assert.equal(
    permissionRuleWhereInfoSchema.safeParse({
      rule: "Read(/x)",
      behavior: "allow",
      where: "persistent",
      notInEffect: false,
    }).success,
    true,
  );
});
