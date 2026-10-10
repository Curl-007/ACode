/* eslint-disable max-lines -- subagent runtime wiring 集中衔接 child runtime、tool pool、权限、MCP 与 activity watchdog，拆分需单独迁移。 */
import {
  createMessageId,
  createSessionId,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
} from "@acode/contracts";
import type { SessionId, SubagentRunOptions } from "@acode/contracts";
import {
  defaultScheduler,
  PermissionService,
  defaultPermissionConfig,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  createExploreSubagentPort,
  createCoreError,
  CoreErrorType,
} from "../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  McpConnectionSnapshot,
  McpPort,
  Model,
  ModelSelection,
  SkillContent,
  SkillLoadOutcome,
  SkillOperationOptions,
  SkillPort,
  SubagentPort,
} from "../deps.js";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { resolveSubagentSelection } from "../helpers/subagent-selection.js";
import type { AgentRuntimeDeps } from "../types.js";
import { toMcpToolName } from "../../mcp/index.js";
import { createBorrowedSubagentMcpAccess } from "../../subagent/borrowed-mcp-port.js";
import { createSubagentMessageSink } from "../../subagent/message-steering.js";
import {
  extractRequiredMcpServerNames,
  matchesRequiredMcpServer,
} from "../../subagent/mcp-config.js";
import { mirrorSubagentToolEvent } from "../../subagent/tool-event-mirror.js";
import { bindSubagentEdgePersistence } from "../../subagent/edge-persistence.js";
import type { PeerMailboxWriteSeam, PeerMirrorInput } from "../../subagent/peer-messaging.js";
import {
  moreRestrictiveMode,
  resolveChildSubagentsEnabled,
} from "../../subagent/nesting-policy.js";
import { isBuiltInExploreAgentProfile } from "../../subagent/profile.js";
import {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} from "../../subagent/tool-policy.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { getSessionShellEnvironment } from "./session-shell-environment.js";
import { deriveChildClientPorts } from "../helpers/child-client-ports.js";
import { createCoordinatorResponsePort } from "../../subagent/coordinator-response.js";
import { isStaleBranchRuntimeTaskEvent } from "./runtime-command-generation.js";
import { loadPersistentAgentMemory } from "../../subagent/persistent-memory.js";
import {
  createOfficialCuaPolicy,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
  type OfficialCuaPolicy,
} from "../../subagent/computer-use-policy.js";
import { wrapSubagentPortWithForegroundPolicy } from "../../subagent/foreground-policy.js";
import { computeOfficialCuaServerNames } from "./mcp.js";

