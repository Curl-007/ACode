/**
 * 设置页「用量状态栏」分组（apps/acode-cli/specs/usage-statusbar-port.md §7.2）。
 *
 * 自包含：直接读 `lib/usageStatusbarPreferences.ts` 的唯一事实源（与 composer 齿轮弹层
 * 同一份 localStorage 切片），不穿过 SettingsPage 巨型 props，也不引入第二写入路径。
 * 分组标题行挂总开关；下面七段子开关 + 回答末尾速率行，顺序与状态栏段一致。
 */
import { useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  getUsageStatusbarPreferencesSnapshot,
  setUsageStatusbarPreferences,
  subscribeToUsageStatusbarPreferences,
  type UsageStatusbarPreferences,
} from "@/lib/usageStatusbarPreferences.js";
import {
  USAGE_BAR_TOGGLE_LABEL_ID,
  USAGE_BAR_TOGGLE_ORDER,
  USAGE_BAR_TOGGLE_PREFERENCE_KEY,
} from "@/v4/composer/usage-bar/usageBarModel.js";
import { buildUsageBarPreferencePatch } from "@/v4/composer/usage-bar/UsageBarSettingsPopover.js";

function usePreferences(): UsageStatusbarPreferences {
  return useSyncExternalStore(
    subscribeToUsageStatusbarPreferences,
    getUsageStatusbarPreferencesSnapshot,
    getUsageStatusbarPreferencesSnapshot,
  );
}

function readToggle(
  preferences: UsageStatusbarPreferences,
  key: (typeof USAGE_BAR_TOGGLE_ORDER)[number],
): boolean {
  const preferenceKey = USAGE_BAR_TOGGLE_PREFERENCE_KEY[key];
  return preferenceKey === "answerFooter"
    ? preferences.answerFooter
    : preferences.visibleItems[preferenceKey];
}

export function UsageStatusbarSettingsSection() {
  const { intl } = useACodeIntl();
  const preferences = usePreferences();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.usageStatusbar.title" })}
        description={intl.formatMessage({ id: "settings.usageStatusbar.description" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.usageStatusbar.totalLabel" })}
            checked={preferences.enabled}
            onCheckedChange={(checked) => setUsageStatusbarPreferences({ enabled: checked })}
          />
        }
      />
      {USAGE_BAR_TOGGLE_ORDER.map((key) => (
        <SettingsRow
          key={key}
          label={intl.formatMessage({ id: USAGE_BAR_TOGGLE_LABEL_ID[key] })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: USAGE_BAR_TOGGLE_LABEL_ID[key] })}
              checked={readToggle(preferences, key)}
              onCheckedChange={(checked) =>
                setUsageStatusbarPreferences(buildUsageBarPreferencePatch(key, checked))
              }
            />
          }
        />
      ))}
    </SettingsGroupCard>
  );
}
