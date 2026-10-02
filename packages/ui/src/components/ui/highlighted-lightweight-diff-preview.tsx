import { useEffect, useMemo, useState, type HTMLAttributes } from "react";
import type { BundledTheme, ThemedToken } from "shiki";
import {
  getLightweightDiffLineParts,
  LightweightDiffPreview,
} from "@/components/ui/lightweight-diff-preview.js";
import {
  highlightCode,
  shouldUseSyntaxHighlighting,
  type TokenizedCode,
} from "@/lib/shikiHighlighter.js";
import { logger } from "@/logger.js";
import { ensureDiffsWorkers } from "@/root/DiffsWorkerPoolProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";

const HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS = 120_000;

export function getHighlightedLightweightDiffLine(line: string) {
  const lineParts = getLightweightDiffLineParts(line);
  return {
    code: lineParts.content,
    marker: lineParts.marker,
  };
}

export function buildHighlightedLightweightDiffCode(lines: readonly string[]): string {
  return lines.map((line) => getHighlightedLightweightDiffLine(line).code).join("\n");
}

function useHighlightedLightweightDiffTokens({
  code,
  language,
  path,
  theme,
}: {
  code: string;
  language: string;
  path?: string;
  theme: BundledTheme;
}) {
  const [tokenizedCode, setTokenizedCode] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    setTokenizedCode(null);

    if (!code || code.length > HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS) {
      return;
    }

    const shouldHighlight = shouldUseSyntaxHighlighting(language);
    const startedAt = Date.now();
    let cancelled = false;

    if (shouldHighlight) {
      logger.debug("[HighlightedLightweightDiffPreview] 启动异步 diff 高亮", {
        chars: code.length,
        language,
        path,
        theme,
      });
    }

    // 首个轻量 diff 渲染是用户即将查看 diff 的信号,在此刻才物化 Diffs worker 池:
    // 池冷启动会一次性 spawn 4 个 worker(828KB bundle + shiki 引擎,多占 16-32MB
    // 进程内存),绝大多数启动会话在首个 diff 前完全不需要(spec 规则 6)。
    // ensure 幂等且永不 reject;物化失败时后续 @pierre/diffs 组件自动走主线程兜底,
    // 本组件的本地 shiki 高亮也不受影响。
    void (async () => {
      await ensureDiffsWorkers();
      if (cancelled) {
        return;
      }

      const tokenized = highlightCode(code, language, theme, (result) => {
        if (cancelled) {
          return;
        }

        if (shouldHighlight) {
          logger.debug("[HighlightedLightweightDiffPreview] 异步 diff 高亮完成", {
            durationMs: Date.now() - startedAt,
            language,
            path,
            theme,
          });
        }

        setTokenizedCode(result);
      });

      if (tokenized) {
        setTokenizedCode(tokenized);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, language, path, theme]);

  return tokenizedCode;
}

function renderHighlightedLightweightDiffTokens(tokens: readonly ThemedToken[] | undefined) {
  if (!tokens || tokens.length === 0) {
    return null;
  }

  return tokens.map((token, index) => (
    <span
      key={`${index}:${token.content}`}
      style={token.color ? { color: token.color } : undefined}
    >
      {token.content}
    </span>
  ));
}

function HighlightedLightweightDiffCodeLine({
  code,
  tokens,
}: {
  code: string;
  tokens?: readonly ThemedToken[];
}) {
  const tokenNodes = renderHighlightedLightweightDiffTokens(tokens);

  return <>{tokenNodes ?? (code || " ")}</>;
}

export interface HighlightedLightweightDiffPreviewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  codePreviewSettings: Pick<
    CodePreviewSettings,
    "fontSizePx" | "showLineNumbers" | "wrapLongLines"
  >;
  language: string;
  lines: readonly string[];
  path?: string;
  theme: BundledTheme;
}

export function HighlightedLightweightDiffPreview({
  codePreviewSettings,
  language,
  lines,
  path,
  theme,
  ...props
}: HighlightedLightweightDiffPreviewProps) {
  const highlightCodeText = useMemo(() => buildHighlightedLightweightDiffCode(lines), [lines]);
  const tokenizedCode = useHighlightedLightweightDiffTokens({
    code: highlightCodeText,
    language,
    path,
    theme,
  });

  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-lightweight-diff-highlight-language={language}
      data-lightweight-diff-highlight-theme={theme}
      data-lightweight-diff-highlighted={tokenizedCode ? "true" : "false"}
      lines={lines}
      renderLineContent={(line, index) => (
        <HighlightedLightweightDiffCodeLine
          code={line.content}
          tokens={tokenizedCode?.tokens[index]}
        />
      )}
      {...props}
    />
  );
}
