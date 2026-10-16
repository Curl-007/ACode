import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * T2-1 闭集 reason 词表验收（specs/error-taxonomy-injection-defense.md R1/R2 + 场景 1-4）：
 * - 场景 1：三词表形态与谓词/收窄器的拒绝语义（非法 token 绝不透传）；
 * - 场景 2：permissionDenied 工厂的 reason 收窄（闭集进 context.reason，自由文本进 reasonDetail）；
 * - 场景 3：error-payload attribution.reason 闭集化（分类器映射 / 精确 token / 自由文本缺席且 detail 保留）；
 * - 场景 4：runner 启动失败面接线钉住（每个结构化抛错点携带闭集 reason token）。
 */

const {
  AgentLaunchFailureReason,
  PermissionDenialReason,
  SessionErrorClass,
  isAgentLaunchFailureReason,
  isPermissionDenialReason,
  isSessionErrorClass,
  isClosedErrorReasonToken,
  narrowExternalReasonToken,
  narrowExternalClosedReasonToken,
  classifyPermissionDenialText,
  classifySessionErrorText,
  narrowErrorReasonToClosedToken,
  permissionDenied,
  createCoreError,
  CoreErrorType,
} = await import("../packages/contracts/src/index.ts");
const { projectExecutionErrorPayload } = await import(
  "../packages/core/src/errors/error-payload.ts"
);

const TOKEN_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;
const root = new URL("../", import.meta.url);
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

const ALL_VOCABULARIES = [
  ["AgentLaunchFailureReason", AgentLaunchFailureReason, isAgentLaunchFailureReason],
  ["PermissionDenialReason", PermissionDenialReason, isPermissionDenialReason],
  ["SessionErrorClass", SessionErrorClass, isSessionErrorClass],
];

const ILLEGAL_TOKENS = [
  "",
  " ",
  "policy denied",
  "policy-denied",
  "policy.denied",
  "<script>alert(1)</script>",
  "policy_denied\nX-Injected: true",
  "9lives",
  "a".repeat(65),
  "../../../etc/passwd",
  undefined,
  null,
  42,
  {},
  ["policy_denied"],
];

test("(场景1/R1) 三词表全部 token 形态合规、互不重叠、谓词自洽", () => {
  const seen = new Map();
  for (const [name, vocabulary, predicate] of ALL_VOCABULARIES) {
    const tokens = Object.values(vocabulary);
    assert.ok(tokens.length >= 8, `${name} 词表过小，可能未按实际失败面收敛`);
    for (const token of tokens) {
      assert.match(token, TOKEN_SHAPE, `${name}.${token} 不符合闭集形态白名单`);
      assert.equal(predicate(token), true, `${name} 谓词拒绝了自己的 token ${token}`);
      assert.equal(isClosedErrorReasonToken(token), true, `联合谓词漏收 ${token}`);
      assert.ok(!seen.has(token), `token ${token} 在 ${seen.get(token)} 与 ${name} 重叠`);
      seen.set(token, name);
    }
  }
});

test("(场景1/R1) 非法值一律被谓词与收窄器拒绝，绝不透传", () => {
  for (const illegal of ILLEGAL_TOKENS) {
    assert.equal(isAgentLaunchFailureReason(illegal), false, `谓词放行了 ${String(illegal)}`);
    assert.equal(isPermissionDenialReason(illegal), false, `谓词放行了 ${String(illegal)}`);
    assert.equal(isSessionErrorClass(illegal), false, `谓词放行了 ${String(illegal)}`);
    assert.equal(isClosedErrorReasonToken(illegal), false, `联合谓词放行了 ${String(illegal)}`);
    assert.equal(
      narrowExternalClosedReasonToken(illegal),
      undefined,
      `收窄器透传了 ${String(illegal)}`,
    );
  }
  // 形态合规但不在词表内的 token（含外部 errno 名）同样拒绝：
  assert.equal(narrowExternalClosedReasonToken("some_other_token"), undefined);
  assert.equal(narrowExternalClosedReasonToken("EACCES"), undefined);
  // errno 名经小写归一后仍必须命中词表才放行：ENOSPC 不在词表 → 拒绝（分类器另管）；
  assert.equal(narrowExternalClosedReasonToken("rate_limit"), "rate_limit");
  // 大小写归一是收窄器的唯一放宽：大写形态的闭集 token 可收（errno 名习惯大写）；
  assert.equal(narrowExternalReasonToken("RATE_LIMIT", Object.values(SessionErrorClass)), "rate_limit");
  assert.equal(
    narrowExternalReasonToken("Rate Limit", Object.values(SessionErrorClass)),
    undefined,
    "含空格/连字符的近似形态不得经归一混入",
  );
});

