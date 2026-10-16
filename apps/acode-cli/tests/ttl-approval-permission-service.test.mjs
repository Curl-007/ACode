import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * TTL 持久授权 × PermissionService 挂接（specs/mcp-lifecycle-ttl-approval.md R4）
 * 验收测试：TTL allow 命中与过期回落 ask、策略地板压制 TTL、显式 ask 规则使
 * 已记住的 always-allow（会话 + TTL）失效、grantSessionPermission 的 TTL 分流。
 */

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const { TtlApprovalStore } = await import("../packages/core/src/permission/ttl-approvals.ts");

const DAY_MS = 86_400_000;
const TOOL = "mcp__srv__send_message";

function baseConfig(overrides = {}) {
  return {
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...overrides,
  };
}

/** MCP 写工具形态：needsApproval + network 副作用 → build 模式缺省 ask。 */
function mcpWriteCapability(overrides = {}) {
  return {
    readOnly: false,
    destructive: false,
    needsApproval: true,
    sideEffectScope: "network",
    riskLevel: "medium",
    permission: "mcp",
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    toolName: TOOL,
    input: {},
    riskLevel: "medium",
    mode: "build",
    ...overrides,
  };
}

async function withStore(fn, storeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acode-ttl-service-"));
  try {
    const state = { now: 1_700_000_000_000 };
    const store = await TtlApprovalStore.create({
      filePath: join(dir, "ttl-approvals.json"),
      now: () => state.now,
      ...storeOptions,
    });
    return await fn({ store, state, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("TTL 授权命中给 rule.ttl.allow；无授权维持 ask（零行为变化）", async () => {
  await withStore(async ({ store }) => {
    const plain = new PermissionService(baseConfig());
    const baseline = plain.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(baseline.decision, "ask", "无 TTL 存储时维持既有 sideEffect ask");

    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 1 });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    const decision = service.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(decision.decision, "allow");
    assert.equal(decision.ruleId, "rule.ttl.allow");
  });
});

test("过期回落 ask：授权到期后同一判定回到原 ask 分支", async () => {
  await withStore(async ({ store, state }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 3 });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    assert.equal(service.checkPermission(makeContext(), mcpWriteCapability()).ruleId, "rule.ttl.allow");

    state.now += 3 * DAY_MS + 1;
    const expired = service.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(expired.decision, "ask");
    assert.equal(expired.ruleId, "mode.build.sideEffect", "过期即回落，不存在第三种状态");
  });
});

test("策略地板压制 TTL：policy ask 托底、policy deny 绝对最高", async () => {
  await withStore(async ({ store }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 1 });
    const floor = (ask, deny) => ({
      deny,
      ask,
      disallowedTools: [],
      disableBypassPermissionsMode: false,
    });

    const askService = new PermissionService(
      baseConfig({ ttlApprovals: store, policyFloor: floor([{ toolName: TOOL }], []) }),
    );
    const askDecision = askService.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(askDecision.decision, "ask");
    assert.equal(askDecision.ruleId, "rule.policy.ask", "策略地板优先于 TTL 授权");

    const denyService = new PermissionService(
      baseConfig({ ttlApprovals: store, policyFloor: floor([], [{ toolName: TOOL }]) }),
    );
    const denyDecision = denyService.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(denyDecision.decision, "deny");
    assert.equal(denyDecision.ruleId, "rule.policy.deny");
  });
});

test("进程级策略地板同样压制 TTL（Explore/子代理缺省配置路径）", async () => {
  const {
    setProcessManagedPolicyFloor,
    resetProcessManagedPolicyFloorForTest,
  } = await import("../packages/core/src/permission/process-policy-floor.ts");
  await withStore(async ({ store }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 1 });
    setProcessManagedPolicyFloor({
      deny: [],
      ask: [{ toolName: TOOL }],
      disallowedTools: [],
      disableBypassPermissionsMode: false,
    });
    try {
      // 不显式传 policyFloor 的实例（defaultPermissionConfig 形态）经进程回落携带地板。
      const service = new PermissionService(baseConfig({ ttlApprovals: store }));
      const decision = service.checkPermission(makeContext(), mcpWriteCapability());
      assert.equal(decision.decision, "ask");
      assert.equal(decision.ruleId, "rule.policy.ask");
    } finally {
      resetProcessManagedPolicyFloorForTest();
    }
  });
});

test("项目显式 ask 压过 TTL allow（普通工具）", async () => {
  await withStore(async ({ store }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 1 });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    const projectRules = { version: 1, ask: [{ toolName: TOOL }] };
    const decision = service.checkPermission(makeContext(), mcpWriteCapability(), projectRules);
    assert.equal(decision.decision, "ask");
    assert.equal(decision.ruleId, "rule.project.ask");
  });
});

