// 安全修复 H1（specs/plan-mode-mcp-gate.md）：plan 模式 MCP 放行门的回归钉。
// 被钉住的缺陷：checkPlanMode 的 mode.plan.mcp 分支此前只判 permissionName==="mcp"
// 且 !destructive 即 allow，不看 needsApproval/riskLevel/sideEffectScope；而
// destructive 来自服务端自报 destructiveHint（fail-open 缺省）、MCP 桥对宿主
// node_repl js 明确标 system/high/needsApproval——三个安全属性在旧分支全部失效，
// 「只读」plan 模式可免审批执行任意代码。收紧后逐条钉死：任一条件不满足 → deny，
// 全条件满足 → allow，只读 MCP 走 mode.plan.readOnly 照常放行，build 模式不受影响。
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../packages/core/src/permission/service.ts";
import { registerMcpTools } from "../packages/core/src/mcp/index.ts";

function context(mode, extra = {}) {
  return { toolName: "mcp__srv__tool", input: {}, riskLevel: "low", mode, ...extra };
}

/** MCP 桥投影后的 capability 形状（executor 的 resolveRuntimePermissionCapability 同款组装）。 */
function mcpCapability(overrides = {}) {
  return {
    readOnly: false,
    destructive: false,
    needsApproval: false,
    riskLevel: "medium",
    sideEffectScope: "network",
    permission: {
      permission: "mcp",
      reason: "MCP tool srv/tool executes through an external server",
      riskLevel: "medium",
      sideEffectScope: "network",
      needsApproval: false,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    ...overrides,
  };
}

const svc = () => new PermissionService();

test("plan：node_repl js 形状的 MCP capability（needsApproval+high+system）被拒", () => {
  const r = svc().checkPermission(
    context("plan", { toolName: "mcp__node_repl__js" }),
    mcpCapability({
      needsApproval: true,
      riskLevel: "high",
      sideEffectScope: "system",
      permission: {
        permission: "mcp",
        riskLevel: "high",
        sideEffectScope: "system",
        needsApproval: true,
      },
    }),
  );
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "mode.plan.nonReadOnly");
});

test("plan：仅 needsApproval 一项不满足 → deny（自报/桥标注的审批要求不可被 plan 抹掉）", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({ needsApproval: true, permission: { permission: "mcp", needsApproval: true } }),
  );
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "mode.plan.nonReadOnly");
});

test("plan：仅 riskLevel high → deny", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({ riskLevel: "high", permission: { permission: "mcp", riskLevel: "high" } }),
  );
  assert.equal(r.decision, "deny");
});

test("plan：仅 riskLevel critical → deny（不得出现严重度倒挂：high 拒而 critical 放）", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({
      riskLevel: "critical",
      permission: { permission: "mcp", riskLevel: "critical" },
    }),
  );
  assert.equal(r.decision, "deny");
});

test("plan：仅 sideEffectScope system → deny", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({
      sideEffectScope: "system",
      permission: { permission: "mcp", sideEffectScope: "system" },
    }),
  );
  assert.equal(r.decision, "deny");
});

test("plan：destructive 自报 true → deny（旧分支同样拒，收紧不得放宽）", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({ destructive: true, permission: { permission: "mcp" } }),
  );
  assert.equal(r.decision, "deny");
});

test("plan：全部收紧条件满足的低风险 MCP capability → allow（mode.plan.mcp 分支保留证明）", () => {
  const r = svc().checkPermission(context("plan"), mcpCapability());
  assert.equal(r.decision, "allow");
  assert.equal(r.ruleId, "mode.plan.mcp");
});

test("plan：只读 MCP（readOnlyHint 形状）仍走 mode.plan.readOnly 放行（R2）", () => {
  const r = svc().checkPermission(
    context("plan"),
    mcpCapability({
      readOnly: true,
      // 桥对全部 MCP 工具硬编码 needsApproval:true——只读放行来自 readOnly 分支，
      // 不依赖 needsApproval，收紧后语义不变。
      needsApproval: true,
      riskLevel: "low",
      permission: { permission: "mcp", riskLevel: "low", needsApproval: true },
    }),
  );
  assert.equal(r.decision, "allow");
  assert.equal(r.ruleId, "mode.plan.readOnly");
});