test("(场景1/R1) 文本分类器：显式正则白名单映射，映射不了返回 undefined", () => {
  // 权限拒绝文案（permission/service.ts 既有字面量）：
  assert.equal(
    classifyPermissionDenialText("Tool Bash is denied by managed policy"),
    "policy_denied",
  );
  assert.equal(
    classifyPermissionDenialText("Tool WebFetch is explicitly disallowed"),
    "disallowed_tool",
  );
  assert.equal(
    classifyPermissionDenialText("Tool Bash is denied by project permission rules"),
    "project_rule_denied",
  );
  assert.equal(
    classifyPermissionDenialText("Plan mode only allows read-only, non-destructive tools"),
    "plan_mode_requires_read_only",
  );
  assert.equal(
    classifyPermissionDenialText("Critical risk tools require explicit approval"),
    "critical_risk_requires_approval",
  );
  assert.equal(classifyPermissionDenialText("Blocked by PreToolUse hook"), "hook_denied");
  assert.equal(classifyPermissionDenialText("User denied the request"), "user_denied");
  assert.equal(classifyPermissionDenialText("Permission request failed"), "permission_request_failed");
  assert.equal(classifyPermissionDenialText("完全无关的自由文本"), undefined);

  // 会话错误分类：
  assert.equal(classifySessionErrorText("write ENOSPC /tmp/x"), "disk_full");
  assert.equal(classifySessionErrorText("HTTP 429 Too Many Requests"), "rate_limit");
  assert.equal(classifySessionErrorText("401 Unauthorized: invalid api key"), "auth_error");
  assert.equal(classifySessionErrorText("request timed out after 60000ms"), "timeout");
  assert.equal(classifySessionErrorText("connect ECONNREFUSED 1.2.3.4:443"), "network");
  assert.equal(classifySessionErrorText("fetch failed"), "network");
  assert.equal(classifySessionErrorText("maximum context length exceeded"), "context_exceeded");
  assert.equal(classifySessionErrorText("'git' is not recognized as an internal or external command"), "git_not_found");
  assert.equal(classifySessionErrorText("fatal: not a git repository"), "git_operation_failed");
  assert.equal(classifySessionErrorText("HTTP 503 service unavailable"), "model_error");
  assert.equal(classifySessionErrorText("The request was aborted"), "cancelled");
  assert.equal(classifySessionErrorText("some totally unrelated prose"), undefined);

  // 总入口：精确成员 → 分类器 → undefined；非字符串拒绝。
  assert.equal(narrowErrorReasonToClosedToken("tree_budget_exceeded"), "tree_budget_exceeded");
  assert.equal(narrowErrorReasonToClosedToken("denied by managed policy"), "policy_denied");
  assert.equal(narrowErrorReasonToClosedToken("read ENOSPC"), "disk_full");
  assert.equal(narrowErrorReasonToClosedToken("随便一句话"), undefined);
  assert.equal(narrowErrorReasonToClosedToken(undefined), undefined);
  assert.equal(narrowErrorReasonToClosedToken(123), undefined);
});

test("(场景2/R2.3) permissionDenied 工厂：闭集进 context.reason，自由文本进 reasonDetail", () => {
  const closed = permissionDenied("Bash", "policy_denied");
  assert.equal(closed.context.reason, "policy_denied");
  assert.equal(closed.context.reasonDetail, undefined);
  // 大写 errno 风格的外部值经收窄仍可命中：
  const upper = permissionDenied("Bash", "USER_DENIED");
  assert.equal(upper.context.reason, "user_denied");

  const free = permissionDenied("Bash", "denied because the sandbox says so");
  assert.equal(free.context.reason, undefined, "自由文本不得占据 context.reason");
  assert.equal(free.context.reasonDetail, "denied because the sandbox says so");

  const absent = permissionDenied("Bash");
  assert.equal(absent.context.reason, undefined);
  assert.equal(absent.context.reasonDetail, undefined);
  assert.equal(absent.context.toolName, "Bash");
  assert.equal(absent.type, CoreErrorType.PermissionDenied);
});

