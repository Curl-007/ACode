// U11：工具图片 ref 形态的**按需字节读取** hook（spec: packages/ui/specs/tool-media-on-demand.md）。
//
// 唯一所有者（proposal §5.2）：byte-bounded Blob 缓存与 objectURL 生命周期只活在这里（经
// `lib/toolMediaOnDemand.createToolMediaLoader`）；正文 store 只持 metadata（ref/mime/bytes）。
// 无 JSX，故为 `.ts`（house 规则：只有含 JSX 的 hook 文件才用 .tsx）。
//
// 生命周期与安全：
// - **按需**：只有 `visible ∨ previewOpen` 且尚无字节时才 fetch（判据在 shouldFetchToolMediaBytes）；
//   未进视口的图片 fetch 0 次（U11-A1）。
// - **reconnect**：订阅 context 的 onRuntimeRestart，换代即 bumpGeneration——旧代际 objectURL
//   释放、缓存失效、in-flight 结果丢弃；重连后预览仍能解析（重新走 gateway 授权，U11-A2/A5）。
// - **fail-closed**：sessionId 从 ref authority 还原（decodeToolMediaSessionId），还原不出/无
//   context/读取失败都进 error 终态，展示降级而非崩溃或静默空白。
// - **identity**：workspaceIdentity/remoteSessionId 由 context 绑定的 workspace transport 贯穿，
//   本 hook 不手写任何 identity key。
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ToolMediaRefImage } from "@acode/shared/acode-protocol-v4";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import { logger } from "@/logger.js";
import {
  createToolMediaLoader,
  decodeToolMediaSessionId,
  resolveToolMediaRenderState,
  shouldFetchToolMediaBytes,
  type ToolMediaLoader,
  type ToolMediaRenderState,
} from "@/lib/toolMediaOnDemand.js";

/**
 * `useToolMediaRefBytes` 的返回类型，声明生成要求它可导出。
 * @lintignore
 */
export interface ToolMediaBytesState {
  state: ToolMediaRenderState;
  /** 就绪时的 object URL（可能为 null：环境无 createObjectURL，调用方据此降级）。 */
  objectUrl: string | null;
  /** 权威 mime（gateway 返回，不是 renderer 自报）；idle/loading 时为 null。 */
  mediaType: string | null;
  /** 显式重试（错误终态下由用户触发；不自动无限重试）。 */
  retry: () => void;
}

/** 把 createObjectURL 的存在性收敛成可注入依赖（无它的环境返回 null，走降级）。 */
function createObjectUrlSafe(bytes: Uint8Array, mediaType: string): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: mediaType }));
}

function revokeObjectUrlSafe(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

export function useToolMediaRefBytes(params: {
  image: ToolMediaRefImage;
  /** 图片是否进入视口（grid 用 IntersectionObserver 观测后传入）。 */
  visible: boolean;
  /** 预览是否打开（打开即强制读取，即便缩略图尚未进视口）。 */
  previewOpen: boolean;
}): ToolMediaBytesState {
  const { image, previewOpen, visible } = params;
  // 直接读 context（可能为 null：静态回放/转录完成卡没有会话上下文），不用会抛的 useV4Conversation。
  const ctx = useContext(V4ConversationContext);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [requested, setRequested] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  // loader 每组件实例一份：≤2 张图、有界条目，卸载即 dispose（revoke 全部 URL，不泄漏）。
  const loaderRef = useRef<ToolMediaLoader | null>(null);
  if (loaderRef.current === null) {
    loaderRef.current = createToolMediaLoader({
      // fetchBytes 在调用时读 ctxRef，永远拿到当前 provider 的读取面（provider 换代不失效）。
      fetchBytes: async (request, signal) => {
        const current = ctxRef.current;
        if (!current) throw new Error("toolMedia.noConversationContext");
        const result = await current.attachmentRead({
          sessionId: request.sessionId,
          ref: request.ref,
          ...(signal ? { signal } : {}),
        });
        // 工具图片恒为 image/*，attachmentRead 的 url 分支只对 desktop-local video 生效；
        // 真收到 url（不该发生）按降级处理，不静默把 url 当字节。
        if ("url" in result) throw new Error("toolMedia.unexpectedUrlResult");
        return { bytes: result.bytes, mediaType: result.mediaType };
      },
      createObjectUrl: createObjectUrlSafe,
      revokeObjectUrl: revokeObjectUrlSafe,
    });
  }

  // reconnect 换代：清缓存 + revoke URL，令后续读取重新授权。
  useEffect(() => {
    if (!ctx) return;
    return ctx.onRuntimeRestart(() => {
      loaderRef.current?.bumpGeneration();
      // 换代后当前实例若已就绪，退回 idle 让 effect 按新代际重新拉取。
      setObjectUrl(null);
      setMediaType(null);
      setError(false);
      setRequested(false);
    });
  }, [ctx]);

  // 卸载：释放 loader 持有的所有 objectURL。
  useEffect(() => {
    const loader = loaderRef.current;
    return () => loader?.dispose();
  }, []);

  const sessionId = decodeToolMediaSessionId(image.ref);
  const shouldFetch = shouldFetchToolMediaBytes({
    kind: "ref",
    hasBytes: objectUrl !== null || mediaType !== null,
    visible,
    previewOpen,
    errored: error,
  });

  useEffect(() => {
    if (!shouldFetch) return;
    // sessionId 还原不出（伪造/损坏 ref）或无 context → 直接 error 终态，不发请求。
    if (!sessionId || !ctxRef.current) {
      setError(true);
      return;
    }
    let alive = true;
    setRequested(true);
    setLoading(true);
    setError(false);
    const loader = loaderRef.current;
    if (!loader) return;
    loader
      .load({ sessionId, ref: image.ref })
      .then((result) => {
        if (!alive) return;
        // 换代后 objectUrl 可能为 null（in-flight 结果被丢弃）：不进 ready，等下一次请求。
        if (result.objectUrl === null) return;
        setObjectUrl(result.objectUrl);
        setMediaType(result.mediaType);
        setLoading(false);
      })
      .catch((caught) => {
        if (!alive) return;
        setLoading(false);
        setError(true);
        logger.warn("[toolMedia] 按需读取工具图片失败", {
          error: caught instanceof Error ? caught.message : String(caught),
          // 不回显 ref 全文（可能含 session 片段）；只记 session 是否可还原。
          sessionResolved: sessionId !== null,
        });
      });
    return () => {
      alive = false;
    };
  }, [image.ref, retryToken, sessionId, shouldFetch]);

  const retry = useCallback(() => {
    setError(false);
    setRetryToken((token) => token + 1);
  }, []);

  const state = resolveToolMediaRenderState({
    kind: "ref",
    requested,
    loading,
    hasBytes: objectUrl !== null,
    error,
  });

  return { state, objectUrl, mediaType, retry };
}
