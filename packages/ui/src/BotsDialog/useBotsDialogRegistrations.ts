/**
 * BotsDialog 的扫码注册与绑定码发起（批次 7 外迁，模式 B 第三刀）。
 *
 * 收口 `bindCode` / `feishuRegistration` / `weixinRegistration` 三个临时状态及其 loading
 * 标志，以及发起入口 `createBindCodeForBot` / `handleStartFeishuRegistration` /
 * `handleStartWeixinRegistration`。轮询本身在 `useBotsDialogPolling.ts`（同一批状态的两面）。
 *
 * 二维码 data URL 生成失败只记日志、不清空 registration——与原实现一致：registration 仍可
 * 展示 `qrUrl` 兜底链接，不让一次 canvas 失败掐掉整个扫码流程。
 */
import { useCallback, useState } from "react";
import QRCode from "qrcode";
import { isFeishuBotProvider } from "@acode/shared";
import type { BotConfig } from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import type { useServices } from "@/hooks/useServices.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  BIND_CODE_TTL_MS,
  type BindCodeState,
  type FeishuRegistrationState,
  type WeixinRegistrationState,
} from "@/BotsDialog/shared.js";
import type { BotsDialogData } from "@/BotsDialog/useBotsDialogData.js";

export interface BotsDialogRegistrationsInput {
  botsService: ReturnType<typeof useServices>["botsService"];
  intl: ReturnType<typeof useACodeIntl>["intl"];
  data: BotsDialogData;
}

export function useBotsDialogRegistrations({
  botsService,
  intl,
  data,
}: BotsDialogRegistrationsInput) {
  const { selectedBot } = data;
  const [bindCode, setBindCode] = useState<BindCodeState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [feishuRegistration, setFeishuRegistration] =
    useState<FeishuRegistrationState | null>(null);
  const [feishuRegistrationLoading, setFeishuRegistrationLoading] = useState(false);
  const [weixinRegistration, setWeixinRegistration] =
    useState<WeixinRegistrationState | null>(null);
  const [weixinRegistrationLoading, setWeixinRegistrationLoading] = useState(false);

  const createBindCodeForBot = useCallback(
    async (bot: BotConfig) => {
      const createdAt = Date.now();
      const result = await botsService.createBindCode({
        botId: bot.id,
        ttlMs: BIND_CODE_TTL_MS,
        allowedWorkspaces: bot.allowedWorkspaces,
      });
      setNowMs(createdAt);
      setBindCode({
        botId: bot.id,
        code: result.code,
        createdAt,
        expiresAt: result.expiresAt,
        ttlMs: Math.max(1, result.expiresAt - createdAt),
      });
    },
    [botsService],
  );

  const handleStartFeishuRegistration = useCallback(async () => {
    if (!selectedBot || !isFeishuBotProvider(selectedBot.provider)) return;
    setFeishuRegistrationLoading(true);
    try {
      const result = await botsService.beginFeishuRegistration({
        domain: selectedBot.provider,
      });
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成飞书注册二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setFeishuRegistration({
        botId: selectedBot.id,
        deviceCode: result.deviceCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        userCode: result.userCode,
        interval: result.interval,
        expiresAt: result.expiresAt,
        domain: result.domain,
        pollDomain: result.pollDomain,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.feishuRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动飞书扫码注册失败", message);
      toast(
        intl.formatMessage(
          { id: "bots.feishuRegistrationFailed" },
          { error: message },
        ),
      );
    } finally {
      setFeishuRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  const handleStartWeixinRegistration = useCallback(async () => {
    if (!selectedBot || selectedBot.provider !== "weixin") return;
    setWeixinRegistrationLoading(true);
    try {
      const result = await botsService.beginWeixinRegistration();
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(result.qrUrl, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        logger.error(
          "[BotsDialog] 生成微信登录二维码失败",
          error instanceof Error ? error.message : String(error),
        );
      }
      setWeixinRegistration({
        botId: selectedBot.id,
        qrCode: result.qrCode,
        qrUrl: result.qrUrl,
        qrDataUrl,
        interval: result.interval,
        expiresAt: result.expiresAt,
        status: "pending",
      });
      toast(intl.formatMessage({ id: "bots.weixinRegistrationStarted" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[BotsDialog] 启动微信扫码登录失败", message);
      toast(
        intl.formatMessage(
          { id: "bots.weixinRegistrationFailed" },
          { error: message },
        ),
      );
    } finally {
      setWeixinRegistrationLoading(false);
    }
  }, [botsService, intl, selectedBot]);

  return {
    bindCode,
    createBindCodeForBot,
    feishuRegistration,
    feishuRegistrationLoading,
    handleStartFeishuRegistration,
    handleStartWeixinRegistration,
    nowMs,
    setBindCode,
    setFeishuRegistration,
    setNowMs,
    setWeixinRegistration,
    weixinRegistration,
    weixinRegistrationLoading,
  };
}

export type BotsDialogRegistrations = ReturnType<typeof useBotsDialogRegistrations>;
