import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  PROVIDER_DIAGNOSTICS_ZERO_SPEND,
  type ProviderDiagnosticsCancelResult,
  type ProviderDiagnosticsRequest,
  type ProviderDiagnosticsResult,
  type ProviderDiagnosticsSpend,
} from "@acode/shared";
import {
  createProviderDiagnosticsExecutor,
  providerDiagnosticsExecutionKey,
} from "../src/model-provider/providerDiagnosticsExecutor.js";
import type { ProviderDiagnosticsRpcPort } from "../src/model-provider/providerDiagnosticsExecutor.js";

/**
 * U08 服务侧编排器行为测试（specs/provider-diagnostics.md R2/R3/R4/R9）。
 *
 * 覆盖提案验收场景：
 * - U08-A4 单次执行：双击/重试只跑一次 RPC，两个 requestId 都拿到各自终态。
 * - U08-A3 revision fencing：执行方回显不一致 → 本地改判 revision-mismatch，不冒充结论。
 * - U08-A1 无运行时：`no-agent-runtime` 终态且 RPC 调用数为 0（零网络/DNS/模型）。
 * - U08-A3 取消：只路由到该 requestId 所属执行，且不声称退还已发请求费用。
 *
 * 全部用注入的 fake RPC，无真实进程、无固定 sleep（用受控 deferred）。
 */

/** 受控 deferred：测试自己决定 RPC 何时完成，不用固定 sleep。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeRequest(overrides: Partial<ProviderDiagnosticsRequest> = {}): ProviderDiagnosticsRequest {
  return {
    requestId: "req-1",
    providerId: "zai",
    revision: 3,
    tier: "offline",
    ...overrides,
  };
}

function completedResult(request: ProviderDiagnosticsRequest, spend?: ProviderDiagnosticsSpend) {
  return {
    requestId: request.requestId,
    providerId: request.providerId,
    revision: request.revision,
    tier: request.tier,
    modelId: "glm-4.6",
    status: "completed" as const,
    verdict: "tier-passed" as const,
    checkpoints: PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" as const })),
    remediationActions: ["escalate-tier-catalog", "verify-later"],
    nextStepCommands: ["acode doctor --provider=zai --tier=catalog"],
    spend: spend ?? { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND },
    blockedNetworkCalls: 0,
    startedAt: "2026-10-26T00:00:00.000Z",
    finishedAt: "2026-10-26T00:00:00.100Z",
  };
}

/** 记录调用、可受控完成的 fake RPC。 */
function createFakeRpc(options: {
  readonly onComplete?: (request: ProviderDiagnosticsRequest) => ProviderDiagnosticsResult;
} = {}) {
  const runCalls: ProviderDiagnosticsRequest[] = [];
  const cancelCalls: string[] = [];
  const gates: { request: ProviderDiagnosticsRequest; gate: ReturnType<typeof deferred<ProviderDiagnosticsResult>> }[] = [];
  const rpc: ProviderDiagnosticsRpcPort = {
    run(request) {
      runCalls.push(request);
      const gate = deferred<ProviderDiagnosticsResult>();
      gates.push({ request, gate });
      if (options.onComplete) {
        // 立即完成路径：仍走 gate，保证调用顺序可观察。
        gate.resolve(options.onComplete(request));
      }
      return gate.promise;
    },
    async cancel(requestId): Promise<ProviderDiagnosticsCancelResult> {
      cancelCalls.push(requestId);
      return { requestId, cancelled: cancelCalls.length > 0 };
    },
  };
  return { rpc, runCalls, cancelCalls, gates };
}

test("U08-A4: 双击/并发同键只触发一次 RPC，两个 requestId 各拿到盖自己 requestId 的终态", async () => {
  const { rpc, runCalls, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "2026-10-26T00:00:00.000Z" });

  const first = fakeRequest({ requestId: "click-1" });
  const second = fakeRequest({ requestId: "click-2" });
  // 同时发起（模拟双击）：两者去重键相同，必须合并成一次执行。
  const pending = Promise.all([executor.run(first), executor.run(second)]);
  assert.equal(executor.inflightCount, 1, "同键并行请求应合并为一次执行");
  assert.equal(runCalls.length, 1, "只能发出一次 RPC");
  // 发往 CLI 的必须是主 requestId（取消路由依赖此，见 InflightExecution 注释）。
  assert.equal(runCalls[0]!.requestId, "click-1");

  gates[0]!.gate.resolve(completedResult(first));
  const [res1, res2] = await pending;

  // R3：两个调用方都拿到终态，但各盖自己的 requestId（否则 UI 匹配失效）。
  assert.equal(res1.requestId, "click-1");
  assert.equal(res2.requestId, "click-2");
  assert.equal(res1.status, "completed");
  assert.equal(res2.status, "completed");
  assert.equal(executor.inflightCount, 0, "终态后应释放在飞登记");
});

