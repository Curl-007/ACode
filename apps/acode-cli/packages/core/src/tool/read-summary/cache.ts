// 摘要解析结果缓存（specs/read-structural-summary.md R5）。
// 机制参照 oh-my-pi (MIT) read-summary.ts 的 per-session LRU memo,
// Copyright (c) 2025 Mario Zechner & Stencil Labs。
// ACode 形态：进程级 LRU（摘要器是纯函数，无会话态）；键 = 路径+内容哈希+
// 阈值参数。文件每次读取都新鲜，命中只复用确定性解析——无陈旧窗口。
// 解析失败/无可折叠声明 memo 为 null（不重复解析坏文件）。

import { createHash } from "node:crypto";

const CACHE_MAX_ENTRIES = 48;

export type CachedFold = import("./fold.js").FoldResult | null;

interface CacheEntry {
  key: string;
  value: CachedFold;
}

const entries: CacheEntry[] = [];
const byKey = new Map<string, CacheEntry>();

export function readSummaryCacheKey(
  filePath: string,
  content: string,
  configFingerprint: string,
): string {
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 16);
  return `${filePath}\u0000${hash}\u0000${configFingerprint}`;
}

export function getCachedFold(key: string): { hit: true; value: CachedFold } | { hit: false } {
  const entry = byKey.get(key);
  if (!entry) return { hit: false };
  // LRU touch：移到队尾。
  const index = entries.indexOf(entry);
  if (index >= 0) {
    entries.splice(index, 1);
    entries.push(entry);
  }
  return { hit: true, value: entry.value };
}

export function setCachedFold(key: string, value: CachedFold): void {
  const existing = byKey.get(key);
  if (existing) {
    existing.value = value;
    return;
  }
  const entry: CacheEntry = { key, value };
  byKey.set(key, entry);
  entries.push(entry);
  while (entries.length > CACHE_MAX_ENTRIES) {
    const evicted = entries.shift();
    if (evicted) byKey.delete(evicted.key);
  }
}

/** 测试隔离面。 */
export function clearReadSummaryCache(): void {
  entries.length = 0;
  byKey.clear();
}

/** 解析调用计数探针（测试断言缓存命中用）。 */
let parseCallCount = 0;
export function noteFoldParseCall(): void {
  parseCallCount += 1;
}
export function readFoldParseCallCount(): number {
  return parseCallCount;
}
