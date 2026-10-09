import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * J1-2 验收测试：Bash Confirm 级反射门（不可重试 justification 协议）。
 *
 * 覆盖规格 apps/acode-cli/specs/bash-confirm-reflexive-gate.md 的 R1–R7 与验收矩阵：
 * 盲目重试仍拒；短/确认词 justification 拒；nonce 防预填；有效 justification 后
 * ask 携带原文；yolo 下审计日志产生；与 J1-1 熔断的优先级关系。
 * 机制对照 jcode (MIT) crates/jcode-command-risk/src/gate.rs 的测试集自撰翻译。
 */

const { PermissionService } = await import("../packages/core/src/permission/service.ts");

const WORKSPACE = join(tmpdir(), "acode-j12-reflex-workspace");

/** confirm 级且不命中既有三类熔断的命令（管道喂给删除类，J1-1 矩阵同款）。 */
const CONFIRM_CMD = "cat paths.txt | xargs rm -rf";
const CONFIRM_CMD_2 = "find / -execdir mystery {} +";
const VALID_JUST =
  "The user explicitly asked to delete every file listed in paths.txt from this workspace";

const RULE = {
  reflect: "gate.bashConfirmReflex.reflect",
  insufficient: "gate.bashConfirmReflex.insufficientJustification",
  ask: "gate.bashConfirmReflex.ask",
  breakerAsk: "gate.bashConfirmReflex.breakerAsk",
  auditedAllow: "gate.bashConfirmReflex.auditedAllow",
};

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
}

function bashCtx(command, mode = "build", justification) {
  return {
    toolName: "Bash",
    input: justification === undefined ? { command } : { command, justification },
    riskLevel: "high",
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

/** 在 fn 执行期间捕获缺省审计 sink（console.warn，stderr 通道）的输出。 */
async function captureAuditWarnings(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

// ── R2/R5：ask lane（build 模式） ────────────────────────────────────

test("(R1) ask lane: first confirm-level call is denied with the reflex four questions", () => {
  const service = makeService();
  const decision = service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, RULE.reflect);
  // 四问 + justification 指引回喂给模型。
  assert.match(decision.reason, /Which specific thing the user asked for/);
  assert.match(decision.reason, /narrower target/);
  assert.match(decision.reason, /recovered/);
  assert.match(decision.reason, /ask the user instead/);
  assert.match(decision.reason, /`justification`/);
  // 措辞不披露分级阈值与内部级别名（R3）。
  assert.ok(!decision.reason.includes("25"));
  assert.ok(!/blacklist/i.test(decision.reason));
  assert.ok(!/risk level/i.test(decision.reason));
});

test("(R2) blind retry of the identical call fails again", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const retry = service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.equal(retry.decision, "deny");
  assert.equal(retry.ruleId, RULE.reflect);
  assert.match(retry.reason, /Repeating the identical call cannot unlock it/);
  // 第三次盲目重试同样拒。
  const retry2 = service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.equal(retry2.decision, "deny");
});

test("(R3) short and acknowledgement-only justifications are rejected in ask lane", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build")); // 记录挑战

  const short = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", "run the cleanup"), // < 25 字符
  );
  assert.equal(short.decision, "deny");
  assert.equal(short.ruleId, RULE.insufficient);
  assert.match(short.reason, /does not explain what the user asked for/);

  const ackCombo = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", "ok, go ahead and do it now, yes"), // 全部是确认词
  );
  assert.equal(ackCombo.decision, "deny");
  assert.equal(ackCombo.ruleId, RULE.insufficient);

  const ackSingle = service.checkPermission(
    bashCtx(CONFIRM_CMD, "build", "proceed."), // 纯确认词 + 标点
  );
  assert.equal(ackSingle.decision, "deny");
  assert.equal(ackSingle.ruleId, RULE.insufficient);
});

test("(R5) valid justification in ask lane proceeds to ask carrying the original text", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build")); // 反射轮
  const decision = service.checkPermission(bashCtx(CONFIRM_CMD, "build", VALID_JUST));
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, RULE.ask);
  // ask 的 reason 携带 justification 原文，供审批弹窗与协议侧展示。
  assert.ok(decision.reason.includes(VALID_JUST));
  assert.match(decision.reason, /matches what you actually asked for/);
});

// ── R4：nonce 防预填 ─────────────────────────────────────────────────

