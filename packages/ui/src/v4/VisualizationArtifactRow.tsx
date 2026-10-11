// 对话内可视化卡片（::visualize → artifactRow html）的沙箱渲染组件。
//
// 安全模型（specs/gen-ui-visualize-card.md 核心决策）纯逻辑都放在
// lib/visualizationSandbox.ts（可单测）：iframe 只开 allow-scripts、绝无
// allow-same-origin；srcdoc 自带 CSP（connect-src 'none'）；高度上报走
// postMessage 且父侧校验 event.source === iframe.contentWindow。仓库「禁止 iframe」
// 纪律（WorkflowArtifactBody）针对的是 allow-same-origin 逃逸组合，本卡片不触碰。
//
// 字节缓存只放组件 ref：artifactRow 是投影行，虚拟列表会复挂载；命中缓存不再
// 发 RPC，也不进全局 store（投影全量补拉的教训见 renderer-memory-budget.md）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartColumnIcon, RotateCcwIcon } from "lucide-react";
import { TID_V4_ROW, testId } from "@acode/shared";
import type { ArtifactRow } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildVisualizationSandboxDocument,
  fetchVisualizationFragment,
  parseVisualizationArtifactRef,
  readVisualizationThemeTokens,
  VISUALIZATION_IFRAME_SANDBOX,
  type ReadVisualizationChunk,
} from "@/lib/visualizationSandbox.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

/**
 * 宿主未注入读取通道（静态回放视图等）时的兜底：直接拒绝 → loadFailed 降级卡
 * （可见、可重试），不静默假成功。正常会话链路由 SessionPane 注入
 * rowContext.readVisualization（v4 conversationVisualizationRead）。
 */
const readVisualizationUnavailable: ReadVisualizationChunk = () =>
  Promise.reject(new Error("fault.visualization.readUnavailable"));

/** 首次高度上报前的初始高度（也用于重载时复位，避免闪出上一次的高度）。 */
const INITIAL_IFRAME_HEIGHT_PX = 240;
const MAX_REPORTED_HEIGHT_PX = 20_000;

type VisualizationLoadState =
  | { phase: "loading" }
  | { phase: "ready"; fragment: string }
  | { phase: "failed" }
  | { phase: "oversized" };

/**
 * 与 ConversationRowView.RowShell 同构的行壳。不复用那个本地组件是刻意的：
 * ConversationRowView 要 import 本组件做 artifactRow 分派，反向再取壳会构成模块
 * 循环依赖（仓库纪律禁止）；这里保持同样的 data-row-id / TID_V4_ROW 行标记。
 */
