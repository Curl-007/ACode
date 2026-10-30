/**
 * 状态筛选命中 0 条时的占位（纯展示）。
 * batch-1 helper 外迁（review 2026-10-28 §3.①）：自 AutomationsSection.tsx 逐字迁移。
 */
import { useACodeIntl } from "@/i18n/IntlProvider.js";

/** 状态筛选命中 0 条时的占位；复用闲时空态卡的描边样式，文案与「还没有任务」区分开。 */
export function AutomationStatusFilterEmpty() {
  const { intl } = useACodeIntl();
  return (
    <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "automations.statusFilter.empty" })}
    </div>
  );
}
