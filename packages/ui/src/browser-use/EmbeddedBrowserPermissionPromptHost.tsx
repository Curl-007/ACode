import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { embeddedBrowserPermissionLabelId } from "@/lib/embeddedBrowserPermissionPresentation.js";
import {
  useEmbeddedBrowserPermissionPromptStore,
  type EmbeddedBrowserPermissionPrompt,
} from "@/store/embeddedBrowserPermissionPromptStore.js";

/**
 * 嵌入式浏览器站点权限弹窗的宿主（packages/desktop/specs/embedded-browser-site-permissions.md
 * 的 UI 部分）。
 *
 * 数据链：main 权限策略 → preload 暴露的 `window.acode.onEmbeddedBrowserPermissionPrompt` →
 * 本组件入队（store）→ 用户四档动作 → `window.acode.resolveEmbeddedBrowserPermission` →
 * main 写 store / session 集 / 无。`window.acode` 的完整类型声明在 desktop renderer 侧，
 * ui 包单独 typecheck 拿不到——这里按 `logger.ts` 的先例用**局部结构类型**承接（只声明
 * 本组件消费的两个成员，缺任一即视为平台不支持，静默不挂弹窗）。
 *
 * 挂在 `RootShell`（app 容器层）：main 把 prompt 发到嵌入浏览器所在窗口，本组件随窗口级
 * 根布局常驻，human Browser tab 与 agent browser-use tab 的请求都落在同一处。
 */
interface EmbeddedBrowserPermissionBridge {
  onEmbeddedBrowserPermissionPrompt?: (
    callback: (payload: EmbeddedBrowserPermissionPrompt) => void,
  ) => () => void;
  resolveEmbeddedBrowserPermission?: (payload: {
    requestId: string;
    action: EmbeddedBrowserPermissionActionValue;
  }) => void;
}

type EmbeddedBrowserPermissionBridgeWindow = Window & { acode?: EmbeddedBrowserPermissionBridge };

/** 四档动作（与 shared 平台类型的闭集同形；这里是 UI 侧的局部镜像，不 import shared 之外的实现）。 */
type EmbeddedBrowserPermissionActionValue =
  | "allow-always"
  | "allow-session"
  | "block-always"
  | "deny-once";

const PERMISSION_ACTIONS: ReadonlyArray<{
  action: EmbeddedBrowserPermissionActionValue;
  messageId: string;
  tone: "primary" | "outline" | "ghost";
}> = [
  { action: "allow-always", messageId: "browser.permission.action.allowAlways", tone: "primary" },
  { action: "allow-session", messageId: "browser.permission.action.allowSession", tone: "outline" },
  { action: "block-always", messageId: "browser.permission.action.blockAlways", tone: "outline" },
  { action: "deny-once", messageId: "browser.permission.action.denyOnce", tone: "ghost" },
];

function resolveBridge(): EmbeddedBrowserPermissionBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as EmbeddedBrowserPermissionBridgeWindow).acode;
  return typeof bridge?.onEmbeddedBrowserPermissionPrompt === "function" &&
    typeof bridge.resolveEmbeddedBrowserPermission === "function"
    ? bridge
    : undefined;
}

/** 可询问权限闭集 → i18n 键（映射单点在 lib）；集合外回退原文，不谎译。 */
function permissionLabel(
  permission: string,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const messageId = embeddedBrowserPermissionLabelId(permission);
  return messageId === undefined ? permission : formatMessage({ id: messageId });
}

