import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * U08 契约一致性守护（apps/acode-cli/specs/provider-doctor.md R3/R8 ↔
 * packages/shared/src/providerDiagnostics.ts）。
 *
 * 中立叶子**镜像**了 doctor 的线协议词汇（12 个 checkpoint id、四态 status、三态 verdict、
 * 三档 tier）。镜像就意味着可能漂移：doctor 改了检查点目录而 shared 没跟上，GUI 会渲染出
 * 残缺列表或把未知状态画成空白。本测试把「两处必须同形」机械化。
 *
 * 注意方向性：doctor 是语义所有者，shared 叶子是线协议词汇。所以断言的是**集合相等**
 * （不是子集），任何一侧单方面增删都会被这里挡住。
 */

// CLI 测试目录不解析裸 @acode/shared（pnpm 未提升到 apps/acode-cli），走相对路径。
const {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  providerDiagnosticsCheckStatusSchema,
  providerDiagnosticsTierSchema,
  providerDiagnosticsVerdictSchema,
} = await import("../../../packages/shared/src/providerDiagnostics.ts");
const { PROVIDER_DOCTOR_CHECKPOINT_IDS } = await import(
  "../packages/adapters/src/doctor/checkpoints.ts"
);
const { PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION, PROVIDER_DOCTOR_TIERS } = await import(
  "../packages/adapters/src/doctor/types.ts"
);
test("R3: 12 个 checkpoint id 在 shared 叶子与 doctor 目录里逐字同序同集", () => {
  assert.deepEqual(
    [...PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS],
    [...PROVIDER_DOCTOR_CHECKPOINT_IDS],
    "checkpoint id 必须与 doctor 的 CHECKPOINT_ORDER 完全一致（顺序也是契约：账本与输出共用同一序）",
  );
  assert.equal(PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.length, 12);
});

test("R2: 档位词汇一致（offline/catalog/live），缺省档语义由 doctor 持有", () => {
  assert.deepEqual([...providerDiagnosticsTierSchema.options], [...PROVIDER_DOCTOR_TIERS]);
  assert.deepEqual([...PROVIDER_DOCTOR_TIERS], ["offline", "catalog", "live"]);
});

test("R2/R3: 检查状态与 verdict 是闭集，且与 doctor 的联合类型同形", () => {
  // doctor: ProviderDoctorCheckStatus = "passed" | "failed" | "skipped" | "blocked"
  assert.deepEqual([...providerDiagnosticsCheckStatusSchema.options].sort(), [
    "blocked",
    "failed",
    "passed",
    "skipped",
  ]);
  // doctor: ProviderDoctorVerdict = "ready" | "tier-passed" | "failed"
  assert.deepEqual([...providerDiagnosticsVerdictSchema.options].sort(), [
    "failed",
    "ready",
    "tier-passed",
  ]);
});

test("R8 additive 纪律：reasonCode 不进 JSONL 账本（账本 schema 版本不变）", async () => {
  // provider-doctor.md R8：reasonCode 只加在内存报告上，账本 schemaVersion 保持 1。
  assert.equal(PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION, 1);

  // 必须走**真实路径**验证：createProviderDoctorLedgerEvent 内部是 `{...check}` 展开，
  // 直接喂一个带 reasonCode 的 check 会被原样拷进去——真正把 reasonCode 挡在账本外的
  // 是 report-assembly.ts:160-167 的 ledgerChecks 投影（只取 id/status/detail）。
  // 所以这里跑一次真诊断，断言落账的事件里没有 reasonCode。
  const { runProviderDoctor } = await import(
    "../packages/adapters/src/doctor/run-provider-doctor.ts"
  );
  const { createInMemoryProviderDoctorLedger } = await import(
    "../packages/adapters/src/doctor/ledger.ts"
  );
  const { createProviderDoctorCredentialPort } = await import(
    "../packages/adapters/src/doctor/credential-probe.ts"
  );

  const MODEL_ID = "glm-parity";
  const provider = {
    providerId: "zai",
    providerName: "Z.AI",
    access: { type: "api-key", hasInlineApiKey: true, hasCredentialRef: false },
    apiType: "openai-chat-completions",
    baseUrl: "https://api.provider.example/v1",
    models: [
      {
        modelId: MODEL_ID,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        reasoningLevels: ["disabled"],
        maxOutputTokens: 8192,
        issues: [],
      },
    ],
    issues: [],
    providerConfig: { access: { type: "api-key", apiKey: "sk-test-parity-key" } },
    modelConfigs: { [MODEL_ID]: {} },
    secretValues: ["sk-test-parity-key"],
  };
  const snapshot = { revision: "3", sources: {}, providers: [provider] };
  const ledger = createInMemoryProviderDoctorLedger();
  // catalog 档 + 401：这正是会产生 reasonCode=credential-rejected 的路径。
  let httpCalls = 0;
  await runProviderDoctor({
    tier: "catalog",
    registry: { loadLocalSnapshot: async () => snapshot },
    credentials: createProviderDoctorCredentialPort({ vault: { load: async () => "sk-test-parity-key" } }),
    http: {
      async request() {
        httpCalls += 1;
        return { status: 401, bodyText: '{"error":"invalid api key"}' };
      },
    },
    models: { createModel() { throw new Error("catalog 档不该构造模型"); } },
    ledger,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });

  assert.equal(httpCalls, 1, "catalog 档应发出一次目录请求");
  const read = await ledger.read();
  assert.ok(read.events.length > 0, "应写入账本事件");
  for (const event of read.events) {
    assert.equal(event.schemaVersion, 1, "账本 schemaVersion 必须保持 1");
    for (const check of event.checks) {
      assert.equal(
        "reasonCode" in check,
        false,
        "账本检查点不得携带 reasonCode（additive 扩展只作用于内存报告）",
      );
      assert.deepEqual(
        Object.keys(check).sort(),
        check.detail === undefined ? ["id", "status"] : ["detail", "id", "status"],
        "账本检查点字段集必须保持 id/status/detail 三项",
      );
    }
  }
  // 同时确认这次运行确实产出了带 reasonCode 的内存报告（否则上面的断言是空跑）。
  const failed = read.events[0].checks.find((c) => c.id === "catalog_live_endpoint");
  assert.equal(failed.status, "failed", "401 应让目录检查点失败");
});
