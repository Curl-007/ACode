import { useCallback, useState, type ReactNode } from "react";
import {
  ImagePreviewDialog,
  type ImagePreviewDialogItem,
} from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";

/**
 * ConversationComposer 的附件预览接缝（2026-10-05 上帝组件拆分第一批）。
 *
 * 四个预览状态（图片 gallery index/open + PDF target/open）与两个预览弹窗是
 * composer 内与业务闭包耦合最浅的一组状态（深度审查 P2 指认的拆分接缝），
 * 收口到本 hook：composer 只持有 openImagePreviewForSrc / openPdfPreview 两个
 * controller 函数并把返回的 dialogs JSX 原样渲染。
 *
 * 约束：openImagePreviewForSrc 以 items（composerMediaPreviewItems）为依赖，
 * 消费它的 useMemo（topContentNode）必须把它列入 deps——items 变化时
 * controller 同步换引用，gallery 索引才不会落在过期的附件列表上。
 */
export function useComposerAttachmentPreview(items: readonly ImagePreviewDialogItem[]): {
  openImagePreviewForSrc: (src: string | undefined) => void;
  openPdfPreview: (target: ChatMediaAttachmentPreviewTarget) => void;
  attachmentPreviewDialogs: ReactNode;
} {
  const [imagePreviewIndex, setImagePreviewIndex] = useState(0);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);

  const openImagePreviewForSrc = useCallback(
    (src: string | undefined) => {
      if (!src) return;
      const previewIndex = items.findIndex((item) => item.src === src);
      // 附件可能在点击前已被移除；找不到对应项时静默忽略（与原实现一致）。
      if (previewIndex < 0) return;
      setImagePreviewIndex(previewIndex);
      setImagePreviewOpen(true);
    },
    [items],
  );

  const openPdfPreview = useCallback((target: ChatMediaAttachmentPreviewTarget) => {
    setPdfPreview(target);
    setPdfPreviewOpen(true);
  }, []);

  const attachmentPreviewDialogs = (
    <>
      <ImagePreviewDialog
        initialIndex={imagePreviewIndex}
        items={items}
        onOpenChange={setImagePreviewOpen}
        open={imagePreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewOpen}
        onOpenChange={(open) => {
          setPdfPreviewOpen(open);
          if (!open) setPdfPreview(null);
        }}
      />
    </>
  );

  return { openImagePreviewForSrc, openPdfPreview, attachmentPreviewDialogs };
}
