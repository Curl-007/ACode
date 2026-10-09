/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
import { isAbsolute, join, resolve } from "node:path";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
} from "@acode/adapters/storage";
import { createNodeLoggerFactory } from "@acode/adapters/logging";
import { createConfig, resolvePath } from "@acode/adapters/config";
import {
  createNodeExecutionAdapter,
  resolveEffectiveBashShellSelection,
} from "@acode/adapters/exec";
import { createNodeFileSystemAdapter } from "@acode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@acode/adapters/http";
import { createJimpImageProcessorAdapter } from "@acode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@acode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@acode/adapters/mailbox";
import { createNodeContextSourceAdapter } from "@acode/adapters/context";
import { createNodeSkillAdapter } from "@acode/adapters/skills";
import { createMcpAdapter } from "@acode/adapters/mcp";
import {
  AgentRuntime,
  InMemoryRuntimeTaskRegistry,
  PermissionService,
  registerAutoClassifierAuditSink,
  registerBashReflexAuditSink,
  setProcessManagedPolicyFloor,
  buildPluginReferenceCatalog,
  type ResumeSessionResult,
} from "@acode/core";
import {
  createRootTraceContext,
  traceContextToLogContext,
  type TraceContext,
  createSessionId,
  createSessionEvent,
  type ExecutionShellSelection,
  type MessageId,
} from "@acode/contracts";
import {
  ACODE_APP_IS_PACKAGED_ENV,
  isRemoteWorkspaceIdentity,
  readOfficialServiceSwitchesFromEnv,
  resolveACodeRuntimeEnv,
  setOfficialServiceSwitches,
} from "@acode/shared";
import {
  ACODE_ATTACHMENT_FAULT_CODES,
  ACodeAttachmentFaultError,
} from "@acode/shared/acode-protocol-v4";

import { createModelAdapter } from "../model-factory.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type {
  PrepareUserExecutionBoundary,
  ResumeOptions,
  ACodeApp,
  ACodeAppOptions,
} from "./types.js";
import {
  createConfigCliOverrides,
  isMessageEnabled,
  resolveEffectiveLocale,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
  readSessionModelSelection,
} from "./session-store.js";
import { createWorkflowWiring } from "./workflow-wiring.js";
import { createWorkflowAppFacade } from "./workflow-app-facade.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { createSessionFacade } from "./session-facade.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { loadProjectMcpTrustSnapshot } from "./project-mcp-trust.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { createReservedAgentNames, resolveBundledAgentProfiles } from "./bundled-agents.js";
import {
  collectDynamicWorkflowDisabledSkillPaths,
  createDynamicWorkflowSnippetService,
  getWorkflowConcurrencyGovernor,
} from "@acode/cli-workflow/contract";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createOvernightController, type OvernightController } from "./overnight-controller.js";
import { createAmbientRuntimeWiring, type AmbientRuntimeWiring } from "./ambient-runtime.js";
import { createSwarmPlanWiring, type SwarmPlanWiring } from "./swarm-plan-runtime.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveACodeCustomCommandPrompt } from "../custom-command-prompt.js";
import {
  resolveACodeBuiltinHostCommand,
  resolveACodeBuiltinPromptCommand,
} from "../builtin-prompt-command.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { loadPluginAgentProfiles, loadACodeAgentProfiles } from "../subagents.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { createCliPlatformOpenPort } from "./platform-open-port.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf"
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

/**
 * 安全加固 P2：本进程是否属于打包运行时。桌面 main 在 app.isPackaged 时向 host/worker
 * 下发 ACODE_APP_IS_PACKAGED=1（desktopRuntimeEnv）；独立 CLI 分发不设此键——
 * 终端用户就是本机管理员，env 覆盖属合法用法（与桌面打包态的注入面不同）。
 */
function resolveIsPackagedRuntime(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[ACODE_APP_IS_PACKAGED_ENV] === "1";
}