export function createDefaultSubagentPort(
  this: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): SubagentPort | undefined {
  if (this.config.subagents?.enabled === false) {
    return undefined;
  }

  // 一次性会话前台策略（subagent-background-tristate.md R3）：port 构造点单点强制——
  // 超时转后台直接失能，派发请求经 wrapper 重写为前台。runner 不感知会话形态。
  const foregroundPolicy = this.config.subagents?.backgroundPolicy === "foreground";
  // 编排方案 Phase 1（specs/subagent-topology-persistence.md R2/R8）：拓扑边持久化的
  // 能力探测——sessionStore 具备边表委托方法（SqliteSessionStore）即接上写入钩子；
  // 缺席（测试替身/未来远程 store）按无持久化降级，事件链行为不变、不伪装成功。
  const edgePersistence = bindSubagentEdgePersistence(this.sessionStore);
  // 编排方案 Phase 5 P1（specs/agent-peer-messaging-cross-process.md R0/R2）：跨进程
  // mailbox 写入接缝——env 门（ACODE_MESSAGE_ENABLED → deps.sessionMailboxPort）与
  // store 双在场才铸造。目标解析 = agentId↔childSessionId 恒等式纯推导（与 runner.ts
  // 的 childSessionId 派生同源）+ getSession 存在性校验；不建整树表（那是 P2）。
  // 缺席 = peer 对 registry 外目标按 P0 拒绝，行为逐字节不变。
  const mailboxPort = deps.sessionMailboxPort;
  const mailboxStore = deps.sessionStore;
  const peerMailbox: PeerMailboxWriteSeam | undefined =
    mailboxPort && mailboxStore
      ? {
          deliver: (input) => mailboxPort.deliver(input),
          resolveTargetSession: async (agentId): Promise<SessionId | undefined> => {
            const targetSessionId = createSessionId(`subagent_${agentId}`);
            const stored = await mailboxStore.getSession(targetSessionId);
            return stored ? targetSessionId : undefined;
          },
        }
      : undefined;
  const port = createExploreSubagentPort({
    logger: this.logger,
    inactivityTimeoutMs: this.config.subagents?.inactivityTimeoutMs,
    autoBackgroundMs: foregroundPolicy ? undefined : this.config.subagents?.autoBackgroundMs,
    outputRootDir: this.config.subagents?.outputRootDir,
    profiles: this.config.subagents?.profiles,
    builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
    runtimeTaskRegistry: this.runtimeTaskRegistry,
    // 编排方案 Phase 4 第二批（specs/subagent-nesting-budget.md R4/R5-1）：树级预算
    // **只计嵌套派发**——本 runtime 自己是子代理（subagentDepth ≥ 1）时才下发预算键，
    // 它派发的 depth≥2 孙代理受三闸约束；根会话的 depth-1 派发（今天的现实：并行兄弟 +
    // 后台代理）不进树级闸，并发语义逐字节不变（防的是 10^depth 嵌套失控，不是既有
    // 工作流；spec「未做与取舍」#7）。键 = 树根 sessionId（不是本 runtime 的会话，
    // 键纪律见 tree-budget.ts 头注），全树共享同一份计数。
    ...((this.config.subagentDepth ?? 0) >= 1
      ? { treeBudgetRootKey: String(this.config.rootSessionId ?? this.sessionId) }
      : {}),
    ...(this.config.offPeakSubagentExecution === true ? { offPeakInherited: true } : {}),
    emitParentEvent: async (event, traceContext) => {
      if (isStaleBranchRuntimeTaskEvent(this, event)) return;
      await this.appendEvent(event, traceContext);
    },
    ...(edgePersistence ? { persistSubagentEdge: edgePersistence.persist } : {}),
    // 编排方案 Phase 3（specs/agent-peer-messaging.md R0/R5）：peer 通信开关与持久镜像。
    // 开关装配期定值（默认关 = 子工具面零变化）；镜像按方案原文只用
    // persistSyntheticUserNoticeForSession（model-only 落共同父会话——冷目录/审计看得到
    // peer 流量，peer-3）。不注入 live messageHistory：peer 流量的参与者是两个 child，
    // 父模型不需要实时消费；冷恢复的 hydration 语义由 synthetic-notice-metadata 登记。
    ...(this.config.subagents?.peerMessaging?.enabled === true
      ? {
          peerMessaging: { enabled: true },
          // 整树寻址 P2（specs/agent-peer-tree-addressing.md R0/R5）：根键每层机械
          // 自算（rootSessionId 谱系事实），**无深度条件**——与预算键的 depth≥1 刻意
          // 不同：预算只计嵌套派发，寻址覆盖全树（depth-1 叔辈同样是跨层目标）。
          treeAddressingRootKey: String(this.config.rootSessionId ?? this.sessionId),
          // 跨进程 P1（specs/agent-peer-messaging-cross-process.md R0/R1）：mailbox
          // 写入接缝随 flag 一并下发；env 门关闭（接缝缺席）时 peer 行为与 P0 逐字节一致。
          ...(peerMailbox ? { peerMailbox } : {}),
          persistPeerMirror: async (input: PeerMirrorInput) => {
            await this.ensureContextInitialized(input.traceContext);
            await this.persistSyntheticUserNoticeForSession({
              messageID: createMessageId(),
              metadata: input.metadata,
              sessionId: this.sessionId,
              source: "peer_message",
              text: input.text,
              traceContext: input.traceContext,
              visibility: "model-only",
            });
          },
        }
      : {}),
    enqueueParentTaskNotification: (notification) => {
      this.enqueueBackgroundTaskNotification({
        originMeta: notification.originMeta,
        taskId: notification.taskId,
        text: notification.text,
        traceContext: notification.traceContext,
      });
      return undefined;
    },
    getAllowedTools: () => {
      return buildExploreAllowedTools({
        embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(),
      });
    },
    runExploreAgent: async (request, options) => {
      request.reportActivity?.();
      const builtInExplore = isBuiltInExploreAgentProfile(request.profile);
      const agentsMdInstructions =
        request.profile.injectAgentsMd !== false
          ? this.contextSourceSnapshot?.userInstructions
          : undefined;
      const { selection: profileChildSelection, hasConcreteModel } = resolveSubagentSelection({
        profileSelection: request.profile.modelSelection,
        parentSelection: this.getSessionModelSelection(),
        overrideSelection: options?.modelOverride?.selection,
        resolveSelection: deps.resolveEffectiveModelSelection,
      });
      const modelOverride = options?.modelOverride;
      const inheritedModel = !modelOverride && !hasConcreteModel ? options?.model : undefined;
      // Core Server override 优先于持久化 profile 与父模型继承，但仍只是标准 Selection。
      const childSelection = inheritedModel
        ? modelSelectionFromActiveModel(inheritedModel)
        : profileChildSelection;
      const embeddedSearchEnabled = resolveSubagentEmbeddedSearchEnabled();
      const baseChildEnvInfo = this.contextSourceSnapshot?.envInfo ??
        this.config.envInfo ?? {
          cwd: request.workingDirectory,
          platform: "unknown",
          shell: "unknown",
          osVersion: "unknown",
          nodeVersion: "unknown",
        };
      const shellEnvironment = getSessionShellEnvironment(this);
      const bashShellSelection = shellEnvironment?.selection;
      const childEnvInfo = {
        ...baseChildEnvInfo,
        ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
      };
      const baseAgentPrompt =
        builtInExplore && request.systemPrompt?.trim() === ""
          ? buildExploreAgentPrompt({ embeddedSearchEnabled })
          : request.systemPrompt?.trim();
      const persistentMemory = await loadPersistentAgentMemory({
        fileSystemPort: deps.fileSystemPort,
        logger: this.logger,
        memory: this.config.memory,
        profile: request.profile,
        traceContext: request.traceContext,
        workspaceRoot: request.workspaceRoot,
      });
      // 空 agent prompt 不是一个语义段；先硬拼 `\n\n` 会把缺失段的边界
      // 泄漏到 persistent Memory 开头。这里只组合非空正文，block 左边界由 builder 统一添加。
      const agentPrompt = [baseAgentPrompt, persistentMemory?.prompt]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n\n");
      const childRuntimeEnvInfo = {
        ...childEnvInfo,

        cwd: request.workingDirectory,
      };
      const officialCuaServerNames = computeOfficialCuaServerNames(
        this.config.mcp?.servers ?? {},
        new Set(this.config.mcp?.trustedOfficialCuaServerNames ?? []),
      );
      const preflightCuaPolicy = createOfficialCuaPolicy(
        officialCuaServerNames,
        [],
        this.config.pluginReferenceCatalog,
      );
      await validateSubagentComputerUseConfiguration(request, preflightCuaPolicy, this.skillPort);
      const childMcpAccess = await resolveSubagentMcpAccess.call(
        this,
        request,
        officialCuaServerNames,
      );
      // 编排方案 Phase 4（specs/subagent-nesting-budget.md R1/R3）：depth 谱系由父闭包
      // 自算（机械保证——request 构造方给不了错值，resumeFromStore 也读不回被篡改的
      // depth）。rootMode/rootSessionId 是链根建链时刻的快照：根会话取自身当前值，
      // 深层原样透传（根后续改模式不放宽天花板）。
      const childDepth = (this.config.subagentDepth ?? 0) + 1;
      const parentEffectiveMode = this.getPlanEnabled() ? "plan" : this.config.mode;
      const rootMode = this.config.rootMode ?? parentEffectiveMode;
      const childSubagentsEnabled = resolveChildSubagentsEnabled({
        childDepth,
        configuredMaxDepth: this.config.subagents?.maxDepth,
      });
      const childToolAllowlist = resolveSubagentToolAllowlist.call(
        this,
        request,
        childMcpAccess.snapshot?.tools.map((descriptor) => toMcpToolName(descriptor)) ?? [],
        { allowDispatch: childSubagentsEnabled },
      );
      validateSubagentMcpRequirements(request, childToolAllowlist, childMcpAccess);
      const childMode = resolveSubagentPermissionMode(
        parentEffectiveMode,
        request.permissionMode,
        builtInExplore,
        { depth: childDepth, rootMode },
      );
      const childCuaPolicy = createOfficialCuaPolicy(
        officialCuaServerNames,
        childMcpAccess.parentSnapshot?.tools ?? childMcpAccess.snapshot?.tools ?? [],
        this.config.pluginReferenceCatalog,
      );
      await validateSubagentComputerUseConfiguration(request, childCuaPolicy, this.skillPort);
      const childSkillPort = resolveSubagentSkillPort(
        this.skillPort,
        request.profile.skills,
        childCuaPolicy,
      );
      const baseChildModelFactory = modelOverride
        ? createSubagentOverrideModelFactory(modelOverride, this.modelFactory)
        : inheritedModel
          ? createInheritedSubagentModelFactory(childSelection, inheritedModel, this.modelFactory)
          : this.modelFactory;
      if (!baseChildModelFactory) {
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          `Subagent model factory cannot resolve ${childSelection.providerId}/${childSelection.modelId}`,
          { recoverable: true },
        );
      }
      const childModel = baseChildModelFactory({ selection: childSelection });
      const childModelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = (target) =>
        target.selection.providerId === childSelection.providerId &&
        target.selection.modelId === childSelection.modelId &&
        target.selection.options?.reasoningLevel === childSelection.options?.reasoningLevel
          ? childModel
          : baseChildModelFactory(target);
      const parentToolCallId = traceStringAttribute(request.traceContext, "parentToolCallId");
      // 对外交互端口（permission broker + provider runtime headers）：与 dwf actor、legacy
      // workflow child 共用同一条派生，路由身份统一落到本 runtime 的会话。
      const childClientPorts = deriveChildClientPorts(
        {
          permissionBroker: this.permissionBroker,
          ...(this.providerRuntimeHeadersPort === undefined
            ? {}
            : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
        },
        {
          agentId: request.agentId,
          agentType: request.agentType,
          childSessionId: request.sessionId,
          description: request.description,
          parentSessionId: this.sessionId,
          parentToolCallId,
          ...(request.traceContext.turnId === undefined
            ? {}
            : { parentTurnId: request.traceContext.turnId }),
        },
      );
      const mirroredToolNameByChildToolCallId = new Map<string, string>();
      let sessionReadyNotified = false;
      const notifySessionReady = async () => {
        if (sessionReadyNotified) return;
        await request.onSessionReady?.();
        sessionReadyNotified = true;
      };
      this.logger?.debug("Starting subagent child runtime", {
        parentSessionId: this.sessionId,
        childSessionId: request.sessionId,
        agentType: request.agentType,
      });
      const childRuntime = new AgentRuntime(
        request.sessionId,
        {
          // 旧 plan 枚举不包含基础权限；拆分后继承完整状态，避免被构造器回退成 build。
          mode: childMode === "plan" ? this.config.mode : childMode,
          planEnabled: childMode === "plan",
          // 编排方案 Phase 4（specs/subagent-nesting-budget.md R1/R3）：depth 谱系事实，
          // 父自填（机械保证）。rootSessionId 是树级预算的键（预算闸落地前预留给
          // origin 归属与审计），rootMode 是天花板锚根的快照。
          subagentDepth: childDepth,
          rootSessionId: this.config.rootSessionId ?? this.sessionId,
          rootMode,
          // 闲时轮 override 事实随谱系透传（specs/subagent-nesting-budget.md R5-1 /
          // 审计 §6.1）：显式 override 只作用当层，但 override 模型经 selection/model/
          // factory 三重继承链传到任意深度——depth-1 置位、深层原样继承，deny 门改判
          // 「有效 override」，孙层不再因 launchOptions 缺显式参数而放行 background。
          ...(options?.modelOverride?.background === "deny" ||
          this.config.offPeakSubagentExecution === true
            ? { offPeakSubagentExecution: true }
            : {}),
          // 模型选择的影响不只在最终 request.model：MCS、内建搜索与 token/media 预算会在
          // child runtime 内按 default model 预先塑形。同步 child 因此必须把整套执行
          // 配置都指向父 turn 快照；runner 禁止它转后台，provider registry 则由父 turn
          // finally 清理，快照不会成为可恢复的 session 配置。
          modelSelection: cloneModelSelection(childSelection),
          modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
          workingDirectory: request.workingDirectory,
          // 工作区身份锚定父的锁定根（specs/subagent-parent-inheritance.md R1）：
          // 修复依据——此前 child 的 workspaceRoot 由构造器回退到本行 driftable cwd，
          // 父 Bash cd 漂移后，child 写真实工作区内（漂移目录外）的文件会被
          // breaker.pathEscapeWrite 误报，任何模式（含 yolo）都弹审批。
          workspaceRoot: request.workspaceRoot,
          // 执行模型只由 child Active Model 投影进 Context；envInfo 不保存第二份模型事实。
          envInfo: childRuntimeEnvInfo,
          // Explore 子运行时之前没有继承主会话的流式配置，Protocol 桌面端虽已默认
          // 开启 modelStreaming，子请求仍会退回 generateText。部分 OpenAI-compatible 端点在
          // 非流式请求里也返回 SSE `data:` 帧，generateText 会按普通 JSON 解析并报
          // Invalid JSON response；继承父配置可让子 agent 与主链路走同一 streamText 语义。
          modelStreaming: this.config.modelStreaming,
          bashTimeoutPolicy: this.config.bashTimeoutPolicy,
          midConversationSystem: this.config.midConversationSystem,
          bashShellSelection,
          // child 只复用父 runtime 已解析的 instructions snapshot；Project Context 仍不继承。
          currentDate: this.contextSourceSnapshot?.currentDate ?? this.config.currentDate,
          subagentContext: {
            agentPrompt: agentPrompt ?? "",
            ...(agentsMdInstructions ? { userInstructions: agentsMdInstructions } : {}),
          },
          agentName: `acode-${request.agentType}`,
          parentSessionId: this.sessionId,
          taskType: "subagent_child",
          // 动态工作流灰度门必须结构性继承：
          // 父会话关着而子代理开着，等于 Agent 工具变成绕过灰度的后门。默认路径（child 继承
          // 父 registry 可见的工具名）本来就够，但**自定义 agent profile 显式写
          // `allowedTools: ["CreateWorkflow"]` 时会跳过那次交集**，只剩这一道能挡住。
          dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
          // 默认 subagent 已从 Explore 调整为 general-purpose。
          // toolset 不能再依赖 DEFAULT_SUBAGENT_TYPE，否则默认通用 agent 会被误降级为只读搜索工具面。
          toolset: builtInExplore ? "explore" : "main",
          toolAllowlist: childToolAllowlist,
          toolDisallowlist: this.config.toolDisallowlist,
          embeddedSearchBackend: this.config.embeddedSearchBackend,
          nativeSearchEnhancementsEnabled: this.config.nativeSearchEnhancementsEnabled,
          subagents: {
            backgroundBashMaxMs: this.config.subagents?.backgroundBashMaxMs,
            // 放开闸门（specs/subagent-nesting-budget.md R3/R4）：child 自己可再派发的
            // 唯一判据 = childDepth < 生效 maxDepth。树级预算闸落地前
            // resolveEffectiveSubagentMaxDepth 硬封 1（fail-closed）→ 本式恒 false，
            // 与原 enabled:false 写死逐字节等价；五道结构性保证的其余四道全部由本值派生。
            enabled: childSubagentsEnabled,
            // 策略值透传（装配期定值）：更深层用同一个 maxDepth 判定，逐层递增的只有
            // depth 事实。profiles 刻意不透传：孙代理只见内置目录（spec「未做与取舍」#4）。
            ...(this.config.subagents?.maxDepth === undefined
              ? {}
              : { maxDepth: this.config.subagents.maxDepth }),
            // 整树寻址 P2（specs/agent-peer-tree-addressing.md R6）：peerMessaging 与
            // maxDepth 同款逐层透传——嵌套放开时孙代理同样获得窄面（兄弟 + 整树 +
            // mailbox 三级链）；默认关 = 不透传 = 零变化。
            ...(this.config.subagents?.peerMessaging === undefined
              ? {}
              : { peerMessaging: this.config.subagents.peerMessaging }),
          },
          mcp: childMcpAccess.config,
        },
        {
          agentTelemetry: this.agentTelemetry.port,
          agentTelemetryCausation: this.agentTelemetry.captureCausation(),
          // 前台 child 的生命周期被父 Agent Tool await，使用真实父子 Span；后台 child
          // 可能晚于父 Tool/Turn 结束，只能作为独立 Trace 用 Link 保留因果关系。
          agentTelemetryCausationMode: request.background ? "linked_root" : "child",
          eventStore: this.eventStore,
          sessionStore: deps.sessionStore,
          // 编排方案 Phase 5 P1（specs/agent-peer-messaging-cross-process.md R7）：
          // child runtime 转发 mailbox 端口——活的 child session 由此获得自己的 hook
          // drain（createRuntimeHookRunner 对任意带该 dep 的 runtime 生效，零新机制），
          // 跨进程来件不再等到独立 resume 才被消费。env 门关闭 = 字段缺席 = 行为
          // 逐字节不变。
          ...(deps.sessionMailboxPort ? { sessionMailboxPort: deps.sessionMailboxPort } : {}),
          // 编排方案 Phase 3（specs/agent-peer-messaging.md R1/R2）：peer 窄面——flag
          // 开启时由 runner 随请求下发；SendMessage 注册门与 handler 分支经 executor
          // deps 消费。缺席 = child 无 SendMessage（现状，depth-1 故事不变）。
          ...(request.peerMessagingPort
            ? { peerMessagingPort: request.peerMessagingPort }
            : {}),
          // 子 runtime 继承父的模型请求准入端口：subagent 的请求 provider 同样看得见，
          // 它们该与父一样喂治理器信号（父是 observer 则子也是 observer）。
          modelRequestAdmission: this.modelRequestAdmission,
          modelFactory: childModelFactory,
          resolveEffectiveModelSelection: deps.resolveEffectiveModelSelection,
          // 子 runtime 自己仍使用 request.sessionId 做事件持久化和 trace 归档；对外阻塞交互
          // （permission / AskUserQuestion / provider runtime headers）一律路由回父 session——
          // 桌面 UI 只认识父 task 的 sessionId。派生收敛在 deriveChildClientPorts 一处，
          // dwf actor 与 legacy workflow child 走同一条。
          ...childClientPorts,
          coordinatorResponsePort: createCoordinatorResponsePort({
            agentId: request.agentId,
            agentType: request.agentType,
            childSessionId: request.sessionId,
            parentToolCallId,
            enqueue: (input) => this.enqueueSubagentMessage(input),
          }),
          // Explore 使用独立只读权限配置；general-purpose 和自定义 agent 继承父权限服务。
          permissionService: builtInExplore
            ? new PermissionService(defaultPermissionConfig)
            : this.permissionService,
          toolScheduler: deps.toolScheduler ?? defaultScheduler,
          executionPort: deps.executionPort,
          fileSystemPort: deps.fileSystemPort,
          // Explore 子运行时会暴露 WebFetch，但之前没有继承主 runtime 的
          // HTTP client port，导致工具在真正发请求前抛出配置错误，而不是网络请求失败。
          httpClientPort: deps.httpClientPort,
          imageProcessorPort: deps.imageProcessorPort,
          pdfDocumentPort: deps.pdfDocumentPort,
          memoryRoot: persistentMemory?.rootDir,
          mcpPort: childMcpAccess.port,
          skillPort: childSkillPort,
          artifactStore: deps.artifactStore,
          appVersion: this.appVersion,
          eventSink: {
            onSessionEvent: async (event) => {
              request.reportActivity?.();
              // child runtime 的事件已经按 childSessionId 落库，但旧链路只把
              // 少量工具事件镜像给 parent sink，导致 UI 订阅 child topic 后只能拿到打开时
              // 的 hydration，后续流式内容不会更新。raw child event 只通知父 runtime 的
              // 外部 sinks，不再次 append，因此不会重复持久化；bootstrap 再按 event.sessionId
              // 把它路由到 child publisher。
              await this.notifyEventSinks(event, {
                ...request.traceContext,
                sessionId: request.sessionId,
              });
              // 编排方案 Phase 4 第二批（specs/subagent-nesting-budget.md R5-3 / 审计
              // §6.3）：多层镜像抑制。两类事件只透传、不再镜像——
              // ① 镜像产物（payload.source="subagent"，深层已按正确的 agentId 与前缀链
              //    铸好）：再镜像一次会让同一工具调用在根 timeline 出现两条（镜像的镜像）；
              // ② 非直接子会话的深层 raw 事件（sessionId ≠ 本 child）：直接镜像会把孙代理
              //    的调用错归属到 child。透传保留观察面，抑制消除重复与错归属。
              const isDirectChildEvent = String(event.sessionId) === String(request.sessionId);
              const isAlreadyMirrored =
                (event.payload as { source?: unknown } | undefined)?.source === "subagent";
              const mirroredEvent =
                isDirectChildEvent && !isAlreadyMirrored
                  ? mirrorSubagentToolEvent(event, {
                      agentId: request.agentId,
                      agentType: request.agentType,
                      background: request.background,
                      childSessionId: request.sessionId,
                      description: request.description,
                      parentSessionId: this.sessionId,
                      parentToolCallId,
                      parentTurnId: request.traceContext.turnId,
                      toolNameByChildToolCallId: mirroredToolNameByChildToolCallId,
                    })
                  : undefined;
              if (!mirroredEvent) return;

              // parent mirror 保留原语义：父会话只看到 subagent 摘要/工具活动，raw child
              // 正文不会污染父 timeline。
              await this.notifyEventSinks(mirroredEvent, {
                ...request.traceContext,
                sessionId: this.sessionId,
              });
            },
          },
          logger: this.logger,
          traceContext: request.traceContext,
        },
      );

      const resumesExistingChild = request.resumeFromStore === true;
      if (resumesExistingChild) {
        // 子模式跟随父当前档（specs/subagent-parent-inheritance.md R2）：不传 override 时
        // resume.ts 会用 child 创建时刻落库的旧模式覆盖上面刚解析的 childMode——
        // 「build 时派生、授完全访问后 SendMessage」会以 build 复活重新弹审批。
        // plan 豁免：override 只带 mode，resolveExecutionState 会把 planEnabled 归 false，
        // 传了会静默拆 plan 地板；plan 由创建时刻落库的 execution-state entry 恢复。
        const resumeModeOverride = resolveSubagentResumeModeOverride(childMode);
        await childRuntime.resumeFromStore({
          traceContext: request.traceContext,
          ...(resumeModeOverride === undefined ? {} : { modeOverride: resumeModeOverride }),
        });
      } else {
        // 父会话过去先发布 SubagentSpawned，child 的首轮 executeTurn 才落库。
        // 并发派生时目录查询会在两者之间读到少一个 child。这里把持久化提升为发布前闸门。
        await childRuntime.ensureSessionPersistedForExternalActivity(request.prompt, {
          traceContext: request.traceContext,
        });
      }
      await notifySessionReady();
      if (!resumesExistingChild) {
        // 新 child 的最终模型可能来自继承、lite 或 profile 显式覆盖。它既是首轮
        // 实时投影事实，也是冷恢复必须保留的 transcript 边界；resume 不重复写入。
        childRuntime.recordPendingModelChange({
          toModel: childSelection,
          toModelLabel: `${childSelection.providerId}/${childSelection.modelId}`,
        });
        await childRuntime.emitModelSelected({
          modelSelection: childSelection,
          effectiveReasoningLevel: childModel.options.reasoningLevel,
          previousModelSelection: null,
          traceContext: request.traceContext,
        });
      }
      request.registerMessageSink?.(createSubagentMessageSink(childRuntime, request));
      try {
        return await childRuntime.executeTurn(request.prompt, undefined, {
          abortSignal: options?.signal,
          // 子 Runtime 的首轮输入来自父 Agent，而不是真实用户直接输入；保留源事实，避免
          // Subagent Turn 在 Trace 和成功率报表里被误归类为 user。
          inputSource: "subagent",
          inputPresentation: "coordinator_input",
          // turn 起点 drain（specs/subagent-pending-message-drain.md R1/R2）：注册 flush
          // 与 turn 启动的竞态输掉后，回队消息在 turn 激活的确定性边界补投。钩子不抛
          // （此处包裹；drain 失败保持 re-queue 语义，resume 路径仍会再冲）。
          onTurnStarted: () => {
            try {
              request.drainQueuedMessages?.();
            } catch {
              // drain 是观察性兜底：失败不伤 turn，消息留在队列。
            }
          },
          traceContext: request.traceContext,
        });
      } finally {
        const cancelled = options?.signal?.aborted === true;
        childRuntime.sealBackgroundTaskNotifications({
          reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
          traceContext: request.traceContext,
        });
        if (cancelled) {
          await childRuntime.cancelRunningRuntimeBackgroundTasks({
            reason: "subagent_cancelled",
            traceContext: request.traceContext,
          });
        }
        // 编排方案 Phase 4 第二批（specs/subagent-nesting-budget.md R5-2 / 审计 §6.2）：
        // 级联收口——child turn 已结算（无论完成还是取消），其在飞的子代理不再有任何
        // 通知消费者（child runtime 即将废弃、其队列无人再读），继续执行 = 孤儿烧 token。
        // 树随派发 run 同生共死；depth-1 无子代理时为 no-op，行为与现状一致。
        await childRuntime.stopInFlightSubagentTasks({
          reason: cancelled ? "subagent_cancelled" : "subagent_terminal",
          traceContext: request.traceContext,
        });
      }
    },
  });

  return foregroundPolicy ? wrapSubagentPortWithForegroundPolicy(port) : port;
}

