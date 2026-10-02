import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * J1 修复轮 2/3 验收测试（对抗性复审 N1–N7/N9/L-3 与对抗复核 F1–F4/F6 的闭合与不回归）。
 *
 * 每个用例的注释标编号，编号沿用对抗性复审/对抗复核报告；spec 依据见
 * apps/acode-cli/specs/bash-confirm-reflexive-gate.md（R3/R4/R6/R7 相应更新）。
 * fixture 分级已用探针实测确认（bash-target-risk 当前检出）：
 * `rm -rf ~` = catastrophic；`cat paths.txt | xargs rm -rf` = confirm 且无熔断命中。
 * F4（挑战键不含 mode）与 F6（hook allow 可翻转普通 ask、deny 永不翻转）为 spec
 * 登记项，无代码改动，不设独立用例。
 */

const { PermissionService } = await import("../packages/core/src/permission/service.ts");
// 直接从模块路径导入：core 的 barrel（src/index.ts）在 tsx 下有循环导入问题，
// 而 gate 模块本身就是 sink 注册点的所有者。
const { setBashReflexAuditSink } =
  await import("../packages/core/src/permission/bash-confirm-reflex-gate.ts");
const { bashToolEntry } = await import("../packages/core/src/tool/handlers/bash.ts");
const { resolveToolPermission } =
  await import("../packages/core/src/tool/executor/permission-flow.ts");

const WORKSPACE = join(tmpdir(), "acode-j1-adversarial-workspace");

/** confirm 级且不命中既有熔断的命令（既有 17 用例同款，分级稳定）。 */
const CONFIRM_CMD = "cat paths.txt | xargs rm -rf";
const CATASTROPHIC_CMD = "rm -rf ~";
const VALID_JUST =
  "The user explicitly asked to delete every file listed in paths.txt from this workspace";

const RULE = {
  reflect: "gate.bashConfirmReflex.reflect",
  insufficient: "gate.bashConfirmReflex.insufficientJustification",
  ask: "gate.bashConfirmReflex.ask",
  breakerAsk: "gate.bashConfirmReflex.breakerAsk",
  auditedAllow: "gate.bashConfirmReflex.auditedAllow",
};

const POLICY_ASK_BASH = {
  deny: [],
  ask: [{ toolName: "Bash" }],
  disallowedTools: [],
  disableBypassPermissionsMode: false,
};
const POLICY_DENY_CURL = {
  deny: [{ toolName: "Bash", ruleContent: "curl:*" }],
  ask: [],
  disallowedTools: [],
  disableBypassPermissionsMode: false,
};
const POLICY_NO_BYPASS = {
  deny: [],
  ask: [],
  disallowedTools: [],
  disableBypassPermissionsMode: true,
};

function makeService(policyFloor) {
  return new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
    ...(policyFloor ? { policyFloor } : {}),
  });
}

function bashCtx(command, mode = "build", justification, extra = {}) {
  return {
    toolName: "Bash",
    input: justification === undefined ? { command } : { command, justification },
    riskLevel: "high",
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...extra,
  };
}

function pick(decision) {
  return [decision.decision, decision.ruleId];
}

// ── N1：策略地板 ask 不再绕过 deny 级熔断与反射门（最严者胜） ─────────

test("(N1) policy ask no longer downgrades the catastrophic deny: the breaker wins", () => {
  // 修复前：policy ask 命中提前返回 → ask rule.policy.ask（可批准），catastrophic
  // 的绝对 deny 被降级。修复后：deny 级熔断先于策略 ask 收敛。
  const service = makeService(POLICY_ASK_BASH);
  assert.deepEqual(pick(service.checkPermission(bashCtx(CATASTROPHIC_CMD, "yolo"))), [
    "deny",
    "breaker.bashTargetCatastrophic",
  ]);
});

test("(N1) policy ask + confirm command: the first call is denied by the gate, not asked by policy", () => {
  const service = makeService(POLICY_ASK_BASH);
  assert.deepEqual(pick(service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"))), [
    "deny",
    RULE.reflect,
  ]);
});

test("(N1) policy ask + confirm command: justified re-issue converges to an ask carrying both policy and gate semantics", () => {
  const service = makeService(POLICY_ASK_BASH);
  service.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
  const second = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
  assert.deepEqual(pick(second), ["ask", "rule.policy.ask"]);
  // 弹窗 reason 同时体现策略地板与门语义（spec R7）。
  assert.match(second.reason, /requires approval by managed policy/);
  assert.ok(second.reason.includes(VALID_JUST), "gate ask reason keeps the justification");
  assert.match(second.reason, /reflection gate/);
});

