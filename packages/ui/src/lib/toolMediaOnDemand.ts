// U11：工具图片的**按需读取**纯逻辑（spec: packages/ui/specs/tool-media-on-demand.md）。
//
// 本文件不含 React、不含 DOM——所有决策与字节缓存生命周期都做成可注入副作用的纯函数/工厂，
// 于是能在无 jsdom 的环境下用「计数 fetcher」证明：字节只在图片可见或预览打开时读取一次、
// 重复预览复用缓存、reconnect（generation 变化）后重新授权、切换会话/关闭预览时旧结果不污染
// 新视图且 objectURL 被释放（proposal U11-A2/A5、§5.5 授权门槛）。
//
// 安全边界（与 gateway 的 tool-media-authorization 对偶）：
// - renderer 只**请求**读取，授权判定永远在 gateway。这里的 sessionId 从 ref 自身的
//   `acode-artifact://<encodeURIComponent(sessionId)>/…` authority 还原，仅用于把请求路由到
//    owning session；gateway 会独立核验该 ref 是否在当前 session 的权威 toolCall display 里，
//   形态非法/跨 session 一律拒绝（fail-closed）。renderer 自报的 mime/bytes **不**参与授权。
// - workspaceIdentity/remoteSessionId 由既有 workspace-bound transport 贯穿（见 V4ConversationContext
//   的 attachmentRead），本文件不手写任何 identity key。
import {
  TOOL_MEDIA_REF_SCHEME,
  inspectToolMediaRef,
  isToolMediaRefImage,
  type ToolMediaImage,
} from "@acode/shared/acode-protocol-v4";

/** renderer 侧一次工具媒体读取请求（sessionId 由 ref 还原，交 gateway 授权）。 */
export interface ToolMediaRequest {
  sessionId: string;
  ref: string;
}

/**
 * 读取结果：解码后的字节 + 权威 mime（gateway 返回，不是 renderer 自报）。
 * 出现在 `ToolMediaLoaderDeps.fetchBytes` / `ToolMediaLoader.load` 的导出签名里，声明生成要求它可导出。
 * @lintignore
 */
export interface ToolMediaBytes {
  bytes: Uint8Array;
  mediaType: string;
}

/** 缓存键的段分隔符（NUL 不可能出现在 sessionId/ref 里，故是可证明的隔离）。 */
const CACHE_KEY_SEP = "\0";

/**
 * 从 ref 的 authority 段还原 owning sessionId。fail-closed：形态非法或 authority 解不出返回 null。
 *
 * 这不是授权——只是把读取请求路由到正确的 session。真正的授权在 gateway：它核验
 * `ref.authority === encodeURIComponent(sessionId)` 且该 ref 出现在该 session 的权威工具产物里。
 */
export function decodeToolMediaSessionId(ref: unknown): string | null {
  if (inspectToolMediaRef(ref) !== null) return null;
  const value = ref as string;
  const authorityEnd = value.indexOf("/", TOOL_MEDIA_REF_SCHEME.length);
  const authority = value.slice(TOOL_MEDIA_REF_SCHEME.length, authorityEnd);
  try {
    const sessionId = decodeURIComponent(authority);
    return sessionId.length > 0 ? sessionId : null;
  } catch {
    // authority 不是合法 percent-encoding（伪造/损坏）：拒绝，不猜。
    return null;
  }
}

/**
 * 图片形态：inline（字节已在 row）或 ref（需按需读取）。
 * 出现在 `shouldFetchToolMediaBytes` / `resolveToolMediaRenderState` 的导出签名里，声明生成要求它可导出。
 * @lintignore
 */
export type ToolMediaImageKind = "inline" | "ref";

/** inline 形态的 data URL（字节已在 row，直接可用）；ref 形态返回 null。 */
export function buildToolMediaInlineDataUrl(image: ToolMediaImage): string | null {
  if (isToolMediaRefImage(image)) return null;
  return `data:${image.mimeType};base64,${image.base64}`;
}

