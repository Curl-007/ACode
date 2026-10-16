// 轮尾收尾卡（packages/ui/specs/turn-wrap-up-card.md）：recap + 「下一步」强调框 +
// 建议任务卡（title/tldr，可展开 prompt；动作 = 发起为新任务 / 复制 prompt）。
// 数据面：resolveTurnWrapUpCard（turnWrapUpCards.ts）在轮收口后派生，本组件无数据状态；
// 建议卡 prompt 的展开/收起是纯 UI 局部态。降级：卡片只在载荷解析成功时存在
// （resolver 已保证），渲染期绝不抛。
import { useState } from "react";
import { ArrowRightIcon, ChevronRightIcon, CopyIcon, SparklesIcon } from "lucide-react";
import type { TurnWrapUpFollowUpSuggestion } from "@acode/shared/acode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useTurnWrapUpSuggestedTask } from "@/hooks/useTurnWrapUpSuggestedTask.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { TurnWrapUpTurnCard } from "@/v4/turnWrapUpCards.js";
import { TURN_WRAP_UP_LABEL_KEYS, formatTurnWrapUpLabel } from "@/v4/turnWrapUpLabels.js";

export function ConversationTurnWrapUpCard({
  card,
  context,
}: {
  card: TurnWrapUpTurnCard;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useACodeIntl();
  const followUp = card.payload.followUpSuggestion;
  return (
    <div
      data-testid="conversation-turn-wrap-up-card"
      className="my-1 w-full rounded-xl border border-border/70 bg-card/70 px-3 py-3 shadow-sm backdrop-blur-sm"
    >
      <div className="text-ui-sm leading-relaxed text-foreground-subtle">{card.payload.recap}</div>
      <div className="mt-2 flex items-start gap-2 rounded-lg bg-accent/50 px-3 py-2">
        <ArrowRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-icon-blue" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {formatTurnWrapUpLabel(intl, TURN_WRAP_UP_LABEL_KEYS.nextStep)}
          </div>
          <div className="mt-0.5 text-ui-base break-words text-foreground">
            {card.payload.nextStep}
          </div>
        </div>
      </div>
      {followUp ? (
        <TurnWrapUpSuggestedTask
          followUp={followUp}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
        />
      ) : null}
    </div>
  );
}

function TurnWrapUpSuggestedTask({
  followUp,
  workspacePath,
  workspaceIdentity,
}: {
  followUp: TurnWrapUpFollowUpSuggestion;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useACodeIntl();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const { copyPrompt, startAsNewTask } = useTurnWrapUpSuggestedTask(
    workspacePath,
    workspaceIdentity,
  );
  return (
    <div
      data-testid="conversation-turn-wrap-up-suggested-task"
      className="mt-3 rounded-lg border border-border/60 bg-surface px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <SparklesIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-icon-blue" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-xs text-foreground-subtlest">
            {formatTurnWrapUpLabel(intl, TURN_WRAP_UP_LABEL_KEYS.suggestedTask)}
          </div>
          <div className="mt-0.5 text-ui-sm font-medium break-words text-foreground">
            {followUp.title}
          </div>
          <div className="mt-0.5 text-ui-sm break-words text-foreground-subtle">
            {followUp.tldr}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setPromptExpanded((expanded) => !expanded)}
        aria-expanded={promptExpanded}
        className="mt-2 inline-flex max-w-full items-center gap-1 text-ui-sm text-foreground-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", promptExpanded && "rotate-90")}
        />
        <span>
          {formatTurnWrapUpLabel(
            intl,
            promptExpanded
              ? TURN_WRAP_UP_LABEL_KEYS.hidePrompt
              : TURN_WRAP_UP_LABEL_KEYS.showPrompt,
          )}
        </span>
      </button>
      {promptExpanded ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card px-2 py-2 text-ui-xs text-foreground-subtle">
          {followUp.prompt}
        </pre>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="conversation-turn-wrap-up-start-task"
          className="h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground"
          onClick={() => startAsNewTask(followUp.prompt)}
        >
          {formatTurnWrapUpLabel(intl, TURN_WRAP_UP_LABEL_KEYS.startAsNewTask)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="conversation-turn-wrap-up-copy-prompt"
          className="h-auto rounded-lg border-border/70 bg-transparent px-3 py-1.5 text-ui-base text-foreground hover:bg-hover hover:text-foreground"
          onClick={() => void copyPrompt(followUp.prompt)}
        >
          <CopyIcon aria-hidden className="size-3.5" />
          <span>{formatTurnWrapUpLabel(intl, TURN_WRAP_UP_LABEL_KEYS.copyPrompt)}</span>
        </Button>
      </div>
    </div>
  );
}