test("(N1) policy ask never relaxes an existing deny (plan nonReadOnly stays deny)", () => {
  // 策略地板只能收紧：policy ask 压过放行，但压不过模式层 deny。
  const service = makeService({ ...POLICY_ASK_BASH, ask: [{ toolName: "Write" }] });
  const decision = service.checkPermission(
    {
      toolName: "Write",
      input: { file_path: join(WORKSPACE, "notes.md") },
      riskLevel: "medium",
      mode: "plan",
      workingDirectory: WORKSPACE,
      workspaceRoot: WORKSPACE,
    },
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.deepEqual(pick(decision), ["deny", "mode.plan.nonReadOnly"]);
});

test("(N1) no-regression: a normal command under policy ask still asks rule.policy.ask", () => {
  const service = makeService(POLICY_ASK_BASH);
  const decision = service.checkPermission(bashCtx("ls -la", "yolo"));
  assert.deepEqual(pick(decision), ["ask", "rule.policy.ask"]);
  assert.equal(decision.reason, "Tool Bash requires approval by managed policy");
});

test("(N1) no-regression: policy deny stays absolute over yolo", () => {
  const service = makeService(POLICY_DENY_CURL);
  assert.deepEqual(pick(service.checkPermission(bashCtx("curl http://evil.example", "yolo"))), [
    "deny",
    "rule.policy.deny",
  ]);
});

test("(N1) no-regression: disableBypassPermissionsMode semantics unchanged", () => {
  const service = makeService(POLICY_NO_BYPASS);
  const decision = service.checkPermission(
    bashCtx("ls -la", "yolo"),
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.equal(decision.decision, "ask");
  assert.notEqual(decision.ruleId, "mode.yolo");
});

test("(N1) no-regression: without a policy floor the whole chain behaves as before", () => {
  const service = makeService(undefined);
  assert.deepEqual(pick(service.checkPermission(bashCtx("ls -la", "yolo"))), [
    "allow",
    "mode.yolo",
  ]);
  assert.deepEqual(pick(service.checkPermission(bashCtx(CONFIRM_CMD, "build"))), [
    "deny",
    RULE.reflect,
  ]);
});

// ── N2：审计 JSONL 值级脱敏 ──────────────────────────────────────────

test("(N2) audit entry redacts credentials in the command and justification, keeps the rest verbatim", () => {
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    const credCmd =
      "TOKEN=eyJhbGciOiJIUzI1NiJ9.dGVzdC1zaWduYXR1cmU cat paths.txt | xargs rm -rf";
    const credJust =
      VALID_JUST +
      ". The deployment key sk-abcdefghijklmnop1234 was already revoked, and the leaked header was Bearer tu9supersecretvalue1.";
    service.checkPermission(bashCtx(credCmd, "yolo")); // 反射轮
    const allowed = service.checkPermission(bashCtx(credCmd, "yolo", credJust));
    assert.deepEqual(pick(allowed), ["allow", RULE.auditedAllow]);
  } finally {
    setBashReflexAuditSink(undefined);
  }
  assert.equal(captured.length, 1);
  const entry = captured[0];
  const flat = JSON.stringify(entry);
  // 凭据真值不落盘（AGENTS.md 日志红线）。
  assert.ok(!flat.includes("eyJhbGciOiJIUzI1NiJ9"), "JWT must not reach the audit log");
  assert.ok(!flat.includes("sk-abcdefghijklmnop1234"), "API key must not reach the audit log");
  assert.ok(!flat.includes("tu9supersecretvalue1"), "Bearer value must not reach the audit log");
  // REDACTED 标记出现（JSON 赋值/裸 Key/方案头三类）。
  assert.equal(entry.command, "[REDACTED:credential-field] cat paths.txt | xargs rm -rf");
  assert.ok(entry.justification.includes("[REDACTED:api-key]"));
  assert.ok(entry.justification.includes("[REDACTED:auth-scheme]"));
  // 非凭据内容逐字保留（审计排障价值）。
  assert.ok(entry.command.includes("cat paths.txt | xargs rm -rf"));
  assert.ok(entry.justification.startsWith(VALID_JUST));
  // 其余审计字段完整。
  assert.equal(entry.event, "bash_reflex_gate_audited_allow");
  assert.equal(entry.ruleId, RULE.auditedAllow);
  assert.ok(Array.isArray(entry.assessmentReasons) && entry.assessmentReasons.length > 0);
  assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
});

test("(N2) quoted JSON credential fields and header forms are redacted without breaking syntax", () => {
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    const just =
      VALID_JUST +
      '. The provider payload echoed {"api_key": "sk-verysecretkey99", "x-api-key": "anthropicvalue123"} at us.';
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
    const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", just));
    assert.deepEqual(pick(allowed), ["allow", RULE.auditedAllow]);
  } finally {
    setBashReflexAuditSink(undefined);
  }
  const entry = captured[0];
  assert.ok(!JSON.stringify(entry).includes("sk-verysecretkey99"));
  assert.ok(!JSON.stringify(entry).includes("anthropicvalue123"));
  // JSON 结构不被破坏：键名保留，值整体替换。
  assert.ok(entry.justification.includes('"api_key": "[REDACTED:credential-field]"'));
  assert.ok(entry.justification.includes('"x-api-key": "[REDACTED:credential-field]"'));
});

