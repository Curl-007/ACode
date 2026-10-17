// 验收场景 1（apps/acode-cli/specs/turn-auto-resume.md）：分类器各分支 + retryable:false 优先。
// 结构化闭集判定（SessionErrorClass / ModelRetryReason / ModelFailureReason / CoreErrorType），
// 无文本正则；落位跟随 apps/acode-cli/tests 的 .mjs + tsx 直跑源码惯例。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyAutoResumeFailure,
  isAutoResumeBudgetResultType,
  settlementClassification,
} from "../packages/core/src/runtime/auto-resume/classifier.ts";

function facts(coreErrorType, attribution) {
  return attribution === undefined ? { coreErrorType } : { attribution, coreErrorType };
}

describe("classifyAutoResumeFailure - transient", () => {
  it("maps SessionErrorClass transient tokens (rate_limit/network/timeout)", () => {
    for (const reason of ["rate_limit", "network", "timeout"]) {
      const result = classifyAutoResumeFailure(facts("unknown_error", { reason }));
      assert.equal(result.kind, "transient", reason);
    }
  });

  it("maps ModelRetryReason transient tokens from adapter context.reason", () => {
    for (const reason of [
      "rate_limited",
      "provider_overloaded",
      "server_error",
      "network_error",
      "timeout",
      "stream_idle_timeout",
      "stale_connection",
    ]) {
      const result = classifyAutoResumeFailure(facts("unknown_error", { reason }));
      assert.equal(result.kind, "transient", reason);
    }
  });

  it("maps CoreErrorType ModelRateLimited/ModelTimeout without attribution", () => {
    assert.equal(classifyAutoResumeFailure(facts("model_rate_limited")).kind, "transient");
    assert.equal(classifyAutoResumeFailure(facts("model_timeout")).kind, "transient");
  });

  it("maps model_error with retryable not-false (true or absent)", () => {
    assert.equal(
      classifyAutoResumeFailure(facts("model_error", { reason: "model_error", retryable: true }))
        .kind,
      "transient",
    );
    assert.equal(
      classifyAutoResumeFailure(facts("model_error", { reason: "model_error" })).kind,
      "transient",
    );
    assert.equal(classifyAutoResumeFailure(facts("model_error")).kind, "transient");
  });

  it("builds closed-set signature and summary without free text", () => {
    const result = classifyAutoResumeFailure(
      facts("model_error", {
        providerErrorCode: "3007",
        reason: "rate_limit",
        statusCode: 429,
      }),
    );
    assert.equal(result.kind, "transient");
    if (result.kind !== "transient") return;
    assert.equal(result.signature, "rate_limit|429|3007");
    assert.equal(result.errorSummary, "rate_limit (HTTP 429)");
  });

  it("E2E D2 回归：真实投影面 reason 缺席时，retryable:true（adapter 权威判定）兜底 transient", () => {
    // 真实链路形状（E2E 实测）：AiSdkModelAdapterError → UnknownError 包装，
    // "network_error"/"rate_limited" 等 adapter token 在 narrowErrorReasonToClosedToken
    // 边界丢失，归因上只有 retryable/source/statusCode/providerErrorCode 存活。
    const refused = classifyAutoResumeFailure(
      facts("unknown_error", {
        providerErrorCode: "ECONNREFUSED",
        retryable: true,
        source: "network",
      }),
    );
    assert.equal(refused.kind, "transient");
    if (refused.kind !== "transient") return;
    // reason 缺席时摘要退到 source 闭集词（比 unknown_error 可诊断）。
    assert.equal(refused.errorSummary, "network");

    const exhausted429 = classifyAutoResumeFailure(
      facts("unknown_error", { retryable: true, statusCode: 429 }),
    );
    assert.equal(exhausted429.kind, "transient");
    if (exhausted429.kind !== "transient") return;
    assert.equal(exhausted429.errorSummary, "unknown_error (HTTP 429)");

    // permanent 优先序不被 retryable:true 覆盖（规则次序钉住）。
    assert.equal(
      classifyAutoResumeFailure(facts("unknown_error", { reason: "auth_error", retryable: true }))
        .kind,
      "permanent",
    );
    assert.equal(
      classifyAutoResumeFailure(facts("model_context_exceeded", { retryable: true })).kind,
      "permanent",
    );
    // retryable 缺席时保守不猜：仅 source 不构成 transient。
    assert.equal(classifyAutoResumeFailure(facts("unknown_error", { source: "network" })).kind, "none");
    // retryable:false 仍是最高优先 permanent（规则 1 不受兜底影响）。
    assert.equal(
      classifyAutoResumeFailure(facts("unknown_error", { retryable: false, source: "network" }))
        .kind,
      "permanent",
    );
  });
});

