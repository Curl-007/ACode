/* eslint-disable max-lines -- 存量基线豁免:初始导入即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,CLI turbo lint 门禁因此从未变绿)。先恢复门禁信号,拆分重构另行立项。 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type OAuthClientProvider,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpContentBlock,
  McpOAuthConfig,
  McpPluginStateNotification,
  McpPort,
  McpReadResourceResult,
  McpResourceDescriptor,
  McpServerConfig,
  McpServerStatus,
  McpServerStatusChange,
  McpServerStatusChangeListener,
  McpServerStatusChangeTrigger,
  McpServerStatusKind,
  McpToolCallResult,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
  TraceContext,
} from "@acode/contracts";
import { ACODE_MCP_SERVER_REQUEST_ID_META_KEY } from "@acode/contracts";
import {
  exceedsMcpToolNameLimit,
  deduplicateMcpToolDescriptors,
  MCP_TOOL_NAME_MAX_LENGTH,
  normalizeMcpToolDescriptor,
} from "./descriptor.js";
import {
  buildMcpAccessDeniedError,
  buildMcpCrashStormRefusalError,
  buildMcpNotConnectedMessage,
  buildMcpOutcomeUnknownError,
  buildMcpReconnectRefusalError,
} from "./model-guidance.js";
import {
  McpCrashStormBreaker,
  type McpCrashStormTrip,
} from "./crash-storm-breaker.js";
import {
  McpProbeLadder,
  type McpProbeLadderOptions,
} from "./probe-ladder.js";
import {
  createMcpToolCache,
  type McpToolCache,
} from "./mcp-tool-cache.js";
import { expandMcpEnvDeep } from "./expand-env.js";
import {
  createMcpNegotiationMemory,
  type McpNegotiationMemory,
} from "./negotiation-memory.js";
import {
  createSingleflightRunner,
  McpReconnectBudget,
} from "./reconnect-budget.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import { OFFICIAL_MCP_AUTH_META_KEY, ACODE_OFFICIAL_MCP_AUTH_TYPE, type OfficialMcpAuthFailureKind } from "@acode/shared";
import { type V4McpServerFailureKind } from "@acode/shared/acode-protocol-v4";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import {
  createSharedACodeCredentialStore,
  type SharedACodeCredentialStore,
} from "../auth/shared-credentials.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  type McpDeadline,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
} from "./timeout.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/** 插件状态通知的 logger 前缀：notifications/message 的 logger 以此开头才被识别。 */
const PLUGIN_STATE_LOGGER_PREFIX = "acode-plugin-state:";
/**
 * 快启门预算（specs/mcp-startup-gate-breaker.md R1）：connectConfiguredServers 等
 * 全部连接任务收敛至多等这么久；到期后已就绪的照常注册，仍 pending 的 server 用
 * 磁盘缓存的上次工具清单先注册 Deferred 工具（无缓存则不注册），后台完成握手后
 * 原子替换为真实工具。0 = 关门等全部收敛（退化为既有语义）。
 */