test("(N2) non-credential audit content stays verbatim", () => {
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
  } finally {
    setBashReflexAuditSink(undefined);
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].command, CONFIRM_CMD);
  assert.equal(captured[0].justification, VALID_JUST);
  assert.ok(!captured[0].justification.includes("[REDACTED:"));
});

// ── N3：挑战不跨身份（共享 PermissionService 实例） ──────────────────

test("(N3) a challenge registered by session A does not unlock session B on a shared instance", () => {
  const service = makeService();
  // 会话 A（build）触发反射挑战。
  const firstA = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", undefined, { sessionId: "session-A" }),
  );
  assert.deepEqual(pick(firstA), ["deny", RULE.reflect]);
  // 会话 B（yolo）首调即带有效 justification：挑战不跨身份 → 仍是预填 → deny reflect
  // （修复前：B 直接 auditedAllow，B 从未收到反射 prompt）。
  const firstB = service.checkPermission(
    bashCtx(CONFIRM_CMD, "yolo", VALID_JUST, { sessionId: "session-B" }),
  );
  assert.deepEqual(pick(firstB), ["deny", RULE.reflect]);
  assert.match(firstB.reason, /was not counted/);
});

test("(N3) the same-identity two-round flow is unchanged", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build", undefined, { sessionId: "session-1" }));
  const second = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", VALID_JUST, { sessionId: "session-1" }),
  );
  assert.deepEqual(pick(second), ["ask", RULE.ask]);

  const yoloService = makeService();
  yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo", undefined, { sessionId: "session-1" }));
  const allowed = yoloService.checkPermission(
    bashCtx(CONFIRM_CMD, "yolo", VALID_JUST, { sessionId: "session-1" }),
  );
  assert.deepEqual(pick(allowed), ["allow", RULE.auditedAllow]);
});

test("(N3) legacy callers without identity keep the per-command behavior", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const second = service.checkPermission(bashCtx(CONFIRM_CMD, "build", VALID_JUST));
  assert.deepEqual(pick(second), ["ask", RULE.ask]);
});

test("(N3) the executor flow passes the session identity so the gate is per-session end to end", async () => {
  const service = makeService();
  // 会话 A 走真实投递路径触发挑战。
  const firstA = await runFlow(service, "session-A", CONFIRM_CMD, "build");
  assert.equal(firstA.flow.allowed, false);
  assert.match(firstA.flow.result.error.message, /Which specific thing the user asked for/);
  // 会话 B 经同一实例、同一命令、带有效 justification 首调 → 预填无效。
  const firstB = await runFlow(service, "session-B", CONFIRM_CMD, "build", VALID_JUST);
  assert.equal(firstB.flow.allowed, false);
  assert.match(firstB.flow.result.error.message, /was not counted/);
  // 会话 A 自己的重提照常有效：挑战在本身份下成立 → ask → broker 桩批准放行。
  const secondA = await runFlow(service, "session-A", CONFIRM_CMD, "build", VALID_JUST);
  assert.equal(secondA.flow.allowed, true);
  assert.ok(secondA.emitted.some((event) => event.type === "permission_requested"));
});

// ── N4：零宽字符填充过校验 ───────────────────────────────────────────

