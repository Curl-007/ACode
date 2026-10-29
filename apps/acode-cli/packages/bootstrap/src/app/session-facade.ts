/* eslint-disable max-lines -- 存量基线豁免:该文件先于 CLI lint 门禁建立即超限(根 lint 的 ignorePatterns 排除 apps/acode-cli,turbo lint 因此从未变绿)。头注豁免以恢复门禁信号;拆分重构超出本批范围。 */
import {
  updateAutoResumeInFileConfig,
  updateUiLocaleInFileConfig,
  type ConfigResult,
} from "@acode/adapters/config";
import { executeUsageQuery, renderUsageQueryUnavailable, type AgentRuntime } from "@acode/core";
import { resolveLocale } from "@acode/i18n";
import { normalizeModelSelection, type ModelSelection } from "@acode/provider";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  traceContextToLogContext,
  type CollaborationMode,
  type ExecutionPort,
  type GoalStatus,
  type Logger,
  type LoggerFactory,
  type LocalSettingStorePort,
  type McpPort,
  type McpServerConfig,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type TurnInputIntentMetadata,
  type UiLocale,
  type UiThemePreference,
  type UsageStorePort,
} from "@acode/contracts";
import { listMcpServerStatuses } from "../mcp-config.js";
import { resolveTzOffsetMs } from "../acode-protocol-v4/usage-stats-builder.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import type { PrepareUserExecutionBoundary, ACodeApp } from "./types.js";

// SessionEnd hook 收口闸门（apps/acode-cli/specs/hook-event-surface.md F1）：
// 漏斗级超时上限，独立于 hook runner 的每 hook 超时——关闭链路不得被 hook 无限
// 拖住；超时即 abort，由 runner 收掉在飞 hook 进程。
const SESSION_END_HOOKS_TIMEOUT_MS = 30_000;
// reason 闭集条目（F1 建议集 clear/logout/exit/dispose…）：本装配层单一漏斗的
// 事实是「宿主回收会话 app」= dispose；更细来源需要 close 签名链路携带原因参数，
// 登记为后续批次。子会话（dwf child runtime）不经本漏斗，其生命周期事件面归 F5。
const SESSION_END_HOOK_REASON_DISPOSE = "dispose";

type SessionFacade = Pick<
  ACodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "getAutoResumeStatus"
  | "applyAutoResumeCommand"
  | "queryUsage"
  | "listCheckpoints"
  | "listMcpServers"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

