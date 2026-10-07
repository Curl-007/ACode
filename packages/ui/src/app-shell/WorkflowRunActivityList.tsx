import { memo, useMemo } from "react";
import { CircleDotIcon } from "lucide-react";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import {
  WorkflowAgentPill,
  type WorkflowAgentPillOpen,
} from "@/components/workflow-timeline/WorkflowAgentPill.js";
import {
  buildWorkflowActivityGroups,
  workflowActorKey,
  workflowActorStepStatus,
  type WorkflowActivityGroup,
} from "@/app-shell/workflowRunActivity.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import type { WorkflowRunActor, WorkflowRunNode, WorkflowRunState } from "@acode/shared/acode-protocol-v4";

/**
 * 详情侧栏的**第二主体**：只吃 `workflowRuns` 投影的实时活动清单。
 *
 * 为什么需要它：既有主体 `WorkflowRunPhaseList` 从头到尾绑在静态因果图上，而图是按发起
 * toolCallId 从 `CreateWorkflow` 工具行的元数据里取的。脚本工作流（`dialect === "script"`）
 * 不编译、不做静态分析，`RunWorkflow` 的工具行上没有图，于是它走到侧栏只能看到一句
 * 「当前会话的可见历史里没有这张工作流图」——状态头、结果区、产物区都在，主体却是空的。
 *
 * 分组与状态折叠的规则住在 `workflowRunActivity.ts`（纯函数，可穷举单测，并记明了
 * **为什么不从投影合成一张因果图**）；本文件只负责把它贴到 DOM 上。
 *
 * 与图视图的分工由调用方决定（`WorkflowRunSidePane`）：有图走图，没图但有 run 投影走这里，
 * 连投影都没有才落到「图不可用」——那句话的本义是「无从观测」，不该被有投影的 run 占用。
 */
export const WorkflowRunActivityList = memo(function WorkflowRunActivityList({
  onOpenActor,
  run,
}: {
  /** 缺席即行不可点（回调的存在本身就是门控），与图视图同一条规则。 */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  run: WorkflowRunState;
}) {
  const { intl } = useACodeIntl();
  const format = intl.formatMessage.bind(intl);
  const groups = useMemo(() => buildWorkflowActivityGroups(run), [run]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="workflow-run-activity">
      {/*
       * 一句话交代这份视图是什么、不是什么。措辞按方言分开，因为两者的「没有图」是两件
       * 不同的事：脚本工作流**根本没有**静态计划（不编译、不做静态分析），而 dwf 是有图
       * 但发起行滚出了可见历史窗口。对后者说「这套系统没有静态计划」是谎话。
       */}
      <p className="text-ui-xs text-foreground-subtle" data-testid="workflow-run-activity-hint">
        {format({
          id:
            run.dialect === "script"
              ? "chat.toolCall.workflow.run.activity.hint.script"
              : "chat.toolCall.workflow.run.activity.hint.noGraph",
        })}
      </p>
      {groups.map((group, groupIndex) => (
        <ActivityPhaseSection
          format={format}
          group={group}
          key={group.name ?? `__unphased_${groupIndex}`}
          {...(onOpenActor === undefined ? {} : { onOpenActor })}
        />
      ))}
    </div>
  );
});

type Format = (
  descriptor: { id: string },
  values?: Record<string, number | string>,
) => string;

