import { useState } from "react";
import { Loader2Icon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  DIAGNOSTICS_TIER_OPTIONS,
  canRunTier,
  checkpointLabelId,
  checkpointStatusLabelId,
  checkpointStatusVariant,
  diagnosticsErrorCodeLabelId,
  remediationActionView,
  resolveCancelNoticeId,
  resolveProviderConfigState,
  resolveRunPhase,
  resolveSpendNotice,
  resolveVerdictBadge,
  resolveVerdictLabelId,
  type ProviderConfigState,
} from "@/lib/providerDiagnostics.js";
import type { UseProviderDiagnosticsResult } from "@/hooks/useProviderDiagnostics.js";

/**
 * U08 Provider 诊断面板（specs/provider-diagnostics-ui.md）。
 *
 * 组件层**只做渲染**：所有判定（三态/fencing/档位授权/文案与动作映射）都在
 * `lib/providerDiagnostics.ts` 的纯函数里（U1）。本文件刻意不含任何 tier 判定、
 * revision 比较或 errorCode → 文案的 if/else 分支——那些都会被纯函数测试覆盖，
 * 写在这里就变成只能用源码断言守护的死区。
 *
 * 首次配置与设置页共用本面板：它只依赖 `diagnostics`（hook 返回）与 `configState`，
 * 不依赖调用方是 WelcomeScreen 还是设置页，因此不为首配另起一条渲染路径。
 */

/** 面板局部 test id：不进 shared/test-ids.ts（该文件由他人维护），就地定义避免跨文件耦合。 */
const TID = {
  root: "provider-diagnostics-panel",
  tierItem: "provider-diagnostics-tier",
  acknowledge: "provider-diagnostics-acknowledge",
  run: "provider-diagnostics-run",
  cancel: "provider-diagnostics-cancel",
  state: "provider-diagnostics-state",
  verdict: "provider-diagnostics-verdict",
  error: "provider-diagnostics-error",
  notice: "provider-diagnostics-notice",
  checkpoint: "provider-diagnostics-checkpoint",
  remediation: "provider-diagnostics-remediation",
  command: "provider-diagnostics-command",
} as const;

export interface ProviderDiagnosticsPanelProps {
  /** 诊断 hook 的全部状态与动作（useProviderDiagnostics 的返回）。 */
  readonly diagnostics: UseProviderDiagnosticsResult;
  /** provider 是否已保存：未保存时面板只显示说明，不提供运行入口。 */
  readonly saved: boolean;
  /** 当前 ProviderSettingsView.revision：fencing 判据（U3）。 */
  readonly revision: number;
  /** 用户点「打开设置」等导航类修复动作时的回调；缺席时该按钮不渲染。 */
  readonly onOpenProviderSettings?: () => void;
}

/** 配置状态徽标：三态必须可见地区分（U2）。 */
function ConfigStateBadge({ state }: { readonly state: ProviderConfigState }) {
  const { intl } = useACodeIntl();
  if (state === "unconfigured") return null;
  const validated = state === "validated";
  return (
    <Badge variant={validated ? "secondary" : "outline"} data-testid={TID.state}>
      {validated ? <ShieldCheckIcon className="size-3" /> : <TriangleAlertIcon className="size-3" />}
      {intl.formatMessage({
        id: validated
          ? "settings.modelProvider.diagnostics.state.validated"
          : "settings.modelProvider.diagnostics.state.savedUnverified",
      })}
    </Badge>
  );
}