describe("classifyAutoResumeFailure - permanent", () => {
  it("maps SessionErrorClass permanent tokens", () => {
    for (const reason of ["auth_error", "context_exceeded", "configuration_error", "disk_full"]) {
      assert.equal(
        classifyAutoResumeFailure(facts("unknown_error", { reason })).kind,
        "permanent",
        reason,
      );
    }
  });

  it("maps ModelFailureReason permanent tokens", () => {
    for (const reason of ["auth_failed", "invalid_request", "provider_not_configured"]) {
      assert.equal(
        classifyAutoResumeFailure(facts("unknown_error", { reason })).kind,
        "permanent",
        reason,
      );
    }
  });

  it("maps CoreErrorType ModelContextExceeded/ConfigurationError", () => {
    assert.equal(classifyAutoResumeFailure(facts("model_context_exceeded")).kind, "permanent");
    assert.equal(classifyAutoResumeFailure(facts("configuration_error")).kind, "permanent");
  });

  it("retryable:false wins over a transient reason (spec: 任何 retryable:false)", () => {
    assert.equal(
      classifyAutoResumeFailure(facts("model_error", { reason: "rate_limit", retryable: false }))
        .kind,
      "permanent",
    );
    assert.equal(
      classifyAutoResumeFailure(facts("unknown_error", { reason: "network", retryable: false }))
        .kind,
      "permanent",
    );
  });
});

describe("classifyAutoResumeFailure - 不干预", () => {
  it("unknown_error without structured attribution stays out (no text guessing)", () => {
    assert.equal(classifyAutoResumeFailure(facts("unknown_error")).kind, "none");
  });

  it("two-sided reasons (storage_error/proxy_error/tls_error/unknown) do not get transient", () => {
    for (const reason of ["storage_error", "proxy_error", "tls_error", "unknown"]) {
      assert.equal(
        classifyAutoResumeFailure(facts("unknown_error", { reason })).kind,
        "none",
        reason,
      );
    }
  });

  it("permission/tool failures stay out", () => {
    assert.equal(
      classifyAutoResumeFailure(facts("permission_denied", { reason: "user_denied" })).kind,
      "none",
    );
    assert.equal(classifyAutoResumeFailure(facts("tool_execution_failed")).kind, "none");
  });

  it("TurnCancelled is never a failure classification", () => {
    assert.equal(
      classifyAutoResumeFailure(facts("turn_cancelled", { reason: "network" })).kind,
      "none",
    );
  });
});

describe("budget / settlement", () => {
  it("recognizes the budget resultType closed set only", () => {
    assert.equal(isAutoResumeBudgetResultType("error_max_turns"), true);
    assert.equal(isAutoResumeBudgetResultType("error_max_budget"), true);
    assert.equal(isAutoResumeBudgetResultType("error_max_tool_calls"), true);
    assert.equal(isAutoResumeBudgetResultType("error_during_execution"), false);
    assert.equal(isAutoResumeBudgetResultType("success"), false);
    assert.equal(isAutoResumeBudgetResultType("cancelled"), false);
  });

  it("settlement classification: budget gives up, success/cancelled reset", () => {
    assert.equal(settlementClassification("budget").kind, "budget");
    assert.equal(settlementClassification("success").kind, "none");
    assert.equal(settlementClassification("cancelled").kind, "none");
  });
});
