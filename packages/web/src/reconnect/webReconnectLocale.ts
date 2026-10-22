/**
 * Web 入口断线态文案表（specs/web-reconnect.md）。
 *
 * 为什么不复用 `@acode/ui` 的 `ACodeIntlProvider` / `useACodeIntl`：断线态 overlay 由入口
 * `bootstrapWebApp` 命令式渲染，且 WS 断开时 services 已不可用——IntlProvider 需要 settingService /
 * broadcastService 才能挂载。这里沿用本包**既有入口层 i18n 约定**（`auth/webAuthLocale.ts`、
 * `WebBootstrapErrorScreen`）：集中式 locale 表按 navigator/document 语言选词，不硬编码内联文案，
 * 也不新增第二份散落字符串。
 */
type WebReconnectLocale = "zh-CN" | "en-US";

interface WebReconnectCopy {
  /** overlay 标题：连接已断开。 */
  disconnectedTitle: string;
  /** overlay 说明：正在自动重连。 */
  reconnectingDescription: string;
  /** 手动重试按钮（达上限 / 用户主动触发）。 */
  retryAction: string;
  /** 达到自动重连上限后的说明。 */
  exhaustedDescription: string;
  /** 退避倒计时提示模板，{seconds} 由调用方替换。 */
  retryCountdown: string;
}

const WEB_RECONNECT_COPY = {
  "zh-CN": {
    disconnectedTitle: "连接已断开",
    reconnectingDescription: "正在尝试重新连接服务器，请稍候。",
    retryAction: "重新连接",
    exhaustedDescription: "自动重连已达上限，请检查网络后手动重试。",
    retryCountdown: "将在 {seconds} 秒后重试",
  },
  "en-US": {
    disconnectedTitle: "Connection lost",
    reconnectingDescription: "Reconnecting to the server, please wait.",
    retryAction: "Reconnect",
    exhaustedDescription:
      "Automatic reconnection reached its limit. Check your network and retry manually.",
    retryCountdown: "Retrying in {seconds}s",
  },
} satisfies Record<WebReconnectLocale, WebReconnectCopy>;

/**
 * 解析当前语言：与 `resolveWebAuthLocale` 同一优先级（documentElement.lang → navigator.language
 * → navigator.languages[0]），保证入口各处语言判定一致。
 */
export function resolveWebReconnectLocale(language?: string): WebReconnectLocale {
  // 守卫 document/navigator：overlay 会在 Node 测试环境（renderToStaticMarkup）渲染，
  // 那里没有 document；navigator.language 也可能缺失。各分支归一为 string | undefined，
  // 末尾 `?? ""` 兜底，保证 locale 判定在浏览器与测试环境都不抛。
  const candidate =
    language ??
    (typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined) ??
    (typeof navigator !== "undefined" ? navigator.language ?? navigator.languages?.[0] : undefined);
  return (candidate ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebReconnectCopy(
  locale: WebReconnectLocale = resolveWebReconnectLocale(),
): WebReconnectCopy {
  return WEB_RECONNECT_COPY[locale];
}

/** 把 {seconds} 占位替换为实际秒数（与 ui 的 formatMessage 占位替换同语义）。 */
export function formatRetryCountdown(copy: WebReconnectCopy, seconds: number): string {
  return copy.retryCountdown.replaceAll("{seconds}", String(seconds));
}