test("(R4) prefilled justification on a fresh gate does not unlock; it only records the challenge", () => {
  const service = makeService();
  // 首次调用即带有效 justification：没有经过反射 prompt，不计为应答。
  const prefilled = service.checkPermission(bashCtx(CONFIRM_CMD, "build", VALID_JUST));
  assert.equal(prefilled.decision, "deny");
  assert.equal(prefilled.ruleId, RULE.reflect);
  assert.match(prefilled.reason, /was not counted/);

  // 同一 justification 在 prompt 之后重提 → 有效。
  const after = service.checkPermission(bashCtx(CONFIRM_CMD, "build", VALID_JUST));
  assert.equal(after.decision, "ask");
  assert.equal(after.ruleId, RULE.ask);
});

test("(R4) challenges are per-command: a different command gets its own reflex round", () => {
  const service = makeService();
  service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  const other = service.checkPermission(bashCtx(CONFIRM_CMD_2, "build", VALID_JUST));
  assert.equal(other.decision, "deny"); // 预填对新命令同样无效
  assert.equal(other.ruleId, RULE.reflect);
  const otherAfter = service.checkPermission(bashCtx(CONFIRM_CMD_2, "build", VALID_JUST));
  assert.equal(otherAfter.decision, "ask");
});

// ── R2/R6：allow lane（yolo） ────────────────────────────────────────

test("(R6) yolo: invalid justification converges to breaker ask, valid allows with an audit entry", async () => {
  const service = makeService();
  const audits = [];

  const first = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
  assert.equal(first.decision, "deny");
  assert.equal(first.ruleId, RULE.reflect);

  const blind = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
  assert.equal(blind.decision, "deny"); // yolo 下盲目重试同样拒

  const invalid = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", "yes ok proceed"));
  assert.equal(invalid.decision, "ask"); // 无效论证收敛到用户裁决
  assert.equal(invalid.ruleId, RULE.breakerAsk);

  const captured = await captureAuditWarnings(async () => {
    const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.ruleId, RULE.auditedAllow);
  });
  for (const line of captured) {
    if (line.startsWith("[bash-reflex-audit] ")) {
      audits.push(JSON.parse(line.slice("[bash-reflex-audit] ".length)));
    }
  }
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event, "bash_reflex_gate_audited_allow");
  assert.equal(audits[0].ruleId, RULE.auditedAllow);
  assert.equal(audits[0].command, CONFIRM_CMD);
  assert.equal(audits[0].justification, VALID_JUST);
  assert.ok(Array.isArray(audits[0].assessmentReasons) && audits[0].assessmentReasons.length > 0);
  assert.ok(!Number.isNaN(Date.parse(audits[0].timestamp)));
});

// ── R7：与 J1-1 熔断的优先级（门不介入、不叠加） ─────────────────────

test("(R7) catastrophic deny and class-1 breaker hits bypass the gate entirely", () => {
  const service = makeService();
  const catastrophic = service.checkPermission(bashCtx("rm -rf ~", "yolo"));
  assert.equal(catastrophic.decision, "deny");
  assert.equal(catastrophic.ruleId, "breaker.bashTargetCatastrophic");

  const classOne = service.checkPermission(bashCtx('rm -rf "$OUT"/', "yolo"));
  assert.equal(classOne.decision, "ask");
  assert.equal(classOne.ruleId, "breaker.bashRootDelete");
});

test("(R8) safe/low commands and non-Bash tools never enter the gate", () => {
  const service = makeService();
  const safe = service.checkPermission(bashCtx("ls -la", "yolo"));
  assert.equal(safe.decision, "allow");
  assert.equal(safe.ruleId, "mode.yolo");

  const low = service.checkPermission(bashCtx("rm -rf node_modules", "yolo"));
  assert.equal(low.decision, "allow");
  assert.equal(low.ruleId, "mode.yolo");

  const write = service.checkPermission({
    toolName: "Write",
    input: { file_path: join(WORKSPACE, "notes.md") },
    riskLevel: "medium",
    mode: "yolo",
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  });
  assert.equal(write.decision, "allow");
  assert.equal(write.ruleId, "mode.yolo");
});

// ── R7：deny 决策不进门（plan 模式 / disallowedTools 原样） ──────────

test("(R7) existing deny decisions are never relaxed or rewritten by the gate", () => {
  const service = makeService({ disallowedTools: ["Bash"] });
  const denied = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
  assert.equal(denied.decision, "deny");
  assert.equal(denied.ruleId, "rule.disallowedTools");

  const planMode = makeService().checkPermission(bashCtx(CONFIRM_CMD, "plan"));
  assert.equal(planMode.decision, "deny");
  assert.notEqual(planMode.ruleId, RULE.reflect);
});

// ── 评审 J1-2 修复：投递边界与审计落盘 ───────────────────────────────

const { bashToolEntry } = await import("../packages/core/src/tool/handlers/bash.ts");
const { resolveToolPermission } =
  await import("../packages/core/src/tool/executor/permission-flow.ts");