function resolveSubagentEmbeddedSearchEnabled(): boolean {
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: true,
  });

  return embeddedSearchDecision.useEmbeddedSearchBranch;
}

function createInheritedSubagentModelFactory(
  inheritedSelection: ModelSelection,
  inheritedModel: Model,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): NonNullable<AgentRuntimeDeps["modelFactory"]> {
  return (target) => {
    if (
      target.selection.providerId === inheritedSelection.providerId &&
      target.selection.modelId === inheritedSelection.modelId &&
      target.selection.options?.reasoningLevel === inheritedSelection.options?.reasoningLevel
    ) {
      // Selection 保持显式意图的稀疏形态；不能拿它和 Active Model 的完整 effective
      // options 比较，否则默认值必然导致复用失败并让 child 重新解释可变 Registry。
      return inheritedModel;
    }
    return fallbackFactory(target);
  };
}

function modelSelectionFromActiveModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function createSubagentOverrideModelFactory(
  override: NonNullable<SubagentRunOptions["modelOverride"]>,
  fallbackFactory: AgentRuntimeDeps["modelFactory"],
): AgentRuntimeDeps["modelFactory"] {
  return (target) => {
    return fallbackFactory({
      ...target,
      selection: override.selection,
      requestDependencies: override.requestDependencies,
    });
  };
}

