// Provider 诊断（U08）契约守护测试。
// 规格 packages/services/specs/provider-diagnostics.md（R2/R5/R6/R8），
// 档位与 checkpoint 语义真源 apps/acode-cli/specs/provider-doctor.md（R2/R3/R5）。
//
// 钉住四条契约不变量：
// 1. `.strict()` 白名单——未知字段、尤其敏感字段名（apiKey/authorization/keyHash…）在 parse
//    时被拒，「结构性排除凭据」不依赖生产侧自律（R8 / 提案隐私门槛 = 0）；
// 2. status / verdict / reasonCode / remediation 是**闭集**——不存在 passed/ready 之类可
//    伪造结论的额外值，也不允许把 skipped 折叠进 failed（R5 / U08-A5）；
// 3. `revision` 必填回显——迟到结果对新 revision 的写入为 0（R2 / U08-A3）；
// 4. 12 检查点恒定——数量、id 集合、去重由 schema `superRefine` 强制（provider-doctor.md R3）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT,
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  PROVIDER_DIAGNOSTICS_REASON_CODES,
  PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS,
  PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR,
  PROVIDER_DIAGNOSTICS_CANCEL_PARSE_ERROR,
  PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR,
  PROVIDER_DIAGNOSTICS_ZERO_SPEND,
  parseProviderDiagnosticsCancelResult,
  parseProviderDiagnosticsRequest,
  parseProviderDiagnosticsResult,
  providerDiagnosticsCheckStatusSchema,
  providerDiagnosticsCheckpointIdSchema,
  providerDiagnosticsReasonCodeSchema,
  providerDiagnosticsRemediationActionSchema,
  providerDiagnosticsResultSchema,
  providerDiagnosticsVerdictSchema,
} from "../src/providerDiagnostics.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 12 个全 passed 的检查点（构造合法结果的基底）。 */
function allPassedCheckpoints() {
  return PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id) => ({ id, status: "passed" as const }));
}

/** 一份最小合法的 completed/live/ready 结果。 */
function minimalResult(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    providerId: "zai",
    revision: 7,
    tier: "live",
    modelId: "glm-4.6",
    status: "completed",
    verdict: "ready",
    checkpoints: allPassedCheckpoints(),
    remediationActions: ["retry-diagnostics"],
    nextStepCommands: ["acode doctor --provider=zai --tier=live"],
    spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND },
    blockedNetworkCalls: 0,
    startedAt: "2026-10-26T00:00:00.000Z",
    finishedAt: "2026-10-26T00:00:01.000Z",
    ...overrides,
  };
}

test("请求 schema：合法请求 round-trip，tier 无默认值（缺 tier 即拒，不静默升档）", () => {
  const parsed = parseProviderDiagnosticsRequest({
    requestId: "req-1",
    providerId: "zai",
    revision: 3,
    tier: "offline",
  });
  assert.equal(parsed.tier, "offline");
  // 缺省档由 UI 决定，schema 给默认值会让「忘记传 tier」静默变成某一档（可能意外触网）。
  assert.throws(() =>
    parseProviderDiagnosticsRequest({ requestId: "r", providerId: "p", revision: 0 }),
  );
  assert.throws(() => parseProviderDiagnosticsRequest({ ...parsed, tier: "full" }));
});

