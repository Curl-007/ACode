import { ServiceChannels } from "@acode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ACodeConfigOption,
  ACodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ACodeAutomationBotDeliveryTarget,
} from "@acode/shared";
import type { ACodeAgentAppRuntimePreferences } from "../acode-agent/acodeAgent.js";

export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ACodeProvider;
}

export interface BotAutomationRunWatchParams {
  target: ACodeAutomationBotDeliveryTarget;
  taskId: string;
  /** automation run 台账 id（heartbeat 协议 R3）：诊断关联用；决策由共享解析器判定。 */
  runId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

export interface IBotsService {
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ACodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ACodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  getBotStates(): Promise<BotContextState[]>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots, {
  allowedMethods: [
    "syncAppRuntimePreferences",
    "getStatus",
    "getConfig",
    "listWorkspaceRefs",
    "getUserConfigOptions",
    "beginFeishuRegistration",
    "pollFeishuRegistration",
    "beginWeixinRegistration",
    "pollWeixinRegistration",
    "saveConfig",
    "listBots",
    "saveBot",
    "removeBotSecret",
    "deleteBot",
    "testBot",
    "createBindCode",
    "getBotStates",
    "resetBotState",
    "watchAutomationRun",
    "handleInboundMessage",
    "handleProviderCallback",
    "handleProviderCallbackResponse",
  ],
  argumentValidators: {
    // preferences 是配置对象，无必需 id/path 字段；只做顶层对象形态检查，保持宽容。
    syncAppRuntimePreferences: (args) => requireObjectArg(args, []),
    getStatus: (args) => requireNoArguments(args),
    getConfig: (args) => requireNoArguments(args),
    listWorkspaceRefs: (args) => optionalSingleObjectArg(args),
    getUserConfigOptions: (args) => requireObjectArg(args, ["workspacePath", "provider"]),
    beginFeishuRegistration: (args) => optionalSingleObjectArg(args),
    pollFeishuRegistration: (args) => requireObjectArg(args, ["deviceCode"]),
    beginWeixinRegistration: (args) => requireNoArguments(args),
    pollWeixinRegistration: (args) => requireObjectArg(args, ["qrCode"]),
    // 写入入口 saveConfig：BotsConfigFile（version + bots[]）无顶层 id/path 字段，
    // 只做对象形态检查，完整 schema 校验由 service 层的 botsConfigFileSchema 负责。
    saveConfig: (args) => requireObjectArg(args, []),
    listBots: (args) => requireNoArguments(args),
    // 写入入口 saveBot：params.bot 是必填对象；credentialValue/webhookSecretValue 为可选秘密，不校验值。
    saveBot: (args) => {
      const value = requireObjectArg(args, []);
      const bot = value.bot;
      if (!bot || typeof bot !== "object" || Array.isArray(bot)) throw new Error("invalid bot");
    },
    removeBotSecret: (args) => requireStringArg(args, "invalid botId"),
    deleteBot: (args) => requireStringArg(args, "invalid botId"),
    testBot: (args) => requireStringArg(args, "invalid botId"),
    // BotCreateBindCodeParams 全部字段可选；只做对象形态检查。
    createBindCode: (args) => requireObjectArg(args, []),
    getBotStates: (args) => requireNoArguments(args),
    resetBotState: (args) => requireStringArg(args, "invalid contextKey"),
    watchAutomationRun: (args) => {
      const value = requireObjectArg(args, ["taskId", "runId", "workspacePath"]);
      const target = value.target;
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("invalid target");
      }
    },
    handleInboundMessage: (args) => requireObjectArg(args, ["botId"]),
    handleProviderCallback: (args) => requireProviderCallbackArgs(args),
    handleProviderCallbackResponse: (args) => requireProviderCallbackArgs(args),
  },
});

function requireNoArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("expected no arguments");
}

function requireStringArg(args: readonly unknown[], message: string): void {
  if (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0) {
    throw new Error(message);
  }
}

function optionalSingleObjectArg(args: readonly unknown[]): void {
  if (args.length > 1) throw new Error("expected at most one argument");
  const value = args[0];
  if (args.length === 0 || value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an optional parameter object");
  }
}

function requireObjectArg(
  args: readonly unknown[],
  requiredStringFields: readonly string[],
): Record<string, unknown> {
  if (args.length !== 1) throw new Error("expected a single parameter object");
  const value = args[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a parameter object");
  }
  const record = value as Record<string, unknown>;
  for (const field of requiredStringFields) {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      throw new Error(`invalid ${field}`);
    }
  }
  return record;
}

// provider 是必填字符串（BotProvider 枚举）；payload 为 unknown 类型：
// 不做类型校验，接受任意值（含缺省），避免误拒合法回调转发。
function requireProviderCallbackArgs(args: readonly unknown[]): void {
  if (args.length < 1 || args.length > 2) throw new Error("expected provider and payload");
  if (typeof args[0] !== "string" || args[0].length === 0) throw new Error("invalid provider");
}
