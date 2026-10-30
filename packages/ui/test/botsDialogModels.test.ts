import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { ALL_BOT_WORKSPACES } from "@acode/shared";
import type {
  BotAutoConnectInput,
  BotAutoConnectSubject,
} from "../src/BotsDialog/botsDialogModels.js";

// 环境适配（不改变被测对象）：botsDialogModels 通过 @/BotsDialog/shared.js 取
// `createDefaultCommands`，该模块静态 import 渠道图标 .png（ERR_UNKNOWN_FILE_EXTENSION）。
// 用 module.registerHooks 把 .png 重定向到 data: 空模块，进程内生效；node --test 每个
// 测试文件独立进程，不影响其他测试（口径同 pluginListRows.test.ts）。因此被测模块走
// test.before 里的动态 import。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".png")) {
      return { url: "data:text/javascript,export default ''", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let createDraftBot: typeof import("../src/BotsDialog/botsDialogModels.js").createDraftBot;
let createEmptyConfig: typeof import("../src/BotsDialog/botsDialogModels.js").createEmptyConfig;
let resolveBotAutoConnectAction: typeof import("../src/BotsDialog/botsDialogModels.js").resolveBotAutoConnectAction;

test.before(async () => {
  ({ createDraftBot, createEmptyConfig, resolveBotAutoConnectAction } = await import(
    "../src/BotsDialog/botsDialogModels.js"
  ));
});

/**
 * BotsDialog 批次 6 外迁（botsDialogModels.ts）的决策表单测。
 * 覆盖：配置初值/草稿 Bot 构造 × 自动扫码与自动续绑定码的五条渠道分支 ×
 * 去重集合与 30 秒有效期边界 × 非激活态一律 none。
 */

const bot = (overrides: Partial<BotAutoConnectSubject> = {}): BotAutoConnectSubject => ({
  id: "bot-1",
  provider: "telegram",
  credentialRef: "cred-1",
  ...overrides,
});

const input = (overrides: Partial<BotAutoConnectInput> = {}): BotAutoConnectInput => ({
  open: true,
  creatingBot: false,
  selectedBot: bot(),
  bindCode: null,
  bindExpired: false,
  feishuRegistration: null,
  feishuRegistrationLoading: false,
  weixinRegistration: null,
  weixinRegistrationLoading: false,
  autoQrStartedKeys: new Set(),
  autoBindCreatingIds: new Set(),
  ...overrides,
});

test("createEmptyConfig：版本 3 且无 Bot", () => {
  assert.deepEqual(createEmptyConfig(), { version: 3, bots: [] });
});

test("createDraftBot：id 带 bot- 前缀且不含 provider 名（bugfix 回归）", () => {
  for (const provider of ["telegram", "feishu", "weixin", "discord", "wecom"] as const) {
    const draft = createDraftBot({ provider });
    assert.ok(draft.id.startsWith("bot-"), `${provider} 的草稿 id 应以 bot- 开头`);
    assert.ok(
      !draft.id.includes(provider),
      `${provider} 的草稿 id 不应包含渠道名（会误导渠道被固定）`,
    );
  }
});

test("createDraftBot：默认启用、全工作区、无凭证与空选项", () => {
  const draft = createDraftBot({ provider: "telegram" });
  assert.equal(draft.enabled, true);
  assert.equal(draft.name, "");
  assert.deepEqual(draft.allowedWorkspaces, [ALL_BOT_WORKSPACES]);
  assert.deepEqual(draft.currentOptions, {});
  assert.equal(draft.allowedCommands.status, true, "默认命令集应全部放开（对象形态）");
});

test("resolveBotAutoConnectAction：弹窗未打开 / 正在新建 / 无选中 Bot 一律 none", () => {
  assert.equal(resolveBotAutoConnectAction(input({ open: false })).kind, "none");
  assert.equal(resolveBotAutoConnectAction(input({ creatingBot: true })).kind, "none");
  assert.equal(resolveBotAutoConnectAction(input({ selectedBot: null })).kind, "none");
});

test("飞书：无凭据且未在轮询时自动启动扫码", () => {
  const action = resolveBotAutoConnectAction(
    input({ selectedBot: bot({ provider: "feishu", credentialRef: undefined }) }),
  );
  assert.deepEqual(action, { kind: "start-feishu-qr", dedupeKey: "bot-1:feishu-registration" });
});

test("飞书：已发起过扫码（去重集合命中）不再重复启动", () => {
  const action = resolveBotAutoConnectAction(
    input({
      selectedBot: bot({ provider: "feishu", credentialRef: undefined }),
      autoQrStartedKeys: new Set(["bot-1:feishu-registration"]),
    }),
  );
  assert.equal(action.kind, "none");
});

test("飞书：二维码轮询进行中或有现存注册态时不重复启动", () => {
  const base = bot({ provider: "feishu", credentialRef: undefined });
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: base, feishuRegistrationLoading: true }),
    ).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({
        selectedBot: base,
        feishuRegistration: {
          botId: "bot-1",
          deviceCode: "d",
          qrUrl: "",
          qrDataUrl: null,
          userCode: "",
          interval: 1,
          expiresAt: 0,
          domain: "feishu",
          status: "pending",
        },
      }),
    ).kind,
    "none",
  );
});

