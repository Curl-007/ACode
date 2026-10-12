import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";

/**
 * execute 卡的命令折叠区（packages/ui/specs/chat-small-ux-file-icons.md §1）。
 *
 * 从 renderers/execute.tsx 拆出（max-file-lines 门）：阈值判定是纯函数供单测钉住，
 * 组件自带折叠态。折叠态是纯组件内 useState——不进 store、不进协议；快照回放重挂载后
 * 自然复位为折叠。阈值以下的短命令不渲染按钮（没有可折叠的东西）。
 */

/** 命令折叠的阈值：超过约 2 行（160 字符，或 ≥ 2 个换行即 3 行以上）就值得折叠。 */
const EXECUTE_COMMAND_COLLAPSE_CHARS = 160;

export function executeCommandNeedsCollapse(command: string | undefined): boolean {
  if (command === undefined) return false;
  return command.length > EXECUTE_COMMAND_COLLAPSE_CHARS || command.split("\n").length > 2;
}

export function ExecuteCommandArea({ command }: { command: string | undefined }) {
  const { intl } = useACodeIntl();
  const [expanded, setExpanded] = useState(false);
  if (command === undefined) return null;
  const collapsible = executeCommandNeedsCollapse(command);
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2 font-sans text-ui-base text-foreground">
        <span className="shrink-0 text-foreground-subtle">$</span>
        {/* 折叠态收成单行截断；展开态放开全部行。完整命令始终在同一文本节点里，
            折叠/展开往返只改容器裁剪，不重建内容（验收：往返不丢内容）。 */}
        <pre
          className={
            collapsible && !expanded
              ? "min-w-0 flex-1 block truncate whitespace-pre"
              : "min-w-0 flex-1 block max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
          }
          data-collapsed={collapsible && !expanded ? "true" : undefined}
          data-testid="execute-command-text"
        >
          {command}
        </pre>
      </div>
      {collapsible ? (
        <button
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-ui-xs text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="execute-command-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? (
            <ChevronUpIcon aria-hidden className="size-3" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-3" />
          )}
          {intl.formatMessage({
            id: expanded
              ? "chat.toolCall.execute.collapseCommand"
              : "chat.toolCall.execute.expandCommand",
          })}
        </button>
      ) : null}
    </div>
  );
}
