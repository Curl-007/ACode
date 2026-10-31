/* eslint-disable max-lines -- BotsDialog 只剩编排接线：数据层/写入动作/扫码注册/轮询四组已批次 7 收口进 BotsDialog/useBotsDialog*.ts，卡片在 BotsDialog/* 子组件。 */
import { useCallback, useEffect, useRef } from "react";
import { Bot } from "lucide-react";
import type { BotProvider } from "@acode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  getBotProviderRegionTagLabelId,
  resolveBotProviderEntry,
  type BotProviderEntryId,
} from "@/botsUi.js";
import { TELEGRAM_BOTFATHER_URL } from "@/BotsDialog/shared.js";
import {
  resolveBindCountdown,
} from "@/BotsDialog/botsDialogPolling.js";
import { resolveBotAutoConnectAction } from "@/BotsDialog/botsDialogModels.js";
import { useBotsDialogData } from "@/BotsDialog/useBotsDialogData.js";
import { useBotsDialogActions } from "@/BotsDialog/useBotsDialogActions.js";
import { useBotsDialogRegistrations } from "@/BotsDialog/useBotsDialogRegistrations.js";
import { useBotsDialogBindCodePolling } from "@/BotsDialog/useBotsDialogBindCodePolling.js";
import { useBotsDialogStatusPolling } from "@/BotsDialog/useBotsDialogStatusPolling.js";
import { BotsDialogSidebar } from "@/BotsDialog/BotsDialogSidebar.js";
import { BotsDialogCreatePanel } from "@/BotsDialog/BotsDialogCreatePanel.js";
import {
  BotsDialogDetailPanel,
  BotsDialogEmptyState,
} from "@/BotsDialog/BotsDialogDetailPanel.js";

