import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  Logger,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  WorkflowPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  VisualizationFragmentStorePort,
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
} from "./deps.js";
import type { PromptFileRouting } from "../context/prompt-files.js";
import type {
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ProviderRuntimeHeadersPort,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/contract.js";
import type { SwarmPlanPort } from "../swarm/port.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { MemorySemanticRecallChannel } from "./helpers/memory-semantic-recall.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import type { RuntimeTurnCoordinationView } from "./turn-coordination.js";
import type { RuntimeTurnTimingView } from "./runtime-turn-timing.js";
import type { RuntimeLifecycleView } from "./runtime-lifecycle.js";
import type { RuntimeNotificationSealView } from "./runtime-notification-seal.js";
import type { RuntimeModelSelectionView } from "./runtime-model-selection.js";
import type { RuntimeSessionPersistenceView } from "./runtime-session-persistence.js";
import type { RuntimePermissionGrantView } from "./runtime-permission-grant.js";
import type { RuntimeModelChangeTimelineView } from "./runtime-model-change-timeline.js";
import type { RuntimeCacheDiagnosticsView } from "./runtime-cache-diagnostics.js";

// ─────────────────────────────────────────────────────────────────────────────
// AgentRuntimeInternal 状态所有权分簇（specs/runtime-state-ownership.md）。
//
// 背景：methods/ 下 102 个文件经 installAgentRuntimeMethods 原型注入共享同一个
// `this: AgentRuntimeInternal`，93 个 property 曾以扁平列表堆放，任何新模块都
// 能悄悄读写任意字段，时序不变量只存在于注释（2026-10-05 深度审查 P2）。
// 分簇仍保留扁平读面；CLI-05 将 reservation/drain/generation 委托给私有 owner，
// 只提供 readonly getter，写者显式使用有限 port。其余簇继续明确所有者语义——
// 新增字段必须先回答「属于哪个簇、谁是唯一写入方」，跨簇读写在评审时可见。
// 簇间时序不变量清单与断言化计划见 spec；分簇接口不导出（避免扩公共 API 面）。
// ─────────────────────────────────────────────────────────────────────────────

/** 身份与构造期配置：runtime 生命周期内不变（唯一写入方 = 构造函数）。 */
interface RuntimeIdentityConfig {
  sessionId: SessionId;
  config: AgentRuntimeConfig;
  appVersion: string;
  workingDirectory: string;
  workspaceRoot: string;
  rootTraceContext: TraceContext;
  logger?: Logger;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
}

/** 注入依赖端口：构造期固定、无 late binding（唯一写入方 = 构造函数）。 */
interface RuntimeInjectedDeps {
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  eventSinks: Set<SessionEventSink>;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  /** 产品 scratch 暂存区根（R5.2，spec managed-policy-floor-and-bypass-immune-breakers.md）：
   * 构造期注入、生命周期内不变（唯一写入方 = 构造函数）；消费方 = context builder（提示词引导）。 */
  scratchRoot?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * 脚本工作流端口（RunWorkflow 那套，与 dwf 的 dynamicWorkflowRunPort 并列而非同一物）。
   *
   * 暴露在 internal 上的唯一理由是 `stopBackgroundTask` 的 `local_workflow` 分派要拿它的
   * `cancel`——在此之前它只经 deps 流到工具执行器，runtime 方法面拿不到，于是脚本工作流的
   * 后台任务虽然把 `cancellable` 报成 true，取消分派却落进兜底的「不支持」，TaskStop 回答
   * "cannot be stopped"。装配方式与 dynamicWorkflowRunPort 同款：deps 注入、构造期固定。
   */
  workflowPort?: WorkflowPort;
  /**
   * K2 swarm plan 端口（specs/swarm-task-graph.md R5）：turn 后调度点（methods/turn.ts）
   * 与 plan 进展 reminder 的运行期消费面。deps 注入、构造期固定——与 dynamicWorkflowRunPort
   * 同款（端口本体由 bootstrap 在 runtime 构造前装配完成，无 late binding）。
   */
  swarmPlanPort?: SwarmPlanPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  /** 对话内可视化片段存储（specs/gen-ui-visualize.md）；构造期固定，无 late binding。 */
  visualizationFragmentStore?: VisualizationFragmentStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  agentTelemetry: RuntimeTelemetryFacade;
}

/**
 * 上下文与记忆状态：上下文构建、MCP/skill 装配与语义召回。
 * 写入方集中在 methods/context-*、helpers/project-memory-extraction、
 * helpers/memory-semantic-recall 与 MCP 启动路径。
 */
interface RuntimeContextMemoryState {
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /**
   * 当前请求的工具搜索 context（specs/tool-search.md R8）：请求准备单点写入，
   * executor deps 经 getToolSearchContext 读取注入 handler；undefined = 未启用。
   * 发现集合唯一所有者是请求决策（每次准备重建），这里只是 executor 的读取缝，
   * 不建第二缓存。
   */
  toolSearchContext?: import("@acode/contracts").ToolSearchExecutionContext;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  latestContextBuildResult?: ContextBuildResult;
  memoryRoot?: string;
  memoryIndexContent?: string;
  /** 提示词文件路由（specs/stable-prefix-pause-gate.md R5）：ensureContextInitialized 的 async 面加载；无文件=空对象=零行为变化。 */
  promptFileRouting?: PromptFileRouting;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  /**
   * K1 会话级语义召回通道（specs/memory-semantic-recall.md R6/R9）：injector（含四层
   * 去重账本）+ 检索管线 + 度量账本。会话唯一所有者（非模块级全局），首轮检索时惰性
   * 构造；resume/rewind 不跨会话复用。
   */
  memorySemanticRecallChannel?: MemorySemanticRecallChannel;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  mcpInitializationPromise?: Promise<void>;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  skillLoadOutcome?: SkillLoadOutcome;
  residencyBlockingWorkCount: number;
}

/**
 * turn 生命周期状态：时序不变量最密集的一簇（唯一写入方 = turn 编排路径：
 * methods/turn.ts、methods/prompt-admission.ts、command-queue drain）。
 * 关键不变量（目前由注释+测试钉住，断言化计划见 specs/runtime-state-ownership.md）：
 * - activeTurnStartReservation 建立前不得出现第二条 turn（prompt-admission.ts:15-19）；
 * - runtimeCommandDrainActive 期间不得重入 drain；
 * - branchGeneration 单调递增，resume/rewind 重建后旧分支写入必须被拒。
 *
 * 高频时序字段（turnNumber、activeTurn、pendingInput 系列、queue drain 系列）已收敛到
 * RuntimeTurnTimingView 的只读 getter（runtime-turn-timing.ts owner，CLI-05 P1 第一切片）：
 * `this.X = ...` 在运行时抛 TypeError、tsc 下报 readonly 违例，写面只经
 * getRuntimeTurnTimingPort(this) 的有限端口。activeForegroundExecution、foregroundPromotionLease、
 * runtimeCommandQueue、currentTurnFileChanges 仍为扁平可写，登记为后续批次
 * （spec 的 RuntimeTurnState 剩余字段）；lastAssistantCompletedAtMs 已迁出至
 * RuntimeCacheDiagnosticsView（R1-01 B1）。
 */
interface RuntimeTurnState extends RuntimeTurnCoordinationView, RuntimeTurnTimingView {
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  runtimeCommandQueue: RuntimeCommandQueue;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
}

/** 消息 ID 投影：event 发布路径派生的最近 ID 游标（写入方 = 事件发布/reducer 路径）。 */
interface RuntimeMessageProjectionState {
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  // lastRequestModelId 已迁出至 RuntimeCacheDiagnosticsView（R1-01 B1，cache 归因输入）。
  lastEmittedLocalDate?: string;
}

/**
 * 缓存与压缩诊断：进程内累计，resume/rewind 重建后从空开始（写入方 = 模型请求路径）。
 * R1-01 B1：4 个 cache 字段 + 迁入的 lastRequestModelId + lastAssistantCompletedAtMs 已全部
 * 收敛到 RuntimeCacheDiagnosticsView 的只读 getter（runtime-cache-diagnostics.ts owner），
 * 写面只经 getRuntimeCacheDiagnosticsPort(this) 的有限端口。本接口不再持有扁平可写字段。
 */
interface RuntimeCacheDiagnosticsState extends RuntimeCacheDiagnosticsView {}

/** 会话级状态与生命周期旗标：一次性 flag 与开关（各自的消费点即写入点，评估即消费）。 */
interface RuntimeSessionLifecycleState
  extends RuntimeLifecycleView,
    RuntimeNotificationSealView,
    RuntimeModelSelectionView,
    RuntimeSessionPersistenceView,
    RuntimePermissionGrantView,
    RuntimeModelChangeTimelineView {}

export interface AgentRuntimeInternal
  extends
    AgentRuntimeCoreMethods,
    AgentRuntimeTurnMethods,
    AgentRuntimeHookMethods,
    RuntimeIdentityConfig,
    RuntimeInjectedDeps,
    RuntimeContextMemoryState,
    RuntimeTurnState,
    RuntimeMessageProjectionState,
    RuntimeCacheDiagnosticsState,
    RuntimeSessionLifecycleState {}
