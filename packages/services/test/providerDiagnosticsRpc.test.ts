import assert from "node:assert/strict";
import test from "node:test";
import { ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "../src/acode-agent/acodeAgent.js";
import {
  createNoAgentRuntimeError,
  createProviderDiagnosticsRpcPort,
} from "../src/acode-agent/providerDiagnosticsRpc.js";
import {
  PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE,
  createProviderDiagnosticsExecutor,
  type ProviderDiagnosticsRpcPort,
} from "../src/model-provider/providerDiagnosticsExecutor.js";
import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  PROVIDER_DIAGNOSTICS_ZERO_SPEND,
  type ProviderDiagnosticsRequest,
  type ProviderDiagnosticsResult,
} from "@acode/shared";

/**
 * U08 RPC 适配层测试（specs/provider-diagnostics.md R4/R6 + 「无 workspace 的首次配置」）。
 *
 * 本层唯一的判定职责：把 acode-agent 的稳定 code 翻译成编排器自己的词汇，且**按结构化字段
 * 识别、不匹配错误文本**（根 AGENTS.md）。翻译正确与否直接决定 UI 给用户「重试」还是
 * 「稍后在设置中验证」——首次配置尚无 workspace 时给「重试」是无效动作。
 */

function fakeRequest(overrides: Partial<ProviderDiagnosticsRequest> = {}): ProviderDiagnosticsRequest {
  return { requestId: "r", providerId: "zai", revision: 1, tier: "offline", ...overrides };
}

function completedResult(request: ProviderDiagnosticsRequest): ProviderDiagnosticsResult {
  return {
    requestId: request.requestId,
    providerId: request.providerId,
    revision: request.revision,
    tier: request.tier,
    status: "completed",
    verdict: "tier-passed",
    checkpoints: PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" as const })),
    remediationActions: ["escalate-tier-catalog"],
    nextStepCommands: [],
    spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND },
    blockedNetworkCalls: 0,
    startedAt: "t0",
    finishedAt: "t1",
  };
}

/** 抛带稳定 code 的错误的 fake agent service（模拟没有活跃 workspace runtime）。 */
function createNoRuntimeAgentService(code: string) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    agentService: {
      async runProviderDiagnostics(): Promise<ProviderDiagnosticsResult> {
        calls += 1;
        const error = new Error("ACode Agent runtime is not running.") as Error & { code?: string };
        error.code = code;
        throw error;
      },
      async cancelProviderDiagnostics(_params: { requestId: string }) {
        calls += 1;
        const error = new Error("ACode Agent runtime is not running.") as Error & { code?: string };
        error.code = code;
        throw error;
      },
    },
  };
}

test("U08-A1: ACODE_AGENT_RUNTIME_UNAVAILABLE 被翻译成 no-agent-runtime（结构化 code，非文本匹配）", async () => {
  const fake = createNoRuntimeAgentService(ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE);
  const rpc = createProviderDiagnosticsRpcPort({ agentService: fake.agentService });
  // 经编排器端到端：适配层翻译 + 编排器归一，最终 UI 拿到 no-agent-runtime。
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const result = await executor.run(fakeRequest({ requestId: "first-config" }));

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "no-agent-runtime");
  assert.deepEqual(result.remediationActions, ["verify-later"], "无进程时只给「稍后验证」，不给无效的重试");
  assert.equal(result.spend, undefined, "没跑起来时花费未知，不得填 0");
  assert.equal(fake.calls, 1, "只尝试一次，不重试");
});

test("适配层自带的 no-agent-runtime code 同样归一（两条来源同语义）", async () => {
  const fake = createNoRuntimeAgentService(PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE);
  const rpc = createProviderDiagnosticsRpcPort({ agentService: fake.agentService });
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const result = await executor.run(fakeRequest());
  assert.equal(result.errorCode, "no-agent-runtime");
});

