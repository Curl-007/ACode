import { useState } from "react";
import { DownloadIcon, Loader2 } from "lucide-react";
import type { ConversationExportFormat, ConversationExportSelection } from "@acode/services";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { dismissToast, toast } from "@/components/ui/toast.js";
import { useConversationExportService } from "@/hooks/useConversationExport.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  EXPORT_MAX_BYTES,
  runConversationExport,
} from "@/lib/conversation-export/runConversationExport.js";
import { getConversationShareSelectedProductTurnIds } from "@/store/conversationShareSelectionStore.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

/**
 * 会话本地导出的入口 + 格式/范围弹层。
 *
 * 与 ConversationShareMenu 的关键差异：
 * - 显示条件不要求登录态（导出是纯本地行为）；
 * - 不复用分享的 `active` 视觉（两个入口共用同一个选择 store，若都读 scope === "partial"，
 *   用户点开分享选择后两个按钮会一起高亮，语义错乱）；导出只用 `disabled={exporting}`。
 */
export function ConversationExportMenu({
  taskId,
  title,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  useWindowsCaptionSpacing = false,
}: {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl, locale } = useACodeIntl();
  const exportService = useConversationExportService();
  const platform = useOptionalPlatform();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ConversationExportFormat>("markdown");
  const [scope, setScope] = useState<"all" | "partial">("all");
  const [exporting, setExporting] = useState(false);

  const selectedTurnCount = useConversationShareSelectionStore(
    (state) => getConversationShareSelectedProductTurnIds(state, taskId).length,
  );

  const resolveSelection = (): ConversationExportSelection => {
    if (scope === "all") return { kind: "all" };
    return {
      kind: "productTurns",
      productTurnIds: getConversationShareSelectedProductTurnIds(
        useConversationShareSelectionStore.getState(),
        taskId,
      ),
    };
  };

  const handleExport = async () => {
    if (exporting || !exportService) return;
    setExporting(true);
    const pendingToastId = toast(intl.formatMessage({ id: "conversationExport.pending" }), {
      durationMs: Number.POSITIVE_INFINITY,
    });
    try {
      const outcome = await runConversationExport({
        exportService,
        platform: platform?.saveFile ? { saveFile: platform.saveFile.bind(platform) } : null,
        intl,
        locale,
        format,
        selection: resolveSelection(),
        target: {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId: taskId,
        },
        title,
        now: new Date(),
      });

      if (outcome.ok) {
        setOpen(false);
        if (outcome.copied) {
          toast(intl.formatMessage({ id: "conversationExport.copied" }));
        } else if (outcome.path) {
          toast(intl.formatMessage({ id: "conversationExport.success" }, { path: outcome.path }));
        } else {
          // Web 端 HTML 走浏览器下载：没有可展示的路径，用不带占位的文案
          // （formatMessage 缺占位值时会把字面量 {path} 留在文案里，不能传空串蒙混）。
          toast(intl.formatMessage({ id: "conversationExport.downloaded" }));
        }
        return;
      }

      switch (outcome.failure) {
        case "empty":
          toast(intl.formatMessage({ id: "conversationExport.error.empty" }));
          break;
        case "running":
          toast(intl.formatMessage({ id: "conversationExport.error.running" }));
          break;
        case "no_selection":
          toast(intl.formatMessage({ id: "conversationExport.error.empty" }));
          break;
        case "too_large":
          toast(
            intl.formatMessage(
              { id: "conversationExport.error.tooLarge" },
              { limit: `${Math.round(EXPORT_MAX_BYTES / (1024 * 1024))} MB` },
            ),
          );
          break;
        case "changed":
          toast(intl.formatMessage({ id: "conversationExport.error.changed" }));
          break;
        default:
          toast(
            intl.formatMessage(
              { id: "conversationExport.error.failed" },
              { error: outcome.errorDetail ?? "unknown" },
            ),
          );
          break;
      }
    } catch (error) {
      logger.warn("[conversation-export] 导出动作异常", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(
        intl.formatMessage(
          { id: "conversationExport.error.failed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    } finally {
      dismissToast(pendingToastId);
      setExporting(false);
    }
  };

  // 服务不可用（旧 host / 未装配）时不渲染入口，避免点了没反应。
  if (!exportService) return null;

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className={cn(
        "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
        useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
        useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
      )}
      aria-label={intl.formatMessage({ id: "conversationExport.trigger" })}
      data-testid="conversation-export-trigger"
      disabled={exporting}
      onClick={() => setOpen(true)}
    >
      <DownloadIcon className="size-4" />
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={(next) => (exporting ? undefined : setOpen(next))}>
      <PopoverTrigger asChild>
        <ControlHintTooltip
          title={intl.formatMessage({ id: "conversationExport.trigger" })}
          side="bottom"
        >
          {trigger}
        </ControlHintTooltip>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        data-testid="conversation-export-popover"
        className="w-72 rounded-xl border-popover-border bg-popover p-3"
      >
        <div className="flex flex-col gap-3">
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "conversationExport.title" })}
          </span>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "conversationExport.formatLabel" })}
            </span>
            <div role="radiogroup" className="flex flex-col gap-0.5">
              {(
                [
                  { value: "markdown", labelId: "conversationExport.format.markdown" },
                  { value: "html", labelId: "conversationExport.format.html" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={format === option.value}
                  data-testid={`conversation-export-format-${option.value}`}
                  className={cn(
                    "flex items-center rounded-lg px-2 py-1.5 text-left text-ui-base",
                    format === option.value
                      ? "bg-selected text-foreground"
                      : "text-foreground-subtle hover:bg-hover",
                  )}
                  onClick={() => setFormat(option.value)}
                >
                  {intl.formatMessage({ id: option.labelId })}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "conversationExport.scopeLabel" })}
            </span>
            <div role="radiogroup" className="flex flex-col gap-0.5">
              <button
                type="button"
                role="radio"
                aria-checked={scope === "all"}
                data-testid="conversation-export-scope-all"
                className={cn(
                  "flex items-center rounded-lg px-2 py-1.5 text-left text-ui-base",
                  scope === "all"
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover",
                )}
                onClick={() => setScope("all")}
              >
                {intl.formatMessage({ id: "conversationExport.scope.all" })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={scope === "partial"}
                data-testid="conversation-export-scope-selected"
                // 没有选中轮次时该项不可用：避免导出一份空文件。
                disabled={selectedTurnCount === 0}
                className={cn(
                  "flex items-center rounded-lg px-2 py-1.5 text-left text-ui-base disabled:opacity-50",
                  scope === "partial"
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover",
                )}
                onClick={() => setScope("partial")}
              >
                {intl.formatMessage(
                  { id: "conversationExport.scope.selected" },
                  { count: selectedTurnCount },
                )}
              </button>
            </div>
          </div>

          <Button
            type="button"
            variant="default"
            size="default"
            data-testid="conversation-export-confirm"
            disabled={exporting}
            className="justify-center"
            onClick={() => void handleExport()}
          >
            {exporting ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {intl.formatMessage({ id: "conversationExport.confirm" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
