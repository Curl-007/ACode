import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * J3-1 验收测试：Provider Doctor 分档诊断 + 覆盖账本。
 *
 * 覆盖 apps/acode-cli/specs/provider-doctor.md 的 R1-R7 与「验收场景」1-7：
 * offline 档零网络、三档输出结构、账本无凭据、host 校验拒绝私网、未通过项给下一步命令、
 * 覆盖账本与新鲜度、接线钉住（源断言，仓库既有惯例）。
 *
 * 机制参照 jcode (MIT) crates/jcode-provider-doctor 与 docs/PROVIDER_DOCTOR.md
 * （三档 tier × 12 检查点 + 花费跟踪 + 覆盖账本），用例为自撰 TypeScript。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { runProviderDoctor } = await import(
  "../packages/adapters/src/doctor/run-provider-doctor.ts"
);
const {
  createTierGuardedDnsLookup,
  createTierGuardedModelPort,
} = await import("../packages/adapters/src/doctor/run-provider-doctor.ts");
const {
  PROVIDER_DOCTOR_CHECKPOINT_CATALOG,
  PROVIDER_DOCTOR_CHECKPOINT_COUNT,
  PROVIDER_DOCTOR_CHECKPOINT_IDS,
  isCheckpointRunAtTier,
  isProviderDoctorTier,
  providerDoctorCommand,
  providerDoctorEscalationHint,
} = await import("../packages/adapters/src/doctor/checkpoints.ts");
const {
  createProviderDoctorCredentialPort,
  resolveProviderDoctorApiKey,
} = await import("../packages/adapters/src/doctor/credential-probe.ts");
const {
  createFileProviderDoctorLedger,
  createProviderDoctorLedgerEvent,
  parseProviderDoctorLedger,
  readProviderDoctorLedgerFile,
  resolveProviderDoctorLedgerPath,
  summarizeProviderDoctorCoverage,
} = await import("../packages/adapters/src/doctor/ledger.ts");
const {
  buildProviderCatalogHeaders,
  buildProviderCatalogUrl,
  inspectProviderEndpoint,
} = await import("../packages/adapters/src/doctor/endpoint-policy.ts");
const { createProviderDoctorRedactor, findCredentialLikeKeys } = await import(
  "../packages/adapters/src/doctor/redaction.ts"
);
const {
  formatCoverageLines,
  formatProviderDoctorRun,
  providerDoctorJsonPayload,
} = await import("../packages/adapters/src/doctor/format-report.ts");
// 评审 J3 修复的接线证据：用**真实**的 standalone headers port（生产里 CLI 就是拿它
// 包成 accountAuth），而不是自造桩件——桩件不会要求 accountAccess，也就复现不出误报。
const { createStandaloneProviderRuntimeHeadersPort } =
  await import("../packages/bootstrap/src/app/standalone-account-provider-runtime.ts");
const { createRootTraceContext, createSessionId } =
  await import("../packages/contracts/src/index.ts");

// ── 固定事实（确定性断言用） ─────────────────────────────────────────

/** 运行期内存里的凭据真值：任何输出/账本里出现它就是失败。 */
const API_KEY = "sk-test-9f3c1a7b5d2e4086";
const ACCOUNT_KEY = "sk-account-77aa11bb22cc33dd";
const MODEL_ID = "glm-test";
const SECOND_MODEL_ID = "glm-second";
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const LOOPBACK_DNS = async () => [{ address: "127.0.0.1", family: 4 }];

const modelFacts = (overrides = {}) => ({
  modelId: MODEL_ID,
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  reasoningLevels: ["disabled", "enabled"],
  maxOutputTokens: 32000,
  issues: [],
  ...overrides,
});

const providerFacts = (overrides = {}) => ({
  providerId: "zai",
  providerName: "Z.AI Coding Plan",
  access: { type: "api-key", hasInlineApiKey: true, hasCredentialRef: false },
  apiType: "openai-chat-completions",
  baseUrl: "https://api.provider.example/v1",
  models: [modelFacts(), modelFacts({ modelId: SECOND_MODEL_ID })],
  issues: [],
  providerConfig: { access: { type: "api-key", apiKey: API_KEY } },
  modelConfigs: { [MODEL_ID]: {}, [SECOND_MODEL_ID]: {} },
  secretValues: [API_KEY],
  ...overrides,
});

const snapshot = (providers) => ({
  revision: "7",
  sources: {
    acodeBuiltinFilePath: join("/data", ".acode", "v2", "acode-builtin.json"),
    personalFilePath: join("/data", ".acode", "v2", "provider_config.json"),
    credentialsFilePath: join("/data", ".acode", "v2", "credentials.json"),
  },
  providers,
});

const createRecordingHttp = (responder) => {
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
};

const catalogBody = (ids) => JSON.stringify({ data: ids.map((id) => ({ id })) });

const createRecordingModels = (options = {}) => {
  const calls = [];
  const client = {
    providerId: "zai",
    modelId: MODEL_ID,
    async generateText(request) {
      calls.push({ kind: "generate", tools: (request.tools ?? []).map((tool) => tool.name) });
      if (options.failWith) throw new Error(options.failWith);
      if ((request.tools ?? []).length > 0) {
        return {
          text: "",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: options.malformedToolCall
            ? [{ id: "1", name: "other_tool", input: "not-an-object" }]
            : [{ id: "1", name: "acode_doctor_probe", input: { acknowledged: true } }],
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
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } };
    },
  };
  return { calls, port: { createModel: () => client } };
};

const credentialPort = (overrides = {}) =>
  createProviderDoctorCredentialPort({
    vault: { load: async () => API_KEY },
    credentialsFilePath: join("/data", ".acode", "v2", "credentials.json"),
    ...overrides,
  });

const inMemoryLedger = () => {
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
};

const checkById = (report) =>
  Object.fromEntries(report.checks.map((check) => [check.id, check]));

const runDoctor = async (overrides = {}) => {
  const ledger = overrides.ledger ?? inMemoryLedger();
  const http = overrides.http ?? createRecordingHttp(async () => ({ status: 200, bodyText: catalogBody([MODEL_ID, SECOND_MODEL_ID]) }));
  const models = overrides.models ?? createRecordingModels();
  const result = await runProviderDoctor({
    tier: overrides.tier ?? "offline",
    registry: { loadLocalSnapshot: async () => overrides.snapshot ?? snapshot([providerFacts()]) },
    credentials: overrides.credentials ?? credentialPort(),
    http: http.port,
    models: models.port,
    ledger: ledger.port,
    ledgerPath: overrides.ledgerPath ?? join("/data", "coverage.jsonl"),
    dnsLookup: overrides.dnsLookup ?? PUBLIC_DNS,
    ...(overrides.providerId ? { providerId: overrides.providerId } : {}),
    ...(overrides.modelId ? { modelId: overrides.modelId } : {}),
    ...(overrides.invocationContext ? { invocationContext: overrides.invocationContext } : {}),
    ...(overrides.accountAuth ? { accountAuth: overrides.accountAuth } : {}),
  });
  return { result, http, models, ledger };
};

// ── (1) offline 档零网络 + 输出结构 ─────────────────────────────────

