// 脚本工作流分组：工作流中枢页（AutomationsSection 的 workflow tab）里的第二族内容。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §7.1/§7.2/§7.4。
//
// 与上方 dwf 中枢（SavedWorkflowsSection）**刻意平行、不可互换**：两套系统的物理表、
// 状态词表、owner 语义都不同（spec §2.2），列表不混排、文案明说不可互换。
// 数据经 scriptWorkflowStore（v4 只读查询，锚活动会话）；本组件不自判档位——
// 「工具已停用」徽标读落盘设置（§7.4：disabled 档照常渲染数据，不弹窗不阻断）。
import { useCallback, useEffect, useMemo } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { ScriptWorkflowLogicalStatus } from "@acode/shared/acode-protocol-v4";
import { normalizeScriptWorkflowMode } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { selectScriptWorkflowState, useScriptWorkflowStore } from "@/store/scriptWorkflowStore.js";

export interface ScriptWorkflowsGroupProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 「查看发起会话」深链：切到发起该 run 的会话（复用 onOpenWorkflowRun 同类回调语义）。 */
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

/** 状态徽标的 i18n 键位（评审必改项 6）：completed/failed 复用现有 chat.toolCall 键组。 */
const STATUS_LABEL_KEYS: Record<ScriptWorkflowLogicalStatus, string> = {
  pending: "workflows.scriptHub.status.pending",
  running: "workflows.scriptHub.status.running",
  paused: "workflows.scriptHub.status.paused",
  completed: "chat.toolCall.scriptWorkflow.status.completed",
  failed: "chat.toolCall.scriptWorkflow.status.failed",
  cancelled: "workflows.scriptHub.status.cancelled",
  interrupted: "workflows.scriptHub.status.interrupted",
};

/** 徽标配色：running 用 accent 色调；failed/interrupted/cancelled 暖色；终态中性。 */
const STATUS_BADGE_CLASSNAMES: Record<ScriptWorkflowLogicalStatus, string> = {
  pending: "bg-surface text-foreground-subtle",
  running: "bg-primary/10 text-primary",
  paused: "bg-surface text-foreground-subtle",
  completed: "bg-surface text-foreground-subtle",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-surface text-foreground-subtle",
  interrupted: "bg-destructive/10 text-destructive",
};

const SCOPE_LABEL_KEYS: Record<string, string> = {
  builtin: "workflows.scriptHub.scope.builtin",
  explicit: "workflows.scriptHub.scope.explicit",
  project: "workflows.scriptHub.scope.project",
  user: "workflows.scriptHub.scope.user",
};

