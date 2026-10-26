import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * U08 CLI 侧适配测试（specs/provider-diagnostics.md 验收场景 U08-A1/A2/A3/A5/P1）。
 *
 * 这些用例走**适配器的真实代码路径**（createProviderDiagnosticsProtocolExecutor →
 * runProviderDoctor → projectProviderDiagnosticsResult），只把 IO 换成注入的计数/受控 Port。
 * 因此「offline 档零网络」证明的是**这里的接线**没有漏注入 blocked transport，而不只是
 * doctor 自己的测试结论（provider-doctor.test.mjs 证明不了本适配层）。
 *
 * 覆盖：
 * - U08-A1 offline 档网络/DNS/model 调用数全 0，且 verdict 不越档为 ready。
 * - U08-A2 错误密钥 / 空目录 / 凭据引用悬空三者稳定错误码互不相同。
 * - U08-A3 取消回包带 spend 事实、无任何退费语义字段。
 * - U08-A5 skipped 与 failed 可区分；模型不支持 tool call → tool_call_parse 为 skipped。
 * - U08-P1 真实明文 key 在 fixture 里，序列化后的 DTO 零泄漏。
 */

const { createProviderDiagnosticsProtocolExecutor } = await import(
  "../packages/bootstrap/src/acode-protocol/provider-diagnostics.ts"
);
// CLI 测试目录不解析裸 `@acode/shared`（pnpm 未把它提升到 apps/acode-cli），
// 与仓库既有惯例一致，走相对路径引 root 侧 shared 源码。
const { PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS, PROVIDER_DIAGNOSTICS_ZERO_SPEND } = await import(
  "../../../packages/shared/src/providerDiagnostics.ts"
);

// ── 固定事实 ──────────────────────────────────────────────────────
/** 运行期内存里的凭据真值：出现在任何 DTO 字段里即为失败（P1 隐私门槛）。 */
const API_KEY = "sk-test-9f3c1a7b5d2e4086";
const PROVIDER_ID = "zai";
const MODEL_ID = "glm-test";
const NO_TOOL_MODEL_ID = "glm-no-tool";
/** 公网 DNS：catalog/live 档的 #7 出口校验需要它通过，且必须封闭（不发真实解析）。 */
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const CHECKPOINT_COUNT = PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.length;

// ── Registry 快照 fixture ────────────────────────────────────────
// projectProviderRegistryServiceSnapshot 只读这几个字段（adapters/doctor/defaults.ts）：
// registry.providers[].{providerId,providerName,templateId,config,models}、
// resolution.{resolvedProviders,issues}、sourceRevisions.config。
function modelConfig(overrides = {}) {
  return {
    properties: { supportsToolCall: true, supportsJsonSchemaOutput: false, ...overrides.properties },
    optionSpecs: {
      reasoningLevel: { values: ["disabled", "enabled"] },
      maxOutputTokens: { max: 32000 },
      ...overrides.optionSpecs,
    },
    ...overrides,
  };
}

function registryProvider(overrides = {}) {
  const models = overrides.models ?? [
    { modelId: MODEL_ID, config: modelConfig() },
    { modelId: NO_TOOL_MODEL_ID, config: modelConfig({ properties: { supportsToolCall: false } }) },
  ];
  return {
    providerId: PROVIDER_ID,
    providerName: "Z.AI Coding Plan",
    templateId: "zai-coding-plan",
    config: {
      access: { type: "api-key", apiKey: API_KEY },
      api: { type: "openai-chat-completions", baseUrl: "https://api.provider.example/v1" },
    },
    models,
    ...overrides,
  };
}

function registrySnapshot(providers = [registryProvider()]) {
  return {
    sourceRevisions: { config: "7", account: "1" },
    config: {},
    account: {},
    resolution: { resolvedProviders: [], issues: [], registryProviders: providers },
    registry: { revision: "7", providers },
  };
}