export function BotsDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  entryProvider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  entryProvider?: BotProvider | null;
}) {
  const { intl } = useACodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const { botsService } = useServices();
  const botNameCompositionActiveRef = useRef(false);
  const autoQrStartedBotIdsRef = useRef(new Set<string>());
  const autoBindCreatingBotIdsRef = useRef(new Set<string>());
  const handledEntryProviderRef = useRef<BotProvider | null>(null);

  const data = useBotsDialogData({
    botsService,
    intl,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  const actions = useBotsDialogActions({
    data,
    botsService,
    intl,
    confirmDialog,
    botNameCompositionActiveRef,
  });
  const registrations = useBotsDialogRegistrations({ botsService, intl, data });
  useBotsDialogBindCodePolling({
    open,
    bindExpired: resolveBindCountdown(registrations.bindCode, registrations.nowMs).expired,
    bindCode: registrations.bindCode,
    selectedBot: data.selectedBot,
    botsService,
    setConfig: data.setConfig,
    setBindCode: registrations.setBindCode,
    setNowMs: registrations.setNowMs,
  });
  useBotsDialogStatusPolling({
    open,
    botsService,
    intl,
    selectedBot: data.selectedBot,
    selectedBotState: data.selectedBotState,
    feishuRegistration: registrations.feishuRegistration,
    weixinRegistration: registrations.weixinRegistration,
    saveBot: actions.saveBot,
    setConfig: data.setConfig,
    setBotStates: data.setBotStates,
    setStatus: data.setStatus,
    setFeishuRegistration: registrations.setFeishuRegistration,
    setWeixinRegistration: registrations.setWeixinRegistration,
  });

  const {
    config,
    configLoaded,
    creatingBot,
    currentWorkspace,
    selectedBot,
    selectedBotId,
    selectedBotState,
    setConfig,
    setConfigLoaded,
    setCreatingBot,
    setSelectedBotId,
    status,
    workspaceRefs,
  } = data;
  const {
    commitBotNameDraft,
    creatingProvider,
    credentialValue,
    fallbackBotName,
    handleAddBot,
    handleBotNameKeyDown,
    handleDelete,
    handleDialogEscapeKeyDown,
    handleSaveSecret,
    handleSaveWeCom,
    handleUnbind,
    patchAllowedWorkspaces,
    patchSelectedBot,
    renamingBotId,
    secretSaving,
    selectedBotDisplayName,
    selectedBotName,
    setBotNameDraft,
    setCreatingProvider,
    setCredentialValue,
    setSecretSaving,
    setWorkspaceAccessSaving,
    startBotNameRename,
    toggleWorkspaceAccess,
    workspaceAccessSaving,
  } = actions;
  const {
    bindCode,
    createBindCodeForBot,
    feishuRegistration,
    feishuRegistrationLoading,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    nowMs,
    setBindCode,
    setFeishuRegistration,
    setWeixinRegistration,
    weixinRegistration,
    weixinRegistrationLoading,
  } = registrations;

  const bindCountdown = resolveBindCountdown(bindCode, nowMs);
  const selectedRuntime = selectedBot
    ? status?.botRuntime.find((item) => item.botId === selectedBot.id)
    : undefined;

  useEffect(() => {
    setCredentialValue("");
    setSecretSaving(false);
    setWorkspaceAccessSaving(false);
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [
    selectedBotId,
    selectedBot?.provider,
    setCredentialValue,
    setFeishuRegistration,
    setSecretSaving,
    setWeixinRegistration,
    setWorkspaceAccessSaving,
  ]);

  useEffect(() => {
    handledEntryProviderRef.current = null;
  }, [entryProvider, open]);

  useEffect(() => {
    if (open) {
      setConfigLoaded(false);
      void data.refresh();
    }
  }, [open, data.refresh, setConfigLoaded]);

  useEffect(() => {
    // 自动扫码 / 自动续绑定码的 120 行分支链收在 resolveBotAutoConnectAction（纯决策表，
    // 批次 6 外迁）。effect 只负责副作用：ref 去重集合的增删与发起动作。
    const action = resolveBotAutoConnectAction({
      open,
      creatingBot,
      selectedBot,
      bindCode,
      bindExpired: bindCountdown.expired,
      feishuRegistration,
      feishuRegistrationLoading,
      weixinRegistration,
      weixinRegistrationLoading,
      autoQrStartedKeys: autoQrStartedBotIdsRef.current,
      autoBindCreatingIds: autoBindCreatingBotIdsRef.current,
    });

    if (action.kind === "none") {
      return;
    }

    if (action.kind === "create-bind-code") {
      if (!selectedBot) {
        return;
      }
      autoBindCreatingBotIdsRef.current.add(selectedBot.id);
      void createBindCodeForBot(selectedBot).finally(() => {
        autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      });
      return;
    }

    autoQrStartedBotIdsRef.current.add(action.dedupeKey);
    if (action.kind === "start-feishu-qr") {
      void handleStartFeishuRegistration();
      return;
    }
    void handleStartWeixinRegistration();
  }, [
    bindCode,
    bindCountdown.expired,
    createBindCodeForBot,
    creatingBot,
    feishuRegistration,
    feishuRegistrationLoading,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    open,
    selectedBot,
    weixinRegistration,
    weixinRegistrationLoading,
  ]);

  useEffect(() => {
    if (!open || !entryProvider || !configLoaded) {
      return;
    }
    if (handledEntryProviderRef.current === entryProvider) {
      return;
    }

    const entry = resolveBotProviderEntry(config.bots, entryProvider);
    handledEntryProviderRef.current = entryProvider;
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);

    if (entry.mode === "select") {
      setCreatingBot(false);
      setCreatingProvider(null);
      setSelectedBotId(entry.botId);
      return;
    }

    // Bugfix: 远程控制弹窗新增 Bot Channel 快捷入口后，进入 BotsDialog 不能停在空白选择页。
    // 这里在配置加载完成后再判断并创建，避免异步刷新尚未拿到已有 bot 时重复新建。
    setCreatingBot(true);
    setSelectedBotId(null);
    void handleAddBot(entry.provider);
  }, [
    config.bots,
    configLoaded,
    entryProvider,
    handleAddBot,
    open,
    setCreatingBot,
    setCreatingProvider,
    setCredentialValue,
    setFeishuRegistration,
    setSelectedBotId,
    setWeixinRegistration,
  ]);

  const handleBeginAddBot = useCallback(() => {
    setCreatingBot(true);
    setCreatingProvider(null);
    setSelectedBotId(null);
    setCredentialValue("");
    setFeishuRegistration(null);
    setWeixinRegistration(null);
  }, [
    setCreatingBot,
    setCreatingProvider,
    setCredentialValue,
    setFeishuRegistration,
    setSelectedBotId,
    setWeixinRegistration,
  ]);

  const handleCreateBindCode = async () => {
    if (!selectedBot) return;
    await createBindCodeForBot(selectedBot);
  };

  const handleOpenTelegramBotFather = () => {
    platform.openExternal(TELEGRAM_BOTFATHER_URL);
  };

  const copyBindCommand = async () => {
    if (!bindCode || bindCountdown.expired) return;
    const command = `/bind ${bindCode.code}`;
    await navigator.clipboard?.writeText(command).catch((error: unknown) => {
      logger.warn(
        "[BotsDialog] 复制绑定命令失败",
        error instanceof Error ? error.message : String(error),
      );
    });
    toast(intl.formatMessage({ id: "bots.bindCommandCopied" }));
  };

  const handleRemoveSecret = async () => {
    if (!selectedBot) return;
    try {
      const saved = await botsService.removeBotSecret(selectedBot.id);
      autoQrStartedBotIdsRef.current.delete(
        `${selectedBot.id}:feishu-registration`,
      );
      autoQrStartedBotIdsRef.current.delete(
        `${selectedBot.id}:weixin-registration`,
      );
      autoBindCreatingBotIdsRef.current.delete(selectedBot.id);
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((item) =>
          item.id === saved.id ? saved : item,
        ),
      }));
      setCredentialValue("");
      setBindCode(null);
      void data.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 移除 Bot secret 失败", message);
      toast(
        intl.formatMessage(
          { id: "bots.removeSecretFailed" },
          { error: message },
        ),
      );
    }
  };

  const renderChannelName = (provider: BotProviderEntryId) => {
    const regionTagLabelId = getBotProviderRegionTagLabelId(provider);

    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: `bots.channel.${provider}` })}
        </span>
        {regionTagLabelId ? (
          <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
            {intl.formatMessage({ id: regionTagLabelId })}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[calc(100vh-6rem)] max-h-168 max-w-4xl flex-col overflow-hidden rounded-2xl"
        onEscapeKeyDown={handleDialogEscapeKeyDown}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Bot className="size-5 text-foreground" />
            <DialogTitle className="text-lg font-medium text-foreground">
              {intl.formatMessage({ id: "bots.title" })}
            </DialogTitle>
            <DialogDescription className="ml-3">
              {intl.formatMessage({ id: "bots.description" })}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3">
          <BotsDialogSidebar
            bots={config.bots}
            status={status}
            selectedBotId={selectedBotId}
            creatingBot={creatingBot}
            fallbackBotName={fallbackBotName}
            onBeginAddBot={handleBeginAddBot}
            onSelectBot={(botId) => {
              setCreatingBot(false);
              setSelectedBotId(botId);
            }}
            renderChannelName={renderChannelName}
          />

          <section className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-background p-4">
            {creatingBot ? (
              <BotsDialogCreatePanel
                creatingProvider={creatingProvider}
                onAddBot={(provider) => {
                  void handleAddBot(provider);
                }}
                renderChannelName={renderChannelName}
              />
            ) : !selectedBot ? (
              <BotsDialogEmptyState onBeginAddBot={handleBeginAddBot} />
            ) : (
              <BotsDialogDetailPanel
                bot={selectedBot}
                runtime={selectedRuntime}
                workspaceRefs={workspaceRefs}
                currentWorkspace={currentWorkspace}
                selectedBotDisplayName={selectedBotDisplayName}
                selectedBotName={selectedBotName}
                fallbackBotName={fallbackBotName}
                renaming={renamingBotId === selectedBot.id}
                credentialValue={credentialValue}
                bindCode={bindCode}
                bindExpired={bindCountdown.expired}
                bindRemainingMs={bindCountdown.remainingMs}
                bindCountdownProgress={bindCountdown.progress}
                feishuRegistration={feishuRegistration}
                feishuRegistrationLoading={feishuRegistrationLoading}
                weixinRegistration={weixinRegistration}
                weixinRegistrationLoading={weixinRegistrationLoading}
                weixinActivated={Boolean(selectedBotState?.weixinActivatedAt)}
                secretSaving={secretSaving}
                workspaceAccessSaving={workspaceAccessSaving}
                onStartRename={startBotNameRename}
                onCommitNameDraft={commitBotNameDraft}
                onNameDraftChange={(value) =>
                  setBotNameDraft({ botId: selectedBot.id, value })
                }
                onNameCompositionEnd={() => {
                  botNameCompositionActiveRef.current = false;
                }}
                onNameCompositionStart={() => {
                  botNameCompositionActiveRef.current = true;
                }}
                onNameInputKeyDown={handleBotNameKeyDown}
                onPatchBot={patchSelectedBot}
                onCredentialValueChange={setCredentialValue}
                onSaveSecret={() => void handleSaveSecret()}
                onSaveWeCom={(values) => void handleSaveWeCom(values)}
                onRemoveSecret={() => void handleRemoveSecret()}
                onOpenTelegramBotFather={handleOpenTelegramBotFather}
                onStartWeixinRegistration={() => void handleStartWeixinRegistration()}
                onStartFeishuRegistration={() => void handleStartFeishuRegistration()}
                onCreateBindCode={() => void handleCreateBindCode()}
                onUnbind={() => void handleUnbind()}
                onCopyBindCommand={() => void copyBindCommand()}
                onPatchAllowedWorkspaces={patchAllowedWorkspaces}
                onToggleWorkspaceAccess={toggleWorkspaceAccess}
                onDelete={() => void handleDelete()}
              />
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
