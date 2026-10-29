/**
 * BotsDialog 的运行态与扫码注册轮询（批次 7 外迁，模式 B 第四刀·B 半）。
 *
 * 三组：运行态串行轮询（慢 RPC 不堆叠）、微信激活态轮询、飞书/微信扫码注册轮询。
 * 轮询取消语义由 `botsDialogPolling.ts` 的原语承载（可注入计时器 → 可用假计时器验证
 * 「stop 之后不再写回」）。
 *
 * 依赖逐条对齐迁移前：只接受原始值 / 稳定回调，不以聚合对象作 effect 依赖——否则每次
 * render 新对象都会重启轮询（原注释警告的「毫秒级 RPC 风暴」）。
 */
import { useEffect } from "react";
import type { BotConfig, BotServiceStatus, BotState } from "@acode/shared";
import { isFeishuBotProvider } from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import type { useServices } from "@/hooks/useServices.js";
import type { useACodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  createCancellablePollLoop,
  shouldPollFeishuRegistration,
  shouldPollWeixinActivation,
  shouldPollWeixinRegistration,
} from "@/BotsDialog/botsDialogPolling.js";
import type {
  FeishuRegistrationState,
  WeixinRegistrationState,
} from "@/BotsDialog/shared.js";
import type { BotsDialogActions } from "@/BotsDialog/useBotsDialogActions.js";
import type { BotsDialogData } from "@/BotsDialog/useBotsDialogData.js";
import type { BotsDialogRegistrations } from "@/BotsDialog/useBotsDialogRegistrations.js";

const BOT_STATUS_POLL_INTERVAL_MS = 2_000;

export interface BotsDialogStatusPollingInput {
  open: boolean;
  botsService: ReturnType<typeof useServices>["botsService"];
  intl: ReturnType<typeof useACodeIntl>["intl"];
  selectedBot: BotConfig | null;
  selectedBotState: BotState | null;
  feishuRegistration: FeishuRegistrationState | null;
  weixinRegistration: WeixinRegistrationState | null;
  saveBot: BotsDialogActions["saveBot"];
  setConfig: BotsDialogData["setConfig"];
  setBotStates: BotsDialogData["setBotStates"];
  setStatus: BotsDialogData["setStatus"];
  setFeishuRegistration: BotsDialogRegistrations["setFeishuRegistration"];
  setWeixinRegistration: BotsDialogRegistrations["setWeixinRegistration"];
}