/**
 * 子代理权限模式天花板（安全加固 P2 subagent-policy-floor-inheritance R3；编排方案
 * Phase 4 锚根修正 specs/subagent-nesting-budget.md R1/R2）。导出供回归测试钉住。
 *
 * - depth ≤ 1（缺省锚值）：天花板 = 直接父，与三参旧签名逐字节同语义——request 显式
 *   yolo/bypassPermissions 回落 parentMode，Explore 缺省 yolo 是 depth-1 只读工具面的
 *   设计保留（熔断器 + 进程级策略地板兜底）。
 * - depth ≥ 2：天花板 = parent 与 **root** 的更严者（R1 提权链封堵：根 build →
 *   Explore 子 yolo → 孙代理经 undefined 分支继承 yolo + 可写工具面的一跳提权不再
 *   成立）；Explore 缺省 yolo 限定 depth ≤ 1（depth≥2 的 Explore 可能拿到派发/可写
 *   面，不再享受只读豁免）。
 */
export function resolveSubagentPermissionMode(
  parentMode: AgentRuntimeInternal["config"]["mode"],
  permissionMode: ExploreSubagentRuntimeRequest["permissionMode"],
  builtInExplore: boolean,
  anchors?: { depth: number; rootMode: AgentRuntimeInternal["config"]["mode"] },
): AgentRuntimeInternal["config"]["mode"] {
  const depth = anchors?.depth ?? 1;
  const ceiling =
    depth <= 1 ? parentMode : moreRestrictiveMode(parentMode, anchors?.rootMode ?? parentMode);
  switch (permissionMode) {
    case "auto":
      return "auto";
    case "plan":
      return "plan";
    case undefined:
      return builtInExplore && depth <= 1 ? "yolo" : ceiling;
    default:
      return ceiling;
  }
}

