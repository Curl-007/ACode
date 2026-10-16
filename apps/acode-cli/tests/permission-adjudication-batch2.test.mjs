// 权限裁决批 2 验收（apps/acode-cli/specs/permission-adjudication-batch2.md）：
// R1 dontAsk 收敛全谱与正交不变量、R2 决策日志（env 门控 JSONL、失败静默）、
// R3 AUQ ask 写作纪律描述、R4 闭集词表增补（启动拒绝组 + 审批参数绑定失效 +
// dontask_mode_denied 分类）。真 PermissionService，沿 makeService 夹具模式。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
const dontAsk = await import("../packages/core/src/permission/dont-ask-mode.ts");
const decisionLog = await import("../packages/core/src/permission/decision-log.ts");
// 词表本体在 reasons.ts、文本分类器在 reasons-classify.ts（ratchet 行数门禁拆分）；
// 经 errors 桶导入两个面，公开符号集与拆分前逐名一致。
const reasons = await import("../packages/contracts/src/errors/index.ts");

const WORKSPACE = "/tmp/perm-batch2-ws";

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(extra.allowedTools ?? []),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(extra.policyFloor ? { policyFloor: extra.policyFloor } : {}),
  });
}

function ctx(toolName, input, mode = "dontAsk", riskLevel = "medium", extra = {}) {
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

// ── R1 dontAsk 收敛全谱 ──────────────────────────────────────────────────────

test("R1: build 语义下会 ask 的调用在 dontAsk 下全部 deny(mode.dontAsk) 且不弹卡", () => {
  const service = makeService();
  // 副作用工具（build 下 mode.build.sideEffect ask）
  const write = service.checkPermission(ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium"));
  assert.equal(write.decision, "deny");
  assert.equal(write.ruleId, dontAsk.DONT_ASK_RULE_ID);
  assert.equal(write.escalated, false);
  assert.equal(write.allowed, false);
  assert.ok(write.reason.includes("mode.build.sideEffect"), "文案含原 ruleId 归因");
  // critical（build 下 ask）
  const critical = service.checkPermission(ctx("SomeTool", {}, "dontAsk", "medium"), {
    riskLevel: "critical",
    sideEffectScope: "system",
  });
  assert.equal(critical.decision, "deny");
  assert.equal(critical.ruleId, dontAsk.DONT_ASK_RULE_ID);
  // alwaysAsk（tool.alwaysAsk ask）
  const always = service.checkPermission(ctx("SomeTool", {}, "dontAsk", "medium"), {
    alwaysAsk: true,
  });
  assert.equal(always.decision, "deny");
  assert.ok(always.reason.includes("tool.alwaysAsk"));
  // requiresApproval 恒 false（诚实语义：不会发起审批请求）
  assert.equal(service.requiresApproval(ctx("Write", { file_path: "a.ts" })), false);
});

test("R1: userInteraction 工具走专属文案变体（没有批准面）", () => {
  const service = makeService();
  const ask = service.checkPermission(
    ctx("AskUserQuestion", { questions: [] }, "dontAsk", "low"),
    { requiresUserInteraction: true, sideEffectScope: "userInteraction", riskLevel: "low" },
  );
  assert.equal(ask.decision, "deny");
  assert.equal(ask.ruleId, dontAsk.DONT_ASK_RULE_ID);
  assert.ok(ask.reason.includes("no approval surface"), "userInteraction 变体");
  assert.ok(!ask.reason.includes("don't-ask mode, where anything"), "非通用变体");
});

test("R1: 白名单照常放行；既有 deny 原样（未白名单即拒，白名单即允）", () => {
  const service = makeService({ allowedTools: ["Write"], disallowedTools: ["Grep"] });
  // 只读直通
  const read = service.checkPermission(ctx("Read", { file_path: "a.ts" }, "dontAsk", "low"));
  assert.equal(read.decision, "allow");
  // allowedTools 白名单
  const allowed = service.checkPermission(ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium"));
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "rule.allowedTools");
  // 项目 allow 规则白名单
  const projectAllow = service.checkPermission(
    ctx("WebFetch", { url: "https://example.com" }, "dontAsk", "low"),
    { readOnly: true, sideEffectScope: "network", riskLevel: "low", needsApproval: false },
    { version: 1, allow: [{ toolName: "Read" }] },
  );
  assert.equal(projectAllow.decision, "allow");
  // disallowedTools deny 原样（不经 ask 漏斗）
  const disallowed = service.checkPermission(ctx("Grep", {}, "dontAsk", "low"));
  assert.equal(disallowed.decision, "deny");
  assert.equal(disallowed.ruleId, "rule.disallowedTools");
  // plan 拒写 deny 原样（planEnabled 地板 + dontAsk 正交）
  const planDeny = service.checkPermission(
    ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium", { planEnabled: true }),
  );
  assert.equal(planDeny.decision, "deny");
  assert.equal(planDeny.ruleId, "mode.plan.nonReadOnly");
});

test("R1: 正交组合——policy floor deny 保持、policy ask 收敛为 deny 且归因保留", () => {
  const floor = {
    deny: [{ toolName: "Bash", ruleContent: "rm -rf /" }],
    ask: [{ toolName: "WebFetch" }],
  };
  const service = makeService({ policyFloor: floor });
  const denied = service.checkPermission(
    ctx("Bash", { command: "rm -rf /" }, "dontAsk", "high"),
    { riskLevel: "high", sideEffectScope: "system" },
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.ruleId, "rule.policy.deny", "policy deny 不被 dontAsk 改写");
  // policy ask 托底 → dontAsk deny，归因保留 rule.policy.ask
  const askFloor = service.checkPermission(
    ctx("WebFetch", { url: "https://example.com" }, "dontAsk", "low"),
    { readOnly: true, sideEffectScope: "network", riskLevel: "low", needsApproval: false },
  );
  assert.equal(askFloor.decision, "deny");
  assert.equal(askFloor.ruleId, dontAsk.DONT_ASK_RULE_ID);
  assert.ok(askFloor.reason.includes("rule.policy.ask"));
});

test("R1: 不变量——autoGrayZone 不产生、yolo 直通不生效、deny 文案三要素与长度界", () => {
  const service = makeService();
  // dontAsk 不进 auto 灰区（medium 在 auto 下是灰区 ask；dontAsk 下是 deny 无标记）
  const medium = service.checkPermission(ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium"));
  assert.equal(medium.autoGrayZone, undefined);
  // yolo 直通谓词对 dontAsk 恒 false：副作用不放行
  assert.equal(medium.decision, "deny");
  // 文案三要素 + 500 字符投影界内
  for (const tool of ["Write", "AskUserQuestion"]) {
    const reason = dontAsk.buildDontAskDenialReason(tool, {
      underlyingRuleId: "mode.build.sideEffect",
      underlyingReason: "Tool has side effects and requires approval",
      requiresUserInteraction: tool === "AskUserQuestion",
    });
    assert.ok(reason.length <= 500, `${tool} 文案 ${reason.length} 超投影界`);
    assert.ok(reason.includes("NOT performed"));
    assert.ok(reason.includes("do not claim") || reason.includes("Do not claim"));
    assert.ok(reason.toLowerCase().includes("do not retry"));
    assert.ok(reason.includes("mode.build.sideEffect"));
  }
  // 模式闭集常量：六值含 dontAsk
  assert.deepEqual([...dontAsk.PERMISSION_ADJUDICATION_MODES], [
    "plan",
    "build",
    "edit",
    "yolo",
    "auto",
    "dontAsk",
  ]);
  assert.equal(dontAsk.isDontAskMode("dontAsk"), true);
  assert.equal(dontAsk.isDontAskMode("build"), false);
});

// ── R2 决策日志 ──────────────────────────────────────────────────────────────

test("R2: env=1 → 每次 checkPermission 终局恰一条 JSONL；env 缺席零写入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-decision-log-"));
  try {
    // env 缺席：零写入
    decisionLog.resetPermissionDecisionLogForTest();
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    const serviceOff = makeService();
    serviceOff.checkPermission(ctx("Read", { file_path: "a.ts" }, "build", "low", {
      workingDirectory: dir,
      sessionId: "sess_log_off",
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.throws(() => readFileSync(join(dir, decisionLog.PERMISSION_DECISION_LOG_FILE)));

    // env=1：allow/ask/deny 三决策各恰一条
    process.env[decisionLog.PERMISSION_DECISION_LOG_ENV] = "1";
    decisionLog.resetPermissionDecisionLogForTest();
    const service = makeService();
    const base = { workingDirectory: dir, sessionId: "sess_log" };
    service.checkPermission(ctx("Read", { file_path: "a.ts" }, "build", "low", base));
    service.checkPermission(ctx("Write", { file_path: "a.ts" }, "build", "medium", base));
    service.checkPermission(ctx("Write", { file_path: "a.ts" }, "dontAsk", "medium", base));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = readFileSync(join(dir, decisionLog.PERMISSION_DECISION_LOG_FILE), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 3, "终局单漏斗：中间候选不落，恰 3 条");
    assert.deepEqual(
      lines.map((entry) => entry.decision),
      ["allow", "ask", "deny"],
    );
    assert.equal(lines[0].tool, "Read");
    assert.equal(lines[0].sessionId, "sess_log");
    assert.ok(lines.every((entry) => typeof entry.ts === "number" && entry.ruleId && entry.mode));
    assert.equal(lines[2].ruleId, dontAsk.DONT_ASK_RULE_ID);
    assert.equal(lines[2].mode, "dontAsk");
    // reason 截断 200
    const longReason = "x".repeat(400);
    decisionLog.appendPermissionDecisionLogEntry(
      {
        ts: Date.now(),
        tool: "T",
        decision: "deny",
        ruleId: "r",
        mode: "dontAsk",
        reason: longReason,
      },
      { workingDirectory: dir },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const last = JSON.parse(
      readFileSync(join(dir, decisionLog.PERMISSION_DECISION_LOG_FILE), "utf8").trim().split("\n").at(-1),
    );
    assert.ok(last.reason.length <= decisionLog.PERMISSION_DECISION_LOG_REASON_MAX_CHARS + 1);
  } finally {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: 写入失败静默（不可写目标不影响决策结果）", () => {
  decisionLog.resetPermissionDecisionLogForTest();
  process.env[decisionLog.PERMISSION_DECISION_LOG_ENV] = "1";
  try {
    const service = makeService();
    // workingDirectory 指向不存在的路径 → appendFile 失败 → 静默
    const decision = service.checkPermission(
      ctx("Read", { file_path: "a.ts" }, "build", "low", {
        workingDirectory: join(tmpdir(), "definitely-missing-dir-perm-batch2"),
      }),
    );
    assert.equal(decision.decision, "allow", "日志故障不阻断决策");
  } finally {
    delete process.env[decisionLog.PERMISSION_DECISION_LOG_ENV];
    decisionLog.resetPermissionDecisionLogForTest();
  }
});

// ── R3 AUQ ask 写作纪律 ──────────────────────────────────────────────────────

test("R3: AskUserQuestion 描述含五要素纪律；既有段落不删改", async () => {
  const { askUserQuestionToolEntry } = await import(
    "../packages/core/src/tool/handlers/ask-user-question.ts"
  );
  const description = askUserQuestionToolEntry.metadata.description;
  // 五要素（自撰增补段）
  assert.ok(description.includes("ONE decision"));
  assert.ok(description.includes('Never join two decisions with "and"'));
  assert.ok(description.includes("no reasons, no recommendation"));
  assert.ok(description.includes("options the buttons already present"));
  assert.ok(description.includes("primary button"));
  assert.ok(description.includes("omit the call entirely"));
  // 波次 1 既有段保留
  assert.ok(description.includes("genuinely the user's to make"));
  assert.ok(description.includes("Plan mode note"));
});

// ── R4 闭集词表增补 ──────────────────────────────────────────────────────────

test("R4: 启动拒绝组——token 形态、成员判定、外部收窄、四组互不重叠", () => {
  const tokens = Object.values(reasons.LaunchRefusalReason);
  assert.ok(tokens.length >= 10);
  for (const token of tokens) {
    assert.match(token, /^[a-z][a-z0-9_]{1,63}$/, `token 形态违规: ${token}`);
    assert.equal(reasons.isLaunchRefusalReason(token), true);
    assert.equal(reasons.isClosedErrorReasonToken(token), true);
    // 外部收窄：大写/空白归一后命中；非法形态拒绝
    assert.equal(reasons.narrowExternalClosedReasonToken(` ${token.toUpperCase()} `), token);
  }
  assert.equal(reasons.narrowExternalClosedReasonToken("ORG_PIN_MISMATCHX"), undefined);
  assert.equal(reasons.isLaunchRefusalReason("gateway_timeout"), false);
  // 四组互不重叠
  const groups = [
    Object.values(reasons.AgentLaunchFailureReason),
    Object.values(reasons.PermissionDenialReason),
    Object.values(reasons.SessionErrorClass),
    tokens,
  ];
  const all = groups.flat();
  assert.equal(new Set(all).size, all.length, "四组词表存在重叠 token");
  // org/gateway/provider 族关键 token 在集
  for (const expected of [
    "org_pin_mismatch",
    "gateway_signin_required",
    "gateway_session_expired",
    "provider_not_allowed",
    "managed_settings_refused",
    "bypass_permissions_root_blocked",
    "worktree_unverified",
  ]) {
    assert.ok(tokens.includes(expected), `启动拒绝组缺 ${expected}`);
  }
});

test("R4: 审批参数绑定失效 token + dontAsk/绑定失效文案分类", () => {
  assert.equal(
    reasons.PermissionDenialReason.ApprovalArgumentsMismatch,
    "approval_arguments_mismatch",
  );
  assert.equal(
    reasons.classifyPermissionDenialText(
      "The approval for this Bash call came back with different arguments, so it was not run. Retry the same call.",
    ),
    "approval_arguments_mismatch",
  );
  assert.equal(
    reasons.classifyPermissionDenialText(
      "The approval was for different arguments; it cannot be reused.",
    ),
    "approval_arguments_mismatch",
  );
  // dontAsk 规范文案 → dontask_mode_denied（即使归因段携带 breaker ruleId 也不误归类）
  const dontAskReason = dontAsk.buildDontAskDenialReason("Bash", {
    underlyingRuleId: "breaker.pathEscapeWrite",
    underlyingReason: "write escapes the workspace",
  });
  assert.equal(
    reasons.classifyPermissionDenialText(dontAskReason),
    reasons.PermissionDenialReason.DontAskModeDenied,
  );
  // 总入口收窄：精确成员 + 文案分类两路
  assert.equal(
    reasons.narrowErrorReasonToClosedToken(dontAskReason),
    reasons.PermissionDenialReason.DontAskModeDenied,
  );
});

// ── 源码不变量 ───────────────────────────────────────────────────────────────

test("不变量: ask 漏斗是 dontAsk 唯一收敛点; hook-flow 首行 deny 免疫保持", async () => {
  const { readFileSync: readFs } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const read = (rel) =>
    readFs(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const service = read("../packages/core/src/permission/service.ts");
  // ask() 漏斗含 dontAsk 收敛；result() 不再直接产 ask（所有 ask 经漏斗）
  const askFunnel = service.slice(
    service.indexOf("private ask("),
    service.indexOf("private deny("),
  );
  assert.ok(askFunnel.includes("DONT_ASK_MODE"));
  assert.ok(askFunnel.includes("DONT_ASK_RULE_ID"));
  assert.ok(askFunnel.includes("buildDontAskDenialReason"));
  // checkPermission 薄包装：日志 + 台账喂入在终局单漏斗
  const wrapper = service.slice(
    service.indexOf("checkPermission("),
    service.indexOf("private evaluatePermission("),
  );
  assert.ok(wrapper.includes("appendPermissionDecisionLogEntry"));
  assert.ok(wrapper.includes("recordTranscriptFileProvenanceFromAllowedCall"));
  // hook-flow：deny 原样返回（dontAsk deny 对 hook allow 免疫的结构保证）
  const hookFlow = read("../packages/core/src/tool/executor/hook-flow.ts");
  const preTool = hookFlow.slice(hookFlow.indexOf("export function applyPreToolPermissionDecision"));
  assert.ok(
    preTool.slice(0, 400).includes('permissionDecision.decision === "deny"') &&
      preTool.slice(0, 400).includes("return permissionDecision"),
    "hook-flow 首行 deny 免疫语义被改动",
  );
  // 决策日志模块零网络符号（no-telemetry）
  const logSource = read("../packages/core/src/permission/decision-log.ts");
  for (const symbol of ["fetch(", "node:http", "node:https", "node:net", "node:dgram"]) {
    assert.ok(!logSource.includes(symbol), `decision-log 含网络符号 ${symbol}`);
  }
});