/** 注入用的 registry source：记录 refresh 是否被调用（offline 档必须为 0）。 */
function createRegistrySource(snapshot) {
  const calls = { refresh: 0 };
  return {
    calls,
    source: {
      async refresh() {
        calls.refresh += 1;
      },
      getSnapshot: () => snapshot,
    },
  };
}

// ── 计数 Port（U08-A1 的承重断言面）────────────────────────────────
function createCountingHttp(responder) {
  const calls = [];
  return {
    calls,
    port: {
      async request(request) {
        calls.push(request);
        return responder(request);
      },
    },
  };
}

function createCountingModels(options = {}) {
  const calls = [];
  const client = {
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    async generateText(request) {
      calls.push({ kind: "generate", tools: (request.tools ?? []).map((t) => t.name) });
      if (options.failWith) throw new Error(options.failWith);
      if ((request.tools ?? []).length > 0) {
        return {
          text: "",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [{ id: "1", name: "acode_doctor_probe", input: { acknowledged: true } }],
        };
      }
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
    async *streamText() {
      calls.push({ kind: "stream" });
      if (options.failWith) throw new Error(options.failWith);
      yield { type: "text_delta", text: "ok" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      };
    },
  };
  return {
    calls,
    port: {
      createModel(input) {
        calls.push({ kind: "createModel", providerId: input.providerId, modelId: input.modelId });
        return client;
      },
    },
  };
}

/** 凭据 Port：按 fixture 场景返回三种不同事实（引用悬空 / 可解密 / 库不可用）。 */
function credentialPort(status, detail) {
  return {
    async probe() {
      // 来源恒为 credential-ref：fixture 的 provider 用的是凭据库引用形态。
      return { status, source: "credential-ref", detail };
    },
  };
}

function inMemoryLedger() {
  const events = [];
  return {
    events,
    port: {
      async record(event) {
        events.push(event);
      },
      async read() {
        return { events: [...events], corruptLines: 0 };
      },
    },
  };
}

const catalogBody = (ids) => JSON.stringify({ data: ids.map((id) => ({ id })) });

/**
 * 组装一个带计数 Port 的执行器。所有 IO 都是注入的：无真实网络、无真实 DNS、无真实磁盘账本
 * （ledger 用内存版，但仍走真实 resolveProviderDoctorLedgerPath + 临时 baseDir）。
 */
async function createHarness(options = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), "u08-diagnostics-"));
  const http = options.http ?? createCountingHttp(async () => ({
    status: 200,
    bodyText: catalogBody([MODEL_ID, NO_TOOL_MODEL_ID]),
  }));
  const models = options.models ?? createCountingModels(options.modelsOptions);
  const ledger = options.ledger ?? inMemoryLedger();
  const registry = createRegistrySource(options.snapshot ?? registrySnapshot());
  const dnsCalls = [];
  const dnsLookup = async (host, opts) => {
    dnsCalls.push(host);
    return PUBLIC_DNS(host, opts);
  };

  const executor = createProviderDiagnosticsProtocolExecutor({
    registry: registry.source,
    // 生产事实：协议 worker 的 env 必带这两个配置源路径——
    // resolveNodeProviderRuntimePaths 要求二者同时存在，否则 startProcessProviderRegistryRuntime
    // 直接抛（provider-node/src/runtime-paths.ts）。fixture 照抄，否则 #1 config_sources_loaded
    // 会因「未解析到任何配置源」失败，测的就不是本项的行为了。
    env: {
      ACODE_DATA_BASE_DIR: baseDir,
      ACODE_BUILTIN_PROVIDER_CONFIG_FILE: join(baseDir, "acode-builtin.json"),
      ACODE_PERSONAL_PROVIDER_CONFIG_FILE: join(baseDir, "provider_config.json"),
    },
    assemblePorts: () => ({
      credentials: options.credentials ?? credentialPort("available", "凭据可解密"),
      http: http.port,
      models: models.port,
      ledger: ledger.port,
      dnsLookup,
    }),
  });

  return {
    executor,
    http,
    models,
    ledger,
    registry,
    dnsCalls,
    baseDir,
    cleanup: async () => rm(baseDir, { recursive: true, force: true }),
  };
}