export function EmbeddedBrowserPermissionPromptHost() {
  const { intl } = useACodeIntl();
  const prompts = useEmbeddedBrowserPermissionPromptStore((state) => state.prompts);
  const pushPrompt = useEmbeddedBrowserPermissionPromptStore((state) => state.pushPrompt);
  const settlePrompt = useEmbeddedBrowserPermissionPromptStore((state) => state.settlePrompt);
  // 「已按始终档保存」的轻反馈：应答后留一行短提示再淡出（spec i18n 的 saved 键）。
  const [savedNotice, setSavedNotice] = useState(false);
  const savedTimerRef = useRef<number | null>(null);
  const format = intl.formatMessage.bind(intl);

  const resolve = useCallback(
    (requestId: string, action: EmbeddedBrowserPermissionActionValue) => {
      const bridge = resolveBridge();
      bridge?.resolveEmbeddedBrowserPermission?.({ requestId, action });
      settlePrompt(requestId);
      if (action === "allow-always" || action === "block-always") {
        if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
        setSavedNotice(true);
        savedTimerRef.current = window.setTimeout(() => setSavedNotice(false), 2500);
      }
    },
    [settlePrompt],
  );

  useEffect(() => {
    const bridge = resolveBridge();
    if (bridge === undefined) return undefined;
    const dispose = bridge.onEmbeddedBrowserPermissionPrompt?.((payload) => {
      // 队列过载被挤掉的请求必须立刻按 deny-once 结算，否则它在 main 里永远悬着。
      const evicted = pushPrompt(payload);
      if (evicted !== undefined) {
        logger.warn("[embedded-browser-permission] 未决弹窗过载，最旧请求按拒绝结算", {
          origin: evicted.origin,
          permission: evicted.permission,
          requestId: evicted.requestId,
        });
        bridge.resolveEmbeddedBrowserPermission?.({
          requestId: evicted.requestId,
          action: "deny-once",
        });
      }
    });
    return () => {
      dispose?.();
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, [pushPrompt]);

  if (prompts.length === 0 && !savedNotice) return null;
  return (
    <div
      aria-label={format({ id: "browser.permission.promptAriaLabel" })}
      className="pointer-events-none fixed left-1/2 top-3 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-3"
      data-testid="embedded-browser-permission-prompts"
    >
      {savedNotice && prompts.length === 0 ? (
        <div
          className="pointer-events-auto rounded-xl border border-border bg-popover px-3 py-2 text-ui-sm text-foreground-subtle shadow-xs"
          data-testid="embedded-browser-permission-saved"
          role="status"
        >
          {format({ id: "browser.permission.saved" })}
        </div>
      ) : null}
      {prompts.map((prompt, index) => (
        <EmbeddedBrowserPermissionPromptCard
          key={prompt.requestId}
          index={index}
          onResolve={resolve}
          prompt={prompt}
        />
      ))}
    </div>
  );
}

function EmbeddedBrowserPermissionPromptCard({
  index,
  onResolve,
  prompt,
}: {
  /** 卡片在队列里的序号，键盘快捷键 1..n 用。 */
  index: number;
  onResolve: (requestId: string, action: EmbeddedBrowserPermissionActionValue) => void;
  prompt: EmbeddedBrowserPermissionPrompt;
}) {
  const { intl } = useACodeIntl();
  const format = intl.formatMessage.bind(intl);
  // `media` 请求按 mediaTypes 细分后展示（camera+microphone 时两个名字都念出来）。
  const shownPermissions =
    prompt.mediaTypes !== undefined && prompt.mediaTypes.length > 0
      ? prompt.mediaTypes.map((entry) => permissionLabel(entry, format))
      : [permissionLabel(prompt.permission, format)];

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onResolve(prompt.requestId, "deny-once");
      return;
    }
    const shortcut = Number(event.key);
    const shortcutAction =
      Number.isInteger(shortcut) && shortcut >= 1 && shortcut <= PERMISSION_ACTIONS.length
        ? PERMISSION_ACTIONS[shortcut - 1]
        : undefined;
    if (!event.altKey && !event.ctrlKey && !event.metaKey && shortcutAction !== undefined) {
      event.preventDefault();
      onResolve(prompt.requestId, shortcutAction.action);
    }
  };

  return (
    <div
      className="pointer-events-auto w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-xs"
      data-permission={prompt.permission}
      data-request-id={prompt.requestId}
      data-testid="embedded-browser-permission-prompt"
      onKeyDown={handleKeyDown}
      role="dialog"
      tabIndex={-1}
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
              {format({ id: "browser.permission.promptAriaLabel" })}
            </p>
            {/* 主句：origin（等宽、可换行——来源是要被核对的身份，不能截断）+ 想要使用 + 权限名。 */}
            <p className="mt-1 text-ui-base leading-5 text-foreground">
              <span className="break-all font-mono text-ui-sm">{prompt.origin}</span>
              <span className="mx-1">{format({ id: "browser.permission.wantsToUse" })}</span>
              <span className="font-medium">{shownPermissions.join(" / ")}</span>
            </p>
          </div>
          <button
            aria-label={format({ id: "browser.permission.close" })}
            className="shrink-0 rounded-md p-1 text-foreground-subtlest outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            data-testid="embedded-browser-permission-close"
            onClick={() => onResolve(prompt.requestId, "deny-once")}
            type="button"
          >
            <XIcon aria-hidden className="size-4" />
          </button>
        </div>
        <div
          aria-label={format({ id: "browser.permission.promptAriaLabel" })}
          className="space-y-1"
          role="listbox"
        >
          {PERMISSION_ACTIONS.map((entry, actionIndex) => (
            <button
              aria-label={format({ id: entry.messageId })}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected hover:bg-hover",
                entry.tone === "primary" && "font-medium",
              )}
              data-permission-action={entry.action}
              data-testid="embedded-browser-permission-action"
              key={entry.action}
              onClick={() => onResolve(prompt.requestId, entry.action)}
              role="option"
              aria-selected={false}
              tabIndex={actionIndex === 0 ? 0 : -1}
              type="button"
            >
              <span className="w-5 shrink-0 self-center text-ui-base font-medium text-foreground-subtlest">
                {index * PERMISSION_ACTIONS.length + actionIndex + 1 > 9
                  ? actionIndex + 1
                  : index * PERMISSION_ACTIONS.length + actionIndex + 1}
                .
              </span>
              <span className="min-w-0 flex-1 text-ui-base text-foreground">
                {format({ id: entry.messageId })}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
