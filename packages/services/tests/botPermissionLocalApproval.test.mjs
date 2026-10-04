import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Bot 任务权限「需本机确认」门槛测试（安全加固 P2 / P0-3 诚实边界 + 批次 4 R2.7 风险分层）。
 *
 * 覆盖 packages/services/specs/bot-permission-local-approval.md R2.3（门槛 = 用户设置 ∨
 * 管理员策略地板 ∨ 策略损坏 fail-closed ∨ 风险分层）、R2.7（high/critical 或缺失 riskLevel
 * 恒需本机批准，用户设置不可放宽）与 R2.5（文案 keys 双语齐备）。
 *
 * 语义说明：判定是**按请求**的——R2.7 后缺省 requestRiskLevel（undefined）即 fail-closed
 * 视为 high，因此隔离全局维度（设置/策略）的用例显式传 "low"。
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

// ── 全局维度（用 low 请求隔离：风险分层不触发）──────────────────────────

test("settings off + no policy + low risk → gate off (default behavior unchanged)", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: false,
      managed: missing,
      requestRiskLevel: "low",
    }),
    false,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: undefined,
      managed: empty,
      requestRiskLevel: "low",
    }),
    false,
  );
});

test("settings on → gate on regardless of policy and risk", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: true,
      managed: missing,
      requestRiskLevel: "low",
    }),
    true,
  );
  // 用户开启压过 policy 未要求（∨ 语义）。
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: true,
      managed: okWith(false),
      requestRiskLevel: "medium",
    }),
    true,
  );
});

test("invalid policy fails closed → gate on", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: false,
      managed: invalid,
      requestRiskLevel: "low",
    }),
    true,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: undefined,
      managed: invalid,
      requestRiskLevel: "low",
    }),
    true,
  );
});

test("admin floor requireLocalPermissionApproval forces gate on; user setting cannot relax it", () => {
  // strictest-wins：用户设置关，但管理员地板要求 → 仍开启。
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: false,
      managed: okWith(true),
      requestRiskLevel: "low",
    }),
    true,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: undefined,
      managed: okWith(true),
      requestRiskLevel: "low",
    }),
    true,
  );
});

test("admin floor without the key → gate follows user setting only", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: false,
      managed: okWith(false),
      requestRiskLevel: "low",
    }),
    false,
  );
});

// ── R2.7 风险分层维度 ─────────────────────────────────────────────────

test("R2.7: high/critical require local approval even with settings off and no policy", () => {
  for (const requestRiskLevel of ["high", "critical"]) {
    assert.equal(
      resolveBotPermissionLocalApprovalRequired({
        settingsEnabled: false,
        managed: missing,
        requestRiskLevel,
      }),
      true,
      `${requestRiskLevel} must be local-approval-only`,
    );
  }
});

test("R2.7: low/medium keep chat approval when global gate off", () => {
  for (const requestRiskLevel of ["low", "medium"]) {
    assert.equal(
      resolveBotPermissionLocalApprovalRequired({
        settingsEnabled: false,
        managed: missing,
        requestRiskLevel,
      }),
      false,
      `${requestRiskLevel} must stay chat-approvable by default`,
    );
  }
});

test("R2.7: missing riskLevel fails closed (skew tolerance for old events/persisted options)", () => {
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({ settingsEnabled: false, managed: missing }),
    true,
  );
  assert.equal(
    resolveBotPermissionLocalApprovalRequired({
      settingsEnabled: false,
      managed: missing,
      requestRiskLevel: undefined,
    }),
    true,
  );
});

// ── IO 包装 ───────────────────────────────────────────────────────────

test("IO wrapper combines injected settings + managed policy + risk tier", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => ({ botPermissionLocalApprovalEnabled: true }),
        loadManaged: () => missing,
      },
      "low",
    ),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => ({ botPermissionLocalApprovalEnabled: false }),
        loadManaged: () => okWith(true),
      },
      "low",
    ),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => ({ botPermissionLocalApprovalEnabled: false }),
        loadManaged: () => okWith(false),
      },
      "low",
    ),
    false,
  );
  // 风险分层经第二参透传：全局全关时 high 仍要求本机批准。
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => ({ botPermissionLocalApprovalEnabled: false }),
        loadManaged: () => missing,
      },
      "high",
    ),
    true,
  );
});

test("IO wrapper fails closed on invalid policy and tolerates missing settings reader", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => null,
        loadManaged: () => invalid,
      },
      "low",
    ),
    true,
  );
  // 没有 settingService（getSettings 缺省）也不抛错，按 managed + 风险档判定。
  assert.equal(
    await readBotPermissionLocalApprovalGate({ loadManaged: () => empty }, "low"),
    false,
  );
  // 缺省风险档（旧调用面/偏斜）fail-closed。
  assert.equal(
    await readBotPermissionLocalApprovalGate({ loadManaged: () => empty }),
    true,
  );
});

test("IO wrapper swallows settings read errors (fail-soft to policy)", async () => {
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => {
          throw new Error("settings unavailable");
        },
        loadManaged: () => okWith(true),
      },
      "low",
    ),
    true,
  );
  assert.equal(
    await readBotPermissionLocalApprovalGate(
      {
        getSettings: async () => {
          throw new Error("settings unavailable");
        },
        loadManaged: () => missing,
      },
      "low",
    ),
    false,
  );
});

// ── R2.5 文案 ─────────────────────────────────────────────────────────

test("new bot message keys exist in both locales and render", () => {
  // formatBotMessage 缺 key 会因 undefined.replaceAll 抛错，故渲染成功即证明双语目录都补齐了。
  for (const locale of ["zh-CN", "en-US"]) {
    const awaiting = formatBotMessage(locale, "permissionAwaitingDesktopApproval");
    const required = formatBotMessage(locale, "permissionLocalApprovalRequired");
    assert.ok(awaiting.length > 0, `${locale} awaiting renders`);
    assert.ok(required.length > 0, `${locale} required renders`);
  }
});
