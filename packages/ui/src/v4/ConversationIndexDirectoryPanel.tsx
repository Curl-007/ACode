// U07 长对话目录面板（specs/conversation-index-navigation.md）。
//
// 产品规则：目录只读 turn 轻量索引——**打开面板不产生任何 rowsRange 请求**，
// 不扫描正文，不读 renderUnits（那是既有 rail 的数据源，本面板与它并存不合并）。
// 点击项经 store.focusIndexedRow 定位窗口外正文；淘汰可识别（isPartial + evictedCount）。
import { memo, useCallback, useMemo } from "react";
import { CornerDownLeftIcon, ListIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import type { ConversationIndexFocusApi } from "@/hooks/useConversationIndexFocus.js";
import type { IndexDirectoryItem } from "@/v4/conversationIndexNavigation.js";

// 面板内可见条目上限：索引最多 8000 项，全量渲染会把目录本身变成新的性能问题。
// 虚拟列表不在本面板引入（面板是一次性选择入口，不是长列表浏览面）；改为有界渲染 +
// 明确提示「共 N 条，仅显示最近 M 条」，与「只承诺现有覆盖范围」的产品规则一致。
const DIRECTORY_VISIBLE_MAX_ITEMS = 300;

interface ConversationIndexDirectoryPanelProps {
  /** 目录与焦点的唯一来源（store 拥有；面板只读，不自行合并正文）。 */
  focusApi: ConversationIndexFocusApi;
  /** 目录打开期间正文仍在流式输出时，显示运行状态（U07-A2：运行状态保持可见）。 */
  isRunning?: boolean;
  className?: string;
}

function formatTimestamp(intl: IntlInstance, timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return intl.formatMessage({ id: "chat.indexDirectory.unknownTime" });
  }
  return new Date(timestamp).toLocaleString();
}

function DirectoryItemButton({
  item,
  active,
  index,
  total,
  onSelect,
}: {
  item: IndexDirectoryItem;
  active: boolean;
  index: number;
  total: number;
  onSelect: (rowId: number) => void;
}) {
  const { intl } = useACodeIntl();
  const handleClick = useCallback(() => onSelect(item.rowId), [item.rowId, onSelect]);
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-current={active ? "location" : undefined}
        aria-label={intl.formatMessage(
          { id: "chat.indexDirectory.jumpToQuery" },
          { index: String(index + 1), summary: item.summary },
        )}
        aria-posinset={index + 1}
        aria-setsize={total}
        data-testid={`v4-index-directory-item-${item.rowId}`}
        data-row-id={item.rowId}
        data-in-window={item.inWindow ? "true" : "false"}
        data-active={active ? "true" : "false"}
        className={cn(
          "h-auto w-full justify-start gap-2 whitespace-normal px-2 py-1.5 text-left",
          active && "bg-card-selected",
        )}
        onClick={handleClick}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-base text-foreground">{item.summary}</span>
          <span className="block text-ui-xs text-foreground-subtle">
            {formatTimestamp(intl, item.timestamp)}
            {item.inWindow
              ? ` · ${intl.formatMessage({ id: "chat.indexDirectory.inWindow" })}`
              : null}
          </span>
        </span>
        <CornerDownLeftIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-foreground-subtlest"
        />
      </Button>
    </li>
  );
}