test("U08-A4: 不同 tier/revision/modelId 不合并——去重键覆盖四个维度", async () => {
  assert.notEqual(
    providerDiagnosticsExecutionKey(fakeRequest({ tier: "offline" })),
    providerDiagnosticsExecutionKey(fakeRequest({ tier: "catalog" })),
  );
  assert.notEqual(
    providerDiagnosticsExecutionKey(fakeRequest({ revision: 3 })),
    providerDiagnosticsExecutionKey(fakeRequest({ revision: 4 })),
  );
  assert.notEqual(
    providerDiagnosticsExecutionKey(fakeRequest({ modelId: "a" })),
    providerDiagnosticsExecutionKey(fakeRequest({ modelId: "b" })),
  );
  // 「未指定模型」与「指定某模型」不互相合并（modelId 缺席按空串参与）。
  assert.notEqual(
    providerDiagnosticsExecutionKey(fakeRequest({ modelId: undefined })),
    providerDiagnosticsExecutionKey(fakeRequest({ modelId: "a" })),
  );
  // requestId 不参与去重键：不同 requestId 的同键请求必须合并。
  assert.equal(
    providerDiagnosticsExecutionKey(fakeRequest({ requestId: "x" })),
    providerDiagnosticsExecutionKey(fakeRequest({ requestId: "y" })),
  );
});

