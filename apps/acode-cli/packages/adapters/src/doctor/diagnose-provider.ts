// ============================================================
// Provider Doctor 单 provider 检查流水线（J3-1 / spec R3）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 12 个检查点按固定顺序跑完一个 provider：#1-#6 本地零网络（offline-checks.ts），
// #7-#9 需要 catalog 档（本文件），#10-#12 需要 live 档（live-checks.ts）。
// 判定文案与下一步建议不在这里生成（属于 checkpoints.ts），本文件只「取事实 → 判定 → 记录」。

import type { DnsLookup } from "../http/public-egress-policy.js";
import { defaultPublicDnsLookup } from "../http/public-egress-policy.js";
import { createProviderDoctorCheckRecorder } from "./check-recorder.js";
import { getProviderDoctorCheckpoint, isCheckpointRunAtTier } from "./checkpoints.js";
import { probeProviderModelCatalog } from "./catalog-probe.js";
import {
  hasRequestAuth,
  resolveProviderDoctorAccountAccess,
  resolveProviderDoctorApiKey,
} from "./credential-probe.js";
import {
  assertProviderEndpointPublicEgress,
  inspectProviderEndpoint,
} from "./endpoint-policy.js";
import { describeError, timedRun } from "./internal.js";
import { runProviderDoctorLiveChecks } from "./live-checks.js";
import {
  recordCatalogDeclaredCheck,
  recordConfigSourceCheck,
  recordCredentialCheck,
  recordEndpointShapeCheck,
  recordModelRouteCheck,
  recordSchemaCheck,
} from "./offline-checks.js";
import { createProviderDoctorRedactor } from "./redaction.js";
import {
  MAX_LISTED_MODEL_IDS,
  buildNextSteps,
  buildProviderDoctorHintContext,
  computeProviderDoctorVerdict,
  containsModelId,
  recordProviderDoctorLedgerEvent,
  resolveTargetModelId,
} from "./report-assembly.js";
import {
  createProviderDoctorSpendTracker,
  type ProviderDoctorSpendTracker,
} from "./spend.js";
import type { ProviderDoctorCheckRecorder } from "./check-recorder.js";
import type {
  ProviderDoctorHttpPort,
  ProviderDoctorProviderFacts,
  ProviderDoctorRegistrySnapshot,
  ProviderDoctorReport,
  ProviderDoctorRunInput,
  ProviderDoctorTier,
} from "./types.js";

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

export interface DiagnoseProviderInput {
  readonly provider: ProviderDoctorProviderFacts;
  readonly snapshot: ProviderDoctorRegistrySnapshot;
  readonly http: ProviderDoctorHttpPort;
  readonly input: ProviderDoctorRunInput;
  readonly tier: ProviderDoctorTier;
  readonly now: () => Date;
}

