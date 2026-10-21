/**
 * 用量状态栏右端的齿轮弹层（apps/acode-cli/specs/usage-statusbar-port.md §2.3）。
 *
 * 与设置页的同一组开关写同一个 localStorage 切片（lib/usageStatusbarPreferences.ts）：
 * 不提供总开关（总开关关闭后整条栏连齿轮一起消失，没有第二入口）。
 */
import { memo } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { TID_SETTINGS_COMPOSER_USAGE_BAR_SWITCH } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Switch } from "@/components/ui/switch.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { setUsageStatusbarPreferences } from "@/lib/usageStatusbarPreferences.js";
import {
  USAGE_BAR_TOGGLE_LABEL_ID,
  USAGE_BAR_TOGGLE_ORDER,
  USAGE_BAR_TOGGLE_PREFERENCE_KEY,
  type UsageBarSettings,
  type UsageBarSubToggleKey,
} from "./usageBarModel.js";

export function buildUsageBarPreferencePatch(
  key: UsageBarSubToggleKey,
  checked: boolean,
): Parameters<typeof setUsageStatusbarPreferences>[0] {
  const preferenceKey = USAGE_BAR_TOGGLE_PREFERENCE_KEY[key];
  return preferenceKey === "answerFooter"
    ? { answerFooter: checked }
    : { visibleItems: { [preferenceKey]: checked } };
}

export const UsageBarSettingsPopover = memo(function UsageBarSettingsPopoverImpl({
  settings,
  testId,
  writable = true,
}: {
  settings: UsageBarSettings;
  testId: string;
  /** 无 Service/存储的只读宿主传 false；默认允许写设置切片。 */
  writable?: boolean;
}) {
  return <UsageBarSettingsPopoverView settings={settings} testId={testId} writable={writable} />;
});

function UsageBarSettingsPopoverView({
  settings,
  testId,
  writable,
}: {
  settings: UsageBarSettings;
  testId: string;
  writable: boolean;
}) {
  const { intl } = useACodeIntl();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={testId}
          aria-label={intl.formatMessage({ id: "chat.usageStatusbar.settings.title" })}
          className="size-6 rounded-md text-foreground-subtle hover:text-foreground"
        >
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-64 gap-1 p-2">
        <p className="px-1.5 pt-1 pb-0.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.usageStatusbar.settings.title" })}
        </p>
        {USAGE_BAR_TOGGLE_ORDER.map((key, index) => (
          <div key={key}>
            {index === USAGE_BAR_TOGGLE_ORDER.length - 1 ? (
              <div className="my-1 h-px bg-border" aria-hidden />
            ) : null}
            <label
              className={cn(
                "flex h-8 cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 text-ui-sm",
                "hover:bg-hover",
              )}
            >
              <span>{intl.formatMessage({ id: USAGE_BAR_TOGGLE_LABEL_ID[key] })}</span>
              <Switch
                size="sm"
                checked={settings[key]}
                disabled={!writable}
                data-testid={`${TID_SETTINGS_COMPOSER_USAGE_BAR_SWITCH}-${key}`}
                data-usage-bar-key={key}
                aria-label={intl.formatMessage({ id: USAGE_BAR_TOGGLE_LABEL_ID[key] })}
                onCheckedChange={(checked) => {
                  if (!writable) return;
                  setUsageStatusbarPreferences(buildUsageBarPreferencePatch(key, checked));
                }}
              />
            </label>
          </div>
        ))}
        <p className="px-1.5 pt-1 text-ui-xs leading-relaxed text-foreground-subtlest">
          {intl.formatMessage({ id: "chat.usageStatusbar.settings.hint" })}
        </p>
      </PopoverContent>
    </Popover>
  );
}
