import {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/contract.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { createAutoRiskClassifier } from "../methods/auto-risk-classifier-sidecar.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    // SendMessage 注册门（specs/agent-peer-messaging.md R2）：父会话按 subagentPort 的
    // sendMessage 能力（现状）；child 会话按 peer 窄面在场（R0 flag 开启时由 runner 注入）。
    // 两入口同规则纪律（tool-allowlist.ts）：embedded-search-branch 对本门是「只有 true
    // 才注册」的省略安全侧，无需重复。
    includeSendMessage:
      runtime.subagentPort?.sendMessage !== undefined || Boolean(deps.peerMessagingPort),
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // submit_result 只在注入了 workflowSubmitPort 的 workflow actor 会话注册。以端口存在为门，
    // 与 taskType 无关：workflow actor 是 workflow_child，其 runtimeScope 目前是 "main"。
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // mono 子代理：typed 声明。门仍是端口。
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate 与 submit_result 同门同理由：端口在场即注册（不做 opt-in：最可能撞墙的 actor 恰是作者没标记的那个）。
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    includeAutomation: Boolean(deps.automationPort) && runtime.config.taskType !== "subagent_child",
    // K2 swarm plan 工具族（specs/swarm-task-graph.md R5 注册门）：端口在场即注册；
    // 只读面推导与 includeAutomation 的 taskType 排除同款先例——workflow 子会话
    // （swarm worker 是无名 workflow 子会话）只见 PlanStatus，图变更工具仅主对话，
    // 防 worker 自改图；subagent 子会话整体不暴露（封闭域，无 plan 可协调）。
    ...(deps.swarmPlanPort === undefined || runtime.config.taskType === "subagent_child"
      ? {}
      : {
          swarmPlanPort: deps.swarmPlanPort,
          swarmPlanReadOnly: runtime.config.taskType === "workflow_child",
        }),
    // offPeakPort 只在 host 下发 offPeakToolEnabled 时注入（灰度/远程门在 host 端），
    // 端口存在即代表曝光允许；subagent 子会话与 automation 同规则不暴露。
    includeOffPeak: Boolean(deps.offPeakPort) && runtime.config.taskType !== "subagent_child",
    // K6 ambient Schedule 工具（specs/ambient-budget-scheduler.md R2/场景 10）：门 =
    // config.ambient.enabled 显式 true（缺省 false——开启是显式用户决策，spec 红线）
    // && 非封闭子会话（F10，批次C：subagent_child 之外，workflow_child 与
    // nested_workflow_child 也不得注册——swarmPlanReadOnly 的收紧先例同款；workflow
    // 子会话是编排域的执行单元，不该再自建唤醒提议，也无主对话可投递 target=session
    // 提醒）&& 端口在场（bootstrap 装配的 queue 与 nudge 闭包；automationPort 同款
    // 流向）。sessionId 取 runtime 自己的——创建来源会话即提醒投递目标。
    ...(deps.ambientSchedulePort === undefined ||
    runtime.config.ambient?.enabled !== true ||
    runtime.config.taskType === "subagent_child" ||
    runtime.config.taskType === "workflow_child" ||
    runtime.config.taskType === "nested_workflow_child"
      ? {}
      : {
          includeAmbientSchedule: true,
          ambientSchedule: {
            queue: deps.ambientSchedulePort.queue,
            sessionId: String(runtime.sessionId),
            ...(deps.ambientSchedulePort.onScheduleCreated === undefined
              ? {}
              : { onScheduleCreated: deps.ambientSchedulePort.onScheduleCreated }),
          },
        }),
    // 动态工作流灰度门：与 off-peak 相反，
    // 这里不能用端口在场做判据——十个工具的端口在任何 CLI 里都装配齐全，灰度是 Host 的决定。
    // 取值收在 tool-allowlist.ts，与分支刷新那个入口共用同一个推导。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime.config),
    // browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ACode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    includeBrowserUse: browserUseEnabled,
    // Open 工具的平台门：宿主注入 platformOpenPort 才注册（K9 R2）。
    platformOpenPort: deps.platformOpenPort,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    agentProfiles: runtime.config.subagents?.profiles,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // workflow_child 的结构性禁用（CreateWorkflow/SaveWorkflow 因 alwaysAsk 隐形挂起；
    // ResumeWorkflowRun 已免确认但因「child 内不得再编排」仍在列）在 helper
    // 里与 turn 级名单合并，见 tool-allowlist.ts 的根因注释。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
  });
}

function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    agentTelemetry: runtime.agentTelemetry.port,
    agentTelemetryActorKind: runtime.agentTelemetry.actorKind,
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    // auto 模式灰区分类器（specs/auto-mode-risk-classifier.md R2）：装配点唯一在此
    //（runtime 在作用域处构造 sidecar 闭包）；子代理 child runtime 走同一 helper
    // 自动获得；不把 runtime 本体传进 deps（分层纪律）。
    autoRiskClassifier: createAutoRiskClassifier(runtime),
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // 合并删除旧模型连接时曾漏掉此端口；Read 分页渲染与整份 PDF 页数检查仍依赖宿主注入。
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    readFileState: runtime.readFileState,
    // 工作流创作工具的技能门（tool/handlers/workflow-skill-gate.ts）：按模型此刻看得见的历史回答
    // 「读过技能没有」。只在会话真有 Skill 工具时给探针——没有 skillPort 的会话装不上那个技能，
    // 门若仍然在场就成了一道谁也过不去的墙。
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