interface CreateSessionFacadeDeps {
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  unsubscribePluginState?: () => void;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = deps.runtime.getSessionModelSelection();
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // 上次 app/agent 退出可能留下未清空的 active_run_started_at。
      // 这里不能用当前时间结算，否则离线时间会被算进 goal 运行时长；store 会用 last_seen 收口。
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal 不走普通 prompt 提交流程，但它会先把 session 持久化。
    // 必须在首次持久化前走统一用户执行边界，否则 runtime/bash_shell_selection
    // 会因为当时 selection 为空而缺失，冷恢复时退回 legacy shell fallback。
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // TUI 和协议客户端可能在重连或恢复后仍缓存旧 goal。
      // 即使 session store 已经是空，也要把显式 clear 投影成 target:null，
      // 让客户端不能只因为“No goal to clear.”这条文本而继续保留旧面板。
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal 同时是控制命令和用户 query。旧路径只把解析后的 objective
        // 落库，且 live 事件里没有这条输入；因此首轮实时列表为空，冷恢复后也丢失
        // `/goal` / `/target` / `replace` 原文。target 继续存 canonical objective，
        // 可见消息单独保留协议层传入的原始 display text。
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };

  return {
    close: async () => {
      closePromise ??= (async () => {
        // 关闭入口先阻止新调度并取消在飞 Memory Extraction，再等待取消链路收口。
        deps.runtime.beginShutdown();
        deps.unsubscribePluginState?.();
        // SessionEnd hook（apps/acode-cli/specs/hook-event-surface.md F1）：本 close
        // 是唯一 awaitable 的 shutdown 漏斗（beginShutdown 是同步接口；closePromise
        // 保证至多触发一次）。位置在 beginShutdown 之后——shuttingDown 已提交、不会
        // 有新调度，而 execution/MCP/session store 尚未关闭，hook 看到一致状态。
        // await 含超时、失败/超时只 warn：通知类事件绝不阻断会话关闭（触发函数内部
        // 另有 containment，这里兜住超时 abort 与意外抛错）。
        const sessionEndHooksAbort = new AbortController();
        const sessionEndHooksTimer = setTimeout(
          () => sessionEndHooksAbort.abort(),
          SESSION_END_HOOKS_TIMEOUT_MS,
        );
        try {
          await deps.runtime.runSessionEndHooks(
            { reason: SESSION_END_HOOK_REASON_DISPOSE },
            deps.traceContext,
            sessionEndHooksAbort.signal,
          );
        } catch (error: unknown) {
          deps.logger.warn?.("SessionEnd hooks failed during session close", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "hook.session_end.close_failed",
            module: "bootstrap.app",
          });
        } finally {
          clearTimeout(sessionEndHooksTimer);
        }
        await deps.runtime.drainMemoryExtractions(60_000);
        // 引擎归本 App 所有，所以关闭要主动停下它。
        // 位置是两个约束夹出来的：在 beginShutdown **之后**，结算带出的终态通知才会被丢掉
        // （background-notifications.ts 在 shuttingDown 时不入队），不会把正在关闭的会话的模型
        // 叫醒；在 closeSessionResources **之前**，子代理还有 execution / MCP / session store
        // 可以干净地中止，引擎也还有 journal 可以写自己那一笔 stopped(interrupted)。
        if (deps.closeDynamicWorkflowRuns !== undefined) {
          try {
            await deps.closeDynamicWorkflowRuns();
          } catch (error: unknown) {
            // 卡住或抛错的 dwf 关闭绝不能吃掉资源关闭（同下面并行关闭那条注释的论证）：
            // 记一条 warn 继续走，最坏情况是那个 run 留成孤儿行，下一次构造时被收敛。
            deps.logger.warn?.(
              "Closing dynamic workflow runs failed; continuing to close resources",
              {
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "dynamic_workflow.service.close_failed",
                module: "bootstrap.app",
              },
            );
          }
        }
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        await closeSessionResources({
          beginShutdown: () => deps.runtime.beginShutdown(),
          closeBrowserSession: () => deps.runtime.closeBrowserSession(),
          closeExecution:
            deps.ownsExecutionPort && deps.executionPort.close
              ? () => deps.executionPort.close?.()
              : undefined,
          closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
          closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
          closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
          logger: deps.logger,
        });
      })();
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(deps.runtime.getSessionModelSelection()),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : deps.runtime.getSessionModelSelection()?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => deps.runtime.getSessionModelSelection()?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ACodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ACodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = deps.runtime.getSessionModelSelection();
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口规范化模型身份；registry 严格 Factory 只接受完整执行选择——
      // 缺 reasoningLevel 的 selection（润色类调用方只传身份）会在创建 Model 前被拒
      // （E2E D4 回归）。显式档位尊重调用方；缺席时补最低公开档位（与下方
      // testModelConnectivity 同一兜底语义）。Core 的 GIT_COMMIT_MESSAGE 分支仍
      // 在调用点显式决定辅助请求档位，本补齐不改变其行为（bind 覆盖同值）。
      const normalized =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      const selection = normalized.options?.reasoningLevel
        ? normalized
        : completeAuxiliaryRegistryModelSelection(deps.providerRegistry, normalized);
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // 连接测试用的 Model 也要先绑定最低档位，否则严格 Factory 会先因缺档位失败。
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore) {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口保留只改身份语义。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = deps.runtime.getSessionModelSelection();
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      deps.runtime.setSessionModelSelection(sessionSelection);
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = deps.runtime.getSessionModelSelection();
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        deps.runtime.setSessionModelSelection({
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        });
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
    // /auto-resume 命令面（specs/turn-auto-resume.md）：进程内状态（override/pause/
    // 计数）唯一所有者是 runtime coordinator；长期开关与自定义消息在 persist 档另落
    // user config 文件（照 setLocale 写 config 先例，回执 configPath）。持久化先行、
    // 进程内生效随后——写盘失败时进程内状态不被半改。
    getAutoResumeStatus: () => deps.runtime.getAutoResumeStatus?.(),
    applyAutoResumeCommand: async (intent) => {
      const runtime = deps.runtime;
      if (!runtime.applyAutoResumeCommand) {
        return { ok: false, error: "auto-resume is not available in this runtime." };
      }
      if (intent.kind === "status") {
        // status 不经写面（命令模块直接读 getAutoResumeStatus）。
        return { ok: true };
      }
      if (intent.kind === "pause") {
        // off <时长> = 进程内 pause overlay，到期自动恢复，不写盘。
        runtime.applyAutoResumeCommand({ kind: "pause", durationMs: intent.durationMs });
        return { ok: true };
      }
      const configPath = deps.configResult.sources.user.path;
      if (intent.kind === "setEnabled") {
        let persistedPath: string | undefined;
        if (intent.persist) {
          const persisted = await updateAutoResumeInFileConfig(configPath, {
            enabled: intent.enabled,
          });
          persistedPath = persisted.path;
          deps.configResult.config.autoResume = {
            ...deps.configResult.config.autoResume,
            enabled: intent.enabled,
          };
        }
        runtime.applyAutoResumeCommand({ kind: "setEnabled", enabled: intent.enabled });
        deps.logger.info("Session auto-resume toggle updated", {
          ...traceContextToLogContext(deps.traceContext),
          enabled: intent.enabled,
          event: "session.auto_resume.updated",
          module: "bootstrap",
          status: "completed",
        });
        return { ok: true, ...(persistedPath ? { configPath: persistedPath } : {}) };
      }
      let persistedPath: string | undefined;
      if (intent.persist) {
        const persisted = await updateAutoResumeInFileConfig(configPath, {
          continueMessage: intent.message,
        });
        persistedPath = persisted.path;
        const nextAutoResume = { ...deps.configResult.config.autoResume };
        if (intent.message === null) delete nextAutoResume.continueMessage;
        else nextAutoResume.continueMessage = intent.message;
        deps.configResult.config.autoResume = nextAutoResume;
      }
      runtime.applyAutoResumeCommand({ kind: "setContinueMessage", message: intent.message });
      deps.logger.info("Session auto-resume continue message updated", {
        ...traceContextToLogContext(deps.traceContext),
        cleared: intent.message === null,
        event: "session.auto_resume.message_updated",
        module: "bootstrap",
        status: "completed",
      });
      return { ok: true, ...(persistedPath ? { configPath: persistedPath } : {}) };
    },
    // /usage 命令面（specs/usage-statusbar.md）：零 token 本地查询。数据源 = 进程级
    // session store（SqliteSessionStore 同时实现 UsageStorePort），收窄与 desktop
    // v4/command 的 handlers/usage-query leaf 同款；TUI 走本成员，两路共享 core
    // executeUsageQuery 单一实现。时区 = 宿主本机（TUI 无客户端携带通道，与 desktop
    // leaf 的 payload.timeZone 来源不同、口径同 resolveTzOffsetMs）。
    queryUsage: async ({ args }) => {
      const store = deps.sessionStore as Partial<UsageStorePort>;
      if (!store.queryAppUsage || !store.queryTaskUsage) {
        return { ok: false, scope: null, text: renderUsageQueryUnavailable(currentLocale) };
      }
      const now = Date.now();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const result = await executeUsageQuery({
        args,
        locale: currentLocale,
        deps: {
          usageStore: store as Pick<UsageStorePort, "queryAppUsage" | "queryTaskUsage">,
          listSessions: (input) => deps.sessionStore.listSessions(input),
          tzOffsetMs: resolveTzOffsetMs(timeZone, now),
          now,
        },
      });
      return { ok: result.ok, scope: result.scope?.kind ?? null, text: result.text };
    },
  };
}

async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 旧关闭链串行 await；Browser close 永不 settle 时，Execution/MCP 永远不会执行。
  // 各 owner 并行、独立带 deadline，任何一个失败都不能跳过其它资源。
  await Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}

async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = deps.runtime.getSessionModelSelection();
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
function goalStateChangeReminderText(action: undefined): undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}
