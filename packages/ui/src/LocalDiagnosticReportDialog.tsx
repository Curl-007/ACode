import { useCallback, useEffect } from "react";
import { DownloadIcon } from "lucide-react";
import type { LocalDiagnosticAvailability } from "@acode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLocalDiagnosticReport } from "@/hooks/useLocalDiagnosticReport.js";
import type { DiagnosticScope, DownloadOutcome } from "@/lib/localDiagnosticReport.js";
import {
  diagnosticAvailabilityBadgeVariant,
  diagnosticAvailabilityLabelId,
} from "@/lib/localDiagnosticReport.js";

/**
 * U12 本地诊断报告对话框：预览将包含的内容 → 勾选范围 → 下载 JSON（或剪贴板降级）。
 * 契约真源：packages/shared/specs/local-diagnostic-report.md。
 * 核心用户价值是「先预览再决定」：每个字段组的可用性状态（collected/unavailable/
 * not-collected/truncated）必须**可见地区分**渲染（验收 U12-A4）。
 */

const SCOPE_GROUPS = ["build", "connection", "performance", "provider", "events"] as const;

/** 可用性 → i18n 键后缀；四态各自有独立可见标签（含 not-collected 与 unavailable 的区分）。 */
function AvailabilityBadge({ state }: { state: LocalDiagnosticAvailability }) {
  const { intl } = useACodeIntl();
  // 标签映射与 variant 都是 lib 纯函数（diagnosticAvailabilityLabelId/BadgeVariant），
  // 便于脱离组件行为测试；只用 Badge 既有 variant，不新造样式（DESIGN.md）。
  return (
    <Badge variant={diagnosticAvailabilityBadgeVariant(state)} className="shrink-0">
      {intl.formatMessage({ id: diagnosticAvailabilityLabelId(state) })}
    </Badge>
  );
}

export function LocalDiagnosticReportDialog({
  open,
  onOpenChange,
}: {
  /** 由挂载处（帮助菜单）持有开关状态，菜单项点击时置 true。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useACodeIntl();
  const platform = usePlatform();
  const diag = useLocalDiagnosticReport(platform);

  // 采集由 open 变化驱动，**不能**依赖 Dialog 的 onOpenChange：本对话框是受控的（open 由父级
  // 帮助菜单的 state 决定），而 radix 只在用户交互（Esc/点遮罩）时触发 onOpenChange——菜单点击
  // 打开时它不会触发，采集就永远不会发生（phase 停在 idle、对话框空白）。
  useEffect(() => {
    if (open) {
      diag.open();
    } else {
      // 关闭即释放已采集事实（U12-A5：不残留、下次打开重新采集）。
      diag.close();
    }
    // diag.open/close 是 hook 内 useCallback 稳定引用；此处只关心 open 的变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 关闭对话框：同时通知父级（受控 open 的真源）与释放本层采集状态。 */
  const requestClose = useCallback(() => {
    diag.close();
    onOpenChange(false);
  }, [diag, onOpenChange]);

  const handleDownload = async () => {
    const outcome: DownloadOutcome = await diag.download();
    switch (outcome.kind) {
      case "saved":
        toast(
          outcome.path
            ? intl.formatMessage({ id: "diagnostics.download.savedPath" }, { path: outcome.path })
            : intl.formatMessage({ id: "diagnostics.download.saved" }),
        );
        // 必须走 requestClose：只调 diag.close() 的话父级 open 仍为 true，
        // 对话框会停在空白态（受控组件的开关真源在父级）。
        requestClose();
        break;
      case "cancelled":
        // 用户取消保存框：静默，不弹错误（取消不是失败）。
        break;
      case "copied":
        // 平台无法直接下载（如手机浏览器拦截）：已复制到剪贴板，如实告知。
        toast(intl.formatMessage({ id: "diagnostics.download.copiedFallback" }));
        break;
      case "failed":
        toast(
          intl.formatMessage({ id: "diagnostics.download.failed" }, { error: outcome.errorCode }),
        );
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "diagnostics.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "diagnostics.description" })}
          </DialogDescription>
        </DialogHeader>

        {diag.phase === "collecting" ? (
          <p className="text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "diagnostics.collecting" })}
          </p>
        ) : null}

        {diag.phase === "error" ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "diagnostics.error" }, { error: diag.errorCode ?? "" })}
          </p>
        ) : null}

        {diag.phase === "ready" && diag.report ? (
          <div className="flex flex-col gap-3">
            {/* 范围勾选：默认最小集（build/connection/performance 已勾，provider/events 未勾）。
                勾选变化只做纯重组，不重复采集（U12-A5）。 */}
            <div className="flex flex-col gap-2">
              {SCOPE_GROUPS.map((group) => {
                const checked = diag.scope[group as keyof DiagnosticScope];
                const state = diag.report?.fieldAvailability[group];
                return (
                  <label
                    key={group}
                    className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-ui-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => diag.toggleScope(group)}
                        aria-label={intl.formatMessage({ id: `diagnostics.group.${group}` })}
                      />
                      {intl.formatMessage({ id: `diagnostics.group.${group}` })}
                    </span>
                    {state ? <AvailabilityBadge state={state} /> : null}
                  </label>
                );
              })}
            </div>
            {/* 内容预览：只展示将写入文件的 JSON（已经是白名单+脱敏后的最终形态）。 */}
            <pre
              className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-ui-xs whitespace-pre-wrap break-all"
              data-testid="diagnostics-report-preview"
            >
              {JSON.stringify(diag.report, null, 2)}
            </pre>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={requestClose}>
            {intl.formatMessage({ id: "diagnostics.close" })}
          </Button>
          <Button
            onClick={() => void handleDownload()}
            disabled={diag.phase !== "ready" || !diag.report || diag.downloading}
          >
            <DownloadIcon className="size-4" />
            {diag.downloading
              ? intl.formatMessage({ id: "diagnostics.download.pending" })
              : intl.formatMessage({ id: "diagnostics.download.action" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