test("(1) offline 档零网络：12 个检查点、后 6 个 skipped、无任何出网与模型调用", async () => {
  const { result, http, models, ledger } = await runDoctor({ tier: "offline" });
  const report = result.reports[0];

  assert.equal(result.blockedNetworkCalls, 0, "offline 档不应触发被拦截的网络尝试");
  assert.equal(http.calls.length, 0, "offline 档不得发出任何 HTTP 请求");
  assert.equal(models.calls.length, 0, "offline 档不得发起任何模型调用");

  assert.equal(report.checks.length, PROVIDER_DOCTOR_CHECKPOINT_COUNT);
  assert.deepEqual(
    report.checks.map((check) => check.id),
    [...PROVIDER_DOCTOR_CHECKPOINT_IDS],
    "检查点顺序必须与目录一致",
  );

  const checks = checkById(report);
  for (const id of [
    "config_sources_loaded",
    "provider_schema_valid",
    "endpoint_shape_valid",
    "credential_available",
    "catalog_models_declared",
    "model_route_resolved",
  ]) {
    assert.equal(checks[id].status, "passed", `${id} 应在 offline 档通过`);
  }
  for (const id of [
    "endpoint_public_egress",
    "catalog_live_endpoint",
    "catalog_model_listed",
    "non_streaming_chat_completion",
    "streaming_chat_completion",
    "tool_call_parse",
  ]) {
    assert.equal(checks[id].status, "skipped", `${id} 在 offline 档必须记 skipped 而不是通过`);
  }

  // 轻档绝不给重档背书（spec R2）
  assert.equal(report.tierPassed, true);
  assert.equal(report.ready, false);
  assert.equal(report.verdict, "tier-passed");
  assert.equal(report.spend.billableCalls, 0);
  assert.equal(report.spend.catalogCalls, 0);

  assert.equal(ledger.events.length, 1, "每次运行落一条账本证据");
  assert.equal(ledger.events[0].result, "tier-passed");
  assert.equal(ledger.events[0].tier, "offline");
  assert.equal(ledger.events[0].checks.length, PROVIDER_DOCTOR_CHECKPOINT_COUNT);

  // 未通过项为空时仍必须给出升档命令（spec R7）
  assert.equal(report.nextSteps.length, 1);
  assert.match(report.nextSteps[0], /--tier=catalog/);
});

test("(1b) offline 档：credential 缺失即失败，且仍不出网", async () => {
  const credentials = credentialPort({ vault: { load: async () => null } });
  const { result, http } = await runDoctor({
    tier: "offline",
    credentials,
    snapshot: snapshot([
      providerFacts({
        access: { type: "api-key", hasInlineApiKey: false, hasCredentialRef: true, credentialRef: "provider:apikey:zai" },
        providerConfig: { access: { type: "api-key", credentialRef: "provider:apikey:zai" } },
      }),
    ]),
  });
  const checks = checkById(result.reports[0]);
  assert.equal(checks.credential_available.status, "failed");
  assert.equal(http.calls.length, 0);
  assert.equal(result.reports[0].tierPassed, false);
  assert.equal(result.reports[0].verdict, "failed");
  // 失败必须给可执行的下一步（spec R7）
  assert.ok(result.reports[0].nextSteps.length > 0);
  assert.match(result.reports[0].nextSteps.join("\n"), /API Key/);
});

test("(1c) offline 档：凭据库不可用记 blocked（无法证明 ≠ 失败），并给出下一步", async () => {
  const credentials = credentialPort({
    vault: {
      load: async () => {
        throw new Error("credential store is locked");
      },
    },
  });
  const { result } = await runDoctor({
    tier: "offline",
    credentials,
    snapshot: snapshot([
      providerFacts({
        access: { type: "api-key", hasInlineApiKey: false, hasCredentialRef: true, credentialRef: "provider:apikey:zai" },
      }),
    ]),
  });
  const checks = checkById(result.reports[0]);
  assert.equal(checks.credential_available.status, "blocked");
  assert.equal(result.reports[0].tierPassed, false);
});

test("(1d) 账号型 provider：entitled=false 直接失败并建议 acode login", async () => {
  const { result } = await runDoctor({
    tier: "offline",
    snapshot: snapshot([
      providerFacts({
        providerId: "zai",
        access: { type: "zhipu-account", accountType: "zai", accountMode: "individual-coding-plan", entitled: false, hasInlineApiKey: false, hasCredentialRef: false },
        apiType: "anthropic-messages",
        baseUrl: "https://api.z.ai/api/anthropic",
      }),
    ]),
  });
  const report = result.reports[0];
  assert.equal(checkById(report).credential_available.status, "failed");
  assert.match(report.nextSteps.join("\n"), /acode login/);
});

// ── (1e-1g) 评审 J3 修复：账号型 provider 的请求身份必须随诊断下发 ──────

/** 账号身份事实：与真实 registry 里 zai/bigmodel individual-coding-plan 的形状一致。 */
const ACCOUNT_ACCESS = {
  type: "zhipu-account",
  accountType: "zai",
  mode: "individual-coding-plan",
  entitled: true,
};

const accountProviderFacts = () =>
  providerFacts({
    providerId: "zai",
    access: {
      type: "zhipu-account",
      accountType: "zai",
      accountMode: "individual-coding-plan",
      entitled: true,
      hasInlineApiKey: false,
      hasCredentialRef: false,
    },
    apiType: "anthropic-messages",
    baseUrl: "https://api.z.ai/api/anthropic",
    providerConfig: { access: ACCOUNT_ACCESS },
    secretValues: [],
  });

/** 真实 standalone headers port 的接线包装（CLI provider-doctor-command.ts 同款）。 */
function standaloneAccountAuth({ forwardAccountAccess }) {
  const headersPort = createStandaloneProviderRuntimeHeadersPort(
    // 凭据库桩件：身份与 key 都读得出 = 「已登录且凭据可解密」。
    { load: async () => "stub-decryptable-account-key", loadMany: async () => new Map() },
    {},
  );
  const sessionId = createSessionId("provider-doctor-test");
  const traceContext = createRootTraceContext({ sessionId });
  return {
    resolve: async (input) =>
      (
        await headersPort.refreshBeforeModelRequest({
          providerId: input.providerId,
          modelId: input.modelId ?? "",
          reason: "model-request",
          sessionId,
          traceContext,
          ...(forwardAccountAccess && input.accountAccess
            ? { accountAccess: input.accountAccess }
            : {}),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        })
      ).requestAuth,
  };
}

test("(1e) 账号型 provider：已登录且凭据可解密 → credential_available passed，不再让人去重新登录", async () => {
  const { result } = await runDoctor({
    tier: "offline",
    snapshot: snapshot([accountProviderFacts()]),
    credentials: credentialPort({
      accountAuth: standaloneAccountAuth({ forwardAccountAccess: true }),
      vault: { load: async () => null },
    }),
  });
  const report = result.reports[0];
  const checks = checkById(report);
  // spec R3 #4：凭据存在且可解密 → passed。
  assert.equal(checks.credential_available.status, "passed");
  assert.match(checks.credential_available.detail, /可解密/);
  assert.ok(
    !checks.credential_available.detail.includes("请求身份无效"),
    `不应再把接线缺身份报成解密失败: ${checks.credential_available.detail}`,
  );
  assert.equal(report.tierPassed, true, "offline 档六项全过就该 tier-passed");
  assert.ok(!report.nextSteps.join("\n").includes("acode login"));
});

