import { Button } from "@acode/ui";
import { formatRetryCountdown, getWebReconnectCopy } from "./webReconnectLocale.js";
import type { WebReconnectState } from "./webSocketReconnect.js";

/**
 * Web 入口断线态 overlay（specs/web-reconnect.md）。
 *
 * 覆盖在死界面上，告知用户连接状态并提供手动重试。遵守 DESIGN.md：
 * - dialog shell 用 `rounded-2xl`（Dialogs 规则）+ `bg-popover border-popover-border`（overlay 表面）；
 * - 排版走 `text-ui-*` 尺度（标题 text-ui-lg、正文 text-ui-sm、倒计时 text-ui-sm）；
 * - 状态点 `bg-destructive` 配可读文案（不只靠颜色传义）；
 * - 手动重试复用 `@acode/ui` 的 `Button`（与本包 WebCallbackPage 同一范式）：可见焦点、圆角、
 *   primary 变体全部走既有基座——仓库全局 `*:focus-visible{box-shadow:none}` 会压掉 ring，
 *   Button 的焦点态用 border-color，故不自建 focus 样式。
 */
export function WebDisconnectOverlay({
  state,
  onRetry,
}: {
  state: WebReconnectState;
  onRetry: () => void;
}) {
  const copy = getWebReconnectCopy();
  const exhausted = state.phase === "exhausted";
  const waiting = state.phase === "waiting";
  // connecting 阶段禁用手动重试：一次 connect 已在途，再触发 retryNow 会换代控制器并泄漏孤儿 socket
  //（specs/web-reconnect.md R3.4/R5.4/R7）。入口 retryNow 也做了同守卫，双保险。
  const connecting = state.phase === "connecting";
  const countdown =
    waiting && state.retryInMs > 0
      ? formatRetryCountdown(copy, Math.max(1, Math.ceil(state.retryInMs / 1000)))
      : null;
  const description = exhausted ? copy.exhaustedDescription : copy.reconnectingDescription;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm"
    >
      <section className="w-full max-w-sm rounded-2xl border border-popover-border bg-popover p-5 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="size-2 shrink-0 rounded-full bg-destructive" />
          <h1 className="text-ui-lg font-medium text-foreground">{copy.disconnectedTitle}</h1>
        </div>
        <p className="mt-2 text-ui-sm/relaxed text-foreground-subtle">{description}</p>
        {countdown ? <p className="mt-1 text-ui-sm text-foreground-subtlest">{countdown}</p> : null}
        <Button type="button" size="lg" className="mt-4 w-full" onClick={onRetry} disabled={connecting}>
          {copy.retryAction}
        </Button>
      </section>
    </div>
  );
}