const { createPermissionErrorResult } =
  await import("../packages/core/src/tool/executor/errors.ts");
// 直接从模块路径导入：core 的 barrel（src/index.ts）在 tsx 下有循环导入问题
// （tool/executor.js 的 ToolExecutor），而 gate 模块本身就是 sink 注册点的所有者。
const { setBashReflexAuditSink } =
  await import("../packages/core/src/permission/bash-confirm-reflex-gate.ts");

/** 驱动真实投递路径所需的最小 executor deps（deny 早退，不触 broker/hook）。 */
function makeExecutorDeps(service, emitted = []) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    permissionService: service,
    getWorkingDirectory: () => WORKSPACE,
    getWorkspaceRoot: () => WORKSPACE,
    emitEvent: async (event) => {
      emitted.push(event);
    },
  };
}

const TRACE_CONTEXT = { traceId: "trace-1", sessionId: "session-1" };
const NO_HOOKS = { additionalContexts: [] };

async function runPermissionFlow(service, command, mode, justification) {
  const emitted = [];
  const deps = makeExecutorDeps(service, emitted);
  const input = justification === undefined ? { command } : { command, justification };
  const toolCall = { id: "tool-call-1", name: "Bash", input };
  const flow = await resolveToolPermission(
    deps,
    toolCall,
    bashToolEntry,
    input,
    NO_HOOKS,
    mode,
    TRACE_CONTEXT,
  );
  return { flow, emitted };
}

test("(review F9) the reflex prompt reaches the model verbatim through the tool-error channel", async () => {
  const service = makeService();
  const decision = service.checkPermission(bashCtx(CONFIRM_CMD, "build"));
  assert.equal(decision.ruleId, RULE.reflect);
  // 首轮反射文案约 1000 字符：四问 + 「re-issue with a justification」解锁协议。
  assert.ok(decision.reason.length > 500, `reason length ${decision.reason.length}`);

  // 走真实投递路径（resolveToolPermission → createPermissionErrorResult）：模型看到的
  // error.message 必须是完整文案，不能被 sanitizeText 压平并截到 500 字符。
  const { flow, emitted } = await runPermissionFlow(makeService(), CONFIRM_CMD, "build");
  assert.equal(flow.allowed, false);
  const message = flow.result.error.message;
  assert.equal(message.length, decision.reason.length);
  assert.ok(!message.endsWith("..."), "message must not be truncated");
  assert.match(message, /Which specific thing the user asked for/); // Q1
  assert.match(message, /something you inferred/); // Q2
  assert.match(message, /narrower target/); // Q3
  assert.match(message, /can its effects be recovered/); // Q4
  assert.match(message, /`justification`/); // 解锁协议
  assert.match(message, /\n/, "line structure must survive (not flattened to one line)");
  assert.equal(flow.result.error.ruleId ?? undefined, undefined);
  // denied 事件照常发出（R7：任何失败形态都不静默）。
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "permission_denied");
  assert.equal(emitted[0].payload.reason.length, decision.reason.length);
});

test("(review F9) blind retry and insufficient-justification prompts are delivered verbatim too", async () => {
  const service = makeService();
  await runPermissionFlow(service, CONFIRM_CMD, "build"); // 反射轮，记录挑战
  const retry = await runPermissionFlow(service, CONFIRM_CMD, "build");
  assert.equal(retry.flow.allowed, false);
  assert.match(retry.flow.result.error.message, /Repeating the identical call cannot unlock it/);
  assert.match(retry.flow.result.error.message, /`justification`/);

  const insufficient = await runPermissionFlow(service, CONFIRM_CMD, "build", "proceed.");
  assert.equal(insufficient.flow.allowed, false);
  assert.match(insufficient.flow.result.error.message, /does not explain what the user asked for/);
  assert.match(insufficient.flow.result.error.message, /`justification`/);
});

test("(review F9) non-gate denials keep the existing sanitized projection", () => {
  // 收窄到 gate.* ruleId：其余 deny 文案仍走既有投影（压平 + 500 字符上限），
  // 避免把 provider 错误摘要的保护一起关掉。
  const toolCall = { id: "tool-call-2", name: "Bash", input: { command: "rm -rf ~" } };
  const longReason = `blocked: ${"x".repeat(700)}`;
  const projected = createPermissionErrorResult(toolCall, longReason, {
    decision: "deny",
    ruleId: "breaker.bashTargetCatastrophic",
  });
  assert.equal(projected.error.message.length, 500);
  assert.ok(projected.error.message.endsWith("..."));

  // J1-1 的 catastrophic 文案本身短于上限，完整送达（既有行为不变）。
  const catastrophic = makeService().checkPermission(bashCtx("rm -rf ~", "yolo"));
  const delivered = createPermissionErrorResult(toolCall, catastrophic.reason, {
    decision: "deny",
    ruleId: catastrophic.ruleId,
  });
  assert.equal(delivered.error.message.replace(/\s+/g, " ").trim(), catastrophic.reason);
});