test("(场景3/R2.2) error-payload attribution.reason 闭集化，detail 保留自由文本", () => {
  // 自由拒绝文案 → 分类器折叠成 token：
  const denial = createCoreError(CoreErrorType.PermissionDenied, "denied", {
    context: { reason: "Tool Bash is denied by managed policy" },
  });
  const denialProjection = projectExecutionErrorPayload(denial);
  assert.equal(denialProjection.attribution?.reason, "policy_denied");

  // 精确闭集 token 原样通过：
  const exact = createCoreError(CoreErrorType.ModelRateLimited, "slow down", {
    context: { reason: "rate_limit" },
  });
  assert.equal(projectExecutionErrorPayload(exact).attribution?.reason, "rate_limit");

  // 外部错误串经分类器收窄（errno 名 → disk_full）：
  const enospc = createCoreError(CoreErrorType.StorageError, "write failed", {
    context: { reason: "write ENOSPC /var/lib/acode" },
  });
  assert.equal(projectExecutionErrorPayload(enospc).attribution?.reason, "disk_full");

  // 分类不了的自由文本：attribution.reason 缺席，原文仍进 detail（debug/hover 通道不丢信息）：
  const freeform = createCoreError(CoreErrorType.UnknownError, "boom", {
    context: { reason: "completely novel failure prose <script>" },
  });
  const projection = projectExecutionErrorPayload(freeform);
  assert.equal(projection.attribution?.reason, undefined);
  assert.ok(
    !("reason" in (projection.attribution ?? {})),
    "attribution 仍携带 reason 键（哪怕 undefined）",
  );
  assert.ok(
    projection.detail?.includes("reason=completely novel failure prose"),
    `detail 未保留原始自由文本：${projection.detail}`,
  );
});

test("(场景4/R2.1) runner 启动失败面接线钉住：每个结构化抛错点携带闭集 reason", async () => {
  const runner = await read("packages/core/src/subagent/runner.ts");
  const pinned = [
    "reason: AgentLaunchFailureReason.BackgroundUnavailable",
    "reason: AgentLaunchFailureReason.UnknownAgentType",
    "reason: AgentLaunchFailureReason.ChildRuntimeFailed",
    "reason: AgentLaunchFailureReason.TreeBudgetExceeded",
    "reason: AgentLaunchFailureReason.InactivityTimeout",
    "reason: AgentLaunchFailureReason.CancelledBeforeCompletion",
    "reason: AgentLaunchFailureReason.StartupMetadataWriteFailed",
  ];
  for (const needle of pinned) {
    assert.ok(runner.includes(needle), `runner.ts 缺少接线：${needle}`);
  }
  // unknown_agent_type 有两个抛错点（ambiguous / not_found）：
  assert.equal(
    runner.split("reason: AgentLaunchFailureReason.UnknownAgentType").length - 1,
    2,
    "unknown_agent_type 应钉住两个抛错点",
  );
  // 树预算的局部拒绝维度移到 budgetReason，不再与全局闭集混键：
  assert.ok(runner.includes("budgetReason: claim.reason"), "claim.reason 未移入 budgetReason");
  assert.ok(
    !/reason: claim\.reason/.test(runner),
    "context.reason 仍是树预算局部词，闭集接线未完成",
  );
  // 启动元数据失败由裸 rethrow 改为 wrapper 包装（两处接线 + 一个包装函数）：
  assert.equal(
    runner.split("throw wrapStartupMetadataWriteFailure(error, lifecycle, request)").length - 1,
    2,
    "元数据写入失败应有 run/start 两处统一包装",
  );
  assert.ok(
    runner.includes("ErrorPayloadRole.Wrapper") &&
      runner.includes("Subagent startup metadata could not be written"),
    "元数据失败包装缺 wrapper 角色或消息",
  );
});