test("U08-A4: 上一次失败后重试是新的一次执行（幂等边界是去重，不是缓存）", async () => {
  const { rpc, runCalls, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const request = fakeRequest({ requestId: "attempt-1" });

  const firstPending = executor.run(request);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  gates[0]!.gate.reject(abort);
  const first = await firstPending;
  assert.equal(first.status, "cancelled", "AbortError 归一成 cancelled 终态，不是 failed");

  // 终态后重试：同键但已不在飞 → 新的一次执行（用户显式重试要真跑一遍）。
  const secondPending = executor.run(fakeRequest({ requestId: "attempt-2" }));
  assert.equal(runCalls.length, 2, "重试必须真的再发一次 RPC");
  gates[1]!.gate.resolve(completedResult(fakeRequest({ requestId: "attempt-2" })));
  const second = await secondPending;
  assert.equal(second.status, "completed");
});

test("U08-A4: 诊断永不创建/修改 provider——编排器只转调 run/cancel，无写入路径", async () => {
  // 端口面本身只有 run/cancel 两个只读诊断动作；没有 create/save 能力可用（结构性保证）。
  const { rpc, runCalls, cancelCalls } = createFakeRpc({ onComplete: (req) => completedResult(req) });
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  await executor.run(fakeRequest());
  assert.deepEqual(Object.keys(rpc), ["run", "cancel"], "RPC 端口面只允许 run/cancel");
  assert.equal(runCalls.length, 1);
  assert.equal(cancelCalls.length, 0);
});

test("U08-A3: 执行方回显的 revision 不一致 → 本地改判 revision-mismatch，不冒充结论", async () => {
  const { rpc, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const request = fakeRequest({ revision: 3, requestId: "r" });
  const pending = executor.run(request);
  // 执行方违约：回显了别的 revision（模拟「结果跑在了新配置上」）。
  gates[0]!.gate.resolve(completedResult({ ...request, revision: 9 }));
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "revision-mismatch");
  // 改判后不得带 verdict（否则 UI 可能把它渲染成结论），也不得冒充 completed。
  assert.equal(result.verdict, undefined);
  assert.equal(result.revision, 3, "回给 UI 的仍是它请求的 revision，UI 才能据此丢弃");
  // spend 缺席：没跑出可信报告时花费未知，绝不填 0 冒充没花钱（R4）。
  assert.equal(result.spend, undefined);
});

test("U08-A3: 取消只路由到该 requestId 所属执行；合并进来的请求也路由到主 requestId", async () => {
  const { rpc, cancelCalls, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const primary = fakeRequest({ requestId: "primary" });
  const merged = fakeRequest({ requestId: "merged" });
  const other = fakeRequest({ requestId: "other", providerId: "bigmodel" });

  const p1 = executor.run(primary);
  const p2 = executor.run(merged);
  const p3 = executor.run(other);
  assert.equal(executor.inflightCount, 2, "两个不同 provider = 两次独立执行");

  // 取消「合并进来的」requestId：必须路由到主 requestId（CLI 只认识主的那个）。
  const cancelMerged = await executor.cancel("merged");
  assert.deepEqual(cancelCalls, ["primary"], "合并请求的取消应路由到主 requestId");
  assert.equal(cancelMerged.cancelled, true);

  // 取消另一个执行的 requestId：不得波及 primary（R4「只取消该次」）。
  const cancelOther = await executor.cancel("other");
  assert.deepEqual(cancelCalls, ["primary", "other"]);
  assert.equal(cancelOther.cancelled, true);

  // 未知 requestId：cancelled:false，且**不**下发任何取消 RPC（不是错误）。
  const cancelUnknown = await executor.cancel("never-existed");
  assert.equal(cancelUnknown.cancelled, false);
  assert.deepEqual(cancelCalls, ["primary", "other"], "未知 requestId 不应产生 RPC");

  gates[0]!.gate.resolve(completedResult(primary));
  gates[1]!.gate.resolve(completedResult(other));
  await Promise.all([p1, p2, p3]);
});

test("U08-A3: 取消结果不声称退还已发请求费用——DTO 里没有任何退费语义字段", async () => {
  const { rpc, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const liveRequest = fakeRequest({ requestId: "live-1", tier: "live", liveOptIn: true });
  const pending = executor.run(liveRequest);
  await executor.cancel("live-1");
  // 执行方在取消前已产生计费调用：spend 如实回传，UI 据此说「已发生，无法撤销」。
  gates[0]!.gate.resolve({
    ...completedResult(liveRequest, { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, billableCalls: 2 }),
    status: "cancelled" as const,
    verdict: undefined,
    errorCode: "cancelled" as const,
  });
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.spend?.billableCalls, 2, "已发生的计费调用必须如实回传");
  // 结构性断言：DTO 里不存在任何「退费/已撤销」字段可供 UI 误用。
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of ["refund", "refunded", "chargeback", "reversed"]) {
    assert.equal(serialized.includes(forbidden), false, `结果不得含退费语义字段: ${forbidden}`);
  }
});

test("U08-A1: 没有可承载诊断的 agent 运行时 → no-agent-runtime 终态且 RPC 调用数为 0", async () => {
  // 首次配置发生在 WelcomeScreen，此时可能一个 workspace 都没打开（spec「无 workspace」段）。
  let runCalls = 0;
  const noRuntimeError = new Error("no agent runtime available for provider diagnostics");
  (noRuntimeError as Error & { code?: string }).code = "provider-diagnostics-no-agent-runtime";
  const rpc: ProviderDiagnosticsRpcPort = {
    async run() {
      runCalls += 1;
      throw noRuntimeError;
    },
    async cancel(requestId) {
      return { requestId, cancelled: false };
    },
  };
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const result = await executor.run(fakeRequest({ requestId: "first-config" }));

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "no-agent-runtime");
  // 没有进程 → 一次网络/DNS/模型调用都不会发出（U08-A1 的零调用断言）。
  assert.equal(result.blockedNetworkCalls, 0);
  assert.equal(result.spend, undefined, "没跑起来时花费未知，不得填 0");
  // 只给「稍后验证」出口：没有进程时重试也没用（提案 §3.6）。
  assert.deepEqual(result.remediationActions, ["verify-later"]);
  assert.equal(result.checkpoints.length, PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.length);
  assert.ok(result.checkpoints.every((c) => c.status === "skipped"), "无执行时检查点全 skipped");
  // run 被调用了一次但立即抛错，没有任何后续执行发生。
  assert.equal(runCalls, 1);
});

test("R4: 未知错误码归一成 execution-failed（不归一成 no-agent-runtime，避免误导「稍后再试」）", async () => {
  // 分层纪律：把 acode-agent 的稳定 code 翻译成编排器自己的词汇是 **RPC 适配层**的职责
  // （providerDiagnosticsRpc.ts，见其测试）；编排器只认自己的 code。这里验证的是编排器
  // 不会把「没见过的错误」误判成「没有运行时」——两者给用户的动作不同（retry vs verify-later）。
  const error = new Error("ACode Agent runtime is not running.") as Error & { code?: string };
  error.code = "ACODE_AGENT_RUNTIME_UNAVAILABLE";
  let runCalls = 0;
  const rpc: ProviderDiagnosticsRpcPort = {
    async run() {
      runCalls += 1;
      throw error;
    },
    async cancel(requestId) {
      return { requestId, cancelled: false };
    },
  };
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const result = await executor.run(fakeRequest());
  assert.equal(result.errorCode, "execution-failed");
  assert.equal(runCalls, 1);
  assert.ok(result.remediationActions.includes("retry-diagnostics"));
});

