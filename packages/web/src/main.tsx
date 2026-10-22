/* Web 入口：只做启动/连接编排（bootstrap、OAuth callback 路由、WS 重连、Root 挂载）。
   平台适配器工厂已抽出到 webPlatform.ts、重连控制器/overlay/i18n 在 reconnect/，
   本文件回落到 400 行闸以下，故不再需要 max-lines 豁免（2026-10-22 review 修复批次）。 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ACodeIntlProvider,
  generateMobileDeviceFingerprint,
  setStreamClientId,
  type Theme,
} from "@acode/ui";
import "@acode/ui/styles.css";
import { connectViaWebSocket } from "@acode/client";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import type { ServerRemoteInfo } from "@acode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";
import { createWebPlatform } from "./webPlatform.js";
import {
  createWebReconnectController,
  WebDisconnectOverlay,
  type WebReconnectController,
  type WebReconnectState,
} from "./reconnect/index.js";

/** connectViaWebSocket 成功返回的 services 门面类型（web 包不直接依赖 @acode/services）。 */
type WebServices = Awaited<ReturnType<typeof connectViaWebSocket>>;

function resolveWebThemePreference(defaultTheme: Theme = WEB_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("acode-theme");
  return resolveWebInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 store（packages/ui/src/store/index.ts 的 setTheme，
// acode-theme 的唯一写入口，走广播防回环）接管；不再由 useTheme hook 接管。
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  const saved = resolveWebThemePreference();
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ACode - Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/");
      }}
    />,
  );
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "ACode - Web";
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

/** 渲染正常 app（连接可用）：复用 web-remote-replayable 恢复路径，重挂 Root 即从 server 快照重建。 */
function renderWebApp(services: WebServices, bootstrap: WebBootstrapResult): void {
  const platform = createWebPlatform();
  document.title = "ACode - Web + Server";
  root.render(
    <AppErrorBoundary>
      <ACodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <Root
          services={services}
          platform={platform}
          initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
          initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
          initialTaskId={bootstrap.initialTaskId}
          restoreSession={bootstrap.restoreSession}
          allowOpenWorkspace={bootstrap.allowOpenWorkspace}
          preferDirectoryBrowser
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
        />
      </ACodeIntlProvider>
    </AppErrorBoundary>,
  );
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  // R2-05 修复：此前 `onClose: () => {}` 空实现——WS 断开后 Web 入口不重连、不提示，用户停在
  // 死界面。现在 onClose 触发有上限的指数退避重连 + 断线态 overlay；重连成功用新 services 重挂
  // Root，经既有 web-remote-replayable 快照/resume 路径恢复会话（services 侧语义已齐备，不改）。
  let controller: WebReconnectController | null = null;

  /** 建立一次 WS 连接；onClose 在「首次连接就绪后」才驱动重连（此时 controller 已存在）。 */
  const establish = (): Promise<WebServices> =>
    connectViaWebSocket(bootstrap.wsUrl, { onClose: () => controller?.start() });

  // 首次连接：controller 尚未创建，onClose 是 no-op；就绪前失败 → reject → bootstrap 错误屏
  // （保持既有首连失败语义，不进入重连循环）。
  let services: WebServices;
  try {
    services = await establish();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  /** 建立一个重连控制器（首次连接后、以及手动重试时各建一个；旧控制器先 cancel 再替换）。 */
  const makeController = (): WebReconnectController =>
    createWebReconnectController<WebServices>({
      connect: establish,
      onReconnected: (next) => renderWebApp(next, bootstrap),
      onStateChange: (state: WebReconnectState) => {
        if (state.phase === "reconnected") {
          return; // 由 onReconnected 重挂 app，避免与 overlay 抢同一帧。
        }
        root.render(<WebDisconnectOverlay state={state} onRetry={retryNow} />);
      },
    });

  /** 手动重试：取消当前循环、重置退避计数、立即重新发起（exhausted / 用户主动触发用）。 */
  function retryNow(): void {
    controller?.cancel();
    controller = makeController();
    controller.start();
  }

  controller = makeController();
  renderWebApp(services, bootstrap);

  // 页面卸载时取消重连循环、清理挂起 timer，防定时器泄漏（AGENTS.md 生命周期约束）。
  window.addEventListener("pagehide", () => controller?.cancel(), { once: true });
}

void bootstrapWebApp();