/**
 * resume 分支的 modeOverride 决策（specs/subagent-parent-inheritance.md R2）。
 * 非 plan childMode 原样透出：resume.ts 的 modeOverride 是最高优先级通道，让
 * SendMessage/冷恢复后的子模式跟随父当前档，而非 child 创建时刻落库的旧值。
 * "plan" 返回 undefined（豁免）：modeOverride 只携带 mode，resolveExecutionState
 * 会把 planEnabled 归 false，传了会静默拆 plan 地板；plan 由创建时刻落库的
 * execution-state entry 正确恢复。导出供回归测试钉住该边界。
 */
export function resolveSubagentResumeModeOverride(
  childMode: AgentRuntimeInternal["config"]["mode"],
): "build" | "edit" | "yolo" | "auto" | undefined {
  return childMode === "plan" ? undefined : childMode;
}

function resolveSubagentToolAllowlist(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  visibleMcpToolNames: readonly string[],
  options?: { allowDispatch?: boolean },
): readonly string[] {
  const disallowedRules = buildSubagentChildDisallowRules(
    [...(this.config.toolDisallowlist ?? []), ...(request.disallowedTools ?? [])],
    options,
  );
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) {
    const parentAllowedMcpToolNames = filterMcpToolNamesByParentAllowlist(
      visibleMcpToolNames,
      this.config.toolAllowlist,
    );
    const availableToolNames = [
      ...this.getTools()
        // child MCP 必须与 parent 启动 snapshot 使用同一批 descriptor，
        // 不能从另一份 registry 视图重新推导。
        .filter((tool) => tool.permission?.permission !== "mcp")
        .map((tool) => tool.name),
      ...parentAllowedMcpToolNames,
    ];
    return appendCoordinatorResponseTool(
      [...new Set(availableToolNames)]
        // 派发工具（Agent/Task）的剔除在 tool-policy 强制集单一出处（增补 R4），
        // 两个分支共用 filterSubagentChildToolNames，不再各留一份内联过滤。
        .filter((toolName) => filterSubagentChildToolNames([toolName], disallowedRules).length > 0),
    );
  }
  if (request.allowedTools.length > 0) {
    return appendCoordinatorResponseTool(
      filterSubagentChildToolNames(request.allowedTools, disallowedRules),
    );
  }
  return appendCoordinatorResponseTool([]);
}

