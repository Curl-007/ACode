import { memo, useEffect, useState } from "react";
import { PuzzleIcon } from "lucide-react";
import type { WorkflowRunPendingHole } from "@acode/shared/acode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * 一条停驻中的 workflow hole（挖洞-填充，见 apps/acode-cli/specs/workflow-holes.md 观测链）。
 *
 * 与 `WorkflowRunQuestionRow` 的分工（照 shared schema 头注释的同一条线）：升级问题欠的是
 * **值**（actor 等一句话），hole 欠的是**代码**（脚本进程停在洞站点，等主代理用
 * FillWorkflowHole 提交该处函数体）。所以这一行**只读**：填洞者是主代理，用户答不了；
 * 能做的是看见「哪个阶段在等、等的是什么、等了多久」，必要时经「打开运行」跳到详情页指着它说。
 *
 * waiting 态是本组件唯一要画的态：`hole-filled` 后 run 走 supersede 链换新 run，旧投影里的洞
 * 直接消失（reducer 划掉），不存在一个需要停留的「已填充」行。
 */
export const WorkflowRunHoleRow = memo(function WorkflowRunHoleRow({
  className,
  hole,
  now,
  onOpenRun,
}: {
  /** 落位由调用方给（详情页清单 / 编排面板行下，缩进各不相同）。 */
  className?: string;
  hole: WorkflowRunPendingHole;
  /** 由清单的定时器喂进来的"现在"：停驻中的 run 不发事件，等待时长必须自己走表。 */
  now: number;
  /** 「打开运行」；缺席即不渲染按钮（回调的存在本身就是门控，与问题行同一条规则）。 */
  onOpenRun?: () => void;
}) {
  const { intl } = useACodeIntl();
  // 等待时长复用升级问题那套阶梯（sidePane.time.*）：同一个"等了多久"不该有两套文案。
  // askedAt 缺席（老 journal 重放）时整段不渲染——head 退到 untimed 变体，绝不编一个"刚刚"。
  const waited = workflowRunQuestionWaitedLabel(hole.askedAt, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );
  const head =
    waited === undefined
      ? intl.formatMessage(
          { id: "chat.toolCall.workflow.hole.head.title.untimed" },
          { stage: hole.stage },
        )
      : intl.formatMessage(
          { id: "chat.toolCall.workflow.hole.head.title" },
          { stage: hole.stage, time: waited },
        );

  return (
    <div
      className={
        "mt-1 flex min-w-0 items-start gap-2 rounded-lg bg-[var(--color-interaction-confirmation-surface)] px-2 py-1.5 text-ui-sm text-[var(--color-interaction-confirmation-foreground)]" +
        (className === undefined ? "" : ` ${className}`)
      }
      data-hole-id={hole.holeId}
      data-testid="workflow-run-hole"
    >
      <PuzzleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="break-words font-medium">{head}</span>
        {/* prompt 是作者写的人话（含插值后的进展账目），按正文排版并夹到两行：
            它的作用是让读者认出"哦是这一步"，不是全文阅读——全文在脚本里。 */}
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-ui-xs opacity-80">
          <span className="mr-1 opacity-70">
            {intl.formatMessage({ id: "chat.toolCall.workflow.hole.promptLabel" })}
          </span>
          {hole.prompt}
        </p>
      </div>
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-ui-xs">
        {/* 站点 id 是主代理 FillWorkflowHole 要用的定位 token；显示出来才"指着它说"得成。 */}
        <span className="opacity-70">{hole.holeId}</span>
        {onOpenRun === undefined ? null : (
          <Button
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.hole.open" })}
            className="text-[var(--color-interaction-confirmation-foreground)] underline-offset-2 hover:bg-transparent hover:underline"
            data-testid="workflow-run-hole-open"
            onClick={onOpenRun}
            size="xs"
            type="button"
            variant="ghost"
          >
            {intl.formatMessage({ id: "chat.toolCall.workflow.hole.open" })}
          </Button>
        )}
      </span>
    </div>
  );
});

/** 停驻中 run 恰恰不发事件，等待时长要自己走表；间隔与升级问题清单同一档（30s）。 */
const HOLE_TICK_MS = 30_000;

/**
 * 停驻洞清单：`run.pendingHoles` 的「无则缺席」区（零条时整个组件不渲染，与
 * `pendingQuestions` 同一条惯例——不是给一个没人停驻的 run 留一节空壳）。
 *
 * 定时器只在有洞时存在；`onOpenRun` 在场时每行带「打开运行」（走宿主既有的
 * onOpenWorkflowRun 链），缺席时行是纯展示。
 */
export const WorkflowRunHolesSection = memo(function WorkflowRunHolesSection({
  className,
  holes,
  onOpenRun,
}: {
  className?: string;
  holes: readonly WorkflowRunPendingHole[];
  /** 「打开运行」逐行接线（编排面板按 run 各自开）；缺席即全部纯展示。 */
  onOpenRun?: () => void;
}) {
  const { intl } = useACodeIntl();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (holes.length === 0) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), HOLE_TICK_MS);
    return () => clearInterval(timer);
  }, [holes.length]);

  if (holes.length === 0) return null;
  return (
    <section
      className={"flex flex-col gap-1 px-4 py-2" + (className === undefined ? "" : ` ${className}`)}
      data-testid="workflow-run-holes"
    >
      <span className="text-ui-xs font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waiting" })}
      </span>
      {holes.map((hole) => (
        <WorkflowRunHoleRow
          hole={hole}
          key={hole.holeId}
          now={now}
          {...(onOpenRun === undefined ? {} : { onOpenRun })}
        />
      ))}
    </section>
  );
});