export function ScriptWorkflowsGroup({
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: ScriptWorkflowsGroupProps) {
  const { intl } = useACodeIntl();
  const { settings } = useSettings();
  const { acodeAgentService } = useServices();
  const target = useMemo(
    () =>
      workspacePath ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) } : null,
    [workspacePath, workspaceIdentity],
  );
  const state = useScriptWorkflowStore((store) => selectScriptWorkflowState(store, target));
  // disabled 档的呈现事实来自落盘设置（本机产品开关，无 Host 快照，spec §5 行 12）。
  const toolDisabled = normalizeScriptWorkflowMode(settings?.scriptWorkflowMode) === "disabled";

  // useCallback 化：refresh 依赖 target/acodeAgentService，挂载 effect 以它为触发源——
  // target 变化（切 workspace）即自动重查，不依赖调用点记得替我们刷新。
  const refresh = useCallback(
    (bypassCache: boolean) => {
      if (!target) return;
      void useScriptWorkflowStore
        .getState()
        .load({ ...target }, acodeAgentService, { bypassCache })
        .catch(() => undefined);
    },
    [target, acodeAgentService],
  );

  // 挂载必现查（spec §3.3/§8.2：存储是唯一权威，缓存只服务同页重渲染——挂载时快照会
  // 漏掉模型刚落盘的 run 行）。此前 load 只挂在刷新/重试按钮上，首开永远渲染误导空态；
  // 修复仿照 saved-workflows 全局组先例（useSavedWorkflowGlobalGroup 的 useEffect(refresh)）。
  // store.load 自带 in-flight 去重，effect 重跑/StrictMode 双挂载不会重复发查询。
  useEffect(() => {
    refresh(false);
  }, [refresh]);

  return (
    <section className="flex flex-col gap-3" data-testid="script-workflows-group">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "workflows.scriptHub.title" })}
          </h2>
          {toolDisabled ? (
            <span
              className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle"
              data-testid="script-workflows-gated-badge"
            >
              {intl.formatMessage({ id: "workflows.scriptHub.gatedBadge" })}
            </span>
          ) : null}
        </div>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.scriptHub.description" })}
        </p>
        {toolDisabled ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "workflows.scriptHub.gated" })}
          </p>
        ) : null}
      </div>

      {state.error ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <p className="text-ui-base text-destructive" role="alert">
            {intl.formatMessage({ id: "workflows.scriptHub.loadError" })}
          </p>
          {/* 错误态不伪造空列表（空列表和「读不到」是两个事实，spec §4.6）：给显式重试。 */}
          <button
            className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-ui-base text-foreground hover:bg-hover disabled:cursor-default disabled:opacity-60"
            data-testid="script-workflows-retry"
            disabled={state.loading}
            onClick={() => refresh(true)}
            type="button"
          >
            <RefreshCwIcon
              aria-hidden
              className={cn("size-3.5", state.loading && "animate-spin")}
            />
            {intl.formatMessage({ id: "workflows.scriptHub.retry" })}
          </button>
        </div>
      ) : state.noSession ? (
        <p className="rounded-xl border border-border p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.scriptHub.noSession" })}
        </p>
      ) : (
        <>
          {/* 「脚本」小节：已持久化脚本清单（meta + scriptPath，正文预览登记为后续增强）。 */}
          <div className="flex flex-col gap-2">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "workflows.scriptHub.scripts" })}
            </h3>
            {state.definitions.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.scriptHub.scriptsEmpty" })}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.definitions.map((definition) => (
                  <li
                    className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3"
                    data-testid="script-workflow-definition-row"
                    key={definition.id}
                  >
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-ui-base font-medium text-foreground">
                        {definition.name}
                      </span>
                      <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id:
                            SCOPE_LABEL_KEYS[definition.scope] ??
                            "workflows.scriptHub.scope.explicit",
                        })}
                      </span>
                      <span className="text-ui-xs text-foreground-subtle">
                        {formatDateTime(definition.timeUpdated)}
                      </span>
                    </div>
                    <p className="text-ui-base text-foreground-subtle">{definition.description}</p>
                    {definition.phaseTitles.length > 0 ? (
                      <p className="text-ui-xs text-foreground-subtle">
                        {definition.phaseTitles.join(" → ")}
                      </p>
                    ) : null}
                    {definition.scriptPath ? (
                      <p className="truncate font-mono text-ui-xs text-foreground-subtle">
                        {definition.scriptPath}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 「运行历史」小节：journal 快照（刷新 = 显式重查，无轮询，spec §8.2）。 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "workflows.scriptHub.runs" })}
              </h3>
              <button
                aria-label={intl.formatMessage({ id: "workflows.scriptHub.retry" })}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-ui-xs text-foreground-subtle hover:bg-hover disabled:cursor-default disabled:opacity-60"
                data-testid="script-workflows-refresh"
                disabled={state.loading}
                onClick={() => refresh(true)}
                type="button"
              >
                <RefreshCwIcon
                  aria-hidden
                  className={cn("size-3.5", state.loading && "animate-spin")}
                />
                {intl.formatMessage({ id: "workflows.scriptHub.retry" })}
              </button>
            </div>
            {state.runs.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.scriptHub.empty" })}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.runs.map((run) => (
                  <li
                    className="flex min-w-0 flex-col gap-1 rounded-xl border border-border p-3"
                    data-testid="script-workflow-run-row"
                    key={run.runId}
                  >
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-px text-ui-xs",
                          STATUS_BADGE_CLASSNAMES[run.logicalStatus],
                        )}
                        data-status={run.logicalStatus}
                      >
                        {intl.formatMessage({ id: STATUS_LABEL_KEYS[run.logicalStatus] })}
                      </span>
                      <span className="text-ui-base font-medium text-foreground">{run.name}</span>
                      <span className="text-ui-xs text-foreground-subtle">
                        {formatDateTime(run.createdAt)}
                      </span>
                    </div>
                    {run.stopReason !== undefined ? (
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id:
                            run.stopReason === "user"
                              ? "workflows.scriptHub.stopReason.user"
                              : "workflows.scriptHub.stopReason.processExited",
                        })}
                      </p>
                    ) : null}
                    <p className="text-ui-xs text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "workflows.scriptHub.stats" },
                        {
                          agentCalls: run.stats.agentCalls,
                          toolCalls: run.stats.toolCalls,
                          // 账本不完整时如实显示「≥K」，不把不完整账本伪装成零（spec §4.1）。
                          tokens: run.stats.usageIncomplete
                            ? intl.formatMessage(
                                { id: "workflows.scriptHub.usageIncomplete" },
                                { known: run.stats.tokensTotal },
                              )
                            : String(run.stats.tokensTotal),
                        },
                      )}
                    </p>
                    {run.toolCallId !== undefined && run.parentSessionId !== undefined ? (
                      <button
                        className="w-fit rounded-lg px-2 py-1 text-ui-xs text-primary hover:bg-hover"
                        data-testid="script-workflow-run-open-origin"
                        onClick={() => {
                          onOpenSession?.({
                            sessionId: run.parentSessionId!,
                            workspacePath: run.cwd,
                            ...(run.workspaceIdentity !== undefined
                              ? { workspaceIdentity: run.workspaceIdentity }
                              : {}),
                          });
                        }}
                        type="button"
                      >
                        {intl.formatMessage({ id: "workflows.scriptHub.openOriginSession" })}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {state.truncated ? (
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "workflows.scriptHub.truncated" },
                  { limit: state.runs.length },
                )}
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