export const DEFAULT_MCP_STARTUP_GATE_BUDGET_MS = 250;
/**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 连接状态跃迁监听（specs/mcp-lifecycle-ttl-approval.md R2）。desktop 设置页 /
   * TUI 侧栏等上层经此被动感知断开、失败与重连挂起；监听器故障不影响连接生命周期。
   */
  onStatusChange?: McpServerStatusChangeListener;
  /**
   * 自动重连预算（specs/mcp-lifecycle-ttl-approval.md R1）：双计数器（连续连接
   * 失败 / 连续中途崩溃）熔断与最小重试间隔。缺省 crashBudget=3、
   * minRetryIntervalMs=30s。只门禁自动（懒）重连，显式连接永远放行并复位预算。
   */
  reconnect?: {
    crashBudget?: number;
    minRetryIntervalMs?: number;
  };
  /**
   * 协议协商记忆（specs/mcp-protocol-negotiation-increments.md R1）：慢连接 server
   * 的 legacy 裁决持久记忆，7 天新鲜窗内 auto 协商跳过 server/discover probe。
   * 缺省创建文件存储（`<数据基目录>/.acode/cli/mcp/protocol-memory.json`，
   * fail-open）；测试可注入内存实现或临时文件路径。
   */
  negotiationMemory?: McpNegotiationMemory;
  /**
   * 快启门（specs/mcp-startup-gate-breaker.md R1）：connectConfiguredServers 的
   * 整批连接预算门。budgetMs 缺省 250、0 = 等全部收敛；sleep 是门等待注入点
   * （测试用假时钟获得确定性时序，缺省真定时器且 unref）。
   */
  startupGate?: {
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  /**
   * 静默探测阶梯（specs/mcp-startup-gate-breaker.md R3）：曾连接成功的 http/sse
   * server 失联后的后台静默探测节奏（15s 起步指数退避至 5min）。缺省创建；测试
   * 注入 baseDelayMs/arm 获得确定性时序。stdio 不适用（按需拉起）。
   */
  probeLadder?: McpProbeLadderOptions;
  /**
   * 工具磁盘缓存（specs/mcp-startup-gate-breaker.md R1）：Deferred 注册的数据源。
   * 缺省创建文件存储（`<数据基目录>/.acode/cli/mcp/tool-cache.json`，fail-open）；
   * 测试注入临时文件路径实例。
   */
  toolCache?: McpToolCache;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 ACode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveACodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveACodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  /** 插件状态通知回调（acode-plugin-state: logging 通知 → 宿主事件桥）。 */
  onPluginStateNotification?: (notification: McpPluginStateNotification) => void;
  workingDirectory?: string;
}

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ACode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  transport?: McpTransport;
  /**
   * 该 server 是否曾以 connected 状态完成过连接（specs/mcp-startup-gate-breaker.md
   * R3 静默探测阶梯的适用判据：只对「曾经连上又失联」的 http/sse server 武装探测）。
   * 重连时随新 record 传递，显式断开与 adapter close 一并终结。
   */
  sawConnected?: boolean;
  /**
   * 当前连接建立以来是否发生过一次完整成功的工具调用（specs/mcp-startup-gate-breaker.md
   * R2 风暴熔断的判据：风暴 = 「连上就死、毫无产出」的 fork 循环；断连之间夹着
   * 完整成功调用的 server 是 R1 认定的半可用形态，必须继续服务、不得熔断）。
   */
  workedSinceConnect?: boolean;
}

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory, onPluginStateNotification }) =>
      createMcpAdapter({
        ...options,
        onPluginStateNotification,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";
// 自动重连预算（specs/mcp-lifecycle-ttl-approval.md R1）：预算类与 singleflight
// 工具对外导出，供装配层调参与测试直连；判定门禁在 adapter 内部，不单独暴露。
export {
  createSingleflightRunner,
  DEFAULT_MCP_RECONNECT_CRASH_BUDGET,
  DEFAULT_MCP_RECONNECT_MIN_RETRY_INTERVAL_MS,
  McpReconnectBudget,
  type McpReconnectBudgetOptions,
  type McpReconnectGateVerdict,
  type McpReconnectSuspensionState,
} from "./reconnect-budget.js";
// 崩溃风暴熔断（specs/mcp-startup-gate-breaker.md R2）、静默探测阶梯（R3）、工具
// 磁盘缓存与配置展开（R1/R4）：类与常量对外导出供装配层调参与测试直连；门禁与
// 状态所有者都在 adapter 内部。
export {
  MCP_CRASH_STORM_LIMIT,
  MCP_CRASH_STORM_WINDOW_MS,
  McpCrashStormBreaker,
  type McpCrashStormBreakerOptions,
  type McpCrashStormTrip,
} from "./crash-storm-breaker.js";
export {
  MCP_PROBE_BASE_DELAY_MS,
  MCP_PROBE_MAX_DELAY_MS,
  McpProbeLadder,
  type McpProbeLadderOptions,
} from "./probe-ladder.js";
export {
  createMcpToolCache,
  defaultToolCachePath,
  mcpToolCacheConfigFingerprint,
  MCP_TOOL_CACHE_MAX_FILE_BYTES,
  MCP_TOOL_CACHE_TTL_MS,
  type CreateMcpToolCacheOptions,
  type McpToolCache,
} from "./mcp-tool-cache.js";
export { expandMcpEnvDeep, type ExpandMcpEnvOptions } from "./expand-env.js";
export {
  deduplicateMcpToolDescriptors,
  type McpToolNameCollision,
} from "./descriptor.js";

class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly pluginStateNotificationSink?: (notification: McpPluginStateNotification) => void;
  private readonly telemetry?: McpTelemetryTracker;
  private readonly onStatusChange?: McpServerStatusChangeListener;
  /** 工具面变更订阅者（onToolsChanged，McpPort 可选面）；派发点 try/catch 旁路。 */
  private readonly toolsChangedListeners = new Set<() => void>();
  /** 自动重连预算（R1）：连续失败熔断 + 最小重试间隔；显式连接复位。 */
  private readonly reconnectBudget: McpReconnectBudget;
  /**
   * 协议协商记忆（specs/mcp-protocol-negotiation-increments.md R1）：慢连接 server
   * 的 legacy 裁决，7 天新鲜窗内 auto 协商跳过 probe。fail-open：记忆面任何故障
   * 都退化为「没有记忆、照常探测」。
   */
  private readonly negotiationMemory: McpNegotiationMemory;
  /**
   * 崩溃风暴熔断（specs/mcp-startup-gate-breaker.md R2）：30s 滑动窗口内 >5 次意外
   * 断开即停掉该 server 的一切自动恢复，等显式操作复位。与 R1 预算边界见 spec 表格。
   */
  private readonly crashStorm: McpCrashStormBreaker;
  /**
   * 静默探测阶梯（specs/mcp-startup-gate-breaker.md R3）：曾连接成功的 http/sse
   * server 失联后的后台自愈节奏。所有者为本实例；stdio 永不武装。
   */
  private readonly probeLadder: McpProbeLadder;
  /**
   * 工具磁盘缓存（specs/mcp-startup-gate-breaker.md R1）：快启门 Deferred 注册的
   * 数据源；tools/list 成功即 best-effort 覆写（schema 变更以新握手为准）。
   */
  private readonly toolCache: McpToolCache;
  private readonly startupGateBudgetMs: number;
  private readonly startupGateSleep: (ms: number) => Promise<void>;
  /**
   * HTTP 403 快速失败标记（negotiation-increments spec R2）：403 = 身份被认出但
   * 访问被拒，重连不可能改变结果。标记的 server 不再进懒重连循环（不 spawn、
   * 不消耗预算），callTool 直接抛带解释的快速失败错误；显式连接清除标记。
   */
  private readonly permanentAccessDenied = new Set<string>();
  /** 同一 server 的并发自动重连共享一个 in-flight promise（R1 singleflight）。 */
  private readonly autoReconnectSingleflight = createSingleflightRunner<string, McpServerStatus>();
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedACodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  private readonly workingDirectory?: string;

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "acode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.pluginStateNotificationSink = options.onPluginStateNotification;
    this.telemetry = options.telemetry;
    this.onStatusChange = options.onStatusChange;
    this.reconnectBudget = new McpReconnectBudget({ ...options.reconnect });
    this.negotiationMemory =
      options.negotiationMemory ??
      createMcpNegotiationMemory({ env: options.env, logger: this.logger });
    this.crashStorm = new McpCrashStormBreaker();
    this.probeLadder = new McpProbeLadder(options.probeLadder);
    this.toolCache = options.toolCache ?? createMcpToolCache({ env: options.env, logger: this.logger });
    this.startupGateBudgetMs = Math.max(
      0,
      Math.floor(options.startupGate?.budgetMs ?? DEFAULT_MCP_STARTUP_GATE_BUDGET_MS),
    );
    this.startupGateSleep = options.startupGate?.sleep ?? defaultStartupGateSleep;
    this.workingDirectory = options.workingDirectory;
  }

  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    await Promise.all(
      Array.from(this.records.keys())
        .filter((name) => !configuredNames.has(name))
        .map((name) => this.disconnectServer(name)),
    );

    // 环境展开在本入口先做一次（specs/mcp-startup-gate-breaker.md R4）：共享连接
    // 去重比较与连接共用展开后配置，双方基准一致才不会误判「配置变更」。展开幂等，
    // connectServer 内部的再次展开是恒等操作。
    const connectTasks = Object.entries(servers).map(([name, rawConfig]) => {
      const config = expandMcpEnvDeep(rawConfig, { env: this.env ?? process.env });
      const record = this.records.get(name);
      if (
        record?.connecting &&
        record.status.status === "connecting" &&
        record.status.authorization &&
        isDeepStrictEqual(record.config, config)
      ) {
        // 相同配置的全量收敛可能与 OAuth callback 等待重叠；重新 connect
        // 会关闭原 session，使浏览器中已打开的授权 URL、PKCE/state 和 callback 一并失效。
        // 连接生命周期可以共享，但 Session 的 15 秒等待预算和 AbortSignal 不能继承设置页的 5 分钟预算。
        return trackConnectTask(name, config, this.waitForSharedConnection(name, record, options));
      }
      return trackConnectTask(name, config, this.connectServer(name, config, options));
    });

    // 快启门（specs/mcp-startup-gate-breaker.md R1）：整批连接只等 budgetMs；
    // 到期后已 settle 的走既有语义，仍 pending 的连接任务**留在后台**（绝不取消），
    // 由 materializeDeferredTools 决定是否用磁盘缓存先注册 Deferred 工具。
    if (this.startupGateBudgetMs > 0) {
      await Promise.race([
        Promise.allSettled(connectTasks.map((task) => task.promise)),
        this.startupGateSleep(this.startupGateBudgetMs),
      ]);
    } else {
      await Promise.allSettled(connectTasks.map((task) => task.promise));
    }
    await this.materializeDeferredTools(connectTasks);

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    // 显式连接（设置页刷新、session 启动、配置变更下发的全量收敛）：先复位自动重连
    // 预算——挂起/冷却只拦自动路径，用户必须永远保有恢复手段（spec R1）。
    return await this.connectServerInternal(name, config, options, { auto: false });
  }

  private async connectServerInternal(
    name: string,
    rawConfig: McpServerConfig,
    options: McpConnectOptions = {},
    invocation: { auto: boolean },
  ): Promise<McpServerStatus> {
    // 环境展开在本边界做一次（specs/mcp-startup-gate-breaker.md R4）：transport、
    // 缓存指纹与状态投影全部看到展开后配置。展开幂等，重连路径传入的已展开配置
    // 原样通过；未设置的 `${VAR}` 保持字面（不吞占位符，配置错误可见）。
    const config = expandMcpEnvDeep(rawConfig, { env: this.env ?? process.env });
    const startedAt = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const generation = this.nextConnectionGeneration(name);
    if (!invocation.auto) {
      this.reconnectBudget.reset(name);
      // 风暴熔断只由显式操作复位（specs/mcp-startup-gate-breaker.md R2）：用户
      // 修好 server 后从设置页重连，必须能重新获得自动恢复。
      this.crashStorm.reset(name);
      // 403 快速失败标记只由显式操作清除（negotiation-increments spec R2）：用户
      // 修好凭据/权限后从设置页重连，必须能重新尝试。
      this.permanentAccessDenied.delete(name);
    }
    this.lastOfficialAuthKind.delete(name);
    this.connectionDiagnosticByServer.delete(name);
    this.logger?.info("MCP server connection started", {
      event: "mcp.server.connect.started",
      mcpServerName: name,
      status: "started",
      timeoutMs,
      transport: config.type,
    });
    const previousStatusKind = this.records.get(name)?.status.status;
    await this.closeRecord(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.emitStatusChange(name, previousStatusKind, status, "disabled");
      this.logger?.info("MCP server connection skipped", {
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connect.skipped",
        mcpServerName: name,
        status: "completed",
        transport: config.type,
      });
      return status;
    }

    const abortController = new AbortController();
    const abortExternal = () => {
      abortController.abort(
        options.signal?.reason instanceof Error ? options.signal.reason : undefined,
      );
    };
    if (options.signal?.aborted) {
      abortExternal();
    } else {
      options.signal?.addEventListener("abort", abortExternal, { once: true });
    }

    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: connectingStatus,
      tools: [],
      // sawConnected 随重连传递（specs/mcp-startup-gate-breaker.md R3）：重连失败
      // 的 http/sse server 仍要武装静默探测——它曾经连上过。
      sawConnected: this.records.get(name)?.sawConnected === true,
    };
    this.records.set(name, record);
    this.emitStatusChange(name, previousStatusKind, connectingStatus, "connect-started");
    const connecting = this.openServerConnection({
      config,
      generation,
      name,
      oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
      signal: abortController.signal,
      timeoutMs,
      workingDirectory: options.workingDirectory,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abortExternal);
    });
    record.connecting = connecting;
    // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
    // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
    // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
    // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
    return await this.waitForSharedConnection(name, record, options);
  }

  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    const previousStatusKind = record.status.status;
    this.nextConnectionGeneration(name);
    await this.closeRecord(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    // 显式断开也清预算：下次显式/自动连接从干净计数开始（挂起状态不跨显式操作存活）。
    this.reconnectBudget.reset(name);
    // 显式断开终结一切自动恢复面（specs/mcp-startup-gate-breaker.md R2/R3）：
    // 风暴窗口复位、静默探测阶梯拆除——用户主动下线的 server 不该被后台拉活。
    this.crashStorm.reset(name);
    this.probeLadder.stop(name);
    this.emitStatusChange(name, previousStatusKind, status, "disconnected");
    return status;
  }

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  // HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
  // connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
  // ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
      if (isPeerAnsweredError(error)) {
        return true;
      }
      if (!this.isCurrentConnection(name, generation)) return false;
      const current = this.records.get(name);
      if (current && current.client === record.client) {
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server did not answer ping",
          failureKind: "unexpected_disconnect",
        });
        this.emitStatusChange(name, "connected", current.status, "disconnected");
        // ping 判死 = 已建立连接的丢失（specs/mcp-startup-gate-breaker.md R3）：
        // 曾连接成功的远程 server 武装静默探测，等待期自愈。
        this.noteRemoteServerLost(name);
      }
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  /**
   * 资源清单（specs/mcp-sampling-resources.md）。未连接/旧 server 无 resources 能力时
   * 返回空表而不是抛错——拉取面是尽力而为，工具侧把空表如实呈现给模型。
   * 200 条裁剪在 adapter 侧执行（线上上限，见 spec）。
   */
  async listResources(
    name: string,
    options: { timeoutMs?: number } = {},
  ): Promise<McpResourceDescriptor[]> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return [];
    const timeoutMs = Math.min(
      options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    try {
      const listed = await record.client.listResources({}, { timeout: timeoutMs });
      const resources = Array.isArray(listed.resources) ? listed.resources : [];
      return resources.slice(0, 200).map((resource) => ({
        uri: String(resource.uri ?? ""),
        ...(resource.name === undefined ? {} : { name: String(resource.name) }),
        ...(resource.mimeType === undefined ? {} : { mimeType: String(resource.mimeType) }),
        ...(resource.description === undefined
          ? {}
          : { description: String(resource.description) }),
      })).filter((resource) => resource.uri.length > 0);
    } catch (error) {
      this.logger?.warn("MCP listResources failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.resources.list.failed",
        mcpServerName: name,
      });
      return [];
    }
  }

  /**
   * 读一个资源。返回 undefined = server 未实现 / uri 不存在 / 未连接——调用方
   * （core 的 read_resource 工具）把它归一成结构化的 not found，不猜原因。
   * 单次 ≤ 512 KiB：超限截断并如实标注（spec 的分段策略由 server 侧资源设计承担）。
   */
  async readResource(
    name: string,
    uri: string,
    options: { timeoutMs?: number } = {},
  ): Promise<McpReadResourceResult | undefined> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return undefined;
    const timeoutMs = Math.min(
      options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    try {
      const result = await record.client.readResource({ uri }, { timeout: timeoutMs });
      const contents = Array.isArray(result.contents) ? result.contents : [];
      const content = contents[0];
      if (!content) return undefined;
      // SDK 的 contents 是 text | blob 判别联合：用 in 收窄，不猜字段。
      const text = "text" in content && typeof content.text === "string" ? content.text : undefined;
      const base64 = "blob" in content && typeof content.blob === "string" ? content.blob : undefined;
      const MAX_READ_BYTES = 512 * 1024;
      return {
        uri: typeof content.uri === "string" && content.uri.length > 0 ? content.uri : uri,
        ...(content.mimeType === undefined ? {} : { mimeType: String(content.mimeType) }),
        ...(text === undefined
          ? {}
          : { text: text.length > MAX_READ_BYTES ? `${text.slice(0, MAX_READ_BYTES)}\n…[truncated]` : text }),
        ...(base64 === undefined ? {} : { base64 }),
      };
    } catch (error) {
      this.logger?.warn("MCP readResource failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.resources.read.failed",
        mcpServerName: name,
      });
      return undefined;
    }
  }

  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const initialRecord = this.records.get(request.serverName);
    const timeoutMs =
      options.timeoutMs ?? initialRecord?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    const pending = initialRecord?.connecting;
    if (pending) {
      // connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
      // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
      // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
      await waitWithinMcpDeadline(pending, deadline, timeoutMessage, options.signal);
    }

    // stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
    // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
    // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
    // 但工具本身恢复可用。自动重连受预算门禁（specs/mcp-lifecycle-ttl-approval.md R1）：
    // 挂起/冷却期内直接拒绝并抛出带模型指引的错误，不再 spawn。
    const stale = this.records.get(request.serverName);
    // 403 快速失败门（negotiation-increments spec R2）：已确认的永久拒绝不进懒重连
    // 循环——不 spawn/握手、不消耗重连预算，直接向模型解释「重试不会改变结果」。
    // 标记只由显式操作（设置页重连 / session 启动收敛）或一次连接成功清除。
    if (this.permanentAccessDenied.has(request.serverName)) {
      throw buildMcpAccessDeniedError(request.serverName);
    }
    if (stale && isAutoReconnectableStatus(stale.status)) {
      this.assertAutoReconnectAllowed(request.serverName);
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, stale.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    const record = this.records.get(request.serverName);
    if (!record?.client || record.status.status !== "connected") {
      // 失败文案即模型的下一步（spec R2.1）：裸的 "not connected" 会诱导模型循环重试，
      // 这里显式给出「不要循环重试」指引与应采取的动作。
      throw new Error(buildMcpNotConnectedMessage(request.serverName, record?.status));
    }

    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    } catch (error) {
      // 连接建立后 token 过期、被撤销或 scope 不足时，
      // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
      // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await this.recoverToolCallAuthorization({
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
      // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      // 预算门禁在发起重连**之前**拒绝：挂起/冷却时把带指引的错误直接抛给模型，
      // 而不是让它落进下面的 catch 再抛一次裸 "Not connected"（spec R1/R2.1）。
      this.assertAutoReconnectAllowed(request.serverName);
      try {
        await waitWithinMcpDeadline(
          this.reconnectForCall(request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        // 裸 "Not connected" 对模型没有信息量：换成带当前状态（含挂起事实）与
        // 「不要循环重试」指引的文案，原错误进 cause 链（spec R2.1）。
        throw new Error(
          buildMcpNotConnectedMessage(
            request.serverName,
            this.records.get(request.serverName)?.status,
          ),
          { cause: error },
        );
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") {
        throw new Error(buildMcpNotConnectedMessage(request.serverName, revived?.status), {
          cause: error,
        });
      }
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
      );
    }
  }

  /** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */
  private rememberServerResponse(
    serverName: string,
    response: OfficialMcpServerResponseInfo,
  ): void {
    if (
      !response.spanId &&
      response.rpcMethod !== "tools/call" &&
      this.records.get(serverName)?.status.status === "connecting"
    ) {
      if (response.failureKind) {
        this.connectionDiagnosticByServer.set(serverName, {
          failureKind: response.failureKind,
          ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
        });
      }
      return;
    }
    if (!response.spanId) return;
    if (!response.serverRequestId) return;
    // 401 重试会对同一 span 产生两条响应，后写覆盖——留下的是最终那次，正是要报的那个。
    this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
    while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
      const oldest = this.serverRequestIdBySpan.keys().next();
      if (oldest.done) break;
      this.serverRequestIdBySpan.delete(oldest.value);
    }
  }

  /** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */
  private takeServerRequestId(spanId: string | undefined): string | undefined {
    if (!spanId) return undefined;
    const requestId = this.serverRequestIdBySpan.get(spanId);
    if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
    return requestId;
  }

  /**
   * 解析 stdio 官方 MCP 本次出站协议消息的身份头。
   * 返回 undefined 表示"不是官方 stdio server"——此时 `_meta` 里绝不能出现该键，否则等于把
   * 身份头广播给任意第三方插件。
   */
  private async resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined> {
    if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    const resolveACodeApiOrigin = this.officialMcpAuth?.resolveACodeApiOrigin;
    const logBase = {
      event: "mcp.official_auth.stdio_meta",
      mcpKey: official.mcpKey,
      mcpServerName: serverName,
      module: "adapters.mcp",
    };
    const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
      // 刻意不写 lastOfficialAuthKind：那个 map 只被 failConnection 读取，用来给**连接失败**
      // 打分类标签。stdio 的身份头缺失不会让连接失败，写进去会一直留着，等到该 server 之后
      // 因为别的原因（子进程死掉等）真正断连时被当成断连原因记进日志，属误导。
      // 本路径的可观测性由下面这条自己的 event + 下发给插件的 reason 承担。
      this.logger?.warn("Official MCP stdio auth headers unavailable", {
        ...logBase,
        reason,
        status: "failed",
      });
      return { ok: false, reason };
    };

    // standalone CLI 没有 host auth port。不静默省略该键：插件区分不了"宿主不支持"与
    // "宿主支持但我没登录"，只有显式 reason 才能给出正确的用户提示。
    if (!authHeadersPort || !trustedOrigins || !resolveACodeApiOrigin) {
      return fail("official_auth_unavailable");
    }

    // stdio 没有 url，origin 由宿主给出而非插件声明。isTrusted 在此退化为恒真断言，但仍要调用：
    // 它同时校验 https、拒绝带 username/password 的 URL，并让 dev loopback 开关继续生效。
    //
    // 这两步原来裸调用。origin 解析依赖 settings / 运行时环境，isTrusted 是
    // 注入的实现，两者都可能抛。异常裸冒泡会绕过整个失败分类：插件收不到 `{ok:false, reason}`，
    // 而 reason 是跨 adapter / host / UI 的契约（决定提示文案与是否重试）。因此统一映射为
    // official_auth_unavailable——宿主侧解析不出可信 origin，对插件而言就是"官方鉴权不可用"。
    // 错误文本只进日志，绝不参与流程判断。
    let targetOrigin: string;
    let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
    try {
      targetOrigin = resolveACodeApiOrigin();
      trust = await trustedOrigins.isTrusted({
        mcpKey: official.mcpKey,
        origin: targetOrigin,
        pluginId: official.pluginId,
      });
    } catch (error) {
      this.logger?.warn("Official MCP stdio origin resolution failed", {
        ...logBase,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        pluginId: official.pluginId,
      });
      return fail("official_auth_unavailable");
    }
    if (!trust.trusted) {
      this.logger?.warn("Official MCP stdio origin is not trusted", {
        ...logBase,
        detail: trust.detail ?? "unknown",
        pluginId: official.pluginId,
        targetOrigin,
      });
      return fail("official_mcp_origin_untrusted");
    }

    const resolved = await authHeadersPort.resolveHeaders({
      mcpKey: official.mcpKey,
      pluginId: official.pluginId,
      targetOrigin,
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) return fail(resolved.reason);

    // 只记 header 名与套餐维度，绝不记 header 值——日志留存周期不受控。
    this.logger?.debug("Official MCP stdio auth headers attached", {
      ...logBase,
      identityHeaderNames: Object.keys(resolved.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ...(resolved.headers["Bigmodel-Target-Type"]
        ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
        : {}),
      status: "completed",
    });
    return { ok: true, headers: resolved.headers };
  }

  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<McpToolCallResult> {
    // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
    // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
    const logBase = {
      event: "mcp.tool.call",
      mcpServerName: request.serverName,
      mcpToolName: request.toolName,
      module: "adapters.mcp",
      timeoutMs,
    };
    const argumentKeys = Object.keys(request.arguments ?? {}).sort();
    this.logger?.debug("MCP tool call started", {
      ...logBase,
      argumentKeys,
      status: "started",
    });

    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          ...((request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath)
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
        },
      );

      const durationMs = Date.now() - startedAt;
      const isError = typeof result.isError === "boolean" ? result.isError : false;
      if (!isError) {
        // 中途崩溃计数的复位点（spec R1）：一次工具调用完整成功。连接成功不复位该
        // 计数；in-band isError 也不复位——「崩溃 / 业务报错」交替同样构成 spawn 风暴。
        this.reconnectBudget.recordToolCallSuccess(request.serverName);
        // 风暴窗口的复位点（specs/mcp-startup-gate-breaker.md R2）：完整成功调用 =
        // server 在干活的证据，清空断连窗口（与 R1 半可用契约同点同理）。仅在结果
        // 归属当前连接时记账，防迟到结果污染新连接的窗口。
        const workedRecord = this.records.get(request.serverName);
        if (workedRecord && workedRecord.client === client) {
          workedRecord.workedSinceConnect = true;
          this.crashStorm.reset(request.serverName);
        }
      }
      // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
      // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      const outcome = {
        ...logBase,
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        durationMs,
        hasStructuredContent: result.structuredContent !== undefined,
        // 业务级失败（isError）与传输级失败不同，必须能分开统计。
        isError,
        ...(serverRequestId ? { serverRequestId } : {}),
      };
      if (isError) {
        // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
        // 这类失败在生产日志里完全不可见。
        this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
      } else {
        this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
      }

      const meta = isRecord(result._meta) ? result._meta : undefined;
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
        // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
        _meta:
          isError && serverRequestId
            ? { ...meta, [ACODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
            : meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
      // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
      const timedOut =
        /timed?\s*out|timeout/i.test(message) ||
        (error instanceof Error && error.name === "AbortError");
      // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      this.logger?.warn("MCP tool call failed", {
        ...logBase,
        argumentKeys,
        durationMs,
        error: message,
        ...(serverRequestId ? { serverRequestId } : {}),
        errorName: error instanceof Error ? error.name : "unknown",
        status: "failed",
        timedOut,
        // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
        ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
      });
      // 中途崩溃计数（spec R1 第二计数器）：callTool 执行中途 transport 断开。
      // 达到阈值即挂起：状态附加 reconnectSuspension（含 suspendedBy 来源维度）、
      // 派发 reconnect-suspended 事件，并把裸断连错误换成 R2.1 模型指引文案
      // （原错误进 cause 链）；未达阈值时原错误照常冒泡，"Not connected" 仍走
      // callTool 的既有一次重试竞态路径。注意：显式关闭（disconnectServer /
      // connectServer 关旧 record）也会让在飞调用收到 CONNECTION_CLOSED 而多计
      // 一次；显式操作本身先复位预算，残余计数不足以单独触发挂起。
      if (isMidCallTransportDisconnect(error)) {
        const outcome = this.reconnectBudget.recordInCallCrash(request.serverName);
        if (outcome.suspended) {
          this.applyInCallCrashSuspension(request.serverName, outcome.consecutiveInCallCrashes);
          const verdict = this.reconnectBudget.check(request.serverName);
          if (!verdict.allowed && verdict.reason === "suspended") {
            throw buildMcpReconnectRefusalError(request.serverName, verdict, error);
          }
        }
        // 防双跑（negotiation-increments spec R4）：CONNECTION_CLOSED = 请求已写上
        // 线、响应没有回来——server 可能已执行、仍在执行或根本没收到。裸
        // "Connection closed" 会诱导模型原样重发（副作用工具 = 双跑）；换成
        // outcome-unknown 指引，原错误保留在 cause 链。NOT_CONNECTED（发起时已断，
        // 请求未上线）不包装：callTool 对该消息的「安全一次重试」语义依赖未发送
        // 事实，包装会破坏它。
        if (isConnectionClosedMidCall(error)) {
          throw buildMcpOutcomeUnknownError(request.serverName, request.toolName, error);
        }
      }
      throw error;
    }
  }

  private reconnectForCall(name: string, config: McpServerConfig): Promise<McpServerStatus> {
    // singleflight（spec R1）：并发工具调用共享同一次自动重连，不重复 spawn/握手；
    // 失败结果原样共享给所有等待者——去重的是执行，不是错误。
    return this.autoReconnectSingleflight(name, async () => {
      this.reconnectBudget.beginAttempt(name);
      this.logger?.warn("MCP server reconnecting after lost connection", {
        event: "mcp.server.reconnect.started",
        mcpServerName: name,
        status: "started",
        transport: config.type,
      });
      return await this.connectServerInternal(name, config, {}, { auto: true });
    });
  }

  /**
   * 自动重连门禁：风暴熔断（specs/mcp-startup-gate-breaker.md R2）先于 R1 预算
   * （specs/mcp-lifecycle-ttl-approval.md R1）判定——broken 即全停，恢复只能显式；
   * 挂起（预算耗尽）或冷却期（< 最小重试间隔）内拒绝发起，抛出带模型指引的错误。
   * 显式连接不经过本门禁。
   */
  private assertAutoReconnectAllowed(serverName: string): void {
    if (this.crashStorm.isTripped(serverName)) {
      throw buildMcpCrashStormRefusalError(serverName, {
        windowCount: this.crashStorm.windowCount(serverName),
        windowMs: this.crashStorm.windowSizeMs,
      });
    }
    const verdict = this.reconnectBudget.check(serverName);
    if (verdict.allowed) return;
    throw buildMcpReconnectRefusalError(serverName, verdict);
  }

  /**
   * 快启门的 Deferred 物化（specs/mcp-startup-gate-breaker.md R1）：门到期仍
   * pending 的 server，缓存命中（指纹一致）就把缓存 descriptor 注册进 in-flight
   * record——模型面立即可见 schema，状态保持 connecting；缓存未命中则不注册，
   * 连接任务留后台完成后经 records.set 原子替换为真实工具。
   */
  private async materializeDeferredTools(
    tasks: readonly TrackedConnectTask[],
  ): Promise<void> {
    const pending = tasks.filter((task) => task.status === "pending");
    if (pending.length === 0) return;
    const materialized: Array<{ serverName: string; toolCount: number }> = [];
    await Promise.all(
      pending.map(async (task) => {
        let cached: McpToolDescriptor[] | null = null;
        try {
          cached = await this.toolCache.get(task.name, task.config);
        } catch {
          cached = null;
        }
        if (!cached || cached.length === 0) return;
        // 双重检查：缓存读取期间连接可能已收敛（成功/失败都会整体替换 record），
        // 只有仍在 connecting 的 record 才注入。
        const record = this.records.get(task.name);
        if (!record || record.status.status !== "connecting") return;
        // 缓存内容重新过注册边界（长度剔除 + 确定性碰撞去重），不信任缓存绕过检查。
        const withinLimit = cached.filter((tool) => !exceedsMcpToolNameLimit(tool));
        const { tools } = deduplicateMcpToolDescriptors(withinLimit);
        if (tools.length === 0) return;
        record.tools = tools;
        materialized.push({ serverName: task.name, toolCount: tools.length });
      }),
    );
    if (materialized.length > 0) {
      this.logger?.info("MCP deferred tools registered from disk cache", {
        ...this.connectionContext,
        deferredServers: materialized,
        event: "mcp.startup.deferred_tools",
        status: "completed",
      });
    }
  }

  /**
   * 曾连接成功的远程 server 失联后的静默探测武装（specs/mcp-startup-gate-breaker.md
   * R3）。stdio 不武装（进程死了等不来，定时重拉正是风暴熔断要停掉的风暴）；已
   * 武装时幂等 no-op（单一定时器所有者）。
   */
  private noteRemoteServerLost(name: string): void {
    const record = this.records.get(name);
    if (!record?.sawConnected) return;
    if (record.config.type !== "http" && record.config.type !== "sse") return;
    this.probeLadder.arm(name, (probeName) => {
      void this.runQuietProbe(probeName);
    });
  }

  /**
   * 一次静默探测 = 一次完整连接尝试（specs/mcp-startup-gate-breaker.md R3）。
   * 风暴熔断即停（拆除阶梯，恢复交显式操作）；有在飞连接时让位（由其结果决定
   * re-arm / stop，绝不并发重连）。探测失败由 failConnection 统一记账（预算计数
   * + 事件）并按已倍增的延迟重新武装；本方法吞掉异常，探测循环绝无 unhandled
   * rejection。
   */
  private async runQuietProbe(name: string): Promise<void> {
    if (this.crashStorm.isTripped(name)) {
      this.probeLadder.stop(name);
      return;
    }
    const record = this.records.get(name);
    if (!record) {
      this.probeLadder.stop(name);
      return;
    }
    if (record.connecting) return;
    if (
      !record.sawConnected ||
      (record.config.type !== "http" && record.config.type !== "sse")
    ) {
      this.probeLadder.stop(name);
      return;
    }
    if (record.status.status === "connected" || record.status.status === "disabled") {
      this.probeLadder.stop(name);
      return;
    }
    const config = record.config;
    this.logger?.debug("MCP quiet probe starting", {
      ...this.connectionContext,
      event: "mcp.server.probe.started",
      mcpServerName: name,
      status: "started",
      transport: config.type,
    });
    try {
      await this.connectServerInternal(name, config, {}, { auto: true });
      // 成功路径：openServerConnection 已拆除阶梯、预算 recordSuccess。
    } catch {
      // failConnection 已处理失败面（状态 + re-arm）；探测循环自身不再上抛。
    }
  }

  /**
   * 风暴熔断的状态面（specs/mcp-startup-gate-breaker.md R2）：状态附加挂起事实
   * + warn 日志 + reconnect-suspended 事件；陈旧工具保留在注册面（omp 同形态：
   * 「leaves tools registered」），调用报错并给显式恢复指引。
   *
   * wire fail-safe 说明：contracts 的 `McpReconnectSuspension.suspendedBy` 闭集
   * 尚无 `crash_storm` 字面（共享桶申请中），这里先不带维度标签——消费者按契约
   * 注释「缺失按 connect_failures 理解」处理；精确的风暴事实由本 warn 事件、
   * error 文本与模型指引文案承载。
   */
  private applyCrashStormSuspension(name: string, trip: McpCrashStormTrip): void {
    const record = this.records.get(name);
    this.probeLadder.stop(name);
    this.logger?.warn("MCP server crash-storm breaker tripped; automatic recovery suspended", {
      ...this.connectionContext,
      event: "mcp.server.crash_storm.suspended",
      mcpServerName: name,
      status: "failed",
      ...(record ? { transport: record.config.type } : {}),
      windowCount: trip.windowCount,
      windowMs: trip.windowMs,
    });
    if (!record) return;
    const previousStatusKind = record.status.status;
    record.status = this.createStatus(record.config, "disconnected", {
      error: `MCP server disconnected ${trip.windowCount} times within ${Math.round(trip.windowMs / 1000)}s; automatic reconnection suspended (crash-storm breaker). Fix the server and reconnect explicitly to resume automatic recovery.`,
      failureKind: "unexpected_disconnect",
      toolCount: record.tools.length,
    });
    record.status.reconnectSuspension = {
      consecutiveFailures: trip.windowCount,
      // crash_storm 维度标签（contracts suspendedBy 联合已扩）：windowCount 是
      // 30s 窗口内无产出断连数，不是 connect_failures 的连续失败计数。
      suspendedBy: "crash_storm",
      suspendedAt: new Date().toISOString(),
    };
    this.emitStatusChange(name, previousStatusKind, record.status, "reconnect-suspended");
  }

  /**
   * 中途崩溃达到阈值时的挂起状态面（spec R1/R2）：与 connect_failures 挂起同一
   * reconnectSuspension 附加字段、同一 reconnect-suspended 事件、同一 warn 日志
   * 事件名（以 suspendedBy 维度区分）。SDK 的 _onclose 先同步派发 client.onclose
   * 再拒绝挂起请求，因此正常时序下 record 已被 onclose 标为 disconnected，这里
   * 只把挂起事实附加到当前状态（预算是挂起的唯一读源）。
   */
  private applyInCallCrashSuspension(serverName: string, consecutiveInCallCrashes: number): void {
    const record = this.records.get(serverName);
    this.logger?.warn("MCP server automatic reconnection suspended", {
      ...this.connectionContext,
      consecutiveInCallCrashes,
      event: "mcp.server.reconnect.suspended",
      mcpServerName: serverName,
      status: "failed",
      suspendedBy: "in_call_crashes",
      ...(record ? { transport: record.config.type } : {}),
    });
    const suspension = this.reconnectBudget.suspension(serverName);
    if (!suspension || !record || record.status.reconnectSuspension !== undefined) return;
    const previousStatusKind = record.status.status;
    record.status = { ...record.status, reconnectSuspension: suspension };
    this.emitStatusChange(serverName, previousStatusKind, record.status, "reconnect-suspended");
  }

  /**
   * 状态跃迁事件派发（spec R2）。监听器故障不得反向影响连接生命周期——
   * 与遥测旁路同一哲学，try/catch 吞掉。
   */
  private emitStatusChange(
    name: string,
    previousStatus: McpServerStatusKind | undefined,
    status: McpServerStatus,
    trigger: McpServerStatusChangeTrigger,
  ): void {
    if (!this.onStatusChange) return;
    try {
      const change: McpServerStatusChange = {
        serverName: name,
        ...(previousStatus ? { previousStatus } : {}),
        status,
        trigger,
        ...(this.connectionContext
          ? { connectionId: this.connectionContext.mcpConnectionId }
          : {}),
        at: new Date().toISOString(),
      };
      this.onStatusChange(change);
    } catch {
      // 旁路故障静默：状态事件消费方（UI）异常不能拆连接。
    }
  }

  /**
   * 工具面变更订阅（specs/mcp-startup-gate-breaker.md R1 收尾接线，McpPort.
   * onToolsChanged）：后台连接完成、Deferred/空工具记录被真实工具原子替换后
   * 触发（无载荷——消费方重查 listTools()）。与 emitStatusChange 同一哲学：
   * 监听器故障不得反向影响连接生命周期。
   */
  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => {
      this.toolsChangedListeners.delete(listener);
    };
  }

  private emitToolsChanged(): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener();
      } catch {
        // 旁路故障静默：rebind 消费方异常不能拆连接。
      }
    }
  }

  /**
   * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
   *
   * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
   */
  private async recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult> {
    const { record, request } = input;
    const config = record.config;
    if (config.type === "stdio") throw input.error;
    const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (!oauthConfig) throw input.error;

    this.logger?.warn("MCP tool call requires OAuth authorization", {
      event: "mcp.oauth.tool_call.authorization_required",
      mcpServerName: request.serverName,
      oauthTriggerReason: input.trigger.reason,
      status: "started",
      toolName: request.toolName,
    });

    const recovery = this.ensureToolCallAuthorizationRecovery({
      config,
      name: request.serverName,
      oauthConfig,
      record,
      trigger: input.trigger,
    });
    const recoveredStatus = await waitWithinMcpDeadline(
      recovery,
      input.deadline,
      input.timeoutMessage,
      input.signal,
    );
    if (recoveredStatus.status !== "connected") {
      throw input.error;
    }

    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw input.error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
      input.signal,
    );
  }

  /**
   * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
   * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
   */
  private ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const current = this.records.get(input.name);
    if (
      current?.connecting &&
      current.status.status === "connecting" &&
      isDeepStrictEqual(current.config, input.config)
    ) {
      return current.connecting;
    }

    const generation = this.nextConnectionGeneration(input.name);
    const abortController = new AbortController();
    const recoveryRecord: McpServerRecord = {
      abortController,
      config: input.config,
      status: this.createStatus(input.config, "connecting", {
        toolCount: input.record.tools.length,
      }),
      // 运行期工具已经向 core 广告；恢复期间保留 descriptor，避免设置页/借用端口误判工具消失。
      tools: input.record.tools,
    };
    this.records.set(input.name, recoveryRecord);
    const connecting = this.runToolCallAuthorizationRecovery({
      abortController,
      config: input.config,
      generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      previousClient: input.record.client,
      previousTransport: input.record.transport,
      trigger: input.trigger,
    });
    recoveryRecord.connecting = connecting;
    return connecting;
  }

  private async runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const startedAt = Date.now();
    try {
      // 原 transport 的握手与 token 已失效，必须由共享 owner 统一退休；不能调用 connectServer，
      // 否则 closeRecord 会 abort recoveryRecord 自己的 controller，形成自取消。
      await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
      const outcome = await this.runInteractiveOAuthAuthorization({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthConfig: input.oauthConfig,
        serverUrl: input.config.url,
        signal: input.abortController.signal,
        trigger: input.trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await this.openServerConnection({
          config: input.config,
          generation: input.generation,
          name: input.name,
          oauthAuthorizationAttempted: true,
          signal: input.abortController.signal,
          timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        });
      }
      return await this.failConnection({
        config: input.config,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    } catch (error) {
      // 防御边界：共享 recovery promise 必须是 total operation。任何未来新增的编排异常也只能
      // 收敛为 failed record，不能留下 rejected connecting promise 污染后续 snapshot。
      return await this.failConnection({
        config: input.config,
        error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    }
  }

  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    // adapter 关闭 = 探测阶梯整体拆除（specs/mcp-startup-gate-breaker.md R3）。
    this.probeLadder.stopAll();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  private waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const connecting = record.connecting;
    if (!connecting) return Promise.resolve(record.status);
    if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
      return connecting;
    }

    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const currentStatus = () => this.records.get(name)?.status ?? record.status;
    const waiters: Promise<McpServerStatus>[] = [connecting];

    const timeoutMs = options.oauthAuthorizationTimeoutMs;
    if (timeoutMs !== undefined) {
      waiters.push(
        new Promise((resolvePromise) => {
          timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
        }),
      );
    }
    if (options.signal) {
      waiters.push(
        new Promise((resolvePromise) => {
          if (options.signal?.aborted) {
            resolvePromise(currentStatus());
            return;
          }
          abortHandler = () => resolvePromise(currentStatus());
          options.signal?.addEventListener("abort", abortHandler, {
            once: true,
          });
        }),
      );
    }

    return Promise.race(waiters).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    });
  }

  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      signal,
      timeoutMs,
      workingDirectory,
    } = input;
    const startedAt = Date.now();
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: V4McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
      );
      transport = transportBundle.transport;
      getRecentStderr = this.attachStdioLogging(name, transport);
      // 协商记忆消费（negotiation-increments spec R1）：auto 协商本来要先跑一轮
      // server/discover probe；7 天新鲜窗内被记住为「probe 不出结果的 legacy 对端」
      // 的 server 直接走 legacy 路径，省掉 probe 超时预算（慢连接 server 的启动税）。
      // 显式 pin/legacy 配置与 sse 不受记忆影响（记忆只作用于 auto）。
      const configuredNegotiation = resolveVersionNegotiation(config, timeoutMs);
      let effectiveNegotiation = configuredNegotiation;
      let probeSkippedByMemory = false;
      if (
        configuredNegotiation.mode === "auto" &&
        (await this.negotiationMemory.isRememberedLegacy(config))
      ) {
        effectiveNegotiation = { mode: "legacy" };
        probeSkippedByMemory = true;
        this.logger?.debug(
          "MCP server remembered as a legacy peer from an earlier connect; skipping the discover probe",
          {
            ...this.connectionContext,
            event: "mcp.server.negotiation_memory.hit",
            mcpServerName: name,
          },
        );
      }
      client = new Client(
        {
          name: this.clientName,
          version: this.clientVersion,
        },
        {
          versionNegotiation: effectiveNegotiation,
        },
      );
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });
      // 插件 server 名不含 marketplace；只能用 loader 附在 source 上的权威 pluginId，
      // 否则个人来源的同名插件会伪装成官方快照。普通 MCP 连接不接收状态通知。
      const pluginId = config.source?.pluginId;
      if (pluginId && this.pluginStateNotificationSink) {
        client.setNotificationHandler("notifications/message", (notification) => {
          try {
            const params = notification.params as
              | { level?: unknown; logger?: unknown; data?: unknown }
              | undefined;
            const loggerName = typeof params?.logger === "string" ? params.logger : undefined;
            if (!loggerName?.startsWith(PLUGIN_STATE_LOGGER_PREFIX)) return;
            const topic = loggerName.slice(PLUGIN_STATE_LOGGER_PREFIX.length);
            if (!topic) return;
            this.pluginStateNotificationSink?.({
              pluginId,
              key: topic,
              state: params?.data,
            });
          } catch (error) {
            this.logger?.warn("mcp.plugin_state_notification_failed", {
              error: error instanceof Error ? error.message : String(error),
              serverName: name,
            });
          }
        });
      }

      const connectStartedAt = Date.now();
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP server ${name} connection timed out after ${timeoutMs}ms`,
        signal,
      );
      connectDurationMs = Date.now() - connectStartedAt;

      failureKind = "tool_list_failed";
      const listToolsStartedAt = Date.now();
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
        signal,
      );
      listToolsDurationMs = Date.now() - listToolsStartedAt;
      const tools: McpToolDescriptor[] = [];
      // >128 字符工具名剔除（negotiation-increments spec R3）：模型面工具名超过
      // provider/MCP SDK 的 128 字符上限时，注册进工具池只会在首次调用或 schema
      // 校验阶段炸出难以归因的错误。这里在注册边界剔除并**点名**记录被剔工具，
      // 让日志能直接回答「这个 server 少了哪个工具、为什么」。
      const droppedOverlongTools: Array<{ toolName: string; name: string; length: number }> = [];
      for (const tool of listed.tools) {
        const descriptor = normalizeMcpToolDescriptor(
          name,
          tool,
          config.timeoutMs,
          // 只有 http 形态置位。这个标记的用途是**信任结果里的结构化标识**
          // （额度耗尽 / 无套餐），因此判据必须是"结果由谁产出"：
          //   - http：结果来自 ACode 后端。fetch wrapper 对每次请求校验 origin；登录态只在
          //     tools/call 解析，缺失时由同一可信后端返回结构化 coding_plan_required；
          //   - stdio：结果由插件进程自己产出，可以任意伪造 `{"error_code":"quota_exceeded"}`，
          //     从而在用户输入框上方弹出"额度用完 / 请开通 Coding Plan"的误导提示。
          // 原判据是 `type !== "sse"`，把 stdio 一起放了进来，等于这道门槛在 stdio 上为零。
          // 注意这不是在挡凭证外泄（那由 origin 校验负责），而是在挡**结果伪造**。
          config.type === "http" && config.auth?.type === ACODE_OFFICIAL_MCP_AUTH_TYPE,
        );
        const modelName = descriptor.name ?? descriptor.toolName;
        if (exceedsMcpToolNameLimit(descriptor)) {
          droppedOverlongTools.push({
            toolName: descriptor.toolName,
            name: modelName,
            length: modelName.length,
          });
          continue;
        }
        tools.push(descriptor);
      }
      if (droppedOverlongTools.length > 0) {
        this.logger?.warn("MCP tools dropped: model-facing name exceeds the length limit", {
          ...this.connectionContext,
          droppedTools: droppedOverlongTools,
          event: "mcp.tools.name_too_long_dropped",
          maxNameLength: MCP_TOOL_NAME_MAX_LENGTH,
          mcpServerName: name,
        });
      }
      // 模型面名撞名的确定性赢家（specs/mcp-startup-gate-breaker.md R4）：sanitizer
      // 有损，两个不同来源可 mint 同一模型面名；赢家按原始身份键字典序取，与数组
      // 顺序、重连先后无关。同源重复静默去重。
      const deduplicated = deduplicateMcpToolDescriptors(tools);
      if (deduplicated.collisions.length > 0) {
        this.logger?.warn("MCP tool name collision; keeping deterministic winner", {
          ...this.connectionContext,
          collisions: deduplicated.collisions,
          event: "mcp.tools.name_collision",
          mcpServerName: name,
        });
      }
      const registeredTools = deduplicated.tools;
      const negotiatedProtocolEra = client.getProtocolEra();
      const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
      // 工具缓存覆写（specs/mcp-startup-gate-breaker.md R1）：schema 变更以新握手
      // 结果为准——每次 tools/list 成功都 best-effort 覆写，写失败只记日志。
      if (registeredTools.length > 0) {
        void this.toolCache.set(name, config, registeredTools).catch(() => {});
      }
      // 协商记忆记账（negotiation-increments spec R1）：只有真正跑过 probe 的 auto
      // 协商才产生观察事实。probe 后落在 legacy 纪元 → 记住（7 天窗内跳过 probe）；
      // modern 纪元 → 清除旧记忆（自愈证据优先）。记忆短路、显式 pin/legacy、sse
      // 都不记账。写入是 best-effort（模块内部串行化 + 吞错），不阻塞连接成功路径。
      if (configuredNegotiation.mode === "auto" && !probeSkippedByMemory) {
        if (negotiatedProtocolEra === "legacy") {
          void this.negotiationMemory.rememberLegacy(config);
        } else if (negotiatedProtocolEra === "modern") {
          void this.negotiationMemory.forget(config);
        }
      }
      // 连接成功 = 403 快速失败标记的解除点之一（另一处是显式连接入口）。
      this.permanentAccessDenied.delete(name);
      const status = this.createStatus(config, "connected", {
        protocolEra: negotiatedProtocolEra,
        toolCount: registeredTools.length,
      });
      if (!this.isCurrentConnection(name, generation)) {
        await this.closeClientAndTransport(name, client, transport);
        return this.records.get(name)?.status ?? status;
      }
      this.connectionDiagnosticByServer.delete(name);
      this.records.set(name, {
        client,
        config,
        status,
        tools: registeredTools,
        transport,
        sawConnected: true,
        // 新连接从零开始计量「毫无产出」：风暴只数没干过活的连接（spec R2）。
        workedSinceConnect: false,
      });
      // 连接成功 = 最强的恢复证据：清零连续失败计数并解除挂起（spec R1）；
      // 静默探测阶梯拆除（specs/mcp-startup-gate-breaker.md R3，自愈完成）。
      this.reconnectBudget.recordSuccess(name);
      this.probeLadder.stop(name);
      this.emitStatusChange(name, "connecting", status, "connected");
      // 工具面已原子替换（含 Deferred→真实与空→真实）：通知 core 注册表 rebind
      // （specs/mcp-startup-gate-breaker.md R1 收尾接线）。
      this.emitToolsChanged();
      const mcpTransportPid = getStdioTransportPid(transport);
      const mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
      // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
      // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
      client.onclose = () => {
        if (!this.isCurrentConnection(name, generation)) return;
        const current = this.records.get(name);
        if (!current || current.client !== client) return;
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
        const previousStatusKind = current.status.status;
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server connection closed unexpectedly",
          failureKind: "unexpected_disconnect",
        });
        // 挂起事实若已存在（如中途崩溃阈值刚刚达到、或状态被 onclose 重写），随
        // 状态一并携带——预算是挂起的唯一读源，附加不依赖 onclose 与计数点的
        // 先后时序（正常时序 onclose 先于 callTool catch，这里兜住反序/重写）。
        const activeSuspension = this.reconnectBudget.suspension(name);
        if (activeSuspension) current.status.reconnectSuspension = activeSuspension;
        // server 进程关闭只标记状态、派发事件，不后台自旋重连——恢复走懒重连
        // （下次 callTool，受预算门禁；spec R1「重连触发点」）。
        this.emitStatusChange(name, previousStatusKind, current.status, "disconnected");
        this.logger?.warn("MCP server connection lost", {
          ...this.connectionContext,
          event: "mcp.server.connection_lost",
          mcpServerName: name,
          ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
          ...(mcpProcessIdentity ?? {}),
          ...(processExit
            ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
            : {}),
          status: "failed",
          transport: current.config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          current.config.type === "stdio" &&
          this.connectionContext &&
          (processExit || !isStdioTransportProcessAlive(transport))
        ) {
          this.telemetry?.recordProcessCrashed({
            connectionId: this.connectionContext.mcpConnectionId,
            exitCode: processExit?.exitCode ?? null,
            signal: processExit?.signal ?? null,
          });
        }
        // 崩溃风暴记账（specs/mcp-startup-gate-breaker.md R2）：已建立连接的意外
        // 断开是唯一计数点——但只数「毫无产出」的连接（本连接从未完整成功过一次
        // 工具调用）。断连之间夹着成功调用的 server 是 R1 认定的半可用形态，成功
        // 调用已在 callTool 成功点清空窗口，这里不得重复计入。30s 窗口内 >5 次
        // 「连上就死」即熔断：状态附加挂起事实、派发 reconnect-suspended、拆除
        // 探测阶梯，一切自动恢复停止直至显式操作。
        if (!current.workedSinceConnect) {
          const storm = this.crashStorm.recordDisconnect(name);
          if (storm.tripped && storm.trip) {
            this.applyCrashStormSuspension(name, storm.trip);
          }
        }
        // 静默探测武装（specs/mcp-startup-gate-breaker.md R3）：曾连接成功的
        // http/sse server 武装后台自愈；stdio 不武装（按需拉起，防 fork 风暴）。
        this.noteRemoteServerLost(name);
      };
      // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
      // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
      // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
      // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
      this.logger?.info("MCP server connected", {
        ...this.connectionContext,
        connectDurationMs,
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connected",
        listToolsDurationMs,
        mcpClientName: this.clientName,
        mcpClientVersion: this.clientVersion,
        mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
        mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
        mcpServerName: name,
        ...(mcpProcessIdentity ?? {}),
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
        status: "completed",
        toolCount: registeredTools.length,
        transport: config.type,
      });
      return status;
    } catch (error) {
      // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
      // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
      // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
      const trigger = oauthAuthorizationAttempted
        ? undefined
        : classifyInteractiveAuthorizationTrigger(error);
      const authorizationCodeOAuthConfig =
        trigger && config.type !== "stdio"
          ? resolveAuthorizationCodeOAuthConfig(config)
          : undefined;
      if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
        // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
        await this.closeClientAndTransport(name, client, transport);
        const outcome = await this.runInteractiveOAuthAuthorization({
          config,
          generation,
          name,
          oauthConfig: authorizationCodeOAuthConfig,
          serverUrl: config.url,
          signal,
          trigger,
        });
        if (outcome.status === "authorized" || outcome.status === "already-authorized") {
          return await this.openServerConnection({
            ...input,
            oauthAuthorizationAttempted: true,
          });
        }
        // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
        // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
        return this.failConnection({
          config,
          connectDurationMs,
          error:
            outcome.status === "pending"
              ? new Error(
                  `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
                )
              : outcome.error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
        });
      }
      // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
      // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
      // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
      // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
      // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
      // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
      // reject），cause 链仅作防御性兜底。
      const negotiationFailureKind = isProtocolNegotiationFailure(error)
        ? ("protocol_negotiation_failed" as const)
        : undefined;
      return this.failConnection({
        client,
        config,
        connectDurationMs,
        error,
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
        transport,
        failureKind: negotiationFailureKind ?? failureKind,
      });
    }
  }

  /**
   * Phase 2：交互授权。
   *
   * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
   * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
   */
  private async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedACodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
      // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
      // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
      // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
        // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
      // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
      // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }

  private async failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: V4McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus> {
    const {
      client,
      config,
      connectDurationMs,
      error,
      failureKind: fallbackFailureKind,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
    // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
    // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
    const officialAuthKind =
      (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
      this.lastOfficialAuthKind.get(name);
    this.lastOfficialAuthKind.delete(name);
    // 403 快速失败标记（negotiation-increments spec R2）：HTTP 403（SDK 结构化
    // SdkHttpError.status 判定，不按错误文本反解）或官方鉴权 forbidden 分类 =
    // 身份被认出但访问被拒——重连不可能改变结果。标记后懒重连门禁直接拒绝
    // （不再「403 → 冷却 → 重连 → 又 403」三连），显式操作或连接成功清除。
    if (officialAuthKind === "official_auth_forbidden" || isHttpForbiddenFailure(error)) {
      this.permanentAccessDenied.add(name);
      this.logger?.warn("MCP server denied access (HTTP 403); automatic retries suppressed", {
        ...this.connectionContext,
        event: "mcp.server.access_denied",
        mcpServerName: name,
        status: "failed",
      });
    }
    const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
    this.connectionDiagnosticByServer.delete(name);
    const failureKind =
      (officialAuthKind === "official_mcp_origin_untrusted"
        ? "official_origin_untrusted"
        : undefined) ??
      responseDiagnostic?.failureKind ??
      (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const status = this.createStatus(config, "failed", {
      error: displayMessage,
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    // 连续失败计数累积（显式与自动路径都记——连续失败是 server 的客观事实）；
    // 预算耗尽即挂起：状态携带 reconnectSuspension，自动重连停止，等待显式操作
    // （specs/mcp-lifecycle-ttl-approval.md R1）。
    const budgetOutcome = this.reconnectBudget.recordFailure(name);
    const suspension = budgetOutcome.suspended
      ? this.reconnectBudget.suspension(name)
      : undefined;
    if (suspension) status.reconnectSuspension = suspension;
    const recentStderr = getRecentStderr?.();
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    // sawConnected 随失败 record 传递（specs/mcp-startup-gate-breaker.md R3）：
    // 曾连接成功的 http/sse server 连接失败后仍要武装静默探测。
    const sawConnectedBefore = this.records.get(name)?.sawConnected === true;
    this.records.set(name, { config, status, tools: [], sawConnected: sawConnectedBefore });
    if (sawConnectedBefore) {
      this.noteRemoteServerLost(name);
    }
    if (suspension) {
      this.logger?.warn("MCP server automatic reconnection suspended", {
        ...this.connectionContext,
        consecutiveFailures: suspension.consecutiveFailures,
        event: "mcp.server.reconnect.suspended",
        mcpServerName: name,
        status: "failed",
        transport: config.type,
      });
      this.emitStatusChange(name, "connecting", status, "reconnect-suspended");
    } else {
      this.emitStatusChange(name, "connecting", status, "connect-failed");
    }
    this.logger?.warn("MCP server connection failed", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      error: displayMessage,
      event: "mcp.server.failed",
      listToolsDurationMs,
      mcpServerName: name,
      ...(officialAuthKind ? { officialAuthKind } : {}),
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "failed",
      ...(recentStderr ? { stderr: recentStderr } : {}),
      transport: config.type,
    });
    return status;
  }

  private async createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          env: {
            ...buildMcpStdioEnv({ env: this.env, network: this.network }),
            ...config.env,
          },
          stderr: "pipe",
          ...(isOfficialAuthConfig(config) && config.official
            ? {
                requestMetaProvider: async () => {
                  const authMeta = await this.resolveOfficialStdioAuthMeta(
                    serverName,
                    config,
                    signal,
                  );
                  return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
                },
              }
            : {}),
        }),
      };
    }

    const fetch = createMcpTransportFetch({
      env: this.env,
      network: this.network,
    });
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
          // 不起 localhost 回调 server、401/403 不转授权流程。
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch ?? fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        }),
      };
    }

    return {
      transport: new SSEClientTransport(new URL(config.url), {
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  /**
   * 官方鉴权 MCP 的动态 fetch。返回 undefined 表示走普通 MCP 路径。
   *
   * trusted origin 依赖缺失时直接 fail closed。auth port 可以缺失：wrapper 仍校验 origin，
   * 各请求匿名降级并由服务端做权威判定。
   */
  private createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined {
    if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    if (!trustedOrigins) {
      return (() => {
        throw new OfficialMcpAuthError(
          "official_auth_unavailable",
          `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
        );
      }) as unknown as typeof globalThis.fetch;
    }
    return createOfficialMcpAuthFetch({
      baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
      official,
      onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
      onServerResponse: (response) => {
        if (this.isCurrentConnection(serverName, generation)) {
          this.rememberServerResponse(serverName, response);
        }
      },
      serverName,
      trustedOrigins,
      url: config.url,
      ...(authHeadersPort ? { authHeadersPort } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
    });
  }

  /**
   * 运行期 auth provider。
   *
   * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
   * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
   * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
   * `auth()`，绕过我们的 refresh 单飞锁。
   *
   * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
   * 交互授权只在 Phase 2 事务里发生。
   */
  private createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined {
    if (config.type === "stdio") return undefined;
    // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 ACode 登录/套餐解决，
    // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
    if (isOfficialAuthConfig(config)) return undefined;
    const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (authorizationCodeOAuthConfig) {
      return createMcpOAuthTokenProvider({
        config: authorizationCodeOAuthConfig,
        credentialStore: this.resolveCredentialStore(),
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
        ...(this.logger ? { logger: this.logger } : {}),
        serverName,
        serverUrl: config.url,
      });
    }
    if (config.oauth?.type === "client_credentials") {
      return new ClientCredentialsProvider({
        clientId: config.oauth.clientId,
        clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
        clientSecret: config.oauth.clientSecret,
        scope: config.oauth.scope,
      });
    }
    return undefined;
  }

  private resolveCredentialStore(): SharedACodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedACodeCredentialStore();
    return this.credentialStore;
  }

  private createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined {
    if (config.type === "stdio") return this.mcpOAuth;
    return {
      ...this.mcpOAuth,
      authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
      onAuthorizationRequired: async (context) => {
        this.updateCurrentRecordStatus(serverName, generation, {
          authorization: createOAuthAuthorizationStatus(context),
          status: "connecting",
        });
        await this.mcpOAuth?.onAuthorizationRequired?.(context);
      },
    };
  }

  private attachStdioLogging(name: string, transport: McpTransport): () => string | undefined {
    const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
    const stderr = (
      transport as {
        stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
      }
    ).stderr;
    stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer.append(text);
      this.logger?.debug("MCP stdio stderr", {
        event: "mcp.stdio.stderr",
        mcpServerName: name,
        stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
      });
    });
    return () => {
      const text = stderrBuffer.read();
      if (!text) return undefined;
      // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
      // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
      return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
    };
  }

  private async closeRecord(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
    if (!record.client && !record.transport) return;
    await this.closeClientAndTransport(name, record.client, record.transport);
  }

  private async closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> {
    const startedAt = Date.now();
    const mcpTransportPid = getStdioTransportPid(transport);
    // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
    if (client) client.onclose = undefined;
    // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
    // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
    await this.terminateStdioProcessTree(name, transport);

    try {
      await client?.close();
    } catch (error) {
      this.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }

    try {
      await transport?.close();
    } catch (error) {
      this.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      this.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      this.telemetry?.recordProcessClosed({
        connectionId: this.connectionContext.mcpConnectionId,
      });
    }
    this.logger?.info("MCP server closed", {
      ...this.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  }

  private async terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void> {
    const pid = getStdioTransportPid(transport);
    if (pid == null) return;

    try {
      await terminateMcpStdioProcessTree(pid);
    } catch (error) {
      this.logger?.warn("MCP stdio process tree cleanup failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.stdio.process_tree_cleanup.failed",
        mcpServerName: name,
        mcpTransportPid: pid,
        pid,
        status: "failed",
      });
    }
  }

  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    return generation;
  }

  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  private updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  private updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。ACode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.acode/request-context": requestContext,
  };
}

function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // deprecated SSE transport 本身只承载 legacy era；显式 modern pin 仍应失败而不能静默降级。
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * SDK 版本协商（auto/pin 的 server/discover probe）失败的稳定识别。
 *
 * 结构化判定，禁止匹配错误文本：
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`：probe 硬失败（含非标 legacy server 的
 *   malformed 200 响应，经 transport 层 Zod 校验失败 + normalizeReply 落入 network-error 分支）；
 * - `UnsupportedProtocolVersionError`：recognized modern error，pin 版本不被 server 接受。
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin 没有 legacy fallback，probe 就是唯一 initialize 路径；沿用 auto 的 5 秒
  // 保护上限会无视 server 的长连接预算，把冷启动正常但超过 5 秒的 node_repl 静默移出工具池。
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // 原因：SDK 的 stdio auto/pin 会先启动 disposable sibling；若沿用 SDK 60s 默认值，
      // ACode 的总连接超时可能先结束并让 probe 残留，也不给 legacy initialize 留预算。
      timeoutMs: probeTimeoutMs,
    },
  };
}

function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 MCP OAuth 互斥。必须位于所有既有分支之前：
  // 官方 MCP 既不写 oauth 字段、又禁止静态 authorization 头，若不在此短路就会落进
  // 下面的 authorization_code 兜底，导致 401 时弹出 MCP 授权 UI —— 而官方鉴权失败
  // 只能由 ACode 自身的登录/套餐解决，不可能由目标 MCP 的 OAuth 授权解决。
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // 新建 HTTP/SSE MCP 常只保存 URL；OAuth 支持应由服务端
  // WWW-Authenticate / discovery 触发，不能要求配置里预先写 oauth 字段。
  return {
    type: "authorization_code",
  };
}

/**
 * auth.type/provider 精确命中且 provenance 存在时为真；provenance 缺失说明不是 Plugin loader
 * 产出的配置。
 *
 * 覆盖 http 与 stdio 两种形态——两者的凭证投递通道不同，但"是否官方鉴权"
 * 的判定同源。调用方若只关心某一形态，需自行再判 `config.type`（如 createOfficialAuthFetch
 * 只处理 http、_meta 注入只处理 stdio）。
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "acode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// server 回了 JSON-RPC 错误响应（数字 code）说明请求走通了、连接是活的；
// SDK 本地错误（SdkError，字符串 code：REQUEST_TIMEOUT / CONNECTION_CLOSED / NOT_CONNECTED
// / SEND_FAILED）才代表 transport 已断。code 类型判断兜底 instanceof 在多份 SDK 实例下失效的情况。
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}

/**
 * callTool 执行中途 transport 断开的结构化识别（spec R1 中途崩溃计数的判据）：
 * SdkError 字符串 code CONNECTION_CLOSED（执行中断开）/ NOT_CONNECTED（发起时
 * 已断，onclose 未及处理的竞态）。不按错误文本反解；code 字符串比较兜底多份 SDK
 * 实例下 instanceof 失效（与 isPeerAnsweredError 同一哲学）。超时
 * （REQUEST_TIMEOUT）、in-band isError 与普通请求错误都不计入——不是崩溃证据。
 */
function isMidCallTransportDisconnect(error: unknown): boolean {
  if (SdkError.isInstance(error)) {
    return error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected;
  }
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
  );
}

/**
 * 「请求已上线后连接断开」的结构化识别（negotiation-increments spec R4 防双跑的
 * 判据）：只认 SdkError 字符串 code CONNECTION_CLOSED——SDK 在响应等待期 transport
 * 断开时抛出。NOT_CONNECTED 不在此列：它只在请求**尚未写出**时抛（SDK 的
 * request/send 入口对 transport 缺席的早期拒绝），是 callTool 安全一次重试的依据。
 * 与 isMidCallTransportDisconnect 同一哲学：结构化 code 比较，不按错误文本反解，
 * record 形态兜底多份 SDK 实例下 instanceof 失效。
 */
function isConnectionClosedMidCall(error: unknown): boolean {
  if (SdkError.isInstance(error)) {
    return error.code === SdkErrorCode.ConnectionClosed;
  }
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    error.code === SdkErrorCode.ConnectionClosed
  );
}

/**
 * HTTP 403 的结构化识别（negotiation-increments spec R2）：SDK 把非 2xx 响应包成
 * SdkHttpError（data.status），沿 cause 链查找。官方鉴权路径的 forbidden 分类走
 * OfficialMcpAuthError.kind（failConnection 内单独判定），两者取或。
 */
function isHttpForbiddenFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (SdkHttpError.isInstance(current) && current.status === 403) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 懒重连触发面（spec R1）：disconnected（server 进程关闭 / ping 判死）与非鉴权类
 * failed。failed 也进懒重连——否则一次自动重连失败后 record 永远停在 failed，
 * 崩溃预算无法经工具调用耗尽，server 只能等显式操作复活。鉴权类失败例外：
 * OAuth 授权未完成 / 官方 origin 不可信的自动重试会重新拉起浏览器授权流程，
 * 那是显式操作的副作用面，不由工具调用循环触发（对齐参考机制的
 * needsInteractiveAuth 独立分支）。
 */
function isAutoReconnectableStatus(status: McpServerStatus): boolean {
  if (status.status === "disconnected") return true;
  return (
    status.status === "failed" &&
    status.failureKind !== "oauth_authorization_failed" &&
    status.failureKind !== "official_origin_untrusted" &&
    status.authorization === undefined
  );
}

/**
 * 快启门的任务追踪（specs/mcp-startup-gate-breaker.md R1）：包一层 settle 状态
 * 投影，门到期后据此区分「已收敛」与「仍 pending」。附加回调同时消除原 promise
 * 的 unhandled rejection 面（连接任务留在后台继续跑，不能再炸出未处理拒绝）。
 */
interface TrackedConnectTask {
  config: McpServerConfig;
  name: string;
  promise: Promise<McpServerStatus>;
  status: "pending" | "fulfilled" | "rejected";
}

function trackConnectTask(
  name: string,
  config: McpServerConfig,
  promise: Promise<McpServerStatus>,
): TrackedConnectTask {
  const task: TrackedConnectTask = { config, name, promise, status: "pending" };
  promise.then(
    (value) => {
      task.status = "fulfilled";
      void value;
    },
    (error) => {
      task.status = "rejected";
      void error;
    },
  );
  return task;
}

/** 快启门的缺省等待：真定时器且 unref（门是启动优化，绝不把进程吊在退出边缘）。 */
function defaultStartupGateSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}