export async function diagnoseProvider(
  context: DiagnoseProviderInput,
): Promise<ProviderDoctorReport> {
  const { provider, snapshot, http, input, tier, now } = context;
  const startedAt = now();
  // 已知凭据真值：先收 provider 事实里声明的，catalog/live 档解析出的账号凭据再追加。
  const knownSecrets: string[] = [...provider.secretValues];
  const redactor = createProviderDoctorRedactor(knownSecrets);
  const recorder = createProviderDoctorCheckRecorder(tier, redactor);
  const spend = createProviderDoctorSpendTracker();

  const modelId = resolveTargetModelId(provider, input.modelId, input.defaultModelSelection);
  const modelFacts = modelId
    ? provider.models.find((model) => model.modelId === modelId)
    : undefined;
  const endpointVerdict = inspectProviderEndpoint(provider.baseUrl);

  recordConfigSourceCheck(recorder, snapshot);
  recordSchemaCheck(recorder, provider);
  recordEndpointShapeCheck(recorder, provider, endpointVerdict);
  await recordCredentialCheck(recorder, provider, input, modelId);
  recordCatalogDeclaredCheck(recorder, provider);
  recordModelRouteCheck(recorder, provider, modelId, modelFacts);

  const credentialUsable = recorder.isPassed("credential_available");
  const routeResolved =
    recorder.isPassed("model_route_resolved") && Boolean(modelId && modelFacts);

  const dnsLookup: DnsLookup = input.dnsLookup ?? defaultPublicDnsLookup();
  await recordEgressCheck(recorder, provider, endpointVerdict, tier, dnsLookup, input.signal);
  const egressPassed = recorder.isPassed("endpoint_public_egress");
  // 端点判定同样是 live 探针（#10-#12）的前置（评审 J3 修复）。spec R4 是硬约束原文：
  // 「端点被判定为内网/环回 → endpoint_public_egress 失败，且**不发出任何请求**（先校验
  // 后连接）」。此前 prerequisitesMet 只含 credential_available + model_route_resolved，
  // 于是端点已被本模块判为环回/内网（#3/#7 failed）时，live 档仍带着真实凭据向该端点发
  // 3 次模型调用并计入 spend.billableCalls——既违背硬约束，也把余额花在一条本模块自己
  // 已经拒绝的链路上。#3 一并纳入：协议不是 http/https 或 baseUrl 不可解析时同样不该建连
  // （明文 http 只在 #3 记 warning、仍是 passed，因此不受影响）。
  // 必须在 recordEgressCheck 之后求值：#7 的结论在那一步才落进 recorder。
  const endpointTrusted = recorder.isPassed("endpoint_shape_valid") && egressPassed;
  const liveCatalogModelIds = await recordCatalogChecks({
    recorder,
    spend,
    provider,
    http,
    input,
    tier,
    modelId,
    knownSecrets,
    credentialUsable,
    egressPassed,
  });

  await runProviderDoctorLiveChecks({
    recorder,
    spend,
    tier,
    prerequisitesMet: credentialUsable && routeResolved && endpointTrusted,
    ...(modelId && modelFacts
      ? {
          probeInput: {
            models: input.models,
            providerId: provider.providerId,
            modelId,
            model: modelFacts,
            timeoutMs: input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
            ...(input.invocationContext ? { invocationContext: input.invocationContext } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
        }
      : {}),
  });

  const checks = recorder.results();
  const { tierPassed, ready, verdict } = computeProviderDoctorVerdict({ tier, checks });
  const endpointHost = endpointVerdict.ok ? endpointVerdict.host : undefined;
  const hintContext = buildProviderDoctorHintContext({
    provider,
    tier,
    ...(modelId ? { modelId } : {}),
    checks,
    liveCatalogModelIds,
  });
  const finishedAt = now();
  const report: ProviderDoctorReport = Object.freeze({
    providerId: provider.providerId,
    ...(provider.providerName ? { providerLabel: provider.providerName } : {}),
    ...(modelId ? { modelId } : {}),
    tier,
    ...(endpointHost ? { endpointHost } : {}),
    checks: Object.freeze(checks),
    verdict,
    tierPassed,
    ready,
    spend: spend.snapshot(),
    nextSteps: Object.freeze(
      buildNextSteps(checks, hintContext, {
        providerId: provider.providerId,
        tier,
        ...(modelId ? { modelId } : {}),
      }),
    ),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  });

  await recordProviderDoctorLedgerEvent({
    ...(input.ledger ? { ledger: input.ledger } : {}),
    report,
    checks,
    hintContext,
    redactor,
    recordedAt: finishedAt,
    ...(endpointHost ? { endpointHost } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.retestDays !== undefined ? { retestDays: input.retestDays } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });

  return report;
}

async function recordEgressCheck(
  recorder: ProviderDoctorCheckRecorder,
  provider: ProviderDoctorProviderFacts,
  verdict: ReturnType<typeof inspectProviderEndpoint>,
  tier: ProviderDoctorTier,
  dnsLookup: DnsLookup,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!isCheckpointRunAtTier(getProviderDoctorCheckpoint("endpoint_public_egress"), tier)) {
    recorder.skip(
      "endpoint_public_egress",
      `${tier} 档零网络：DNS 出口校验需要 --tier=catalog 以上`,
    );
    return;
  }
  if (!verdict.ok) {
    recorder.set("endpoint_public_egress", "failed", verdict.reason);
    return;
  }
  const outcome = await timedRun(async () => {
    try {
      await assertProviderEndpointPublicEgress(provider.baseUrl ?? "", dnsLookup, { signal });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, reason: describeError(error) };
    }
  });
  if (outcome.result.ok) {
    recorder.set(
      "endpoint_public_egress",
      "passed",
      `主机 ${verdict.host} 通过公网出口校验（解析结果均为公网地址）`,
      outcome.durationMs,
    );
    return;
  }
  recorder.set(
    "endpoint_public_egress",
    "failed",
    `公网出口校验拒绝该端点: ${outcome.result.reason}`,
    outcome.durationMs,
  );
}

interface CatalogChecksInput {
  readonly recorder: ProviderDoctorCheckRecorder;
  readonly spend: ProviderDoctorSpendTracker;
  readonly provider: ProviderDoctorProviderFacts;
  readonly http: ProviderDoctorHttpPort;
  readonly input: ProviderDoctorRunInput;
  readonly tier: ProviderDoctorTier;
  readonly modelId: string | undefined;
  readonly knownSecrets: string[];
  readonly credentialUsable: boolean;
  readonly egressPassed: boolean;
}

async function recordCatalogChecks(context: CatalogChecksInput): Promise<readonly string[]> {
  const {
    recorder,
    spend,
    provider,
    http,
    input,
    tier,
    modelId,
    credentialUsable,
    egressPassed,
  } = context;
  if (!isCheckpointRunAtTier(getProviderDoctorCheckpoint("catalog_live_endpoint"), tier)) {
    const reason = `${tier} 档不触网：实时目录需要 --tier=catalog 以上`;
    recorder.skip("catalog_live_endpoint", reason);
    recorder.skip("catalog_model_listed", reason);
    return [];
  }
  if (!credentialUsable) {
    recorder.skip("catalog_live_endpoint", "凭据不可用，跳过目录请求（先修 credential_available）");
    recorder.skip("catalog_model_listed", "凭据不可用，跳过目录比对（先修 credential_available）");
    return [];
  }
  // 先校验后连接：出口校验没过就绝不发请求（spec R4）。
  if (!egressPassed) {
    recorder.skip(
      "catalog_live_endpoint",
      "端点未通过公网出口校验，拒绝发请求（先修 endpoint_public_egress）",
    );
    recorder.skip("catalog_model_listed", "端点未通过公网出口校验，拒绝发请求");
    return [];
  }

  const requestAuth = await resolveCatalogAuth(provider, input, modelId, context.knownSecrets);
  const outcome = await timedRun(() =>
    probeProviderModelCatalog({
      provider,
      http,
      ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
      ...(requestAuth.headers ? { authHeaders: requestAuth.headers } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      onNetworkCall: () => {
        spend.recordCatalogCall();
      },
    }),
  );
  const probe = outcome.result;
  if (probe.status === "ok") {
    recorder.set("catalog_live_endpoint", "passed", probe.detail, outcome.durationMs);
  } else if (probe.status === "unsupported") {
    recorder.set("catalog_live_endpoint", "skipped", probe.detail, outcome.durationMs);
  } else {
    recorder.set("catalog_live_endpoint", "failed", probe.detail, outcome.durationMs);
  }

  if (probe.status !== "ok") {
    recorder.skip(
      "catalog_model_listed",
      probe.status === "unsupported"
        ? "端点不提供目录列举，无法比对目标模型"
        : "实时目录请求未成功，无法比对目标模型",
    );
    return [];
  }
  if (!modelId) {
    recorder.skip("catalog_model_listed", "没有目标模型可比对");
    return probe.modelIds;
  }
  if (containsModelId(probe.modelIds, modelId)) {
    recorder.set(
      "catalog_model_listed",
      "passed",
      `目标模型 ${modelId} 出现在实时目录（共 ${probe.modelIds.length} 个）`,
    );
    return probe.modelIds;
  }
  recorder.set(
    "catalog_model_listed",
    "failed",
    `实时目录里没有 ${modelId}；目录样本: ${probe.modelIds
      .slice(0, MAX_LISTED_MODEL_IDS)
      .join(", ")}`,
  );
  return probe.modelIds;
}

async function resolveCatalogAuth(
  provider: ProviderDoctorProviderFacts,
  input: ProviderDoctorRunInput,
  modelId: string | undefined,
  knownSecrets: string[],
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  const headers: Record<string, string> = {};
  let apiKey = resolveProviderDoctorApiKey(provider.providerConfig);
  if (provider.access.type === "zhipu-account" && input.accountAuth) {
    // 请求身份随解析一起下发（评审 J3 修复）：与 #4 凭据探测同一原因——接线的 headers
    // port 缺 accountAccess 会直接抛「请求身份无效」，目录请求就拿不到鉴权（#8/#9 假失败）。
    const accountAccess = resolveProviderDoctorAccountAccess(provider.providerConfig);
    try {
      const auth = await input.accountAuth.resolve({
        providerId: provider.providerId,
        ...(modelId ? { modelId } : {}),
        ...(accountAccess ? { accountAccess } : {}),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      });
      if (auth?.apiKey) apiKey = auth.apiKey;
      for (const [name, value] of Object.entries(auth?.headers ?? {})) headers[name] = value;
    } catch {
      // 账号鉴权解析失败不抛：目录检查点会因为「没有可用凭据」如实失败。
    }
  }
  // 解析出来的真值必须立刻进入脱敏集合，否则它可能顺着错误文本流出。
  if (apiKey) knownSecrets.push(apiKey);
  for (const value of Object.values(headers)) {
    if (value.trim().length > 0) knownSecrets.push(value.trim());
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(hasRequestAuth({ headers }) ? { headers } : {}),
  };
}
