// U11：单张 **ref 形态**工具图片的缩略图（spec: packages/ui/specs/tool-media-on-demand.md）。
//
// 与 inline 缩略图（字节已在 row，直接拼 data URL）不同，ref 形态的字节按需读取：
// 缩略图进入视口（IntersectionObserver，提前 200px）或预览打开时才 fetch；未进视口 = fetch 0 次
// （proposal U11-A1）。读取失败/授权失败进 error 终态，展示降级 + 允许显式 retry（U11-A5），
// 绝不崩溃或静默空白。
//
// 复用既有 image-thumbnail-gallery 的触发器样式（与 markdown-image.tsx 同一约定，含
// focus-visible:ring-2 焦点态，符合 DESIGN.md「焦点态必须可见」）。retry 是动作按钮，用 `Button`。
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { ToolMediaRefImage } from "@acode/shared/acode-protocol-v4";
import { useToolMediaRefBytes } from "@/lib/toolMediaRefBytes.js";

/**
 * 进入视口才置 visible（提前 200px 预读）；无 IntersectionObserver 的环境（jsdom/回放）视作立刻
 * 可见——逐字照 app-shell/WorkflowWorkspacePeek.tsx 的 house 模式。
 *
 * 返回**回调 ref**而不是 ref 对象：同一个节点既要交给 IntersectionObserver，又要上报给 grid 的
 * triggerRefs（预览关闭后把焦点还回触发按钮，不让焦点落到 body——与 inline 项同一约定）。
 */
function useVisibleOnIntersect(
  registerTrigger?: (node: HTMLButtonElement | null) => void,
): [(node: HTMLButtonElement | null) => void, boolean] {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  const attach = useCallback(
    (node: HTMLButtonElement | null) => {
      registerTrigger?.(node);
      // 节点更换/卸载：停掉上一轮观察，避免观察已脱离文档的节点。
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (node === null || visible) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setVisible(true);
            observer.disconnect();
          }
        },
        { rootMargin: "200px 0px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [registerTrigger, visible],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [attach, visible];
}

export function NodeReplImageRefThumbnail({
  alt,
  image,
  onOpenPreview,
  onStateChange,
  previewOpen,
  registerTrigger,
}: {
  alt: string;
  image: ToolMediaRefImage;
  /** 点击缩略图 → 打开共享预览（grid 持有 dialog）。 */
  onOpenPreview: () => void;
  /** 把本图的读取态（url/mime/error）上报给 grid，供共享预览 dialog 组装 item。 */
  onStateChange: (state: {
    objectUrl: string | null;
    mediaType: string | null;
    error: boolean;
  }) => void;
  /** 该图对应的预览是否打开（打开即强制读取，即便缩略图尚未进视口）。 */
  previewOpen: boolean;
  /** 把触发按钮节点登记给 grid，使预览关闭后焦点能还回本图（与 inline 项共用同一数组）。 */
  registerTrigger?: (node: HTMLButtonElement | null) => void;
}) {
  const { intl } = useACodeIntl();
  const [attachTrigger, visible] = useVisibleOnIntersect(registerTrigger);
  const { objectUrl, mediaType, retry, state } = useToolMediaRefBytes({
    image,
    previewOpen,
    visible,
  });

  // 上报给 grid 的共享预览 dialog（依赖变化才上报，避免每次渲染都 setState）。
  useEffect(() => {
    onStateChange({ objectUrl, mediaType, error: state === "error" });
  }, [mediaType, objectUrl, onStateChange, state]);

  const openLabel = intl.formatMessage({ id: "chat.attachments.preview.open" });
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  const unavailableLabel = intl.formatMessage({ id: "codeViewer.imageUnavailable" });
  const retryLabel = intl.formatMessage({ id: "common.retry" });

  const isLoading = state === "loading" || state === "idle";
  const isError = state === "error";

  return (
    <button
      ref={attachTrigger}
      type="button"
      aria-label={openLabel}
      className={cn(
        imageThumbnailTriggerClassName,
        // 加载/错误态内部是绝对定位占位，画廊父级的 w-auto 会塌缩宽度；固定方形，同 markdown-image。
        (isLoading || isError) && "relative !h-44 !w-44 !max-w-full",
        isError && "cursor-default",
      )}
      data-image-thumbnail-trigger=""
      data-node-repl-image-state={state}
      onClick={() => {
        if (!isError) onOpenPreview();
      }}
    >
      {isLoading ? (
        <span
          aria-label={loadingLabel}
          className="markdown-image-loading-shimmer absolute inset-0 flex size-full items-center justify-center text-foreground-subtle"
          data-node-repl-ref-loading=""
          role="status"
        >
          <ImageIcon aria-hidden="true" className="size-6" />
        </span>
      ) : null}
      {isError ? (
        <span
          className="absolute inset-0 flex size-full flex-col items-center justify-center gap-1 text-center text-foreground-subtle"
          data-node-repl-ref-error=""
          role="img"
          aria-label={unavailableLabel}
        >
          <ImageOffIcon aria-hidden="true" className="size-6" />
          <span className="text-ui-sm">{unavailableLabel}</span>
          {/* retry 是动作按钮，用 Button（DESIGN.md）；显式触发，不自动无限重试。 */}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0"
            onClick={(event) => {
              event.stopPropagation();
              retry();
            }}
          >
            {retryLabel}
          </Button>
        </span>
      ) : null}
      {objectUrl ? (
        <img
          alt={alt}
          className={imageThumbnailClassName}
          draggable={false}
          loading="lazy"
          src={objectUrl}
        />
      ) : null}
    </button>
  );
}
