import type { OfficialServiceKey, OfficialServiceSwitches } from "@acode/shared";
import { Switch } from "@/components/ui/switch.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface OfficialServicesSettingsSectionProps {
  switches?: Partial<OfficialServiceSwitches>;
  onToggle: (key: OfficialServiceKey, enabled: boolean) => void;
}

/** 展开顺序即页面顺序；分享已永久下线，不在此列。 */
const OFFICIAL_SERVICE_FEATURES: readonly OfficialServiceKey[] = [
  "account",
  "codingPlan",
  "feedback",
  "officialMcp",
  "offPeak",
  "marketplace",
  "clientConfig",
];

export function OfficialServicesSettingsSection({
  switches,
  onToggle,
}: OfficialServicesSettingsSectionProps) {
  const { intl } = useACodeIntl();
  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <div className="px-4 pb-2 pt-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.officialServices.title" })}
          </div>
          <div className="mt-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-ui-sm text-warning">
            {intl.formatMessage({ id: "settings.officialServices.description" })}
          </div>
        </div>
        {OFFICIAL_SERVICE_FEATURES.map((key) => {
          const label = intl.formatMessage({ id: `settings.officialServices.${key}.title` });
          return (
            <SettingsRow
              key={key}
              label={label}
              description={intl.formatMessage({ id: `settings.officialServices.${key}.desc` })}
              control={
                <Switch
                  aria-label={label}
                  checked={switches?.[key] === true}
                  onCheckedChange={(checked) => onToggle(key, checked)}
                />
              }
            />
          );
        })}
      </SettingsGroupCard>
    </div>
  );
}