/**
 * 缓存键：包含 session + ref + generation（§5.5「cache key 包含 identity/session/ref 和授权版本，
 * 不能仅按文件名缓存」）。generation 是 reconnect/会话切换的授权代际——换代后旧键自然失效，
 * 一个 reconnect 前授权过的字节不会被 reconnect 后误当作已授权复用。
 * workspaceIdentity 由 transport 层绑定（同一 renderer 实例只服务一个 workspace scope），
 * 不进这里的键；sessionId 已是 identity 隔离的会话级键。
 */
export function toolMediaCacheKey(request: ToolMediaRequest, generation: number): string {
  return `${request.sessionId}${CACHE_KEY_SEP}${request.ref}${CACHE_KEY_SEP}${generation}`;
}

/**
 * 「现在该不该发起字节读取」的纯决策——U11 的核心节流点。
 *
 * 只有 ref 形态、尚无字节、且（图片进入视口 ∨ 预览打开）三者同时成立才读取。inline 形态永不
 * 触发读取（字节已在 row）。这条判据让「fetch happens 0 times until the image is requested」可被
 * 计数 fetcher 断言。
 */
export function shouldFetchToolMediaBytes(params: {
  kind: ToolMediaImageKind;
  hasBytes: boolean;
  visible: boolean;
  previewOpen: boolean;
  /** 已进入终态错误（不再自动重试，只等用户显式 retry）。 */
  errored: boolean;
}): boolean {
  if (params.kind !== "ref") return false;
  if (params.hasBytes) return false;
  if (params.errored) return false;
  return params.visible || params.previewOpen;
}

/** renderer 的展示态（降级不崩溃、不静默空白）。 */
export type ToolMediaRenderState = "inline" | "idle" | "loading" | "ready" | "error";

/**
 * 由读取生命周期推导 renderer 展示态（纯函数）。
 * - inline：字节已在 row，直接渲染；
 * - idle：ref 形态但尚未进入视口/未打开预览（轻量占位，不读字节）；
 * - loading：已发起读取；
 * - ready：字节就绪；
 * - error：读取/授权失败——终态，展示降级 + 允许显式 retry（不自动无限重试）。
 */
export function resolveToolMediaRenderState(params: {
  kind: ToolMediaImageKind;
  requested: boolean;
  loading: boolean;
  hasBytes: boolean;
  error: boolean;
}): ToolMediaRenderState {
  if (params.kind === "inline") return "inline";
  if (params.error) return "error";
  if (params.hasBytes) return "ready";
  if (params.loading) return "loading";
  return params.requested ? "loading" : "idle";
}

/**
 * 可注入的副作用面（无 DOM 环境下用桩替换）。
 * `createToolMediaLoader` 的入参类型，声明生成要求它可导出。
 * @lintignore
 */
