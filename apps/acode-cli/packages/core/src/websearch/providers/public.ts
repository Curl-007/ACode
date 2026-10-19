// Ported from oh-my-pi (MIT) — packages/coding-agent/src/web/search/providers/public.ts
// Copyright (c) 2025 Mario Zechner & Stencil Labs
// 免凭据引擎的聚合扇出：并行打全部抓取引擎，URL 去重后按跨引擎共识（命中引擎数）
// → 单引擎最佳名次 → 插入序排序。Bun.sleep/Promise.withResolvers 降解为 node 等价。

import type { SearchProviderId, SearchResponse, SearchSource } from "../types.js";
import { SearchProviderError } from "../types.js";
import { markEngineModuleLoaded } from "../loaded-engines.js";
import { clampNumResults, withHardTimeout } from "../provider-utils.js";
import type { SearchParams } from "./base.js";
import { SearchProvider } from "./base.js";

markEngineModuleLoaded("public");

/** 扇出目标：免凭据引擎。顺序是合并排序的 tiebreak（早引擎赢共识/名次平局）。 */
const PUBLIC_ENGINE_IDS: readonly SearchProviderId[] = ["startpage", "google", "duckduckgo", "ecosia", "mojeek"];

/** 聚合比单引擎窗口宽：共识需要广度。 */
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/**
 * 扇出软截止：过了这点至少有一个引擎结果就尽快返回。快 HTML 引擎远低于此值；
 * 慢引擎算 bonus 覆盖而非延迟下限。
 */
const SOFT_DEADLINE_MS = 5_000;

/** 硬截止：到点无论如何返回， pathological 慢引擎不能拖住整次工具调用。 */
const HARD_DEADLINE_MS = 30_000;

export interface PublicWebDeadlines {
  softMs?: number;
  hardMs?: number;
}

/** 跨引擎去重 URL 的累加器。 */
interface MergedSource {
  source: SearchSource;
  /** 命中该 URL 的引擎数——主排序信号。 */
  engines: number;
  /** 观测到的最佳（最小）单引擎名次。 */
  bestRank: number;
  /** 首见插入序；最终平局保证确定性。 */
  order: number;
}

/** URL 规范去重键：host 去 www、path 去尾斜杠、保留 query、丢 fragment。 */
function dedupKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${host}${path}${url.search}`;
  } catch {
    return rawUrl;
  }
}

/** 把一个引擎的名次列表合并进累加器。 */
function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
  for (const [rank, source] of sources.entries()) {
    const key = dedupKey(source.url);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
      continue;
    }
    existing.engines += 1;
    if (rank < existing.bestRank) {
      existing.bestRank = rank;
      existing.source.title = source.title;
      existing.source.url = source.url;
    }
    // 无论哪个引擎名次最好，保留信息量最大的摘录。
    if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
      existing.source.snippet = source.snippet;
    }
    existing.source.publishedDate ??= source.publishedDate;
    existing.source.ageSeconds ??= source.ageSeconds;
  }
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * 并行搜索全部免凭据引擎并合并：URL 跨引擎去重，按跨引擎共识→最佳单引擎名次排序。
 * 三个出口取最早：全部落定；软截止到点且已有成功；硬截止到点。软截止先于首个成功
 * 触发时聚合继续等（至硬上限），慢引擎退化为更少覆盖而非空答案。胜负已分后中止
 * 迟到者。单引擎失败（bot 墙、超时）容忍；仅当全部引擎失败才抛。
 */
export async function searchPublicWeb(params: SearchParams, deadlines: PublicWebDeadlines = {}): Promise<SearchResponse> {
  const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
  const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
  const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  // provider 静态注册表构造本类；反向边延迟到搜索时打开，避免在 import TDZ 里观察注册表。
  const { getSearchProvider, formatSearchProviderFailures } = await import("../registry.js");

  const straggler = new AbortController();
  const signal = AbortSignal.any([withHardTimeout(params.signal, params.timeoutMs), straggler.signal]);

  // oxlint-disable-next-line unicorn/no-new-array -- 按引擎序预分配槽位，omp 同款。
  const responses: (SearchResponse | undefined)[] = new Array(PUBLIC_ENGINE_IDS.length);
  const failures: { provider: { id: string; label: string }; error: unknown }[] = [];
  const all = Promise.all(
    PUBLIC_ENGINE_IDS.map(async (id, index) => {
      try {
        const provider = await getSearchProvider(id);
        responses[index] = await provider.search({ ...params, signal });
      } catch (error) {
        failures.push({ provider: { id, label: id }, error });
      }
    }),
  );

  // 三个出口取最早（omp 同款）：全落定 / 软截止 / 硬截止。
  const softRace = await Promise.race([all.then(() => "done" as const), sleepMs(softMs).then(() => "soft" as const)]);
  if (softRace === "soft" && !responses.some(response => response !== undefined) && failures.length < PUBLIC_ENGINE_IDS.length) {
    await Promise.race([all, sleepMs(Math.max(0, hardMs - softMs)).then(() => "hard" as const)]);
  }
  straggler.abort();

  // 按引擎优先序（非落定序）合并，排名 tiebreak 保持确定。
  const merged = new Map<string, MergedSource>();
  for (const response of responses) {
    if (response) mergeSources(merged, response.sources);
  }

  if (merged.size === 0 && failures.length === PUBLIC_ENGINE_IDS.length) {
    throw new SearchProviderError("public", `All public engines failed: ${formatSearchProviderFailures(failures)}`, 503);
  }

  const sources = [...merged.values()]
    .sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
    .slice(0, numResults)
    .map(entry => entry.source);

  return { provider: "public", sources };
}

/**
 * 全部免凭据引擎上的聚合元引擎。显式点名专属：自动链可直接选中单个引擎，
 * 扇出五个抓取引擎是刻意选择而非隐式回退（omp 同款 isAvailable=false）。
 */
export class PublicWebProvider extends SearchProvider {
  readonly id = "public" as const;
  readonly label = "Public Web";

  isAvailable(): boolean {
    return false;
  }

  override isExplicitlyAvailable(): boolean {
    return true;
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return searchPublicWeb(params);
  }
}