test("(review F10) the audit sink is replaceable and the replacement receives the entry", async () => {
  const captured = [];
  const warnings = await captureAuditWarnings(async () => {
    setBashReflexAuditSink((entry) => captured.push(entry));
    try {
      const service = makeService();
      service.checkPermission(bashCtx(CONFIRM_CMD, "yolo")); // 反射轮
      const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
      assert.equal(allowed.decision, "allow");
      assert.equal(allowed.ruleId, RULE.auditedAllow);
    } finally {
      setBashReflexAuditSink(undefined);
    }
  });
  // 替换 sink 后缺省 stderr 通道不再重复输出（同一条审计只有一个所有者）。
  assert.equal(warnings.filter((line) => line.includes("[bash-reflex-audit]")).length, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, "bash_reflex_gate_audited_allow");
  assert.equal(captured[0].ruleId, RULE.auditedAllow);
  assert.equal(captured[0].command, CONFIRM_CMD);
  assert.equal(captured[0].justification, VALID_JUST);
});

test("(review F10) a failing audit sink never changes the permission decision", () => {
  setBashReflexAuditSink(() => {
    throw new Error("audit transport down");
  });
  try {
    const service = makeService();
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
    const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.ruleId, RULE.auditedAllow);
  } finally {
    setBashReflexAuditSink(undefined);
  }
});

test("(review F10) the audited allow is persisted to the JSONL log file via the wired sink", async () => {
  // plan 验收项「yolo 下审计日志落盘」：gate 的缺省 sink 只写一行易失 stderr，
  // bootstrap/create-app.ts 用 setBashReflexAuditSink 接到 info 级 Logger，
  // NodeFileLogger 以 appendFileSync 写 JSONL（@acode/adapters/logging）。
  // 这里用真实 logger 工厂 + 临时 logDir 验证「同一接线形态 → 磁盘上有一条记录」。
  const { createNodeLoggerFactory } = await import("../packages/adapters/src/logging/index.ts");
  const { readdir, readFile } = await import("node:fs/promises");
  const logDir = join(
    tmpdir(),
    `acode-j12-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const factory = createNodeLoggerFactory({ logDir });
  const auditLogger = factory.createLogger("acode").child({ module: "core.permission" });

  setBashReflexAuditSink((entry) => {
    auditLogger.info("Bash reflex gate allowed a confirm-level command", {
      assessmentReasons: entry.assessmentReasons,
      command: entry.command,
      event: entry.event,
      justification: entry.justification,
      ruleId: entry.ruleId,
      status: "completed",
      timestamp: entry.timestamp,
    });
  });
  try {
    const service = makeService();
    service.checkPermission(bashCtx(CONFIRM_CMD, "yolo"));
    const allowed = service.checkPermission(bashCtx(CONFIRM_CMD, "yolo", VALID_JUST));
    assert.equal(allowed.ruleId, RULE.auditedAllow);
  } finally {
    setBashReflexAuditSink(undefined);
  }

  const files = (await readdir(logDir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1, `expected one JSONL log file, got ${JSON.stringify(files)}`);
  const lines = (await readFile(join(logDir, files[0]), "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const audit = lines.find((line) => line.event === "bash_reflex_gate_audited_allow");
  assert.ok(audit, `audit line missing from ${JSON.stringify(lines.map((l) => l.event))}`);
  assert.equal(audit.level, "info");
  assert.equal(audit.module, "core.permission");
  assert.equal(audit.context.ruleId, RULE.auditedAllow);
  assert.equal(audit.context.command, CONFIRM_CMD);
  assert.equal(audit.context.justification, VALID_JUST);
  assert.ok(!Number.isNaN(Date.parse(audit.context.timestamp)));
});

test("(review F10) bootstrap wires the audit sink to the info-level logger", async () => {
  // 接线守卫：gate 侧只提供可替换 sink，真正落盘的注册点在 create-app.ts。
  // 没有这条断言，上面的落盘测试就只是在测一个测试里临时搭的接线。
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    join(import.meta.dirname, "..", "packages", "bootstrap", "src", "app", "create-app.ts"),
    "utf8",
  );
  // 多 App 场景使用按 session 路由的注册 API，避免进程级 sink 串线。
  assert.match(source, /registerBashReflexAuditSink\(/);
  assert.match(source, /permissionAuditLogger\.info\(/);
  assert.match(source, /entry\.justification/);
  assert.match(source, /entry\.command/);
});
