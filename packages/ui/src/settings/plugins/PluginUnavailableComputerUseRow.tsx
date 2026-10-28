/**
 * Computer Use 不可用分组的提示行（受控组件，纯渲染）。
 * 批次 4 helper 外迁（2026-10-28）：自 settings/PluginsSection.tsx 内部
 * renderUnavailableComputerUse 逐字迁移，JSX 与文案 id 未改一字；intl 由原闭包改为
 * useACodeIntl 自取（原文 intl 也只用于 formatMessage，行为等价）。
 * computerUseAvailability 类型按 ts-no-return-type 规则引用属主模块 computerUseAvailability.ts
 * 导出的具名 ComputerUseAvailability（该 export 随本次外迁补上）。
 */
import { Monitor } from "lucide-react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ComputerUseAvailability } from "@/settings/computerUseAvailability.js";

export function PluginUnavailableComputerUseRow({
  computerUseAvailability,
}: {
  computerUseAvailability: ComputerUseAvailability;
}) {
  const { intl } = useACodeIntl();
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-foreground-subtle">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
          <Monitor className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id:
                computerUseAvailability.kind === "local-linux"
                  ? "settings.computerUse.unsupported.linuxDescription"
                  : "settings.computerUse.unsupported.remoteDescription",
            })}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-background px-2 py-1 text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.badge" })}
        </span>
      </div>
    </div>
  );
}