test("R9: tier=live 缺 liveOptIn → live-opt-in-required 终态，RPC 调用数为 0（零模型调用）", async () => {
  let runCalls = 0;
  const rpc: ProviderDiagnosticsRpcPort = {
    async run() {
      runCalls += 1;
      throw new Error("should not be called");
    },
    async cancel(requestId) {
      return { requestId, cancelled: false };
    },
  };
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  // 缺 liveOptIn。
  const result = await executor.run(fakeRequest({ tier: "live", liveOptIn: undefined }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "live-opt-in-required");
  assert.equal(runCalls, 0, "未 opt-in 的 live 档绝不能发出任何调用");
  // 显式 false 同样拒绝（授权只对本次、该档位生效，且必须显式）。
  const explicitFalse = await executor.run(fakeRequest({ tier: "live", liveOptIn: false }));
  assert.equal(explicitFalse.errorCode, "live-opt-in-required");
  assert.equal(runCalls, 0);
});

test("R9: liveOptIn=true 时 live 档正常放行", async () => {
  const { rpc, runCalls, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const request = fakeRequest({ tier: "live", liveOptIn: true, requestId: "live-ok" });
  const pending = executor.run(request);
  assert.equal(runCalls.length, 1);
  gates[0]!.gate.resolve({
    ...completedResult(request),
    verdict: "ready" as const,
  });
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.verdict, "ready", "只有 live 档能出 ready（轻档不越档背书）");
});

test("R3: 终态后在飞登记释放，同键新请求是全新执行（不会永久占位）", async () => {
  const { rpc, runCalls, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const first = executor.run(fakeRequest({ requestId: "a" }));
  gates[0]!.gate.resolve(completedResult(fakeRequest({ requestId: "a" })));
  await first;
  assert.equal(executor.inflightCount, 0);

  const second = executor.run(fakeRequest({ requestId: "b" }));
  assert.equal(executor.inflightCount, 1);
  gates[1]!.gate.resolve(completedResult(fakeRequest({ requestId: "b" })));
  await second;
  assert.equal(runCalls.length, 2);
  assert.equal(executor.inflightCount, 0);
});

test("R4: 执行抛非取消类异常 → execution-failed 终态（诊断失败 != 保存失败，不向上抛）", async () => {
  const { rpc, gates } = createFakeRpc();
  const executor = createProviderDiagnosticsExecutor({ rpc, now: () => "t" });
  const pending = executor.run(fakeRequest({ requestId: "boom" }));
  gates[0]!.gate.reject(new Error("doctor exploded"));
  // 关键：不抛给调用方——UI 需要结构化终态，否则保存流程会被诊断失败牵连。
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "execution-failed");
  assert.ok(result.remediationActions.includes("retry-diagnostics"), "失败态必须可重试");
  assert.ok(result.remediationActions.includes("verify-later"), "失败态保留稍后验证出口");
});

test("结果 DTO 恒过 shared 契约 schema（终态失败也要满足 12 点 + superRefine 约束）", async () => {
  // 编排器产出的每一份 DTO 都必须能被契约叶子接受，否则 UI 侧 parse 会失败。
  const { parseProviderDiagnosticsResult } = await import("@acode/shared");
  const noRuntime = new Error("no runtime") as Error & { code?: string };
  noRuntime.code = "provider-diagnostics-no-agent-runtime";
  const executor = createProviderDiagnosticsExecutor({
    rpc: {
      async run() {
        throw noRuntime;
      },
      async cancel(requestId) {
        return { requestId, cancelled: false };
      },
    },
    now: () => "2026-10-26T00:00:00.000Z",
  });
  const failed = await executor.run(fakeRequest());
  const reparsed: ProviderDiagnosticsResult = parseProviderDiagnosticsResult(failed);
  assert.equal(reparsed.errorCode, "no-agent-runtime");

  // live 未 opt-in 的终态同样合法。
  const notOptedIn = await executor.run(fakeRequest({ tier: "live", requestId: "live-x" }));
  parseProviderDiagnosticsResult(notOptedIn);
});