function VisualizationRowShell({
  rowId,
  className = "",
  children,
}: {
  rowId: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

export const VisualizationArtifactRow = memo(function VisualizationArtifactRow({
  row,
  context,
}: {
  row: ArtifactRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useACodeIntl();
  const identity = parseVisualizationArtifactRef(row.ref);
  const wide = row.meta?.visualization?.mode === "wide";
  const cardLabel = intl.formatMessage({ id: "chat.visualize.card" });
  const title = row.displayName.trim() || cardLabel;
  const wideLabel = intl.formatMessage({ id: "chat.visualize.wide" });
  const loadFailedLabel = intl.formatMessage({ id: "chat.visualize.loadFailed" });
  const retryLabel = intl.formatMessage({ id: "chat.visualize.retry" });
  const oversizedLabel = intl.formatMessage({ id: "chat.visualize.oversized" });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const fragmentCacheRef = useRef<{ key: string; fragment: string } | null>(null);
  const [state, setState] = useState<VisualizationLoadState>({ phase: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const [height, setHeight] = useState(INITIAL_IFRAME_HEIGHT_PX);
  const [themeVariables, setThemeVariables] = useState("");

  const cacheKey = identity ? `${identity.sessionId}/${identity.name}` : null;
  // 通道：宿主注入的 rowContext.readVisualization（SessionPane 已接线）；
  // 缺席时直接拒绝 → loadFailed 降级卡，不会静默假成功。
  const readChunk: ReadVisualizationChunk =
    context.readVisualization ?? readVisualizationUnavailable;

  useEffect(() => {
    if (!identity || cacheKey === null) return;
    const cached = fragmentCacheRef.current;
    if (cached && cached.key === cacheKey) {
      setState({ phase: "ready", fragment: cached.fragment });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ phase: "loading" });
    void fetchVisualizationFragment(readChunk, identity, controller.signal).then(
      (result) => {
        if (cancelled) return;
        if ("oversized" in result) {
          setState({ phase: "oversized" });
          return;
        }
        fragmentCacheRef.current = { key: cacheKey, fragment: result.fragment };
        setState({ phase: "ready", fragment: result.fragment });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ phase: "failed" });
        logger.warn("[v4-visualization] failed to read visualization fragment", {
          error: error instanceof Error ? error.message : String(error),
          name: identity.name,
        });
      },
    );
    return () => {
      // 卸载即中断在途分块，不让滚动出视口的行继续占用 IPC。
      cancelled = true;
      controller.abort();
    };
    // readChunk 随 rowContext 引用稳定（宿主 memo 依赖）；retryCount 是显式重试信号。
  }, [cacheKey, identity, readChunk, retryCount]);

  // 主题 token：从卡片容器 computed style 取值；dark class 翻转不改变本组件 props，
  // 用根元素 class/style 的 MutationObserver 捕获主题切换后重新读取。
  useEffect(() => {
    const readTokens = () => {
      const element = containerRef.current;
      if (element) setThemeVariables(readVisualizationThemeTokens(element));
    };
    readTokens();
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(readTokens);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);

  // 高度上报：只接受来自本卡 iframe 的消息（event.source 校验），消息体不合法即丢弃。
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (typeof data !== "object" || data === null || data.type !== "acode-viz-height") return;
      if (typeof data.height !== "number" || !Number.isFinite(data.height) || data.height < 0) {
        return;
      }
      setHeight(Math.min(Math.ceil(data.height), MAX_REPORTED_HEIGHT_PX));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const srcDoc = useMemo(
    () =>
      state.phase === "ready"
        ? buildVisualizationSandboxDocument(state.fragment, themeVariables)
        : null,
    [state, themeVariables],
  );

  // 文档重载（主题变化触发 srcDoc 重建）时复位高度，等待新一轮上报。
  useEffect(() => {
    setHeight(INITIAL_IFRAME_HEIGHT_PX);
  }, [srcDoc]);

  const handleRetry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  if (!identity) {
    // 分派层已按 ref 前缀过滤；走到这里说明 row 在传输途中被改坏，按读取失败降级。
    return (
      <VisualizationRowShell rowId={row.rowId} className="px-4 py-1">
        <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle">
          {loadFailedLabel}
        </div>
      </VisualizationRowShell>
    );
  }

  return (
    <VisualizationRowShell rowId={row.rowId} className={cn("py-1", wide ? "px-0" : "px-4")}>
      <div
        ref={containerRef}
        data-v4-visualization-card="true"
        data-v4-visualization-mode={wide ? "wide" : "standard"}
        className="flex w-full flex-col overflow-hidden rounded-xl border border-card-border bg-card"
      >
        <div className="flex items-center gap-2 border-b border-card-border px-3 py-2">
          <ChartColumnIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
            {title}
          </p>
          {wide ? (
            <span className="shrink-0 text-ui-sm text-foreground-subtlest">{wideLabel}</span>
          ) : null}
        </div>
        {state.phase === "ready" && srcDoc !== null ? (
          // 高度钳制在滚动容器上：iframe 自身按上报高度撑开，超出的部分卡片内滚动。
          <div
            className="max-h-[640px] overflow-y-auto overscroll-contain"
            data-v4-visualization-scroll="true"
          >
            <iframe
              ref={iframeRef}
              title={title}
              sandbox={VISUALIZATION_IFRAME_SANDBOX}
              srcDoc={srcDoc}
              style={{ height: `${height}px` }}
              className="block w-full border-0 bg-card"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : state.phase === "loading" ? (
          <div className="h-40 w-full animate-pulse bg-surface" aria-busy="true" />
        ) : state.phase === "oversized" ? (
          <div className="flex items-center gap-2 px-3 py-3 text-ui-sm text-foreground-subtle">
            {oversizedLabel}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 px-3 py-3">
            <span className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
              {loadFailedLabel}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetry}
              data-testid={`v4-visualization-retry-${row.rowId}`}
            >
              <RotateCcwIcon data-icon="inline-start" className="size-3" aria-hidden="true" />
              {retryLabel}
            </Button>
          </div>
        )}
      </div>
    </VisualizationRowShell>
  );
});
