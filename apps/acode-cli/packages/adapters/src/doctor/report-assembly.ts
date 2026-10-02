// ============================================================
// Provider Doctor 结论装配（J3-1 / spec R2 + R6 + R7）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// verdict、下一步建议、账本事件的装配集中在这里：主流程只负责跑检查点。
// 「轻档不越档背书」「未通过必给可执行命令」「账本只收白名单字段」三条规则的实现点。

import type { Logger } from "@acode/contracts";
import {
  getProviderDoctorCheckpoint,
  isSafeProviderDoctorCommandId,
  providerDoctorCommand,
  providerDoctorEscalationHint,
  type ProviderDoctorHintContext,
} from "./checkpoints.js";
import { describeError } from "./internal.js";
import { createProviderDoctorLedgerEvent } from "./ledger.js";
import type { ProviderDoctorRedactor } from "./redaction.js";
import type {
  ProviderDoctorAccessFacts,
  ProviderDoctorCheckResult,
  ProviderDoctorLedgerCheck,
  ProviderDoctorLedgerEvent,
  ProviderDoctorModelFacts,
  ProviderDoctorProviderFacts,
  ProviderDoctorReport,
  ProviderDoctorTier,
  ProviderDoctorVerdict,
} from "./types.js";

/** 详情里最多列几个模型 id：够用户下一步选模型，不至于把整张目录喷到终端。 */
const MAX_LISTED_MODEL_IDS = 5;

export function resolveTargetModelId(
  provider: ProviderDoctorProviderFacts,
  requestedModelId: string | undefined,
  defaultSelection: { providerId: string; modelId: string } | undefined,
): string | undefined {
  const requested = requestedModelId?.trim();
  if (requested) return requested;
  if (defaultSelection && defaultSelection.providerId === provider.providerId) {
    return defaultSelection.modelId;
  }
  return provider.models[0]?.modelId;
}

export function listModelIds(models: readonly ProviderDoctorModelFacts[]): string {
  if (models.length === 0) return "无";
  const sample = models.slice(0, MAX_LISTED_MODEL_IDS).map((model) => model.modelId);
  return models.length > sample.length
    ? `${sample.join(", ")} …共 ${models.length} 个`
    : sample.join(", ");
}

export function containsModelId(modelIds: readonly string[], modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  return modelIds.some((id) => id === modelId || id.toLowerCase() === lowered);
}

export function suggestAlternativeModelId(
  provider: ProviderDoctorProviderFacts,
  liveCatalogModelIds: readonly string[],
  currentModelId: string | undefined,
): string | undefined {
  // 对抗复核 F4：候选 id 来自实时目录响应与本地配置，均不可信——非白名单 id 不进建议
  // （否则会被 providerDoctorCommand 之外的建议文案路径引用）。命令构造处还有同一道
  // 白名单兜底（双重把关），这里先过滤让「无安全候选」尽早退化为占位符文案。
  const fromLive = liveCatalogModelIds.find(
    (id) => id !== currentModelId && isSafeProviderDoctorCommandId(id),
  );
  if (fromLive) return fromLive;
  return provider.models.find(
    (model) => model.modelId !== currentModelId && isSafeProviderDoctorCommandId(model.modelId),
  )?.modelId;
}

export function findFirstFailure(
  checks: readonly ProviderDoctorCheckResult[],
): ProviderDoctorCheckResult | undefined {
  return checks.find((check) => check.status === "failed" || check.status === "blocked");
}

/** skipped 不算失败（轻档本就不跑重档检查点），但也不算通过——只有全 passed 才 READY。 */
export function computeProviderDoctorVerdict(input: {
  tier: ProviderDoctorTier;
  checks: readonly ProviderDoctorCheckResult[];
}): { tierPassed: boolean; ready: boolean; verdict: ProviderDoctorVerdict } {
  const tierPassed = findFirstFailure(input.checks) === undefined;
  const ready = input.tier === "live" && input.checks.every((check) => check.status === "passed");
  return { tierPassed, ready, verdict: ready ? "ready" : tierPassed ? "tier-passed" : "failed" };
}

