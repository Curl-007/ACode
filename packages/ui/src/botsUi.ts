import type {
  ACodeProvider,
  BotConfig,
  BotProvider,
  BotReplyGranularity,
} from "@acode/shared";
import {
  BOT_ACODE_PROVIDER_OPTIONS,
  getBotSelectablePermissionModes,
  getSupportedBotReplyGranularities,
} from "@acode/shared";

export type BotProviderEntryId = BotProvider | "dingding";

type BotProviderEntry =
  | { id: BotProvider; label: string; implemented: true }
  | { id: BotProviderEntryId; label: string; implemented: false };

export const BOT_PROVIDERS: BotProviderEntry[] = [
  { id: "weixin", label: "Weixin", implemented: true },
  { id: "feishu", label: "Feishu", implemented: true },
  { id: "lark", label: "Lark", implemented: true },
  { id: "telegram", label: "Telegram", implemented: true },
  { id: "dingding", label: "DingTalk", implemented: false },
  { id: "discord", label: "Discord", implemented: true },
  { id: "wecom", label: "WeCom", implemented: true },
  { id: "webhook", label: "Webhook", implemented: true },
];

export const BOT_REPLY_GRANULARITIES: Array<{
  id: BotReplyGranularity;
  labelId: string;
  descriptionId: string;
}> = [
  {
    id: "assistant_changes",
    labelId: "bots.replyGranularity.assistantChanges",
    descriptionId: "bots.replyGranularity.assistantChanges.description",
  },
  {
    id: "assistant_toolcalls_changes",
    labelId: "bots.replyGranularity.assistantToolcallsChanges",
    descriptionId: "bots.replyGranularity.assistantToolcallsChanges.description",
  },
  {
    id: "summary_changes",
    labelId: "bots.replyGranularity.summaryChanges",
    descriptionId: "bots.replyGranularity.summaryChanges.description",
  },
  {
    id: "streaming_card",
    labelId: "bots.replyGranularity.streamingCard",
    descriptionId: "bots.replyGranularity.streamingCard.description",
  },
];

export const DEFAULT_BOT_REPLY_GRANULARITY_ENTRY = BOT_REPLY_GRANULARITIES[0]!;

/**
 * Bot 可选引擎，由共享 BOT_ACODE_PROVIDER_OPTIONS（已过滤到 implemented 引擎）派生。
 * label/description 复用既有 engine.<id>.name / engine.<id>.description 文案键。
 */
export const BOT_ENGINES: Array<{
  id: ACodeProvider;
  labelId: string;
  descriptionId: string;
}> = BOT_ACODE_PROVIDER_OPTIONS.map((engine) => ({
  id: engine.id,
  labelId: `engine.${engine.id}.name`,
  descriptionId: `engine.${engine.id}.description`,
}));

export function getBotEngineEntry(engine: ACodeProvider | undefined) {
  return BOT_ENGINES.find((entry) => entry.id === engine) ?? BOT_ENGINES[0];
}

/**
 * 某引擎下 bot（远程入口）可选的默认权限模式选项（按引擎作用域，来自注册表）。
 * label 复用 engine.permissionMode.<id> 文案键。
 *
 * 安全加固 P0-3：这是「bot 默认权限模式」卡片的选项源，设置的是 bot 驱动的远程会话默认模式，
 * 因此剔除全权限档（yolo/bypassPermissions），与远程入口天花板（services 派发侧 clampBotPermissionMode）
 * 同源。native 引擎只列 build/edit/plan。需要 yolo 请在桌面本地的任务工具栏显式切换，不经 bot 配置。
 */
export function getBotPermissionModesForEngine(
  engine: ACodeProvider | undefined,
): Array<{ id: string; labelId: string }> {
  return getBotSelectablePermissionModes(engine).map((mode) => ({
    id: mode,
    labelId: `engine.permissionMode.${mode}`,
  }));
}

export function getBotReplyGranularitiesForProvider(
  provider: BotProvider,
): typeof BOT_REPLY_GRANULARITIES {
  const supportedIds = new Set(getSupportedBotReplyGranularities(provider));
  return BOT_REPLY_GRANULARITIES.filter((granularity) =>
    supportedIds.has(granularity.id),
  );
}

export function getBotReplyGranularityEntryForProvider(
  provider: BotProvider,
  replyMode: BotReplyGranularity,
) {
  const granularities = getBotReplyGranularitiesForProvider(provider);
  return (
    granularities.find((granularity) => granularity.id === replyMode) ??
    granularities[0] ??
    DEFAULT_BOT_REPLY_GRANULARITY_ENTRY
  );
}

export function getBotProviderRegionTagLabelId(
  provider: BotProviderEntryId,
): string | null {
  switch (provider) {
    case "lark":
      return "login.oauth.regionTag.zai";
    case "feishu":
      return "login.oauth.regionTag.bigmodel";
    default:
      return null;
  }
}

export function buildCurrentWorkspaceId(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

type BotProviderEntryResolution =
  | { mode: "select"; botId: string }
  | { mode: "create"; provider: BotProvider };

export function resolveBotProviderEntry(
  bots: BotConfig[],
  provider: BotProvider,
): BotProviderEntryResolution {
  const existingBot = bots.find((bot) => bot.provider === provider);
  if (existingBot) {
    return { mode: "select", botId: existingBot.id };
  }

  return { mode: "create", provider };
}