export function useBotsDialogStatusPolling({
  open,
  botsService,
  intl,
  selectedBot,
  selectedBotState,
  feishuRegistration,
  weixinRegistration,
  saveBot,
  setConfig,
  setBotStates,
  setStatus,
  setFeishuRegistration,
  setWeixinRegistration,
}: BotsDialogStatusPollingInput) {
  // 1) 运行态串行轮询（只在弹窗可见时串行刷新，避免慢 RPC 堆积或关闭后回写）
  useEffect(() => {
    if (!open) return undefined;
    const loop = createCancellablePollLoop({
      mode: "serial",
      intervalMs: BOT_STATUS_POLL_INTERVAL_MS,
      run: async (isCancelled) => {
        try {
          const nextStatus: BotServiceStatus = await botsService.getStatus();
          if (!isCancelled()) setStatus(nextStatus);
        } catch (error) {
          logger.debug("[BotsDialog] 刷新 Bot 运行状态失败", error);
        }
      },
    });
    loop.start();
    return () => loop.stop();
  }, [botsService, open, setStatus]);

  // 2) 微信激活态轮询（有凭据但尚未激活）
  useEffect(() => {
    if (
      !shouldPollWeixinActivation({
        open,
        provider: selectedBot?.provider,
        credentialRef: selectedBot?.credentialRef,
        weixinActivatedAt: selectedBotState?.weixinActivatedAt,
      })
    ) {
      return undefined;
    }
    const loop = createCancellablePollLoop({
      mode: "interval",
      intervalMs: BOT_STATUS_POLL_INTERVAL_MS,
      run: async (isCancelled) => {
        try {
          const nextBotStates: BotState[] = await botsService.getBotStates();
          if (!isCancelled()) {
            setBotStates(nextBotStates);
          }
        } catch (error) {
          logger.warn(
            "[BotsDialog] 轮询微信 Bot 激活状态失败",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });
    loop.start();
    return () => loop.stop();
  }, [
    botsService,
    open,
    selectedBot?.credentialRef,
    selectedBot?.id,
    selectedBot?.provider,
    selectedBotState?.weixinActivatedAt,
    setBotStates,
  ]);

  // 3) 飞书扫码注册轮询
  useEffect(() => {
    if (
      !shouldPollFeishuRegistration({
        open,
        hasSelectedBot: selectedBot !== null,
        isFeishuProvider: Boolean(selectedBot && isFeishuBotProvider(selectedBot.provider)),
        registration: feishuRegistration,
      }) ||
      !selectedBot ||
      !feishuRegistration
    ) {
      return undefined;
    }
    const registration = feishuRegistration;
    const pollingBot = selectedBot;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    const loop = createCancellablePollLoop({
      mode: "interval",
      intervalMs: pollIntervalMs,
      run: async (isCancelled) => {
        try {
          const result = await botsService.pollFeishuRegistration({
            deviceCode: registration.deviceCode,
            domain: registration.domain,
            pollDomain: registration.pollDomain,
          });
          if (isCancelled()) {
            return;
          }
          if (result.status === "pending") {
            setFeishuRegistration((current) => {
              if (current?.deviceCode !== registration.deviceCode) {
                return current;
              }
              if (
                current.interval === result.interval &&
                current.domain === result.domain &&
                current.pollDomain === result.pollDomain
              ) {
                return current;
              }
              // Bugfix: pending 轮询结果通常不变；如果每次都创建新对象，会触发 effect 依赖变化，
              // 进而立即重启轮询并造成毫秒级 RPC 风暴。
              return {
                ...current,
                interval: result.interval,
                domain: result.domain,
                pollDomain: result.pollDomain,
              };
            });
            return;
          }
          if (result.status === "success") {
            // Bugfix: 服务层一直支持飞书扫码注册，但 Bots 重构后的 UI 只保留了手填凭据。
            // 扫码成功后直接复用 saveBot 的 secret 写入路径，避免把 App Secret 留在明文配置文件里。
            const savedBot = await saveBot(
              {
                ...pollingBot,
                provider: pollingBot.provider,
                name: result.appName?.trim() || pollingBot.name,
                feishuAppId: result.appId,
              },
              { credentialValue: result.appSecret },
            );
            if (!isCancelled()) {
              // Bugfix: 飞书/Lark 扫码成功只完成应用凭据接入；绑定码由“有凭据但未绑定”的统一状态机生成。
              // 这里仅收起二维码，避免二维码和 /bind 面板在一次状态更新里互相抢展示优先级。
              setConfig((previous) => ({
                ...previous,
                bots: previous.bots.map((bot) =>
                  bot.id === savedBot.id ? savedBot : bot,
                ),
              }));
              setFeishuRegistration(null);
              toast(intl.formatMessage({ id: "bots.feishuRegistrationSuccess" }));
            }
            return;
          }
          setFeishuRegistration((current) =>
            current?.deviceCode === registration.deviceCode
              ? {
                  ...current,
                  status: result.status,
                  message:
                    result.message ??
                    intl.formatMessage({
                      id: `bots.feishuRegistration.${result.status}`,
                    }),
                }
              : current,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[BotsDialog] 飞书扫码注册轮询失败", message);
          if (!isCancelled()) {
            setFeishuRegistration((current) =>
              current?.deviceCode === registration.deviceCode
                ? { ...current, status: "error", message }
                : current,
            );
          }
        }
      },
    });
    loop.start();
    return () => loop.stop();
  }, [
    botsService,
    feishuRegistration,
    intl,
    open,
    saveBot,
    selectedBot,
    setConfig,
    setFeishuRegistration,
  ]);

  // 4) 微信扫码登录轮询（串行：状态接口会长等待）
  useEffect(() => {
    if (
      !shouldPollWeixinRegistration({
        open,
        hasSelectedBot: selectedBot !== null,
        provider: selectedBot?.provider,
        registration: weixinRegistration,
      }) ||
      !selectedBot ||
      !weixinRegistration
    ) {
      return undefined;
    }
    const registration = weixinRegistration;
    const pollingBot = selectedBot;
    const pollIntervalMs = Math.max(1, registration.interval) * 1000;

    // Bugfix: 微信扫码状态接口会长等待，如果用 setInterval 会在上一次请求未返回时继续堆叠 RPC。
    // 串行轮询可以避免连续 timeout，也避免多个结果互相覆盖 UI 状态。
    const loop = createCancellablePollLoop({
      mode: "serial",
      intervalMs: pollIntervalMs,
      run: async (isCancelled) => {
        try {
          const result = await botsService.pollWeixinRegistration({
            qrCode: registration.qrCode,
          });
          if (isCancelled()) {
            return;
          }
          if (result.status === "pending" || result.status === "scanned") {
            setWeixinRegistration((current) => {
              if (current?.qrCode !== registration.qrCode) {
                return current;
              }
              if (
                current.interval === result.interval &&
                current.status === result.status
              ) {
                return current;
              }
              return {
                ...current,
                interval: result.interval,
                status: result.status,
              };
            });
            return;
          }
          if (result.status === "success") {
            await saveBot(
              {
                ...pollingBot,
                webhookUrl: undefined,
                providerUserId: result.botId ?? pollingBot.providerUserId,
                displayName: result.botId ?? pollingBot.displayName,
                name: pollingBot.name,
              },
              { credentialValue: result.botToken },
            );
            if (!isCancelled()) {
              // Bugfix: 微信扫码成功即完成连接，保留 QR registration 会让用户看到过期的扫码区域。
              // 清掉临时状态后，Bot token 行会切到已连通的 Unbind 操作。
              setWeixinRegistration(null);
              toast(intl.formatMessage({ id: "bots.weixinRegistrationSuccess" }));
            }
            return;
          }
          setWeixinRegistration((current) =>
            current?.qrCode === registration.qrCode
              ? {
                  ...current,
                  status: result.status,
                  message:
                    ("message" in result ? result.message : undefined) ??
                    intl.formatMessage({
                      id: `bots.weixinRegistration.${result.status}`,
                    }),
                }
              : current,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[BotsDialog] 微信扫码登录轮询失败", message);
        }
      },
    });
    loop.start();
    return () => loop.stop();
  }, [
    botsService,
    intl,
    open,
    saveBot,
    selectedBot,
    setWeixinRegistration,
    weixinRegistration,
  ]);
}
