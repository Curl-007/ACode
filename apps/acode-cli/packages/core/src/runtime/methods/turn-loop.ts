import { beginLocalTurnPreparation } from "@acode/contracts";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildMemoryRecallReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildRuntimeRestartReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  buildSemanticMemoryRecallReminderBody,
  buildUltracodeKeywordReminderBody,
  shouldEmitUltracodeKeywordReminder,
  createCompactRapidRefillError,
  findOrphanedBackgroundTaskIds,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getRuntimeLifecyclePort } from "../runtime-lifecycle.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  evaluateRapidRefill,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const tools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
    finishTools();
    if (
      !outputTokenRecoveryActive &&
      getRuntimeLifecyclePort(this).consumePlanModeExitReminder()
    ) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    // 重启孤儿任务提醒：per-request 档 + runtime_local 一次性触发，评估即消费
    // （specs/runtime-restart-task-reminder.md R2/R3）。首 turn 时本进程尚无后台任务
    // （launch 只发生在 turn 内），registry 谓词在该时点恒真；flag 防同进程重复注入。
    if (
      !outputTokenRecoveryActive &&
      getRuntimeLifecyclePort(this).consumeRuntimeRestartReminder()
    ) {
      const orphanedTaskIds = findOrphanedBackgroundTaskIds({
        entries: state.turnRequestState.entries,
        isTaskKnownToRuntime: (taskId) => this.runtimeTaskRegistry.get(taskId) !== undefined,
      });
      const runtimeRestartReminderBody = buildRuntimeRestartReminderBody(orphanedTaskIds);
      if (runtimeRestartReminderBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("runtime_restart_tasks", runtimeRestartReminderBody),
        ]);
      }
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      // 列表无未完成项时 body 为 null：此时既不提交 attachment，也不落 persisted notice，
      // 避免「没有可跟踪工作却每 10 turn 落一条 synthetic notice」
      // （specs/reminder-extensions.md R1 条件 5 / R2）。
      const reminderBody = buildTodoReminderBody(currentTodos);
      if (reminderBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("todo_reminder", reminderBody),
        ]);
        await this.persistSyntheticUserNoticeForSession({
          messageID: createMessageId(),
          metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
          sessionId: this.sessionId,
          source: "todo_reminder",
          text: reminderBody,
          traceContext: state.turnTraceContext,
        });
      }
    }
    // 召回记忆提醒：per-request 档，只进本轮请求 entries，不落 session
    // （specs/reminder-extensions.md R3；档位判据见 R4）。
    const memoryRecallReminderBody = outputTokenRecoveryActive
      ? null
      : buildMemoryRecallReminderBody({
          entries: state.turnRequestState.entries,
          memoryRoot: this.memoryRoot,
          memoryIndexContent: this.memoryIndexContent,
        });
    if (memoryRecallReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("memory_recall", memoryRecallReminderBody),
      ]);
    }
    // K1 语义召回动态注入（specs/memory-semantic-recall.md R6）：每个 Main turn 的首个
    // 模型请求前执行一次（modelStepCount===0：turn 内后续 step 是工具循环，query 不变，
    // 重复检索只浪费 IO；outputTokenContinuation 是恢复请求，同样不重复注入）。走
    // per-request 动态段（memory_semantic_recall），不进 context section / 前缀缓存段。
    if (!outputTokenRecoveryActive && state.modelStepCount === 0) {
      const semanticRecallBody = await buildSemanticMemoryRecallReminderBody(this, {
        entries: state.turnRequestState.entries,
        traceContext: state.turnTraceContext,
      });
      if (semanticRecallBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("memory_semantic_recall", semanticRecallBody),
        ]);
      }
    }
    // ultracode 关键词触发（specs/script-workflow-revival.md 批次 C2）：与语义召回同款，
    // 每个 Main turn 的首个模型请求前判定一次（turn 内后续 step 是工具循环，用户文本不变，
    // 重复判定只会重复注入同一条）。正文纯由当轮用户文本派生，走 per-request 动态段。
    if (!outputTokenRecoveryActive && state.modelStepCount === 0) {
      const ultracodeReminderBody = shouldEmitUltracodeKeywordReminder({
        dynamicWorkflowEnabled: this.config.dynamicWorkflowEnabled,
        entries: state.turnRequestState.entries,
      })
        ? buildUltracodeKeywordReminderBody()
        : null;
      if (ultracodeReminderBody) {
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("ultracode_keyword", ultracodeReminderBody),
        ]);
      }
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    const providerEntries = [...state.turnRequestState.entries];
    const requestEntries = providerEntries;
    // provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = buildRuntimeProviderRequestMessages(this, {
      entries: requestEntries,
      applyCacheControl: true,
      model: state.model,
    });
    const { messages } = providerProjection;
    const recordableEntries = filterOutputTokenContinuationEntries(requestEntries);
    const recordableProjection =
      recordableEntries === requestEntries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools,
    });

    if (result === "break") {
      break;
    }
  }
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // 闲时执行轮禁止再创建闲时任务（防递归自我派生）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
