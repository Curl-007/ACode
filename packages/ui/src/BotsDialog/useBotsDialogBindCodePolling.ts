/**
 * BotsDialog 的绑定码轮询族（批次 7 外迁，模式 B 第四刀·A 半）。
 *
 * 三件事：倒计时节拍（250ms 驱动进度条）、绑定码结果轮询（2s 固定节拍）、
 * 「已绑定即收起旧码」的收敛 effect。轮询取消语义由 `botsDialogPolling.ts` 的原语承载。
 *
 * 与 `useBotsDialogStatusPolling.ts` 的边界：本文件只碰 bindCode / nowMs，
 * 后者只碰 status / botStates / 扫码注册——两组状态互不写入，因此可以各自独立启停。
 */
import { useEffect } from "react";
import type { BotConfig } from "@acode/shared";
import type { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  createCancellablePollLoop,
  shouldCollapseBindCode,
  shouldPollBindResult,
  shouldTickBindCountdown,
} from "@/BotsDialog/botsDialogPolling.js";
import type { BindCodeState } from "@/BotsDialog/shared.js";
import type { BotsDialogData } from "@/BotsDialog/useBotsDialogData.js";
import type { BotsDialogRegistrations } from "@/BotsDialog/useBotsDialogRegistrations.js";

/** 绑定码进度条刷新节拍：30 秒有效期下 1 秒一跳会让进度条明显跳格。 */
const BIND_COUNTDOWN_TICK_MS = 250;
const BIND_RESULT_POLL_INTERVAL_MS = 2_000;

export interface BotsDialogBindCodePollingInput {
  open: boolean;
  bindExpired: boolean;
  bindCode: BindCodeState | null;
  selectedBot: BotConfig | null;
  botsService: ReturnType<typeof useServices>["botsService"];
  setConfig: BotsDialogData["setConfig"];
  setBindCode: BotsDialogRegistrations["setBindCode"];
  setNowMs: BotsDialogRegistrations["setNowMs"];
}

export function useBotsDialogBindCodePolling({
  open,
  bindExpired,
  bindCode,
  selectedBot,
  botsService,
  setConfig,
  setBindCode,
  setNowMs,
}: BotsDialogBindCodePollingInput) {
  // 1) 倒计时节拍
  useEffect(() => {
    if (!shouldTickBindCountdown({ open, bindCode })) return undefined;
    setNowMs(Date.now());
    // Bugfix: 绑定码缩短到 30 秒后，1 秒刷新会让进度条明显跳格。
    // 这里用更细的节奏驱动动画，文字仍由 formatBindCountdown 按秒展示。
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), BIND_COUNTDOWN_TICK_MS);
    return () => globalThis.clearInterval(timer);
  }, [bindCode, open, setNowMs]);

  // 2) 绑定码结果（/bind 由第三方聊天回写配置，UI 没有直接事件）
  useEffect(() => {
    if (!shouldPollBindResult({ open, bindCode, bindExpired }) || !bindCode) {
      return undefined;
    }
    const polledBindCode = bindCode;
    const loop = createCancellablePollLoop({
      mode: "interval",
      intervalMs: BIND_RESULT_POLL_INTERVAL_MS,
      run: async (isCancelled) => {
        try {
          const nextConfig = await botsService.getConfig();
          if (isCancelled()) return;
          setConfig(nextConfig);
          const targetBot = nextConfig.bots.find((bot) => bot.id === polledBindCode.botId);
          if (targetBot?.providerUserId) {
            // Bugfix: /bind 是从第三方聊天回写配置，UI 没有直接事件。
            // 绑定码展开期间低频刷新配置，绑定成功后立即收起绑定区域。
            setBindCode(null);
          }
        } catch (error) {
          logger.warn(
            "[BotsDialog] 轮询 Bot 绑定结果失败",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });
    loop.start();
    return () => loop.stop();
  }, [bindCode, bindExpired, botsService, open, setBindCode, setConfig]);

  // 3) 已绑定即收起旧码（服务层异步回写，即使轮询被切换/刷新打断也要收）
  useEffect(() => {
    if (
      !shouldCollapseBindCode({
        bindCode,
        selectedBotId: selectedBot?.id,
        selectedBotProviderUserId: selectedBot?.providerUserId,
      })
    ) {
      return;
    }
    setBindCode(null);
  }, [bindCode, selectedBot?.id, selectedBot?.providerUserId, setBindCode]);
}
