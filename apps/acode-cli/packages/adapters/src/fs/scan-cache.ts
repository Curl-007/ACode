// Mechanism ported from oh-my-pi (MIT) crates/pi-walker — 语义参照，Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 目录项扫描缓存（specs/fs-hotpath-mechanisms.md R1）
//
// 存「目录项列表」（文件绝对路径数组）而非最终工具结果：glob/grep 的高层
// 过滤、排序与限额全部留在调用方。键 = root + 规范化遍历选项（respectGitignore）。
// 语义照抄 omp cache.rs：TTL 1000ms / 16 条 / 64MiB 字节预算（按内容实际计量）/
// 按 createdAt 最老先淘汰 / generation 计数阻止在途扫描回填 / 前缀失效顺手清理
// TTL 过期项 / 空结果重检（年龄 ≥200ms）由调用方消费 cacheAgeMs 实现。
// ============================================================

import { isAbsolute, normalize, sep } from "node:path";

export interface ScanCacheKnobs {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  /** 空结果重检的最低缓存年龄；0 = 禁用重检。 */
  readonly emptyRecheckMs: number;
}

const DEFAULT_TTL_MS = 1_000;
const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_EMPTY_RECHECK_MS = 200;

/** 每个缓存路径项的固定对象头开销（字符串 wrapper + 数组槽位近似值）。 */
const PER_ENTRY_FIXED_BYTES = 64;

