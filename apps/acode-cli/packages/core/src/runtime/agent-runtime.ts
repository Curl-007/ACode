/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
import { DEFAULT_ACODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@acode/shared";
import type { BackgroundBashOutputResult } from "@acode/shared";
import type { PromptCacheMissCause, ToolSearchExecutionContext } from "@acode/contracts";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type {
  CollaborationMode,
  Logger,
  BackgroundTaskCancelResult,
  SessionEvent,
  MessageId,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  ModelToolContract,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  ProjectId,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionGoal,
  SavedWorkflowScope,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  SwarmPlanProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
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
  ToolCallId,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  ToolCall,
  TurnState,
  MessageHistory,
  ReadFileStateMap,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  ExecutionShellSelection,
  HookRunner,
  TurnId,
} from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";
// SessionEnd 公开桥接的本体（specs/hook-event-surface.md F1）：触发函数住在
// methods/hooks-extended.ts，经 hooks.ts 再导出——导入路径与既有消费者一致。
import { runSessionEndHooks as runSessionEndHooksTrigger } from "./methods/hooks.js";
import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";
import type { ConcurrencyDiagnosticsSnapshot } from "./methods/concurrency-diagnostics.js";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type {
  ModelConnectivityTestInput,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./methods/workspace-generate-text.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import type {
  ActiveTurnInfo,
  ActiveForegroundExecutionState,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContinueActiveTargetLoopOptions,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ForegroundPromotionLeaseMode,
  ForegroundPromotionLeaseState,
  PendingModelChangeTimeline,
  PermissionDecisionResult,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
  ResumeSessionOptions,
  ResumeSessionResult,
  RuntimeConfigUpdatePatch,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
// 跨回合 auto-resume（specs/turn-auto-resume.md）：shutdown 收口 + /auto-resume 命令面。
import { disposeAutoResumeCoordinator } from "./auto-resume/runtime-api.js";
import type { AutoResumeRuntimeCommand, AutoResumeStatusSnapshot } from "./auto-resume/types.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/contract.js";
import type { SwarmPlanPort } from "../swarm/port.js";
import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { MemorySemanticRecallChannel } from "./helpers/memory-semantic-recall.js";
import type { PromptFileRouting } from "../context/prompt-files.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
// 会话终结的技能缓存清理（skill-frontmatter-governance R4/R5/R6 消费接线）。
import { clearSessionSkillActivationScope } from "../agent/skill-activation-scope.js";
import { clearSkillPathActivations } from "../agent/skill-path-activation.js";
import { clearConflictHistories } from "../tool/conflict/index.js";
import { clearUserInvokedSkillMarker } from "../agent/skill-user-invocation.js";
import { initializeRuntimeTurnCoordination } from "./turn-coordination.js";
import { initializeRuntimeTurnTiming } from "./runtime-turn-timing.js";
import { getRuntimeLifecyclePort, initializeRuntimeLifecycle } from "./runtime-lifecycle.js";
import { initializeRuntimeNotificationSeal } from "./runtime-notification-seal.js";
import { initializeRuntimeModelSelection } from "./runtime-model-selection.js";
import { initializeRuntimeSessionPersistence } from "./runtime-session-persistence.js";
import { initializeRuntimePermissionGrant } from "./runtime-permission-grant.js";
import { initializeRuntimeModelChangeTimeline } from "./runtime-model-change-timeline.js";
import { initializeRuntimeCacheDiagnostics } from "./runtime-cache-diagnostics.js";
import { initializeRuntimeForegroundExecution } from "./runtime-foreground-execution.js";
import { initializeRuntimeMessageProjection } from "./runtime-message-projection.js";
import {
  getRuntimeContextInitPort,
  initializeRuntimeContextInit,
} from "./runtime-context-init.js";
import { initializeRuntimeMcpLifecycle } from "./runtime-mcp-lifecycle.js";
import { initializeRuntimeToolCache } from "./runtime-tool-cache.js";
import { initializeRuntimeSidecar } from "./runtime-sidecar.js";

/**
 * 工作区身份根的构造期归一化（specs/subagent-parent-inheritance.md R1）：
 * 显式 config.workspaceRoot 优先（子代理派生传父 runtime 的锁定根——父 Bash cd 漂移后，
 * 若回退到漂移的 workingDirectory，breaker.pathEscapeWrite 会对工作区内文件误报）；
 * 缺省/空白回退 workingDirectory（主会话等既有构造点行为不变）。
 * 与 resolveSubagentPermissionMode 同一先例：导出纯函数供测试钉住优先级。
 */
export function resolveRuntimeWorkspaceRoot(
  config: Pick<AgentRuntimeConfig, "workspaceRoot" | "workingDirectory">,
): string {
  const explicit = config.workspaceRoot?.trim();
  return explicit && explicit.length > 0 ? explicit : (config.workingDirectory ?? ".");
}

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  private sessionId: SessionId;
  declare private readonly turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private scratchRoot?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  // R1-01 B4：ContextMemory 19 字段已全部收敛——
  // messageHistory / contextBuilder / contextInitialized / contextSourceSnapshot /
  // latestContextBuildResult / memoryRoot / memoryIndexContent / promptFileRouting /
  // skillLoadOutcome 归 RuntimeContextInitOwner（runtime-context-init.ts）；
  // mcpInitialized / mcpStartupPromise / mcpInitializationPromise / mcpToolsRegistered 归
  // RuntimeMcpLifecycleOwner（runtime-mcp-lifecycle.ts）；cachedTools / toolSearchContext 归
  // RuntimeToolCacheOwner（runtime-tool-cache.ts）；memoryExtractionScheduler /
  // memorySemanticRecallChannel / residencyBlockingWorkCount 归 RuntimeSidecarOwner
  // （runtime-sidecar.ts）。declare readonly getter 由各 initializeRuntime* 在构造期安装；
  // 迁移前的扁平默认值（cachedTools=null、contextInitialized=false、
  // residencyBlockingWorkCount=0 等）全部下沉到 owner 默认值。
  declare private readonly messageHistory: MessageHistory;
  // readFileState 零 method 重赋值（唯一赋值在构造期），与 runtimeCommandQueue 同款：
  // 构造期不可写数据属性 + 类型级 readonly，不进 owner。
  declare private readonly readFileState: ReadFileStateMap;
  declare private readonly cachedTools: ModelToolContract[] | null;
  declare private readonly toolSearchContext?: ToolSearchExecutionContext;
  declare private readonly contextBuilder: ContextBuilder | null;
  declare private readonly contextInitialized: boolean;
  declare private readonly contextSourceSnapshot?: ContextSourceSnapshot;
  declare private readonly latestContextBuildResult?: ContextBuildResult;
  declare private readonly memoryRoot?: string;
  declare private readonly memoryIndexContent?: string;
  declare private readonly promptFileRouting?: PromptFileRouting;
  declare private readonly memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  declare private readonly memorySemanticRecallChannel?: MemorySemanticRecallChannel;
  declare private readonly skillLoadOutcome?: SkillLoadOutcome;
  declare private readonly mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  /** MCP tool registration owner：并发 initializeMcp 共享这一 promise。 */
  declare private readonly mcpInitializationPromise?: Promise<void>;
  declare private readonly residencyBlockingWorkCount: number;
  declare private readonly mcpInitialized: boolean;
  declare private readonly mcpToolsRegistered: boolean;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  private subagentPort?: SubagentPort;
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private workflowPort?: WorkflowPort;
  private swarmPlanPort?: SwarmPlanPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  declare private readonly branchGeneration: number;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  declare private readonly sessionPersisted: boolean;
  declare private readonly runtimeRestartReminderEmitted: boolean;
  // R1-01 B3：MessageProjection 4 字段已收敛到 RuntimeMessageProjectionOwner
  // （runtime-message-projection.ts），declare readonly getter 由
  // initializeRuntimeMessageProjection 在构造期安装。
  declare private readonly latestConversationMessageId?: MessageId;
  declare private readonly latestAssistantMessageId?: MessageId;
  declare private readonly latestAssistantTurnId?: TurnId;
  // R1-01 B1：cache 诊断 6 字段已收敛到 RuntimeCacheDiagnosticsOwner
  // （runtime-cache-diagnostics.ts），declare readonly getter 由 initializeRuntimeCacheDiagnostics
  // 在构造期安装。迁移前的扁平赋值（mainTurnCacheHitAggregate 字面量、cacheMissCauseCounts={}、
  // autoCompactConsecutiveFailures=0 等）全部下沉到 owner 默认值。
  declare private readonly mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  declare private readonly pendingCacheMissCause?: PromptCacheMissCause;
  declare private readonly cacheMissCauseCounts: Partial<Record<PromptCacheMissCause, number>>;
  declare private readonly lastRequestModelId?: string;
  declare private readonly lastAssistantCompletedAtMs?: number;
  declare private readonly autoCompactConsecutiveFailures: number;
  // R1-01 B2：TurnState 剩余 4 字段已收敛——activeForegroundExecution /
  // foregroundPromotionLease / currentTurnFileChanges 归 RuntimeForegroundExecutionOwner
  // （runtime-foreground-execution.ts），declare readonly getter 由
  // initializeRuntimeForegroundExecution 在构造期安装。runtimeCommandQueue 零 method
  // 写点（唯一赋值在构造期），declare readonly + 构造期不可写数据属性，不进 owner。
  declare private readonly currentTurnFileChanges: RuntimeTurnFileChangeMap;
  // R1-01 B3：日期游标同属 RuntimeMessageProjectionOwner（见上）。
  declare private readonly lastEmittedLocalDate?: string;
  declare private readonly runtimeCommandQueue: RuntimeCommandQueue;
  declare private readonly runtimeCommandDrainActive: boolean;
  declare private readonly activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  declare private readonly foregroundPromotionLease?: ForegroundPromotionLeaseState;
  declare private readonly activeTurn?: ActiveTurnSteeringState;
  declare private readonly activeTurnStartReservation:
    | Readonly<ActiveTurnStartReservation>
    | undefined;
  declare private readonly pendingInputSequence: number;
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  declare private readonly pendingInputReservations: ReadonlyMap<string, string>;
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  declare private readonly queueAutoDrain: boolean;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  declare private readonly queueExternalDrainActive: boolean;
  declare private readonly pendingInputDrains?: number;
  declare private readonly shuttingDown: boolean;
  declare private readonly pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private agentTelemetry: RuntimeTelemetryFacade;

  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    // turnNumber 归 RuntimeTurnTimingOwner（CLI-05 P1）：构造期不再直接赋值，
    // owner 以 0 起始，写面只经 getRuntimeTurnTimingPort 的 advanceTurn/setTurnNumber。
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = projectPersistentAgentMemoryTools({
      ...config,
      modelContextBudgetStrategy: DEFAULT_ACODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    Object.assign(this.config, resolveExecutionState(config));
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.scratchRoot = deps.scratchRoot;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    // R1-01 B4：messageHistory 归 RuntimeContextInitOwner（构造期默认值 = owner 初始值
    // new MessageHistoryImpl()，resume 整体替换经 resetForResume 端口）；readFileState
    // 零 method 重赋值——构造期装不可写数据属性（与下方 runtimeCommandQueue 同款），
    // 容器内容变更（set/delete  hydrate 等）是设计内行为。
    Object.defineProperty(this, "readFileState", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: new Map(),
    });
    // R1-01 B2：runtimeCommandQueue 零 method 写点——构造期装不可写数据属性，引用
    // 不可替换（运行时赋值/重定义抛 TypeError，tsc 下报 readonly 违例）；容器内容
    // 变更（enqueue/dequeueNextBatch/removeById/...）经 queue 方法是设计内行为。
    Object.defineProperty(this, "runtimeCommandQueue", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: createRuntimeCommandQueue(),
    });
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    initializeRuntimeTurnCoordination(runtime);
    // turn 时序字段 owner（CLI-05 P1）：必须先于任何 createDefaultSubagentPort /
    // startMcpStartup / 原型注入 method 的读面安装只读 getter，之后 `this.turnNumber`
    // 等只读、赋值走 getRuntimeTurnTimingPort。
    initializeRuntimeTurnTiming(runtime);
    initializeRuntimeLifecycle(runtime);
    initializeRuntimeNotificationSeal(runtime, () => this.config.taskType === "subagent_child");
    initializeRuntimeModelSelection(runtime, config.modelSelection);
    initializeRuntimeSessionPersistence(runtime);
    initializeRuntimePermissionGrant(runtime);
    initializeRuntimeModelChangeTimeline(runtime);
    // R1-01 B1：cache 诊断 6 字段 owner，与上述 owner 同款——必须先于任何 method 读面。
    initializeRuntimeCacheDiagnostics(runtime);
    // R1-01 B2：foreground execution / promotion lease / turn file changes owner，同款。
    initializeRuntimeForegroundExecution(runtime);
    // R1-01 B3：消息投影 4 游标字段 owner，同款——必须先于任何 method 读面。
    initializeRuntimeMessageProjection(runtime);
    // R1-01 B4：ContextMemory 18 字段归 4 个子 owner（context-init / mcp-lifecycle /
    // tool-cache / sidecar），同款——必须先于任何 method 读面（含下方
    // createDefaultSubagentPort / initializeRuntimeTooling / startMcpStartup 与
    // 构造期 contextBuilder 分支）。
    initializeRuntimeContextInit(runtime);
    initializeRuntimeMcpLifecycle(runtime);
    initializeRuntimeToolCache(runtime);
    initializeRuntimeSidecar(runtime);
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // 脚本工作流端口：runtime 方法面唯一 consumers 是 stopBackgroundTask 的 local_workflow
    // 分派（internal.ts 字段注释记了漏接它的后果）。
    this.workflowPort = deps.workflowPort;
    // K2 swarm plan 端口：turn 后调度点与 reminder 的运行期消费面（internal.ts 字段注释）。
    this.swarmPlanPort = deps.swarmPlanPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    // 工作区身份根：显式 config.workspaceRoot（子代理继承父锁定根）优先，
    // 缺省回退 workingDirectory——cd 漂移只应改变相对路径解析，不改变工作区身份
    // （specs/subagent-parent-inheritance.md R1；与 setWorkingDirectory 同一不变量）。
    this.workspaceRoot = resolveRuntimeWorkspaceRoot(config);
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    // R1-01 B4：contextBuilder/contextInitialized 归 RuntimeContextInitOwner，写面经端口
    // （原 `this.contextBuilder = deps.contextBuilder ?? null; if (...) { ...;
    // this.contextInitialized = true; }` 逐点等价：builder 提交 → 历史初始化 → 单调提交）。
    const injectedContextBuilder = deps.contextBuilder ?? null;
    if (injectedContextBuilder) {
      const contextInitPort = getRuntimeContextInitPort(runtime);
      contextInitPort.commitContextBuilder(injectedContextBuilder);
      runtime.initializeMessageHistoryFromContext(injectedContextBuilder, this.rootTraceContext);
      contextInitPort.markContextInitialized();
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }

  async closeBrowserSession(): Promise<void> {
    this.beginShutdown();
    disposeNodeReplSession(this.sessionId);
    try {
      await this.browserControlPort?.closeSession?.({
        sessionId: this.sessionId,
        traceContext: this.rootTraceContext,
      });
    } catch (error) {
      // browser backend 清理失败不能阻断 execution/MCP/session store 的主关闭链路。
      this.logger?.warn("Browser session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.session_cleanup.failed",
      });
    }
  }

  beginShutdown(): void {
    // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
    // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
    // shuttingDown 归 RuntimeLifecycleOwner（CLI-05 I4）：只能经 commitShutdown
    // 单调提交一次，重复 beginShutdown 不会回退，也没有布尔 setter 可绕过。
    getRuntimeLifecyclePort(this).commitShutdown();
    // 跨回合 auto-resume 的定时器纪律（specs/turn-auto-resume.md）：进程退出/会话
    // 关闭必须取消 pending 自动继续定时器——进程亡即重试链亡，不留幽灵续跑。
    disposeAutoResumeCoordinator(this as unknown as AgentRuntimeInternal);
    // 关闭单个 session 后进程仍存活，
    // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
    this.memoryExtractionScheduler?.shutdown();
    // 会话终结即清（skill-frontmatter-governance R4/R5/R6 消费接线）：技能激活期
    // 作用域缓存、paths 触发激活集与用户指名标记都是会话键控——进程存活的
    // 多会话轮转不留陈旧状态。
    clearSessionSkillActivationScope(this.sessionId);
    clearSkillPathActivations(this.sessionId);
    clearUserInvokedSkillMarker(this.sessionId);
    // 冲突注册表同为会话键控进程态（specs/conflict-uri-resolution.md R2）。
    clearConflictHistories(this.sessionId);
  }

  /**
   * SessionEnd hook（specs/hook-event-surface.md F1）：shutdown 漏斗的公开桥接——
   * bootstrap session-facade.close 在 beginShutdown 之后调用。本体是
   * methods/hooks-extended.ts 的「runtime 显式首参」普通函数（spec D6 形态），
   * 这里只做公开面绑定与缺省 trace context 解析。通知类且内含 containment
   * （hook 故障只 warn）；调用方另加超时闸门（abort 收掉在飞 hook 进程）。
   */
  runSessionEndHooks(
    input: { reason: string },
    traceContext?: TraceContext,
    signal?: AbortSignal,
  ): Promise<void> {
    return runSessionEndHooksTrigger(
      this as unknown as AgentRuntimeInternal,
      input,
      traceContext,
      signal,
    );
  }
}

export interface AgentRuntime {
  /** v4 bridge 只读投影；写面仅 RuntimePermissionGrantOwner 的 set 端口（CLI-05 I7）。 */
  readonly lastPermissionGrantId?: string;
  beginShutdown(): void;
  closeBrowserSession(): Promise<void>;
  /** SessionEnd hook（specs/hook-event-surface.md F1）：通知类、内含 containment；调用方加超时闸门。 */
  runSessionEndHooks(
    input: { reason: string },
    traceContext?: TraceContext,
    signal?: AbortSignal,
  ): Promise<void>;
  updateConfig(patch: RuntimeConfigUpdatePatch): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  /**
   * D5 并发只读诊断投影（specs/concurrency-diagnostics-projection.md）：tool scheduler /
   * dynamic-workflow / Plan Explore / subagent 后台四域的 caps/current/degraded 统一快照。
   * 纯投影——供 debug 日志与文档引用，不改变任何调度决策，参数调整权留在各域。
   */
  getConcurrencyDiagnostics(): ConcurrencyDiagnosticsSnapshot;
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;
  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;
  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;
  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。 */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /**
   * v4 heldQueueDisposition=clearQueueAndSend 执行件：
   * 清空全部排队输入（active turn 内存项 + held 投影残留），返回丢弃条数。
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级）。 */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列外层 FIFO 已消费到空，恢复后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级）。 */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;
  /** v4 switchModelConfig：模型选型变化后补发 ModelSelected（config/marker 投影）。 */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;
  /** v4 switchCollaborationMode：协作模式切换后补发 SessionModeChanged（config.mode 投影）。 */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  getToolRegistry(): ToolRegistry;
  /**
   * 注册表被外部改写后让 getTools 重算。公开它的唯一使用者是 dwf driver 的 submit profile 运行时
   * 守卫：静态 profile 与实际 ask 不符时把
   * typed 的 submit_result 换回通用声明——改的是同一个注册表，缓存不失效就会继续把旧声明发给模型。
   */
  invalidateToolCache(): void;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  /**
   * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store，供 class 外构造的子
   * runtime 共享（照 `subagent.ts` 的 `eventStore: this.eventStore`）。理由见
   * `methods/config.ts` 的实现注释。
   */
  getSessionEventStore(): SessionEventStorePort;
  /**
   * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集
   * （保留子 sessionId、只通知不 append）。**必须在子 runtime 构造期装成它的
   * `deps.eventSink`**——理由见 `methods/config.ts` 的实现注释。
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 外部子 runtime 的接缝（三）：铸造子 runtime 的对外交互端口（permission broker +
   * provider runtime headers），已绑定本 runtime 的客户端路由身份。class 外构造的子 runtime
   * **必须**经这里取这两个端口，不能自行从 appOptions 取——理由见 `methods/config.ts` 的实现注释。
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;
  getContextBuilder(): ContextBuilder;
  /** Composer 使用的 Session Skill 快照；同一 runtime 冻结，runtime 重建后重新发现。 */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** workflow run 进度的出回合追加（事件源在 bootstrap 的 run service）。 */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** swarm plan 提交投影的出回合追加（事件源在 bootstrap 的 swarm-plan-runtime）。 */
  recordSwarmPlanProgress(
    input: SwarmPlanProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** 恢复的 workflow run 的追踪重臂（registry 登记 + started 事件 + waiter + 结算通知）。 */
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 中枢直接启动一个已保存的工作流：解析 + 校验 + 编译，
   * 干净则 submit 启动 run、落 controlOnly 启动轮、登记后台追踪。`app.startSavedWorkflow` 能力的
   * 落地实现（端口在场时注册）。
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run、登记后台追踪、把设置轮排进队列。
   * `app.amendWorkflowRunSettings` 能力的落地实现。
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  /** 级联收口在飞子代理（specs/subagent-nesting-budget.md R5-2）；返回停止数。 */
  stopInFlightSubagentTasks(input: {
    reason: "subagent_cancelled" | "subagent_terminal";
    traceContext?: TraceContext;
  }): Promise<number>;
  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;
  getSessionId(): SessionId;
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
    // overnight 隐藏 coordinator 的落盘身份覆盖（specs/overnight-execution.md R1a）。
    hiddenCoordinatorTitle?: string;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  /**
   * conversation edit/retry 的 same-session branch cut primitive。
   *
   * 该入口故意不经过 executeTurn command queue：组合文件 rewind 会在文件事务的
   * commit gate 内调用它；若再排队 `/rewind`，当前 edit command 会等待自己释放队列。
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;
  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  /** 缺省等待最多 60 秒；null 等待全部已调度提取结束，不设置 drain deadline。 */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
  /**
   * /auto-resume 命令面（specs/turn-auto-resume.md）：进程内状态只读投影
   * （开关/暂停到期/自定义消息/当前会话计数与重复签名次数）。
   * optional 成员先例（concurrencyBuckets?/tryAcquire?）：缺席 = 宿主未装配，
   * 命令模块回执「不可用」，不得猜测。
   */
  getAutoResumeStatus?(): AutoResumeStatusSnapshot;
  /**
   * /auto-resume 命令面的进程内写入点（enable/pause/continue message overlay）；
   * config 持久化在 bootstrap app 层另行叠加（照 /locale 写 config 先例）。
   */
  applyAutoResumeCommand?(input: AutoResumeRuntimeCommand): void;
}

installAgentRuntimeMethods(AgentRuntime);