test("飞书：有凭据但未绑定时自动生成绑定码", () => {
  assert.equal(
    resolveBotAutoConnectAction(input({ selectedBot: bot({ provider: "feishu" }) })).kind,
    "create-bind-code",
  );
});

test("飞书：有凭据且已绑定时不动作", () => {
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "feishu", providerUserId: "u-1" }) }),
    ).kind,
    "none",
  );
});

test("绑定码未过期时不再续码；过期后立即续", () => {
  const bindCode = {
    botId: "bot-1",
    code: "123456",
    createdAt: 0,
    expiresAt: 30_000,
    ttlMs: 30_000,
  };
  assert.equal(
    resolveBotAutoConnectAction(input({ bindCode, bindExpired: false })).kind,
    "none",
    "30 秒有效期内的旧码不应被新码顶掉",
  );
  assert.equal(
    resolveBotAutoConnectAction(input({ bindCode, bindExpired: true })).kind,
    "create-bind-code",
  );
});

test("绑定码属于别的 Bot 时不影响当前 Bot 续码", () => {
  const action = resolveBotAutoConnectAction(
    input({
      bindCode: { botId: "bot-2", code: "x", createdAt: 0, expiresAt: 30_000, ttlMs: 30_000 },
      bindExpired: false,
    }),
  );
  assert.equal(action.kind, "create-bind-code");
});

test("绑定码生成中（ref 去重）时不重复发起", () => {
  assert.equal(
    resolveBotAutoConnectAction(
      input({ autoBindCreatingIds: new Set(["bot-1"]) }),
    ).kind,
    "none",
  );
});

test("Telegram / Discord：有凭据未绑定 → 生成绑定码", () => {
  for (const provider of ["telegram", "discord"] as const) {
    assert.equal(
      resolveBotAutoConnectAction(input({ selectedBot: bot({ provider }) })).kind,
      "create-bind-code",
    );
  }
});

test("Telegram / Discord：无凭据或已绑定时不动作", () => {
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "telegram", credentialRef: undefined }) }),
    ).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "telegram", providerUserId: "u" }) }),
    ).kind,
    "none",
  );
});

test("企业微信：三项回调配置齐全才生成绑定码", () => {
  const complete = bot({
    provider: "wecom",
    credentialRef: "c",
    webhookSecretRef: "w",
    wecomEncodingAESKey: "k",
  });
  assert.equal(resolveBotAutoConnectAction(input({ selectedBot: complete })).kind, "create-bind-code");

  for (const missing of [
    { webhookSecretRef: undefined },
    { wecomEncodingAESKey: undefined },
    { credentialRef: undefined },
  ]) {
    const incomplete = { ...complete, ...missing };
    assert.equal(
      resolveBotAutoConnectAction(input({ selectedBot: incomplete })).kind,
      "none",
      `缺 ${Object.keys(missing)[0]} 时不应自动出绑定码`,
    );
  }
});

test("企业微信：已绑定时不动作", () => {
  assert.equal(
    resolveBotAutoConnectAction(
      input({
        selectedBot: bot({
          provider: "wecom",
          credentialRef: "c",
          webhookSecretRef: "w",
          wecomEncodingAESKey: "k",
          providerUserId: "u",
        }),
      }),
    ).kind,
    "none",
  );
});

test("微信：无凭据时自动启动扫码登录", () => {
  assert.deepEqual(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "weixin", credentialRef: undefined }) }),
    ),
    { kind: "start-weixin-qr", dedupeKey: "bot-1:weixin-registration" },
  );
});

test("微信：有凭据 / 轮询中 / 已有注册态 / 已发起过，均不重复启动", () => {
  const noCredential = bot({ provider: "weixin", credentialRef: undefined });
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "weixin" }) }),
    ).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: noCredential, weixinRegistrationLoading: true }),
    ).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({
        selectedBot: noCredential,
        weixinRegistration: {
          botId: "bot-1",
          qrCode: "q",
          qrUrl: "",
          qrDataUrl: null,
          interval: 1,
          expiresAt: 0,
          status: "pending",
        },
      }),
    ).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({
        selectedBot: noCredential,
        autoQrStartedKeys: new Set(["bot-1:weixin-registration"]),
      }),
    ).kind,
    "none",
  );
});

test("未知渠道（webhook / 其他）不触发任何自动连接", () => {
  assert.equal(
    resolveBotAutoConnectAction(input({ selectedBot: bot({ provider: "webhook" }) })).kind,
    "none",
  );
  assert.equal(
    resolveBotAutoConnectAction(
      input({ selectedBot: bot({ provider: "lark" }) }),
    ).kind,
    "create-bind-code",
    "lark 走飞书分支（isFeishuBotProvider 覆盖 lark）",
  );
});
