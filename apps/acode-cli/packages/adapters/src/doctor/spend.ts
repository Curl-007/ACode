// ============================================================
// Provider Doctor 花费跟踪（J3-1 / spec R6）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 「这次诊断花了我多少钱」必须是可回答的：live 档真的会打真实调用。计数只取 provider
// 返回的 usage——不估算、不按字符数猜、缺数据就如实说 hasTokenData=false。

import { getModelUsageTotalTokens, type ModelUsage } from "@acode/contracts";
import type { ProviderDoctorSpend } from "./types.js";

export const EMPTY_PROVIDER_DOCTOR_SPEND: ProviderDoctorSpend = Object.freeze({
  billableCalls: 0,
  catalogCalls: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  hasTokenData: false,
});

export interface ProviderDoctorSpendTracker {
  /** 一次真实模型调用（非流式 / 流式 / 工具调用），usage 可缺席。 */
  recordModelCall(usage?: ModelUsage): void;
  /** 一次目录端点请求：触网但不产生 token 花费，单独计数以免混淆。 */
  recordCatalogCall(): void;
  snapshot(): ProviderDoctorSpend;
}

export function createProviderDoctorSpendTracker(): ProviderDoctorSpendTracker {
  let billableCalls = 0;
  let catalogCalls = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasTokenData = false;

  return {
    recordModelCall(usage?: ModelUsage): void {
      billableCalls += 1;
      if (!usage) return;
      const prompt = usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const completion = usage.outputTokens ?? 0;
      const total = getModelUsageTotalTokens(usage);
      if (usage.inputTokens !== undefined || usage.cacheReadTokens !== undefined) {
        promptTokens += prompt;
        hasTokenData = true;
      }
      if (usage.outputTokens !== undefined) {
        outputTokens += completion;
        hasTokenData = true;
      }
      if (total > 0) {
        totalTokens += total;
        hasTokenData = true;
      }
    },
    recordCatalogCall(): void {
      catalogCalls += 1;
    },
    snapshot(): ProviderDoctorSpend {
      return Object.freeze({
        billableCalls,
        catalogCalls,
        promptTokens,
        outputTokens,
        totalTokens,
        hasTokenData,
      });
    },
  };
}

/** 覆盖视图的累计花费：各 provider×model 的最新一次证据之和（不重复计历史）。 */
export function summarizeProviderDoctorSpend(
  spends: readonly ProviderDoctorSpend[],
): ProviderDoctorSpend {
  return spends.reduce<ProviderDoctorSpend>(
    (total, spend) => ({
      billableCalls: total.billableCalls + spend.billableCalls,
      catalogCalls: total.catalogCalls + spend.catalogCalls,
      promptTokens: total.promptTokens + spend.promptTokens,
      outputTokens: total.outputTokens + spend.outputTokens,
      totalTokens: total.totalTokens + spend.totalTokens,
      hasTokenData: total.hasTokenData || spend.hasTokenData,
    }),
    EMPTY_PROVIDER_DOCTOR_SPEND,
  );
}

export function formatProviderDoctorSpend(spend: ProviderDoctorSpend): string {
  if (spend.billableCalls === 0 && spend.catalogCalls === 0) {
    return "本次运行没有可计费调用（未花费余额）";
  }
  const parts: string[] = [];
  if (spend.billableCalls > 0) {
    parts.push(`${spend.billableCalls} 次可计费模型调用`);
  }
  if (spend.catalogCalls > 0) {
    parts.push(`${spend.catalogCalls} 次目录端点请求`);
  }
  parts.push(
    spend.hasTokenData
      ? `${spend.totalTokens} tokens（${spend.promptTokens} in + ${spend.outputTokens} out）`
      : "provider 未返回 token 用量",
  );
  return parts.join("，");
}
