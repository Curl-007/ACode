/**
 * BotsDialog 的配置/状态数据层（批次 7 外迁，模式 B 第一刀）。
 *
 * 收口 `BotsDialog.tsx` 的 config / status / workspaceRefs / botStates / selectedBotId /
 * creatingBot / configLoaded 七个 state，以及 `refresh` 编排与选中 Bot 的派生值。
 * 写入路径（`saveBot`）在 `useBotsDialogBotActions.ts`——它需要这里的 setter 与 `refresh`，
 * 但数据层本身不认识「保存语义」，保持单向依赖。
 *
 * `refresh` 的 deps 与迁移前逐字一致（含 `creatingBot`：新建流程中不能被首条配置抢走选中项）。
 */
import { useCallback, useMemo, useState } from "react";
import type {
  BotConfig,
  BotServiceStatus,
  BotState,
  BotWorkspaceRef,
  BotsConfigFile,
} from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import type { useServices } from "@/hooks/useServices.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { buildCurrentWorkspaceId } from "@/botsUi.js";
import { createEmptyConfig } from "@/BotsDialog/botsDialogModels.js";

export interface BotsDialogDataInput {
  botsService: ReturnType<typeof useServices>["botsService"];
  intl: ReturnType<typeof useACodeIntl>["intl"];
  workspacePath: string;
  workspaceIdentity?: string;
}

export function useBotsDialogData({
  botsService,
  intl,
  workspacePath,
  workspaceIdentity,
}: BotsDialogDataInput) {
  const [config, setConfig] = useState<BotsConfigFile>(() => createEmptyConfig());
  const [workspaceRefs, setWorkspaceRefs] = useState<BotWorkspaceRef[]>([]);
  const [status, setStatus] = useState<BotServiceStatus | null>(null);
  const [botStates, setBotStates] = useState<BotState[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const currentWorkspaceId = useMemo(
    () => buildCurrentWorkspaceId(workspacePath, workspaceIdentity),
    [workspaceIdentity, workspacePath],
  );
  const currentWorkspace = useMemo(
    () => ({
      id: currentWorkspaceId,
      label:
        workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath,
      workspacePath,
      workspaceIdentity,
    }),
    [currentWorkspaceId, workspaceIdentity, workspacePath],
  );
  const selectedBot: BotConfig | null =
    config.bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotState: BotState | null =
    botStates.find((state) => state.botId === selectedBotId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextWorkspaces, nextBotStates] =
        await Promise.all([
          botsService.getConfig(),
          botsService.getStatus(),
          botsService.listWorkspaceRefs({ currentWorkspace }),
          botsService.getBotStates(),
        ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setWorkspaceRefs(nextWorkspaces);
      setBotStates(nextBotStates);
      setConfigLoaded(true);
      setSelectedBotId((current) =>
        creatingBot ? current : (current ?? nextConfig.bots[0]?.id ?? null),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 加载 Bots 配置失败", message);
      toast(intl.formatMessage({ id: "bots.loadFailed" }, { error: message }));
    }
  }, [botsService, creatingBot, currentWorkspace, intl]);

  return {
    botStates,
    config,
    configLoaded,
    creatingBot,
    currentWorkspace,
    refresh,
    selectedBot,
    selectedBotId,
    selectedBotState,
    setBotStates,
    setConfig,
    setConfigLoaded,
    setCreatingBot,
    setSelectedBotId,
    setStatus,
    setWorkspaceRefs,
    status,
    workspaceRefs,
  };
}

export type BotsDialogData = ReturnType<typeof useBotsDialogData>;
