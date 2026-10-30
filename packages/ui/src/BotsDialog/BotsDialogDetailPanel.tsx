/**
 * BotsDialog 的选中 Bot 详情面板（批次 6 外迁）。
 *
 * 逐字迁移自 `BotsDialog.tsx` 的详情分支（BotSummaryCard / ProviderSettingsCard /
 * SettingsGroupCard / BotDangerCard 的编排），改为受控组件：所有状态与回调来自宿主。
 * 单独的「未选中」空态由 `BotsDialogEmptyState` 承载。
 */
import type {
  BotConfig,
  BotProvider,
  BotServiceStatus,
  BotWorkspaceRef,
} from "@acode/shared";
import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  BotDangerCard,
  BotEngineCard,
  BotPermissionModeCard,
  BotReplyGranularityCard,
  BotSummaryCard,
} from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import type {
  BindCodeState,
  FeishuRegistrationState,
  WeixinRegistrationState,
} from "@/BotsDialog/shared.js";
import { Bot, Plus } from "lucide-react";

export interface BotsDialogEmptyStateProps {
  onBeginAddBot: () => void;
}

export function BotsDialogEmptyState({ onBeginAddBot }: BotsDialogEmptyStateProps) {
  const { intl } = useACodeIntl();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
      <Bot className="size-8" />
      <div>{intl.formatMessage({ id: "bots.empty" })}</div>
      <Button variant="outline" size="lg" onClick={onBeginAddBot}>
        <Plus className="size-4" />
        {intl.formatMessage({ id: "bots.addBot" })}
      </Button>
    </div>
  );
}

export interface BotsDialogDetailPanelProps {
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  workspaceRefs: BotWorkspaceRef[];
  currentWorkspace: BotWorkspaceRef;
  selectedBotDisplayName: string;
  selectedBotName: string;
  fallbackBotName: string;
  renaming: boolean;
  credentialValue: string;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
  bindRemainingMs: number;
  bindCountdownProgress: number;
  feishuRegistration: FeishuRegistrationState | null;
  feishuRegistrationLoading: boolean;
  weixinRegistration: WeixinRegistrationState | null;
  weixinRegistrationLoading: boolean;
  weixinActivated: boolean;
  secretSaving: boolean;
  workspaceAccessSaving: boolean;
  onStartRename: () => void;
  onCommitNameDraft: () => void;
  onNameDraftChange: (value: string) => void;
  onNameCompositionStart: () => void;
  onNameCompositionEnd: () => void;
  onNameInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onPatchBot: (patch: Partial<BotConfig>) => void;
  onCredentialValueChange: (value: string) => void;
  onSaveSecret: () => void;
  onSaveWeCom: (values: {
    wecomCorpId: string;
    wecomAgentId: string;
    wecomEncodingAESKey: string;
    corpSecret?: string;
    callbackToken?: string;
  }) => void;
  onRemoveSecret: () => void;
  onOpenTelegramBotFather: () => void;
  onStartWeixinRegistration: () => void;
  onStartFeishuRegistration: () => void;
  onCreateBindCode: () => void;
  onUnbind: () => void;
  onCopyBindCommand: () => void;
  onPatchAllowedWorkspaces: (allowedWorkspaces: string[]) => Promise<void>;
  onToggleWorkspaceAccess: (workspaceId: string, checked: boolean) => Promise<void>;
  onDelete: () => void;
}

