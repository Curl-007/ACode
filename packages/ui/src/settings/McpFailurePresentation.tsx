import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ACodeMcpReconnectSuspension } from "@acode/shared";
import { type V4McpServerFailureKind } from "@acode/shared/acode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useACodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";

export function resolveMcpFailureMessageId(
  failureKind: V4McpServerFailureKind | undefined,
): `settings.mcp.failure.${V4McpServerFailureKind}` {
  return `settings.mcp.failure.${failureKind ?? "connection_failed"}`;
}

// 熔断挂起文案（specs/mcp-lifecycle-ttl-approval.md R2.3）：按 suspendedBy 三维分叉；
// 缺失按 connect_failures 理解（contracts mcp-status.port.ts 的历史形态约定）。
export function resolveMcpSuspensionMessageId(
  suspendedBy: ACodeMcpReconnectSuspension["suspendedBy"],
):
  | "settings.mcp.suspension.connectFailures"
  | "settings.mcp.suspension.inCallCrashes"
  | "settings.mcp.suspension.crashStorm" {
  switch (suspendedBy) {
    case "in_call_crashes":
      return "settings.mcp.suspension.inCallCrashes";
    case "crash_storm":
      return "settings.mcp.suspension.crashStorm";
    case "connect_failures":
    case undefined:
      return "settings.mcp.suspension.connectFailures";
  }
}

/** 挂起提示的格式化文案；tooltip reason 与横幅共用同一实现，避免两处措辞漂移。 */
export function formatMcpSuspensionMessage(
  intl: IntlInstance,
  suspension: ACodeMcpReconnectSuspension,
): string {
  const messageId = resolveMcpSuspensionMessageId(suspension.suspendedBy);
  if (messageId === "settings.mcp.suspension.crashStorm") {
    // crash_storm 维度没有随行的窗口计数字段（contracts 只有双计数器），文案不带 N。
    return intl.formatMessage({ id: messageId });
  }
  const count =
    suspension.suspendedBy === "in_call_crashes"
      ? (suspension.consecutiveInCallCrashes ?? suspension.consecutiveFailures)
      : suspension.consecutiveFailures;
  return intl.formatMessage({ id: messageId }, { count: String(count) });
}

export function McpSuspensionNotice({ suspension }: { suspension: ACodeMcpReconnectSuspension }) {
  const { intl } = useACodeIntl();
  return (
    <div className="mt-1 flex min-w-0 items-start gap-1 text-ui-base text-warning">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{formatMcpSuspensionMessage(intl, suspension)}</span>
    </div>
  );
}

export function McpFailurePresentation({
  error,
  failureKind,
}: {
  error?: string;
  failureKind?: V4McpServerFailureKind;
}) {
  const { intl } = useACodeIntl();
  const message = intl.formatMessage({
    id: resolveMcpFailureMessageId(failureKind),
  });
  const detailsLabel = intl.formatMessage({
    id: "settings.mcp.failure.technicalDetails",
  });
  return (
    <div className="mt-1 min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-1 text-ui-base text-foreground-subtle">
        <span className="min-w-0">{message}</span>
        {error ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="-my-1 shrink-0 text-foreground-subtlest hover:text-foreground-subtle"
                aria-label={detailsLabel}
                title={detailsLabel}
                onClick={(event) => event.stopPropagation()}
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="top"
              className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="text-ui-sm font-medium text-foreground">{detailsLabel}</div>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground-subtle select-text">
                {error}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </div>
  );
}