function filterMcpToolNamesByParentAllowlist(
  toolNames: readonly string[],
  parentAllowlist: readonly string[] | undefined,
): readonly string[] {
  if (parentAllowlist === undefined) return toolNames;
  const allowed = new Set(parentAllowlist);
  return toolNames.filter((toolName) => allowed.has(toolName));
}

function isModelVisibleMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function appendCoordinatorResponseTool(toolNames: readonly string[]): readonly string[] {
  if (toolNames.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
    return toolNames;
  }

  // child 控制通道不受 profile 工具列表约束；全局 toolDisallowlist 仍在 runtime 注册边界生效。
  return [...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME];
}

interface ResolvedSubagentMcpAccess {
  config: { enabled?: boolean } | undefined;
  port: McpPort | undefined;
  parentSnapshot: McpConnectionSnapshot | undefined;
  snapshot: McpConnectionSnapshot | undefined;
}

async function resolveSubagentMcpAccess(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  officialCuaServerNames: ReadonlySet<string>,
): Promise<ResolvedSubagentMcpAccess> {
  if (!shouldBorrowParentMcp(request)) {
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const scopedServerNames = request.profile.mcpServers?.length
    ? request.profile.mcpServers
    : undefined;
  if (!this.mcpPort || this.config.mcp?.enabled === false) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return {
      config: this.config.mcp?.enabled === false ? { enabled: false } : undefined,
      parentSnapshot: undefined,
      port: undefined,
      snapshot: undefined,
    };
  }

  // child 不拥有连接生命周期，只能复用 parent constructor 已创建的启动快照。
  const parentStartupSnapshot = await this.mcpStartupPromise;
  if (!parentStartupSnapshot) {
    if (scopedServerNames) {
      throw createSubagentMcpUnavailableError(request);
    }
    return { config: undefined, parentSnapshot: undefined, port: undefined, snapshot: undefined };
  }

  const unavailableScopedServerNames = (scopedServerNames ?? []).filter(
    (serverName) => parentStartupSnapshot.statuses[serverName]?.status !== "connected",
  );
  if (unavailableScopedServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableScopedServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableScopedServerNames,
        },
        recoverable: true,
      },
    );
  }

  const borrowed = createBorrowedSubagentMcpAccess(
    this.mcpPort,
    parentStartupSnapshot,
    scopedServerNames,
    officialCuaServerNames,
  );
  return {
    config: { enabled: true },
    parentSnapshot: parentStartupSnapshot,
    port: borrowed.port,
    snapshot: borrowed.snapshot,
  };
}