test("(N4) zero-width padded acknowledgement no longer passes the gate", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build")); // 记录挑战
  // 27 字符（视觉空白论证）在修复前通过校验 → ask；剥零宽后是纯确认词 → 无效。
  const padded = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", "ok" + "\u200b".repeat(25)),
  );
  assert.deepEqual(pick(padded), ["deny", RULE.insufficient]);
});

test("(N4) occasional zero-width chars in real prose are judged by the stripped content", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const stegged = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", VALID_JUST.split("the").join("th\u200be")),
  );
  assert.deepEqual(pick(stegged), ["ask", RULE.ask]);
});

test("(N4) a zero-width-only justification is invalid", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const only = service.checkPermission(bashCtx(CONFIRM_CMD, "build", "\u200b".repeat(40)));
  assert.deepEqual(pick(only), ["deny", RULE.insufficient]);
});

// ── N6：gate 决策观测（方案 a） ──────────────────────────────────────

test("(N6) the breakerAsk decision emits a distinct audit entry", () => {
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
    const invalid = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", "yes ok proceed"));
    assert.deepEqual(pick(invalid), ["ask", RULE.breakerAsk]);
  } finally {
    setBashReflexAuditSink(undefined);
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, "bash_reflex_gate_breaker_ask");
  assert.equal(captured[0].ruleId, RULE.breakerAsk);
  assert.equal(captured[0].command, CONFIRM_CMD);
  assert.ok(captured[0].justification.includes("yes ok proceed"));
  assert.ok(Array.isArray(captured[0].assessmentReasons) && captured[0].assessmentReasons.length > 0);
  assert.ok(!Number.isNaN(Date.parse(captured[0].timestamp)));
});

test("(N6) the resolved info log carries the decision ruleId", async () => {
  const service = makeService();
  // 反射轮走真实投递路径（同一 sessionId），挑战键与第二轮一致。
  await runFlow(service, "session-1", CONFIRM_CMD, "build");
  const logCalls = [];
  const second = await runFlow(service, "session-1", CONFIRM_CMD, "build", VALID_JUST, logCalls);
  assert.equal(second.flow.allowed, true); // broker 桩批准 → resolved 日志产生
  const resolved = logCalls.find(([message]) => message === "Tool permission resolved");
  assert.ok(resolved, "Tool permission resolved info log missing");
  assert.equal(resolved[1].ruleId, RULE.ask);
  assert.equal(resolved[1].event, "tool.permission.resolved");
});

// ── N7：gate 层 justification 长度上限 ───────────────────────────────

test("(N7) an over-length justification is invalid even when its content is substantive", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build")); // 记录挑战
  const long = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", `${VALID_JUST} ${"detailed analysis. ".repeat(300)}`),
  );
  assert.deepEqual(pick(long), ["deny", RULE.insufficient]);

  // allow lane 同样按无效处理：收敛到 breakerAsk（用户裁决），不拿 auditedAllow。
  const yoloService = makeService();
  yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
  const yoloLong = yoloService.checkPermission(
    bashCtx(CONFIRM_CMD, "yolo", `${VALID_JUST} ${"detailed analysis. ".repeat(300)}`),
  );
  assert.deepEqual(pick(yoloLong), ["ask", RULE.breakerAsk]);
});

test("(N7) the 4000-char boundary itself stays valid (schema-contract parity)", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const atLimit = service.checkPermission(bashCtx(CONFIRM_CMD, "build", "a".repeat(4000)));
  assert.deepEqual(pick(atLimit), ["ask", RULE.ask]);
  const overLimit = service.checkPermission(bashCtx(CONFIRM_CMD, "build", "a".repeat(4001)));
  assert.deepEqual(pick(overLimit), ["deny", RULE.insufficient]);
});

// ── N9：盲目重试文案（仅措辞，决策语义不变） ─────────────────────────

test("(N9) the blind-retry copy explains that prior approval does not unlock a re-issue", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const retry = service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.deepEqual(pick(retry), ["deny", RULE.reflect]);
  assert.match(retry.reason, /Repeating the identical call cannot unlock it/);
  assert.match(retry.reason, /even if the same command was approved earlier/);
  assert.match(retry.reason, /`justification`/);
});

// ── F1：substantive justification 校验的拼接/字符族绕过（对抗复核修复轮 3） ──

