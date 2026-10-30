/**
 * BotsDialog 的写入路径与 Bot 操作（批次 7 外迁，模式 B 第二刀）。
 *
 * 收口 `saveBot`（配置写入的唯一入口）与围绕它的所有动作：字段补丁、重命名草稿、
 * 凭据/企业微信保存、解绑、删除、工作区访问范围、新建 Bot。所有 setter 来自
 * `useBotsDialogData`，本 hook 不再重复持有 config/selectedBot。
 *
 * 重命名与 IME 语义逐字保留：输入过程中只改本地草稿，提交（blur/Enter）时才写配置，
 * 避免服务层 trim 回写吃掉用户正在输入的尾部空格。
 */
import { useCallback, useState, type KeyboardEvent, type RefObject } from "react";
import type { BotConfig, BotProvider } from "@acode/shared";
import { ALL_BOT_WORKSPACES } from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import type { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import type { useServices } from "@/hooks/useServices.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { logger } from "@/logger.js";
import { formatBotDisplayName, isAllWorkspacesAllowed } from "@/BotsDialog/shared.js";
import { createDraftBot } from "@/BotsDialog/botsDialogModels.js";
import type { BotsDialogData } from "@/BotsDialog/useBotsDialogData.js";

export interface BotsDialogActionsInput {
  data: BotsDialogData;
  botsService: ReturnType<typeof useServices>["botsService"];
  intl: ReturnType<typeof useACodeIntl>["intl"];
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  botNameCompositionActiveRef: RefObject<boolean>;
}

export function useBotsDialogActions({
  data,
  botsService,
  intl,
  confirmDialog,
  botNameCompositionActiveRef,
}: BotsDialogActionsInput) {
  const {
    refresh,
    selectedBot,
    setConfig,
    setCreatingBot,
    setSelectedBotId,
    workspaceRefs,
  } = data;

  const [credentialValue, setCredentialValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [workspaceAccessSaving, setWorkspaceAccessSaving] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState<BotProvider | null>(null);
  const [botNameDraft, setBotNameDraft] = useState<{
    botId: string;
    value: string;
  } | null>(null);
  const [renamingBotId, setRenamingBotId] = useState<string | null>(null);

  const selectedBotName =
    selectedBot && botNameDraft?.botId === selectedBot.id
      ? botNameDraft.value
      : (selectedBot?.name ?? "");
  const fallbackBotName = intl.formatMessage({
    id: "bots.newBot.fallbackName",
  });
  const selectedBotDisplayName = formatBotDisplayName(
    selectedBotName,
    fallbackBotName,
  );

  const saveBot = useCallback(
    async (
      bot: BotConfig,
      secrets?: { credentialValue?: string; webhookSecretValue?: string },
    ) => {
      const saved = await botsService.saveBot({
        bot,
        credentialValue: secrets?.credentialValue,
        webhookSecretValue: secrets?.webhookSecretValue,
      });
      setConfig((previous) => ({
        ...previous,
        bots: [...previous.bots.filter((item) => item.id !== saved.id), saved],
      }));
      setSelectedBotId(saved.id);
      setCreatingBot(false);
      setCredentialValue("");
      void refresh();
      return saved;
    },
    [botsService, refresh, setConfig, setCreatingBot, setSelectedBotId],
  );

  const patchSelectedBot = useCallback(
    (patch: Partial<BotConfig>) => {
      if (!selectedBot) return;
      void saveBot({ ...selectedBot, ...patch });
    },
    [saveBot, selectedBot],
  );

  const startBotNameRename = useCallback(() => {
    if (!selectedBot) return;
    setRenamingBotId(selectedBot.id);
    setBotNameDraft({ botId: selectedBot.id, value: selectedBot.name });
  }, [selectedBot]);

  const commitBotNameDraft = useCallback(() => {
    if (!selectedBot) return;
    const nextName = selectedBotName.trim();
    setBotNameDraft(null);
    setRenamingBotId(null);
    if (nextName === selectedBot.name) return;
    // Bugfix: Bot 名称输入过程中如果立即保存，服务层 trim 后的回写会吃掉刚输入的尾部空格，
    // 导致用户无法继续输入包含空格的名称；改为提交时保存，保留输入过程中的本地草稿。
    // 同时空名称是合法的未命名状态，展示层统一用多语言 fallback 名称兜底。
    void saveBot({ ...selectedBot, name: nextName });
  }, [saveBot, selectedBot, selectedBotName]);

  const handleBotNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: botNameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // Bugfix: Bot 名称重命名时中文输入法 Enter 是候选词确认，不是提交重命名。
          // 这里避免触发 blur，否则 blur 会继续走 commitBotNameDraft。
          logger.debug("[BotsDialog] ignore bot name enter during IME", {
            botId: selectedBot?.id ?? null,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Bugfix: 重命名输入框里的 Escape 只应该取消编辑，不能继续冒泡触发 Dialog 的关闭快捷键。
        setBotNameDraft(null);
        setRenamingBotId(null);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [botNameCompositionActiveRef, selectedBot?.id],
  );

  const handleDialogEscapeKeyDown = useCallback(
    (event: Event) => {
      if (renamingBotId === null) return;
      // Bugfix: Radix Dialog 会在输入框 React onKeyDown 冒泡前处理 Escape 关闭。
      // 正在重命名时需要在 Dialog 的关闭入口拦截，Esc 只取消编辑，不关闭弹窗。
      event.preventDefault();
      setBotNameDraft(null);
      setRenamingBotId(null);
    },
    [renamingBotId],
  );

  const patchAllowedWorkspaces = useCallback(
    async (allowedWorkspaces: string[]) => {
      if (!selectedBot) return;
      setWorkspaceAccessSaving(true);
      const normalizedAllowedWorkspaces =
        allowedWorkspaces.length > 0 ? allowedWorkspaces : [ALL_BOT_WORKSPACES];
      const previousBot = selectedBot;
      const optimisticBot = {
        ...selectedBot,
        allowedWorkspaces: normalizedAllowedWorkspaces,
      };
      setConfig((previous) => ({
        ...previous,
        bots: previous.bots.map((bot) =>
          bot.id === optimisticBot.id ? optimisticBot : bot,
        ),
      }));
      try {
        await saveBot(optimisticBot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 保存工作区访问范围失败", message);
        setConfig((previous) => ({
          ...previous,
          bots: previous.bots.map((bot) =>
            bot.id === previousBot.id ? previousBot : bot,
          ),
        }));
        toast(
          intl.formatMessage({ id: "bots.saveFailed" }, { error: message }),
        );
      } finally {
        setWorkspaceAccessSaving(false);
      }
    },
    [intl, saveBot, selectedBot, setConfig],
  );

  const toggleWorkspaceAccess = useCallback(
    async (workspaceId: string, checked: boolean) => {
      if (!selectedBot) return;
      const currentAllowed = isAllWorkspacesAllowed(
        selectedBot.allowedWorkspaces,
      )
        ? workspaceRefs.map((workspace) => workspace.id)
        : selectedBot.allowedWorkspaces;
      const nextAllowed = checked
        ? [...new Set([...currentAllowed, workspaceId])]
        : currentAllowed.filter((id) => id !== workspaceId);
      await patchAllowedWorkspaces(nextAllowed);
    },
    [patchAllowedWorkspaces, selectedBot, workspaceRefs],
  );

  const handleAddBot = useCallback(
    async (provider: BotProvider) => {
      if (creatingProvider) return;
      setCreatingProvider(provider);
      const bot = createDraftBot({
        provider,
      });
      try {
        await saveBot({
          ...bot,
          name: "",
          ...(provider === "webhook"
            ? { webhookAuthHeaderName: "x-acode-bot-secret" }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[BotsDialog] 创建 Bot 失败", message);
        toast(
          intl.formatMessage({ id: "bots.saveFailed" }, { error: message }),
        );
      } finally {
        setCreatingProvider(null);
      }
    },
    [creatingProvider, intl, saveBot],
  );

  const handleSaveSecret = async () => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(selectedBot, { credentialValue });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 保存 Bot secret 失败", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  const handleSaveWeCom = async (values: {
    wecomCorpId: string;
    wecomAgentId: string;
    wecomEncodingAESKey: string;
    corpSecret?: string;
    callbackToken?: string;
  }) => {
    if (!selectedBot || secretSaving) return;
    setSecretSaving(true);
    try {
      await saveBot(
        {
          ...selectedBot,
          wecomCorpId: values.wecomCorpId,
          wecomAgentId: values.wecomAgentId,
          wecomEncodingAESKey: values.wecomEncodingAESKey,
        },
        {
          credentialValue: values.corpSecret,
          webhookSecretValue: values.callbackToken,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 保存企业微信配置失败", message);
      toast(intl.formatMessage({ id: "bots.saveFailed" }, { error: message }));
    } finally {
      setSecretSaving(false);
    }
  };

  const handleUnbind = async () => {
    if (!selectedBot) return;
    await saveBot({
      ...selectedBot,
      providerUserId: undefined,
      displayName: undefined,
    });
    await botsService.resetBotState(selectedBot.id);
  };

  const handleDelete = async () => {
    if (!selectedBot) return;
    // Bugfix: 删除机器人之前没有二次确认，误触会直接移除凭据和绑定入口。
    // 这里复用项目统一 ConfirmDialog，让破坏性操作和其它设置页保持一致。
    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "bots.deleteConfirmTitle" },
        { name: formatBotDisplayName(selectedBot.name, fallbackBotName) },
      ),
      description: intl.formatMessage({ id: "bots.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "bots.delete" }),
    });
    if (!confirmed) return;

    try {
      await botsService.deleteBot(selectedBot.id);
      setSelectedBotId(null);
      void refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 删除 Bot 失败", message);
      toast(
        intl.formatMessage({ id: "bots.deleteFailed" }, { error: message }),
      );
    }
  };

  return {
    botNameDraft,
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
    saveBot,
    secretSaving,
    selectedBotDisplayName,
    selectedBotName,
    setBotNameDraft,
    setCreatingProvider,
    setCredentialValue,
    setRenamingBotId,
    setSecretSaving,
    setWorkspaceAccessSaving,
    startBotNameRename,
    toggleWorkspaceAccess,
    workspaceAccessSaving,
  };
}

export type BotsDialogActions = ReturnType<typeof useBotsDialogActions>;
