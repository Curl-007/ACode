import { Copy, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotConfig } from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

export interface WeComConfigValues {
  wecomCorpId: string;
  wecomAgentId: string;
  wecomEncodingAESKey: string;
  corpSecret?: string;
  callbackToken?: string;
}

/**
 * 企业微信自建应用配置面板。corpid/agentid/EncodingAESKey 为普通配置字段，
 * CorpSecret 与回调 Token 走加密凭据；一次性提交避免半配置回调验签失败。
 */
export function WeComSettingsPanel({
  bot,
  saving,
  onSave,
}: {
  bot: BotConfig;
  saving: boolean;
  onSave: (values: WeComConfigValues) => void;
}) {
  const { intl } = useACodeIntl();
  const [corpId, setCorpId] = useState(bot.wecomCorpId ?? "");
  const [agentId, setAgentId] = useState(bot.wecomAgentId ?? "");
  const [encodingAESKey, setEncodingAESKey] = useState(bot.wecomEncodingAESKey ?? "");
  const [corpSecret, setCorpSecret] = useState("");
  const [callbackToken, setCallbackToken] = useState("");

  useEffect(() => {
    setCorpId(bot.wecomCorpId ?? "");
    setAgentId(bot.wecomAgentId ?? "");
    setEncodingAESKey(bot.wecomEncodingAESKey ?? "");
    setCorpSecret("");
    setCallbackToken("");
  }, [bot.id, bot.wecomCorpId, bot.wecomAgentId, bot.wecomEncodingAESKey]);

  const callbackPath = `/api/bots/wecom/${bot.id}`;
  const callbackUrl =
    typeof window !== "undefined" && window.location.origin.startsWith("http")
      ? `${window.location.origin}${callbackPath}`
      : callbackPath;

  const copyCallbackUrl = () => {
    void navigator.clipboard?.writeText(callbackUrl).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] 复制企业微信回调地址失败",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.wecom.callbackUrlCopied" }));
  };

  const canSave =
    !saving &&
    corpId.trim().length > 0 &&
    agentId.trim().length > 0 &&
    encodingAESKey.trim().length > 0;

  return (
    <div className="space-y-3 text-ui-base">
      <Field
        label={intl.formatMessage({ id: "bots.wecom.corpId" })}
        value={corpId}
        onChange={setCorpId}
        disabled={saving}
      />
      <Field
        label={intl.formatMessage({ id: "bots.wecom.agentId" })}
        value={agentId}
        onChange={setAgentId}
        disabled={saving}
      />
      <Field
        label={intl.formatMessage({ id: "bots.wecom.encodingAESKey" })}
        value={encodingAESKey}
        onChange={setEncodingAESKey}
        disabled={saving}
      />
      <Field
        label={intl.formatMessage({ id: "bots.wecom.corpSecret" })}
        value={corpSecret}
        onChange={setCorpSecret}
        disabled={saving}
        type="password"
        placeholder={bot.credentialRef ? "••••••••" : undefined}
      />
      <Field
        label={intl.formatMessage({ id: "bots.wecom.callbackToken" })}
        value={callbackToken}
        onChange={setCallbackToken}
        disabled={saving}
        type="password"
        placeholder={bot.webhookSecretRef ? "••••••••" : undefined}
      />
      <div className="space-y-1">
        <div className="text-foreground-subtle">
          {intl.formatMessage({ id: "bots.wecom.callbackUrl" })}
        </div>
        <div className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5">
          <span className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground">
            {callbackUrl}
          </span>
          <Button variant="ghost" size="sm" onClick={copyCallbackUrl} type="button">
            <Copy className="size-4" />
          </Button>
        </div>
        <div className="text-ui-base leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "bots.wecom.verifyHint" })}
        </div>
      </div>
      <Button
        variant="outline"
        size="lg"
        type="button"
        disabled={!canSave}
        onClick={() =>
          onSave({
            wecomCorpId: corpId.trim(),
            wecomAgentId: agentId.trim(),
            wecomEncodingAESKey: encodingAESKey.trim(),
            ...(corpSecret.trim() ? { corpSecret: corpSecret.trim() } : {}),
            ...(callbackToken.trim() ? { callbackToken: callbackToken.trim() } : {}),
          })
        }
      >
        {saving ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <KeyRound className="size-4" />
        )}
        {intl.formatMessage({ id: "bots.saveSecret" })}
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-foreground-subtle">{label}</div>
      <Input
        size="lg"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
