import { EyeIcon, EyeOffIcon } from "lucide-react";
import { TID_MODEL_PROVIDER_API_KEY_INPUT } from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";

export function ApiKeyInput({
  value,
  visible,
  readOnly,
  disabled,
  storedInVault,
  onChange,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onToggleVisibility,
}: {
  value: string;
  visible: boolean;
  /** 只读 = 不可改（含 reveal 展示明文时的「展示值与草稿值分离」）。 */
  readOnly?: boolean;
  /** 置灰禁用（readOnlyEndpoints 卡片）；缺省跟随 readOnly。reveal 展示态不置灰。 */
  disabled?: boolean;
  /** Key 已 vault 化（P1-5）：字段为空是「不回显」而非「未配置」，占位符需如实提示。 */
  storedInVault?: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onToggleVisibility: () => void;
}) {
  const { intl } = useACodeIntl();
  const inputDisabled = disabled ?? readOnly;

  // 眼睛不再因 readOnly 禁用（安全加固 handoff §5.5「已存储 Key 的用户可见性」）：
  // 只读 = 不可改，不等于不可看——已存 vault 的 Key 也要能点眼睛查看明文。
  // visible 即 text：readOnly 上下文展示 reveal 明文时同样需要明文形态。
  const visibilityLabel = intl.formatMessage({
    id: visible ? "settings.modelProvider.hideApiKey" : "settings.modelProvider.showApiKey",
  });

  return (
    <div className="relative">
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type={visible ? "text" : "password"}
        size="lg"
        data-testid={TID_MODEL_PROVIDER_API_KEY_INPUT}
        className="pr-10 h-9"
        placeholder={intl.formatMessage({
          id: storedInVault
            ? "settings.modelProvider.apiKeyConfiguredPlaceholder"
            : "settings.modelProvider.apiKeyPlaceholder",
        })}
        value={value}
        readOnly={readOnly}
        disabled={inputDisabled}
        onChange={(event) => {
          if (!readOnly) {
            onChange(event.target.value);
          }
        }}
        onBlur={readOnly ? undefined : onBlur}
        onKeyDown={readOnly ? undefined : onKeyDown}
        onCompositionStart={readOnly ? undefined : onCompositionStart}
        onCompositionEnd={readOnly ? undefined : onCompositionEnd}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        aria-label={visibilityLabel}
        title={visibilityLabel}
        onClick={onToggleVisibility}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