test("(1f) doctor 把账号请求身份交给鉴权端口：#4 探测与 #8 目录鉴权都带 accountAccess", async () => {
  const seen = [];
  const spyAuth = {
    resolve: async (input) => {
      seen.push(input);
      return { apiKey: ACCOUNT_KEY };
    },
  };
  const http = createRecordingHttp(async () => ({
    status: 200,
    bodyText: catalogBody([MODEL_ID, SECOND_MODEL_ID]),
  }));
  const { result, ledger } = await runDoctor({
    tier: "catalog",
    http,
    snapshot: snapshot([accountProviderFacts()]),
    credentials: credentialPort({ accountAuth: spyAuth, vault: { load: async () => null } }),
    accountAuth: spyAuth,
  });
  const report = result.reports[0];
  // #4 凭据探测（offline 档也走这条）与 #8 目录鉴权各解析一次，两次都要带身份。
  assert.ok(seen.length >= 2, `expected probe + catalog auth, got ${seen.length}`);
  for (const call of seen) {
    assert.deepEqual(call.accountAccess, ACCOUNT_ACCESS);
  }
  assert.equal(checkById(report).credential_available.status, "passed");
  assert.equal(checkById(report).catalog_live_endpoint.status, "passed");
  // 目录请求确实带上了账号鉴权头（anthropic-messages 方言）。
  assert.equal(http.calls[0].headers["x-api-key"], ACCOUNT_KEY);
  // spec R5：解析出的真值只用于构造请求，报告与账本里都不出现。
  const serialized = `${JSON.stringify(ledger.events)}${JSON.stringify(providerDoctorJsonPayload(result))}`;
  assert.ok(!serialized.includes(ACCOUNT_KEY));
  assert.ok(!formatProviderDoctorRun(result, { colors: false }).includes(ACCOUNT_KEY));
});

test("(1g) 反向钉住：接线不透传 accountAccess 时真实 headers port 直接拒绝（这就是修复前的误报形态）", async () => {
  const { result } = await runDoctor({
    tier: "offline",
    snapshot: snapshot([accountProviderFacts()]),
    credentials: credentialPort({
      accountAuth: standaloneAccountAuth({ forwardAccountAccess: false }),
      vault: { load: async () => null },
    }),
  });
  const report = result.reports[0];
  const checks = checkById(report);
  // 端口缺身份即抛 → 探测记 undecryptable → blocked，并连带 skip 掉 catalog/live 的 #8-#12。
  // 保留这条断言是为了钉住因果：doctor 侧一旦不再下发 accountAccess，(1e) 就会退化成这个样子。
  assert.equal(checks.credential_available.status, "blocked");
  assert.match(checks.credential_available.detail, /请求身份无效/);
  assert.match(report.nextSteps.join("\n"), /acode login/);
});

// ── (2) 三档输出结构 ────────────────────────────────────────────────

test("(2) catalog 档：出口校验 + 实时目录参与判定，live 检查点仍 skipped", async () => {
  const { result, http, models } = await runDoctor({ tier: "catalog" });
  const report = result.reports[0];
  const checks = checkById(report);

  assert.equal(checks.endpoint_public_egress.status, "passed");
  assert.equal(checks.catalog_live_endpoint.status, "passed");
  assert.equal(checks.catalog_model_listed.status, "passed");
  assert.equal(checks.non_streaming_chat_completion.status, "skipped");
  assert.equal(checks.streaming_chat_completion.status, "skipped");
  assert.equal(checks.tool_call_parse.status, "skipped");

  assert.equal(http.calls.length, 1, "catalog 档只发一次目录请求");
  assert.equal(http.calls[0].url, "https://api.provider.example/v1/models");
  assert.equal(http.calls[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(models.calls.length, 0, "catalog 档不得发起模型调用");

  assert.equal(report.verdict, "tier-passed");
  assert.equal(report.ready, false);
  assert.equal(report.spend.catalogCalls, 1);
  assert.equal(report.spend.billableCalls, 0);
  assert.match(report.nextSteps.join("\n"), /--tier=live/);
});

test("(2b) live 档：三次真实调用全通过 → READY，花费如实计数", async () => {
  const { result, models, ledger } = await runDoctor({ tier: "live" });
  const report = result.reports[0];

  assert.equal(report.checks.length, PROVIDER_DOCTOR_CHECKPOINT_COUNT);
  assert.ok(
    report.checks.every((check) => check.status === "passed"),
    `live 档应全通过，实际: ${report.checks.map((c) => `${c.id}=${c.status}`).join(", ")}`,
  );
  assert.equal(report.ready, true);
  assert.equal(report.verdict, "ready");
  assert.equal(report.nextSteps.length, 1, "READY 时给复验命令");
  assert.match(report.nextSteps[0], /READY/);

  assert.deepEqual(
    models.calls.map((call) => call.kind),
    ["generate", "stream", "generate"],
    "live 档=一次非流式 + 一次流式 + 一次工具调用",
  );
  assert.deepEqual(models.calls[2].tools, ["acode_doctor_probe"]);

  assert.equal(report.spend.billableCalls, 3);
  assert.equal(report.spend.promptTokens, 28);
  assert.equal(report.spend.outputTokens, 9);
  assert.equal(report.spend.totalTokens, 37);
  assert.equal(report.spend.hasTokenData, true);

  assert.equal(ledger.events[0].result, "ready");
  assert.deepEqual(ledger.events[0].spend, report.spend);
  // 全通过时账本不留详情（账本是证据索引，不是日志转储）
  assert.ok(ledger.events[0].checks.every((check) => check.detail === undefined));
});

test("(2c) live 档：模型不支持工具调用 → 该点 skipped，因此不判 READY", async () => {
  const { result } = await runDoctor({
    tier: "live",
    snapshot: snapshot([
      providerFacts({ models: [modelFacts({ supportsToolCall: false })] }),
    ]),
  });
  const report = result.reports[0];
  assert.equal(checkById(report).tool_call_parse.status, "skipped");
  assert.equal(report.tierPassed, true);
  assert.equal(report.ready, false, "有 skipped 就不能算 READY（不越档背书）");
  assert.equal(report.verdict, "tier-passed");
});

test("(2d) live 档：工具调用解析不出来 → 失败并建议换模型", async () => {
  const { result } = await runDoctor({
    tier: "live",
    models: createRecordingModels({ malformedToolCall: true }),
  });
  const report = result.reports[0];
  assert.equal(checkById(report).tool_call_parse.status, "failed");
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /supportsToolCall/);
  assert.match(report.nextSteps.join("\n"), /--tier=live/);
});

test("(2f) 对抗复核 F8：createModel 构造即抛 → #10-#12 failed 且 billableCalls=0（没发请求就不计费）", async () => {
  const models = {
    calls: [],
    port: {
      createModel() {
        throw new Error("provider doctor 无法构造模型客户端: zai/glm-test 不在快照内");
      },
    },
  };
  const { result } = await runDoctor({ tier: "live", models });
  const report = result.reports[0];
  const checks = checkById(report);
  for (const id of [
    "non_streaming_chat_completion",
    "streaming_chat_completion",
    "tool_call_parse",
  ]) {
    assert.equal(checks[id].status, "failed", `${id} 应如实失败`);
    assert.match(checks[id].detail, /不在快照内/);
  }
  assert.equal(report.spend.billableCalls, 0, "构造失败发生在任何请求之前，不得计可计费调用");
  assert.equal(models.calls.length, 0);
  assert.equal(report.verdict, "failed");
});

test("(2g) 对抗复核 F7：offline 档护栏覆盖 models port 与 dnsLookup（触到即计数并抛错）", async () => {
  // 端到端：正常 offline 流程不触任何出口，blockedNetworkCalls 保持 0。
  const { result } = await runDoctor({ tier: "offline" });
  assert.equal(result.blockedNetworkCalls, 0);

  // 护栏行为直接证明：offline 档触到被包的出口 → 计数 + 抛错（不放行、不静默）。
  let blocked = 0;
  const onBlocked = () => {
    blocked += 1;
  };
  const guardedModels = createTierGuardedModelPort(
    { createModel: () => ({}) },
    "offline",
    onBlocked,
  );
  assert.throws(
    () => guardedModels.createModel({ providerId: "zai", modelId: "m" }),
    /offline 档禁止网络请求/,
    "offline 档触到 models port 必须抛错",
  );
  assert.equal(blocked, 1);
  // 非 offline 档透传原 port（live/catalog 档必须真的能构造模型客户端）。
  const realModels = { createModel: () => "real-client" };
  assert.equal(createTierGuardedModelPort(realModels, "live", onBlocked), realModels);

  const guardedDns = createTierGuardedDnsLookup("offline", onBlocked);
  await assert.rejects(
    guardedDns("api.example.com", { all: true, verbatim: true }),
    /offline 档禁止网络请求/,
    "offline 档触到 DNS 出口必须抛错",
  );
  assert.equal(blocked, 2);
  // 非 offline 档不注入守卫（diagnose-provider 沿用既有缺省解析）。
  assert.equal(createTierGuardedDnsLookup("catalog", onBlocked), undefined);
});

test("(2e) 未知 provider id 直接报错并列出可用 id", async () => {
  await assert.rejects(
    runProviderDoctor({
      tier: "offline",
      registry: { loadLocalSnapshot: async () => snapshot([providerFacts()]) },
      credentials: credentialPort(),
      http: createRecordingHttp(async () => ({ status: 200, bodyText: "{}" })).port,
      models: createRecordingModels().port,
      providerId: "nope",
    }),
    /未知 provider: nope（可用: zai）/,
  );
});

// ── (3) 账本与输出无凭据 ────────────────────────────────────────────

test("(3) 账本无凭据：provider 报错回显 Key 时也不落盘、不外泄", async () => {
  const leaky = `401 unauthorized: authorization Bearer ${API_KEY} apiKey=${ACCOUNT_KEY} rejected`;
  const { result, ledger } = await runDoctor({
    tier: "live",
    models: createRecordingModels({ failWith: leaky }),
  });

  const serialized = JSON.stringify(ledger.events);
  assert.ok(!serialized.includes(API_KEY), "账本不得含运行期 API Key");
  assert.ok(!serialized.includes(ACCOUNT_KEY), "账本不得含账号凭据");
  assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(serialized), "账本不得含 Key 字面量形态");
  assert.ok(!/Bearer\s+\S+/i.test(serialized), "账本不得含 Authorization 头");
  assert.ok(!/"apiKey"/.test(serialized), "账本不得出现凭据字段名");
  assert.deepEqual(findCredentialLikeKeys(ledger.events[0]), []);

  // stdout 走同一套脱敏
  const text = formatProviderDoctorRun(result, { colors: false });
  assert.ok(!text.includes(API_KEY));
  assert.ok(!text.includes(ACCOUNT_KEY));
  const json = JSON.stringify(providerDoctorJsonPayload(result));
  assert.ok(!json.includes(API_KEY));
  assert.ok(!json.includes(ACCOUNT_KEY));

  // 失败仍如实可见：状态失败 + 保留 HTTP 状态码
  const report = result.reports[0];
  assert.equal(checkById(report).non_streaming_chat_completion.status, "failed");
  assert.match(checkById(report).non_streaming_chat_completion.detail, /401/);
  assert.equal(report.spend.billableCalls, 3, "发出过的请求要计入可计费调用");
});

