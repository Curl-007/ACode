import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Bot 任务权限「需本机确认」门槛测试（安全加固 P2 / P0-3 诚实边界）。
 *
 * 覆盖 packages/services/specs/bot-permission-local-approval.md R2.3（门槛 = 用户设置 ∨
 * 管理员策略地板 ∨ 策略损坏 fail-closed）与 R2.5（新文案 keys 双语齐备）。
 */

const {
  resolveBotPermissionLocalApprovalRequired,
  readBotPermissionLocalApprovalGate,
} = await import("../src/bots/botPermissionLocalApproval.ts");
const { formatBotMessage } = await import("../src/bots/messages.ts");

// managed 输入只需 status + policy?.requireLocalPermissionApproval（判定面）。
const missing = { status: "missing" };
const empty = { status: "empty" };
const invalid = { status: "invalid" };
const okWith = (requireLocalPermissionApproval) => ({
  status: "ok",
  policy: {
    deny: [],
    ask: [],
    disallowedTools: [],
    disableBypassPermissionsMode: false,
    requireLocalPermissionApproval,
  },
});

test("settings off + no policy → gate off (default behavior unchanged)", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: false, managed: missing }),
    false,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: undefined, managed: empty }),
    false,
  );
});

test("settings on → gate on regardless of policy", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: true, managed: missing }),
    true,
  );
  // 用户开启压过 policy 未要求（∨ 语义）。
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: true, managed: okWith(false) }),
    true,
  );
});

test("invalid policy fails closed → gate on", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: false, managed: invalid }),
    true,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: undefined, managed: invalid }),
    true,
  );
});

test("admin floor requireLocalPermissionApproval forces gate on; user setting cannot relax it", () => {
  // strictest-wins：用户设置关，但管理员地板要求 → 仍开启。
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: false, managed: okWith(true) }),
    true,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: undefined, managed: okWith(true) }),
    true,
  );
});

test("admin floor without the key → gate follows user setting only", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: false, managed: okWith(false) }),
    false,
  );
});

test("IO wrapper combines injected settings + managed policy", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => ({ botPermissionLocalApprovalEnabled: true }),
      loadManaged: () => missing,
    }),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => ({ botPermissionLocalApprovalEnabled: false }),
      loadManaged: () => okWith(true),
    }),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => ({ botPermissionLocalApprovalEnabled: false }),
      loadManaged: () => okWith(false),
    }),
    false,
  );
});

test("IO wrapper fails closed on invalid policy and tolerates missing settings reader", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => null,
      loadManaged: () => invalid,
    }),
    true,
  );
  // 没有 settingService（getSettings 缺省）也不抛错，按 managed 判定。
  assert.equal(
    await readBotPermissionLocalApprovalGate({ loadManaged: () => empty }),
    false,
  );
});

test("IO wrapper swallows settings read errors (fail-soft to policy)", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => {
        throw new Error("settings unavailable");
      },
      loadManaged: () => okWith(true),
    }),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate({
      getSettings: async () => {
        throw new Error("settings unavailable");
      },
      loadManaged: () => missing,
    }),
    false,
  );
});

test("new bot message keys exist in both locales and render", () => {
  // formatBotMessage 缺 key 会因 undefined.replaceAll 抛错，故渲染成功即证明双语目录都补齐了。
  for (const locale of ["zh-CN", "en-US"]) {
    const awaiting = formatBotMessage(locale, "permissionAwaitingDesktopApproval");
    const required = formatBotMessage(locale, "permissionLocalApprovalRequired");
    assert.ok(awaiting.length > 0, `${locale} awaiting renders`);
    assert.ok(required.length > 0, `${locale} required renders`);
  }
});