test("适配层不吞其它异常：非载体类错误原样上抛，由编排器归一成 execution-failed", async () => {
  const boom = new Error("doctor exploded");
  const rpc = createProviderDiagnosticsRpcPort({
    agentService: {
      async runProviderDiagnostics(): Promise<ProviderDiagnosticsResult> {
        throw boom;
      },
      async cancelProviderDiagnostics(params) {
        return { requestId: params.requestId, cancelled: false };
      },
    },
  });
  // 适配层原样抛（不吞、不改写成字符串）。
  await assert.rejects(() => rpc.run(fakeRequest()), (error: unknown) => error === boom);
  // 编排器把它归一成结构化终态：诊断失败 != 保存失败，绝不向上抛给保存流程。
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const result = await executor.run(fakeRequest());
  assert.equal(result.errorCode, "execution-failed");
  assert.ok(result.remediationActions.includes("retry-diagnostics"));
});

test("R4: 取消时载体不可用 → cancelled:false，不把「没进程」当成取消失败抛给用户", async () => {
  const fake = createNoRuntimeAgentService(ACODE_AGENT_RUNTIME_UNAVAILABLE_CODE);
  const rpc = createProviderDiagnosticsRpcPort({ agentService: fake.agentService });
  const result = await rpc.cancel("gone");
  assert.deepEqual(result, { requestId: "gone", cancelled: false });
});

test("R4: 取消正常转调，并把执行方的 spend 事实原样带回（不声称退费）", async () => {
  let cancelCalls = 0;
  const rpc = createProviderDiagnosticsRpcPort({
    agentService: {
      async runProviderDiagnostics(request) {
        return completedResult(request);
      },
      async cancelProviderDiagnostics(params) {
        cancelCalls += 1;
        return {
          requestId: params.requestId,
          cancelled: true,
          // 已发出的计费调用如实回传；DTO 里没有任何退费语义字段可供 UI 误用。
          spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, billableCalls: 3 },
        };
      },
    },
  });
  const result = await rpc.cancel("live-1");
  assert.equal(result.cancelled, true);
  assert.equal(result.spend?.billableCalls, 3);
  assert.equal(cancelCalls, 1);
  assert.equal("refund" in result, false);
});

test("正常路径：run 原样转交 agent service 的 DTO，不改写 requestId/revision", async () => {
  const seen: ProviderDiagnosticsRequest[] = [];
  const rpc = createProviderDiagnosticsRpcPort({
    agentService: {
      async runProviderDiagnostics(request) {
        seen.push(request);
        return completedResult(request);
      },
      async cancelProviderDiagnostics(params) {
        return { requestId: params.requestId, cancelled: false };
      },
    },
  });
  const request = fakeRequest({ requestId: "keep-me", revision: 42, providerId: "bigmodel" });
  const result = await rpc.run(request);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.requestId, "keep-me");
  assert.equal(result.requestId, "keep-me");
  assert.equal(result.revision, 42, "revision 必须逐字回显（R2 fencing 的基础）");
  assert.equal(result.providerId, "bigmodel");
});

test("createNoAgentRuntimeError 造出的错误带结构化 code（供 node.ts 未装配路径使用）", () => {
  const error = createNoAgentRuntimeError();
  assert.equal(error.code, PROVIDER_DIAGNOSTICS_NO_AGENT_RUNTIME_CODE);
  assert.ok(error instanceof Error);
  // 消息里不含凭据形态字符串（R8 隐私门槛）。
  assert.equal(/sk-|Bearer|apiKey|authorization/i.test(error.message), false);
});

test("端口面只有 run/cancel 两个只读诊断动作（结构性保证：诊断不写 provider）", () => {
  const rpc: ProviderDiagnosticsRpcPort = createProviderDiagnosticsRpcPort({
    agentService: {
      async runProviderDiagnostics(request) {
        return completedResult(request);
      },
      async cancelProviderDiagnostics(params) {
        return { requestId: params.requestId, cancelled: false };
      },
    },
  });
  assert.deepEqual(Object.keys(rpc).sort(), ["cancel", "run"]);
});