export interface ToolMediaLoaderDeps {
  /** 实际读取字节（生产里 = V4ConversationContext.attachmentRead 的 ref-only 路径）。 */
  fetchBytes(request: ToolMediaRequest, signal?: AbortSignal): Promise<ToolMediaBytes>;
  /** Blob → object URL；无 createObjectURL 的环境（测试/SSR）返回 null。 */
  createObjectUrl?(bytes: Uint8Array, mediaType: string): string | null;
  /** 释放 object URL。 */
  revokeObjectUrl?(url: string): void;
  /** 缓存条目上限（预览 + 缩略图合计计数）。默认一个保守值，§5.5 的精确预算需 fixture 校准后另立。 */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 24;

interface CacheEntry {
  generation: number;
  bytes: Uint8Array;
  mediaType: string;
  objectUrl: string | null;
  accessedAt: number;
}

/**
 * 工具媒体字节的有界缓存 + in-flight 去重 + generation 失效。
 *
 * 唯一所有者（proposal §5.2「UI 媒体读取 hook 唯一拥有 byte-bounded Blob 缓存与 URL 生命周期」）：
 * 正文 store 只持 metadata（ref/mime/bytes），字节与 objectURL 只活在这里。
 *
 * - **去重**：同一 (session, ref, generation) 并发请求共享同一个 in-flight promise，不重复读。
 * - **generation**：reconnect / 会话切换调用 `bumpGeneration()`——旧代际的 in-flight 结果被丢弃、
 *   旧缓存条目失效并 revoke 其 objectURL，于是「读到一半切换会话」不会污染新视图（A5）。
 * - **URL 生命周期**：dispose / 逐出 / 换代都 revoke objectURL，不泄漏。
 * - **错误终态**：fetch 失败从缓存删除条目（不负缓存钉死），调用方据 reject 进入 error 终态。
 */
export interface ToolMediaLoader {
  /** 发起（或复用）一次读取；返回 objectURL（可能为 null，环境无 createObjectURL 时）。 */
  load(
    request: ToolMediaRequest,
    signal?: AbortSignal,
  ): Promise<{ objectUrl: string | null; mediaType: string }>;
  /** reconnect / 会话切换：递增授权代际，失效旧缓存与 in-flight。 */
  bumpGeneration(): void;
  /** 当前 generation（缓存键的一部分）。 */
  generation(): number;
  /** 已缓存条目数与是否命中（测试/诊断用）。 */
  stats(): { entries: number; generation: number };
  /** 释放全部 objectURL 并清缓存（宿主卸载时）。 */
  dispose(): void;
}

export function createToolMediaLoader(deps: ToolMediaLoaderDeps): ToolMediaLoader {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ToolMediaBytes>>();
  let generation = 0;
  let clock = 0;

  function revoke(entry: CacheEntry | undefined): void {
    if (entry?.objectUrl) deps.revokeObjectUrl?.(entry.objectUrl);
  }

  function evictIfNeeded(): void {
    if (cache.size <= maxEntries) return;
    // 最旧访问先逐（LRU by accessedAt）；逐出即 revoke，不泄漏 URL。
    const ordered = [...cache.entries()].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
    while (cache.size > maxEntries && ordered.length > 0) {
      const [key, entry] = ordered.shift()!;
      revoke(entry);
      cache.delete(key);
    }
  }

  return {
    load(request, signal) {
      const currentGeneration = generation;
      const key = toolMediaCacheKey(request, currentGeneration);
      const cached = cache.get(key);
      if (cached) {
        cached.accessedAt = ++clock;
        return Promise.resolve({ objectUrl: cached.objectUrl, mediaType: cached.mediaType });
      }
      const existing = inflight.get(key);
      if (existing) {
        // 并发请求复用同一次读取（去重）；仍按当前缓存回读 objectUrl。
        return existing.then((result) => ({
          objectUrl: cache.get(key)?.objectUrl ?? null,
          mediaType: result.mediaType,
        }));
      }
      const flight = deps
        .fetchBytes(request, signal)
        .then((result) => {
          inflight.delete(key);
          // 读取期间发生换代/切换：丢弃结果，不写进新代际缓存（旧结果不污染新视图，A5）。
          if (generation !== currentGeneration) {
            return result;
          }
          const objectUrl = deps.createObjectUrl?.(result.bytes, result.mediaType) ?? null;
          cache.set(key, {
            generation: currentGeneration,
            bytes: result.bytes,
            mediaType: result.mediaType,
            objectUrl,
            accessedAt: ++clock,
          });
          evictIfNeeded();
          return result;
        })
        .catch((error) => {
          // 错误终态：删掉 in-flight，不负缓存钉死（下次显式 retry 可重读）。
          inflight.delete(key);
          throw error;
        });
      inflight.set(key, flight);
      return flight.then((result) => ({
        objectUrl: cache.get(key)?.objectUrl ?? null,
        mediaType: result.mediaType,
      }));
    },
    bumpGeneration() {
      generation += 1;
      // 旧代际的所有 objectURL 立即释放；缓存清空（reconnect 后按需重新授权读取）。
      for (const entry of cache.values()) revoke(entry);
      cache.clear();
      inflight.clear();
    },
    generation() {
      return generation;
    },
    stats() {
      return { entries: cache.size, generation };
    },
    dispose() {
      for (const entry of cache.values()) revoke(entry);
      cache.clear();
      inflight.clear();
    },
  };
}