function request(overrides = {}) {
  return {
    requestId: "req-1",
    providerId: PROVIDER_ID,
    revision: 7,
    tier: "offline",
    ...overrides,
  };
}

function checkpointOf(result, id) {
  return result.checkpoints.find((c) => c.id === id);
}

// ── U08-A1: offline 档零网络 ──────────────────────────────────────
test("U08-A1: offline 档网络/DNS/model 调用数全 0，且 registry.refresh 不被调用", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const result = await harness.executor.run(request({ tier: "offline" }));

  // 承重断言：三类网络出口一次都没被触到。
  assert.equal(harness.http.calls.length, 0, "offline 档不得发出任何 HTTP 请求");
  assert.equal(harness.dnsCalls.length, 0, "offline 档不得做任何 DNS 解析");
  const modelCalls = harness.models.calls.filter((c) => c.kind === "createModel");
  assert.equal(modelCalls.length, 0, "offline 档不得构造任何模型客户端（零推理）");
  assert.equal(result.spend.billableCalls, 0, "offline 档零计费调用");
  assert.equal(result.spend.catalogCalls, 0, "offline 档零目录请求");
  assert.equal(result.blockedNetworkCalls, 0, "接线未漏注入 blocked transport（否则 doctor 会计数）");
  // offline 刻意不 refresh：refresh 可能触发 Built-in 配置的远端刷新（doctor spec「零网络不是免费的」）。
  assert.equal(harness.registry.calls.refresh, 0, "offline 档不得触发 registry refresh");
});

test("U08-A1: offline 档结论不越档——tier-passed 而非 ready，#7-#12 全 skipped", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);

  const result = await harness.executor.run(request({ tier: "offline" }));

  assert.equal(result.status, "completed");
  assert.equal(result.verdict, "tier-passed", "轻档最高只到 tier-passed（doctor R2 不越档背书）");
  assert.notEqual(result.verdict, "ready", "offline 档绝不能声称模型可用");
  assert.equal(result.checkpoints.length, CHECKPOINT_COUNT, "检查点数量恒为 12");
  // catalog/live 档的 6 个检查点必须全 skipped（不是 passed，也不是 failed）。
  for (const id of [
    "endpoint_public_egress",
    "catalog_live_endpoint",
    "catalog_model_listed",
    "non_streaming_chat_completion",
    "streaming_chat_completion",
    "tool_call_parse",
  ]) {
    assert.equal(checkpointOf(result, id).status, "skipped", `${id} 在 offline 档应为 skipped`);
  }
  // offline 档的 6 个本地检查点确实跑了（否则 tier-passed 是空背书）。
  for (const id of [
    "config_sources_loaded",
    "provider_schema_valid",
    "endpoint_shape_valid",
    "credential_available",
    "catalog_models_declared",
    "model_route_resolved",
  ]) {
    assert.equal(checkpointOf(result, id).status, "passed", `${id} 在 offline 档应为 passed`);
  }
});

test("U08-A1: offline 档 revision 逐字回显（host/worker 两套计数器不可比较，必须回显请求值）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ revision: 42 }));
  assert.equal(result.revision, 42, "回显请求 revision，UI 才能据此做 fencing");
  assert.equal(result.requestId, "req-1");
});

