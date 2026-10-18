import { SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SEARCH_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSearchPrimaryText(intl: IntlLike, input: unknown): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0
      ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed })
      : intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  if (!isPlainRecord(input)) {
    return intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  const parsedCmd = input.parsed_cmd;
  if (Array.isArray(parsedCmd)) {
    for (const item of parsedCmd) {
      if (!isPlainRecord(item) || typeof item.type !== "string") {
        continue;
      }

      if (item.type === "list_files") {
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim().replace(/\/+$/, "")
            : undefined;
        return cwd
          ? intl.formatMessage({ id: "chat.toolCall.search.listIn" }, { cwd })
          : intl.formatMessage({ id: "chat.toolCall.search.list" });
      }

      if (item.type === "search" || item.type === "grep" || item.type === "glob") {
        const candidate =
          typeof item.pattern === "string"
            ? item.pattern.trim()
            : typeof item.query === "string"
              ? item.query.trim()
              : typeof item.path === "string"
                ? item.path.trim()
                : "";
        return candidate.length > 0
          ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: candidate })
          : intl.formatMessage({ id: "chat.toolCall.search.find" });
      }
    }
  }

  for (const key of [
    "search_query",
    "searchQuery",
    "query",
    "pattern",
    "path",
    // WebFetch 同时带 url 和 prompt 时，权限/工具摘要展示 prompt 会遮住真正需要用户确认的目标地址。
    "url",
    "prompt",
    "target",
    "name",
  ] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed });
    }
  }

  return intl.formatMessage({ id: "chat.toolCall.search.find" });
}

export function SearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useACodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const searchPrimaryText = getSearchPrimaryText(intl, toolCall.input);
  const primaryText = useMemo(
    () => <span className="truncate">{searchPrimaryText}</span>,
    [searchPrimaryText],
  );
  // 结果事实行（specs/tool-display-read-search.md R4）：display 命中才渲染；
  // pattern 摘要仍来自 input 透传（input 本就结构化，display 不重复携带）。
  const secondaryText = useMemo(() => {
    if (isRunning) return undefined;
    const parsed = readToolResultDisplay(toolCall.raw);
    if (parsed?.kind !== "search") return undefined;
    const base =
      parsed.numMatches !== undefined
        ? intl.formatMessage(
            { id: "chat.toolCall.search.resultMeta" },
            { matches: String(parsed.numMatches), files: String(parsed.numFiles) },
          )
        : intl.formatMessage(
            { id: "chat.toolCall.search.filesMeta" },
            { files: String(parsed.numFiles) },
          );
    const suffix = parsed.truncated || parsed.filenamesTruncated ? "…" : "";
    return (
      <span className="truncate text-foreground-subtlest tabular-nums">
        {base}
        {suffix}
      </span>
    );
  }, [intl, isRunning, toolCall.raw]);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: isRunning ? "chat.toolCall.search.searching" : "chat.toolCall.kind.search",
          })
        }
        sourceLabel={context.sourceLabel}
        // search 的主文本直接拼成一句完整摘要，不再拆 secondaryText；
        // 这样能避免 title 干扰，也更适合列表/目录查询这类操作。
        // display 命中的结果事实（N 处匹配 · M 个文件）是例外：它只在终态出现。
        primaryText={primaryText}
        secondaryText={secondaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        content={null}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
      {/* <pre>{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
