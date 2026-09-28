import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P2 的验收测试：旁路免疫熔断器（bypass-immune circuit breakers）。
 *
 * 覆盖规格 apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md
 * 的 R2/R3 与验收场景 8–12。纯函数测试 + PermissionService 集成断言，无文件系统副作用。
 */

const { evaluateBypassImmuneBreakers } = await import(
  "../packages/core/src/permission/bypass-immune-breakers.ts"
);
const { PermissionService } = await import("../packages/core/src/permission/service.ts");

const WORKSPACE = join(tmpdir(), "acode-p2-breaker-workspace");

function bash(command) {
  return { toolName: "Bash", input: { command } };
}

// ── 类 1：空变量根删除 ────────────────────────────────────────────────

test("(8a) unresolved expansion in forced delete fires the breaker", () => {
  // 主形态：变量为空时 `rm -rf "$DIR"/` 等价于删根。
  const hit = evaluateBypassImmuneBreakers(bash('rm -rf "$BUILD_DIR"/'));
  assert.equal(hit?.ruleId, "breaker.bashRootDelete");
  // 大小写与旗标组合形态同样命中。
  assert.equal(evaluateBashRootDelete("rm -Rf ${DIR}"), "breaker.bashRootDelete");
  assert.equal(evaluateBashRootDelete("rm --recursive --force $TARGET"), "breaker.bashRootDelete");
});

function evaluateBashRootDelete(command) {
  return evaluateBypassImmuneBreakers(bash(command))?.ruleId;
}

test("(8b) literal root/home targets fire; ordinary relative deletes do not", () => {
  assert.equal(evaluateBashRootDelete("rm -rf /"), "breaker.bashRootDelete");
  assert.equal(evaluateBashRootDelete("rm -rf ~"), "breaker.bashRootDelete");
  assert.equal(evaluateBashRootDelete("rm -rf $HOME"), "breaker.bashRootDelete");
  assert.equal(evaluateBashRootDelete(`rm -rf "${homedir()}"`), "breaker.bashRootDelete");
  // 普通工作区删除不受影响（yolo 照常直通）。
  assert.equal(evaluateBashRootDelete("rm -rf ./build"), undefined);
  assert.equal(evaluateBashRootDelete("rm file.txt"), undefined);
  // 非删除类命令即使命中其它形态也不触发本类。
  assert.equal(evaluateBashRootDelete("ls /"), undefined);
});

test("(8c) unparseable delete text fails closed to the breaker", () => {
  // 超过解析上限（10k）→ hasParseErrors；文本含 rm 即熔断。
  const huge = `rm -rf ${"x".repeat(20_000)}`;
  assert.equal(evaluateBashRootDelete(huge), "breaker.bashRootDelete");
  // 解析失败但无删除类关键字 → 不触发（非删除类不受影响）。
  const hugeSafe = `echo ${"x".repeat(20_000)}`;
  assert.equal(evaluateBashRootDelete(hugeSafe), undefined);
});

// ── 类 2：路径逃逸写 ──────────────────────────────────────────────────

test("(9) write outside workspaceRoot fires; inside does not; no root no fire", () => {
  const outside = evaluateBypassImmuneBreakers({
    toolName: "Write",
    input: { file_path: join(WORKSPACE, "..", "escaped.txt") },
    workspaceRoot: WORKSPACE,
    workingDirectory: WORKSPACE,
  });
  assert.equal(outside?.ruleId, "breaker.pathEscapeWrite");

  const inside = evaluateBypassImmuneBreakers({
    toolName: "Edit",
    input: { file_path: join(WORKSPACE, "src", "ok.ts") },
    workspaceRoot: WORKSPACE,
    workingDirectory: WORKSPACE,
  });
  assert.equal(inside, undefined);

  // 拿不到 workspaceRoot：该类熔断器不触发（容错哲学），不误拦无根上下文。
  const noRoot = evaluateBypassImmuneBreakers({
    toolName: "Write",
    input: { file_path: "/etc/passwd" },
    workingDirectory: WORKSPACE,
  });
  assert.equal(noRoot?.ruleId, undefined);
});

// ── 类 3：敏感位置读 ──────────────────────────────────────────────────

