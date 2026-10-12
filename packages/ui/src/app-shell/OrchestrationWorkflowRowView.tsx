import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { OrchestrationWorkflowRow } from "@/app-shell/orchestrationPanelModel.js";
import { WorkflowRunHolesSection } from "@/app-shell/WorkflowRunHoleRow.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  OrchestrationSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

/**
 * 统一编排 side pane 的单条 workflow 行（从 `OrchestrationSidePane.tsx` 拆出，
 * oxlint max-lines 400 门，与 WorkflowRunSidePaneSections 同一先例）。
 *
 * 行本体（状态灯 + 题名 + 步数）照旧只读；行下挂该 run 停驻洞的「无则缺席」区
 * （挖洞-填充）。「打开运行」走宿主既有的 onOpenWorkflowRun 链，只在行带 toolCallId
 * 且宿主给了回调时出现——打开请求按发起工具行联接，缺它开不了详情页。
 */
function WorkflowStatusIcon({ status }: { status: OrchestrationWorkflowRow["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "pending":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "completed":
      return <CheckCircle2Icon aria-hidden className={cn(className, "text-success")} />;
    case "errored":
      return <CircleAlertIcon aria-hidden className={cn(className, "text-destructive")} />;
    case "stopped":
      return <BanIcon aria-hidden className={className} />;
  }
}

export function OrchestrationWorkflowRowView({
  onOpenWorkflowRun,
  run,
  tab,
}: {
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  run: OrchestrationWorkflowRow;
  tab: OrchestrationSidePaneTab;
}) {
  const { intl } = useACodeIntl();
  // 停驻洞行的「打开运行」请求体：提前收窄 toolCallId（闭包里不保窄）。
  const runToolCallId = run.toolCallId;
  const openHoleRun =
    onOpenWorkflowRun === undefined || runToolCallId === undefined
      ? undefined
      : () =>
          onOpenWorkflowRun({
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
            ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
            parentSessionId: tab.parentSessionId,
            toolCallId: runToolCallId,
            runId: run.runId,
            ...(run.title ? { workflowName: run.title } : {}),
          });

  return (
    <div className="flex w-full min-w-0 flex-col">
      <div className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-ui-base">
        <span className="mt-0.5 text-foreground-subtle">
          <WorkflowStatusIcon status={run.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate font-medium text-foreground",
                !run.title && "font-mono text-ui-sm",
              )}
            >
              {run.title ?? run.runId}
            </span>
            <span className="shrink-0 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` })}
            </span>
          </span>
          <span className="mt-0.5 block text-ui-sm text-foreground-subtle">
            {run.nodesSettled}/{run.nodesTotal}
            {run.startedAt ? ` · ${formatTaskRelativeTime(run.startedAt, intl)}` : null}
          </span>
        </span>
      </div>
      <WorkflowRunHolesSection
        className="px-3 pb-1 pt-0"
        holes={run.pendingHoles ?? []}
        {...(openHoleRun === undefined ? {} : { onOpenRun: openHoleRun })}
      />
    </div>
  );
}