function ConversationIndexDirectoryPanelImpl({
  focusApi,
  isRunning = false,
  className,
}: ConversationIndexDirectoryPanelProps) {
  const { intl } = useACodeIntl();
  // open 状态由 hook 单一拥有（不是本组件的 useState）：目录求值被 open 门控，
  // 关闭时零成本；若面板另存一份 open 就有两条写入路径（AGENTS.md：避免重复状态）。
  const { open, setOpen, directory, focus, focusIndexedRow, continueOlder, returnToLive } =
    focusApi;

  const visibleItems = useMemo(
    () => directory.items.slice(-DIRECTORY_VISIBLE_MAX_ITEMS),
    [directory.items],
  );
  const hiddenOlderCount = directory.items.length - visibleItems.length;
  const isLoading = focus.status === "loading";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
    },
    [setOpen],
  );

  const handleSelect = useCallback(
    (rowId: number) => {
      focusIndexedRow(rowId);
      // 选择后立即关闭面板：手机窄屏下正文可独立操作、目录不遮挡（U07-A5）；
      // 桌面同样受益——焦点正文一旦提交，滚动与「返回最新」都在主 timeline 上进行。
      setOpen(false);
    },
    [focusIndexedRow, setOpen],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-label={intl.formatMessage({ id: "chat.indexDirectory.label" })}
          title={intl.formatMessage({ id: "chat.indexDirectory.label" })}
          data-testid="v4-index-directory-trigger"
          className={cn("gap-1.5", className)}
        >
          <ListIcon aria-hidden="true" className="size-3.5" />
          <span className="hidden text-ui-base sm:inline">
            {intl.formatMessage({ id: "chat.indexDirectory.label" })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        data-testid="v4-index-directory-panel"
        className="w-80 max-w-[calc(100vw-2rem)] gap-2 p-2 sm:w-96"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className="text-ui-base font-semibold text-popover-foreground">
            {intl.formatMessage({ id: "chat.indexDirectory.label" })}
          </h2>
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.indexDirectory.count" },
              { count: String(directory.total) },
            )}
          </span>
        </div>

        {/* 淘汰可识别（spec 规则 6 / U07-A5）：只承诺现有覆盖范围，不假装完整。 */}
        {directory.isPartial ? (
          <p
            data-testid="v4-index-directory-partial"
            className="rounded-md bg-card px-2 py-1.5 text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage(
              { id: "chat.indexDirectory.partial" },
              { evicted: String(directory.evictedCount) },
            )}
          </p>
        ) : null}

        {/* 运行状态在浏览历史期间保持可见（U07-A2）。 */}
        {isRunning ? (
          <p className="flex items-center gap-1.5 px-1 text-ui-sm text-foreground-subtle">
            <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
            {intl.formatMessage({ id: "chat.indexDirectory.running" })}
          </p>
        ) : null}

        {visibleItems.length === 0 ? (
          <p className="px-1 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.empty" })}
          </p>
        ) : (
          <ul
            data-testid="v4-index-directory-list"
            className="!scrollbar-hide max-h-72 space-y-0.5 overflow-y-auto"
          >
            {hiddenOlderCount > 0 ? (
              <li className="px-2 py-1 text-ui-xs text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "chat.indexDirectory.hiddenOlder" },
                  { count: String(hiddenOlderCount) },
                )}
              </li>
            ) : null}
            {visibleItems.map((item, index) => (
              <DirectoryItemButton
                key={item.rowId}
                item={item}
                index={index}
                total={directory.items.length}
                active={focus.targetRowId === item.rowId}
                onSelect={handleSelect}
              />
            ))}
          </ul>
        )}

        {/* 超范围必须显式动作（spec 规则 3）：绝不后台遍历全部历史。 */}
        {focus.nextAction === "continue-older" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="v4-index-directory-continue-older"
            className="w-full"
            disabled={isLoading}
            onClick={continueOlder}
          >
            {intl.formatMessage({ id: "chat.indexDirectory.continueOlder" })}
          </Button>
        ) : null}

        {focus.status === "range-exhausted" ? (
          <p className="px-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.rangeExhausted" })}
          </p>
        ) : null}

        {focus.status === "target-missing" ? (
          <p className="px-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.targetMissing" })}
          </p>
        ) : null}

        {focus.status === "not-indexed" ? (
          <p className="px-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.notIndexed" })}
          </p>
        ) : null}

        {focus.status === "retryable-failure" ? (
          <p className="px-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.retryableFailure" })}
          </p>
        ) : null}

        {/* 运行中回答占满共享信封：确定的降级态，不是错误。提示用户回最新后重试。 */}
        {focus.status === "no-budget" ? (
          <p className="px-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.indexDirectory.noBudget" })}
          </p>
        ) : null}

        {/* 返回最新：清焦点、恢复尾部滚动意图（spec 规则 5）。 */}
        {focus.rows.length > 0 ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            data-testid="v4-index-directory-return-to-live"
            className="w-full"
            onClick={returnToLive}
          >
            {intl.formatMessage({ id: "chat.indexDirectory.returnToLive" })}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export const ConversationIndexDirectoryPanel = memo(ConversationIndexDirectoryPanelImpl);