// ── U08-A2: 三种凭据/目录故障的稳定错误码互不相同 ───────────────────
test("U08-A2: 错误密钥 / 空目录 / 凭据引用悬空 → 三个互不相同的稳定错误码", async (t) => {
  // ① 凭据引用悬空（本地可判定，offline 档即出结论）→ credential-missing
  const dangling = await createHarness({
    credentials: credentialPort("missing", "凭据库中没有该引用对应的值"),
  });
  t.after(dangling.cleanup);
  const danglingResult = await dangling.executor.run(request({ tier: "offline" }));
  // status 与 verdict 是刻意分开的两个字段（spec 接口契约）：
  // status=completed 表示「诊断本身跑完了并拿到报告」，verdict=failed 表示「配置结论是不通过」。
  // 把两者混成一个会让「诊断没跑起来」与「跑起来了但配置坏了」不可区分。
  assert.equal(danglingResult.status, "completed", "诊断执行成功完成");
  assert.equal(danglingResult.verdict, "failed", "配置结论为不通过");
  assert.equal(danglingResult.errorCode, "credential-missing");
  assert.equal(checkpointOf(danglingResult, "credential_available").status, "failed");
  // offline 档不伪造远端鉴权结论：只报「本地凭据缺失」，绝不报「密钥被拒」。
  assert.notEqual(danglingResult.errorCode, "credential-rejected");
  assert.equal(
    danglingResult.checkpoints.some((c) => c.status === "passed" && c.id === "catalog_live_endpoint"),
    false,
    "offline 档不得对远端目录给出任何通过结论",
  );

  // ② 密钥被端点拒绝（401）→ credential-rejected；只有联网才知道
  const rejected = await createHarness({
    http: createCountingHttp(async () => ({ status: 401, bodyText: '{"error":"invalid key"}' })),
  });
  t.after(rejected.cleanup);
  const rejectedResult = await rejected.executor.run(request({ tier: "catalog" }));
  assert.equal(rejectedResult.errorCode, "credential-rejected");
  assert.equal(checkpointOf(rejectedResult, "catalog_live_endpoint").status, "failed");
  assert.equal(rejectedResult.spend.catalogCalls, 1, "目录请求确实发出了一次");

  // ③ 目录端点 2xx 但为空 → catalog-empty
  const empty = await createHarness({
    http: createCountingHttp(async () => ({ status: 200, bodyText: catalogBody([]) })),
  });
  t.after(empty.cleanup);
  const emptyResult = await empty.executor.run(request({ tier: "catalog" }));
  assert.equal(emptyResult.errorCode, "catalog-empty");
  assert.equal(checkpointOf(emptyResult, "catalog_live_endpoint").status, "failed");

  // 三者互不相同——这是 GUI 能给出三种不同修复动作的前提。
  const codes = new Set([
    danglingResult.errorCode,
    rejectedResult.errorCode,
    emptyResult.errorCode,
  ]);
  assert.equal(codes.size, 3, `三个故障的稳定码必须互不相同，实际: ${[...codes].join(", ")}`);
});

test("U08-A2: 网络不可达与目录不支持各自独立成码，且 unsupported 记 skipped 不记 failed", async (t) => {
  const unreachable = await createHarness({
    http: createCountingHttp(async () => {
      throw new Error("connect ETIMEDOUT");
    }),
  });
  t.after(unreachable.cleanup);
  const unreachableResult = await unreachable.executor.run(request({ tier: "catalog" }));
  assert.equal(unreachableResult.errorCode, "catalog-unreachable");

  const unsupported = await createHarness({
    http: createCountingHttp(async () => ({ status: 404, bodyText: "not found" })),
  });
  t.after(unsupported.cleanup);
  const unsupportedResult = await unsupported.executor.run(request({ tier: "catalog" }));
  // 端点不支持目录列举 = 不可检查，不是失败（U08-A5 同源语义）。
  const endpoint = checkpointOf(unsupportedResult, "catalog_live_endpoint");
  assert.equal(endpoint.status, "skipped", "404/405/501 应记 skipped");
  assert.equal(endpoint.reasonCode, "catalog-unsupported");
});

test("U08-A2: 未知 providerId → provider-unknown，且零网络调用", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ providerId: "does-not-exist" }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "provider-unknown");
  assert.equal(harness.http.calls.length, 0, "provider 不存在时不得发任何请求");
  assert.equal(result.revision, 7, "失败终态也要回显 revision");
});

