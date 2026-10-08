import type { ConfigResult } from "@acode/adapters/config";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@acode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@acode/core";
import { type BuiltInSubagentModelSelectionOverrides } from "@acode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@acode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import {
  collectProjectDeclaredStdioServers,
  resolveUntrustedProjectMcpServers,
  type ProjectMcpTrustSnapshot,
  type UntrustedProjectMcpServer,
} from "./project-mcp-trust.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ACodeAppOptions } from "./types.js";
import {
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

interface ResolvedAppRuntimeConfig {
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
  /** 被信任门拦下的项目 stdio server（日志/headless 提示用，spec R7）。 */
  pendingProjectMcpServers: UntrustedProjectMcpServer[];
}

interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ACodeAppOptions;
  persistedMode?: CollaborationMode;
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  /**
   * 项目 MCP 信任快照（specs/project-mcp-trust-gate.md，安全修复 H2）。
   * 调用方（create-app）异步加载后注入，本工厂保持同步纯装配。
   * 缺省 = 空信任集 = fail-closed：全部项目 stdio server 视为 untrusted。
   */
  projectMcpTrust?: ProjectMcpTrustSnapshot;
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // 恢复历史不等于开始执行：失效/缺失选择保持未绑定，不能借 configured default 补齐。
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // 空白会话先创建、再应用本次 Submission 的选择；强制初始默认模型会
  // 让未配置 default 的用户在 switch/send 前就创建失败。未绑定 Runtime 可以存在，
  // 真正执行仍由 admission/ModelFactory 校验完整选择，不能在这里偷偷选择 Registry 首项。
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // 标题生成 sidecar 默认 15s 在慢模型/代理链路下容易超时，
          // 入口层统一补 60s，避免旧 core 默认值或空配置让桌面端继续回落到 15s。
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // 空 titleGeneration 表示启用默认标题生成，模型必须跟随会话当前模型。
          // 如果这里在草稿 session 创建时固化另一份标题模型，之后切模型只会更新主链路，
          // 首发时的 generate title sidecar 会继续使用切换前的旧 provider/model。
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // Protocol session/create 传入的 mcp.servers 只包含 UI MCP 设置里的用户配置，
  // 不包含插件注册的 MCP。宿主内建 server 最后合并并保留其 identity，避免用户或第三方
  // 用同名配置劫持 mcp__node_repl__*；普通 plugin MCP 仍允许显式用户配置覆盖。
  const configLayerMcpServers =
    options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers;
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...configLayerMcpServers,
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl 需要 broker 注入，但不是 CUA MCP server。注入资格与官方 CUA 图片
    // authority 必须分开；把它塞进 trustedOfficialCuaServerNames 会让整个
    // 通用 node_repl 结果被误送进 exact-raster gate，Browser 截图和 console 日志都会失败。
    cuaBridgeServerNames.add("node_repl");
  }
  // 安全修复 H2 + B1 收口（specs/project-mcp-trust-gate.md）：项目作用域 stdio MCP
  // 不再「开箱即用」——clone+打开仓库曾直接 spawn 仓库声明的 command/args（早于任何
  // 用户输入，即 RCE）。无内容 digest 信任记录的项目 stdio server 一律剔除出自动连接
  // 集合（不 spawn、不注册工具），状态投影为既有 untrusted 状态；http/sse 不 spawn
  // 本地进程维持自动连接；builtin/plugin（宿主 authority）经引用相等判定豁免（防同名
  // 声明 DoS）。B1：显式 params（desktop 会把仓库携带的 .acode/.agents server 一并
  // 下发，legacy wire 无 cwd/scope）按 R10 内容命中判定过同一 digest 门——判定依据
  // 是「内容可能来自 workspace 文件」，不信任 client 侧任何来源标签。快照缺省 =
  // fail-closed。
  const projectMcpServerSources = configResult.sources.mcp?.serverSources;
  const projectMcpGate = resolveUntrustedProjectMcpServers({
    configuredMcpServers,
    configLayerServers: configLayerMcpServers,
    serverSources: projectMcpServerSources,
    projectDeclaredServers: collectProjectDeclaredStdioServers({
      servers: configResult.config.mcp.servers,
      serverSources: projectMcpServerSources,
    }),
    workingDirectory,
    ...(input.projectMcpTrust ? { trust: input.projectMcpTrust } : {}),
  });
  const untrustedProjectMcpServers = projectMcpGate.untrustedServerNames;
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // 仅接受显式传入的会话级工具面（ACode Protocol session/create 或 CLI
    // --allowed-tools/--disallowed-tools）。不要从 config.permission.allowedTools
    // 回落：那个键的既有语义是“免审批清单”，把它投影到注册面会让老配置里
    // 只写了几个 allowedTools 的用户突然丢失其余全部工具。
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    titleGeneration,
    workingDirectory,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    // K6 ambient flag（specs/ambient-budget-scheduler.md R5 红线）：默认关闭——开启是
    // 显式用户决策。对齐 runtimeFeatures 的「装配期推导注入」形态：CLI/协议
    // call-level runtimeConfig（ACodeAppOptions.runtimeConfig）是唯一入口；config 文件
    // schema（adapters features 面）不承载域级开关，本工厂只做 === true 收口，
    // 不引入第二份真值。下游两处门：runtime-tools 的 Schedule 注册 + ambient 装配的
    // runner 启动，都只读 runtimeConfig.ambient?.enabled。
    ambient: {
      enabled: options.runtimeConfig?.ambient?.enabled === true,
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
    pendingProjectMcpServers: projectMcpGate.pendingServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ACodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}
