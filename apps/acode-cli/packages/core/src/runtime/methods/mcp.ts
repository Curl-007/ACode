import {
  getCapturedACodeCuaBrokerCredentials,
  ACODE_CUA_OFFICIAL_PLUGIN_ID,
  ACODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ACODE_PLUGIN_ID_ENV_KEY,
} from "@acode/shared";
import { registerMcpResourceTools, registerMcpTools, traceContextToLogContext } from "../deps.js";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;

/**
 * 只有同时携带 resolver 注入的官方 plugin id 和本进程私有 authority 的 server 才能共享
 * Computer Use 项目授权。server 名、tool 名和 manifest env 都可被第三方仿造，不能单独作为信任依据。
 */
export function computeOfficialCuaServerNames(
  servers: Record<string, McpServerConfig>,
  trustedServerNames: ReadonlySet<string>,
): Set<string> {
  const expectedAuthority = getCapturedACodeCuaBrokerCredentials().pluginAuthority;
  const names = new Set<string>();
  if (!expectedAuthority) return names;

  for (const [name, config] of Object.entries(servers)) {
    if (!trustedServerNames.has(name)) continue;
    if (config.type !== "stdio") continue;
    if (
      config.env?.[ACODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() !==
        ACODE_CUA_OFFICIAL_PLUGIN_ID ||
      config.env?.[ACODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim() !== expectedAuthority
    ) {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function startMcpStartup(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<McpConnectionSnapshot> | undefined {
  if (this.mcpInitialized) return this.mcpStartupPromise;
  this.mcpInitialized = true;

  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    this.mcpToolsRegistered = true;
    return undefined;
  }

  const servers = this.config.mcp?.servers ?? {};
  if (Object.keys(servers).length === 0) {
    const startup = Promise.all([this.mcpPort.status(), this.mcpPort.listTools()])
      .then(([statuses, tools]) => ({ statuses, tools }))
      .catch((error) => {
        this.logger?.warn("MCP existing tool discovery failed", {
          ...traceContextToLogContext(traceContext),
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.existing_tools.failed",
          module: "core.runtime",
          status: "failed",
        });
        return { statuses: {}, tools: [] };
      });
    this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
    return this.mcpStartupPromise;
  }

  const startedAt = Date.now();
  const startup = this.mcpPort
    .connectConfiguredServers(servers, {
      // authorization_code MCP 无人完成浏览器授权时，session 启动过去会等默认 5 分钟，
      // 导致模型请求迟迟不发出；session 只等 15s，授权入口由设置页 mcp/list 展示。
      oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
      trace: traceContext,
      workingDirectory: this.workingDirectory,
      workspaceIdentity: this.config.workspaceIdentity?.toString(),
    })
    .then((snapshot) => {
      const statusCounts = Object.values(snapshot.statuses).reduce<Record<string, number>>(
        (counts, status) => {
          counts[status.status] = (counts[status.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      this.logger?.info("MCP startup completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "mcp.startup.completed",
        module: "core.runtime",
        serverCount: Object.keys(servers).length,
        status: "completed",
        statusCounts,
        toolCount: snapshot.tools.length,
      });
      return snapshot;
    })
    .catch((error) => {
      this.logger?.warn("MCP startup failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.startup.failed",
        module: "core.runtime",
        status: "failed",
      });
      return { statuses: {}, tools: [] };
    });
  this.mcpStartupPromise = this.trackResidencyBlockingWork(startup);
  this.logger?.debug("MCP startup scheduled", {
    ...traceContextToLogContext(traceContext),
    event: "mcp.startup.scheduled",
    module: "core.runtime",
    serverCount: Object.keys(servers).length,
    status: "started",
  });
  return this.mcpStartupPromise;
}

export async function initializeMcp(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  // MCP startup 可能同时被 constructor residency、首轮 turn 和 settings refresh 触发。
  // 先占住同一个 promise，再 await，避免两个调用都通过 false 检查并重复注册工具。
  if (this.mcpInitializationPromise !== undefined) {
    await this.mcpInitializationPromise;
    return;
  }

  const initialization = initializeMcpOnce.call(this, traceContext);
  this.mcpInitializationPromise = initialization;
  try {
    await initialization;
  } finally {
    this.mcpInitializationPromise = undefined;
  }
}

async function initializeMcpOnce(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (this.mcpToolsRegistered) return;

  const startup = this.startMcpStartup(traceContext);
  const mcpPort = this.mcpPort;
  if (!startup || !mcpPort) {
    this.mcpToolsRegistered = true;
    return;
  }
  const serverCount = Object.keys(this.config.mcp?.servers ?? {}).length;

  try {
    const snapshot = await startup;
    const registered = registerMcpTools(this.registry, mcpPort, snapshot.tools, {
      allowedTools: this.config.toolAllowlist,
      disallowedTools: this.config.toolDisallowlist,
      sessionId: this.sessionId,
      officialCuaServerNames: computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      ),
    });
    // 资源拉取面（specs/mcp-sampling-resources.md）：只对 resources:true 的 server 注册；
    // 与工具注册同一失效面（新工具进 registry 才需要 invalidateToolCache）。
    const resourceTools = registerMcpResourceTools(
      this.registry,
      mcpPort,
      this.config.mcp?.servers ?? {},
    );
    if (registered.length > 0 || resourceTools.length > 0) {
      this.invalidateToolCache();
    }
    // R1 快启门收尾接线（specs/mcp-startup-gate-breaker.md，WI-5 共享桶申请②）：
    // 后台连接完成、Deferred/空工具记录被真实工具原子替换后刷新注册表。
    subscribeMcpToolsRebind.call(this, mcpPort, traceContext, snapshot.tools);
    this.logger?.info("MCP tools registered", {
      ...traceContextToLogContext(traceContext),
      event: "mcp.tools.registered",
      module: "core.runtime",
      registeredToolCount: registered.length,
      serverCount,
      status: "completed",
    });
  } catch (error) {
    this.mcpToolsRegistered = true;
    this.logger?.warn("MCP initialization failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.initialization.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
  this.mcpToolsRegistered = true;
}

const MCP_TOOLS_REBIND_DEBOUNCE_MS = 100;

type McpToolsFingerprintTool = McpConnectionSnapshot["tools"][number];

function mcpToolsFingerprint(tools: readonly McpToolsFingerprintTool[]): string {
  return tools
    .map((tool) => `${tool.serverName}\u0000${tool.toolName}`)
    .sort()
    .join("\u0001");
}

/**
 * 工具面变更订阅 → 去抖 rebind 注册表（specs/mcp-startup-gate-breaker.md R1
 * 收尾接线，WI-5 共享桶申请②）。callTool 按 server/tool 身份路由并等待活连接，
 * 不依赖本订阅——没有它调用正确性也在，它只把注册表 schema 与真实握手结果对齐
 * （消除 Deferred 缓存陈旧窗）。生命周期：port 与 runtime 同生命周期（session
 * 结束 adapter 即销毁），不做显式退订；close 后的迟到 rebind 写进的是已无消费者
 * 的注册表，无害且不抛。
 */
function subscribeMcpToolsRebind(
  this: AgentRuntimeInternal,
  mcpPort: McpPort,
  traceContext: TraceContext,
  initialTools: readonly McpToolsFingerprintTool[],
): void {
  if (!mcpPort.onToolsChanged) return;
  let lastFingerprint = mcpToolsFingerprint(initialTools);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let rebinding = false;
  let rerunAfterInFlight = false;

  const rebind = async (): Promise<void> => {
    if (rebinding) {
      // 在飞期间又来事件：收尾后补跑一次，不丢更新。
      rerunAfterInFlight = true;
      return;
    }
    rebinding = true;
    try {
      const tools = await mcpPort.listTools();
      const fingerprint = mcpToolsFingerprint(tools);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      const registered = registerMcpTools(this.registry, mcpPort, tools, {
        allowedTools: this.config.toolAllowlist,
        disallowedTools: this.config.toolDisallowlist,
        sessionId: this.sessionId,
        officialCuaServerNames: computeOfficialCuaServerNames(
          this.config.mcp?.servers ?? {},
          new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
        ),
      });
      // 资源拉取面与工具同一失效面（initializeMcpOnce 同款）：新连上的
      // resources:true server 也要在 rebind 时补注册（幂等）。
      const resourceTools = registerMcpResourceTools(
        this.registry,
        mcpPort,
        this.config.mcp?.servers ?? {},
      );
      if (registered.length > 0 || resourceTools.length > 0) {
        this.invalidateToolCache();
      }
      this.logger?.info("MCP tools rebound after background connect", {
        ...traceContextToLogContext(traceContext),
        event: "mcp.tools.rebound",
        module: "core.runtime",
        registeredToolCount: registered.length,
        status: "completed",
      });
    } catch (error) {
      // rebind 是旁路：失败不影响连接与调用面，下一次工具面事件再试。
      this.logger?.warn("MCP tools rebind failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.tools.rebind_failed",
        module: "core.runtime",
        status: "failed",
      });
    } finally {
      rebinding = false;
      if (rerunAfterInFlight) {
        rerunAfterInFlight = false;
        void rebind();
      }
    }
  };

  mcpPort.onToolsChanged(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void rebind();
    }, MCP_TOOLS_REBIND_DEBOUNCE_MS);
    // CLI 短进程不因悬挂定时器阻止退出。
    debounce.unref?.();
  });
}