function ActivityPhaseSection({
  format,
  group,
  onOpenActor,
}: {
  format: Format;
  group: WorkflowActivityGroup;
  onOpenActor?: (instance: WorkflowActorInstance) => void;
}) {
  return (
    <section
      data-phase-name={group.name ?? ""}
      data-phase-status={group.status ?? "empty"}
      data-testid="workflow-run-activity-phase"
    >
      <header className="flex items-center gap-2 py-1">
        {/* 灯用 dwf 那份颜色表（STATUS_DOT）：同一个状态在两个主体里不能是两种颜色。
            空组退到 pending 的空心点——它没有节点可折叠，不该借 running 的动画。 */}
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[group.status ?? "pending"])}
          data-testid="workflow-run-activity-lamp"
        />
        <span className="min-w-0 flex-1 truncate text-ui-small font-medium text-foreground">
          {group.name ?? format({ id: "chat.toolCall.workflow.graph.phase.unphased" })}
        </span>
        <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
          {format(
            { id: "chat.toolCall.workflow.run.activity.fraction" },
            { settled: group.settled, total: group.nodes.length },
          )}
        </span>
      </header>
      <ul className="mt-1 flex flex-col gap-0.5">
        {group.actors.map((actor, index) => (
          <ActivityActorRow
            actor={actor}
            avatarIndex={index}
            format={format}
            key={workflowActorKey(actor)}
            nodes={group.nodes.filter(
              (node) =>
                node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
            )}
            {...(onOpenActor === undefined ? {} : { onOpenActor })}
          />
        ))}
        {/* 无主节点（world-read 之类）：脚本工作流产不出它，但投影契约允许，
            漏掉就等于把观测到的事实藏起来。 */}
        {group.nodes
          .filter((node) => node.actorSiteId === undefined || node.actorOrdinal === undefined)
          .map((node) => (
            <li key={`${node.siteId}@${node.ordinal}`} className="pl-1">
              <ActivityNodeLine
                format={format}
                label={format({ id: "chat.toolCall.workflow.run.activity.untrackedNode" })}
                node={node}
                leadingIcon
              />
            </li>
          ))}
      </ul>
    </section>
  );
}

function ActivityActorRow({
  actor,
  avatarIndex,
  format,
  nodes,
  onOpenActor,
}: {
  actor: WorkflowRunActor;
  avatarIndex: number;
  format: Format;
  nodes: readonly WorkflowRunNode[];
  onOpenActor?: (instance: WorkflowActorInstance) => void;
}) {
  const open: WorkflowAgentPillOpen | undefined =
    onOpenActor === undefined
      ? undefined
      : {
          label: format({ id: "chat.toolCall.workflow.run.activity.openActor" }),
          onOpen: () =>
            onOpenActor({
              ordinal: actor.ordinal,
              siteId: actor.siteId,
              status: actor.status,
              ...(actor.name === undefined ? {} : { name: actor.name }),
              ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
            }),
          testId: "workflow-run-activity-actor",
        };
  return (
    <li className="flex flex-col">
      <WorkflowAgentPill
        avatarIndex={avatarIndex}
        className="w-full"
        laneClass="agent"
        name={actor.name ?? actor.siteId}
        size="row"
        status={workflowActorStepStatus(actor, nodes)}
        {...(open === undefined
          ? { inertTitle: format({ id: "chat.toolCall.workflow.run.activity.actorInert" }) }
          : { open })}
      >
        <ActivityNodeLine format={format} node={nodes[nodes.length - 1]} nodes={nodes} />
      </WorkflowAgentPill>
    </li>
  );
}

/**
 * 节点活动的一行附属信息：几次 ask、是否命中缓存、最后一个工具。
 *
 * 全部来自投影的计数字段，不做任何推断——这里多写一个「大概是」的措辞，读者就会当成事实。
 */
function ActivityNodeLine({
  format,
  label,
  leadingIcon = false,
  node,
  nodes,
}: {
  format: Format;
  label?: string;
  leadingIcon?: boolean;
  node: WorkflowRunNode | undefined;
  nodes?: readonly WorkflowRunNode[];
}) {
  const parts: string[] = [];
  if (label !== undefined) parts.push(label);
  if (nodes !== undefined && nodes.length > 0) {
    parts.push(
      format({ id: "chat.toolCall.workflow.run.activity.asks" }, { n: nodes.length }),
    );
    if (nodes.some((entry) => entry.cached === true)) {
      parts.push(format({ id: "chat.toolCall.workflow.run.activity.cached" }));
    }
  }
  if (node?.lastTool?.name) {
    parts.push(
      format({ id: "chat.toolCall.workflow.run.activity.lastTool" }, { name: node.lastTool.name }),
    );
  }
  if (parts.length === 0) return null;
  return (
    <span
      className="ml-1.5 inline-flex min-w-0 items-center gap-1 truncate text-ui-xs text-foreground-subtle"
      data-testid="workflow-run-activity-node"
    >
      {leadingIcon ? <CircleDotIcon aria-hidden className="size-3 shrink-0" /> : null}
      <span className="truncate">{parts.join(" · ")}</span>
    </span>
  );
}
