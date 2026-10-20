// 权限 auto-deny reason 闭集 + 工具名防伪验收（apps/acode-cli/specs/permission-auto-deny-reasons.md）：
// R1 闭集词表（结构性分类：ruleId 精确 + 前缀；映射不了 undefined 不猜）、
// R2 逐条本地度量（decision-log denyReason 字段；env 门控本地 JSONL，no-telemetry）、
// R3 工具名防伪统一回应（registry-miss 含空名 → 统一常量；forged_tool_name 落日志；
// 不回显请求名/清单/建议）+ 词表扩集纪律守护（token 形态/唯一性/ruleId 全覆盖）。
// 真 PermissionService + 真 executor（沿 batch2 / K9 夹具模式）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const decisionLog = await import("../packages/core/src/permission/decision-log.ts");
const autoDeny = await import("../packages/core/src/permission/auto-deny-reasons.ts");
const dontAsk = await import("../packages/core/src/permission/dont-ask-mode.ts");
const { PermissionDenialReason } = await import("../packages/contracts/src/errors/index.ts");
const { createToolRegistry } = await import("../packages/core/src/tool/registry.ts");
const { executeToolCall } = await import("../packages/core/src/tool/executor/call-runner.ts");
const { BackgroundTaskTracker } = await import(
  "../packages/core/src/tool/executor/background-tasks.ts"
);

const WORKSPACE = mkdtempSync(join(tmpdir(), "perm-auto-deny-"));
after(() => {
  delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
  decisionLog.resetPermissionDecisionLogForTest();
  rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(extra.allowedTools ?? []),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(extra.policyFloor ? { policyFloor: extra.policyFloor } : {}),
  });
}

function ctx(toolName, input, mode = "build", riskLevel = "medium", extra = {}) {
  return {
    toolName,
    input,
    riskLevel,
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...extra,
  };
}

