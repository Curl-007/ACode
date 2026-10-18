// read 工具卡的结构化事实徽章（specs/tool-display-read-search.md R4）。
// 从 read.tsx 拆出（该文件叠加 display 消费后越过 oxlint max-lines(400)，
// resolveRenderer.ts 拆分是同一先例）。
import type { ReactNode } from "react";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ReadToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

function ReadFactBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-foreground-subtle ring-1 ring-border">
      {label}
    </span>
  );
}

/**
 * display 命中的结构化事实徽章：行窗/总行、URL 直读的 HTTP 状态与缓存命中、
 * 冲突检出、折叠摘要、截断。行窗 chip 是符号化数字形态（对齐 renderDiffCount 的
 * +N −N 先例），文案类徽章走 i18n。
 */
export function buildReadFacts(
  intl: IntlInstance,
  display: ReadToolResultDisplay,
): ReactNode | null {
  const badges: ReactNode[] = [];
  if (display.numLines > 0) {
    const endLine = display.startLine + display.numLines - 1;
    badges.push(
      <ReadFactBadge
        key="range"
        label={
          display.totalLines > display.numLines
            ? `L${display.startLine}–${endLine} / ${display.totalLines}`
            : `L${display.startLine}–${endLine}`
        }
      />,
    );
  }
  if (display.url) {
    badges.push(<ReadFactBadge key="http" label={`HTTP ${display.url.status}`} />);
    if (display.url.cacheHit) {
      badges.push(
        <ReadFactBadge
          key="cache"
          label={intl.formatMessage({ id: "chat.toolCall.read.badge.urlCached" })}
        />,
      );
    }
  }
  if (display.conflicts) {
    badges.push(
      <ReadFactBadge
        key="conflicts"
        label={intl.formatMessage({ id: "chat.toolCall.read.badge.conflicts" })}
      />,
    );
  }
  if (display.summarized) {
    badges.push(
      <ReadFactBadge
        key="summarized"
        label={intl.formatMessage({ id: "chat.toolCall.read.badge.summarized" })}
      />,
    );
  }
  if (display.truncated) {
    badges.push(
      <ReadFactBadge
        key="truncated"
        label={intl.formatMessage({ id: "chat.toolCall.read.badge.truncated" })}
      />,
    );
  }
  if (badges.length === 0) {
    return null;
  }
  return <span className="inline-flex min-w-0 shrink-0 items-center gap-1">{badges}</span>;
}