export function buildProviderDoctorHintContext(input: {
  provider: ProviderDoctorProviderFacts;
  tier: ProviderDoctorTier;
  modelId?: string;
  checks: readonly ProviderDoctorCheckResult[];
  liveCatalogModelIds: readonly string[];
}): ProviderDoctorHintContext {
  const access: ProviderDoctorAccessFacts = input.provider.access;
  const firstFailure = findFirstFailure(input.checks);
  const suggestedModelId = suggestAlternativeModelId(
    input.provider,
    input.liveCatalogModelIds,
    input.modelId,
  );
  return {
    providerId: input.provider.providerId,
    tier: input.tier,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(access.type ? { accessType: access.type } : {}),
    ...(access.accountType ? { accountType: access.accountType } : {}),
    ...(input.provider.apiType ? { apiType: input.provider.apiType } : {}),
    ...(firstFailure ? { detail: firstFailure.detail } : {}),
    ...(suggestedModelId ? { suggestedModelId } : {}),
  };
}

export function buildNextSteps(
  checks: readonly ProviderDoctorCheckResult[],
  hintContext: ProviderDoctorHintContext,
  commandContext: { providerId: string; modelId?: string; tier: ProviderDoctorTier },
): readonly string[] {
  const steps: string[] = [];
  for (const check of checks) {
    if (check.status !== "failed" && check.status !== "blocked") continue;
    // 建议按「这一条失败」的详情生成，而不是按首个失败的详情——否则同一 provider 的
    // 多个失败点会共用一句不相干的提示。
    const hint = getProviderDoctorCheckpoint(check.id).nextStep({
      ...hintContext,
      detail: check.detail,
    });
    if (hint && !steps.includes(hint)) steps.push(hint);
  }
  if (steps.length === 0) {
    const escalation = providerDoctorEscalationHint(commandContext);
    steps.push(
      escalation ??
        `已是最高档且全部通过（READY）。复验：\`${providerDoctorCommand(commandContext)}\``,
    );
  }
  return steps;
}

export async function recordProviderDoctorLedgerEvent(input: {
  ledger?: { record(event: ProviderDoctorLedgerEvent): Promise<void> };
  report: ProviderDoctorReport;
  checks: readonly ProviderDoctorCheckResult[];
  hintContext: ProviderDoctorHintContext;
  redactor: ProviderDoctorRedactor;
  recordedAt: Date;
  endpointHost?: string;
  runner?: ProviderDoctorLedgerEvent["runner"];
  retestDays?: number;
  logger?: Logger;
}): Promise<void> {
  if (!input.ledger) return;
  const firstFailure = findFirstFailure(input.checks);
  const ledgerChecks: ProviderDoctorLedgerCheck[] = input.checks.map((check) => ({
    id: check.id,
    status: check.status,
    // 只有非通过项才留详情，且走更短的账本上限：账本是证据索引，不是日志转储。
    ...(check.status === "passed" || check.status === "skipped"
      ? {}
      : { detail: input.redactor.redactForLedger(check.detail) }),
  }));
  const event = createProviderDoctorLedgerEvent({
    recordedAt: input.recordedAt,
    tier: input.report.tier,
    providerId: input.report.providerId,
    ...(input.report.providerLabel ? { providerLabel: input.report.providerLabel } : {}),
    ...(input.report.modelId ? { modelId: input.report.modelId } : {}),
    ...(input.endpointHost ? { endpointHost: input.endpointHost } : {}),
    result: input.report.verdict,
    checks: ledgerChecks,
    ...(firstFailure
      ? {
          firstFailure: {
            id: firstFailure.id,
            hint: input.redactor.redactForLedger(
              getProviderDoctorCheckpoint(firstFailure.id).nextStep(input.hintContext),
            ),
          },
        }
      : {}),
    spend: input.report.spend,
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.retestDays !== undefined ? { retestDays: input.retestDays } : {}),
  });
  try {
    await input.ledger.record(event);
  } catch (error) {
    // 账本写失败不能让诊断结果丢失：证据没落盘是可观察的降级，不是运行失败。
    input.logger?.warn("provider doctor 覆盖账本写入失败", { error: describeError(error) });
  }
}

export { MAX_LISTED_MODEL_IDS };
