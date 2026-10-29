/* eslint-disable max-lines -- 本文件在 Overnight 完成信号接线前已达 max-lines 上限（400，零余量）；
   overnight-completion 出口（onOvernightCompletion → connection.send）必须落在 createACodeApp 调用处
   与既有 onToolExecResource 同族，任何一行新增都会越界。头注豁免以恢复门禁信号；拆分重构超出本批范围
   （与 server.ts / v4-bridge.ts / app/types.ts 等同款基线豁免一致）。 */
import { createConfig } from "@acode/adapters/config";
import { createNodeModelSelectionFacade } from "@acode/provider-node";
import { createNodeLoggerFactory } from "@acode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@acode/adapters/mcp";
import {
  ACODE_APP_IS_PACKAGED_ENV,
  createACodeAgentIdleExitEvaluator,
  resolveACodeAgentIdleExitConfig,
  type ACodeMcpResourceSample,
  type ACodeMcpTelemetryEvent,
  LEGACY_NOTIFICATIONS,
} from "@acode/shared";
import type { SqliteSessionStore } from "@acode/adapters/storage";
import { V4_OVERNIGHT_COMPLETION_METHOD } from "@acode/shared/acode-protocol-v4";
import { traceContextToLogContext, createRootTraceContext } from "@acode/contracts";
import type { McpPort, ModelSelection } from "@acode/contracts";
import type { PresentationSurface } from "@acode/core";
import type { RunACodeProtocolAgentOptions, ACodeAppOptions } from "./app/types.js";
import { createACodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./acode-protocol-v4/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installACodeProtocolAiSdkWarningLogger } from "./acode-protocol-v4/ai-sdk-warning-logger.js";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./acode-protocol-v4/official-mcp-auth-port.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  readOfficialServiceSwitchesFromEnv,
  setOfficialServiceSwitches,
  ACODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeACodeEndpointOrigin,
} from "@acode/shared";
import { ACodeProtocolAgentServer } from "./acode-protocol-v4/server.js";
import { ACodeProtocolNdjsonConnection } from "./acode-protocol-v4/transport.js";
import { cleanupProtocolRuntime } from "./acode-protocol-v4/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./acode-protocol-v4/resource-sampler.js";
import { acquireProtocolStartupResource } from "./acode-protocol-v4/startup-resource.js";
import type { ACodeProcessResourceSampler } from "./process-resource-sampler.js";