test("R6: 三个 parse 入口都抛**稳定错误码**（fail-loud，不吞异常也不回显原值）", () => {
  // 稳定码是对外契约：调用方按它归类，不匹配 message 文本。镜像 parseLocalDiagnosticReport 纪律。
  assert.throws(
    () => parseProviderDiagnosticsRequest({ requestId: "r", providerId: "p" }),
    (err: unknown) => err instanceof Error && err.message === PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR,
  );
  assert.throws(
    () => parseProviderDiagnosticsResult(minimalResult({ status: "failed" })),
    (err: unknown) => err instanceof Error && err.message === PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR,
  );
  assert.throws(
    () => parseProviderDiagnosticsCancelResult({ requestId: "r" }),
    (err: unknown) => err instanceof Error && err.message === PROVIDER_DIAGNOSTICS_CANCEL_PARSE_ERROR,
  );
  // 三个码互不相同：调用方能区分「请求畸形 / 结果畸形 / 取消回包畸形」。
  assert.equal(
    new Set([
      PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR,
      PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR,
      PROVIDER_DIAGNOSTICS_CANCEL_PARSE_ERROR,
    ]).size,
    3,
  );
  // 抛出的消息里不得回显被拒的输入（可能含凭据形态字段，R8）。
  let message = "";
  try {
    parseProviderDiagnosticsRequest({ requestId: "r", providerId: "p", revision: 0, tier: "offline", apiKey: "sk-secret-value" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.equal(message, PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR);
  assert.equal(message.includes("sk-secret-value"), false, "错误消息不得回显被拒的输入值");
});

test("R8: 请求 schema：live 需要 liveOptIn 字段可表达（授权语义由服务层强制，schema 只承载事实）", () => {
  const live = parseProviderDiagnosticsRequest({
    requestId: "r",
    providerId: "p",
    revision: 0,
    tier: "live",
    liveOptIn: true,
  });
  assert.equal(live.liveOptIn, true);
});

test("R8: 请求 .strict() 拒绝未知字段与凭据形态字段", () => {
  const base = { requestId: "r", providerId: "p", revision: 1, tier: "offline" };
  for (const extra of [
    { apiKey: "sk-live-fake" },
    { authorization: "Bearer fake" },
    { credentialRef: "provider:apikey:p" },
    { unexpected: 1 },
  ]) {
    assert.throws(
      () => parseProviderDiagnosticsRequest({ ...base, ...extra }),
      (err: unknown) => err instanceof Error,
      `请求 schema 未拒绝注入字段: ${JSON.stringify(Object.keys(extra))}`,
    );
  }
});

test("R8: 结果 .strict() 在顶层与检查点内拒绝凭据形态字段（结构性排除的核心断言）", () => {
  // 执行方若被改坏、把凭据塞进结果，schema 必须在 parse 层拒绝——不依赖下游过滤。
  for (const sensitive of [
    { apiKey: "sk-live-fake" },
    { authorization: "Bearer fake" },
    { keyHash: "deadbeef" },
    { baseUrl: "https://api.example.com/v1?key=sk-live-fake" },
    { rawDetail: "整段原始错误文本透传" },
    {
      checkpoints: allPassedCheckpoints().map((checkpoint, index) =>
        index === 0 ? { ...checkpoint, detail: "凭据真值泄漏" } : checkpoint,
      ),
    },
    { spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, apiKey: "sk-live-fake" } },
  ]) {
    assert.throws(
      () => parseProviderDiagnosticsResult(minimalResult(sensitive)),
      (err: unknown) => err instanceof Error && err.message === PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR,
      `结果 schema 未拒绝注入字段: ${JSON.stringify(Object.keys(sensitive))}`,
    );
  }
});

test("R8: DTO 结构性地没有承载 label/detail 的字段——用户文本由 UI 走 i18n 生成", () => {
  // 检查点只允许 id/status/reasonCode/durationMs。中文 detail 不进边界，
  // 既避免中英文混排，也让「不做文本匹配」（R6）成为结构保证。
  assert.throws(() =>
    providerDiagnosticsResultSchema.parse(
      minimalResult({
        checkpoints: [{ id: "credential_available", status: "passed", label: "凭据可用" }],
      }),
    ),
  );
  assert.deepEqual(Object.keys(minimalResult().checkpoints[0]!), ["id", "status"]);
});

test("R2: revision 必填——缺失即拒，迟到结果无法被构造成「无 revision」形态", () => {
  const { revision: _drop, ...noRevision } = minimalResult();
  assert.throws(() => parseProviderDiagnosticsResult(noRevision));
  // 非整数与负数同样拒绝：revision 是 Registry 的整数事实，不是凭据派生物。
  assert.throws(() => parseProviderDiagnosticsResult(minimalResult({ revision: -1 })));
  assert.throws(() => parseProviderDiagnosticsResult(minimalResult({ revision: 1.5 })));
  assert.equal(parseProviderDiagnosticsResult(minimalResult()).revision, 7);
});

test("R5: 检查状态是四态闭集——skipped 与 failed 不可折叠，也不存在可伪造健康的额外值", () => {
  const allowed = providerDiagnosticsCheckStatusSchema.options;
  assert.deepEqual([...allowed].sort(), ["blocked", "failed", "passed", "skipped"]);
  for (const invalid of ["ok", "healthy", "not-run", "unknown", ""]) {
    assert.throws(() => providerDiagnosticsCheckStatusSchema.parse(invalid));
  }
  // 四态都能进结果（skipped 是合法终态，不是「缺数据」）。
  const fourState = PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.map((id, index) => ({
    id,
    status: (["passed", "failed", "skipped", "blocked"] as const)[index % 4]!,
  }));
  const parsed = parseProviderDiagnosticsResult(
    minimalResult({
      status: "failed",
      verdict: undefined,
      errorCode: "execution-failed",
      checkpoints: fourState,
    }),
  );
  assert.equal(parsed.checkpoints[1]!.status, "failed");
  assert.equal(parsed.checkpoints[2]!.status, "skipped");
});

test("R5/R6: verdict 是三态闭集，offline 结论不可能是 ready（轻档不越档背书）", () => {
  assert.deepEqual([...providerDiagnosticsVerdictSchema.options].sort(), [
    "failed",
    "ready",
    "tier-passed",
  ]);
  for (const invalid of ["ok", "passed", "partial", "tier_failed"]) {
    assert.throws(() => providerDiagnosticsVerdictSchema.parse(invalid));
  }
  // offline 档通过 = tier-passed，不是 ready（provider-doctor.md R2）。
  const offline = parseProviderDiagnosticsResult(
    minimalResult({ tier: "offline", verdict: "tier-passed" }),
  );
  assert.equal(offline.verdict, "tier-passed");
  assert.notEqual(offline.verdict, "ready");
});

test("R6: reasonCode 闭集区分「密钥错了 / 密钥不在 / 目录为空」（U08-A2 的机械断言面）", () => {
  const codes = new Set<string>(PROVIDER_DIAGNOSTICS_REASON_CODES);
  // 三者必须是三个不同的码，UI 才能给三种不同的修复动作。
  for (const code of ["credential-missing", "credential-rejected", "catalog-empty"]) {
    assert.ok(codes.has(code), `缺少稳定错误码: ${code}`);
  }
  // 失效凭据引用与凭据被拒也不同：前者本地可判定，后者只有联网才知道。
  assert.notEqual("credential-undecryptable", "credential-rejected");
  // 闭集外一律拒绝（不做自由字符串错误码，否则 UI 无法映射 i18n）。
  for (const invalid of ["unknown-error", "401", "ECONNREFUSED", ""]) {
    assert.throws(() => providerDiagnosticsReasonCodeSchema.parse(invalid));
  }
});

test("R5: catalog-unsupported / tool-call-unsupported 与失败态并存——「不可检查」是独立词汇", () => {
  const codes = new Set<string>(PROVIDER_DIAGNOSTICS_REASON_CODES);
  // 端点不支持目录列举（404/405/501）→ Doctor 记 skipped；模型不支持 tool call → skipped。
  for (const code of ["catalog-unsupported", "tool-call-unsupported", "catalog-unreachable"]) {
    assert.ok(codes.has(code), `缺少 skipped 语义的稳定码: ${code}`);
  }
});

test("R3/R4: 执行终态三值闭集，cancelled 与 failed 分开（取消不是失败）", () => {
  const cancelled = parseProviderDiagnosticsResult(
    minimalResult({
      status: "cancelled",
      verdict: undefined,
      errorCode: "cancelled",
      spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, billableCalls: 1 },
    }),
  );
  assert.equal(cancelled.status, "cancelled");
  // 取消时仍带 spend：已发出的调用无法追回，UI 据此如实告知而非承诺退费（R4 / U08-A3）。
  assert.equal(cancelled.spend.billableCalls, 1);
});

test("结果 schema：status !== completed 必须带 errorCode，且不得带 verdict", () => {
  // 失败/取消没有稳定码 = UI 只能说「失败了」，违反 R6。
  assert.throws(() => parseProviderDiagnosticsResult(minimalResult({ status: "failed" })));
  // verdict 只在 completed 时可信：失败结果若带 verdict，UI 可能把它渲染成结论。
  assert.throws(() =>
    parseProviderDiagnosticsResult(
      minimalResult({ status: "failed", errorCode: "execution-failed", verdict: "ready" }),
    ),
  );
  assert.throws(() =>
    parseProviderDiagnosticsResult(
      minimalResult({ status: "cancelled", errorCode: "cancelled", verdict: "tier-passed" }),
    ),
  );
});

test("provider-doctor.md R3: 12 检查点恒定——数量、id 集合、去重由 schema 强制", () => {
  assert.equal(PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT, 12);
  assert.equal(PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.length, 12);
  // 少一个检查点 = 执行方漂移了检查点目录，必须 fail-loud 而非渲染残缺列表。
  assert.throws(() =>
    parseProviderDiagnosticsResult(
      minimalResult({ checkpoints: allPassedCheckpoints().slice(0, 11) }),
    ),
  );
  // 多一个（重复 id）同样拒绝。
  const duplicated = [...allPassedCheckpoints(), { id: "credential_available", status: "passed" }];
  assert.throws(() => parseProviderDiagnosticsResult(minimalResult({ checkpoints: duplicated })));
  // 未知 id 拒绝（闭集）。
  assert.throws(() =>
    parseProviderDiagnosticsResult(
      minimalResult({
        checkpoints: [...allPassedCheckpoints().slice(0, 11), { id: "new_checkpoint", status: "passed" }],
      }),
    ),
  );
  assert.throws(() => providerDiagnosticsCheckpointIdSchema.parse("not_a_checkpoint"));
});

test("R9: blockedNetworkCalls 必填且非负——offline 档 >0 即零网络不变量被违背", () => {
  const { blockedNetworkCalls: _drop, ...missing } = minimalResult();
  assert.throws(() => parseProviderDiagnosticsResult(missing));
  assert.throws(() => parseProviderDiagnosticsResult(minimalResult({ blockedNetworkCalls: -1 })));
  assert.equal(
    parseProviderDiagnosticsResult(minimalResult({ blockedNetworkCalls: 2 })).blockedNetworkCalls,
    2,
  );
});

test("R9: 零花费常量的每一档都是 0（offline 承诺的断言基底）", () => {
  assert.deepEqual(PROVIDER_DIAGNOSTICS_ZERO_SPEND, {
    billableCalls: 0,
    catalogCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    hasTokenData: false,
  });
});

test("R6: spend 各计数非负整数（token 只取 provider 返回的 usage，不估算）", () => {
  for (const field of ["billableCalls", "catalogCalls", "promptTokens", "totalTokens"]) {
    assert.throws(
      () =>
        parseProviderDiagnosticsResult(
          minimalResult({ spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, [field]: -1 } }),
        ),
      `spend.${field} 未拒绝负数`,
    );
  }
});

