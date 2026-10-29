/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
import { acodePluginsCancelOperationParamsSchema, PROVIDER_DIAGNOSTICS_METHODS , LEGACY_SURVIVOR_METHODS} from "@acode/shared";
import { v4WorkspaceCancelGenerateTextParamsSchema, V4_METHODS, V4_NOTIFICATIONS, parseConversationTopic, parseSessionsIndexTopic, parseWorkspaceConfigTopic, type V4Method } from "@acode/shared/acode-protocol-v4";
import type { BrowserControlPort } from "@acode/contracts";
import { InMemoryWorkspaceHookPolicyProvider } from "@acode/core";

import { queryV4Capability } from "./capabilities.js";
// 归档会话 header 冷读的实体（v4 目录）；本文件只留一行 dispatch case。
import { querySessionHeaderMeta } from "./session-header-meta-query.js";
import { querySessionGoalV4 } from "./session-goal-query.js";
import { querySessionDebugV4 } from "./session-debug-query.js";
import {
  querySessionEventsV4,
  querySessionMessagesV4,
  querySessionReadV4,
  querySessionResumeV4,
  querySessionsListV4,
  subscribeSessionV4,
} from "./session-readwrite.js";
import { handleSessionRuntimePreferencesPushV4 } from "./session-runtime-preferences.js";
import type {
  ACodeAgentQuiescenceFacts,
  ACodeProtocolError,
  ACodeProtocolMessage,
  LegacySurvivorMethod,
  LegacySkewFallbackMethod,
  ACodeProtocolNotification,
  ACodeProtocolRequest,
  ACodeProtocolRequestId,
  ACodeProtocolResponse,
} from "@acode/shared";
import {
  generateWorkspaceText,
  getTaskTokenUsage,
  getUsageStats,
  listSessionSubagents,
  sendPrompt,
} from "./server-operations.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
// U08 provider 诊断执行器的装配（specs/provider-diagnostics.md）。不 import server-types，
// 因此不构成 server.ts ↔ provider-diagnostics.ts 循环。
import { createProtocolProviderDiagnostics } from "./provider-diagnostics.js";
import {
  describePlugin,
  getPluginsOverview,
  listPlugins,
  validatePlugin,
} from "./plugins-management.js";
import {
  addPluginMarketplace,
  configurePlugin,
  installPlugin,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
} from "./plugins-mutations.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
// M2-6：workflows/skills/mcp 八法实体在 v4 目录（saved-workflows-hub /
// skills-reference-catalog-query / mcp-list-query），legacy 实现文件已随 dispatch 删除。
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows-hub.js";
import { getSkillReferenceCatalog } from "./skills-reference-catalog-query.js";
import { listMcpServers } from "./mcp-list-query.js";
// M2-8：workspace/provider/process 域 11 法实体在 v4 目录（workspace-runtime /
// workspace-policies / workspace-hook-trust-grant / provider-process），legacy 实现文件
// 已随 dispatch 删除；generateWorkspaceText 实体留驻 server-operations.ts（一行转发先例）。
import { readWorkspacePresentationV4 } from "./workspace-runtime.js";
import {
  updateDynamicWorkflowPolicyV4,
  updateInteractionPreferencesV4,
  updateModelIoPreferencesV4,
  updateOffPeakToolPolicyV4,
} from "./workspace-policies.js";
import { grantWorkspaceHookTrustV4 } from "./workspace-hook-trust-grant.js";
import {
  listChildProcessesV4,
  testProviderModelConnectivityV4,
  updateAccountProviderConfigV4,
} from "./provider-process.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "./interaction-registry.js";
import { createConversationV4Gateway } from "./v4-binder.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
  type SessionResidentPoolHost,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  ProtocolRequestError,
  type ParamsSchema,
  parseParams,
  toProtocolError,
  type ACodeProtocolClientRequestOptions,
  type ACodeProtocolAgentDependencies,
  type ACodeProtocolAgentServerContext,
  type ACodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@acode/contracts";

export type { ACodeProtocolAgentDependencies, ACodeProtocolSessionRecord };

const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

type ACodeProtocolOutboundMessage = ACodeProtocolNotification | ACodeProtocolRequest;