test("(3b) 凭据探测只回来源与布尔，绝不回值", async () => {
  const port = credentialPort();
  const probe = await port.probe({
    providerId: "zai",
    access: { type: "api-key", hasInlineApiKey: false, hasCredentialRef: true, credentialRef: "provider:apikey:zai" },
  });
  assert.equal(probe.status, "available");
  assert.equal(probe.source, "credential-ref");
  assert.ok(!probe.detail.includes(API_KEY));
  assert.deepEqual(Object.keys(probe).sort(), ["detail", "source", "status"]);
  assert.equal(resolveProviderDoctorApiKey({ access: { type: "api-key", apiKey: API_KEY } }), API_KEY);
});

test("(3c) redactor 剔除已知真值与常见密钥形态", () => {
  const redactor = createProviderDoctorRedactor([API_KEY]);
  assert.equal(redactor.redact(`key ${API_KEY} leaked`), "key [redacted] leaked");
  assert.equal(redactor.redact("sk-abcdefghij1234"), "[redacted]");
  assert.equal(redactor.redact('{"api_key": "abc123"}'), '{"api_key": "[redacted]"}');
  const headerText = redactor.redact(`authorization: Bearer ${API_KEY}`);
  assert.ok(!headerText.includes(API_KEY), "头里的真值必须被剔除");
  assert.ok(!/Bearer/i.test(headerText), "残留的 Bearer 字样也要吃掉，避免看起来像还带着头");
  assert.ok(!/Bearer\s+\S+/.test(redactor.redact(`Bearer ${API_KEY} rejected`)));
  assert.ok(redactor.redactForLedger("x".repeat(400)).length <= 161);
});