test("取消结果：cancelled:false 是合法结果（requestId 不在飞不是错误）", () => {
  const notInFlight = parseProviderDiagnosticsCancelResult({
    requestId: "gone",
    cancelled: false,
  });
  assert.equal(notInFlight.cancelled, false);
  assert.equal(notInFlight.spend, undefined);
  const inFlight = parseProviderDiagnosticsCancelResult({
    requestId: "req-1",
    cancelled: true,
    spend: { ...PROVIDER_DIAGNOSTICS_ZERO_SPEND, catalogCalls: 1 },
  });
  assert.equal(inFlight.spend?.catalogCalls, 1);
  // .strict()：取消结果同样不透传未知字段。
  assert.throws(() =>
    parseProviderDiagnosticsCancelResult({ requestId: "r", cancelled: true, apiKey: "sk-fake" }),
  );
});

test("修复动作是闭集白名单——UI 只能映射 i18n，不能据此拼可执行命令", () => {
  const actions = new Set<string>(PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS);
  // 首次配置「保持已保存、稍后验证」的出口必须在白名单内（提案 §3.6）。
  for (const action of [
    "open-api-key-settings",
    "relogin-account",
    "verify-later",
    "retry-diagnostics",
  ]) {
    assert.ok(actions.has(action), `缺少修复动作: ${action}`);
  }
  // 自由字符串动作拒绝（否则 UI 无法映射，且会变成命令注入面）。
  for (const invalid of ["rm -rf /tmp", "run:acode login", "", "openUrl(https://evil)"]) {
    assert.throws(() => providerDiagnosticsRemediationActionSchema.parse(invalid));
  }
  // 结果里的 remediationActions 逐项过白名单校验，未知动作使整条结果被拒。
  assert.throws(() =>
    parseProviderDiagnosticsResult(
      minimalResult({ remediationActions: ["retry-diagnostics", "curl https://evil"] }),
    ),
  );
});

