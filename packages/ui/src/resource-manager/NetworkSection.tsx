import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  appendNetworkRecords,
  filterNetworkRecords,
  formatNetworkRecordDuration,
  formatNetworkRecordTime,
  paginateNetworkRecords,
  type NetworkCaptureRecord,
} from "@/resource-manager/networkCaptureView.js";

/**
 * 资源管理器「网络」tab（packages/desktop/specs/runtime-network-capture.md 的 UI 部分）。
 *
 * 桥接形状是**局部类型**：desktop 的独立 renderer 入口把 `window.resourceManager.network`
 * 传进来（setEnabled / getState / subscribeRecords），ui 包不依赖 desktop 的 preload 声明。
 * 桥缺席（非桌面、旧 preload）时整节显示 unavailable——tab 还在，读者知道这块观测面存在
 * 但当前不可用（与存储 tab 同一条规则）。
 *
 * 记录是**追加式**消费：v4 `networkCaptureRecords` 事件按批到达，本节把批次累进本地列表
 * （上界见 networkCaptureView），清空按钮只清 UI。发送方限制（来源窗口校验）在 desktop
 * main，UI 不重复。
 */
export interface ResourceManagerNetworkBridge {
  setEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }>;
  getState(): Promise<{ enabled: boolean; captureId?: string }>;
  subscribeRecords(callback: (records: readonly NetworkCaptureRecord[]) => void): () => void;
}