// ── U08-A5: skipped 与 failed 可区分 ──────────────────────────────
test("U08-A5: 模型不支持 tool call → tool_call_parse 为 skipped 且带 tool-call-unsupported", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  // 选不支持 tool call 的模型（fixture 里 supportsToolCall=false）。
  const result = await harness.executor.run(
    request({ tier: "live", liveOptIn: true, modelId: NO_TOOL_MODEL_ID }),
  );
  const toolCheck = checkpointOf(result, "tool_call_parse");
  assert.equal(toolCheck.status, "skipped", "doctor R3：模型不支持 tool 时记 skipped 而非失败");
  assert.equal(toolCheck.reasonCode, "tool-call-unsupported");
  // 另两个 live 探针照常跑并通过，因此结论是 tier-passed 而非 ready（12 点未全 passed）。
  assert.equal(checkpointOf(result, "non_streaming_chat_completion").status, "passed");
  assert.equal(checkpointOf(result, "streaming_chat_completion").status, "passed");
  assert.equal(result.verdict, "tier-passed", "有 skipped 就不能判 ready");
});

test("U08-A5: live 档 12 点全 passed → ready（唯一能出 ready 的路径）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ tier: "live", liveOptIn: true }));
  assert.equal(result.verdict, "ready");
  assert.equal(result.checkpoints.every((c) => c.status === "passed"), true);
  assert.equal(result.spend.billableCalls, 3, "三次真实探针（非流式/流式/工具）");
});

test("U08-A5: 四态在 DTO 里逐字保留——skipped 不被折叠进 failed 或 passed", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ tier: "offline" }));
  const statuses = new Set(result.checkpoints.map((c) => c.status));
  // offline 档同时存在 passed（#1-#6）与 skipped（#7-#12）。
  assert.ok(statuses.has("passed"), "应含 passed");
  assert.ok(statuses.has("skipped"), "应含 skipped");
  assert.equal(statuses.has("failed"), false, "本 fixture 配置合法，不应有 failed");
});

// ── R9: live 授权门禁 ────────────────────────────────────────────
test("R9: tier=live 缺 liveOptIn → live-opt-in-required，零模型调用（执行方第二道门）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  // 服务侧编排器已挡一道；这里是执行方的第二道，不依赖调用方自律。
  const result = await harness.executor.run(request({ tier: "live" }));
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "live-opt-in-required");
  assert.equal(harness.models.calls.length, 0, "未 opt-in 绝不构造模型客户端");
  assert.equal(harness.http.calls.length, 0);
  assert.equal(result.spend, undefined, "没跑起来时花费未知，不得填 0 冒充没花钱");
});