test("显式 ask 规则使 alwaysAsk 工具已记住的免确认失效（会话 + TTL）", async () => {
  await withStore(async ({ store, state }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 10 });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    service.grantSessionPermission([
      { type: "addRules", behavior: "allow", rules: [{ toolName: TOOL }] },
    ]);
    const capability = mcpWriteCapability({ alwaysAsk: true });

    // 无显式 ask：会话免确认命中（既有语义），TTL 在其后同位可用。
    const remembered = service.checkPermission(makeContext(), capability);
    assert.equal(remembered.decision, "allow");
    assert.equal(remembered.ruleId, "rule.session.allow");

    // 项目显式 ask：会话 always-allow 与 TTL 授权都不消费，每次重新确认。
    const projectRules = { version: 1, ask: [{ toolName: TOOL }] };
    const suppressed = service.checkPermission(makeContext(), capability, projectRules);
    assert.equal(suppressed.decision, "ask");
    assert.equal(suppressed.ruleId, "rule.project.ask");

    // 移除会话规则后单验 TTL 通路：无 ask 规则 → rule.ttl.allow；有 → ask。
    const ttlOnly = new PermissionService(baseConfig({ ttlApprovals: store }));
    assert.equal(
      ttlOnly.checkPermission(makeContext(), capability).ruleId,
      "rule.ttl.allow",
      "alwaysAsk 工具同样可被 TTL 授权免确认",
    );
    assert.equal(
      ttlOnly.checkPermission(makeContext(), capability, projectRules).ruleId,
      "rule.project.ask",
    );

    // TTL 过期后 alwaysAsk 回落 tool.alwaysAsk（不受本机制影响）。
    state.now += 10 * DAY_MS + 1;
    assert.equal(
      ttlOnly.checkPermission(makeContext(), capability).ruleId,
      "tool.alwaysAsk",
    );
  });
});

test("grantSessionPermission 分流：带 expiresAt 的 allow 进 TTL 存储（持久），其余进会话规则", async () => {
  await withStore(async ({ store, dir }) => {
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    const expiresAt = new Date(1_700_000_000_000 + 2 * DAY_MS).toISOString();
    service.grantSessionPermission([
      { type: "addRules", behavior: "allow", rules: [{ toolName: TOOL }], expiresAt },
      { type: "addRules", behavior: "allow", rules: [{ toolName: "WebFetch" }] },
    ]);
    await store.flush();

    // TTL 分流立即可判定（内存同步生效）。
    const decision = service.checkPermission(makeContext(), mcpWriteCapability());
    assert.equal(decision.ruleId, "rule.ttl.allow");

    // 持久化事实：文件里只有 TTL 条目，会话级 WebFetch 不落盘。
    const file = JSON.parse(readFileSync(join(dir, "ttl-approvals.json"), "utf8"));
    assert.equal(file.grants.length, 1);
    assert.equal(file.grants[0].toolName, TOOL);
    assert.equal(file.grants[0].expiresAt, expiresAt);

    // 重启等价物：新 service + 重载存储仍能命中（跨会话持久），而会话规则不存活。
    const reloaded = await TtlApprovalStore.create({
      filePath: join(dir, "ttl-approvals.json"),
      now: () => 1_700_000_000_000,
    });
    const restarted = new PermissionService(baseConfig({ ttlApprovals: reloaded }));
    assert.equal(
      restarted.checkPermission(makeContext(), mcpWriteCapability()).ruleId,
      "rule.ttl.allow",
    );
  });
});

test("无 TTL 存储时 grantSessionPermission 维持既有会话语义（零行为变化）", () => {
  const service = new PermissionService(baseConfig());
  const expiresAt = new Date(Date.now() + DAY_MS).toISOString();
  service.grantSessionPermission([
    { type: "addRules", behavior: "allow", rules: [{ toolName: TOOL }], expiresAt },
  ]);
  const capability = mcpWriteCapability({ alwaysAsk: true });
  // 无存储：带 expiresAt 的更新退回会话规则（不持久、随会话消亡）。
  assert.equal(
    service.checkPermission(makeContext(), capability).ruleId,
    "rule.session.allow",
  );
});

test("scopeKey：带作用域授权不作用于缺省上下文（fail-closed）", async () => {
  await withStore(async ({ store }) => {
    store.grant({ toolName: TOOL, origin: "interactive", ttlDays: 1, scopeKey: "proj-1" });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    assert.equal(
      service.checkPermission(makeContext(), mcpWriteCapability()).decision,
      "ask",
      "缺省 permissionScopeKey 的上下文只消费用户级授权",
    );
    assert.equal(
      service.checkPermission(
        makeContext({ permissionScopeKey: "proj-1" }),
        mcpWriteCapability(),
      ).ruleId,
      "rule.ttl.allow",
    );
  });
});

test("ruleContent 授权只对匹配输入生效（复用既有规则匹配语义）", async () => {
  await withStore(async ({ store }) => {
    store.grant({
      toolName: "Bash",
      ruleContent: "git status",
      origin: "interactive",
      ttlDays: 1,
    });
    const service = new PermissionService(baseConfig({ ttlApprovals: store }));
    const bashCapability = {
      readOnly: false,
      destructive: true,
      needsApproval: true,
      sideEffectScope: "workspace",
      riskLevel: "high",
    };
    const matching = service.checkPermission(
      makeContext({ toolName: "Bash", input: { command: "git status" }, riskLevel: "high" }),
      bashCapability,
    );
    assert.equal(matching.ruleId, "rule.ttl.allow");
    const other = service.checkPermission(
      makeContext({ toolName: "Bash", input: { command: "rm -rf build" }, riskLevel: "high" }),
      bashCapability,
    );
    assert.notEqual(other.ruleId, "rule.ttl.allow", "不同命令不得搭便车");
  });
});
