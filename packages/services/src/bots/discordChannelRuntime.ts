import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@acode/shared";
import type { ICredentialService } from "../credential/credential.js";
import {
  startDiscordGateway,
  type DiscordGatewayClient,
} from "./providers/discordGateway.js";
import {
  acquireDiscordGatewayLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForAbort,
} from "./channelRuntime.js";

interface DiscordChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  processProviderCallback(
    provider: "discord",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export function createDiscordChannelRuntime(deps: DiscordChannelRuntimeDeps) {
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function runBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: bot.provider,
        status: "error",
        messageId: "bots.runtime.discordTokenMissing",
        message: "Discord bot token is missing.",
      });
      return;
    }

    let client: DiscordGatewayClient | null = null;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireDiscordGatewayLock>>;
      try {
        lock = await acquireDiscordGatewayLock(token, bot.id);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.logger.warn(
          undefined,
          `acquire Discord gateway lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Discord gateway lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "idle",
          messageId: "bots.runtime.discordGatewayHandledElsewhere",
          message: "Discord gateway is handled by another ACode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      let retryAfterError = false;
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.discordGatewayConnecting",
          message: "Discord gateway is connecting.",
        });
        client = await startDiscordGateway({
          token,
          signal,
          onConnectionStateChange: (state) => {
            if (state === "connected") {
              deps.statusSink.setRuntimeStatus({
                botId: bot.id,
                provider: bot.provider,
                status: "connected",
                messageId: "bots.runtime.discordGatewayRunning",
                message: "Discord gateway is running.",
              });
            }
          },
          onDispatch: async (type, data) => {
            if (signal.aborted) {
              return;
            }
            try {
              const callbackResult = await deps.processProviderCallback("discord", {
                botId: bot.id,
                eventType: type,
                event: data,
              });
              assertBotCallbackSucceeded("Discord", callbackResult);
            } catch (error) {
              // Bugfix: Discord Gateway 没有可重放的消费游标，消息一旦 dispatch 即被消费。
              // 业务失败不能终止长连接（否则后续消息全断），这里只把错误暴露到运行状态并继续。
              deps.logger.warn(
                undefined,
                `Discord gateway dispatch failed bot=${bot.id} type=${type}: ${error instanceof Error ? error.message : String(error)}`,
              );
              if (!signal.aborted) {
                deps.statusSink.setRuntimeStatus({
                  botId: bot.id,
                  provider: bot.provider,
                  status: "error",
                  message: `Discord message handling failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            }
          },
        });
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.discordGatewayRunning",
          message: "Discord gateway is running.",
        });
        await Promise.race([waitForAbort(signal), client.terminated]);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          messageId: "bots.runtime.discordGatewayFailedRetrying",
          message: `Discord gateway failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        retryAfterError = true;
      } finally {
        if (client) {
          try {
            client.close();
          } catch (error) {
            deps.logger.debug(
              undefined,
              `close Discord gateway failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          client = null;
        }
        await lock.release().catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `release Discord gateway lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (retryAfterError && !signal.aborted) {
        await waitFor(5_000, signal);
      }
    }
  }

  async function stopGateway(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.discordGatewayStopped",
        message: "Discord gateway is stopped.",
      });
    }
  }

  function startGateway(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: "connected",
      messageId: "bots.runtime.discordGatewayStarting",
      message: "Discord gateway is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = runBot(bot, controller.signal)
      .catch((error: unknown) => {
        deps.logger.warn(
          undefined,
          `Discord gateway stopped unexpectedly bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (runtimes.get(bot.id) === runtime) {
          runtimes.delete(bot.id);
          const previous = deps.statusSink.getRuntimeStatus(bot.id);
          if (previous?.status === "connected") {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: bot.provider,
              status: "idle",
              messageId: "bots.runtime.discordGatewayStopped",
              message: "Discord gateway is stopped.",
            });
          }
        }
      });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeDiscordIds = new Set(
      currentConfig.bots
        .filter(
          (bot) => bot.provider === "discord" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeDiscordIds.has(botId)) {
        await stopGateway(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "discord" && bot.enabled && bot.credentialRef) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: token 变化后旧 Gateway 仍持有旧会话。必须等旧 client 和跨窗口锁
          // 完全释放再启动新连接，避免同一 bot 两个配置版本短暂并行。
          await stopGateway(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startGateway(bot, fingerprint);
      } else if (bot.provider === "discord" && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：desktop-attached 远端只暴露控制面服务；Discord Gateway 是出站后台连接，
      // 必须留在本地桌面 host，避免远端配置变更后重新抢跑同一 token。
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Discord gateway failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：abort 只是发取消信号；销毁终态必须等 Gateway 关闭并释放跨进程锁。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopGateway,
  };
}