// ── U08-A3: 取消语义 ─────────────────────────────────────────────
test("U08-A3: cancel 只中止该 requestId；未知 requestId 回 cancelled:false 且不是错误", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  // 未知 requestId：不在飞不是错误（R4）。
  const unknown = harness.executor.cancel({ requestId: "never-existed" });
  assert.deepEqual(unknown, { requestId: "never-existed", cancelled: false });
  assert.equal("spend" in unknown, false, "不在飞时不得编造 spend");

  // 在飞的请求可被取消：model port 阻塞到 abortSignal 触发才 reject——
  // 与真实 AI SDK transport 一致（probeSignal 把 doctor 的 signal 传进每次模型调用，
  // live-probe.ts:307-310）。事件驱动等待，不用固定 sleep。
  let enteredProbe;
  const probeEntered = new Promise((resolve) => {
    enteredProbe = resolve;
  });
  const blocking = {
    calls: [],
    port: {
      createModel() {
        // 两个探针都阻塞到 abortSignal 触发才 reject——与真实 AI SDK transport 一致
        // （probeSignal 把 doctor 的 signal 传进每次模型调用，live-probe.ts:307-310）。
        const blockUntilAbort = (request) =>
          new Promise((resolve, reject) => {
            enteredProbe();
            const signal = request.abortSignal;
            if (signal?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        return {
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
          generateText: (request) => blockUntilAbort(request),
          // streamText 必须是 async **iterable**（Model 契约：live-probe 用 for-await 消费）。
          // 用 Symbol.asyncIterator 而不是 async generator：取消场景下它在产出任何事件
          // **之前**就 reject，写成 generator 会触发 require-yield（语法层规则）。
          streamText: (request) => ({
            [Symbol.asyncIterator]: () => ({
              next: () => blockUntilAbort(request).then(() => ({ done: true, value: undefined })),
            }),
          }),
        };
      },
    },
  };
  const liveHarness = await createHarness({ models: blocking });
  t.after(liveHarness.cleanup);
  const pending = liveHarness.executor.run(
    request({ requestId: "live-1", tier: "live", liveOptIn: true }),
  );
  // 等 model port 真的被触到（此时才谈得上「在飞」）。
  await probeEntered;
  const cancelResult = liveHarness.executor.cancel({ requestId: "live-1" });
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.requestId, "live-1");

  const cancelled = await pending;
  // 承重断言：取消必须是 cancelled 终态，而不是「completed + 检查点 failed」。
  // doctor 的探针会把 AbortError 归一成检查点 failed 并正常 resolve，若适配层不检查
  // signal，用户点了取消却会看到「你的配置有问题」——把取消误报成配置故障。
  assert.equal(cancelled.status, "cancelled", "取消不得被误报成 completed");
  assert.equal(cancelled.errorCode, "cancelled");
  assert.equal(cancelled.verdict, undefined, "取消的结果不得带 verdict（否则 UI 会当成结论）");
  // R4：DTO 里不存在任何退费语义字段——已发出的请求无法撤销，不能谎称退还。
  const serialized = JSON.stringify(cancelled).toLowerCase();
  for (const forbidden of ["refund", "refunded", "chargeback", "reversed", "reimburs"]) {
    assert.equal(serialized.includes(forbidden), false, `取消结果不得含退费语义: ${forbidden}`);
  }
});

// ── U08-P1: 隐私门槛 ─────────────────────────────────────────────
test("U08-P1: 真实明文 key 在 fixture 里，序列化后的 DTO 零泄漏", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  for (const tier of ["offline", "catalog", "live"]) {
    const result = await harness.executor.run(
      request({ tier, ...(tier === "live" ? { liveOptIn: true } : {}) }),
    );
    const serialized = JSON.stringify(result);
    assert.equal(
      serialized.includes(API_KEY),
      false,
      `${tier} 档结果泄漏了完整 API Key`,
    );
    // 密钥形态与 Authorization 头也不得出现（DTO 结构性无承载字段，这里是双保险）。
    assert.equal(/sk-test-/.test(serialized), false, `${tier} 档结果含 sk- 形态密钥`);
    assert.equal(/authorization/i.test(serialized), false, `${tier} 档结果含 authorization`);
    assert.equal(/bearer/i.test(serialized), false, `${tier} 档结果含 Bearer`);
    // 结构性排除：DTO 里没有任何 label/detail 字段可夹带自由文本。
    assert.equal(
      result.checkpoints.some((c) => "detail" in c || "label" in c),
      false,
      "检查点不得携带 detail/label 自由文本",
    );
    // baseUrl 全串不进 DTO，只允许 host。
    assert.equal(
      serialized.includes("https://api.provider.example/v1"),
      false,
      "baseUrl 全串不得进 DTO（只允许 endpointHost）",
    );
    assert.equal(result.endpointHost, "api.provider.example");
  }
});

test("U08-P1: 账本事件里也无凭据（doctor R5 在本路径仍成立）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await harness.executor.run(request({ tier: "catalog" }));
  assert.ok(harness.ledger.events.length > 0, "应写入账本事件");
  const ledgerText = JSON.stringify(harness.ledger.events);
  assert.equal(ledgerText.includes(API_KEY), false, "账本泄漏了完整 API Key");
  assert.equal(/authorization|bearer/i.test(ledgerText), false, "账本含 Authorization/Bearer");
  // reasonCode 是 U08 的 additive 字段，刻意**不进**账本（账本 schemaVersion 不变）。
  assert.equal(
    harness.ledger.events.some((event) =>
      event.checks.some((check) => "reasonCode" in check),
    ),
    false,
    "reasonCode 不得进 JSONL 账本（账本 schema 保持不变）",
  );
});