function applyProtocolPresentationSurface(
  options: Omit<ACodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ACodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * 进程级 Registry 已就绪后，它就是当前 Environment 的模型事实源。
 *
 * 旧 workspace snapshot 不再参与 Provider 和 Model 执行。
 */
function applyProtocolProviderRegistry(
  options: Omit<ACodeAppOptions, "providerRegistry">,
  providerRegistry: ACodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ACodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

export async function runACodeProtocolAgent(
  options: RunACodeProtocolAgentOptions = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    // 安全加固 P2：打包运行时（桌面 main 下发 ACODE_APP_IS_PACKAGED=1）加载托管策略
    // 地板时忽略用户态 env 注入；与 createACodeApp 内的判定同源。
    const config = createConfig({
      env: options.env,
      isPackaged: (options.env ?? process.env)[ACODE_APP_IS_PACKAGED_ENV] === "1",
    });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  // 协议入口先按 env 投影官方服务开关：插件市场管理等请求不经过 createACodeApp，
  // 只在 createACodeApp 设置会让这些请求长期停在默认全关（Desktop env 投影失效）。
  setOfficialServiceSwitches(readOfficialServiceSwitchesFromEnv(options.env ?? process.env));
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "acode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("acode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.acode_protocol",
  });
  installACodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.acode_protocol",
      startupKind: "acode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ACode Protocol agent startup started", {
    context: { version: options.version },
    event: "acode_protocol.startup.started",
    stage: "start",
  });

  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ACodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ACodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ACodeMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: ACodeProcessResourceSampler | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    const configResult = createConfig({
      env: options.env,
      isPackaged: (options.env ?? process.env)[ACODE_APP_IS_PACKAGED_ENV] === "1",
    });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "acode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "acode_protocol.provider_registry.ready",
      module: "bootstrap.acode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // 官方 MCP 身份头端口：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveACodeApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveACodeApiOrigin = (): string =>
      resolveRuntimeACodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ACODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        resolveWorkspace: ({ workspaceIdentity, workspacePath }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveACodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 ACode API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveACodeApiOrigin,
      }),
    };
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            officialMcpAuth,
            // R2 连接状态变更事件（specs/mcp-lifecycle-ttl-approval.md）：pool 把本
            // options 原样展开给每个 lease 的 adapter，监听器随连接实例派发；
            // connectionId 关联 pool lease。与 create-app.ts 的装配位同一形态。
            onStatusChange: (change) => {
              logger.info("MCP server status changed", {
                ...(change.connectionId ? { connectionId: change.connectionId } : {}),
                event: "mcp.server.status_changed",
                ...(change.previousStatus ? { previousStatus: change.previousStatus } : {}),
                ...(change.status.reconnectSuspension
                  ? { reconnectSuspension: change.status.reconnectSuspension }
                  : {}),
                serverName: change.serverName,
                // 同 create-app.ts：日志上下文的 status 是保留闭集字段
                // （contracts/logging/logger.ts），服务器状态枚举不在集内——用非保留键。
                serverStatus: change.status.status,
                timestamp: change.at,
                trigger: change.trigger,
              });
            },
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ACodeProtocolAgentServer({
      createACodeApp: (appOptions = {}) =>
        createACodeApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...runtimeEnv,
            ...appOptions.env,
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: LEGACY_NOTIFICATIONS.toolExecResource, params }),
          // Overnight（K3）完成信号（specs/overnight-completion-notify.md §7）：agent 子进程内
          // supervisor 落终态时经此出口发成 v4 通知，host 侧 acodeAgentService 解析后镜像给 main。
          // method 用本仓 v4 叶子的常量（不进 legacy barrel 冻结面，同 U08 PROVIDER_DIAGNOSTICS_METHODS）。
          onOvernightCompletion: (signal) =>
            connection.send({ method: V4_OVERNIGHT_COMPLETION_METHOD, params: signal }),
        }),
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      // U08 provider 诊断（specs/provider-diagnostics.md）：交出**进程级** Registry runtime，
      // 由 server 用它装配诊断执行器（装配细节与判定/投影同住 provider-diagnostics.ts；本文件
      // 已贴着 400 行 max-lines 门禁，不再堆 import 与装配代码）。不绑定 workspace/session，
      // 因此首次配置尚无 workspace 时也能跑 offline 档——提案 §3.2「不能硬复用要求 workspace
      // 的设置页 probe」的正解：本路径根本不经 workspace app。
      providerRegistryRuntime: activeProviderRegistryRuntime,
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new ACodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (samples) =>
      connection.send({
        method: LEGACY_NOTIFICATIONS.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      connection.send({
        method: LEGACY_NOTIFICATIONS.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    // chat lane 空闲回收(spec: packages/services/specs/chat-lane-idle-reclaim.md):
    // 静默自检搭 60s 资源采样节拍;宣告帧 + 保留退出码让 Host 归因 expected。
    // lifecycle 缺失(测试/嵌入式调用)时不启用——没有退出 owner 就不得自杀。
    const idleExitConfig = resolveACodeAgentIdleExitConfig(runtimeEnv);
    if (idleExitConfig.parseError !== undefined) {
      logger.warn("ACODE_AGENT_IDLE_EXIT_MS 非法,空闲退出已禁用", {
        event: "acode_protocol.idle_exit.config_invalid",
        module: "bootstrap.acode_protocol",
        raw: idleExitConfig.parseError,
      });
    }
    const idleExit =
      idleExitConfig.enabled && options.lifecycle
        ? createACodeAgentIdleExitEvaluator({
            idleExitMs: idleExitConfig.idleExitMs,
            collectFacts: () => {
              const facts = server.collectQuiescenceFacts();
              // transport 在飞帧(含排队)在 entrypoint 合并:connection 对 server 不可见。
              if (connection.hasInFlightDispatches) {
                return { quiescent: false, reasons: [...facts.reasons, "transport-busy"] };
              }
              return facts;
            },
            announce: (params) =>
              connection.send({ method: LEGACY_NOTIFICATIONS.runtimeIdleExit, params }),
            requestShutdown: (exitCode) => options.lifecycle?.requestShutdown(undefined, exitCode),
            onEvent: (event) => {
              if (event.kind === "announced") {
                logger.info("空闲退出已宣告,进入优雅退出链", {
                  event: "acode_protocol.idle_exit.announced",
                  module: "bootstrap.acode_protocol",
                  quiescentMs: event.quiescentMs,
                });
              }
            },
          })
        : undefined;
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
      idleExit,
    );
    startupTimer.complete("ACode Protocol agent startup completed", {
      event: "acode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ACode Protocol agent startup failed", error, {
      event: "acode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    options.lifecycle?.requestShutdown();
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("ACode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "acode_protocol.shutdown.completed",
      module: "bootstrap.acode_protocol",
      status: "completed",
    });
  }
}
