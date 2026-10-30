/**
 * BotsDialog 的纯决策模型（批次 6 外迁）。
 *
 * 1. 配置初值（`createEmptyConfig`）与草稿 Bot 构造（`createDraftBot`）逐字迁移；
 * 2. `resolveBotAutoConnectAction`：把原组件里 120 行的「自动扫码 / 自动生成绑定码」if 链
 *    收成一个判别联合。副作用（ref 去重集合的增删、异步调用）仍留在组件 effect 内，
 *    本函数只回答「该做什么」，便于无 DOM 环境下用决策表覆盖全部分支。
 *
 * 数据来源：`BotsDialog.tsx` 原行 73-94（构造器）与 950-1071（自动连接 effect）。
 */
import {
  ALL_BOT_WORKSPACES,
  createUuid,
  DEFAULT_BOT_REPLY_GRANULARITY,
  isFeishuBotProvider,
  normalizeBotReplyGranularity,
} from "@acode/shared";
import type { BotConfig, BotProvider, BotsConfigFile } from "@acode/shared";
import type { BindCodeState, FeishuRegistrationState, WeixinRegistrationState } from "@/BotsDialog/shared.js";
import { createDefaultCommands } from "@/BotsDialog/shared.js";

export function createEmptyConfig(): BotsConfigFile {
  return { version: 3, bots: [] };
}

export function createDraftBot(params: { provider: BotProvider }): BotConfig {
  // Bugfix: Bot id 只是配置实体身份，不应该带 provider 前缀；
  // 新建时如果看到 telegram-* 这类 id，容易误以为渠道被固定到了 Telegram。
  const id = `bot-${createUuid()}`;
  return {
    id,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: createDefaultCommands(),
    currentOptions: {},
    replyMode: normalizeBotReplyGranularity(params.provider, DEFAULT_BOT_REPLY_GRANULARITY),
  };
}

/** 自动连接决策只需要 Bot 配置的这几个字段（结构子集，避免耦合完整 BotConfig）。 */
export interface BotAutoConnectSubject {
  id: string;
  provider: BotProvider;
  credentialRef?: string;
  providerUserId?: string;
  webhookSecretRef?: string;
  wecomEncodingAESKey?: string;
}

export interface BotAutoConnectInput {
  open: boolean;
  creatingBot: boolean;
  selectedBot: BotAutoConnectSubject | null;
  bindCode: BindCodeState | null;
  bindExpired: boolean;
  feishuRegistration: FeishuRegistrationState | null;
  feishuRegistrationLoading: boolean;
  weixinRegistration: WeixinRegistrationState | null;
  weixinRegistrationLoading: boolean;
  autoQrStartedKeys: ReadonlySet<string>;
  autoBindCreatingIds: ReadonlySet<string>;
}

export type BotAutoConnectAction =
  | { kind: "none" }
  | { kind: "start-feishu-qr"; dedupeKey: string }
  | { kind: "start-weixin-qr"; dedupeKey: string }
  | { kind: "create-bind-code" };

export const NO_BOT_AUTO_CONNECT_ACTION: BotAutoConnectAction = { kind: "none" };

/** 已有绑定码且未过期时不再重复生成（30 秒有效期内的续码节奏）。 */
function hasFreshBindCode(input: BotAutoConnectInput, botId: string): boolean {
  return input.bindCode?.botId === botId && !input.bindExpired;
}

export function resolveBotAutoConnectAction(input: BotAutoConnectInput): BotAutoConnectAction {
  const { selectedBot } = input;
  if (!input.open || input.creatingBot || !selectedBot) {
    return NO_BOT_AUTO_CONNECT_ACTION;
  }

  if (isFeishuBotProvider(selectedBot.provider)) {
    if (!selectedBot.credentialRef) {
      if (input.feishuRegistrationLoading) {
        return NO_BOT_AUTO_CONNECT_ACTION;
      }
      if (input.feishuRegistration?.botId === selectedBot.id) {
        return NO_BOT_AUTO_CONNECT_ACTION;
      }

      const dedupeKey = `${selectedBot.id}:feishu-registration`;
      if (input.autoQrStartedKeys.has(dedupeKey)) {
        return NO_BOT_AUTO_CONNECT_ACTION;
      }

      // Bugfix: 未配置 token 的飞书/Lark Bot 首次进入详情时只显示“扫码”按钮，
      // 用户会误以为还需要额外展开；自动启动一次二维码流程，让缺失凭据的默认状态直接可操作。
      return { kind: "start-feishu-qr", dedupeKey };
    }

    if (!selectedBot.providerUserId) {
      if (hasFreshBindCode(input, selectedBot.id)) {
        return NO_BOT_AUTO_CONNECT_ACTION;
      }
      if (input.autoBindCreatingIds.has(selectedBot.id)) {
        return NO_BOT_AUTO_CONNECT_ACTION;
      }

      // Bugfix: 飞书/Lark 的接入凭据和聊天绑定是两个阶段；已有凭据但未绑定时需要自动展示 /bind。
      // 绑定码现在只有 30 秒有效期，过期后如果还停在旧码会打断自动绑定流程；这里自动续一枚新码。
      return { kind: "create-bind-code" };
    }
    return NO_BOT_AUTO_CONNECT_ACTION;
  }

  if (selectedBot.provider === "telegram" || selectedBot.provider === "discord") {
    if (!selectedBot.credentialRef || selectedBot.providerUserId) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }
    if (hasFreshBindCode(input, selectedBot.id)) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }
    if (input.autoBindCreatingIds.has(selectedBot.id)) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }

    // Bugfix: Telegram / Discord 和飞书/Lark 一样分成凭据接入与私聊绑定两步；
    // token 保存后自动展示 /bind；绑定码过期也自动续码，避免 30 秒有效期让用户卡在旧码上。
    return { kind: "create-bind-code" };
  }

  if (selectedBot.provider === "wecom") {
    // 企业微信回调配置齐全但未绑定成员时，自动展示 /bind，让首屏直接可操作。
    const wecomConfigured =
      Boolean(selectedBot.credentialRef) &&
      Boolean(selectedBot.webhookSecretRef) &&
      Boolean(selectedBot.wecomEncodingAESKey);
    if (!wecomConfigured || selectedBot.providerUserId) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }
    if (hasFreshBindCode(input, selectedBot.id)) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }
    if (input.autoBindCreatingIds.has(selectedBot.id)) {
      return NO_BOT_AUTO_CONNECT_ACTION;
    }
    return { kind: "create-bind-code" };
  }

  if (selectedBot.provider !== "weixin") {
    return NO_BOT_AUTO_CONNECT_ACTION;
  }
  if (selectedBot.credentialRef || input.weixinRegistrationLoading) {
    return NO_BOT_AUTO_CONNECT_ACTION;
  }
  if (input.weixinRegistration?.botId === selectedBot.id) {
    return NO_BOT_AUTO_CONNECT_ACTION;
  }

  const dedupeKey = `${selectedBot.id}:weixin-registration`;
  if (input.autoQrStartedKeys.has(dedupeKey)) {
    return NO_BOT_AUTO_CONNECT_ACTION;
  }

  // Bugfix: 微信 Bot 没有 token/绑定状态时需要立即给出登录二维码，
  // 否则新建后右侧默认只露出按钮，和“扫码接入”的主流程不一致。
  return { kind: "start-weixin-qr", dedupeKey };
}
