import { useCallback, useMemo, useRef, useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ImageThumbnailGallery,
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { extractToolMediaRefImages } from "@/lib/toolMediaRefImages.js";
import { NodeReplImageRefThumbnail } from "@/ToolCallBlocks/renderers/nodeReplImageRefThumbnail.js";

/** 单张 ref 缩略图上报的读取态（供共享预览 dialog 组装 item）。 */
interface RefThumbState {
  objectUrl: string | null;
  mediaType: string | null;
  error: boolean;
}

const EMPTY_REF_STATE: RefThumbState = { objectUrl: null, mediaType: null, error: false };

/**
 * Node REPL / Browser 工具图片画廊。
 *
 * U11：图片有两种形态，同一画廊内共存——
 * - **inline**（legacy）：字节随 row 到达，直接拼 data URL 渲染（旧 row 不回归，U11-A4）；
 * - **ref**（新）：display 只带稳定引用 + mime + bytes，字节在缩略图进视口/预览打开时按需读取
 *   （U11-A1/A2）。读取、缓存、URL 生命周期与降级都在 `useToolMediaRefBytes` +
 *   `NodeReplImageRefThumbnail`；本组件只负责布局与共享预览 dialog。
 *
 * `toolCall` 缺席（旧调用点）或无 ref 形态图片时，行为与 U11 之前逐字一致。
 */
export function NodeReplImageGrid({
  images,
  label,
  toolCall,
}: {
  images: ReadonlyArray<NodeReplDisplayModel["images"][number]>;
  /** 图片的无障碍标签前缀（i18n「结果图片」）；缩略图 alt/aria-label 据此编号。 */
  label: string;
  /** ref 形态图片的来源；缺席即只有 inline（向后兼容）。 */
  toolCall?: TaskChatToolCall;
}) {
  const { intl } = useACodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // 每个下标一个**稳定**的登记函数：缩略图把它放进 useCallback 依赖，若每次渲染都返回新函数，
  // 回调 ref 会被反复重挂、IntersectionObserver 跟着断开重连。按 index 缓存一次即可。
  const registerTriggerCache = useRef(new Map<number, (node: HTMLButtonElement | null) => void>());
  const getRegisterTrigger = useCallback((index: number) => {
    const cached = registerTriggerCache.current.get(index);
    if (cached) return cached;
    const register = (node: HTMLButtonElement | null) => {
      triggerRefs.current[index] = node;
    };
    registerTriggerCache.current.set(index, register);
    return register;
  }, []);

  // ref 形态图片的元数据（字节不在这里，按需读取）。稳定顺序：抽取即定序。
  const refImages = useMemo(
    () => (toolCall ? extractToolMediaRefImages(toolCall) : []),
    [toolCall],
  );
  // 每张 ref 图的读取态；索引与 refImages 对齐。用函数式 setState 局部更新，避免整表重建。
  const [refStates, setRefStates] = useState<RefThumbState[]>([]);
  const setRefState = useCallback((index: number, state: RefThumbState) => {
    setRefStates((current) => {
      const prev = current[index] ?? EMPTY_REF_STATE;
      // 浅比较，值未变则复用原引用，避免 effect→setState→effect 抖动。
      if (
        prev.objectUrl === state.objectUrl &&
        prev.mediaType === state.mediaType &&
        prev.error === state.error
      ) {
        return current;
      }
      const next = current.slice();
      next[index] = state;
      return next;
    });
  }, []);
  // 同理：上报函数按 index 缓存，避免缩略图的 useEffect 依赖每次渲染都变。
  const stateReporterCache = useRef(new Map<number, (state: RefThumbState) => void>());
  const getStateReporter = useCallback(
    (index: number) => {
      const cached = stateReporterCache.current.get(index);
      if (cached) return cached;
      const report = (state: RefThumbState) => setRefState(index, state);
      stateReporterCache.current.set(index, report);
      return report;
    },
    [setRefState],
  );

  // inline 项（data URL）在前，ref 项在后——与画廊渲染顺序一致，previewIndex 按此定位。
  const inlineItems = useMemo(
    () =>
      images.map((image, index) => ({
        alt: `${label} ${index + 1}`,
        filename: `result-image-${index + 1}`,
        src: `data:${image.mimeType};base64,${image.base64}`,
      })),
    [images, label],
  );
  const inlineCount = inlineItems.length;

  const previewItems = useMemo(() => {
    const refItems = refImages.map((image, index) => {
      const state = refStates[index] ?? EMPTY_REF_STATE;
      const ordinal = inlineCount + index + 1;
      return {
        alt: `${label} ${ordinal}`,
        filename: `result-image-${ordinal}`,
        ...(state.objectUrl ? { src: state.objectUrl } : {}),
        ...(state.mediaType ? { mediaType: state.mediaType } : {}),
        // 尚未就绪：有 objectUrl = ready；否则 error 或 loading（未进视口也按 loading 占位）。
        ...(state.objectUrl ? {} : state.error ? { error: true } : { loading: true }),
      };
    });
    return [...inlineItems, ...refItems];
  }, [inlineCount, inlineItems, refImages, refStates, label]);

  const openImageLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });

  const handleOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (!open) {
      window.setTimeout(() => triggerRefs.current[previewIndex]?.focus(), 0);
    }
  };

  return (
    <>
      <ImageThumbnailGallery data-node-repl-image-gallery="" grouped={previewItems.length >= 2}>
        {inlineItems.map((item, index) => (
          <button
            ref={(node) => {
              triggerRefs.current[index] = node;
            }}
            type="button"
            aria-label={`${openImageLabel} ${index + 1}`}
            className={imageThumbnailTriggerClassName}
            data-image-thumbnail-trigger=""
            key={`${images[index]?.mimeType}:${images[index]?.base64.length}:${index}`}
            onClick={() => {
              setPreviewIndex(index);
              setPreviewOpen(true);
            }}
          >
            <img
              alt={item.alt}
              className={imageThumbnailClassName}
              draggable={false}
              loading="lazy"
              src={item.src}
            />
          </button>
        ))}
        {refImages.map((image, index) => (
          <NodeReplImageRefThumbnail
            key={image.ref}
            alt={`${label} ${inlineCount + index + 1}`}
            image={image}
            previewOpen={previewOpen && previewIndex === inlineCount + index}
            // 与 inline 项共用同一张 triggerRefs 数组（ref 项偏移 inlineCount），
            // 于是预览关闭后焦点还回触发按钮的逻辑对两种形态一致。
            registerTrigger={getRegisterTrigger(inlineCount + index)}
            onOpenPreview={() => {
              setPreviewIndex(inlineCount + index);
              setPreviewOpen(true);
            }}
            onStateChange={getStateReporter(index)}
          />
        ))}
      </ImageThumbnailGallery>
      <ImagePreviewDialog
        dialogTestId="node-repl-image-lightbox"
        imageTestId="node-repl-image-lightbox-image"
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={handleOpenChange}
        open={previewOpen}
      />
    </>
  );
}
