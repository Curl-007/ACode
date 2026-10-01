import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IACodeTaskService } from "@acode/services";
import type { ACodeTaskSnapshot } from "@acode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IACodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ACodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IACodeTaskService["getTaskSnapshotWithEtag"]>[0];

const acodeTaskServiceProxyCache = new WeakMap<IACodeTaskService, IACodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IACodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
// 内存快照条目带剪枝元数据（updatedAt/sizeBytes），与持久层条目共用同一预算纯函数。
type MemorySnapshotCacheEntry = {
  etag: string;
  snapshot: ACodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
const snapshotCacheByService = new WeakMap<
  IACodeTaskService,
  Map<string, MemorySnapshotCacheEntry>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "acode-task-snapshot-cache:v1";
export const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
export const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ACodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// 内存诊断计数器：WeakMap 无法枚举，记住最近一个
// service 的内存缓存（renderer 内实际只有一个 task service 实例）。
let latestSnapshotCache: Map<string, MemorySnapshotCacheEntry> | undefined;
let memorySnapshotEvictionCount = 0;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  bytes:
    latestSnapshotCache === undefined
      ? 0
      : [...latestSnapshotCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0),
  persisted: persistedSnapshotCache.size,
  evictions: memorySnapshotEvictionCount,
}));

/** 内存条目与持久层条目共有的剪枝字段；保证两层执行同一预算。 */
export interface PrunableSnapshotCacheEntry {
  updatedAt: number;
  sizeBytes: number;
}

// 内存快照 Map 原本无界（持久层已有 20 条/2MB 剪枝而内存层没有，防护不对称），
// 是 renderer 棘轮式内存增长源之一。这里把持久层剪枝预算抽成共享纯函数，
// 内存层每次写入后执行同参数剪枝（specs/renderer-memory-budget.md 规则 4）。
// 语义：按 updatedAt 新→旧保留；条数或字节超预算的条目跳过，但继续尝试更旧的更小条目。
export function selectRetainedSnapshotEntries<E extends PrunableSnapshotCacheEntry>(
  entries: E[],
): E[] {
  const sorted = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  const retained: E[] = [];
  let totalBytes = 0;
  for (const entry of sorted) {
    if (retained.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    retained.push(entry);
    totalBytes += entry.sizeBytes;
  }
  return retained;
}

function measureSnapshotBytes(snapshot: ACodeTaskSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

function pruneMemorySnapshotCache(snapshotCache: Map<string, MemorySnapshotCacheEntry>): void {
  const retained = new Set(selectRetainedSnapshotEntries([...snapshotCache.values()]));
  if (retained.size === snapshotCache.size) {
    return;
  }
  memorySnapshotEvictionCount += snapshotCache.size - retained.size;
  for (const [key, entry] of snapshotCache) {
    if (!retained.has(entry)) {
      snapshotCache.delete(key);
    }
  }
}

function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // desktop continuous 和手机 remote replayable 的 snapshot 可能经过不同恢复逻辑。
    // 缓存 key 必须区分 clientMode，否则会把某一端的快照复用到另一端。
    params.clientMode ?? "desktop-continuous",
    // 手机只读恢复会刻意跳过 task-index 模型回填。
    // 策略不同代表 host 端恢复语义不同，不能共用同一份 snapshot cache。
    params.resumeModelPolicy ?? "task-index",
    // 手机首屏恢复会用历史模型 hint 激活 session。
    // 同一 task 若模型 hint 不同，context window 也可能不同，缓存必须隔离。
    params.model ?? "",
    // replayable snapshot 现在会携带 session settings 投影出的 configOptions。
    // 同一模型下 thoughtLevel 不同也会改变 toolbar 配置和后续发送 hint，不能复用旧快照。
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: IACodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IACodeTaskService,
): Map<string, MemorySnapshotCacheEntry> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, MemorySnapshotCacheEntry>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  // 与内存层共用同一预算纯函数，保证两层剪枝参数永远一致。
  const retained = selectRetainedSnapshotEntries([...persistedSnapshotCache.values()]);
  persistedSnapshotCache.clear();
  for (const entry of retained) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string): PersistedSnapshotCacheEntry | null {
  ensurePersistedSnapshotCacheLoaded();
  return persistedSnapshotCache.get(key) ?? null;
}

function writePersistedSnapshotEntry(
  key: string,
  etag: string,
  snapshot: ACodeTaskSnapshot,
  sizeBytes: number,
): void {
  ensurePersistedSnapshotCacheLoaded();
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // 大消息 task 的快照若直接写 localStorage，会很快触发配额上限并拖慢主线程。
    // 这里只持久化小体积快照，超限时删除旧缓存，避免“为了加速加载反而造成存储压力”。
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

// 导出供测试驱动真实代理链路（fake service + getTaskSnapshot）。
export function createACodeTaskServiceProxy(service: IACodeTaskService): IACodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          // 命中持久层时提升到内存层；提升也是一次写入，同样执行预算剪枝。
          snapshotCache.set(requestKey, cachedSnapshotEntry);
          pruneMemorySnapshotCache(snapshotCache);
        }

        // 远控首屏恢复时，多个 hook 会并发请求同一 task snapshot，
        // 导致 host 连续执行多次 getTaskSnapshot，并把超大快照重复回传到 relay。
        // 这里按“同一 service + 同一参数”做并发去重，命中时复用同一个 Promise，
        // 保证同一时刻只发起一次 RPC；同时携带 if-none-match，未变化时复用本地缓存快照，
        // 避免重复下发大 JSON。
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // 仅持久化了 etag 但没有可用快照正文时，不能把 notModified 直接透传给上层，
            // 否则首屏会拿到空数据。这里回退一次“无 if-none-match”硬拉取，确保数据完整性优先。
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const snapshotSizeBytes = measureSnapshotBytes(fallbackResult.snapshot);
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
                updatedAt: Date.now(),
                sizeBytes: snapshotSizeBytes,
              };
              // 内存层与持久层同预算：每次写入后剪枝（specs/renderer-memory-budget.md 规则 4）。
              snapshotCache.set(requestKey, nextEntry);
              pruneMemorySnapshotCache(snapshotCache);
              writePersistedSnapshotEntry(
                requestKey,
                fallbackResult.etag,
                fallbackResult.snapshot,
                snapshotSizeBytes,
              );
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const snapshotSizeBytes = measureSnapshotBytes(firstResult.snapshot);
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
              updatedAt: Date.now(),
              sizeBytes: snapshotSizeBytes,
            };
            // 内存层与持久层同预算：每次写入后剪枝（specs/renderer-memory-budget.md 规则 4）。
            snapshotCache.set(requestKey, nextEntry);
            pruneMemorySnapshotCache(snapshotCache);
            writePersistedSnapshotEntry(
              requestKey,
              firstResult.etag,
              firstResult.snapshot,
              snapshotSizeBytes,
            );
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** 获取 ACode task wrapper 服务实例 */
export function useACodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IACodeTaskService {
  // ACode task 服务按 workspace 身份解析，保证所有 task RPC 都落到对应的 host。
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.acodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = acodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createACodeTaskServiceProxy(rawService);
  acodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
