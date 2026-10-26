import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDiagnostics } from "@/hooks/useProviderDiagnostics.js";
import { ProviderDiagnosticsPanel } from "@/components/ProviderDiagnosticsPanel.js";
import { Separator } from "@/components/ui/separator.js";

/**
 * U08 Provider 诊断在**设置页**的入口（specs/provider-diagnostics-ui.md）。
 *
 * 刻意做成自包含组件（自己调 useProviderDiagnostics + 复用首配同一个 Panel），
 * 而不是把 hook 结果经 props 层层穿透 Detail.tsx → InlineEditableProviderCard.tsx：
 * 那两个文件都已超 900 行且被多处共用，多穿一层 prop 只会加深耦合面。
 * 首配与设置页因此共用同一份渲染与判定逻辑，不会出现两套状态文案漂移
 * （提案发布门槛：中英文状态一一对应）。
 *
 * 设置页始终有 workspace，因此三档能力完整可用（首配可能无 workspace，
 * 会拿到 no-agent-runtime，见 spec「无 workspace 的首次配置」段）。
 */
export interface ProviderDiagnosticsCardProps {
  readonly providerId: string;
  /** 当前 ProviderSettingsView.revision：fencing 判据（U3/R2）。 */
  readonly revision: number;
  /** 该 provider 是否已保存进 Registry（设置页里的 provider 恒为已保存）。 */
  readonly saved?: boolean;
}

export function ProviderDiagnosticsCard({
  providerId,
  revision,
  saved = true,
}: ProviderDiagnosticsCardProps) {
  const { intl } = useACodeIntl();
  const diagnostics = useProviderDiagnostics({ providerId, revision });

  // 刻意不在这里再算一遍 configState：Panel 内部已按 resolveProviderConfigState 计算并渲染
  // 徽标。多算一次就是多一条状态派生路径（AGENTS.md：避免重复状态），两者不同步时 UI 会自相矛盾。
  return (
    <div className="space-y-2">
      <Separator />
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.diagnostics.settingsHint" })}
      </p>
      <ProviderDiagnosticsPanel
        diagnostics={diagnostics}
        saved={saved}
        revision={revision}
      />
    </div>
  );
}
