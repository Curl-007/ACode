// ============================================================
// WebFetch URL provenance gate
// (specs/error-taxonomy-injection-defense.md R5)
// ============================================================
//
// 只允许抓取「本会话内模型确实见过」的 URL：真实用户消息、WebSearch 结果、
// 既往 WebFetch 的输入/结果里出现过的 URL。与 webfetch-preapproved.ts 的预批
// 名单合并为允许集（预批面原样保留，是溯源集之外的独立放行面）。
//
// 防御目标：被注入的模型不能抓任意未见过的 URL（数据外传 / 打点 / 拉取第二
// 阶段指令）。assistant 文本与其他工具（Bash/Read 等）输出**不入集**——否则
// 模型复述一遍被注入的 URL 即可自我授权，闸门失效。
//
// fail 语义：sessionStore 在场而未溯源 → 拒绝（handler 抛
// webfetch_unprovenanced_url，成为 error tool result，文案含「写进结论、不要
// 循环重试」指引）；sessionStore 缺席（测试桩/旧宿主）→ 跳过闸门（既有行为
// 不变）。已知保守边界（闸门位于 permission ask 之后）登记在 spec 分批项。

import type { MessageWithParts, SessionId, SessionStorePort } from "@acode/contracts";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

/** WebSearch 的两个注册名（handlers/websearch.ts 的本地常量，此处按名匹配）。 */
const WEBSEARCH_TOOL_NAMES = new Set(["WebSearch", "web_search"]);

/** http(s) URL 提取：到空白/常见定界符为止；尾部标点随后剥掉。 */
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]},;]+/gi;

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)+\]}]+$/;

// 有界账本：进程内 per-session LRU。上限防长会话/多会话把内存吃穿；
// 被逐出的 URL 仍可由历史扫描找回（扫描是账本 miss 时的兜底，不是替代）。
const MAX_SESSIONS = 64;
const MAX_URLS_PER_SESSION = 512;
/** 单次历史扫描的消息上限（从最新往回数）；WebFetch 频率低，成本可控。 */
const MAX_SCANNED_MESSAGES = 400;

const provenanceLedgers = new Map<string, Set<string>>();

/**
 * URL 归一化：http→https、host 小写、去 fragment。query 保留——查询串正是
 * 外传通道，必须精确匹配；尾部斜杠不折叠（/docs 与 /docs/ 是不同资源）。
 */
export function normalizeProvenanceUrl(value: string | URL): string | undefined {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.protocol === "http:") url.protocol = "https:";
  url.hash = "";
  // URL 序列化已含 host 小写化；username/password 不参与溯源比较（handler 层已拒凭据 URL）。
  return url.toString();
}

/** 从自由文本提取归一化后的 http(s) URL 集。 */
export function extractHttpUrls(text: string): Set<string> {
  const urls = new Set<string>();
  for (const match of text.match(HTTP_URL_PATTERN) ?? []) {
    const trimmed = match.replace(TRAILING_PUNCTUATION_PATTERN, "");
    const normalized = normalizeProvenanceUrl(trimmed);
    if (normalized) urls.add(normalized);
  }
  return urls;
}

/** 即时记账（handler 在闸门放行与产出重定向/结果时调用）。 */
export function noteWebFetchProvenanceUrls(
  sessionId: SessionId | string,
  urls: Iterable<string | URL>,
): void {
  const ledger = acquireLedger(String(sessionId));
  for (const value of urls) {
    const normalized = normalizeProvenanceUrl(value);
    if (!normalized) continue;
    if (ledger.size >= MAX_URLS_PER_SESSION && !ledger.has(normalized)) {
      // 有界插入：淘汰最早记账的 URL（Set 迭代序 = 插入序）。
      const oldest = ledger.values().next().value;
      if (oldest !== undefined) ledger.delete(oldest);
    }
    ledger.add(normalized);
  }
}

export function isWebFetchUrlInProvenanceLedger(
  sessionId: SessionId | string,
  url: string | URL,
): boolean {
  const normalized = normalizeProvenanceUrl(url);
  if (!normalized) return false;
  const ledger = provenanceLedgers.get(String(sessionId));
  if (!ledger?.has(normalized)) return false;
  // LRU touch：命中即刷新会话新近度。
  provenanceLedgers.delete(String(sessionId));
  provenanceLedgers.set(String(sessionId), ledger);
  return true;
}

