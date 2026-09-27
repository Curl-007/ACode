import { useMemo } from "react";
import { Boxes, Cpu } from "lucide-react";
import {
  getAgentEngineDescriptors,
  TID_SETTINGS_ENGINE_ROW,
  testId,
  type ACodeAgentEngineDescriptor,
} from "@acode/shared";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsBadge,
} from "@/settings/SettingsPageParts.js";

/**
 * Agent 引擎设置分区（只读）。
 *
 * 渲染 shared 引擎注册表：native(glm) 与外部引擎(codex/opencode/gemini)。状态来自注册表的
 * 静态事实（native / implemented）——外部引擎的会话协议适配器尚未接入（implemented:false），
 * 因此这里如实显示「尚未启用」，不做误导性的「已安装/缺失」实时探测（那需要新的 binary 探测
 * RPC，且引擎还不能驱动会话）。注册表是唯一所有者，本组件不重复定义引擎列表。
 */
export function EngineSection() {
  const { intl } = useACodeIntl();
  const engines = useMemo(() => getAgentEngineDescriptors(), []);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
          <Boxes className="size-4" aria-hidden />
          {intl.formatMessage({ id: "settings.engine.title" })}
        </div>
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.engine.description" })}
        </p>
      </div>

      <SettingsGroupCard>
        {engines.map((engine) => (
          <EngineRow key={engine.id} engine={engine} />
        ))}
      </SettingsGroupCard>
    </div>
  );
}

function EngineRow({ engine }: { engine: ACodeAgentEngineDescriptor }) {
  const { intl } = useACodeIntl();
  const enabled = engine.native || engine.implemented;
  const statusId = enabled ? "settings.engine.installed" : "settings.engine.missing";
  const descriptionId = `engine.${engine.id}.description`;
  const nameId = `engine.${engine.id}.name`;

  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          {engine.native ? <Cpu className="size-4 text-foreground-subtle" aria-hidden /> : null}
          {intl.formatMessage({ id: nameId })}
        </span>
      }
      description={
        <span className="space-y-1">
          <span>{intl.formatMessage({ id: descriptionId })}</span>
          {!enabled ? (
            <span className="block text-foreground-subtle/80">
              {intl.formatMessage({ id: "settings.engine.missingHint" })}
            </span>
          ) : null}
        </span>
      }
      control={<SettingsBadge>{intl.formatMessage({ id: statusId })}</SettingsBadge>}
      detail={
        <div
          className="flex flex-wrap gap-1.5"
          data-testid={testId(TID_SETTINGS_ENGINE_ROW, engine.id)}
        >
          {engine.supportedPermissionModes.map((mode) => (
            <span
              key={mode}
              className="rounded-md bg-surface px-2 py-0.5 text-ui-small text-foreground-subtle"
            >
              {intl.formatMessage({ id: `engine.permissionMode.${mode}` })}
            </span>
          ))}
        </div>
      }
      controlLayout="wide"
    />
  );
}