function envUint(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function loadKnobs(): ScanCacheKnobs {
  return {
    ttlMs: envUint("FS_SCAN_CACHE_TTL_MS", DEFAULT_TTL_MS),
    maxEntries: envUint("FS_SCAN_CACHE_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    maxBytes: envUint("FS_SCAN_CACHE_MAX_BYTES", DEFAULT_MAX_BYTES),
    emptyRecheckMs: envUint("FS_SCAN_EMPTY_RECHECK_MS", DEFAULT_EMPTY_RECHECK_MS),
  };
}

export interface DirectoryScanResult {
  /** root 下的文件绝对路径列表（扫描层已剪枝 VCS/gitignore）。 */
  files: string[];
  /** 0 = 新鲜扫描；>0 = 命中缓存的条目年龄（毫秒）。 */
  cacheAgeMs: number;
}

interface CacheEntry {
  createdAt: number;
  files: string[];
  bytes: number;
}

interface CacheKey {
  root: string;
  respectGitignore: boolean;
}

/** 供测试注入时钟，生产恒为 Date.now。 */
export type ScanClock = () => number;

export class FsScanCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private generation = 0;
  private readonly knobs: ScanCacheKnobs;
  private readonly now: ScanClock;
  /** 同键在途扫描去重：并发调用共享同一次遍历。 */
  private readonly inFlight = new Map<string, Promise<DirectoryScanResult>>();

  constructor(options: { knobs?: ScanCacheKnobs; now?: ScanClock } = {}) {
    this.knobs = options.knobs ?? loadKnobs();
    this.now = options.now ?? Date.now;
  }

  get emptyRecheckMs(): number {
    return this.knobs.emptyRecheckMs;
  }

  /** 上限任一为 0 → 缓存完全旁路（同 omp）。 */
  private get bypassed(): boolean {
    return this.knobs.ttlMs === 0 || this.knobs.maxEntries === 0 || this.knobs.maxBytes === 0;
  }

  private static key(key: CacheKey): string {
    return `${normalizeCacheRoot(key.root)}\u0000${key.respectGitignore ? "gi" : "raw"}`;
  }

  private expireExpired(now: number): void {
    for (const [cacheKey, entry] of this.entries) {
      if (now - entry.createdAt >= this.knobs.ttlMs) {
        this.bytes -= entry.bytes;
        this.entries.delete(cacheKey);
      }
    }
  }

  get(key: CacheKey): DirectoryScanResult | undefined {
    if (this.bypassed) return undefined;
    const now = this.now();
    this.expireExpired(now);
    const entry = this.entries.get(FsScanCache.key(key));
    if (!entry) return undefined;
    return { files: entry.files, cacheAgeMs: Math.max(0, now - entry.createdAt) };
  }

  /**
   * 扫描完成后的回填。generation 不匹配（扫描期间发生过失效）、扫描耗时已超
   * TTL、单次扫描超预算、同键已有更新条目——全部拒收（同 omp insert 的守卫集）。
   * created_at 取扫描开始时刻（omp 同款）：年龄反映快照新旧，而非回填时刻。
   */
  insert(
    key: CacheKey,
    files: string[],
    generationAtScanStart: number,
    scanStartedAt: number,
  ): void {
    if (this.bypassed) return;
    const now = this.now();
    this.expireExpired(now);
    if (generationAtScanStart !== this.generation) return;
    if (now - scanStartedAt >= this.knobs.ttlMs) return;
    const bytes = measureEntriesBytes(files);
    if (bytes > this.knobs.maxBytes) return;
    const cacheKey = FsScanCache.key(key);
    const existing = this.entries.get(cacheKey);
    if (existing && existing.createdAt >= scanStartedAt) return;
    if (existing) {
      this.bytes -= existing.bytes;
      this.entries.delete(cacheKey);
    }
    while (
      this.entries.size >= this.knobs.maxEntries ||
      (this.entries.size > 0 && this.bytes + bytes > this.knobs.maxBytes)
    ) {
      const oldestKey = this.oldestEntryKey();
      if (oldestKey === undefined) break;
      this.removeEntry(oldestKey);
    }
    this.bytes += bytes;
    this.entries.set(cacheKey, { createdAt: scanStartedAt, files, bytes });
  }

  /** 失效 root 是 target 祖先的缓存项 + 顺手清理全部 TTL 过期项（同 omp invalidate）。 */
  invalidatePath(target: string): void {
    this.generation += 1;
    const now = this.now();
    const normalizedTarget = normalizeCacheRoot(target);
    for (const [cacheKey, entry] of this.entries) {
      const expired = now - entry.createdAt >= this.knobs.ttlMs;
      const coversTarget = isPathUnderRoot(cacheRootFromCacheKey(cacheKey), normalizedTarget);
      if (expired || coversTarget) {
        this.bytes -= entry.bytes;
        this.entries.delete(cacheKey);
      }
    }
  }

  invalidateAll(): void {
    this.generation += 1;
    this.bytes = 0;
    this.entries.clear();
  }

  /** 仅供测试观察。 */
  debugSize(): { count: number; bytes: number; generation: number } {
    return { count: this.entries.size, bytes: this.bytes, generation: this.generation };
  }

  private removeEntry(cacheKey: string): void {
    const entry = this.entries.get(cacheKey);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(cacheKey);
  }

  private oldestEntryKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [cacheKey, entry] of this.entries) {
      if (entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt;
        oldestKey = cacheKey;
      }
    }
    return oldestKey;
  }

  /** miss → 发起（或复用在途）扫描；成功后按 generation 守卫回填。 */
  async getOrScan(key: CacheKey, scan: () => Promise<string[]>): Promise<DirectoryScanResult> {
    const cached = this.get(key);
    if (cached) return cached;
    if (this.bypassed) {
      const files = await scan();
      return { files, cacheAgeMs: 0 };
    }

    const generationAtScanStart = this.generation;
    const scanStartedAt = this.now();
    const cacheKey = FsScanCache.key(key);
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const pending = (async (): Promise<DirectoryScanResult> => {
      const files = await scan();
      this.insert(key, files, generationAtScanStart, scanStartedAt);
      return { files, cacheAgeMs: 0 };
    })().finally(() => {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }
}

/** 路径字节计量：内容实际长度 + 固定对象头（同 omp entry_bytes 的内容计量原则）。 */
function measureEntriesBytes(files: string[]): number {
  let bytes = 0;
  for (const file of files) {
    bytes += file.length * 2 + PER_ENTRY_FIXED_BYTES;
  }
  return bytes;
}

function normalizeCacheRoot(root: string): string {
  if (!isAbsolute(root)) return root;
  const normalized = normalize(root);
  // win32 路径大小写不敏感：比较统一小写折叠；posix 保留大小写。
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function cacheRootFromCacheKey(cacheKey: string): string {
  const separatorIndex = cacheKey.lastIndexOf("\u0000");
  return cacheKey.slice(0, separatorIndex);
}

/** root 是否是 target 或其祖先目录（前缀语义，组件边界对齐）。 */
function isPathUnderRoot(root: string, target: string): boolean {
  if (root === target) return true;
  // normalize 在 Windows 产出反斜杠路径，前缀补齐必须用平台分隔符。
  const prefix = root.endsWith("/") || root.endsWith("\\") ? root : root + sep;
  return target.startsWith(prefix);
}

// ============================================================
// 进程级单例与公开失效入口（对应 omp invalidateFsScanCache）
// ============================================================

const sharedCache = new FsScanCache();

export function getSharedFsScanCache(): FsScanCache {
  return sharedCache;
}

/** 写/删/改名后按路径前缀失效；不传 path 时清空全部。 */
export function invalidateFsScanCache(path?: string): void {
  if (path === undefined) {
    sharedCache.invalidateAll();
    return;
  }
  sharedCache.invalidatePath(path);
}

/** 空结果重检判定：命中缓存、年龄达标、重检未被禁用。 */
export function shouldRecheckEmptyResult(cacheAgeMs: number): boolean {
  const threshold = sharedCache.emptyRecheckMs;
  if (threshold === 0) return false;
  return cacheAgeMs >= threshold;
}
