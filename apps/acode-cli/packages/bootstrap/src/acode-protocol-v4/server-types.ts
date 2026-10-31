import {
  createRootTraceContext,
  createTraceId,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type SessionEventStorePort,
  type SessionId,
  type SessionTaskType,
  type SessionStorePort,
  type TraceContext,
} from "@acode/contracts";
import type { McpTelemetryTracker } from "@acode/adapters";
import type { WorkspaceHookPolicyProvider } from "@acode/core";
import type { AccountProviderConfigSnapshot } from "@acode/provider";
import { acodeProtocolErrorCodes, type ACodeAutomationBotDeliveryTarget, type ACodeDeliveryKind, type ModelSelection, type ACodeModelContextBudgetStrategy, type ACodeProtocolMessage, type LegacySurvivorMethod, type LegacySkewFallbackMethod, type ACodeProtocolNotification, type ACodeProtocolRequest, type ACodeProtocolRequestId, type ACodeProtocolTrace, type ACodeSessionMode, type ACodeWorkspaceRef, type ToolSearchAppMode } from "@acode/shared";
import { type V4SessionPersistence, type V4Method } from "@acode/shared/acode-protocol-v4";

import type { ACodeApp, ACodeAppOptions } from "../app/types.js";
import type { V4InteractionRegistry } from "./interaction-registry.js";
import type { ConversationV4Gateway } from "./v4-gateway.js";
import type { SessionResidentPool, SessionResidentPoolOptions } from "./session-resident-pool.js";

export interface ParamsSchema<T> {
  parse(input: unknown): T;
}

export interface ACodeProtocolAgentDependencies {
  createACodeApp(options?: Omit<ACodeAppOptions, "providerRegistry">): ACodeApp | Promise<ACodeApp>;
  /**
   * 每个 session record 的内存 event store 工厂。
   * 默认 turn 窗口保留策略；测试可注入 spy 或 unbounded 实现做对照。
   */
  createSessionEventStore?(sessionId: string): SessionEventStorePort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  mcpPort?: McpPort;
  /** 资源管理器：`process/childProcesses` 读取 MCP 子进程 pid 与插件归属 */
  mcpTelemetry?: Pick<McpTelemetryTracker, "listProcesses">;
  platform?: NodeJS.Platform | string;
  /** 仅用于构造单个 CLI/app-server 的混合 resident 策略；生产默认值由 pool 定义。 */
  sessionResidentPoolOptions?: SessionResidentPoolOptions;
  /** 兼容旧测试/嵌入调用；新代码应通过 sessionResidentPoolOptions 设置 low-water。 */
  sessionResidentTargetCount?: number;
  sessionStore?: SessionStorePort;
  version?: string;
  /** 受信 Host 管理的 Hook policy；workspace/project 配置不得覆盖。 */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** 把 Host 账号状态形成的第三层 Config Overlay 同步给进程 Registry。 */
  syncAccountProviderConfig?: (snapshot: AccountProviderConfigSnapshot) => Promise<boolean>;
  /** 连接测试前主动重读当前进程的 Config Source 并等待 Registry 发布。 */
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

export type ACodeProtocolAgentResolvedDependencies = ACodeProtocolAgentDependencies & {
  createSessionEventStore(sessionId: string): SessionEventStorePort;
  workspaceHookPolicyProvider: WorkspaceHookPolicyProvider;
};

export interface ACodeProtocolEventSequenceState {
  lastSeq: number;
  seqBySourceEventKey: Map<string, number>;
}

export interface ACodeProtocolToolInputTransmissionState {
  streamedToolCallIdsWithInput: Set<string>;
}

export interface ACodeProtocolSessionRecord {
  app: ACodeApp;
  memoryEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  modelContextBudgetStrategy: ACodeModelContextBudgetStrategy;
  createdAt: number;
  deliveryKind?: ACodeDeliveryKind;
  /**
   * 旧 session/subscribe 没有 unsubscribe RPC；只在真正 subscribe 时置位，不能用
   * 会被 session/read 写入的 deliveryKind 代替。连接结束会销毁整个 CLI 进程。
   */
  legacyStreamSubscribed?: boolean;
  eventStore: SessionEventStorePort;
  parentSessionId?: SessionId;
  persistence: V4SessionPersistence;
  protocolEventSequences: Map<string, ACodeProtocolEventSequenceState>;
  protocolToolInputTransmissions: Map<string, ACodeProtocolToolInputTransmissionState>;
  stateRevision: number;
  taskType?: SessionTaskType;
  traceContext: TraceContext;
  unsubscribe?: () => void;
  updatedAt: number;
  workspace: ACodeWorkspaceRef;
  activeAbortController?: AbortController;
  /** background runner 释放 ready lock 后，持久化/snapshot/broadcast 尚未完成的引用计数。 */
  residencyFinalizationCount?: number;
  /** 当前正在执行的 automation 派发 turn；只在 turn 运行期间存在，禁止递归 CronCreate。 */
  activeAutomationId?: string;
  /** 当前正在执行的闲时派发 turn；只在 turn 运行期间存在，禁止递归 OffPeakCreate。 */
  activeOffPeakTaskId?: string;
  /** 当前 Bot 入站 turn 的稳定回推地址；只允许 CronCreate 在本轮读取。 */
  activeBotDeliveryTarget?: ACodeAutomationBotDeliveryTarget;
  restoreWarning?: { message: string; type: string };
  /** 冷恢复候选只供初始投影；新的选模事件立即清除，不能替代 Runtime 执行绑定。 */
  restoredModelSelection?: ModelSelection;
}

export interface ACodeProtocolClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: ACodeProtocolTrace;
  reannounceIntervalMs?: number;
}