export function NetworkSection({
  bridge,
  active,
}: {
  /** preload 暴露的 window.resourceManager.network；缺省表示桥接不可用。 */
  bridge: ResourceManagerNetworkBridge | undefined;
  /** tab 是否激活：订阅与开关状态查询只在激活时进行，切走即退订。 */
  active: boolean;
}) {
  const { intl } = useACodeIntl();
  const format = intl.formatMessage.bind(intl);
  const [records, setRecords] = useState<NetworkCaptureRecord[]>([]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  // 迟到的开关回执：切走 tab 后不再回写状态。
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 状态 + 订阅：激活才建立；退订后不再累加（清空由按钮显式触发）。
  useEffect(() => {
    if (!bridge || !active) return undefined;
    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (!disposed) setEnabled(state.enabled);
      })
      .catch((error) => {
        logger.warn("[resource-manager] network capture 状态读取失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const dispose = bridge.subscribeRecords((batch) => {
      if (disposed) return;
      setRecords((current) => appendNetworkRecords(current, batch));
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [active, bridge]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (bridge === undefined || toggling) return;
      setToggling(true);
      try {
        const result = await bridge.setEnabled(next);
        if (result.success) {
          setEnabled(next);
          // 关闭即清缓冲（agent 侧语义）：UI 的存量行同步清掉，不给「关了还在长」的错觉。
          if (!next) setRecords([]);
        } else {
          logger.warn("[resource-manager] network capture 开关失败", { error: result.error });
        }
      } catch (error) {
        logger.warn("[resource-manager] network capture 开关失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setToggling(false);
      }
    },
    [bridge, toggling],
  );

  const filtered = useMemo(() => filterNetworkRecords(records, filter), [filter, records]);
  const pageView = useMemo(() => paginateNetworkRecords(filtered, page), [filtered, page]);
  // 过滤收窄后页码可能越界：分页函数已钳到最后一页，这里把受控值跟回去。
  useEffect(() => {
    if (page !== pageView.page) setPage(pageView.page);
  }, [page, pageView.page]);

  if (bridge === undefined) {
    return (
      <div
        className="rounded-xl border border-border bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
        data-testid="resource-manager-network-unavailable"
      >
        {format({ id: "resourceManager.network.unavailable" })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="resource-manager-network-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
          {format({ id: "resourceManager.network.description" })}
        </p>
        <div className="flex items-center gap-2">
          {toggling ? (
            <LoaderCircleIcon
              aria-hidden
              className="size-3.5 animate-spin text-foreground-subtle"
            />
          ) : null}
          <Switch
            aria-label={format({
              id:
                enabled === false
                  ? "resourceManager.network.enable"
                  : "resourceManager.network.disable",
            })}
            checked={enabled === true}
            data-testid="resource-manager-network-toggle"
            disabled={enabled === null || toggling}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={format({ id: "resourceManager.network.filter" })}
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-input px-2 text-ui-sm text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus-visible:border-input-border-focused"
          data-testid="resource-manager-network-filter"
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(1);
          }}
          placeholder={format({ id: "resourceManager.network.filter" })}
          type="text"
          value={filter}
        />
        <span className="shrink-0 text-ui-sm text-foreground-subtle tabular-nums">
          {format({ id: "resourceManager.network.count" }, { count: filtered.length })}
        </span>
        <Button
          data-testid="resource-manager-network-clear"
          disabled={records.length === 0}
          onClick={() => {
            setRecords([]);
            setPage(1);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {format({ id: "resourceManager.network.clear" })}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full table-fixed border-collapse text-ui-sm">
          <thead>
            <tr className="border-b border-border text-left text-foreground-subtlest">
              <th className="w-20 px-2 py-1.5 font-normal">
                {format({ id: "resourceManager.network.time" })}
              </th>
              <th className="w-20 px-2 py-1.5 font-normal">
                {format({ id: "resourceManager.network.process" })}
              </th>
              <th className="w-16 px-2 py-1.5 font-normal">
                {format({ id: "resourceManager.network.method" })}
              </th>
              <th className="px-2 py-1.5 font-normal">URL</th>
              <th className="w-14 px-2 py-1.5 font-normal text-right">Status</th>
              <th className="w-20 px-2 py-1.5 font-normal text-right">
                {/* 耗时列没有专设键，与 time/process/method 同表头族；en/zh 均有
                    resourceManager.storage.* 的时间措辞可参照，这里用 count 同款简洁词。 */}
                ms
              </th>
            </tr>
          </thead>
          <tbody>
            {pageView.records.length === 0 ? (
              <tr>
                <td className="px-2 py-4 text-center text-foreground-subtle" colSpan={6}>
                  {format({
                    id:
                      filter.trim().length > 0
                        ? "resourceManager.network.noMatches"
                        : "resourceManager.network.empty",
                  })}
                </td>
              </tr>
            ) : (
              pageView.records.map((record, index) => (
                <tr
                  className={cn(
                    "border-b border-border/60 last:border-b-0",
                    record.status != null && record.status >= 400 && "text-foreground-subtle",
                  )}
                  data-testid="resource-manager-network-row"
                  key={`${record.startedAt}:${index}`}
                >
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-foreground-subtle tabular-nums">
                    {formatNetworkRecordTime(record.startedAt)}
                  </td>
                  <td className="truncate px-2 py-1 font-mono text-foreground-subtle">
                    {record.phase ?? ""}
                  </td>
                  <td className="px-2 py-1 font-mono">{record.method}</td>
                  <td className="px-2 py-1">
                    <span className="block truncate font-mono" title={record.url}>
                      {record.url}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">
                    {record.status === undefined ? "" : record.status}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-foreground-subtle tabular-nums">
                    {formatNetworkRecordDuration(record.durationMs)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageView.pageCount > 1 ? (
        <div
          className="flex items-center justify-end gap-1"
          data-testid="resource-manager-network-pager"
        >
          <Button
            aria-label={format({ id: "resourceManager.network.previous" })}
            data-testid="resource-manager-network-previous"
            disabled={pageView.page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <span className="font-mono text-ui-sm text-foreground-subtle tabular-nums">
            {pageView.page} / {pageView.pageCount}
          </span>
          <Button
            aria-label={format({ id: "resourceManager.network.next" })}
            data-testid="resource-manager-network-next"
            disabled={pageView.page >= pageView.pageCount}
            onClick={() => setPage((current) => current + 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
