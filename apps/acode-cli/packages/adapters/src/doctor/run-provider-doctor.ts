// ============================================================
// Provider Doctor 编排（J3-1 / spec R1-R7）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 顶层只负责：取快照、选目标 provider、按档强制网络边界、逐 provider 跑流水线、
// 汇总覆盖账本。检查点判定在 diagnose-provider.ts，建议在 checkpoints.ts。
//
// 所有 IO 都经注入的 Port（registry/credentials/http/models/ledger），因此
// 「offline 档零网络」是可被测试证明的性质，而不是一句承诺。

import type { Logger } from "@acode/contracts";
import { diagnoseProvider } from "./diagnose-provider.js";
import { describeError } from "./internal.js";
import { summarizeProviderDoctorCoverage } from "./ledger.js";
import type { DnsLookup } from "../http/public-egress-policy.js";
import type {
  ProviderDoctorHttpPort,
  ProviderDoctorLedgerEvent,
  ProviderDoctorLedgerPort,
  ProviderDoctorModelPort,
  ProviderDoctorProviderFacts,
  ProviderDoctorRegistrySnapshot,
  ProviderDoctorReport,
  ProviderDoctorRunInput,
  ProviderDoctorRunResult,
  ProviderDoctorTier,
} from "./types.js";

export async function runProviderDoctor(
  input: ProviderDoctorRunInput,
): Promise<ProviderDoctorRunResult> {
  const now = input.now ?? ((): Date => new Date());
  const startedAt = now();
  const tier = input.tier;

  const snapshot = await loadSnapshot(input, input.logger);
  const targets = selectTargetProviders(snapshot, input.providerId);

  // 对抗复核 F7：offline 档的第二道强制从只包 http transport 扩到同时包 models port 与
  // dnsLookup——http 只是网络出口之一：live 探针经 models port（AI SDK transport 自带
  // 解析与建连），#7 出口校验经 dnsLookup。任一出口在 offline 档被触到都必须计数并
  // 可见失败，「offline 档零网络」才是可被测试证明的性质。
  let blockedNetworkCalls = 0;
  const onBlocked = (): void => {
    blockedNetworkCalls += 1;
  };
  const http = createTierGuardedHttpPort(input.http, tier, onBlocked);
  const models = createTierGuardedModelPort(input.models, tier, onBlocked);
  const dnsLookup = createTierGuardedDnsLookup(tier, onBlocked);

  const reports: ProviderDoctorReport[] = [];
  const diagnosticsInput: ProviderDoctorRunInput = {
    ...input,
    // 非 offline 档这里是原 port 透传；offline 档是守卫版（见 createTierGuardedModelPort）。
    models,
    ...(dnsLookup ? { dnsLookup } : {}),
  };
  for (const provider of targets) {
    reports.push(
      await diagnoseProvider({
        provider,
        snapshot,
        http,
        input: diagnosticsInput,
        tier,
        now,
      }),
    );
  }

  const ledgerRead = input.ledger ? await safeReadLedger(input.ledger, input.logger) : undefined;
  const coverage = ledgerRead
    ? summarizeProviderDoctorCoverage({
        events: ledgerRead.events,
        corruptLines: ledgerRead.corruptLines,
        now: now(),
      })
    : undefined;

  return Object.freeze({
    tier,
    reports: Object.freeze(reports),
    ...(coverage ? { coverage } : {}),
    ...(input.ledgerPath ? { ledgerPath: input.ledgerPath } : {}),
    blockedNetworkCalls,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  });
}

/** offline 档的第二道强制：即使接线漏注入 blocked transport，编排层也不放行网络。 */
export function createTierGuardedHttpPort(
  http: ProviderDoctorHttpPort,
  tier: ProviderDoctorTier,
  onBlocked: () => void,
): ProviderDoctorHttpPort {
  if (tier !== "offline") return http;
  return {
    async request(request) {
      onBlocked();
      throw new Error(
        `provider doctor offline 档禁止网络请求（被拦截的目标: ${safeHost(request.url)}）`,
      );
    },
  };
}

/**
 * 对抗复核 F7：offline 档对模型客户端出口的第二道强制。live 探针经 models port 构造
 * AI SDK 客户端（transport 自带 DNS 与建连），绕过了 http transport 的拦截面——
 * offline 档触到该出口同样计数并抛错，不放行、不静默。
 */
export function createTierGuardedModelPort(
  models: ProviderDoctorModelPort,
  tier: ProviderDoctorTier,
  onBlocked: () => void,
): ProviderDoctorModelPort {
  if (tier !== "offline") return models;
  return {
    createModel(input) {
      onBlocked();
      throw new Error(
        `provider doctor offline 档禁止网络请求（模型客户端构造被拦截: ${input.providerId}/${input.modelId}）`,
      );
    },
  };
}

/**
 * 对抗复核 F7：offline 档对 DNS 出口的第二道强制。#7 出口校验只在 catalog+ 档运行，
 * 正常 offline 流程不会调 dnsLookup；若接线或检查点演化后触到它，这里拦截并计数，
 * 而不是放一次真实解析出去。
 */
export function createTierGuardedDnsLookup(
  tier: ProviderDoctorTier,
  onBlocked: () => void,
): DnsLookup | undefined {
  if (tier !== "offline") return undefined;
  return async () => {
    onBlocked();
    throw new Error("provider doctor offline 档禁止网络请求（DNS 解析被拦截）");
  };
}

function selectTargetProviders(
  snapshot: ProviderDoctorRegistrySnapshot,
  providerId: string | undefined,
): readonly ProviderDoctorProviderFacts[] {
  const requested = providerId?.trim();
  if (!requested || requested === "*") return snapshot.providers;
  const matched = snapshot.providers.filter((provider) => provider.providerId === requested);
  if (matched.length === 0) {
    const known = snapshot.providers.map((provider) => provider.providerId).join(", ");
    throw new Error(
      `未知 provider: ${requested}${
        known ? `（可用: ${known}）` : "（Registry 快照里没有任何 provider）"
      }`,
    );
  }
  return matched;
}

async function loadSnapshot(
  input: ProviderDoctorRunInput,
  logger?: Logger,
): Promise<ProviderDoctorRegistrySnapshot> {
  const local = await input.registry.loadLocalSnapshot();
  if (input.tier === "offline" || !input.registry.refreshSnapshot) return local;
  try {
    return await input.registry.refreshSnapshot();
  } catch (error) {
    // 刷新失败退回本地快照：诊断要回答「现在能不能用」，而不是被 CDN 抖动挡在门外。
    logger?.warn("provider doctor 配置源刷新失败，使用本地快照", { error: describeError(error) });
    return local;
  }
}

async function safeReadLedger(
  ledger: ProviderDoctorLedgerPort,
  logger?: Logger,
): Promise<{ events: readonly ProviderDoctorLedgerEvent[]; corruptLines: number }> {
  try {
    return await ledger.read();
  } catch (error) {
    logger?.warn("provider doctor 覆盖账本读取失败", { error: describeError(error) });
    return { events: [], corruptLines: 0 };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