export interface ACodeProtocolAgentServerContext {
  /** 进程退出期间，迟到的异步物化不能重新登记 session。 */
  assertServing?: () => void;
  deps: ACodeProtocolAgentResolvedDependencies;
  logger?: Logger;
  appRuntimePreferences: {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled: boolean;
    /** host 同步的 Off-Peak 工具面门禁；缺省 false（fail-closed），供 v4 冷恢复等无 host 参数的路径读取。 */
    offPeakToolEnabled: boolean;
    /**
     * host 同步的动态工作流灰度门。
     * 缺省 false（fail-closed）：不认识该方法的旧 Host 或还没来得及同步的启动窗口里，
     * 工作流工具面、`/workflow` 与 dynamic-workflows 技能一律不露出。
     */
    dynamicWorkflowEnabled: boolean;
    /**
     * host 同步的脚本工作流产品开关（spec script-workflow-management-surface.md §4.5）。
     * 与 dynamicWorkflowEnabled 两点刻意不同：**缺省 undefined（缺席 = 显示 /ultracode，
     * fail-open 到本机缺省档 onDemand）**——本 flag 只下架 RunWorkflow 一个工具，缺席
     * 译成「关」会把 TUI/无 v4 通路的宿主的默认目录砍掉；同步时机是 **v4 createSession**
     * （Host 信封显式带 true/false），不是 legacy 的 updateDynamicWorkflowPolicy 推送——
     * script 没有会话中途改档通道（spec §4.5 末行），档位本来就在下次会话创建时生效，
     * 进程缓存在同一时机刷新即可。只影响目录/快照的**展示**；会话的工具面与命令展开
     * 由该会话 runtimeConfig 里的显式布尔裁决，不回读这里。
     */
    scriptWorkflowEnabled?: boolean;
    /**
     * host 同步的工具按需检索档位（specs/tool-search.md R3/R11）。缺省 undefined
     * （= off，fail-safe 到零行为变化红线，与 scriptWorkflowEnabled 的 fail-open 方向
     * 刻意相反）；同步时机同 script——**v4 createSession**（Host 折叠出口每次现读
     * AppSettings，三档含 off 都写，缓存因此总能刷掉旧档位）。消费口是 createRecord
     * 的冷恢复/fork 兜底：无 Host 侧通道参数的 record 物化路径回读这里；会话的工具面
     * 在创建期物化进 AgentRuntimeConfig.toolSearchMode 后固定，存活 runtime 不回读。
     */
    toolSearchMode?: ToolSearchAppMode;
  };
  // 竖切：v4 conversation 通道（订阅/帧/命令），与旧 session/* 方法并存。
  // 构造顺序问题（gateway 闭包持有 context）用可选字段收口，server 构造完立即赋值。
  v4Gateway?: ConversationV4Gateway;
  // v4 前向命令 resolveInteraction 与反向请求（permission/AskUserQuestion）的汇合点。
  // broker 注册 deferred、v4 命令面投递应答（同一实例经 binder 注入 V4CommandCoreHost）。
  v4Interactions: V4InteractionRegistry;
  // 单 CLI resident session 池。冷恢复入口经 waitForDeactivation 等待旧 app.close 收尾，
  // 协议请求则持有 operation lease，禁止异步 handler 与容量回收交错。
  sessionResidentPool?: SessionResidentPool;
  sessions: Map<string, ACodeProtocolSessionRecord>;
  /**
   * 连接级「host 已接住 v4 inbound」证据位（M2-4，specs/m2-4-inbound-interaction.md §2.4）。
   *
   * 只由 host 对六条 v4 反向请求的实际响应置位（server.requestClient 收到 v4/interaction/*
   * 方法的成功响应），并在 setNotificationSink 重连/换 host 时归零。host 对未知**通知**是静默丢弃，
   * 没有可观测回路，因此 CUA 通知不能用探测——发送前读本 flag：true 发 v4 形态，否则发 legacy，
   * 双形态不叠加。-32601 是请求侧的 skew 门（见 automation-port 先例），与通知不共享证据。
   */
  hostV4InboundEstablished: boolean;
  notify(notification: ACodeProtocolNotification): void;
  requestClient<T>(
    method: LegacySurvivorMethod | LegacySkewFallbackMethod | V4Method,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ACodeProtocolClientRequestOptions,
  ): Promise<T>;
}