function shouldBorrowParentMcp(request: ExploreSubagentRuntimeRequest): boolean {
  if ((request.profile.mcpServers?.length ?? 0) > 0) return true;
  if (request.allowedTools.length === 0 || request.allowedTools.includes("*")) return true;
  return request.allowedTools.some((toolName) => {
    const normalized = toolName.trim();
    return isConcreteMcpToolName(normalized) || isMcpServerSelector(normalized);
  });
}

function validateSubagentMcpRequirements(
  request: ExploreSubagentRuntimeRequest,
  effectiveAllowedTools: readonly string[],
  access: ResolvedSubagentMcpAccess,
): void {
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  if (inheritsAvailableTools) return;

  const normalizedAllowedTools = effectiveAllowedTools.map((toolName) => toolName.trim());
  const requiredToolNames = normalizedAllowedTools.filter(isConcreteMcpToolName);
  const requiredServerNames = extractRequiredMcpServerNames(
    normalizedAllowedTools.filter(isMcpServerSelector),
  );
  if (requiredToolNames.length === 0 && requiredServerNames.length === 0) return;
  if (!access.port || !access.snapshot) {
    throw createSubagentMcpUnavailableError(request, requiredToolNames);
  }
  const snapshot = access.snapshot;

  const unavailableServerNames = requiredServerNames.filter(
    (serverName) => !matchesRequiredMcpServer(serverName, snapshot.statuses),
  );
  if (unavailableServerNames.length > 0) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Required MCP server is not connected: ${unavailableServerNames.join(", ")}`,
      {
        context: {
          agentType: request.agentType,
          missingMcpServers: unavailableServerNames,
        },
        recoverable: true,
      },
    );
  }

  const visibleToolNames = new Set(snapshot.tools.map((descriptor) => toMcpToolName(descriptor)));
  const missingToolNames = requiredToolNames.filter((toolName) => !visibleToolNames.has(toolName));
  if (missingToolNames.length === 0) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `Required MCP tool is not available in the parent startup snapshot: ${missingToolNames.join(", ")}`,
    {
      context: {
        agentType: request.agentType,
        missingMcpTools: missingToolNames,
      },
      recoverable: true,
    },
  );
}

function isConcreteMcpToolName(toolName: string): boolean {
  return isModelVisibleMcpToolName(toolName) && !isMcpServerSelector(toolName);
}

function isMcpServerSelector(toolName: string): boolean {
  return toolName === "mcp" || (toolName.startsWith("mcp__") && toolName.endsWith("__*"));
}

function createSubagentMcpUnavailableError(
  request: ExploreSubagentRuntimeRequest,
  requiredToolNames: readonly string[] = [],
) {
  return createCoreError(
    CoreErrorType.ConfigurationError,
    "Subagent MCP is unavailable because the parent startup snapshot is unavailable",
    {
      context: {
        agentType: request.agentType,
        requiredMcpTools: requiredToolNames,
      },
      recoverable: true,
    },
  );
}

function resolveSubagentSkillPort(
  parentSkillPort: SkillPort | undefined,
  skillNames: readonly string[] | undefined,
  cuaPolicy: OfficialCuaPolicy,
): SkillPort | undefined {
  if (!parentSkillPort) {
    return parentSkillPort;
  }
  return new FilteredSkillPort(
    parentSkillPort,
    skillNames && skillNames.length > 0 ? new Set(skillNames) : undefined,
    cuaPolicy,
  );
}

class FilteredSkillPort implements SkillPort {
  constructor(
    private readonly parent: SkillPort,
    private readonly allowedSkills: ReadonlySet<string> | undefined,
    private readonly cuaPolicy: OfficialCuaPolicy,
  ) {}

  async discoverSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    const outcome = await this.parent.discoverSkills(request, options);
    const skills = outcome.skills.filter((skill) => this.isAllowedSkill(skill));
    return {
      ...outcome,
      skills,
      totalDiscovered: skills.length,
    };
  }

  async loadSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    if (
      this.cuaPolicy.isOfficialSkillRequest(request.name) ||
      (await this.hasUniqueOfficialSkillMatch(request, options))
    ) {
      throw createSubagentComputerUseUnavailableError(request.name);
    }
    const resolvedName = await this.resolveAllowedSkillRequestName(request, options);
    if (!resolvedName) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill is not allowed for subagent",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    return this.parent.loadSkill({ ...request, name: resolvedName }, options);
  }

  private async hasUniqueOfficialSkillMatch(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<boolean> {
    if (request.name.includes(":")) return false;
    const outcome = await this.parent.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    return isUniqueOfficialSkillRequest(outcome.skills, request.name, this.cuaPolicy);
  }

  private isAllowedSkill(skill: SkillContent["metadata"]): boolean {
    if (this.cuaPolicy.isOfficialSkill(skill)) return false;
    return (
      this.allowedSkills === undefined ||
      this.allowedSkills.has(skill.name) ||
      (skill.qualifiedName !== undefined && this.allowedSkills.has(skill.qualifiedName))
    );
  }

  private async resolveAllowedSkillRequestName(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<string | undefined> {
    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    const matches = outcome.skills.filter((skill) => matchesSkillRequestName(skill, request.name));
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill name is ambiguous for subagent; use the fully qualified skill name",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            matchingSkills: matches.map((skill) => skill.qualifiedName ?? skill.name),
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    // 可见 skills 列表会把 plugin skill 展示为 qualified name，并声明 bare alias 也可加载。
    // 子 agent 按 bare alias 调用时，先绑定回过滤后的 metadata，避免父端按全局同名 skill 误加载。
    return matches[0]?.qualifiedName ?? matches[0]?.name;
  }
}

async function validateSubagentComputerUseConfiguration(
  request: ExploreSubagentRuntimeRequest,
  cuaPolicy: OfficialCuaPolicy,
  parentSkillPort: SkillPort | undefined,
): Promise<void> {
  const explicitServer = request.profile.mcpServers?.find((serverName) =>
    cuaPolicy.serverNames.has(serverName.trim()),
  );
  const explicitTool = request.allowedTools.find(
    (toolName) =>
      cuaPolicy.isOfficialToolRequest(toolName) || cuaPolicy.isOfficialServerSelector(toolName),
  );
  let explicitSkill = request.profile.skills?.find((skillName) =>
    cuaPolicy.isOfficialSkillRequest(skillName),
  );
  if (!explicitSkill && parentSkillPort && request.profile.skills?.length) {
    try {
      const outcome = await parentSkillPort.discoverSkills({
        workingDirectory: request.workingDirectory,
        trace: request.traceContext,
      });
      explicitSkill = request.profile.skills.find((skillName) =>
        isUniqueOfficialSkillRequest(outcome.skills, skillName, cuaPolicy),
      );
    } catch {
      // Skill discovery remains lazy; a later Skill load will surface its own error.
    }
  }
  if (!explicitServer && !explicitTool && !explicitSkill) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        agentType: request.agentType,
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        ...(explicitServer ? { mcpServer: explicitServer } : {}),
        ...(explicitTool ? { mcpTool: explicitTool } : {}),
        ...(explicitSkill ? { skill: explicitSkill } : {}),
      },
      recoverable: true,
    },
  );
}

function isUniqueOfficialSkillRequest(
  skills: readonly SkillContent["metadata"][],
  requestName: string,
  cuaPolicy: Pick<OfficialCuaPolicy, "isOfficialSkill">,
): boolean {
  if (requestName.includes(":")) return false;
  const matches = skills.filter((skill) => matchesSkillRequestName(skill, requestName));
  return matches.length === 1 && matches[0] !== undefined && cuaPolicy.isOfficialSkill(matches[0]);
}

function createSubagentComputerUseUnavailableError(skillName: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        skill: skillName,
        toolName: "Skill",
      },
      recoverable: true,
    },
  );
}

function matchesSkillRequestName(skill: SkillContent["metadata"], requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

function traceStringAttribute(
  traceContext: { attributes?: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = traceContext.attributes?.[key];
  return typeof value === "string" ? value : undefined;
}
