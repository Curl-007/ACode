/**
 * 页内查找栏（一期窗内 overlay 形态，specs: packages/desktop/specs/find-in-page.md）。
 *
 * 挂载点：RootShell 窗口级宿主（与 EmbeddedBrowserPermissionPromptHost 同层）。
 * 绝对定位于内容区顶部右侧（dialog 层 z-50 之下）；平台桥缺席（Web 端）或关闭态
 * 渲染 null。视觉语言复用 ModelTrajectorySearchBar（popover 表面 + ghost icon-xs 按钮）。
 * 已知边界：一期 overlay 与被搜内容同 webContents，Chromium 查找可能匹配到查找栏
 * 自身渲染的计数文本；input 的 value/placeholder 不参与匹配。
 */
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { FIND_IN_PAGE_BINDINGS } from "@/shortcuts/findInPageBindings.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { shouldShowFindCounter } from "./findInPageModel.js";
import { useFindInPageOverlay } from "./useFindInPageOverlay.js";

/**
 * en 回退表：IntlInstance.formatMessage 未命中时原样返回 id，以 id 往返探测后回退。
 * 键已在 i18n/locales/{en-US,zh-CN}.ts 落库（findInPage.*），正常路径不会走到这里；
 * 保留本表是防御性兜底——locale 资源缺失/被裁剪时查找栏仍有可用文案，比裸 id 好。
 * 注意 counter 的回退文案与 locale 的英文文案（"{activeIndex} of {total}"）刻意不同：
 * 回退只求数字可读，不参与产品文案一致性。
 */
const MESSAGE_FALLBACKS: Readonly<Record<string, string>> = {
  "findInPage.label": "Find in page",
  "findInPage.previous": "Previous match",
  "findInPage.next": "Next match",
  "findInPage.close": "Close find bar",
  "findInPage.counter": "{activeIndex}/{total}",
};

/** 带 en 回退的取词器（{key} 占位替换与 IntlInstance.formatMessage 同语义）。 */
function useFindInPageMessages() {
  const { intl } = useACodeIntl();
  return useCallback(
    (id: string, values?: Record<string, string | number>): string => {
      const formatted = intl.formatMessage({ id }, values);
      if (formatted !== id) {
        return formatted;
      }
      const fallback = MESSAGE_FALLBACKS[id];
      if (fallback === undefined) {
        return id;
      }
      if (values === undefined) {
        return fallback;
      }
      let message = fallback;
      for (const [key, value] of Object.entries(values)) {
        message = message.replaceAll(`{${key}}`, String(value));
      }
      return message;
    },
    [intl],
  );
}

export function FindInPageOverlay() {
  const controller = useFindInPageOverlay();
  const message = useFindInPageMessages();
  const { supported, open, query, result } = controller;
  if (!supported || !open) {
    return null;
  }

  const counterVisible = shouldShowFindCounter(query, result !== null);
  const stepDisabled = !counterVisible || (result?.total ?? 0) === 0;
  const label = message("findInPage.label");
  const previousLabel = message("findInPage.previous");
  const nextLabel = message("findInPage.next");
  const closeLabel = message("findInPage.close");
  const previousTitle = `${previousLabel} (${formatShortcutBindingLabel(
    FIND_IN_PAGE_BINDINGS.previous,
  )})`;
  const nextTitle = `${nextLabel} (${formatShortcutBindingLabel(FIND_IN_PAGE_BINDINGS.next)})`;
  const closeTitle = `${closeLabel} (Esc)`;

  return (
    <div
      ref={controller.containerRef}
      data-find-in-page-overlay=""
      role="search"
      onMouseDown={controller.onContainerMouseDown}
      className="fixed top-14 right-4 z-40 flex h-9 w-80 items-center gap-1.5 rounded-xl border border-popover-border bg-popover px-2 shadow-md [app-region:no-drag]"
    >
      <SearchIcon className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <input
        ref={controller.inputRef}
        type="text"
        value={query}
        onChange={(event) => controller.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter = 下一处，Shift+Enter = 上一处；IME 组合确认的 Enter 不触发步进
          //（isComposing/keyCode 229 与 bindings.ts 内核同一噪声纪律）。
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) {
            return;
          }
          event.preventDefault();
          controller.step(!event.shiftKey);
        }}
        onBlur={controller.onInputBlur}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      {/* role=status + tabular-nums：计数播报与数值宽度稳定（第 N/共 M 处）。 */}
      <span
        role="status"
        className="min-w-10 shrink-0 text-right text-ui-xs tabular-nums text-foreground-subtle select-none"
      >
        {counterVisible && result !== null
          ? message("findInPage.counter", {
              activeIndex: result.activeIndex,
              total: result.total,
            })
          : ""}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={stepDisabled}
          aria-label={previousLabel}
          title={previousTitle}
          onClick={() => controller.step(false)}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={stepDisabled}
          aria-label={nextLabel}
          title={nextTitle}
          onClick={() => controller.step(true)}
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeLabel}
          title={closeTitle}
          onClick={controller.close}
        >
          <XIcon className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}