test("(10) reads of credential locations fire; workspace reads do not", () => {
  const sshKey = evaluateBypassImmuneBreakers({
    toolName: "Read",
    input: { file_path: join(homedir(), ".ssh", "id_rsa") },
  });
  assert.equal(sshKey?.ruleId, "breaker.sensitiveRead");

  // 相对路径穿越到敏感位置同样命中（先按 workingDirectory 解析再匹配）。
  const traversal = evaluateBypassImmuneBreakers({
    toolName: "Read",
    input: { file_path: join("..", "..", ".ssh", "id_ed25519") },
    workingDirectory: join(homedir(), "a", "b"),
  });
  assert.equal(traversal?.ruleId, "breaker.sensitiveRead");

  // Bash 文本引用凭据位置也命中。
  const bashCred = evaluateBashSensitive("cat ~/.aws/credentials");
  assert.equal(bashCred, "breaker.sensitiveRead");

  // 工作区内普通读取不受影响。
  const normal = evaluateBypassImmuneBreakers({
    toolName: "Read",
    input: { file_path: join(WORKSPACE, "src", "index.ts") },
    workingDirectory: WORKSPACE,
  });
  assert.equal(normal, undefined);
});

function evaluateBashSensitive(command) {
  return evaluateBypassImmuneBreakers(bash(command))?.ruleId;
}

// ── PermissionService 集成（R3：只降级 allow，deny/ask 原样） ─────────

function makeService(extra = {}) {
  return new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(extra.disallowedTools ?? []),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
}

function bashCtx(command, mode = "yolo") {
  return {
    toolName: "Bash",
    input: { command },
    riskLevel: "high",
    mode,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

test("(11a) yolo + dangerous delete downgrades to ask via breaker", () => {
  const decision = makeService().checkPermission(bashCtx('rm -rf "$OUT"/'));
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "breaker.bashRootDelete");
});

test("(11b) yolo + ordinary command still fast-allows", () => {
  const decision = makeService().checkPermission(bashCtx("ls -la"));
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("(11c) breaker never weakens deny: disallowed tool stays denied", () => {
  const decision = makeService({ disallowedTools: ["Bash"] }).checkPermission(
    bashCtx('rm -rf "$OUT"/'),
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("(11d) build mode side-effect ask keeps its own ruleId (breaker only downgrades allow)", () => {
  // build 模式下副作用动作本来就是 ask（mode.build.sideEffect）；熔断器不覆写既有 ask。
  const decision = makeService().checkPermission(bashCtx('rm -rf "$OUT"/', "build"));
  assert.equal(decision.decision, "ask");
  assert.notEqual(decision.ruleId, "breaker.bashRootDelete");
});

test("(11e) alwaysAsk tools keep alwaysAsk semantics", () => {
  const decision = makeService().checkPermission(
    {
      toolName: "AskUserQuestion",
      input: {},
      riskLevel: "low",
      mode: "yolo",
      workingDirectory: WORKSPACE,
      workspaceRoot: WORKSPACE,
    },
    { requiresUserInteraction: true },
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.userInteraction");
});

test("(12) workspace-scoped write in yolo is untouched by breakers", () => {
  const decision = makeService().checkPermission(
    {
      toolName: "Write",
      input: { file_path: join(WORKSPACE, "notes.md") },
      riskLevel: "medium",
      mode: "yolo",
      workingDirectory: WORKSPACE,
      workspaceRoot: WORKSPACE,
    },
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("(12b) escaping write in yolo downgrades to ask", () => {
  const outside = join(WORKSPACE, "..", "pwned.txt");
  const decision = makeService().checkPermission(
    {
      toolName: "Write",
      input: { file_path: outside },
      riskLevel: "medium",
      mode: "yolo",
      workingDirectory: WORKSPACE,
      workspaceRoot: WORKSPACE,
    },
    { readOnly: false, destructive: false, sideEffectScope: "workspace", needsApproval: true },
  );
  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "breaker.pathEscapeWrite");
});

// sep 引用防止未使用导入告警（跨平台路径拼接断言里用到）。
test("path separator sanity", () => {
  assert.ok(sep.length > 0);
});
