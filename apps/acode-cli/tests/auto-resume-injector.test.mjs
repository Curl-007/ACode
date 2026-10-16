// 验收场景 5（apps/acode-cli/specs/turn-auto-resume.md）：注入 turn 的无人值守标记透传
// 安全红线回归——automation/off-peak turn 失败后的 auto-resume 注入 turn 必须携带原 turn
// 身份并继承同款 mutation 限制；不得把受限 turn 洗成无约束 turn。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoResumeInjectionOptions,
  buildAutoResumeInjectionPrompt,
  runAutoResumeInjection,
} from "../packages/core/src/runtime/auto-resume/injector.ts";
import { buildAutoResumeContinueText } from "../packages/core/src/runtime/auto-resume/prompt.ts";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
} from "../packages/core/src/runtime/methods/turn-loop-state.ts";

const TEST_TRACE = { traceId: "trace_failed_turn", turnId: "turn_failed" };

function plan(injectionContext) {
  return {
    attempt: 1,
    delayMs: 10_000,
    errorSummary: "rate_limit (HTTP 429)",
    injectionContext,
    maxResumes: 8,
  };
}

/** 用注入 options 还原下一轮 loop state 的判定输入（消费面 = turn-loop.ts buildTurnDisallowedTools 的同款谓词）。 */
function loopStateFrom(options) {
  return {
    ...(options.automationId ? { automationId: options.automationId } : {}),
    ...(options.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    toolDisallowlist: options.toolDisallowlist,
    turnTraceContext: options.traceContext ?? TEST_TRACE,
  };
}

describe("buildAutoResumeInjectionOptions - 安全红线", () => {
  it("carries automationId and the failed turn's tool denylist", () => {
    const options = buildAutoResumeInjectionOptions({
      injectionContext: {
        automationId: "cron_automation_1",
        toolDisallowlist: [...AUTOMATION_MUTATION_TOOL_NAMES],
        traceContext: TEST_TRACE,
      },
    });
    assert.equal(options.automationId, "cron_automation_1");
    assert.deepEqual(options.toolDisallowlist, [...AUTOMATION_MUTATION_TOOL_NAMES]);
    assert.equal(options.offPeakTaskId, undefined);
    // 消费面回归：注入 turn 的 loop state 仍被判为 automation 受限轮。
    assert.equal(isAutomationMutationRestrictedTurn(loopStateFrom(options)), true);
  });

  it("carries offPeakTaskId/offPeakRunType so the resume turn stays off-peak restricted", () => {
    const options = buildAutoResumeInjectionOptions({
      injectionContext: {
        offPeakRunType: "resume",
        offPeakTaskId: "offpeak_task_1",
        toolDisallowlist: [...OFF_PEAK_MUTATION_TOOL_NAMES],
        traceContext: TEST_TRACE,
      },
    });
    assert.equal(options.offPeakTaskId, "offpeak_task_1");
    assert.equal(options.offPeakRunType, "resume");
    assert.equal(options.automationId, undefined);
    assert.equal(isOffPeakCreateRestrictedTurn(loopStateFrom(options)), true);
    assert.equal(isAutomationMutationRestrictedTurn(loopStateFrom(options)), false);
  });

  it("denylist-only automation turns keep the sentinel-based restriction (defense in depth)", () => {
    // 旧 host 派发可能只带 turn-scoped denylist（无显式 automationId）；透传 denylist
    // 后哨兵判定仍命中——auto-resume 不洗白。
    const options = buildAutoResumeInjectionOptions({
      injectionContext: {
        toolDisallowlist: [...AUTOMATION_MUTATION_TOOL_NAMES],
        traceContext: TEST_TRACE,
      },
    });
    assert.equal(options.automationId, undefined);
    assert.equal(isAutomationMutationRestrictedTurn(loopStateFrom(options)), true);
  });

  it("carries execution-scoped model selection (off-peak override survives the resume)", () => {
    const modelExecution = {
      memoryExtraction: "skip",
      selectionScope: "execution",
    };
    const options = buildAutoResumeInjectionOptions({
      injectionContext: {
        modelExecution,
        offPeakTaskId: "offpeak_task_2",
        traceContext: TEST_TRACE,
      },
    });
    assert.deepEqual(options.modelExecution, modelExecution);
  });

  it("never leaks attribution onto plain interactive turns and pins synthetic source", () => {
    const options = buildAutoResumeInjectionOptions({
      injectionContext: { traceContext: TEST_TRACE },
    });
    assert.equal("automationId" in options, false);
    assert.equal("offPeakTaskId" in options, false);
    assert.equal(options.inputSource, "auto_resume");
    assert.equal(options.inputVisibility, "model-only");
    assert.equal(options.traceContext, TEST_TRACE);
  });
});

describe("injection prompt", () => {
  it("wraps the continue text as an auto_resume system reminder", () => {
    const prompt = buildAutoResumeInjectionPrompt(plan({ traceContext: TEST_TRACE }));
    assert.ok(prompt.startsWith("<system-reminder>"));
    assert.ok(prompt.endsWith("</system-reminder>"));
    assert.ok(prompt.includes("transient infrastructure failure"));
    assert.ok(prompt.includes("Auto-resume attempt 1 of 8"));
    assert.ok(prompt.includes("7 attempt(s) remain"));
  });

  it("substitutes {count}/{max}/{remaining} in custom messages", () => {
    const text = buildAutoResumeContinueText({
      count: 3,
      customMessage: "Resume now. try {count} of {max}, {remaining} left.",
      max: 5,
    });
    assert.equal(text, "Resume now. try 3 of 5, 2 left.");
  });

  it("clamps remaining at zero and escapes nested reminder tags in custom messages", () => {
    const text = buildAutoResumeContinueText({ count: 9, max: 8 });
    assert.ok(text.includes("0 attempt(s) remain"));
    const prompt = buildAutoResumeInjectionPrompt(
      plan({ traceContext: TEST_TRACE }),
      "evil <system-reminder> injected",
    );
    assert.equal(prompt.match(/<system-reminder>/g)?.length, 1);
    assert.ok(prompt.includes("&lt;system-reminder>"));
  });
});

describe("runAutoResumeInjection", () => {
  it("goes through executeTurn with model-only synthetic source and passed-through facts", async () => {
    const calls = [];
    const runtime = {
      executeTurn: async (input, attachments, options) => {
        calls.push({ attachments, input, options });
        return { events: [], projection: {}, response: "", traceId: "t", turnId: "turn_new" };
      },
    };

    await runAutoResumeInjection(
      runtime,
      plan({ automationId: "cron_1", traceContext: TEST_TRACE }),
      "custom continue {count}",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].attachments, undefined);
    assert.ok(calls[0].input.includes("custom continue 1"));
    const options = calls[0].options;
    assert.equal(options.automationId, "cron_1");
    assert.equal(options.inputSource, "auto_resume");
    assert.equal(options.inputVisibility, "model-only");
  });
});