export function ProviderDiagnosticsPanel({
  diagnostics,
  saved,
  revision,
  onOpenProviderSettings,
}: ProviderDiagnosticsPanelProps) {
  const { intl } = useACodeIntl();
  const { result, running, tier, setTier, run, cancel } = diagnostics;
  // 档位确认（联网告知 / 费用 opt-in）是**面板局部 UI 状态**，不是服务端事实，也不落盘：
  // 授权只对本次、该档位生效（R9）。切档即重置，避免把 catalog 的确认复用给 live。
  const [acknowledged, setAcknowledged] = useState(false);

  const option = DIAGNOSTICS_TIER_OPTIONS.find((item) => item.tier === tier)!;
  const configState = resolveProviderConfigState({ saved, result, revision });
  const phase = resolveRunPhase(result);
  const badge = resolveVerdictBadge(result, revision);
  const canRun = canRunTier({ tier, acknowledged, running, saved });
  const spendNotice = resolveSpendNotice({ spend: result?.spend });

  const selectTier = (next: typeof tier): void => {
    setTier(next);
    setAcknowledged(false);
  };

  return (
    <div className="space-y-3" data-testid={TID.root}>
      <div className="flex items-center gap-2">
        <h3 className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.diagnostics.title" })}
        </h3>
        <ConfigStateBadge state={configState} />
      </div>

      {/* 未保存时只说明，不给运行入口：诊断读的是已落盘的 Registry 事实（U2）。 */}
      {saved ? (
        <>
          <div className="space-y-2">
            {DIAGNOSTICS_TIER_OPTIONS.map((item) => (
              <label
                key={item.tier}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2"
                data-testid={`${TID.tierItem}-${item.tier}`}
              >
                <input
                  type="radio"
                  name="provider-diagnostics-tier"
                  className="mt-0.5"
                  checked={tier === item.tier}
                  disabled={running}
                  onChange={() => selectTier(item.tier)}
                />
                <span className="space-y-0.5">
                  <span className="block text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: item.labelId })}
                  </span>
                  <span className="block text-ui-xs leading-4 text-foreground-subtle">
                    {intl.formatMessage({ id: item.descriptionId })}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {/* 档位确认：catalog 联网告知、live 费用 opt-in。未确认时运行按钮禁用（U5/R9）。 */}
          {option.requiresAcknowledgement && option.acknowledgementId ? (
            <label className="flex cursor-pointer items-start gap-2" data-testid={TID.acknowledge}>
              <Checkbox
                checked={acknowledged}
                disabled={running}
                onCheckedChange={(value) => setAcknowledged(value === true)}
              />
              <span
                className={
                  option.spendsBalance
                    ? "text-ui-xs leading-4 text-destructive"
                    : "text-ui-xs leading-4 text-foreground-subtle"
                }
              >
                {intl.formatMessage({ id: option.acknowledgementId })}
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid={TID.run}
              disabled={!canRun}
              onClick={() => void run({ acknowledged })}
            >
              {running ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {intl.formatMessage({
                id: running
                  ? "settings.modelProvider.diagnostics.running"
                  : "settings.modelProvider.diagnostics.run",
              })}
            </Button>
            {running ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={TID.cancel}
                onClick={() => void cancel()}
              >
                {intl.formatMessage({ id: "settings.modelProvider.diagnostics.cancel" })}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-ui-xs leading-4 text-foreground-subtle" data-testid={TID.state}>
          {intl.formatMessage({ id: "settings.modelProvider.diagnostics.saveFirstHint" })}
        </p>
      )}

      {/* 取消文案：绝不承诺退费（U7/R4）。 */}
      {phase === "cancelled" ? (
        <Alert data-testid={TID.notice}>
          <AlertDescription>
            {intl.formatMessage({
              id: resolveCancelNoticeId({ spend: result?.spend }),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 结论徽标：tier-passed 与 ready 文案不同，offline 另有更保守措辞（U2）。 */}
      {saved && badge !== "none" && result ? (
        <Alert variant={badge === "failed" ? "destructive" : "default"} data-testid={TID.verdict}>
          {badge === "failed" ? <TriangleAlertIcon className="size-4" /> : <ShieldCheckIcon className="size-4" />}
          <AlertDescription>
            {intl.formatMessage({
              id: resolveVerdictLabelId({ badge, tier: result.tier }),
            })}
            {/* 花费提示：只有确实产生计费调用时才说；未知/零调用不编造（R4 诚实基线）。 */}
            {spendNotice.kind === "charged" && result.spend
              ? ` ${intl.formatMessage(
                  { id: "settings.modelProvider.diagnostics.spend.charged" },
                  { count: result.spend.billableCalls },
                )}`
              : ""}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 失败阶段 + 稳定错误码文案（U2/R6）。 */}
      {result && phase === "failed" && result.errorCode ? (
        <Alert variant="destructive" data-testid={TID.error}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>
            {intl.formatMessage({ id: diagnosticsErrorCodeLabelId(result.errorCode) })}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 检查点明细：四态文案与视觉各自独立，skipped/blocked 不呈现成失败（U6/R5）。 */}
      {result && badge !== "none" ? (
        <ul className="space-y-1" data-testid={TID.checkpoint}>
          {result.checkpoints.map((checkpoint) => (
            <li key={checkpoint.id} className="flex items-center gap-2">
              <Badge variant={checkpointStatusVariant(checkpoint.status)}>
                {intl.formatMessage({ id: checkpointStatusLabelId(checkpoint.status) })}
              </Badge>
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: checkpointLabelId(checkpoint.id) })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 修复动作：只渲染白名单动作的导航/重试，绝不执行命令（U8）。 */}
      {result ? (
        <div className="flex flex-wrap gap-2" data-testid={TID.remediation}>
          {result.remediationActions.map((action) => {
            const view = remediationActionView(action);
            // 导航类动作没有回调时不渲染：给一个点了没反应的按钮比不给更糟。
            if (view.kind === "navigate-settings" && !onOpenProviderSettings) return null;
            return (
              <Button
                key={action}
                type="button"
                size="sm"
                variant="outline"
                disabled={running}
                onClick={() => {
                  if (view.kind === "navigate-settings") onOpenProviderSettings?.();
                  // retry：沿用当前档位与确认态重跑，不重新创建 provider（U4/R3）。
                  if (view.kind === "retry") void run({ acknowledged });
                  // 其余动作（relogin/select-model/edit-endpoint/check-network/escalate/verify-later）
                  // 由宿主页面处理或只是告知；本面板不越权导航到未知路由。
                }}
              >
                {intl.formatMessage({ id: view.labelId })}
              </Button>
            );
          })}
        </div>
      ) : null}

      {/* 可粘贴命令：仅展示/可复制，绝不执行（U8；命令由 Doctor R7 白名单化）。 */}
      {result && result.nextStepCommands.length > 0 ? (
        <div className="space-y-1" data-testid={TID.command}>
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.diagnostics.nextStepsHint" })}
          </p>
          {result.nextStepCommands.map((command) => (
            <code key={command} className="block rounded bg-muted px-2 py-1 text-ui-xs">
              {command}
            </code>
          ))}
        </div>
      ) : null}
    </div>
  );
}
