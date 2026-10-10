import { memo, useEffect, useMemo, useState } from "react";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildOrchestrationPanelModel,
  ORCHESTRATION_SWARM_LAMP_CLASS,
  ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT,
  type OrchestrationSwarmNodeRow,
  type OrchestrationWorkflowRow,
} from "@/app-shell/orchestrationPanelModel.js";
import type {
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OrchestrationSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

/**
 * 统一编排 side pane（packages/ui/specs/orchestration-side-pane.md）：三键合流的只读
 * 观察面。接线与 SubagentDirectorySidePane 逐字同款（provider → lease → projection），
 * 差异只在 lease 以可见性为门（R4）；深度浏览不在本面板：段头 action 跳转既有目录
 * tab（R3）。
 */

function AgentStatusIcon({ status }: { status: "running" | "waiting" | "blocked" }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
  }
}

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

/** swarm 节点状态灯：映射单点在模型层（ORCHESTRATION_SWARM_LAMP_CLASS，spec R5）。 */
function SwarmNodeLamp({ status }: { status: OrchestrationSwarmNodeRow["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1.5 size-2 shrink-0 rounded-full border",
        status === "queued" ? "bg-transparent" : "border-transparent",
        ORCHESTRATION_SWARM_LAMP_CLASS[status],
      )}
    />
  );
}