export class ProtocolRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

export function isRequest(message: ACodeProtocolMessage): message is ACodeProtocolRequest {
  return "method" in message && "id" in message;
}

export function isNotification(
  message: ACodeProtocolMessage,
): message is ACodeProtocolNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(
  message: ACodeProtocolMessage,
): message is { id: ACodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

export function isErrorResponse(message: ACodeProtocolMessage): message is {
  id: ACodeProtocolRequestId;
  error: { code: number; message: string; data?: unknown };
} {
  return "id" in message && "error" in message;
}

/**
 * 从 zod（或类 zod）校验错误里提炼可读的字段级摘要，附到 "Invalid params" 消息里。
 * 原来只回 "Invalid params" 不说哪个字段错，模型（如 browser evaluate 误传函数、
 * 坐标为 NaN 等）无从自纠、会反复瞎试。这里用鸭子类型读 ZodError.issues（不引 zod 依赖），
 * 拼成 `expression: Expected string, received function` 这类可操作提示。
 */
function summarizeParamsError(error: unknown): string | undefined {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }
  const parts = issues.slice(0, 5).map((issue) => {
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message ?? "invalid"}`;
  });
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  return parts.join("; ") + more;
}

export function parseParams<T>(schema: ParamsSchema<T>, params: unknown): T {
  try {
    return schema.parse(params);
  } catch (error) {
    const detail = summarizeParamsError(error);
    throw new ProtocolRequestError(
      -32602,
      detail ? `Invalid params — ${detail}` : "Invalid params",
      error,
    );
  }
}

export function assertExpectedRevision(
  record: ACodeProtocolSessionRecord,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== record.stateRevision) {
    throw new ProtocolRequestError(-32009, "Session state revision mismatch", {
      actualRevision: record.stateRevision,
      expectedRevision,
    });
  }
}

export function toProtocolError(error: unknown): {
  code: number;
  data?: unknown;
  message: string;
} {
  if (error instanceof ProtocolRequestError) {
    return { code: error.code, data: error.data, message: error.message };
  }
  if (error instanceof Error) {
    const businessCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      code: -32603,
      // ModelProtocolError 等业务错误的 code 需要跨 JSON-RPC 保留给 UI。
      // 外层仍是 JSON-RPC internal error，稳定业务 code 放在 data.code 供横幅本地化。
      // 不透传 error.context：上游上下文不保证 JSON-safe，错误响应不能因诊断信息二次失败。
      data: {
        name: error.name,
        stack: error.stack,
        ...(businessCode ? { code: businessCode } : {}),
      },
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

function createProtocolTraceId(_sessionId: SessionId): TraceContext["traceId"] {
  // traceId 是 session 之上的观测链路，不应由 sessionId 拼出来。
  // 这里复用 agent/contracts 的 UUID 算法，保证 app 和 agent 两端 trace 格式一致。
  return createTraceId();
}

export function createProtocolRootTraceContext(
  sessionId: SessionId,
  trace?: ACodeProtocolTrace,
): TraceContext {
  const context = createRootTraceContext({
    sessionId,
    traceId: (trace?.traceId ?? createProtocolTraceId(sessionId)) as TraceContext["traceId"],
  });
  if (trace?.spanId) {
    context.spanId = trace.spanId;
  }
  if (trace?.parentId) {
    context.parentId = trace.parentId;
    context.parentSpanId = trace.parentId;
  }
  return context;
}

export function protocolTraceFromTraceContext(context: TraceContext): ACodeProtocolTrace {
  return {
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...((context.parentId ?? context.parentSpanId)
      ? { parentId: context.parentId ?? context.parentSpanId }
      : {}),
  };
}

export function requireSession(
  context: ACodeProtocolAgentServerContext,
  sessionId: string,
  options: { deliveryKind?: ACodeDeliveryKind; operation?: string } = {},
): ACodeProtocolSessionRecord {
  const record = context.sessions.get(sessionId);
  if (!record) {
    // 诊断：readSession 只读取活跃 runtime；记录缺失时要区分“冷会话尚未恢复”和“ID 已失效”，
    // 不能只留下相同的错误文本，否则无法判断 UI 是读早了还是 task index 带来了脏引用。
    context.logger?.warn("ACode Protocol session runtime missing", {
      activeSessionCount: context.sessions.size,
      event: "acode_protocol.session.require_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.acode_protocol",
      operation: options.operation ?? "unknown",
      ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
      sessionId,
    });
    throw new ProtocolRequestError(
      acodeProtocolErrorCodes.sessionUnavailable,
      `Session is not active: ${sessionId}`,
    );
  }
  return record;
}

export function createProtocolLogger(deps: ACodeProtocolAgentDependencies): Logger | undefined {
  return deps.loggerFactory?.createLogger("acode").child({
    module: "bootstrap.acode_protocol",
  });
}