export function BotsDialogDetailPanel({
  bot,
  runtime,
  workspaceRefs,
  currentWorkspace,
  selectedBotDisplayName,
  selectedBotName,
  fallbackBotName,
  renaming,
  credentialValue,
  bindCode,
  bindExpired,
  bindRemainingMs,
  bindCountdownProgress,
  feishuRegistration,
  feishuRegistrationLoading,
  weixinRegistration,
  weixinRegistrationLoading,
  weixinActivated,
  secretSaving,
  workspaceAccessSaving,
  onStartRename,
  onCommitNameDraft,
  onNameDraftChange,
  onNameCompositionStart,
  onNameCompositionEnd,
  onNameInputKeyDown,
  onPatchBot,
  onCredentialValueChange,
  onSaveSecret,
  onSaveWeCom,
  onRemoveSecret,
  onOpenTelegramBotFather,
  onStartWeixinRegistration,
  onStartFeishuRegistration,
  onCreateBindCode,
  onUnbind,
  onCopyBindCommand,
  onPatchAllowedWorkspaces,
  onToggleWorkspaceAccess,
  onDelete,
}: BotsDialogDetailPanelProps) {
  return (
    <div className="space-y-4">
      <BotSummaryCard
        bot={bot}
        runtime={runtime}
        selectedBotDisplayName={selectedBotDisplayName}
        selectedBotName={selectedBotName}
        fallbackBotName={fallbackBotName}
        renaming={renaming}
        onStartRename={onStartRename}
        onCommitNameDraft={onCommitNameDraft}
        onNameDraftChange={onNameDraftChange}
        onNameCompositionEnd={onNameCompositionEnd}
        onNameCompositionStart={onNameCompositionStart}
        onNameInputKeyDown={onNameInputKeyDown}
        onPatchBot={onPatchBot}
      />

      <ProviderSettingsCard
        bot={bot}
        runtime={runtime}
        credentialValue={credentialValue}
        bindCode={bindCode}
        bindExpired={bindExpired}
        bindRemainingMs={bindRemainingMs}
        bindCountdownProgress={bindCountdownProgress}
        feishuRegistration={feishuRegistration}
        feishuRegistrationLoading={feishuRegistrationLoading}
        weixinRegistration={weixinRegistration}
        weixinRegistrationLoading={weixinRegistrationLoading}
        weixinActivated={weixinActivated}
        secretSaving={secretSaving}
        onCredentialValueChange={onCredentialValueChange}
        onSaveSecret={onSaveSecret}
        onSaveWeCom={onSaveWeCom}
        onRemoveSecret={onRemoveSecret}
        onOpenTelegramBotFather={onOpenTelegramBotFather}
        onStartWeixinRegistration={onStartWeixinRegistration}
        onStartFeishuRegistration={onStartFeishuRegistration}
        onCreateBindCode={onCreateBindCode}
        onUnbind={onUnbind}
        onCopyBindCommand={onCopyBindCommand}
      />

      <SettingsGroupCard>
        <BotEngineCard bot={bot} onPatchBot={onPatchBot} />

        <BotPermissionModeCard bot={bot} onPatchBot={onPatchBot} />

        <BotReplyGranularityCard bot={bot} onPatchBot={onPatchBot} />

        {/*
          暂不暴露命令权限编辑入口，避免用户在 bot 可用前把关键命令关掉。
          如果要恢复 UI，重新渲染 bot.allowedCommands 的列表并用 onPatchBot 保存。
        */}

        <WorkspaceAccessCard
          bot={bot}
          workspaceRefs={workspaceRefs}
          currentWorkspace={currentWorkspace}
          loading={workspaceAccessSaving}
          onPatchAllowedWorkspaces={onPatchAllowedWorkspaces}
          onToggleWorkspaceAccess={onToggleWorkspaceAccess}
        />
      </SettingsGroupCard>

      <BotDangerCard onDelete={onDelete} />
    </div>
  );
}

/** 渠道名渲染（含地区徽标）——唯一实现留在本叶子，宿主与列表/新建面板共用。 */
export function BotsDialogChannelName({
  provider,
  formatChannelName,
  regionTagLabelId,
}: {
  provider: BotProvider;
  formatChannelName: (provider: BotProvider) => string;
  regionTagLabelId: string | null;
}) {
  const { intl } = useACodeIntl();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">{formatChannelName(provider)}</span>
      {regionTagLabelId ? (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
          {intl.formatMessage({ id: regionTagLabelId })}
        </span>
      ) : null}
    </span>
  );
}

/** 供宿主判断 `renderChannelName` 是否可用的占位类型（避免宿主重复声明 BotProviderEntryId）。 */
export type BotsDialogChannelProvider = BotProvider;
