import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * AppSettings 新字段 botPermissionLocalApprovalEnabled 的 schema 契约测试。
 * 覆盖 packages/services/specs/bot-permission-local-approval.md R2.1：
 * 主 schema 默认 false（门槛默认关，零行为变更），patch schema 可选接受。
 */

const { appSettingsSchema, appSettingsPatchSchema } = await import(
  "../src/validationAppSettings.ts"
);

test("botPermissionLocalApprovalEnabled defaults to false in the full settings schema", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.botPermissionLocalApprovalEnabled, false);
});

test("botPermissionLocalApprovalEnabled can be enabled in the full settings schema", () => {
  const parsed = appSettingsSchema.parse({ botPermissionLocalApprovalEnabled: true });
  assert.equal(parsed.botPermissionLocalApprovalEnabled, true);
});

test("patch schema accepts the field and treats it as optional", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ botPermissionLocalApprovalEnabled: true })
      .botPermissionLocalApprovalEnabled,
    true,
  );
  // 缺省时 patch 不应注入该键（保持「未提供=不改动」语义）。
  const empty = appSettingsPatchSchema.parse({});
  assert.equal("botPermissionLocalApprovalEnabled" in empty, false);
});

test("patch schema rejects non-boolean values", () => {
  assert.equal(
    appSettingsPatchSchema.safeParse({ botPermissionLocalApprovalEnabled: "yes" }).success,
    false,
  );
});