test("build 模式不受收紧影响：同 capability 走既有 build 分支（对照钉）", () => {
  // network 副作用 + 无审批标注 → build 既有语义是 ask（mode.build.sideEffect），
  // 与本修复无关；钉住 ruleId 证明 build 分支未被 plan 收紧波及。
  const sideEffect = svc().checkPermission(context("build"), mcpCapability());
  assert.equal(sideEffect.decision, "ask");
  assert.equal(sideEffect.ruleId, "mode.build.sideEffect");
  const highRisk = svc().checkPermission(
    context("build"),
    mcpCapability({
      needsApproval: true,
      riskLevel: "high",
      sideEffectScope: "system",
      permission: {
        permission: "mcp",
        riskLevel: "high",
        sideEffectScope: "system",
        needsApproval: true,
      },
    }),
  );
  assert.equal(highRisk.decision, "ask");
  assert.equal(highRisk.ruleId, "mode.build.highRisk");
  // 无副作用低风险的 MCP capability 在 build 下照常 allow。
  const lowRisk = svc().checkPermission(
    context("build"),
    mcpCapability({
      riskLevel: "low",
      sideEffectScope: "none",
      permission: { permission: "mcp", riskLevel: "low", sideEffectScope: "none" },
    }),
  );
  assert.equal(lowRisk.decision, "allow");
  assert.equal(lowRisk.ruleId, "mode.build.lowRisk");
});

// ---------------------------------------------------------------------------
// 端到端链路钉：真实 MCP 桥（registerMcpTools）注册的 entry，按 executor 同款
// capability 组装后进 PermissionService——防止桥的 permission 名固定为 "mcp"、
// destructive 取服务端自报值这两个事实再次把 plan 地板击穿。
// ---------------------------------------------------------------------------

function collectEntries(descriptors) {
  const entries = new Map();
  const registry = { register: (entry) => entries.set(entry.metadata.name, entry) };
  const mcpPort = { callTool: async () => ({ content: [] }) };
  registerMcpTools(registry, mcpPort, descriptors);
  return entries;
}

function capabilityOf(entry) {
  // resolveRuntimePermissionCapability 的静态部分：{ ...entry.metadata, permission: entry.permission }
  return { ...entry.metadata, permission: { ...entry.permission } };
}

test("桥注册的 node_repl/js：plan 下 deny（H1 主漏洞的端到端钉）", () => {
  const entries = collectEntries([
    {
      serverName: "node_repl",
      toolName: "js",
      description: "Run JavaScript",
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  const entry = entries.get("mcp__node_repl__js");
  assert.ok(entry, "node_repl js 必须被桥注册");
  // 桥侧安全属性在场（收紧判定的事实基础，防桥回退默认值）
  assert.equal(entry.metadata.sideEffectScope, "system");
  assert.equal(entry.metadata.riskLevel, "high");
  assert.equal(entry.metadata.needsApproval, true);
  assert.equal(entry.metadata.destructive, false); // 服务端不自报 destructiveHint → false（fail-open 缺省）

  const r = svc().checkPermission(
    { toolName: "mcp__node_repl__js", input: {}, riskLevel: "high", mode: "plan" },
    capabilityOf(entry),
  );
  assert.equal(r.decision, "deny");
  assert.equal(r.ruleId, "mode.plan.nonReadOnly");
});

test("桥注册的第三方无注解工具：plan 下 deny（needsApproval 桥级硬编码兜底）", () => {
  const entries = collectEntries([
    { serverName: "evil", toolName: "run", inputSchema: { type: "object", properties: {} } },
  ]);
  const entry = entries.get("mcp__evil__run");
  assert.ok(entry);
  const r = svc().checkPermission(
    { toolName: "mcp__evil__run", input: {}, riskLevel: "medium", mode: "plan" },
    capabilityOf(entry),
  );
  assert.equal(r.decision, "deny");
});

test("桥注册的只读工具（readOnlyHint）：plan 下仍 allow", () => {
  const entries = collectEntries([
    {
      serverName: "docs",
      toolName: "search",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  const entry = entries.get("mcp__docs__search");
  assert.ok(entry);
  const r = svc().checkPermission(
    { toolName: "mcp__docs__search", input: {}, riskLevel: "low", mode: "plan" },
    capabilityOf(entry),
  );
  assert.equal(r.decision, "allow");
  assert.equal(r.ruleId, "mode.plan.readOnly");
});
