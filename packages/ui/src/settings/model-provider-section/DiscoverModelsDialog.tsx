import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  ProviderModelDiscoveryErrorKind,
  ProviderModelDiscoveryResult,
} from "@acode/services";
import { TID_MODEL_PROVIDER_DISCOVER_DIALOG } from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  computeDiscoverySelection,
  mapDiscoveryErrorKindToMessageId,
  DISCOVERY_MODEL_LIST_LIMIT,
} from "@/settings/model-provider-section/modelDiscoveryDialogModel.js";

// 获取模型勾选对话框（specs/provider-model-discovery.md 产品规则 5 / 验收场景 4）：
// open 时发起一次发现；ok → 未配置 id 默认勾选、已配置 id 禁用弱化；!ok → 错误态可重试。
// 对话框态局部（不进 store）；发现结果不持久化，关闭即弃。取消/关闭零副作用。

type DiscoveryPhase = "loading" | "ready" | "error";

interface DiscoveryErrorState {
  kind: ProviderModelDiscoveryErrorKind;
  httpStatus?: number;
}

export function DiscoverModelsDialog({
  open,
  onOpenChange,
  configuredModelIds,
  onDiscover,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前已配置模型 id：命中者禁用勾选并标「已配置」，绝不覆盖/重复添加。 */
  configuredModelIds: readonly string[];
  onDiscover: () => Promise<ProviderModelDiscoveryResult>;
  /** 批量添加勾选集；resolve 视为成功并关闭，reject 留在对话框内显示 inline 错误。 */
  onConfirm: (modelIds: string[]) => Promise<unknown>;
}) {
  const { intl } = useACodeIntl();
  const [phase, setPhase] = useState<DiscoveryPhase>("loading");
  const [fetchedModels, setFetchedModels] = useState<readonly string[]>([]);
  const [fetchedCount, setFetchedCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<DiscoveryErrorState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [addFailed, setAddFailed] = useState(false);
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  // 打开/重试期间父组件可能重渲染，旧请求晚到会覆盖新结果；token 守卫丢弃过期响应。
  const requestTokenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const token = ++requestTokenRef.current;
    setPhase("loading");
    setDiscoveryError(null);
    setAddFailed(false);
    void (async () => {
      try {
        const result = await onDiscover();
        if (token !== requestTokenRef.current) return;
        if (result.ok) {
          setFetchedModels(result.models);
          setFetchedCount(result.fetchedCount);
          setTruncated(result.truncated);
          // spec：未配置 id 默认全勾。
          setSelected(
            new Set(computeDiscoverySelection(result.models, configuredModelIds).preselected),
          );
          setPhase("ready");
        } else {
          setDiscoveryError({ kind: result.error.kind, httpStatus: result.error.httpStatus });
          setPhase("error");
        }
      } catch {
        // RPC 传输层异常没有结构化 kind；按 network 语义兜底（同为「请求未能完成」）。
        if (token !== requestTokenRef.current) return;
        setDiscoveryError({ kind: "network" });
        setPhase("error");
      }
    })();
    // onDiscover/configuredModelIds 每次父渲染都是新引用；发现只在 open/重试时触发一次，
    // 闭包取当次最新值即可，显式排除依赖（与 DirectoryBrowser 同口径）。
  }, [open, discoveryNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const selection = useMemo(
    () => computeDiscoverySelection(fetchedModels, configuredModelIds),
    [fetchedModels, configuredModelIds],
  );
  // 行序保持 fetched 原序；configured 命中者禁选（含打开期间配置变化的实时口径）。
  const rows = useMemo(() => {
    const addableSet = new Set(selection.addable);
    const seen = new Set<string>();
    const result: { id: string; configured: boolean }[] = [];
    for (const id of fetchedModels) {
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ id, configured: !addableSet.has(id) });
    }
    return result;
  }, [fetchedModels, selection]);
  const confirmIds = useMemo(
    () => selection.addable.filter((id) => selected.has(id)),
    [selection, selected],
  );

  const toggleModel = useCallback((modelId: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (saving || confirmIds.length === 0) return;
    setSaving(true);
    setAddFailed(false);
    try {
      await onConfirm(confirmIds);
      onOpenChange(false);
    } catch {
      // 添加失败不关闭：错误留在对话框内（inline），勾选态保留可直接重试。
      setAddFailed(true);
    } finally {
      setSaving(false);
    }
  }, [confirmIds, onConfirm, onOpenChange, saving]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 保存中关闭会让失败反馈无处显示；等待本次提交完成（与添加模型对话框同纪律）。
      if (saving && !next) return;
      onOpenChange(next);
    },
    [onOpenChange, saving],
  );

  const retry = useCallback(() => setDiscoveryNonce((value) => value + 1), []);
  const errorText = discoveryError
    ? intl.formatMessage(
        { id: mapDiscoveryErrorKindToMessageId(discoveryError.kind) },
        discoveryError.kind === "http" ? { status: discoveryError.httpStatus ?? "-" } : undefined,
      )
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid={TID_MODEL_PROVIDER_DISCOVER_DIALOG}
        data-no-model-drag="true"
        className="max-h-[min(36rem,calc(100vh-4rem))] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {intl.formatMessage({ id: "settings.modelProvider.discover.title" })}
          </DialogTitle>
        </DialogHeader>
        {phase === "loading" ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.modelProvider.discover.loading" })}
          </div>
        ) : null}
        {phase === "error" ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-3">
            <p className="text-ui-base text-destructive">{errorText}</p>
            <Button type="button" variant="secondary" className="rounded-lg" onClick={retry}>
              {intl.formatMessage({ id: "settings.modelProvider.discover.retry" })}
            </Button>
          </div>
        ) : null}
        {phase === "ready" ? (
          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.modelProvider.discover.summary" },
                  {
                    fetched: fetchedCount,
                    addable: selection.addable.length,
                    configured: selection.configuredHits.length,
                  },
                )}
                {truncated ? (
                  <span className="ml-2 text-ui-xs">
                    {intl.formatMessage(
                      { id: "settings.modelProvider.discover.truncated" },
                      { max: DISCOVERY_MODEL_LIST_LIMIT },
                    )}
                  </span>
                ) : null}
              </div>
              {/* spec 产品规则 5：全选/全不选快捷（只作用于可新增集，已配置行不受影响）。 */}
              {selection.addable.length > 0 ? (
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="rounded-md"
                    disabled={saving}
                    onClick={() => setSelected(new Set(selection.addable))}
                  >
                    {intl.formatMessage({ id: "settings.modelProvider.discover.selectAll" })}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="rounded-md"
                    disabled={saving}
                    onClick={() => setSelected(new Set())}
                  >
                    {intl.formatMessage({ id: "settings.modelProvider.discover.selectNone" })}
                  </Button>
                </div>
              ) : null}
            </div>
            {selection.addable.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.modelProvider.discover.empty" })}
              </div>
            ) : (
              <div className="min-h-0 overflow-y-auto rounded-lg border border-input-border bg-input">
                {rows.map((row) => (
                  <label
                    key={row.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 text-ui-base",
                      row.configured ? "opacity-60" : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      checked={row.configured ? false : selected.has(row.id)}
                      disabled={row.configured || saving}
                      onCheckedChange={(checked) => toggleModel(row.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">{row.id}</span>
                    {row.configured ? (
                      <span className="shrink-0 text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.modelProvider.discover.configured" })}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {addFailed ? (
            <p className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "settings.modelProvider.discover.addFailed" })}
            </p>
          ) : null}
          {/* spec 产品规则 9：发现请求由 host 所在网络出口发出，远端 workspace 即远端主机视角。 */}
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.discover.hostNote" })}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            <Button
              type="button"
              className="rounded-lg"
              disabled={confirmIds.length === 0 || saving}
              onClick={() => void handleConfirm()}
            >
              {intl.formatMessage({ id: "settings.modelProvider.discover.confirm" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