/**
 * 闸门判定：账本命中 → 放行；否则扫描会话历史（真实用户消息 / WebSearch 结果 /
 * 既往 WebFetch 输入与结果）并回填账本。sessionStore 缺席 → 跳过闸门（fail-open，
 * 既有测试桩/旧宿主行为不变；生产链路 executor 恒接线 sessionStore）。
 */
export async function resolveWebFetchProvenance(input: {
  sessionId: SessionId;
  sessionStore?: SessionStorePort;
  url: string | URL;
}): Promise<{ checked: boolean; provenanced: boolean }> {
  const normalized = normalizeProvenanceUrl(input.url);
  // 归一化失败交给 handler 的既有 URL 校验路径报错，闸门不抢语义。
  if (!normalized) return { checked: false, provenanced: true };
  if (isWebFetchUrlInProvenanceLedger(input.sessionId, normalized)) {
    return { checked: true, provenanced: true };
  }
  if (!input.sessionStore) {
    return { checked: false, provenanced: true };
  }

  let messages: MessageWithParts[];
  try {
    messages = await input.sessionStore.messages({ sessionID: input.sessionId });
  } catch {
    // 历史不可读时不阻断既有抓取语义（闸门是纵深防御层，permission ask 仍在）。
    return { checked: false, provenanced: true };
  }

  const scanned = extractProvenanceUrlsFromMessages(
    messages.slice(Math.max(0, messages.length - MAX_SCANNED_MESSAGES)),
  );
  noteWebFetchProvenanceUrls(input.sessionId, scanned);
  return { checked: true, provenanced: scanned.has(normalized) };
}

/**
 * 历史扫描的入集规则（R5）：
 * - `role=user` 且非 synthetic 的 text part（synthetic notice 是 harness 再注入的
 *   模型产出——后台通知/子代理回流，不算用户来源）；
 * - WebSearch / web_search 已完成调用的结果文本；
 * - WebFetch 已完成调用的输入 URL 与结果文本（finalUrl、重定向目标、结果引用链接）。
 * 其余一律不入集：assistant 文本、其他工具输出、失败调用的输入（被闸门拦下的
 * URL 不能借 error state 的 input 自我授权）。
 */
export function extractProvenanceUrlsFromMessages(
  messages: readonly MessageWithParts[],
): Set<string> {
  const urls = new Set<string>();
  for (const entry of messages) {
    if (entry.info.role === "user") {
      for (const part of entry.parts) {
        if (part.type !== "text" || part.synthetic === true) continue;
        for (const url of extractHttpUrls(part.text)) urls.add(url);
      }
      continue;
    }
    for (const part of entry.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      if (part.tool === WEBFETCH_TOOL_NAME) {
        const inputUrl = part.state.input?.url;
        if (typeof inputUrl === "string") {
          const normalized = normalizeProvenanceUrl(inputUrl);
          if (normalized) urls.add(normalized);
        }
        for (const url of extractHttpUrls(part.state.output)) urls.add(url);
        continue;
      }
      if (WEBSEARCH_TOOL_NAMES.has(part.tool)) {
        for (const url of extractHttpUrls(part.state.output)) urls.add(url);
      }
    }
  }
  return urls;
}

export function clearWebFetchProvenanceForTests(): void {
  provenanceLedgers.clear();
}

function acquireLedger(sessionKey: string): Set<string> {
  const existing = provenanceLedgers.get(sessionKey);
  if (existing) {
    // LRU touch + 会话数上限逐出（Map 迭代序 = 插入序，头部最旧）。
    provenanceLedgers.delete(sessionKey);
    provenanceLedgers.set(sessionKey, existing);
    return existing;
  }
  while (provenanceLedgers.size >= MAX_SESSIONS) {
    const oldest = provenanceLedgers.keys().next().value;
    if (oldest === undefined) break;
    provenanceLedgers.delete(oldest);
  }
  const ledger = new Set<string>();
  provenanceLedgers.set(sessionKey, ledger);
  return ledger;
}