test("(3e) redactor 覆盖与 core 反射门同源的泄漏形态（对抗复核 F2/F3 同款用例）", () => {
  // 与 core AUDIT_REDACTION_PATTERNS 同一份形态清单的两处落地（specs/provider-doctor.md
  // R5）：修复前 JSON 引号键独缺 token、api-key 无大小写/下划线变体、无 gh/AWS/PEM
  // 形态、Bearer 引号多词值吃不全——七类真值都会落进 stdout/账本。
  const redactor = createProviderDoctorRedactor([]);
  const cases = [
    ['"token": "tok_abc123def456"', "tok_abc123def456"],
    ["sk_UNDERSCOREKEY123456", "UNDERSCOREKEY123456"],
    ["SK-UPPERCASE12345678", "UPPERCASE12345678"],
    ["ghp_GITHUBPAT1234567890", "GITHUBPAT1234567890"],
    ["AKIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
    [
      "-----BEGIN RSA PRIVATE KEY----- Qk9EWS0xMjM0NTY3OA== -----END RSA PRIVATE KEY-----",
      "RSA PRIVATE KEY",
    ],
    ['Bearer "quoted secret value"', "quoted secret value"],
  ];
  for (const [payload, truth] of cases) {
    const redacted = redactor.redact(`probe ${payload} tail`);
    assert.ok(!redacted.includes(truth), `真值必须被剔除: ${redacted}`);
    assert.ok(redacted.includes("[redacted]"), `凭据位置必须有 [redacted] 标记: ${redacted}`);
    assert.ok(
      redacted.startsWith("probe ") && redacted.endsWith(" tail"),
      `非凭据段逐字保留: ${redacted}`,
    );
  }
  // 句法保真（F3）：-H 引号值脱敏后引号仍配对、URL 段逐字保留。
  const headerFixture = redactor.redact(
    'curl -H "Authorization: Bearer sk-bearerquoted999" https://api.example.com',
  );
  assert.equal(headerFixture.split('"').length - 1, 2, "脱敏后引号必须配对");
  assert.ok(!headerFixture.includes("sk-bearerquoted999"));
  assert.ok(headerFixture.includes(" https://api.example.com"));
});

test("(3f) redactor 与 core 反射门对齐（对抗复核 F3 三处漂移的五形态复现）", () => {
  // 修复前漂移：JSON 引号键独缺 x-api-key / anthropic-auth-token、JWT 第三段必填
  // （两段式漏网）、Bearer 裸值类 `[A-Za-z0-9._~+/=-]{8,}` 放行 <8 字符与含特殊字符 token。
  const redactor = createProviderDoctorRedactor([]);
  const cases = [
    // a) JSON 引号键 x-api-key（doctor 自己为 anthropic-messages 构造的头，报文回显必须灭）
    ['{"x-api-key": "ak-doctor-secret-01"}', "ak-doctor-secret-01", '{"x-api-key": "[redacted]"}'],
    // b) JSON 引号键 anthropic-auth-token
    [
      '{"anthropic-auth-token": "tok_anthropic_9999"}',
      "tok_anthropic_9999",
      '{"anthropic-auth-token": "[redacted]"}',
    ],
    // c) 两段式 JWT（header.payload，无签名段）
    ["token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 done", "eyJhbGciOiJIUzI1NiJ9"],
    // d) 短 Bearer 裸值（<8 字符）
    ["Bearer abc123", "abc123", "[redacted]"],
    // e) 含 `!@#` 特殊字符的 Bearer 裸值（旧字符类在 ! 处断开 → 整值泄漏）
    ["Bearer tok!@#secret99", "tok!@#secret99", "[redacted]"],
  ];
  for (const [payload, truth, expected] of cases) {
    const redacted = redactor.redact(payload);
    assert.ok(!redacted.includes(truth), `真值必须被剔除: ${redacted}`);
    assert.ok(redacted.includes("[redacted]"), `凭据位置必须有 [redacted] 标记: ${redacted}`);
    if (expected) assert.ok(redacted.includes(expected), `结构保真: ${redacted}`);
  }
  // 三段式 JWT 不因第三段 optional 而漏匹配（同一条正则吞整段）。
  const threeSegment = redactor.redact(
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
  );
  assert.ok(!threeSegment.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"));
  assert.ok(!threeSegment.includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("(3d) 账本落用户数据目录、可用 env 覆盖、拒绝写入凭据字段", async () => {
  const baseDir = join(tmpdir(), "acode-doctor-base");
  assert.equal(
    resolveProviderDoctorLedgerPath({ env: { ACODE_DATA_BASE_DIR: baseDir } }),
    join(baseDir, ".acode", "cli", "provider-doctor", "coverage.jsonl"),
  );
  const override = join(tmpdir(), "custom-ledger.jsonl");
  assert.equal(
    resolveProviderDoctorLedgerPath({ env: { ACODE_PROVIDER_DOCTOR_LEDGER: override } }),
    override,
  );

  const dir = await mkdtemp(join(tmpdir(), "acode-doctor-"));
  try {
    const filePath = join(dir, "nested", "coverage.jsonl");
    const ledger = createFileProviderDoctorLedger({ filePath });
    const event = createProviderDoctorLedgerEvent({
      recordedAt: new Date("2026-09-30T08:00:00.000Z"),
      tier: "offline",
      providerId: "zai",
      modelId: MODEL_ID,
      result: "tier-passed",
      checks: [{ id: "config_sources_loaded", status: "passed" }],
      spend: { billableCalls: 0, catalogCalls: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, hasTokenData: false },
    });
    await ledger.record(event);
    const text = await readFile(filePath, "utf8");
    assert.equal(text.trim().split("\n").length, 1, "JSONL 追加一行一事件");
    assert.ok(!text.includes(API_KEY));
    const parsed = await readProviderDoctorLedgerFile(filePath);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].providerId, "zai");

    await assert.rejects(
      ledger.record({ ...event, apiKey: API_KEY }),
      /拒绝写入含凭据字段/,
      "白名单之外夹带凭据字段必须拒绝落盘",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── (4) host 校验拒绝私网 / 保留地址 ────────────────────────────────

test("(4) 端点策略：只允许 http/https，拒绝 localhost/环回/私网/链路本地/单标签", () => {
  const cases = [
    ["http://127.0.0.1:8080/v1", "blocked_address"],
    ["https://10.0.0.5/v1", "blocked_address"],
    ["https://192.168.1.20/v1", "blocked_address"],
    ["https://169.254.169.254/latest/meta-data", "blocked_address"],
    ["https://[::1]/v1", "blocked_address"],
    // 对抗复核 F1：IPv6 过渡/保留段——NAT64 WKP 内嵌 IPv4（169.254.169.254 / 127.0.0.1）、
    // 6to4、Teredo。修复前这些字面量被判成公网并放行建连。
    ["https://[64:ff9b::a9fe:a9fe]/v1", "blocked_address"],
    ["https://[64:ff9b::7f00:1]/v1", "blocked_address"],
    ["https://[2002:7f00:1::1]/v1", "blocked_address"],
    ["https://[2001::1]/v1", "blocked_address"],
    ["https://localhost/v1", "blocked_host"],
    ["https://foo.localhost/v1", "blocked_host"],
    ["https://intranet/v1", "blocked_host"],
    ["ftp://api.provider.example/v1", "unsupported_protocol"],
    ["file:///etc/passwd", "unsupported_protocol"],
    ["not a url", "invalid_url"],
    ["", "missing"],
  ];
  for (const [baseUrl, code] of cases) {
    const verdict = inspectProviderEndpoint(baseUrl);
    assert.equal(verdict.ok, false, `${baseUrl} 应被拒绝`);
    assert.equal(verdict.code, code, `${baseUrl} 的拒绝原因应是 ${code}`);
  }

  const https = inspectProviderEndpoint("https://api.provider.example/v1");
  assert.equal(https.ok, true);
  assert.equal(https.host, "api.provider.example");
  assert.equal(https.plaintextHttp, false);

  const plaintext = inspectProviderEndpoint("http://api.provider.example/v1");
  assert.equal(plaintext.ok, true);
  assert.equal(plaintext.plaintextHttp, true, "明文 http 要如实告警（知情不禁止）");

  // 被拒绝的端点绝不拼出目录 URL（先校验后连接）
  assert.equal(buildProviderCatalogUrl("http://127.0.0.1/v1", "openai-responses"), undefined);
  assert.equal(
    buildProviderCatalogUrl("https://api.provider.example/v1", "openai-chat-completions"),
    "https://api.provider.example/v1/models",
  );
  assert.equal(
    buildProviderCatalogUrl("https://api.anthropic.example", "anthropic-messages"),
    "https://api.anthropic.example/v1/models",
  );
  assert.equal(
    buildProviderCatalogUrl("https://api.anthropic.example/v1/", "anthropic-messages"),
    "https://api.anthropic.example/v1/models",
  );
  assert.equal(buildProviderCatalogUrl("https://api.provider.example", "unknown-api"), undefined);
  assert.deepEqual(buildProviderCatalogHeaders("anthropic-messages", "k"), {
    "x-api-key": "k",
    "anthropic-version": "2023-06-01",
  });
});

test("(4b) 私网 IP 端点：检查点失败且一次请求都不发", async () => {
  const { result, http } = await runDoctor({
    tier: "catalog",
    snapshot: snapshot([providerFacts({ baseUrl: "https://10.0.0.5/v1" })]),
  });
  const checks = checkById(result.reports[0]);
  assert.equal(checks.endpoint_shape_valid.status, "failed");
  assert.equal(checks.endpoint_public_egress.status, "failed");
  assert.equal(checks.catalog_live_endpoint.status, "skipped", "出口校验未过就不发请求");
  assert.equal(http.calls.length, 0);
  assert.match(result.reports[0].nextSteps.join("\n"), /内网|公网/);
});

test("(4c) DNS 解析到环回（重绑定面）：catalog 档拒绝且不建连", async () => {
  const { result, http } = await runDoctor({
    tier: "catalog",
    dnsLookup: LOOPBACK_DNS,
    snapshot: snapshot([providerFacts({ baseUrl: "https://rebind.provider.example/v1" })]),
  });
  const checks = checkById(result.reports[0]);
  assert.equal(checks.endpoint_public_egress.status, "failed");
  assert.equal(checks.catalog_live_endpoint.status, "skipped");
  assert.equal(http.calls.length, 0, "解析到环回时绝不发出请求");
  // 下一步必须点出 fake-IP/代理这一常见误判来源，并给 offline 退路（spec R4 已知限制）
  const hint = result.reports[0].nextSteps.join("\n");
  assert.match(hint, /fake-IP/);
  assert.match(hint, /--tier=offline/);
});

test("(4d) catalog 档 401：归因为凭据问题并给出重登/换 Key 的下一步", async () => {
  const http = createRecordingHttp(async () => ({ status: 401, bodyText: "{}" }));
  const { result } = await runDoctor({ tier: "catalog", http });
  const report = result.reports[0];
  assert.equal(checkById(report).catalog_live_endpoint.status, "failed");
  assert.equal(checkById(report).catalog_model_listed.status, "skipped");
  assert.match(report.nextSteps.join("\n"), /API Key/);
});

test("(4e) 目标模型不在实时目录：失败并建议换目录内模型", async () => {
  const http = createRecordingHttp(async () => ({ status: 200, bodyText: catalogBody(["other-model"]) }));
  const { result } = await runDoctor({ tier: "catalog", http });
  const report = result.reports[0];
  assert.equal(checkById(report).catalog_model_listed.status, "failed");
  const hint = report.nextSteps.join("\n");
  assert.match(hint, /--model=other-model/);
});

test("(4f) 目录端点不支持列举（404）：记 skipped，不算失败", async () => {
  const http = createRecordingHttp(async () => ({ status: 404, bodyText: "not found" }));
  const { result } = await runDoctor({ tier: "catalog", http });
  const checks = checkById(result.reports[0]);
  assert.equal(checks.catalog_live_endpoint.status, "skipped");
  assert.equal(checks.catalog_model_listed.status, "skipped");
  assert.equal(result.reports[0].tierPassed, true);
});

test("(4g) live 档 + 端点被判内网/环回：#10-#12 跳过，一次模型调用都不发、不计花费（评审 J3 修复）", async () => {
  // spec R4 硬约束：「端点被判定为内网/环回 → endpoint_public_egress 失败，且不发出任何
  // 请求（先校验后连接）」。修复前 live 探针的前置只有 credential_available +
  // model_route_resolved，于是端点已被本模块判为环回时仍带着真实凭据发 3 次模型调用、
  // spend.billableCalls=3。
  const loopbackLiteral = await runDoctor({
    tier: "live",
    snapshot: snapshot([providerFacts({ baseUrl: "http://127.0.0.1:8080/v1" })]),
  });
  const literalChecks = checkById(loopbackLiteral.result.reports[0]);
  assert.equal(literalChecks.endpoint_shape_valid.status, "failed");
  assert.equal(literalChecks.endpoint_public_egress.status, "failed");
  for (const id of [
    "non_streaming_chat_completion",
    "streaming_chat_completion",
    "tool_call_parse",
  ]) {
    assert.equal(literalChecks[id].status, "skipped", `${id} 不该在内网端点上真打`);
  }
  assert.equal(loopbackLiteral.models.calls.length, 0, "一次模型调用都不该发出");
  assert.equal(loopbackLiteral.http.calls.length, 0);
  assert.equal(loopbackLiteral.result.reports[0].spend.billableCalls, 0, "没发请求就不该计花费");

  // DNS 重绑定面：#3 形态合法、#7 解析到环回 → 同样不打真实调用。
  const rebinding = await runDoctor({
    tier: "live",
    dnsLookup: LOOPBACK_DNS,
    snapshot: snapshot([providerFacts({ baseUrl: "https://rebind.provider.example/v1" })]),
  });
  const rebindChecks = checkById(rebinding.result.reports[0]);
  assert.equal(rebindChecks.endpoint_shape_valid.status, "passed");
  assert.equal(rebindChecks.endpoint_public_egress.status, "failed");
  assert.equal(rebindChecks.non_streaming_chat_completion.status, "skipped");
  assert.equal(rebindChecks.streaming_chat_completion.status, "skipped");
  assert.equal(rebindChecks.tool_call_parse.status, "skipped");
  assert.equal(rebinding.models.calls.length, 0);
  assert.equal(rebinding.result.reports[0].spend.billableCalls, 0);

  // 对照：公网端点（PUBLIC_DNS）下 live 探针照常打三次（(2b) 已钉住 READY 与花费）。
  const publicEndpoint = await runDoctor({ tier: "live" });
  assert.equal(publicEndpoint.models.calls.length, 3);
  assert.equal(publicEndpoint.result.reports[0].spend.billableCalls, 3);
});

test("(4h) 对抗复核 F1：IPv6 过渡段端点在 catalog 档被拒且零请求；正常公网 IPv6 不回归", async () => {
  // 对抗复核实证形态：修复前 catalog 档对 `https://[64:ff9b::a9fe:a9fe]/v1`
  // （NAT64 WKP 内嵌 169.254.169.254 云元数据）egress=passed 并带凭据发出请求。
  const nat64 = await runDoctor({
    tier: "catalog",
    snapshot: snapshot([providerFacts({ baseUrl: "https://[64:ff9b::a9fe:a9fe]/v1" })]),
  });
  const nat64Checks = checkById(nat64.result.reports[0]);
  assert.equal(nat64Checks.endpoint_shape_valid.status, "failed");
  assert.equal(nat64Checks.endpoint_public_egress.status, "failed");
  assert.equal(nat64Checks.catalog_live_endpoint.status, "skipped", "出口校验未过就不发请求");
  assert.equal(nat64.http.calls.length, 0, "NAT64 端点绝不发出目录请求");

  // 6to4 内嵌 127.0.0.1 同样拒绝。
  const sixToFour = await runDoctor({
    tier: "catalog",
    snapshot: snapshot([providerFacts({ baseUrl: "https://[2002:7f00:1::1]/v1" })]),
  });
  assert.equal(checkById(sixToFour.result.reports[0]).endpoint_public_egress.status, "failed");
  assert.equal(sixToFour.http.calls.length, 0);

  // 不回归：正常公网 IPv6 字面量仍放行（照常发出目录请求）。
  const publicV6 = await runDoctor({
    tier: "catalog",
    snapshot: snapshot([providerFacts({ baseUrl: "https://[2606:4700::1]/v1" })]),
  });
  const publicV6Checks = checkById(publicV6.result.reports[0]);
  assert.equal(publicV6Checks.endpoint_shape_valid.status, "passed");
  assert.equal(publicV6Checks.endpoint_public_egress.status, "passed");
  assert.equal(publicV6Checks.catalog_live_endpoint.status, "passed");
  assert.equal(publicV6.http.calls.length, 1);
});

test("(4i) 对抗复核 F4：恶意 provider/model id 不裸拼进可粘贴命令（命令构造层白名单）", () => {
  // 合规 id 逐字不变（既有断言不回归）。
  assert.equal(
    providerDoctorCommand({ providerId: "zai", modelId: "glm-test", tier: "live" }),
    "acode doctor --provider=zai --model=glm-test --tier=live",
  );
  // 恶意 id 三形态（对抗复核原版）：反引号命令替换 / $() 命令替换 / 分号+空格分段
  // → 一律退化成占位符，建议命令无裸注入面。
  for (const evil of ["evil`touch pwned`", "$(touch pwned)", "my provider; rm -rf /tmp/x"]) {
    const command = providerDoctorCommand({ providerId: "zai", modelId: evil, tier: "live" });
    assert.ok(command.includes("--model=<模型 id（手动输入）>"), `不合规 id 退化为占位符: ${command}`);
    assert.ok(!command.includes(evil), `恶意 id 不得出现: ${command}`);
    assert.equal(/[`$;&|]/.test(command), false, `建议命令不得含 shell 元字符: ${command}`);
  }
  // 恶意 provider id 同样不裸拼。
  const evilProvider = providerDoctorCommand({ providerId: "x; curl evil", tier: "offline" });
  assert.equal(/[`$;&|]/.test(evilProvider), false, `恶意 provider id 不得出现: ${evilProvider}`);
  assert.ok(evilProvider.includes("--provider=<provider id（手动输入）>"));
});

test("(4j) 对抗复核 F4：恶意目录 id 被解析层过滤并计数；建议命令只含白名单 id", async () => {
  // 对抗复核原版形态：目录响应 id ``evil`touch pwned` `` 被裸拼进建议命令。
  const http = createRecordingHttp(async () => ({
    status: 200,
    bodyText: catalogBody([
      "evil`touch pwned`",
      "$(touch pwned)",
      "my provider; rm -rf /tmp/x",
      "glm-good",
    ]),
  }));
  const { result } = await runDoctor({ tier: "catalog", http });
  const report = result.reports[0];
  const hint = report.nextSteps.join("\n");
  assert.ok(!hint.includes("touch pwned"), `注入载荷不得进建议: ${hint}`);
  assert.ok(!hint.includes("rm -rf"), `注入载荷不得进建议: ${hint}`);
  assert.ok(!hint.includes("; "), `分号分段不得进建议: ${hint}`);
  assert.match(hint, /--model=glm-good/, "唯一安全候选应进建议命令");
  // 过滤计数进 detail（可审计）。
  assert.match(checkById(report).catalog_live_endpoint.detail, /过滤 3 个/);

  // 目录全为恶意 id 且本地无替代模型：建议退化为占位符而非裸拼。
  const allEvil = await runDoctor({
    tier: "live",
    snapshot: snapshot([providerFacts({ models: [modelFacts()] })]),
    http: createRecordingHttp(async () => ({
      status: 200,
      bodyText: catalogBody(["evil`touch pwned`", "a;b"]),
    })),
    models: createRecordingModels({ failWith: "401 unauthorized" }),
  });
  const liveHint = allEvil.result.reports[0].nextSteps.join("\n");
  assert.ok(!liveHint.includes("touch pwned"), `注入载荷不得进建议: ${liveHint}`);
  assert.ok(!liveHint.includes("a;b"), `分号 id 不得进建议: ${liveHint}`);
  assert.match(liveHint, /--model=<模型 id（手动输入）>/, "无安全候选时退化为占位符");
});

// ── (5) 检查点目录与档位门控 ────────────────────────────────────────

test("(5) 检查点目录：12 个唯一 id、逐档累加、每点都有下一步建议", () => {
  assert.equal(PROVIDER_DOCTOR_CHECKPOINT_IDS.length, 12);
  assert.equal(PROVIDER_DOCTOR_CHECKPOINT_COUNT, 12);
  assert.equal(new Set(PROVIDER_DOCTOR_CHECKPOINT_IDS).size, 12);
  assert.equal(new Set(PROVIDER_DOCTOR_CHECKPOINT_CATALOG.map((d) => d.id)).size, 12);

  const tierOf = Object.fromEntries(
    PROVIDER_DOCTOR_CHECKPOINT_CATALOG.map((definition) => [definition.id, definition.minTier]),
  );
  assert.equal(tierOf.config_sources_loaded, "offline");
  assert.equal(tierOf.endpoint_public_egress, "catalog");
  assert.equal(tierOf.tool_call_parse, "live");

  // 逐档累加：轻档运行的集合是重档的子集
  const runsAt = (tier) =>
    PROVIDER_DOCTOR_CHECKPOINT_CATALOG.filter((d) => isCheckpointRunAtTier(d, tier)).map((d) => d.id);
  const offline = runsAt("offline");
  const catalog = runsAt("catalog");
  const live = runsAt("live");
  assert.equal(offline.length, 6);
  assert.equal(catalog.length, 9);
  assert.equal(live.length, 12);
  assert.ok(offline.every((id) => catalog.includes(id)));
  assert.ok(catalog.every((id) => live.includes(id)));

  for (const definition of PROVIDER_DOCTOR_CHECKPOINT_CATALOG) {
    const hint = definition.nextStep({
      providerId: "zai",
      modelId: MODEL_ID,
      tier: "live",
      detail: "HTTP 401: unauthorized",
    });
    assert.ok(hint.length > 10, `${definition.id} 必须给出下一步建议`);
    assert.match(hint, /acode |API Key|Base URL|模型|配置/, `${definition.id} 的建议要可执行`);
    assert.equal(definition.spendsBalance, definition.minTier === "live");
  }

  assert.equal(
    providerDoctorCommand({ providerId: "zai", modelId: MODEL_ID, tier: "live" }),
    "acode doctor --provider=zai --model=glm-test --tier=live",
  );
  assert.match(providerDoctorEscalationHint({ providerId: "zai", tier: "offline" }), /--tier=catalog/);
  assert.equal(providerDoctorEscalationHint({ providerId: "zai", tier: "live" }), undefined);
  assert.ok(isProviderDoctorTier("catalog"));
  assert.ok(!isProviderDoctorTier("full"));
});

// ── (6) 覆盖账本与新鲜度 ────────────────────────────────────────────

test("(6) 覆盖账本：READY / N-12、首个阻塞点、推进命令、新鲜度与累计花费", async () => {
  const spend = { billableCalls: 3, catalogCalls: 1, promptTokens: 28, outputTokens: 9, totalTokens: 37, hasTokenData: true };
  const readyEvent = createProviderDoctorLedgerEvent({
    recordedAt: new Date("2026-09-30T08:00:00.000Z"),
    tier: "live",
    providerId: "zai",
    providerLabel: "Z.AI Coding Plan",
    modelId: MODEL_ID,
    endpointHost: "api.provider.example",
    result: "ready",
    checks: PROVIDER_DOCTOR_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" })),
    spend,
    runner: { actor: "user", cliVersion: "1.2.3", platform: "win32", arch: "x64", node: "v22.0.0", sea: false, pid: 4242 },
  });
  const failedEvent = createProviderDoctorLedgerEvent({
    recordedAt: new Date("2026-08-01T08:00:00.000Z"),
    tier: "catalog",
    providerId: "bigmodel",
    modelId: SECOND_MODEL_ID,
    result: "failed",
    checks: [
      { id: "config_sources_loaded", status: "passed" },
      { id: "credential_available", status: "failed", detail: "凭据缺失" },
    ],
    firstFailure: { id: "credential_available", hint: "运行 `acode login bigmodel`" },
    spend: { billableCalls: 0, catalogCalls: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, hasTokenData: false },
  });

  const serialized = `${JSON.stringify(readyEvent)}\nnot-json-at-all\n${JSON.stringify(failedEvent)}\n`;
  const parsed = parseProviderDoctorLedger(serialized);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.corruptLines, 1, "损坏行跳过并计数，不整份失败");

  const coverage = summarizeProviderDoctorCoverage({
    events: parsed.events,
    corruptLines: parsed.corruptLines,
    now: new Date("2026-09-30T12:00:00.000Z"),
  });
  assert.equal(coverage.rows.length, 2);
  const [bigmodel, zai] = coverage.rows;
  assert.equal(bigmodel.providerId, "bigmodel");
  assert.equal(bigmodel.ready, false);
  assert.equal(bigmodel.clearedCheckpoints, 1);
  assert.equal(bigmodel.totalCheckpoints, 12);
  assert.equal(bigmodel.firstBlockerId, "credential_available");
  assert.equal(bigmodel.nextCommand, "运行 `acode login bigmodel`");
  assert.equal(bigmodel.stale, true, "超过 retestAfter 的证据要标记过期");
  assert.equal(zai.ready, true);
  assert.equal(zai.clearedCheckpoints, 12);
  assert.equal(zai.stale, false);

  assert.equal(coverage.recordedSpend.billableCalls, 3);
  assert.equal(coverage.recordedSpend.totalTokens, 37);

  const lines = formatCoverageLines(coverage, join("/data", "coverage.jsonl"), {
    now: new Date("2026-09-30T12:00:00.000Z"),
  }).join("\n");
  assert.match(lines, /READY/);
  assert.match(lines, /1\/12/);
  assert.match(lines, /acode login bigmodel/);
  assert.match(lines, /用户 \/ release 构建/);
  assert.match(lines, /证据已过期/);
  assert.match(lines, /绝不上传/);
});

test("(6b) 同一 pair 只取最新证据（追加式账本不重复计花费）", () => {
  const older = createProviderDoctorLedgerEvent({
    recordedAt: new Date("2026-09-01T00:00:00.000Z"),
    tier: "live",
    providerId: "zai",
    modelId: MODEL_ID,
    result: "failed",
    checks: [{ id: "config_sources_loaded", status: "passed" }],
    spend: { billableCalls: 3, catalogCalls: 0, promptTokens: 10, outputTokens: 5, totalTokens: 15, hasTokenData: true },
  });
  const newer = createProviderDoctorLedgerEvent({
    recordedAt: new Date("2026-09-20T00:00:00.000Z"),
    tier: "live",
    providerId: "zai",
    modelId: MODEL_ID,
    result: "ready",
    checks: PROVIDER_DOCTOR_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" })),
    spend: { billableCalls: 3, catalogCalls: 1, promptTokens: 28, outputTokens: 9, totalTokens: 37, hasTokenData: true },
  });
  const coverage = summarizeProviderDoctorCoverage({ events: [older, newer] });
  assert.equal(coverage.rows.length, 1);
  assert.equal(coverage.rows[0].ready, true);
  assert.equal(coverage.recordedSpend.billableCalls, 3, "只算最新一次，不累加历史");
});

// ── (7) 渲染与 JSON 载荷 ────────────────────────────────────────────

test("(7) 文本输出含档位说明/逐点状态/花费/结论/下一步；JSON 与文本同源", async () => {
  const { result } = await runDoctor({ tier: "catalog" });
  const text = formatProviderDoctorRun(result, { colors: false });
  assert.match(text, /Provider doctor: Z\.AI Coding Plan \/ glm-test/);
  assert.match(text, /Tier: catalog（需要凭据、约零花费/);
  assert.match(text, /Endpoint: api\.provider\.example/);
  assert.match(text, /\[通过\s*\] 配置源可加载/);
  assert.match(text, /\[跳过\s*\] 工具调用解析/);
  assert.match(text, /本次花费: 1 次目录端点请求/);
  assert.match(text, /结论: catalog 档通过/);
  assert.match(text, /下一步:/);
  assert.match(text, /覆盖账本 \(本地\)|覆盖账本（本地）/);
  assert.match(text, /绝不上传/);
  assert.ok(!text.includes(API_KEY));

  const payload = providerDoctorJsonPayload(result);
  assert.equal(payload.status, "ok");
  assert.equal(payload.tier, "catalog");
  assert.equal(payload.reports.length, 1);
  assert.equal(payload.reports[0].checks.length, 12);
  assert.deepEqual(
    payload.reports[0].checks.map((check) => check.id),
    [...PROVIDER_DOCTOR_CHECKPOINT_IDS],
  );
  assert.equal(payload.blockedNetworkCalls, 0);
  assert.ok(!JSON.stringify(payload).includes(API_KEY));
});

test("(7b) 全部 provider 一起诊断（裸 --provider 语义）", async () => {
  const { result } = await runDoctor({
    tier: "offline",
    snapshot: snapshot([providerFacts(), providerFacts({ providerId: "bigmodel", providerName: "BigModel" })]),
  });
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.reports.map((report) => report.providerId), ["zai", "bigmodel"]);
});

// ── (8) 接线钉住（源断言） ──────────────────────────────────────────

// Windows 检出（core.autocrlf）会把源文件转成 CRLF：`.` 不匹配 `\r` 且 `$` 不落行尾，
// 整行注释剥离会静默失败（注释里的 specs/no-telemetry.md 字样被误判为代码引入遥测）。
// 按 \r?\n 切分使剥离对两种行尾都成立。
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");

test("(8) 接线钉住：run.ts 早分支、provider runtime 门槛、doctor 模块无裸 fetch/遥测", async () => {
  const runSource = await read("apps/acode-cli/packages/cli/src/run.ts");
  assert.match(runSource, /isProviderDoctorInvocation\(ctx\.argv\)/);
  assert.match(runSource, /runProviderDoctorCommand\(ctx, deps, version, ctx\.argv\)/);
  // 早分支必须在严格 parseGlobalArgs 之前，否则裸 --provider 会被判未知选项
  assert.ok(
    runSource.indexOf("isProviderDoctorInvocation") < runSource.indexOf("parseGlobalArgs(extracted.args)"),
    "doctor 分流必须早于全局 parseArgs",
  );

  const runtimeEnvSource = await read("apps/acode-cli/packages/cli/src/provider-runtime-env.ts");
  assert.match(runtimeEnvSource, /command === "doctor"/);
  assert.match(runtimeEnvSource, /arg === "--provider" \|\| arg\.startsWith\("--provider="\)/);

  const commandSource = await read("apps/acode-cli/packages/cli/src/provider-doctor-command.ts");
  assert.match(commandSource, /createBlockedProviderDoctorHttpPort\(\)/, "offline 档必须注入 blocked transport");
  assert.match(commandSource, /createBlockedUpstreamFetch/, "offline 档必须拦住 Built-in CDN 刷新");
  assert.match(commandSource, /resolveProviderDoctorLedgerPath/);

  const packageJson = JSON.parse(await read("apps/acode-cli/packages/adapters/package.json"));
  assert.ok(packageJson.exports["./doctor"], "adapters 必须暴露 ./doctor 公开入口");

  const doctorFiles = [
    "types.ts",
    "checkpoints.ts",
    "check-recorder.ts",
    "internal.ts",
    "redaction.ts",
    "spend.ts",
    "endpoint-policy.ts",
    "credential-probe.ts",
    "catalog-probe.ts",
    "live-probe.ts",
    "live-checks.ts",
    "offline-checks.ts",
    "ledger.ts",
    "report-assembly.ts",
    "diagnose-provider.ts",
    "run-provider-doctor.ts",
    "format-report.ts",
    "defaults.ts",
    "index.ts",
  ];
  for (const file of doctorFiles) {
    const source = stripComments(
      await read(`apps/acode-cli/packages/adapters/src/doctor/${file}`),
    );
    assert.ok(!/\bfetch\s*\(/.test(source), `${file} 不得出现裸 fetch（走既有 HttpClientPort/模型客户端）`);
    assert.ok(!/globalThis\.fetch/.test(source), `${file} 不得直接引用 globalThis.fetch`);
    assert.ok(!/telemetry|otlp|OTLP/i.test(source), `${file} 不得引入遥测（specs/no-telemetry.md）`);
  }

  // 对抗复核 F7：网络出口 import 钉住从账本扩到**全部** doctor 文件——
  // node:https / undici / node:dns 一律不得直接出现；唯一合法的网络装配是
  // defaults.ts 经 ../http/index.js 的受控 adapter（egressPolicy:"public"，按档位
  // 装配，见该文件 import 处注释），它不匹配本断言的下层协议导入。
  for (const file of doctorFiles) {
    const source = stripComments(
      await read(`apps/acode-cli/packages/adapters/src/doctor/${file}`),
    );
    assert.ok(
      !/\bnode:https?\b|undici|\bnode:dns\b/.test(source),
      `${file} 不得直接引入 node:http(s)/undici/node:dns（出网只经 HttpClientPort/模型客户端 Port）`,
    );
  }

  // 账本模块不得有任何网络出口（含 HttpClient 字样：账本只落本地文件）
  const ledgerSource = stripComments(await read("apps/acode-cli/packages/adapters/src/doctor/ledger.ts"));
  assert.ok(!/node:https?|undici|HttpClient/.test(ledgerSource), "账本只落本地文件");
});