function SectionHeader({
  count,
  onOpenDirectory,
  openDirectoryLabel,
  title,
}: {
  count?: number;
  onOpenDirectory?: () => void;
  openDirectoryLabel?: string;
  title: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-1.5">
      <h3 className="min-w-0 truncate text-ui-sm font-medium text-foreground-subtlest">
        {title}
        {count !== undefined ? ` · ${count}` : null}
      </h3>
      {onOpenDirectory && openDirectoryLabel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label={openDirectoryLabel}
          title={openDirectoryLabel}
          onClick={onOpenDirectory}
        >
          <ListTreeIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export const OrchestrationSidePane = memo(function OrchestrationSidePane({
  tab,
  visible,
  onOpenSubagentDirectory,
  onOpenWorkflowRunDirectory,
}: {
  tab: OrchestrationSidePaneTab;
  visible: boolean;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <OrchestrationContents
        tab={tab}
        visible={visible}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onOpenWorkflowRunDirectory={onOpenWorkflowRunDirectory}
      />
    </V4PaneConversationProvider>
  );
});

const OrchestrationContents = memo(function OrchestrationContents({
  tab,
  visible,
  onOpenSubagentDirectory,
  onOpenWorkflowRunDirectory,
}: {
  tab: OrchestrationSidePaneTab;
  visible: boolean;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
}) {
  const { intl } = useACodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  // R4：lease 以可见性为门——隐藏即释放（refCount → 30s keep-warm → 投影窗口回收）。
  useEffect(() => {
    if (!visible) return;
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId, visible]);
  const projection = useConversationProjection(lease);
  const snapshot = projection.snapshot;
  const model = useMemo(
    () =>
      buildOrchestrationPanelModel({
        backgroundWorks: snapshot?.backgroundWorks,
        ...(snapshot?.subagents ? { subagents: snapshot.subagents } : {}),
        swarmPlan: snapshot?.swarmPlan ?? null,
        ...(snapshot?.workflowRuns ? { workflowRuns: snapshot.workflowRuns } : {}),
      }),
    [snapshot],
  );

  const subagentDirectoryLabel = intl.formatMessage({ id: "sidePane.subagentDirectory" });
  const workflowDirectoryLabel = intl.formatMessage({ id: "sidePane.workflowDirectory" });

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "orchestration.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {model.empty ? (
          <p className="px-3 py-6 text-center text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "orchestration.empty" })}
          </p>
        ) : null}

        {model.agents ? (
          <section>
            <SectionHeader
              title={intl.formatMessage({ id: "chat.statusPanel.agents" })}
              count={model.agents.running.length}
              openDirectoryLabel={subagentDirectoryLabel}
              {...(onOpenSubagentDirectory
                ? {
                    onOpenDirectory: () =>
                      onOpenSubagentDirectory({
                        workspacePath: tab.workspacePath,
                        ...(tab.workspaceIdentity
                          ? { workspaceIdentity: tab.workspaceIdentity }
                          : {}),
                        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
                        rootSessionId: tab.rootSessionId,
                        parentSessionId: tab.parentSessionId,
                      }),
                  }
                : {})}
            />
            {model.agents.running.map((item) => (
              <div
                key={item.childSessionId}
                className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-ui-base"
              >
                <span className="mt-0.5 text-foreground-subtle">
                  <AgentStatusIcon status={item.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">{item.title}</span>
                    <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                      {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-ui-sm text-foreground-subtle">
                    {item.subagentType}
                  </span>
                </span>
                {item.startedAt ? (
                  <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                    {formatTaskRelativeTime(item.startedAt, intl)}
                  </span>
                ) : null}
              </div>
            ))}
            {model.agents.endedTotal > 0 ? (
              <p className="px-3 pt-1 text-ui-sm text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.statusPanel.endedAgents" })} ·{" "}
                {model.agents.endedTotal}
              </p>
            ) : null}
          </section>
        ) : null}

        {model.workflows ? (
          <section className={model.agents ? "mt-5" : undefined}>
            <SectionHeader
              title={intl.formatMessage({ id: "chat.statusPanel.workflows" })}
              count={model.workflows.rows.length}
              openDirectoryLabel={workflowDirectoryLabel}
              {...(onOpenWorkflowRunDirectory
                ? {
                    onOpenDirectory: () =>
                      onOpenWorkflowRunDirectory({
                        workspacePath: tab.workspacePath,
                        ...(tab.workspaceIdentity
                          ? { workspaceIdentity: tab.workspaceIdentity }
                          : {}),
                        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
                        parentSessionId: tab.parentSessionId,
                      }),
                  }
                : {})}
            />
            {model.workflows.rows.map((run) => (
              <div
                key={run.runId}
                className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2 text-ui-base"
              >
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
                      {intl.formatMessage({
                        id: `chat.toolCall.workflow.run.status.${run.status}`,
                      })}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-ui-sm text-foreground-subtle">
                    {run.nodesSettled}/{run.nodesTotal}
                    {run.startedAt ? ` · ${formatTaskRelativeTime(run.startedAt, intl)}` : null}
                  </span>
                </span>
              </div>
            ))}
          </section>
        ) : null}

        {model.swarm ? (
          <section className={model.agents || model.workflows ? "mt-5" : undefined}>
            <SectionHeader title={intl.formatMessage({ id: "orchestration.swarm" })} />
            <div className="px-3">
              <p className="line-clamp-2 text-ui-sm text-foreground-subtle">{model.swarm.goal}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
                  {model.swarm.mode}
                </span>
                {model.swarm.terminalState !== "active" ? (
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-ui-xs",
                      model.swarm.terminalState === "completed"
                        ? "bg-success/10 text-success"
                        : "bg-warning/10 text-warning",
                    )}
                  >
                    {intl.formatMessage({
                      id:
                        model.swarm.terminalState === "completed"
                          ? "chat.toolCall.workflow.run.status.completed"
                          : "orchestration.swarm.stalled",
                    })}
                  </span>
                ) : null}
                {(
                  [
                    ["running", "orchestration.swarm.status.running"],
                    ["queued", "orchestration.swarm.status.queued"],
                    ["done", "orchestration.swarm.status.done"],
                    ["failed", "orchestration.swarm.status.failed"],
                    ["gates", "orchestration.swarm.gate"],
                    ["stalled", "orchestration.swarm.stalled"],
                  ] as const
                ).map(([key, messageId]) =>
                  model.swarm && model.swarm.counts[key] > 0 ? (
                    <span key={key} className="text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage({ id: messageId })} {model.swarm.counts[key]}
                    </span>
                  ) : null,
                )}
              </div>
            </div>
            <div className="mt-2">
              {model.swarm.nodes.map((node) => (
                <div key={node.id} className="flex min-w-0 items-start gap-2 px-3 py-1">
                  <SwarmNodeLamp status={node.status} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-ui-sm text-foreground">
                        {node.id}
                      </span>
                      {node.isGate ? (
                        <span className="shrink-0 rounded-md bg-accent px-1 py-px text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "orchestration.swarm.gate" })}
                        </span>
                      ) : null}
                      {node.dependsOnCount > 0 ? (
                        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                          ←{node.dependsOnCount}
                        </span>
                      ) : null}
                    </span>
                    {node.contentPreview ? (
                      <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
                        {node.contentPreview}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                    {intl.formatMessage({ id: `orchestration.swarm.status.${node.status}` })}
                  </span>
                </div>
              ))}
            </div>
            {model.swarm.nodeDisplayTruncated ? (
              <p className="px-3 pt-1.5 text-ui-xs text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "orchestration.swarm.nodesShown" },
                  { count: String(ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT) },
                )}
              </p>
            ) : null}
            {model.swarm.wireTruncated ? (
              <p className="px-3 pt-1 text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "orchestration.swarm.truncated" })}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
});