test("(F1) concatenated acknowledgement words are rejected on both lanes", () => {
  // 修复前：单一 token 不在黑名单集合，四个拼接形态在 yolo（allow lane）全部拿到
  // auditedAllow——confirm 级破坏命令静默放行；build（ask lane）被当作有效论证。
  const forms = [
    ["y x25", "y".repeat(25)],
    ["确认 x13", "确认".repeat(13)],
    ["ok x13", "ok".repeat(13)],
    ["yes x9", "yes".repeat(9)],
  ];
  for (const [name, just] of forms) {
    const buildService = makeService();
    buildService.checkPermission(bashCtx(CONFIRM_CMD, "build")); // 反射轮
    assert.deepEqual(
      pick(buildService.checkPermission(bashCtx(CONFIRM_CMD, "build", just))),
      ["deny", RULE.insufficient],
      `ask lane must reject ${name}`,
    );
    const yoloService = makeService();
    yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
    assert.deepEqual(
      pick(yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo", just))),
      ["ask", RULE.breakerAsk],
      `allow lane must converge to breakerAsk (never auditedAllow) for ${name}`,
    );
  }
});

test("(F1) invisible-character families outside the enumerated list are stripped", () => {
  // U+061C/U+0600/U+E0020/U+110BD 是通用类别 Cf（\p{Cf} 属性类一次覆盖）；
  // U+3164/U+2800/U+FFA0 字形是空白但类别不是 Cf（显式清单）。修复前 7/7 族
  // 「ok」+25×填充全部通过校验（审计与弹窗里视觉空白论证）。
  const families = ["\u061C", "\u0600", "\u{E0020}", "\u{110BD}", "\u3164", "\u2800", "\uFFA0"];
  for (const family of families) {
    const just = `ok${family.repeat(25)}`;
    const label = `U+${family.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    const buildService = makeService();
    buildService.checkPermission(bashCtx(CONFIRM_CMD, "build"));
    assert.deepEqual(
      pick(buildService.checkPermission(bashCtx(CONFIRM_CMD, "build", just))),
      ["deny", RULE.insufficient],
      `${label} must be stripped before judging`,
    );
    const yoloService = makeService();
    yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
    assert.deepEqual(
      pick(yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo", just))),
      ["ask", RULE.breakerAsk],
      `${label} must never reach auditedAllow`,
    );
  }
});

test("(F1) a real argument with occasional format characters stays valid", () => {
  // 不回归：正常文本偶发 \p{Cf} 字符（此处 U+061C）按剥后内容判——仍是有效论证。
  const stegged = VALID_JUST.split("user").join("us\u061Cer");
  assert.notEqual(stegged, VALID_JUST);
  const buildService = makeService();
  buildService.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.deepEqual(pick(buildService.checkPermission(bashCtx(CONFIRM_CMD, "build", stegged))), [
    "ask",
    RULE.ask,
  ]);
  const yoloService = makeService();
  yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
  assert.deepEqual(pick(yoloService.checkPermission(bashCtx(CONFIRM_CMD, "yolo", stegged))), [
    "allow",
    RULE.auditedAllow,
  ]);
});

test("(F1) digit-padded acknowledgement is rejected too (same filler family)", () => {
  // 归一化把数字同剥：25 字符的 "ok"+"1"*23 与词拼接是同族无语义填充。
  const just = `ok${"1".repeat(23)}`;
  const buildService = makeService();
  buildService.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.deepEqual(pick(buildService.checkPermission(bashCtx(CONFIRM_CMD, "build", just))), [
    "deny",
    RULE.insufficient,
  ]);
});

// ── F2/F3：审计脱敏覆盖缺口与句法保真（对抗复核修复轮 3） ───────────

test("(F2) the six credential leak forms and the quoted Bearer value never reach the audit entry", () => {
  // 修复前实测：tok_abc…/sk_UNDERSCORE…/SK-UPPERCASE…/ghp_…/AKIA…/PEM 块六个真值
  // 全部落入审计 JSONL（JSON 引号键独缺 token、api-key 无大小写与下划线变体、无
  // gh/AWS/PEM 形态），`Bearer "quoted secret value"` 残留多词值。
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    const just =
      VALID_JUST +
      '. Probe payloads: {"token": "tok_abc123def456"} | sk_UNDERSCOREKEY123456 | ' +
      "SK-UPPERCASE12345678 | ghp_GITHUBPAT1234567890 | AKIAIOSFODNN7EXAMPLE | " +
      "-----BEGIN RSA PRIVATE KEY----- Qk9EWS0xMjM0NTY3OA== -----END RSA PRIVATE KEY----- | " +
      'Bearer "quoted secret value" | ' +
      'curl -H "Authorization: Bearer sk-bearerquoted999" https://api.example.com';
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
    const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", just));
    assert.deepEqual(pick(allowed), ["allow", RULE.auditedAllow]);
  } finally {
    setBashReflexAuditSink(undefined);
  }
  assert.equal(captured.length, 1);
  const entry = captured[0];
  const flat = JSON.stringify(entry);
  // 多凭据并存仍全灭（AGENTS.md 日志红线）。
  for (const truth of [
    "tok_abc123def456",
    "sk_UNDERSCOREKEY123456",
    "SK-UPPERCASE12345678",
    "ghp_GITHUBPAT1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "RSA PRIVATE KEY",
    "Qk9EWS0xMjM0NTY3OA",
    "quoted secret value",
    "sk-bearerquoted999",
  ]) {
    assert.ok(!flat.includes(truth), `${truth} must not reach the audit log`);
  }
  // REDACTED 标记按类别出现（含整块替换的 PEM 与引号整体吃掉的 Bearer 值）。
  assert.ok(entry.justification.includes('"token": "[REDACTED:credential-field]"'));
  assert.ok(entry.justification.includes("[REDACTED:api-key]"));
  assert.ok(entry.justification.includes("[REDACTED:gh-token]"));
  assert.ok(entry.justification.includes("[REDACTED:aws-key]"));
  assert.ok(entry.justification.includes("[REDACTED:private-key]"));
  assert.ok(entry.justification.includes("[REDACTED:auth-scheme]"));
  // 非凭据内容逐字保留。
  assert.ok(entry.justification.startsWith(VALID_JUST));
});

test("(F3) redaction keeps command syntax: quotes stay paired and non-credential text verbatim", () => {
  // 修复前：方案头 \S+ 与赋值形态级联把闭合引号吞掉，脱敏结果双引号 2→1（不配对）。
  const captured = [];
  setBashReflexAuditSink((entry) => captured.push(entry));
  try {
    const service = makeService();
    const just =
      'The user explicitly asked to clean this workspace. curl -H "Authorization: Bearer sk-bearerquoted999" https://api.example.com';
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", just));
  } finally {
    setBashReflexAuditSink(undefined);
  }
  const entry = captured[0];
  const count = (text, ch) => text.split(ch).length - 1;
  assert.equal(count(entry.justification, '"'), 2, "脱敏后引号必须配对");
  assert.ok(entry.justification.includes('curl -H "'), "非凭据前缀逐字保留");
  assert.ok(entry.justification.includes('" https://api.example.com'), "闭合引号必须保留");
  assert.ok(!entry.justification.includes("sk-bearerquoted999"));
});

// ── 共用：真实投递路径驱动（含 N6 的 logger/broker 桩） ──────────────

const TRACE_CONTEXT = { traceId: "trace-1", sessionId: "session-1" };
const NO_HOOKS = { additionalContexts: [] };

function makeFlowDeps(service, sessionId, emitted, logCalls) {
  return {
    sessionId,
    turnId: "turn-1",
    permissionService: service,
    // ask 路径需要一个 broker 桩；deny 在 broker 之前早退，用不到它。
    permissionBroker: { requestPermission: async () => ({ decision: "allow" }) },
    defaultTimeoutMs: 1000,
    getWorkingDirectory: () => WORKSPACE,
    getWorkspaceRoot: () => WORKSPACE,
    emitEvent: async (event) => {
      emitted.push(event);
    },
    logger: {
      info: (message, context) => logCalls?.push([message, context]),
      warn: () => {},
      debug: () => {},
      error: () => {},
    },
  };
}

async function runFlow(service, sessionId, command, mode, justification, logCalls) {
  const emitted = [];
  const deps = makeFlowDeps(service, sessionId, emitted, logCalls);
  const input = justification === undefined ? { command } : { command, justification };
  const flow = await resolveToolPermission(
    deps,
    { id: "tool-call-1", name: "Bash", input },
    bashToolEntry,
    input,
    NO_HOOKS,
    mode,
    { ...TRACE_CONTEXT, sessionId },
  );
  return { flow, emitted };
}