export async function createACodeApp(options: ACodeAppOptions): Promise<ACodeApp> {
  // CLI/headless：官方平台功能默认关闭；可用 ACODE_ENABLE_OFFICIAL_* 环境变量按需开启。
  setOfficialServiceSwitches(readOfficialServiceSwitchesFromEnv(process.env));

  if (!options?.providerRegistry) {
    throw new Error("createACodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
      // 安全加固 P2：桌面 main 在打包态下发 ACODE_APP_IS_PACKAGED=1（见 desktopRuntimeEnv）。
      // 打包运行时加载托管策略地板必须忽略用户态 env 注入（ACODE_MANAGED_POLICY_FILE），
      // 与 P1-7 更新源门禁同一哲学。
      isPackaged: resolveIsPackagedRuntime(options.env ?? process.env),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("acode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  // J1-2（specs/bash-confirm-reflexive-gate.md R6）：反射门 auditedAllow 的审计必须落盘。
  // gate 模块的缺省 sink 只写一行 stderr——宿主不重定向就没有任何持久记录，而 allow lane
  // 的入口包含项目 allow 规则/allowedTools/会话规则（不只是 yolo），confirm 级破坏命令
  // 不能在只留一行易失 stderr 的情况下执行（评审 J1-2 修复，plan 验收项「yolo 下审计
  // 日志落盘」）。这里把 sink 接到 info 级 Logger：NodeFileLogger 以 appendFileSync 写
  // JSONL 日志文件（@acode/adapters/logging），与 setProcessManagedPolicyFloor 同一
  // 「bootstrap 装配期注册进程级 hook」形态。
  const permissionAuditLogger = loggerFactory.createLogger("acode").child({
    ...traceContextToLogContext(traceContext),
    module: "core.permission",
  });
  const unregisterBashReflexAuditSink = registerBashReflexAuditSink(sessionId, (entry) => {
    permissionAuditLogger.info("Bash reflex gate allowed a confirm-level command", {
      assessmentReasons: entry.assessmentReasons,
      command: entry.command,
      event: entry.event,
      justification: entry.justification,
      ruleId: entry.ruleId,
      status: "completed",
      timestamp: entry.timestamp,
    });
  });
  // auto 分类器审计（specs/auto-mode-risk-classifier.md R6）：同一 JSONL 本地落盘形态，
  // 每次灰区裁决一条（verdict/reasonCode/confidence/latency/cache/fallback）。
  const unregisterAutoClassifierAuditSink = registerAutoClassifierAuditSink(sessionId, (entry) => {
    permissionAuditLogger.info("Auto risk classifier verdict", {
      cache: entry.cache,
      confidence: entry.confidence,
      event: entry.event,
      ...(entry.fallback ? { fallback: entry.fallback } : {}),
      latencyMs: entry.latencyMs,
      reasonCode: entry.reasonCode,
      ruleId: entry.ruleId,
      sessionId: entry.sessionId,
      status: "completed",
      timestamp: entry.timestamp,
      tool: entry.tool,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      verdict: entry.verdict,
    });
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "acode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("acode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const storageRoot = resolvePath(configResult.config.storage.dir);
    const cliStorageRoot = getCliStorageRoot(storageRoot);
    const modelIoDir = getModelIoDir(
      cliStorageRoot,
      resolveACodeRuntimeEnv(options.env ?? process.env) === "development",
    );
    // 官方预置 agent（bundled 包 agents/ 目录）：与 bundled 技能同源 pack root，
    // 先解析再传入 loadACodeAgentProfiles 置于数组合并序最前（R5），
    // 避免 bootstrap 内部两处各自解析 pack root。包缺席时降级为空，CLI 正常启动（R8）。
    const bundledAgentOutcome = await resolveBundledAgentProfiles({ cliStorageRoot, logger });
    const acodeSubagentProfileOutcome = await loadACodeAgentProfiles({
      bundledProfiles: bundledAgentOutcome.profiles,
      logger,
      storageRoot,
      workingDirectory,
    });
    const acodeSubagentProfiles = acodeSubagentProfileOutcome.profiles;
    const pluginOutcome = resolveStartupPlugins({
      cliStorageRoot,
      configResult,
      env: options.env,
      logger,
      options,
      startupTimer,
      workingDirectory,
    });
    // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
    const bundledSkillRoots = await resolveBundledSkillRoots({ cliStorageRoot, logger });
    const pluginSubagentProfiles = loadPluginAgentProfiles({
      logger,
      plugins: pluginOutcome.plugins,
      // 保留名单（R5 动态化）：核心二名 ∪ bundled profile 名（含被禁用成员，名单派生自
      // 包内容而非装配结果），再并入 user/project profile 名（既有语义不变）。
      reservedProfileNames: [
        ...createReservedAgentNames(bundledAgentOutcome.profiles),
        ...acodeSubagentProfiles.map((profile) => profile.name),
      ],
      modelSelectionOverrides: acodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
    }).profiles;
    const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
    const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome,
      workingDirectory,
    });
    // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
    const subagentProfiles = [...acodeSubagentProfiles, ...pluginSubagentProfiles];
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    const localSettingStore = asLocalSettingStore(sessionStore);
    const projectID = projectIdFromDirectory(workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    // 安全修复 H2（specs/project-mcp-trust-gate.md）：项目 stdio MCP 的信任快照在
    // 装配期加载一次（与 hooks trust 的 per-session load 同哲学）；读取失败/损坏
    // fail-closed（空信任集），不阻断会话启动。
    const projectMcpTrust = await loadProjectMcpTrustSnapshot({
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      userConfigPath: configResult.sources.user.path,
      logger,
    });
    let {
      configuredMcpServers,
      runtimeConfig,
      untrustedProjectMcpServers,
      pendingProjectMcpServers,
    } = resolveAppRuntimeConfig({
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        acodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      projectMcpTrust,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    });
    if (pendingProjectMcpServers.length > 0) {
      // headless/无 UI 场景的日志提示（spec R7）：不 spawn、不注册工具；审查入口是
      // `acode mcp trust review`。CLI -p 的 stderr 提示由 prompt-command 另行投影。
      logger.info("Project MCP servers pending trust were skipped", {
        event: "mcp.project_trust.pending",
        module: "bootstrap",
        pendingServers: pendingProjectMcpServers.map(
          (server) => `${server.name} (${server.displayCommand})`,
        ),
        reasonCode: "project_mcp_pending_trust",
        reviewHint: "acode mcp trust review",
        status: "completed",
        workspaceIdentity: projectMcpTrust.workspaceIdentity,
      });
    }
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ACode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
      appVersion,
      logger,
      projectConfigPath: options.projectConfigPath,
      policy: options.workspaceHookPolicy,
      policyProvider: options.workspaceHookPolicyProvider,
      reviewHost: options.workspaceHookReviewHost,
      workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
      runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
        // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
        // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
        // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
        // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
        // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
        enabled: runtimeConfig.hooks?.enabled === true,
        timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
        maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
      },
      sessionId,
      snapshot: configResult.sources.project.workspaceHookSnapshot,
      userConfigPath: configResult.sources.user.path,
      workingDirectory,
      ...(options.workspaceHookReviewHost
        ? {
            emitReviewEvent: async (event) => {
              if (!runtime) throw new Error("ACode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
            emitAdmissionEvent: async (event) => {
              if (!runtime) throw new Error("ACode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
          }
        : {}),
    });
    // 安全加固 P2 补丁项（subagent-policy-floor-inheritance R1）：策略地板注册为进程级
    // 事实——Explore 子代理与 memory agent 用 defaultPermissionConfig 自建 PermissionService，
    // 构造参数纪律覆盖不到；进程注册后任何实例缺省自动携带地板（含 disableBypassPermissionsMode
    // 对 Explore 缺省 yolo 的约束）。undefined = 本机未部署策略文件（清除旧值，测试/复用安全）。
    setProcessManagedPolicyFloor(configResult.config.permission.policy);
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
      // 安全加固 P2：托管策略地板（deny/ask 规则 + disableBypassPermissionsMode）。
      // disallowedTools 的策略并集已在配置合并层完成，这里不重复携带。
      ...(configResult.config.permission.policy
        ? { policyFloor: configResult.config.permission.policy }
        : {}),
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const artifactStore =
      options.artifactStore ??
      createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      });
    const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
    const messageEnabled = isMessageEnabled(options.env ?? process.env);
    const sessionMailboxPort =
      options.sessionMailboxPort ??
      (messageEnabled
        ? createNodeSessionMailboxAdapter({
            rootDir: resolvePath(
              (options.env ?? process.env).ACODE_MAILBOX_ROOT ?? "~/.acode/mailbox",
            ),
          })
        : undefined);
    markStorageAdaptersInitialized({
      cliStorageRoot,
      hasInjectedArtifactStore: options.artifactStore !== undefined,
      hasInjectedSessionStore: options.sessionStore !== undefined,
      startupTimer,
      storageRoot,
    });
    const mcpPort =
      options.mcpPort ??
      (runtimeConfig.mcp?.enabled === false
        ? undefined
        : (options.mcpPortFactory?.({ workingDirectory }) ??
          createMcpAdapter({
            clientVersion: appVersion,
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            workingDirectory,
          })));
    const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
    const executionPort =
      options.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: options.onToolExecResource,
        network: {
          httpProxy: configResult.config.network.httpProxy,
          noProxy: configResult.config.network.noProxy,
          caCertFile: configResult.config.network.caCertFile,
        },
        outputRootDir: join(storageRoot, "cli", "exec"),
        processEnv: options.env ?? process.env,
      });
    const ownsExecutionPort = options.executionPort === undefined;
    const pdfDocumentPort =
      options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
    // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
    const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
    const httpClientPort =
      options.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: options.env ?? process.env,
        timeoutMs: configResult.config.network.timeout,
        proxyUrl: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      });
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ACode runtime is not initialized yet.");
      return runtime;
    };
    let resumePrepared = false;
    const resolveDefaultShellSelection = (): ExecutionShellSelection =>
      resolveEffectiveBashShellSelection({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      }).selection;
    let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;
    const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
      initialShellSelectionPromise ??= (async () =>
        (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
      return initialShellSelectionPromise;
    };
    const initializeSessionShellEnvironment = async (): Promise<void> => {
      getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
    };

    const restorePersistedModelSelection = async (): Promise<
      ResumeSessionResult["modelSelection"]
    > => {
      const registry = options.providerRegistry;
      let selection: ResumeSessionResult["modelSelection"];
      try {
        // 数据库启动已完成版本化迁移；恢复只读新字段，不按会话重复补迁。
        selection = await readSessionModelSelection(sessionStore, sessionId);
      } catch (error) {
        // 选择 entry 的读取/解析故障不能拖垮独立的历史恢复；留下真实存储错误，
        // 不读取旧消息或默认模型来掩盖失败。
        logger.warn("Session model selection restore failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.restore_failed",
          sessionId,
        });
      }
      const validation = selection && registry.validateSelection(selection);
      // 只查模型是否存在会把缺档位/已删除的选择重新绑定进 Runtime，
      // 抵消了未绑定初始化。历史恢复不要求可执行模型，只有完整选择可以绑定。
      getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
      // 恢复结果是保存意图，不是执行绑定。过去在这里置空/删档位，Host 的
      // Selection View 就再也拿不到原意图，账号切换和配置恢复后也无法重新解析。
      return selection;
    };

    const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
      const runtime = getRuntime();
      const unsubscribe = resumeOptions?.onEvent
        ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
        : undefined;

      try {
        const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
        const modelSelection = await restorePersistedModelSelection();
        await initializeSessionShellEnvironment();
        const result = await runtime.resumeFromStore({
          ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
          // 只传调用方原始 mode；项目/全局默认值不能伪装成 invocation override，
          // 否则交互式 resume 将无法恢复真正持久化的 session mode。
          modeOverride: options.runtimeConfig?.mode,
          persistedMessages: resumeOptions?.persistedMessages,
          traceContext: resumeTraceContext,
        });
        await runtime.activatePausedTargetAfterResume(resumeTraceContext);
        resumePrepared = true;
        return { ...result, modelSelection };
      } finally {
        unsubscribe?.();
      }
    };

    const prepareResume = async (
      submitTraceContext?: TraceContext,
      abortSignal?: AbortSignal,
    ): Promise<void> => {
      if (!options.resume || resumePrepared) return;
      await resumeFromStore({
        ...(abortSignal ? { abortSignal } : {}),
        traceContext: submitTraceContext ?? traceContext,
      });
      resumePrepared = true;
    };

    const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
      // Bash shell 快照属于“首次真实用户执行”边界，而不是 chat
      // input 独有状态。普通 prompt、expert workflow、script workflow 都可能
      // 作为新 session 的第一个模型/子 agent 入口，必须统一在 resume/context
      // 初始化前落定一次，避免模型看到的 Shell 与 Bash 执行 shell 分叉。
      await initializeSessionShellEnvironment();
      await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    };

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    const { scriptWorkflowFacade, dynamicWorkflowRunPort } = createWorkflowWiring({
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
      executionPort,
      concurrency: workflowConcurrencyGovernor,
      remoteSessionId: runtimeConfig.remoteSessionId,
      workspaceIdentity: runtimeConfig.memory?.workspaceIdentity,
    });
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    // K3 overnight：runtime-task registry 在装配期显式建一份并注入 runtime——
    // overnight controller 需要同一份引用来注册 run 投影（type: "overnight"），
    // 不注入则 runtime 自建私有实例，run 的可见面挂不上去。
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    // K2 swarm plan 装配（specs/swarm-task-graph.md 2b）：port 在主 runtime 构造前成型
    //（deps 注册门要它在场），executeNode 的 runtime 引用在构造后 bind（overnight
    // controller 的同款先后序）。持久化 seam 绑 sessionStore 的 swarm plan 行。
    const swarmPlanWiring: SwarmPlanWiring = createSwarmPlanWiring({
      appOptions: options,
      appVersion,
      ...(artifactStore ? { artifactStore } : {}),
      configResult,
      fileSystemPort,
      ...(httpClientPort ? { httpClientPort } : {}),
      imageProcessorPort,
      logger,
      ...(mcpPort ? { mcpPort } : {}),
      modelFactory,
      permissionService,
      runtimeConfig,
      runtimeTaskRegistry,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
      ...(pdfDocumentPort ? { pdfDocumentPort } : {}),
    });
    // K6 ambient 接线（specs/ambient-budget-scheduler.md 接线批）：wiring 在主 runtime
    // 构造前成型（deps 的注册门 ambientSchedulePort 要 queue + 创建回调闭包——两者都不
    // 依赖 runtime 实例），fork/reminder/busy 驱动面在 runtime 就绪后 bind
    //（swarmPlanWiring 的同款先后序）。flag 关（缺省）时只注入共享账本与 queue 面
    //（turn 计量旁路写继续记 user kind——数据面与调度面正交），不启动 runner。
    const ambientWiring: AmbientRuntimeWiring = createAmbientRuntimeWiring({
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      imageProcessorPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      runtimeConfig,
      runtimeTaskRegistry,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
      ...(pdfDocumentPort ? { pdfDocumentPort } : {}),
    });
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      runtimeTaskRegistry,
      swarmPlanPort: swarmPlanWiring.port,
      ambientSchedulePort: ambientWiring.port,
      // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // 动态工作流关闭时不提供 dynamic-workflows 技能：
                // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink: options.eventSink,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      // CLI 宿主 native opener（K9）：Open 工具的平台 port。desktop host 下发链
      // 接入后由宿主侧替换注入，此处保持 CLI 形态的兜底实现。
      platformOpenPort: createCliPlatformOpenPort(),
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    // K2 swarm：runtime 实例就绪后绑定 executeNode 迟到引用，并从持久化行恢复 plan
    //（hydrate 在首个 turn 前完成——恢复的图要能被第一个调度点推进；坏行 warn + 空图起步）。
    swarmPlanWiring.bindRuntime(runtime);
    await swarmPlanWiring.hydrate(traceContext);
    // K6 ambient：runtime 实例就绪后绑定 fork/reminder/busy 驱动面，并（flag 开时）
    // 启动 runner——异步驱动不 await（宿主关停走 app.close 的 dispose，overnight 同款）。
    ambientWiring.bindRuntime(runtime);
    await ambientWiring.start();
    // K3 overnight 接线：controller 在 runtime 构造后装配（fork/turn 驱动都要 runtime
    // 实例）。入口链路：sendInput 拦截（resolveACodeBuiltinHostCommand）→ 结构化动作 →
    // controller.handleHostCommand；宿主/协议层也可经 app.startOvernightRun 直调同一面。
    const overnightController: OvernightController = createOvernightController({
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      executionPort,
      fileSystemPort,
      imageProcessorPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      runtime: runtime!,
      runtimeConfig,
      runtimeTaskRegistry,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const inputFacade = createInputFacade({
      artifactStore,
      // K3 /overnight 族的宿主动作拦截：sendInput 顶解析（薄层，结构化动作判定），
      // 命中即不进模型。指令文本随后以 controlOnly 用户轮落 transcript（/goal 的
      // recordExternalUserPrompt 先例——可见、无模型输出），再返回宿主回执。
      builtinHostCommandInterceptor: async (text, interceptorOptions) => {
        const command = resolveACodeBuiltinHostCommand(text);
        if (!command) return undefined;
        const hostTraceContext = interceptorOptions?.traceContext ?? traceContext;
        const result = await overnightController.handleHostCommand(command, hostTraceContext);
        try {
          await getRuntime().recordExternalUserPrompt(text, { traceContext: hostTraceContext });
        } catch (error) {
          // transcript 可观测面失败不吞宿主动作的回执（启动/取消已生效）。
          logger.warn("Overnight host command transcript record failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "overnight.command.transcript_failed",
            module: "bootstrap.overnight",
          });
        }
        return {
          response: result.response,
          ...(result.runId ? { runId: result.runId } : {}),
        };
      },
      customCommandPromptResolver: async (text, resolverOptions) => {
        const builtinPrompt = resolveACodeBuiltinPromptCommand(text, {
          // 动态工作流关闭时内置 `/workflow` 不得展开。目录侧已经把它从 `/` 面板
          // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。TUI 缺席时不设门禁；
          // headless 按 --enable-workflow 显式取值，见 runtimeConfig 字段注释。
          dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
          workingDirectory,
        });
        if (builtinPrompt !== undefined) {
          return builtinPrompt;
        }
        return await resolveACodeCustomCommandPrompt(text, {
          env: options.env,
          executionPort,
          logger,
          projectConfigPath: options.projectConfigPath,
          sessionId,
          signal: resolverOptions?.abortSignal,
          skipUserConfig: options.skipUserConfig,
          traceContext: resolverOptions?.traceContext ?? traceContext,
          userConfigPath: options.userConfigPath,
          workingDirectory,
        });
      },
      inputHistoryStore,
      logger,
      prepareUserExecutionBoundary,
      runtime,
      sessionId,
      traceContext,
    });
    const workflowFacade = createWorkflowFacade({
      appOptions: options,
      appVersion,
      artifactStore,
      cliStorageRoot,
      configResult,
      eventSink: options.eventSink,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      runtime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    const sessionFacade = createSessionFacade({
      // App 关闭时停下本会话拥有的 dwf run：
      // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
      configResult,
      configuredMcpServers,
      ...(options.configuredDefaultModelSelection
        ? {
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
          }
        : {}),
      executionPort,
      localSettingStore,
      logger,
      loggerFactory,
      mcpPort,
      ownsExecutionPort,
      ownsMcpPort,
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
      ownsSessionStore,
      prepareUserExecutionBoundary,
      prepareResume,
      projectID,
      providerRegistry: options.providerRegistry,
      resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
      runtime,
      sessionId,
      sessionStore,
      traceContext,
      untrustedProjectMcpServers,
      workingDirectory,
    });

    const closeSession = sessionFacade.close;
    const resolvePromptAttachment = async (input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
      let ref = input.ref;
      let mediaType = input.mime;
      let artifactUri: string | undefined;
      if (input.messageId && input.attachmentIndex !== undefined) {
        // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
        // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
        const persistedMessage = await sessionStore.messageWithParts({
          sessionID: sessionId,
          messageID: input.messageId as MessageId,
        });
        const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
          input.attachmentIndex
        ];
        if (persistedAttachment?.type === "file") {
          mediaType = persistedAttachment.mime;
          // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
          // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
          artifactUri =
            persistedAttachment.metadata?.artifactUri ??
            (persistedAttachment.url.startsWith("acode-artifact://")
              ? persistedAttachment.url
              : undefined);
          ref =
            artifactUri ??
            (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
        }
        // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
        // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
      }
      return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
    };
    return {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      // K3 overnight 宿主结构化动作面（协议层/宿主直调；/overnight 文本拦截走 sendInput）。
      startOvernightRun: async (input) =>
        await overnightController.start(input.durationMs, input.traceContext),
      cancelOvernightRun: () => overnightController.cancel(),
      getActiveOvernightRunId: () => overnightController.getActiveRunId(),
      respondWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.respond(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.decision,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      toggleWorkspaceHookReviewItem: (input) =>
        workspaceHookRuntimeSecurity?.toggle(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.reviewItemId,
          input.enabled,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      revokeWorkspaceHookTrust: (input) =>
        ("hookDeclarationDigests" in input
          ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
          : workspaceHookRuntimeSecurity?.revoke(
              {
                sessionId: input.sessionId,
                taskId: input.taskId,
                runId: input.runId,
                ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
                workspaceIdentity: input.workspaceIdentity,
                bundleDigest: input.bundleDigest,
                reviewFlowId: input.reviewFlowId,
                generation: input.generation,
                interactionId: input.interactionId,
              },
              input.reviewItemIds,
            )) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      requestWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.requestReview({
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
        }) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
      // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
      reloadWorkspaceHookTrust: () =>
        workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
      // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
      writePromptAttachment: async (input) => {
        const artifact = await artifactStore.writeToolResultArtifact({
          content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
          sessionId,
          toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "prompt-attachment:upload",
          trace: traceContext,
        });
        if (
          input.mime.startsWith("image/") ||
          input.mime.startsWith("video/") ||
          input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
        ) {
          // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
          void artifactStore
            .primeMediaAttachmentPath?.({
              bytes: input.bytes,
              mediaType: input.mime,
              uri: artifact.uri,
            })
            .catch(() => undefined);
        }
        return { ref: artifact.uri };
      },
      readPromptAttachment: async (input) => {
        const { ref, mediaType } = await resolvePromptAttachment(input);
        // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
        // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
        if (ref.startsWith("acode-artifact://")) {
          const artifact = await artifactStore.readToolResultArtifact({
            uri: ref,
            trace: traceContext,
          });
          return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
        }
        const read = await fileSystemPort.readBinaryFile({
          path: ref,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
        return { bytes: read.content, mediaType };
      },
      statPromptAttachment: async (input) => {
        const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
        if (artifactUri) {
          if (!artifactStore.statToolResultArtifact) {
            throw new ACodeAttachmentFaultError(ACODE_ATTACHMENT_FAULT_CODES.statUnsupported);
          }
          const result = await artifactStore.statToolResultArtifact({
            uri: artifactUri,
            trace: traceContext,
          });
          return {
            totalBytes: result.bytes,
            mediaType: result.contentType || mediaType,
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          };
        }
        const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
        if (result.kind !== "file") {
          // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
          // 让 share 预检按确定分类处理，而不是靠错误文本猜。
          throw new ACodeAttachmentFaultError(ACODE_ATTACHMENT_FAULT_CODES.statNotFile);
        }
        return {
          totalBytes: result.sizeBytes,
          mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      },
      resolvePromptAttachmentPreviewSource: async (input) => {
        const resolved = await resolvePromptAttachment(input);
        if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
        if (resolved.artifactUri) {
          if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
          try {
            const materialized = await artifactStore.ensureMediaAttachmentPath({
              uri: resolved.artifactUri,
              mediaType: resolved.mediaType,
            });
            if (materialized.status === "ready" && materialized.path.trim()) {
              return {
                kind: "local_path",
                path: materialized.path,
                mediaType: resolved.mediaType,
              };
            }
          } catch {
            // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
          }
          return { kind: "chunked" };
        }
        if (isAbsolute(resolved.ref)) {
          return {
            kind: "local_path",
            path: resolved.ref,
            mediaType: resolved.mediaType,
          };
        }
        return { kind: "chunked" };
      },
      ...sessionFacade,
      close: async () => {
        try {
          unregisterBashReflexAuditSink();
          unregisterAutoClassifierAuditSink();
          // K3 R1：app 关闭 = overnight run 终止（收口 runtime-task 投影，不等待在飞 turn）。
          overnightController.dispose();
          // K6：app 关闭 = ambient runner 停循环释放 claim + 账本缓冲落盘（生命周期
          // 绑定 app，spec R5；dispose 幂等，flag 关时是纯 flush）。
          await ambientWiring.dispose();
          // K2 swarm：app 关闭 = 在飞 worker 子会话全部 abort（协作式取消；迟到结果由
          // runner 的 stale run 防护丢弃，持久化行已随每次提交写穿）。
          swarmPlanWiring.dispose();
          await closeSession?.();
        } finally {
          providerModelRuntime?.dispose();
        }
      },
      ...workflowFacade,
      ...scriptWorkflowFacade,
      ...createWorkflowAppFacade({
        getRuntime,
        prepareUserExecutionBoundary,
        dynamicWorkflowRunPort,
        sessionStore,
        sessionId,
        logger,
        traceContext,
      }),
      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
        // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
  } catch (error) {
    providerModelRuntime?.dispose();
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ACode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