async function readLogEntries(dir) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return readFileSync(join(dir, decisionLog.PERMISSION_DECISION_LOG_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// ── R1 闭集词表：结构性分类 ─────────────────────────────────────────────────

test("R1: ruleId → token 精确映射逐条（闭集词表全覆盖）", () => {
  const { classifyAutoDenyRuleId } = autoDeny;
  assert.equal(classifyAutoDenyRuleId("rule.policy.deny"), PermissionDenialReason.PolicyDenied);
  assert.equal(
    classifyAutoDenyRuleId("rule.disallowedTools"),
    PermissionDenialReason.DisallowedTool,
  );
  assert.equal(
    classifyAutoDenyRuleId("rule.skillActivation.deny"),
    autoDeny.CoreAutoDenyExtraReason.SkillActivationDenied,
  );
  assert.equal(
    classifyAutoDenyRuleId("rule.project.deny"),
    PermissionDenialReason.ProjectRuleDenied,
  );
  assert.equal(
    classifyAutoDenyRuleId("mode.plan.nonReadOnly"),
    PermissionDenialReason.PlanModeRequiresReadOnly,
  );
  assert.equal(
    classifyAutoDenyRuleId("mode.plan.exitOnly"),
    autoDeny.CoreAutoDenyExtraReason.PlanModeTransitionDenied,
  );
  assert.equal(
    classifyAutoDenyRuleId(dontAsk.DONT_ASK_RULE_ID),
    PermissionDenialReason.DontAskModeDenied,
  );
  assert.equal(
    classifyAutoDenyRuleId(autoDeny.FORGED_TOOL_NAME_RULE_ID),
    autoDeny.CoreAutoDenyExtraReason.ForgedToolName,
  );
});

test("R1: 前缀族（breaker.* / gate.bashConfirmReflex.*）归因到单一 token", () => {
  const { classifyAutoDenyRuleId } = autoDeny;
  for (const ruleId of [
    "breaker.bashTargetCatastrophic",
    "breaker.bashRootDelete",
    "breaker.pathEscapeWrite",
    "breaker.sensitiveRead",
  ]) {
    assert.equal(classifyAutoDenyRuleId(ruleId), PermissionDenialReason.BreakerDenied, ruleId);
  }
  for (const ruleId of [
    "gate.bashConfirmReflex.reflect",
    "gate.bashConfirmReflex.insufficientJustification",
  ]) {
    assert.equal(
      classifyAutoDenyRuleId(ruleId),
      autoDeny.CoreAutoDenyExtraReason.ReflexGateDenied,
      ruleId,
    );
  }
});

test("R1: 映射不了的 ruleId 返回 undefined（不猜）", () => {
  const { classifyAutoDenyRuleId } = autoDeny;
  assert.equal(classifyAutoDenyRuleId("rule.project.allow"), undefined, "allow 类 ruleId 不归类");
  assert.equal(classifyAutoDenyRuleId("mode.yolo"), undefined);
  assert.equal(classifyAutoDenyRuleId("gate.somethingElse.deny"), undefined);
  assert.equal(classifyAutoDenyRuleId(""), undefined);
  assert.equal(classifyAutoDenyRuleId(undefined), undefined);
});

test("R1 扩集纪律: 全部 token 过形态白名单且闭集内互不重复", () => {
  const tokens = [
    ...Object.values(PermissionDenialReason),
    ...Object.values(autoDeny.CoreAutoDenyExtraReason),
  ];
  const pattern = /^[a-z][a-z0-9_]{1,63}$/;
  for (const token of tokens) {
    assert.match(token, pattern, `token ${token} 过闭集形态白名单`);
    assert.equal(autoDeny.isAutoDenyReason(token), true, `guard 认 ${token}`);
  }
  assert.equal(new Set(tokens).size, tokens.length, "本地扩展与 contracts 值互斥（无碰撞）");
  assert.equal(autoDeny.isAutoDenyReason("not_in_vocabulary"), false);
});

// ── R2 逐条本地度量：deny 终局进 decision-log 带闭集 denyReason ─────────────

test("R2: 各类 auto-deny 终局逐条落 denyReason；allow 不带该字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-deny-reason-"));
  try {
    process.env[decisionLog.PERMISSION_DECISION_LOG_ENV] = "1";
    decisionLog.resetPermissionDecisionLogForTest();

    const base = { workingDirectory: dir, sessionId: "sess_deny_reason" };
    // disallowedTools → disallowed_tool
    makeService({ disallowedTools: ["Write"] }).checkPermission(
      ctx("Write", { file_path: "a.ts" }, "build", "medium", base),
    );
    // plan 非只读 → plan_mode_requires_read_only
    makeService().checkPermission(ctx("Write", { file_path: "a.ts" }, "plan", "medium", base));
    // dontAsk 收敛 → dontask_mode_denied
    makeService().checkPermission(ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium", base));
    // 策略地板 deny → policy_denied
    makeService({
      policyFloor: { deny: [{ toolName: "Bash", ruleContent: "rm -rf /" }], ask: [] },
    }).checkPermission(ctx("Bash", { command: "rm -rf /" }, "build", "high", base));
    // 项目 deny 规则 → project_rule_denied
    makeService().checkPermission(
      ctx("WebFetch", { url: "https://example.com" }, "build", "low", base),
      { readOnly: true, sideEffectScope: "network", riskLevel: "low", needsApproval: false },
      { version: 1, deny: [{ toolName: "WebFetch" }] },
    );
    // allow 对照 → 无 denyReason
    makeService().checkPermission(ctx("Read", { file_path: "a.ts" }, "build", "low", base));

    const lines = await readLogEntries(dir);
    assert.equal(lines.length, 6, "终局单漏斗逐条恰一");
    assert.deepEqual(
      lines.map((entry) => entry.denyReason),
      [
        PermissionDenialReason.DisallowedTool,
        PermissionDenialReason.PlanModeRequiresReadOnly,
        PermissionDenialReason.DontAskModeDenied,
        PermissionDenialReason.PolicyDenied,
        PermissionDenialReason.ProjectRuleDenied,
        undefined,
      ],
    );
    assert.ok(
      lines.every((entry) => entry.denyReason === undefined || autoDeny.isAutoDenyReason(entry.denyReason)),
      "落日志的 denyReason 全部是闭集成员",
    );
    assert.ok(
      lines.slice(0, 5).every((entry) => entry.decision === "deny"),
      "前 5 条均为 deny 终局",
    );
  } finally {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: recordForgedToolNameDenial 直记 forged 条目（mode 占位 + 名字截断）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-forged-log-"));
  try {
    process.env[decisionLog.PERMISSION_DECISION_LOG_ENV] = "1";
    decisionLog.resetPermissionDecisionLogForTest();

    autoDeny.recordForgedToolNameDenial({
      toolName: "FancyUiCardTool",
      sessionId: "sess_forged",
      workingDirectory: dir,
    });
    // 外部可控超长名：日志记录前截断（防日志膨胀；回应侧本就不回显）。
    const longName = `x${"y".repeat(autoDeny.FORGED_TOOL_NAME_LOG_MAX_CHARS + 50)}`;
    autoDeny.recordForgedToolNameDenial({ toolName: longName, workingDirectory: dir });

    const lines = await readLogEntries(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].decision, "deny");
    assert.equal(lines[0].ruleId, autoDeny.FORGED_TOOL_NAME_RULE_ID);
    assert.equal(lines[0].denyReason, autoDeny.CoreAutoDenyExtraReason.ForgedToolName);
    assert.equal(lines[0].mode, "dispatch", "mode 缺席时占位 dispatch（denied at dispatch）");
    assert.equal(lines[0].sessionId, "sess_forged");
    assert.equal(lines[0].tool, "FancyUiCardTool", "本地日志保留原名供诊断（非 provider 面）");
    assert.ok(
      lines[1].tool.length <= autoDeny.FORGED_TOOL_NAME_LOG_MAX_CHARS + 1,
      "超长名截断到上限 + 省略标记",
    );
    assert.ok(lines[1].tool.endsWith("…"));
  } finally {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── R3 工具名防伪统一回应（executor 集成） ──────────────────────────────────

function makeEntry(name) {
  return {
    capability: `probe capability for ${name}`,
    metadata: {
      name,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async () => ({ ok: true }),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {},
    permission: {
      permission: `probe.${name.toLowerCase()}`,
      reason: "test probe tool",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 4000, maxModelBytes: 4000, strategy: "truncate" },
    timeout: { defaultMs: 5000, maxMs: 5000, allowCallOverride: false },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "cancelled" },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "none",
      recordOutput: "summary",
    },
  };
}

test("R3: registry-miss 经 executor 统一回应且 forged_tool_name 逐条落本地日志", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-forged-exec-"));
  try {
    process.env[decisionLog.PERMISSION_DECISION_LOG_ENV] = "1";
    decisionLog.resetPermissionDecisionLogForTest();

    const registry = createToolRegistry();
    registry.register(makeEntry("Write"));
    const deps = {
      registry,
      permissionService: new PermissionService(),
      emitEvent: async () => undefined,
      sessionId: "sess_forged_exec",
      turnId: "turn_forged_exec",
      defaultTimeoutMs: 5000,
      getMode: () => "build",
      getWorkingDirectory: () => dir,
      getWorkspaceRoot: () => dir,
      runtimeScope: "main",
    };
    const tracker = new BackgroundTaskTracker(deps);

    const result = await executeToolCall(deps, tracker, {
      id: "call-forged-1",
      name: "Writee",
      input: {},
    });

    assert.equal(result.success, false, "判定语义照旧：失败回执");
    assert.equal(result.modelContent, autoDeny.NO_SUCH_TOOL_MODEL_RESPONSE, "统一常量回应");
    assert.ok(!result.modelContent.includes("Writee"), "不回显请求名");
    assert.ok(!result.modelContent.includes("Write`"), "不确认近似名存在");

    const lines = await readLogEntries(dir);
    const forged = lines.filter(
      (entry) => entry.denyReason === autoDeny.CoreAutoDenyExtraReason.ForgedToolName,
    );
    assert.equal(forged.length, 1, "forged 类 reason 恰一条（本地度量，无外部出口）");
    assert.equal(forged[0].tool, "Writee", "本地日志留原名供诊断");
    assert.equal(forged[0].mode, "build", "记当前协作模式");
    assert.equal(forged[0].sessionId, "sess_forged_exec");
    assert.equal(forged[0].ruleId, autoDeny.FORGED_TOOL_NAME_RULE_ID);
  } finally {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3: env 关闭时 forged 路径零写入（关闭态零 IO 红线不破）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-forged-off-"));
  try {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
    autoDeny.recordForgedToolNameDenial({ toolName: "Ghost", workingDirectory: dir });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.throws(() => readFileSync(join(dir, decisionLog.PERMISSION_DECISION_LOG_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
