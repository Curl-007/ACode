import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Switch } from "@/components/ui/switch.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  setUsageStatusbarPreferences,
  USAGE_STATUSBAR_ITEM_IDS,
  type UsageStatusbarItemId,
} from "@/lib/usageStatusbarPreferences.js";
import { useUsageStatusbarPreferences } from "@/v4/usage-statusbar/useUsageStatusbarPreferences.js";

// 设置齿轮 popover：逐项显隐 + 速率行开关（specs/usage-statusbar.md「设置齿轮」行）。
// 写入只走 lib 唯一写入口；本组件不持有偏好状态副本（Zustand/局部 state 都不当事实源）。
// 浮层规范照 DESIGN.md §Menus, Popovers：bg-popover + border-popover-border（组件默认），
// 紧凑行、弱分隔，不做子卡片堆叠。

const ITEM_LABEL_MESSAGE_ID: Record<UsageStatusbarItemId, string> = {
  generationSpeed: "chat.usageStatusbar.speed.label",
  turnUsage: "chat.usageStatusbar.turnUsage.label",
  sessionCumulative: "chat.usageStatusbar.session.label",
  toolCalls: "chat.usageStatusbar.tools.label",
  todayTotal: "chat.usageStatusbar.today.label",
  subagents: "chat.usageStatusbar.subagents.label",
};

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function ToggleRow({ label, checked, onCheckedChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-ui-base hover:bg-hover">
      <span className="min-w-0 truncate text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export function UsageStatusbarSettingsPopover() {
  const { intl } = useACodeIntl();
  const preferences = useUsageStatusbarPreferences();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={intl.formatMessage({ id: "chat.usageStatusbar.settings.label" })}
          className="size-6 shrink-0 text-foreground-subtle"
          data-testid="usage-statusbar-settings"
        >
          <Settings2 className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={4} className="w-64 gap-1 p-1.5">
        <span className="px-2 pb-1 pt-0.5 text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "chat.usageStatusbar.settings.title" })}
        </span>
        {USAGE_STATUSBAR_ITEM_IDS.map((itemId) => (
          <ToggleRow
            key={itemId}
            checked={preferences.visibleItems[itemId]}
            label={intl.formatMessage({ id: ITEM_LABEL_MESSAGE_ID[itemId] })}
            onCheckedChange={(checked) => {
              setUsageStatusbarPreferences({ visibleItems: { [itemId]: checked } });
            }}
          />
        ))}
        <span className="my-1 border-t border-border" />
        <ToggleRow
          checked={preferences.rateLineEnabled}
          label={intl.formatMessage({ id: "chat.usageStatusbar.settings.rateLine" })}
          onCheckedChange={(checked) => {
            setUsageStatusbarPreferences({ rateLineEnabled: checked });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