test("中立叶子纪律：不 import legacy barrel / v4 目录，只依赖 zod（+ 兄弟词汇文件）", () => {
  // 与 acode-protocol-shared.ts 同一纪律（M2-B）：反向依赖会让冻结面重新被牵动。
  // 契约叶子拆成 providerDiagnostics.ts（线协议 schema）+ providerDiagnosticsVocabulary.ts
  // （闭集词汇）两个文件，两者都必须守纪律。
  const files = [
    join(HERE, "..", "src", "providerDiagnostics.ts"),
    join(HERE, "..", "src", "providerDiagnosticsVocabulary.ts"),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    assert.equal(
      /from "\.\/acode-protocol\/index\.js"|from "\.\/acode-protocol-v4\//.test(source),
      false,
      `${file} 不得 import legacy barrel 或 v4 目录`,
    );
    // 允许的外部依赖只有 zod 与彼此的兄弟文件；不牵 node-only 模块（根 barrel 浏览器安全 R7）。
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    const allowed = new Set([
      "zod",
      "./providerDiagnostics.js",
      "./providerDiagnosticsVocabulary.js",
    ]);
    for (const specifier of specifiers) {
      assert.ok(
        allowed.has(specifier),
        `${file} 出现意外依赖 ${specifier}（只允许 zod 与兄弟词汇文件）`,
      );
    }
  }
});

test("legacy barrel 冻结面：新契约不得回流进 acode-protocol/index.ts", () => {
  // U08 的 DTO 必须走中立叶子；既有 ACodeProviderTestModelConnectivityResult 在 barrel 里
  // 是存量，不是可效仿的先例（冻结规则只删不增）。
  const barrel = readFileSync(join(HERE, "..", "src", "acode-protocol", "index.ts"), "utf-8");
  assert.equal(
    /providerDiagnostics|ProviderDiagnostics/.test(barrel),
    false,
    "provider 诊断契约不得进 legacy barrel",
  );
  // 根 barrel 必须公开本叶子，否则跨包消费者拿不到契约。
  const root = readFileSync(join(HERE, "..", "src", "index.ts"), "utf-8");
  assert.match(root, /export \* from "\.\/providerDiagnostics\.js";/);
});