// M2-8：hook trust grant 的 accepted→session 重载联动随实体迁入
// ../acode-protocol-v4/workspace-hook-trust-grant.ts（notifyWorkspaceHookTrustGrantSessionsV4），
// 本文件不再持有。

function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

function getPluginOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

interface ACodeProtocolPostResponseBatch {
  readonly messages: readonly ACodeProtocolOutboundMessage[];
  commit(): boolean;
}

interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

export class ACodeProtocolAgentServer {
  private readonly runtimeResources: ProtocolRuntimeResources;
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  get officialMcpAuthRequestContext(): Pick<ACodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  private messageSink?: (message: ACodeProtocolOutboundMessage) => void;
  private clientDisconnectError?: Error;
  private readonly context: ACodeProtocolAgentServerContext;
  private readonly logger;
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ACodeProtocolRequestId,
    ACodeProtocolPostResponseBatch
  >();
  private nextClientRequestId = 1;
  /**
   * 与 resident pool 共用的同一份事实适配器:静默自检必须走 pool 的同一判据源,
   * 不允许再抄一份 readResidencyFacts(避免重复状态/双路径,spec chat-lane-idle-reclaim.md R5)。
   */
  private readonly residentPoolHost: SessionResidentPoolHost;

  constructor(deps: ACodeProtocolAgentDependencies) {
    this.runtimeResources = new ProtocolRuntimeResources(deps.createACodeApp);
    const resolvedDeps = {
      ...deps,
      createACodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
      // U08 provider 诊断：测试可直接注入 executor；否则用 entrypoint 交出的进程级 Registry
      // runtime 现场装配（不绑定 workspace，首次配置也能跑 offline 档）。两者都缺 → 协议层
      // 回 method-unavailable（requireProviderDiagnostics），不静默降级。
      // logger 直接由 deps 现取：this.logger 在下一行才赋值，此处读它必为 undefined。
      // createProtocolLogger 只读 deps.loggerFactory，与下方 this.logger 的取值同源。
      providerDiagnostics:
        deps.providerDiagnostics ??
        (deps.providerRegistryRuntime
          ? createProtocolProviderDiagnostics(
              deps.providerRegistryRuntime,
              deps.env ?? process.env,
              createProtocolLogger(deps),
            )
          : undefined),
    };
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 v4/workspace/updateDynamicWorkflowPolicy
        // 才开启（M2-8 前为 legacy workspace/updateDynamicWorkflowPolicy 词）。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ACodeProtocolSessionRecord>(),
      // M2-4：连接级「host 已接住 v4 inbound」证据位（specs/m2-4-inbound-interaction.md §2.4）。
      // 由六条 v4 反向请求的成功响应置位（requestClient 内），换连接时归零（setNotificationSink）。
      hostV4InboundEstablished: false,
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.residentPoolHost = createSessionResidentPoolHost(this.context);
    this.context.sessionResidentPool = new SessionResidentPool(this.residentPoolHost, {
      ...deps.sessionResidentPoolOptions,
      // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
      // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
      highWaterCount: sessionResidentHighWaterCount,
      targetCount: sessionResidentTargetCount,
    });
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * chat lane 空闲回收的静默事实聚合(spec: packages/services/specs/chat-lane-idle-reclaim.md R1/R5)。
   * 只读:不触发 rebalance、不修改任何状态;由 60s 资源采样节拍调用。
   * transport 在飞帧与进程生命周期状态由 entrypoint 的 evaluator 合并,这里不重复持有。
   * 存储静默无需专门判据:迁移门禁在 server 开始服务前已收敛,后续写入都发生在
   * turn/detached work 内,被 residency 事实覆盖。
   */
  collectQuiescenceFacts(): ACodeAgentQuiescenceFacts {
    const reasons = new Set<string>();
    if (this.shutdownPromise || this.clientDisconnectError) reasons.add("shutting-down");
    if (this.pendingClientRequests.size > 0) reasons.add("pending-client-requests");
    // 插件安装/卸载与 generateText 是 detached 长操作,transport 在飞计数盖不住。
    if (this.pluginOperationControllers.size > 0) reasons.add("plugin-operations");
    if (this.workspaceGenerateTextControllers.size > 0) reasons.add("generate-text");
    if (this.context.sessionResidentPool?.hasActiveOperations()) reasons.add("operation-leases");
    if (this.context.v4Gateway?.hasPendingAttachmentUploads()) reasons.add("attachment-uploads");
    for (const sessionId of this.context.sessions.keys()) {
      const facts = this.residentPoolHost.readResidencyFacts(sessionId);
      if (!facts) continue;
      // 非即时持久化会话不得随进程释放(与 pool isEligible 的 persisted 判据同源)。
      if (!facts.persisted) reasons.add("unpersisted-session");
      if (facts.hasResidencyBlockingWork) reasons.add("residency-blocking-work");
      if (facts.hasPendingInteractions) reasons.add("pending-interactions");
      if (facts.hasQueuedCommands) reasons.add("queued-commands");
      if (facts.hasSubscribers || facts.hasLegacySubscriber) reasons.add("subscribers");
    }
    return { quiescent: reasons.size === 0, reasons: [...reasons] };
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  setNotificationSink(sink: (message: ACodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientDisconnectError = undefined;
    this.messageSink = sink;
    // M2-4：换连接 = 可能换了 host，证据位归零（CUA 通知会回落 legacy 形态，
    // 直到六条反向请求重新证明）。见 specs/m2-4-inbound-interaction.md §2.4。
    this.context.hostV4InboundEstablished = false;
  }

  disconnectClient(error: Error): void {
    this.clientDisconnectError = error;
    // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
    // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
    const pendingRequests = new Set(this.pendingClientRequests.values());
    for (const pending of pendingRequests) {
      this.cleanupClientRequest(pending);
      pending.reject(error);
    }
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("ACode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "acode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  takePostResponseMessages(requestId: ACodeProtocolRequestId): ACodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  takePostResponseBatch(requestId: ACodeProtocolRequestId): ACodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  async handleMessage(
    message: ACodeProtocolMessage,
  ): Promise<ACodeProtocolError | ACodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    if (isResponse(message)) {
      this.resolveClientRequest(message.id, message.result);
      return undefined;
    }
    if (isErrorResponse(message)) {
      this.rejectClientRequest(
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      this.logger?.debug("ACode Protocol notification ignored", {
        event: "acode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.acode_protocol",
      });
    }
    return undefined;
  }

  private async handleRequest(
    request: ACodeProtocolRequest,
  ): Promise<ACodeProtocolError | ACodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  private async dispatchRequest(request: ACodeProtocolRequest) {
    switch (request.method) {
      // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
      case V4_METHODS.capabilitiesQuery: {
        return queryV4Capability(request.params);
      }
      case V4_METHODS.connectionFlow: {
        this.requireV4Gateway().setConnectionFlowState(request.params);
        return {};
      }
      case V4_METHODS.conversationSubscribe: {
        // 同一 subscribe 方法按 topic 前缀分派：
        // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
        const gateway = this.requireV4Gateway();
        const topic = (request.params as { topic?: unknown } | null)?.topic;
        let dispatch;
        if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
          dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
        } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
          dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
        } else {
          dispatch = await gateway.subscribeReserved(request.params);
        }
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationResync: {
        // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
        // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
        const dispatch = this.requireV4Gateway().resyncReserved(request.params);
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationUnsubscribe: {
        // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
        // subId 对 conversation/sessions-index/workspace-config 广撒网。
        this.requireV4Gateway().unsubscribe(request.params);
        return {};
      }
      // ── 行分页 query（独立分支，便于与帧分派改动合并）──
      case V4_METHODS.conversationRowsRange:
        return await this.requireV4Gateway().rowsRange(request.params);
      case V4_METHODS.conversationPlans:
        return await this.requireV4Gateway().plans(request.params);
      case V4_METHODS.backgroundBashOutput:
        return await this.requireV4Gateway().backgroundBashOutput(request.params);
      case V4_METHODS.conversationFileChanges:
        return await this.requireV4Gateway().fileChanges(request.params);
      case V4_METHODS.conversationFileRewindPreview:
        return await this.requireV4Gateway().fileRewindPreview(request.params);
      // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
      case V4_METHODS.conversationWorkflowRunEvents:
        return await this.requireV4Gateway().workflowRunEvents(request.params);
      // dwf run 枚举（重启后的发现查询）。
      case V4_METHODS.conversationWorkflowRuns:
        return await this.requireV4Gateway().workflowRuns(request.params);
      // dwf 用户面产物的三个读面。同族：只读、无状态、
      // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
      case V4_METHODS.conversationWorkflowRunArtifacts:
        return await this.requireV4Gateway().workflowRunArtifacts(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactData:
        return await this.requireV4Gateway().workflowRunArtifactData(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactRead:
        return await this.requireV4Gateway().workflowRunArtifactRead(request.params);
      // 对话内可视化（::visualize）的字节分块读；授权在宿主端口侧（会话 + 注册名核对）。
      case V4_METHODS.conversationVisualizationRead:
        return await this.requireV4Gateway().visualizationRead(request.params);
      // 运行时网络观测开关（agent 进程级事实，不是 conversation 命令）。
      case V4_METHODS.networkCaptureSetEnabled:
        return await this.requireV4Gateway().networkCaptureSetEnabled(request.params);
      // dwf 工作区 transcript 的两个读面。同族。
      case V4_METHODS.conversationWorkflowRunWorkspace:
        return await this.requireV4Gateway().workflowRunWorkspace(request.params);
      case V4_METHODS.conversationWorkflowRunNodeResult:
        return await this.requireV4Gateway().workflowRunNodeResult(request.params);
      // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
      case V4_METHODS.attachmentBegin:
        return await this.requireV4Gateway().attachmentBegin(request.params);
      case V4_METHODS.attachmentChunk:
        return await this.requireV4Gateway().attachmentChunk(request.params);
      case V4_METHODS.attachmentCommit:
        return await this.requireV4Gateway().attachmentCommit(request.params);
      case V4_METHODS.attachmentAbort:
        await this.requireV4Gateway().attachmentAbort(request.params);
        return {};
      case V4_METHODS.attachmentRead:
        return await this.requireV4Gateway().attachmentRead(request.params);
      case V4_METHODS.conversationAttachmentRead:
        return await this.requireV4Gateway().conversationAttachmentRead(request.params);
      case V4_METHODS.conversationAttachmentStat:
        return await this.requireV4Gateway().conversationAttachmentStat(request.params);
      case V4_METHODS.attachmentPreviewSource:
        return await this.requireV4Gateway().attachmentPreviewSource(request.params);
      // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
      // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
      // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
      case V4_METHODS.usageStats:
        return await getUsageStats(this.context, request.params);
      case V4_METHODS.conversationUsage:
        return await getTaskTokenUsage(this.context, request.params);
      // 归档会话 header 冷读（specs/v4-session-header-meta.md）。实体在 v4 目录
      // （session-header-meta-query.ts），此处只一行转发——M3 搬迁入口时只需移动这一行，
      // 不在本待删目录新增实体债。
      case V4_METHODS.sessionHeaderMeta:
        return await querySessionHeaderMeta(this.context, request.params);
      // M2-2 session 控制面读路径（specs/m2-2-session-control.md）：实体在 v4 目录
      // （session-goal-query.ts / session-debug-query.ts），此处一行转发，同 headerMeta 纪律。
      case V4_METHODS.sessionGoalQuery:
        return await querySessionGoalV4(this.context, request.params);
      case V4_METHODS.sessionDebug:
        return querySessionDebugV4(this.context, request.params);
      // M2-3 session 读写面（specs/m2-3-session-readwrite.md）：实体在 v4 目录
      // （session-readwrite.ts / session-runtime-preferences.ts），此处一行转发，
      // 同 headerMeta 纪律。resume 有冷恢复激活副作用；subscribe 写投递画像并
      // 原子返回同一水位 replay+snapshot；runtimePreferences 是 host→CLI 推送。
      case V4_METHODS.sessionRead:
        return await querySessionReadV4(this.context, request.params);
      case V4_METHODS.sessionResume:
        return await querySessionResumeV4(this.context, request.params);
      case V4_METHODS.sessionsList:
        return await querySessionsListV4(this.context, request.params);
      case V4_METHODS.sessionMessages:
        return await querySessionMessagesV4(this.context, request.params);
      case V4_METHODS.sessionEvents:
        return await querySessionEventsV4(this.context, request.params);
      case V4_METHODS.sessionSubscribe:
        return await subscribeSessionV4(this.context, request.params);
      case V4_METHODS.sessionRuntimePreferences:
        return await handleSessionRuntimePreferencesPushV4(this.context, request.params);
      // ── M2-6：workflows 中枢六法 + skills catalog + mcp list（additive 换名迁
      // 徙，specs/m2-6-workflows-skills-mcp.md）。与 usageStats 同款：无会话投影依赖，
      // 不经 v4Gateway，直调 v4 目录实体；载荷与 legacy 逐字 parity。──
      case V4_METHODS.workflowsList:
        return await listSavedWorkflowsOp(this.context, request.params);
      case V4_METHODS.workflowsGet:
        return await getSavedWorkflowOp(this.context, request.params);
      case V4_METHODS.workflowsUpdateMeta:
        return await updateSavedWorkflowMetaOp(this.context, request.params);
      case V4_METHODS.workflowsDelete:
        return await deleteSavedWorkflowOp(this.context, request.params);
      case V4_METHODS.workflowsRuns:
        return await listSavedWorkflowRunsOp(this.context, request.params);
      case V4_METHODS.workflowsMove:
        return await moveSavedWorkflowOp(this.context, request.params);
      case V4_METHODS.skillsReferenceCatalog:
        return await getSkillReferenceCatalog(this.context, request.params);
      case V4_METHODS.mcpList:
        return await listMcpServers(this.context, request.params);
      // ── M2-5：plugins 管理面 16 法（specs/m2-5-plugins.md）。管理面 14 法实体在 v4 目录
      // （plugins-management.ts 读四法+共享投影 / plugins-mutations.ts 写十法，自 legacy
      // plugins.ts 逐字迁）；catalog/resolveSuggested 实体留在 legacy
      // plugin-reference-catalog.ts——两个 legacy catalog case 因 services 侧
      // -32601 fallback 链仍存活（usageStats 同款一行转发；v4 catalog 恒带 category）。
      // setEnabled/resolveSuggested/marketplaceAdd/marketplaceUpdate/install 五个可取消操作
      // 经 withPluginOperationSignal 包装；中止注册表按 operationId 键控、与协议代际无关，
      // cancelOperation 因此保留 legacy 词（下方 legacy 区）。──
      case V4_METHODS.pluginsList:
        return await listPlugins(this.context, request.params);
      case V4_METHODS.pluginsOverview:
        return await getPluginsOverview(this.context, request.params);
      case V4_METHODS.pluginsDescribe:
        return await describePlugin(this.context, request.params);
      case V4_METHODS.pluginsValidate:
        return await validatePlugin(this.context, request.params);
      case V4_METHODS.pluginsReferenceCatalog:
        return await getPluginReferenceCatalog(this.context, request.params, true);
      case V4_METHODS.pluginsResolveSuggestedReference:
        return await this.withPluginOperationSignal(request, (signal) =>
          resolveSuggestedPluginReference(this.context, request.params, signal),
        );
      case V4_METHODS.pluginsSetEnabled:
        return await this.withPluginOperationSignal(request, (signal) =>
          setPluginEnabled(this.context, request.params, signal),
        );
      case V4_METHODS.pluginsMarketplaceAdd:
        return await this.withPluginOperationSignal(request, (signal) =>
          addPluginMarketplace(this.context, request.params, signal),
        );
      case V4_METHODS.pluginsMarketplaceRemove:
        return await removePluginMarketplace(this.context, request.params);
      case V4_METHODS.pluginsMarketplaceUpdate:
        return await this.withPluginOperationSignal(request, (signal) =>
          updatePluginMarketplace(this.context, request.params, signal),
        );
      case V4_METHODS.pluginsInstall:
        return await this.withPluginOperationSignal(request, (signal) =>
          installPlugin(this.context, request.params, signal),
        );
      case V4_METHODS.pluginsUninstall:
        return await uninstallPlugin(this.context, request.params);
      case V4_METHODS.pluginsUpdate:
        return await updatePlugin(this.context, request.params);
      case V4_METHODS.pluginsRestoreBuiltin:
        return await restoreBuiltinPlugin(this.context, request.params);
      case V4_METHODS.pluginsConfigure:
        return await configurePlugin(this.context, request.params);
      case V4_METHODS.pluginsResetConfig:
        return await resetPluginConfig(this.context, request.params);
      // ── M2-8：workspace + provider + process 域 11 法（specs/m2-8-workspace-provider-process.md）。
      // 与 usageStats 同款：无会话投影依赖，不经 v4Gateway，直调 v4 目录实体；载荷与 legacy
      // 逐字 parity。generateText 实体留驻 server-operations.ts（该文件不在本批范围），
      // 经既有 withWorkspaceGenerateTextSignal 包装（operationId 注册表与代际无关）；
      // cancelGenerateText 复用同一私有方法/注册表。hookTrustGrant 的 accepted→同
      // workspaceKey 活跃 session 重载联动在 v4 handler 内（迁移不变量）。──
      case V4_METHODS.workspaceReadPresentation:
        return await readWorkspacePresentationV4(this.context, request.params);
      case V4_METHODS.workspaceHookTrustGrant:
        return await grantWorkspaceHookTrustV4(this.context, request.params);
      case V4_METHODS.workspaceUpdateInteractionPreferences:
        return await updateInteractionPreferencesV4(this.context, request.params);
      case V4_METHODS.workspaceUpdateModelIoPreferences:
        return await updateModelIoPreferencesV4(this.context, request.params);
      case V4_METHODS.workspaceUpdateOffPeakToolPolicy:
        return await updateOffPeakToolPolicyV4(this.context, request.params);
      case V4_METHODS.workspaceUpdateDynamicWorkflowPolicy:
        return await updateDynamicWorkflowPolicyV4(this.context, request.params);
      case V4_METHODS.workspaceGenerateText:
        return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
          generateWorkspaceText(this.context, request.params, signal),
        );
      case V4_METHODS.workspaceCancelGenerateText:
        return this.cancelWorkspaceGenerateText(request.params);
      case V4_METHODS.providerUpdateAccountConfig:
        return await updateAccountProviderConfigV4(this.context, request.params);
      case V4_METHODS.providerTestModelConnectivity:
        return await testProviderModelConnectivityV4(this.context, request.params);
      case V4_METHODS.processChildProcesses:
        return listChildProcessesV4(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
      case V4_METHODS.command:
        return this.requireV4Gateway().handleCommand(request.params);
      case V4_METHODS.commandsQuery:
        return this.requireV4Gateway().queryCommands(request.params);
      // ── M3 幸存 legacy 词（spec m3-legacy-server-removal.md §0 裁决 + 幸存清单）──
      // M3 删除段裁决：除幸存清单外的 legacy case 全部删除（sessionStop /
      // sessionCancelBackgroundTask / sessionFork / sessionSetThoughtLevel /
      // pluginsReferenceCatalog×2 / runtimeCapabilities / usageStats / sessionUsage；
      // 其 services 消费在 M2 季已归零或为 skew-only，op 实体若仅服务这些 case 则随删）。
      // 幸存词保留最小执行面，登记移除条件见 spec §0 幸存清单。
      // 裁决 1：session/subagents 无 v4 分页 query，UI 已结束子代理目录依赖；幸存待产品裁决。
      case LEGACY_SURVIVOR_METHODS.sessionSubagents:
        return await listSessionSubagents(this.context, request.params);
      // 裁决 3：session/send 仅附件回退路径幸存——v4 sendText 只收 attachmentRef，
      // 宿主发送侧上传/寄存命令面尚未建模；bot/手机 replayable 附件输入走此路
      // （acodeTaskServiceAdapter.ts 附件分支）。
      case LEGACY_SURVIVOR_METHODS.sessionSend:
        return await sendPrompt(this.context, request.params);
      // ── U08 provider 诊断（specs/provider-diagnostics.md）──
      // 走进程级执行器（不建 workspace ACodeApp），因此首次配置尚无 workspace 也能诊断。
      case PROVIDER_DIAGNOSTICS_METHODS.run:
        return await this.requireProviderDiagnostics().run(request.params);
      case PROVIDER_DIAGNOSTICS_METHODS.cancel:
        return this.requireProviderDiagnostics().cancel(request.params);
      // 裁决 2：plugins/cancelOperation 中止注册表按 operationId 键控、与协议代际无关，
      // legacy 词保留（M2-5 §4 先例；shared protocol-boundary 测试断言其不进 v4 面）。
      case LEGACY_SURVIVOR_METHODS.pluginsCancelOperation:
        return this.cancelPluginOperation(request.params);
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
    }
  }

  private requireV4Gateway() {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  /**
   * U08 provider 诊断执行器（specs/provider-diagnostics.md）。
   * 缺席 = 该宿主未装配诊断能力：回 method-unavailable 而不是静默返回空结果，
   * 让 host 侧能把「没装配」与「诊断失败」区分开（错误是一等对象，不吞）。
   */
  private requireProviderDiagnostics() {
    const diagnostics = this.context.deps.providerDiagnostics;
    if (!diagnostics) {
      throw new ProtocolRequestError(
        -32601,
        "provider diagnostics is not available in this agent runtime",
      );
    }
    return diagnostics;
  }

  private async withPluginOperationSignal<T>(
    request: ACodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(request.params);
    if (!operationId) return await run();

    const controller = new AbortController();
    this.pluginOperationControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.pluginOperationControllers.get(operationId) === controller) {
        this.pluginOperationControllers.delete(operationId);
      }
    }
  }

  private cancelPluginOperation(rawParams: unknown) {
    const params = parseParams(acodePluginsCancelOperationParamsSchema, rawParams);
    const controller = this.pluginOperationControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
    controller.abort();
    this.pluginOperationControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private async withWorkspaceGenerateTextSignal<T>(
    request: ACodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getOperationId(request.params);
    if (!operationId) return await run();

    if (this.workspaceGenerateTextControllers.has(operationId)) {
      // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
      // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
      throw new ProtocolRequestError(
        -32600,
        `Workspace generate operation is already active: ${operationId}`,
      );
    }

    const controller = new AbortController();
    this.workspaceGenerateTextControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.workspaceGenerateTextControllers.get(operationId) === controller) {
        this.workspaceGenerateTextControllers.delete(operationId);
      }
    }
  }

  private cancelWorkspaceGenerateText(rawParams: unknown) {
    const params = parseParams(v4WorkspaceCancelGenerateTextParamsSchema, rawParams);
    const controller = this.workspaceGenerateTextControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
    this.workspaceGenerateTextControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private ok(id: ACodeProtocolRequestId, result: unknown): ACodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ACodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ACodeProtocolError {
    return { error: { code, data, message }, id };
  }

  private requestClient<T>(
    method: LegacySurvivorMethod | LegacySkewFallbackMethod | V4Method,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ACodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(-32020, `No ACode Protocol client is attached for ${method}`);
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(new ProtocolRequestError(-32021, `Client request cancelled: ${method}`));
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(-32022, `Client request timed out: ${method}`, {
              timeoutMs: options.timeoutMs,
            }),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  private resolveClientRequest(id: ACodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    // M2-4（§2.4）：host 对六条 v4 inbound 反向请求之一的成功响应，证明它确实在用 v4 分支
    // 服务本连接——置位证据位，之后的 CUA 通知即可发 v4 形态。错误响应（含 -32601）走
    // rejectClientRequest 不在此置位：-32601 恰说明该 host 缺 v4 inbound 分支，其通知面同样不认。
    // 只认请求侧响应：host 对未知通知是静默丢弃，不构成证据。
    if (!this.context.hostV4InboundEstablished && pending.method.startsWith("v4/interaction/")) {
      this.context.hostV4InboundEstablished = true;
    }
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  private rejectClientRequest(id: ACodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }

  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