// ── 契约完整性 ───────────────────────────────────────────────────
test("结果恒为 12 检查点且 id 集合与契约闭集一致（不多不少不重复）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ tier: "offline" }));
  const ids = result.checkpoints.map((c) => c.id);
  assert.equal(ids.length, CHECKPOINT_COUNT);
  assert.deepEqual([...ids].sort(), [...PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS].sort());
  assert.equal(new Set(ids).size, CHECKPOINT_COUNT, "检查点 id 不得重复");
});

test("修复动作全部落在契约白名单内（UI 才能映射 i18n，不能据此拼命令）", async (t) => {
  const { PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS } = await import(
    "../../../packages/shared/src/providerDiagnostics.ts"
  );
  const allowed = new Set(PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS);
  const harness = await createHarness();
  t.after(harness.cleanup);
  for (const tier of ["offline", "catalog", "live"]) {
    const result = await harness.executor.run(
      request({ tier, ...(tier === "live" ? { liveOptIn: true } : {}) }),
    );
    for (const action of result.remediationActions) {
      assert.ok(allowed.has(action), `未知修复动作: ${action}`);
    }
  }
  // 失败态的修复动作同样在白名单内。
  const failing = await createHarness({
    credentials: credentialPort("missing", "凭据缺失"),
  });
  t.after(failing.cleanup);
  const failed = await failing.executor.run(request({ tier: "offline" }));
  assert.ok(failed.remediationActions.length > 0, "失败态必须给修复动作");
  assert.ok(failed.remediationActions.includes("verify-later"), "失败不清空已保存 provider，可稍后验证");
  for (const action of failed.remediationActions) {
    assert.ok(allowed.has(action), `未知修复动作: ${action}`);
  }
});

test("offline 档升档建议指向 catalog，catalog 档指向 live（doctor R7 升档提示不丢失）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const offline = await harness.executor.run(request({ tier: "offline" }));
  assert.ok(
    offline.remediationActions.includes("escalate-tier-catalog"),
    "offline 通过应建议升档到 catalog",
  );
  assert.ok(
    offline.nextStepCommands.some((cmd) => cmd.includes("--tier=catalog")),
    "升档建议应带可粘贴命令",
  );
  const catalog = await harness.executor.run(request({ tier: "catalog", requestId: "req-2" }));
  assert.ok(
    catalog.remediationActions.includes("escalate-tier-live"),
    "catalog 通过应建议升档到 live",
  );
});

test("入参运行时校验：畸形请求被 schema 拒绝（跨进程边界 fail-loud）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  await assert.rejects(
    () => harness.executor.run({ requestId: "r", providerId: PROVIDER_ID, revision: 1 }),
    /provider-diagnostics-request-invalid/,
    "缺 tier 应被拒（tier 无 schema 默认值，不静默升档）",
  );
  await assert.rejects(
    () => harness.executor.run({ ...request(), apiKey: API_KEY }),
    /provider-diagnostics-request-invalid/,
    ".strict() 应拒绝凭据形态字段",
  );
  await assert.throws(
    () => harness.executor.cancel({}),
    /provider-diagnostics-cancel-invalid/,
    "取消缺 requestId 应被拒",
  );
});

test("零花费常量未被适配层改写（offline 档 spend 与常量逐字一致）", async (t) => {
  const harness = await createHarness();
  t.after(harness.cleanup);
  const result = await harness.executor.run(request({ tier: "offline" }));
  assert.deepEqual(result.spend, PROVIDER_DIAGNOSTICS_ZERO_SPEND);
});
