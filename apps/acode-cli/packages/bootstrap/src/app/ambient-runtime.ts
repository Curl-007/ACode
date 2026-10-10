// K6「Ambient 预算感知调度」接线层（specs/ambient-budget-scheduler.md R3 + 附录 A3）：
// 把 core 引擎层（core/src/ambient/ 八文件）绑到 CLI agent 进程的真实驱动面。
// 形态参照 overnight-controller.ts（K3 同款接缝），绑定事实：
//
// - cycle/spawn fork：runtime.forkWorkspaceFromCheckpoint（overnight fork 链同款——
//   「fork 全部父 messages 于当下」，targetMessageId 复用 session-fork 的 active 分支
//   选择器，不手写第二份分支语义）；provider 配置经子 runtime 的
//   setSessionModelSelection 显式继承；
// - turn 驱动：子 AgentRuntime.executeTurn（overnight lease 的同款驱动面）；
// - busy 信号：runtime.hasActiveOrQueuedTurnWork（activeTurn + CommandInQueue pending，
//   prompt-admission 的 busy 判定同源——「用户会话活跃」不新造信号）；
// - target=session 投递：recordGoalStateChangeReminder（K1/K2 的 reminder 载体先例：
//   messageHistory attachment + persisted synthetic notice，不起 agent）；
// - R4 权限收紧（附录 A2）：nonInteractive 翻译为 fork configOverrides 的 mode=plan
//   ——core permission 域零改动，plan 模式对非只读操作**同步 deny**
//   （mode.plan.nonReadOnly，不排队等审批）；被拒操作经 turn events 的
//   PermissionDenied 投影写回 AmbientCycleResult.deniedOperations；
// - quota 端口：ambient-quota.ts（余额面绑定，1:1 折算，附录登记）；
// - 数据根（附录 A4）：defaultAmbientDataRootDir 显式注入——ledger/queue 同根，
//   账本经 setSharedAmbientUsageLedger 成为 turn 旁路写的单一实例。
import type { SessionEvent, TraceContext } from "@acode/contracts";
import { SessionEventType } from "@acode/contracts";
import type { AgentRuntime, AgentRuntimeConfig } from "@acode/core";
import type { RuntimeTaskRegistry } from "@acode/core";
import {
  AdaptiveScheduler,
  AmbientScheduleQueue,
  AmbientUsageLedger,
  defaultAmbientDataRootDir,
  forkSourceMessagesForSession,
  getActiveAmbientRunner,
  markAmbientSession,
  setSharedAmbientUsageLedger,
  startAmbientRunner,
  type AmbientCyclePort,
  type AmbientDirectDeliveryPort,
  type AmbientQuotaSnapshot,
  type AmbientRunnerEvent,
  type AmbientRunnerHandle,
  type ScheduledItem,
} from "@acode/core";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "@acode/cli-workflow/contract";
import { createAmbientQuotaSnapshotPort } from "./ambient-quota.js";
import type { ACodeAppOptions } from "./types.js";

export interface CreateAmbientRuntimeWiringDeps
  extends Omit<ScriptWorkflowAgentRuntimeDeps, "runtime" | "appOptions"> {
  /**
   * W1-R3：引擎只消费窄宿主面（ScriptWorkflowHostOptions），而 bootstrap 装配期还要读
   * providerRegistry / providerRuntimeHeadersPort（ambient quota 快照），所以本侧 deps
   * 保留完整 ACodeAppOptions；传入引擎时结构化可赋值，行为不变。
   */
  appOptions: ACodeAppOptions;
  /** ambient cycle/spawn 的 runtime-task 投影面（create-app 装配期注入 runtime 的同一份）。 */
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /** fork/reminder/registry 投影共用的根 trace（overnight controller 的同款必填项）。 */
  traceContext: TraceContext;
}

export interface AmbientSchedulePortBinding {
  queue: AmbientScheduleQueue;
  onScheduleCreated(item: ScheduledItem): void;
}

export interface AmbientRuntimeWiring {
  /** Schedule 工具注册门输入（runtime deps 的 ambientSchedulePort 消费）。 */
  readonly port: AmbientSchedulePortBinding;
  /** runtime 实例就绪后绑定 fork/reminder/busy 驱动面（swarmPlanWiring.bindRuntime 同款先后序）。 */
  bindRuntime(runtime: AgentRuntime): void;
  /** flag 开时启动 runner（bindRuntime 之后调用；幂等）。 */
  start(): Promise<void>;
  /** app 关闭面：dispose runner + flush 账本缓冲（幂等）。 */
  dispose(): Promise<void>;
}

const LOG_MODULE = "bootstrap.ambient";

export function createAmbientRuntimeWiring(deps: CreateAmbientRuntimeWiringDeps): AmbientRuntimeWiring {
  const logger = deps.logger;
  const env = deps.appOptions.env ?? process.env;
  // 附录 A4：数据根显式注入。CLI 进程无 services 实例（getDataBaseDir 的进程内覆盖是
  // services 私有态），defaultAmbientDataRootDir 镜像其 env > HOME > homedir 优先级；
  // 显式传参让「账本与队列同根」成为装配期事实而不是惰性缺省的巧合。
  const dataRootDir = defaultAmbientDataRootDir(env);
  const logWarn = (message: string, details?: Record<string, unknown>) =>
    logger.warn(message, { ...details, module: LOG_MODULE });
  const logInfo = (message: string, details?: Record<string, unknown>) =>
    logger.info(message, { ...details, module: LOG_MODULE });
  // 共享账本（turn 旁路写的单一写入点）无论 flag 开关都注入：usage 记录是数据面
  //（R1），调度消费是另一个面（R3）——数据面常开，开启 flag 时才有历史速率可用。
  const ledger = new AmbientUsageLedger({ dataRootDir, warn: logWarn });
  setSharedAmbientUsageLedger(ledger);
  const queue = new AmbientScheduleQueue({ dataRootDir });
  const enabled = deps.runtimeConfig.ambient?.enabled === true;

  let runtimeRef: AgentRuntime | undefined;
  let runnerHandle: AmbientRunnerHandle | null = null;
  let disposed = false;
  let startPromise: Promise<void> | undefined;

  const scriptWorkflowDeps: ScriptWorkflowAgentRuntimeDeps = {
    appOptions: deps.appOptions,
    appVersion: deps.appVersion,
    ...(deps.artifactStore ? { artifactStore: deps.artifactStore } : {}),
    configResult: deps.configResult,
    ...(deps.contextSourcePort ? { contextSourcePort: deps.contextSourcePort } : {}),
    fileSystemPort: deps.fileSystemPort,
    ...(deps.httpClientPort ? { httpClientPort: deps.httpClientPort } : {}),
    imageProcessorPort: deps.imageProcessorPort,
    logger: deps.logger,
    ...(deps.mcpPort ? { mcpPort: deps.mcpPort } : {}),
    modelFactory: deps.modelFactory,
    permissionService: deps.permissionService,
    runtime: undefined as unknown as AgentRuntime, // bindRuntime 后才使用；见 forkAmbientChildRuntime
    runtimeConfig: deps.runtimeConfig,
    sessionId: deps.sessionId,
    sessionStore: deps.sessionStore,
    storageRoot: deps.storageRoot,
    workingDirectory: deps.workingDirectory,
  };

  const quotaSnapshot: (() => Promise<AmbientQuotaSnapshot | null>) | undefined =
    createAmbientQuotaSnapshotPort({
      // 账号上下文从 provider 装配面取：registry 的 zhipu-account access 判家族，
      // providerRuntimeHeadersPort 刷请求凭据（CLI 形态为 standalone coding plan 面）。
      providerRegistry: deps.appOptions.providerRegistry,
      ...(deps.appOptions.providerRuntimeHeadersPort
        ? { providerRuntimeHeadersPort: deps.appOptions.providerRuntimeHeadersPort }
        : {}),
      getSelection: () => runtimeRef?.getSessionModelSelection(),
      sessionId: deps.sessionId,
      traceContext: deps.traceContext,
      env,
    });

  const scheduler = new AdaptiveScheduler({
    getHourlyRate: (nowMs) => ledger.getHourlyRate(nowMs),
    getRecentCycles: (n) => ledger.getRecentCycles(n),
    ...(quotaSnapshot ? { getQuotaSnapshot: quotaSnapshot } : {}),
  });

  /**
   * fork 隐藏 ambient 子会话（overnight forkCoordinatorTask 的同款链）：
   * forkWorkspaceFromCheckpoint fork 全部父 messages 于当下 → 子 runtime 复用
   * createScriptWorkflowAgentRuntime 装配线（共享 sessionStore/eventStore/ports），
   * 差异经 configOverrides 表达。返回 null 表示父会话没有可 fork 的 active 消息。
   *
   * kind（F9，批次C）：cycle 路径标记 ambient session（消耗从用户速率剔除——预算
   * 公式防正反馈死锁）；spawn 路径**不标记**——spawn 是用户显式定时的工作单，消耗
   * 计入 user 速率（保守方向：用户自己托付的工作占用户预算，不该被 ambient 剔除）。
   */
  async function forkAmbientChildRuntime(
    kind: "ambient-cycle" | "spawn" = "ambient-cycle",
  ): Promise<AgentRuntime | null> {
    const runtime = runtimeRef;
    if (!runtime) throw new Error("ambient wiring: runtime binding is not ready");
    const parentSession = await deps.sessionStore.getSession(deps.sessionId);
    if (!parentSession) {
      throw new Error(`ambient fork 找不到父会话 ${String(deps.sessionId)}`);
    }
    const parentMessages = await deps.sessionStore.messages({ sessionID: deps.sessionId });
    const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
    if (activeMessages.length === 0) return null;
    const forked = await runtime.forkWorkspaceFromCheckpoint({
      targetMessageId: activeMessages[activeMessages.length - 1]!.info.id,
      traceContext: deps.traceContext,
    });
    const childRuntime = createScriptWorkflowAgentRuntime({
      childSessionId: forked.forkedSessionId,
      deps: scriptWorkflowDeps,
      // 与 create-app 的 run service 装配同款：request 只是工厂签名占位（opts 为空 =
      // 不覆盖任何东西），ambient 的差异全部经 configOverrides 表达。
      request: { opts: {} } as never,
      traceContext: deps.traceContext,
      configOverrides: ambientChildConfigOverrides(),
    });
    // provider 配置继承：legacy fork 链不复制选型 entry，显式绑定父会话当前选择
    //（overnight 的同款注释——内存绑定即完整）。
    const parentSelection = runtime.getSessionModelSelection();
    if (parentSelection) {
      childRuntime.setSessionModelSelection(parentSelection);
    }
    // 附录 A3：fork 端口绑定处登记 ambient 会话标记——turn 计量旁路写按它判
    // kind=ambient（自身消耗从用户速率剔除，防预算公式正反馈死锁）。
    // F9：仅 cycle 路径标记；spawn 的 fork 不标（消耗留在 user 速率）。
    if (kind === "ambient-cycle") {
      markAmbientSession(String(childRuntime.getSessionId()));
    }
    return childRuntime;
  }

  /**
   * R4（附录 A2）：nonInteractive 的 fork configOverrides 翻译。mode=plan 是
   * configOverrides 上唯一现成的「非交互直接拒绝」面——plan 模式对非只读操作同步
   * deny（mode.plan.nonReadOnly，不排队等审批），比 R4 字面的「confirm 及以上拒绝」
   * 更严（edit 级也拒）：方向一致（收紧），「后台周期检查 = 只读观察」的语义下
   * 保守面更贴。overnight 沿用父 mode 是「不放宽」；ambient 收紧到 plan 是 R4 的
   * 无人值守红线。subagents 关闭：后台周期检查不派 helper（与 dwf child 同收紧面）。
   */
  function ambientChildConfigOverrides(): Partial<AgentRuntimeConfig> {
    return {
      agentName: "acode-ambient",
      mode: "plan",
      subagents: { enabled: false },
      // 与落盘 child session 的 taskType 对齐（buildForkedSessionInput 的 "fork"）。
      taskType: "fork",
    };
  }

  /** R4：从子会话 turn events 投影被非交互权限面拒绝的操作（denied 事件的载荷面）。 */
  function collectDeniedOperations(events: readonly SessionEvent[]): string[] {
    const denied = new Set<string>();
    for (const event of events) {
      if (event.type !== SessionEventType.PermissionDenied) continue;
      const toolName = (event.payload as { toolName?: unknown }).toolName;
      if (typeof toolName === "string" && toolName) denied.add(toolName);
    }
    return [...denied];
  }

  /** registry 投影（RuntimeTaskType "ambient"——runner 驱动的非工具派生任务，overnight 同款先例）。 */
  function registerAmbientTask(taskId: string, description: string, prompt: string): void {
    deps.runtimeTaskRegistry.register({
      agentId: taskId,
      agentType: "ambient",
      description,
      prompt,
      startedAt: new Date(),
      status: "running",
      parentSessionId: deps.sessionId,
      taskId,
      traceContext: deps.traceContext,
      type: "ambient",
    });
  }

  const cyclePort: AmbientCyclePort = {
    async runAmbientCycle(request) {
      try {
        const child = await forkAmbientChildRuntime();
        if (!child) {
          return { status: "failed", responseText: "parent session has no forkable active messages" };
        }
        registerAmbientTask(
          request.cycleId,
          `ambient cycle: ${request.items.map((item) => item.taskDescription).join("; ")}`,
          request.prompt,
        );
        const result = await child.executeTurn(request.prompt, undefined, {
          traceContext: deps.traceContext,
        });
        const deniedOperations = collectDeniedOperations(result.events);
        return {
          status: "completed",
          responseText: result.response,
          ...(deniedOperations.length > 0 ? { deniedOperations } : {}),
        };
      } catch (error) {
        return {
          status: "failed",
          responseText: error instanceof Error ? error.message : String(error),
        };
      } finally {
        deps.runtimeTaskRegistry.remove(request.cycleId);
      }
    },
  };

  const deliveryPort: AmbientDirectDeliveryPort = {
    async deliverReminder(item) {
      const runtime = runtimeRef;
      if (!runtime) throw new Error("ambient wiring: runtime binding is not ready");
      // 投递目标 = 创建会话。CLI app 一会话一 runtime；跨会话/跨进程残留项跳过
      //（direct 项是一次性语义，投错会话比丢失更糟——engine 投递失败不重投的同口径）。
      if (
        item.createdBySession !== undefined &&
        item.createdBySession !== String(runtime.getSessionId())
      ) {
        logWarn("Ambient session reminder skipped: creating session is not this app's session", {
          event: "ambient.reminder.foreign_session",
          scheduleId: item.scheduleId,
        });
        return;
      }
      // K1/K2 的 reminder 载体先例：attachment + persisted synthetic notice，不起 agent；
      // active turn 在场时它自带「落在 tool_use/tool_result 之间」的 deferral 防护。
      await runtime.recordGoalStateChangeReminder({
        text: `[ambient schedule] ${item.taskDescription}`,
        traceContext: deps.traceContext,
      });
    },
    async spawnTask(item) {
      try {
        // F9（批次C）：spawn 的 fork 不标记 ambient session——turn 用量按 kind="user"
        // 记账（用户显式定时的工作单计入用户速率，保守方向）。
        const child = await forkAmbientChildRuntime("spawn");
        if (!child) {
          throw new Error("parent session has no forkable active messages");
        }
        const taskId = `ambient-spawn-${item.scheduleId}`;
        registerAmbientTask(taskId, `ambient spawn: ${item.taskDescription}`, item.taskDescription);
        try {
          // spawn 是用户显式定时的工作单：prompt 即 taskDescription（自包含指令），
          // 不解析 cycle 自提议围栏（那是 ambient cycle 的语义）。
          await child.executeTurn(item.taskDescription, undefined, {
            traceContext: deps.traceContext,
          });
        } finally {
          deps.runtimeTaskRegistry.remove(taskId);
        }
      } catch (error) {
        // 投递失败不重投（engine 注释同口径）：记录在日志面，周期性需求应走 cron。
        logWarn("Ambient spawn delivery failed", {
          event: "ambient.spawn.failed",
          scheduleId: item.scheduleId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  function logRunnerEvent(event: AmbientRunnerEvent): void {
    // 生产可见的生命周期面落 info（AGENTS.md 日志分级：会话/进程生命周期 = info；
    // cycle 内部细节不在此重复——engine 的 debug 面不在 CLI 落盘）。
    logInfo("Ambient runner event", { event: `ambient.runner.${event.type}`, ...event });
  }

  async function startRunner(): Promise<void> {
    if (!enabled || disposed) return;
    const result = await startAmbientRunner({
      enabled: true,
      queue,
      scheduler,
      cyclePort,
      deliveryPort,
      // 用户会话活跃探测：既有 busy 面（activeTurn + CommandInQueue pending），
      // prompt-admission 的 busy 判定同源——不新造信号。
      isBusy: () => runtimeRef?.hasActiveOrQueuedTurnWork() ?? false,
      now: () => Date.now(),
      logger: { warn: logWarn, info: logInfo },
      onEvent: logRunnerEvent,
    });
    runnerHandle = result.handle;
    if (!result.handle) {
      logWarn("Ambient runner did not start", { event: "ambient.runner.start_refused", reason: result.reason });
    }
  }

  const wiring: AmbientRuntimeWiring = {
    port: {
      queue,
      onScheduleCreated: () => {
        // R3 wake nudge / idle 重启缝：active runner 在场则 nudge（sleep 截短——
        // direct 项到期提前唤醒）；idle/stopped（cycle 无自提议停循环后）重启，
        // 即「新 schedule 创建可重启」路径。
        const active = getActiveAmbientRunner();
        if (
          active &&
          (active.getStatus() === "scheduled" || active.getStatus() === "paused")
        ) {
          active.nudge();
          return;
        }
        if (enabled && !disposed) void startRunner();
      },
    },
    bindRuntime(runtime) {
      runtimeRef = runtime;
      scriptWorkflowDeps.runtime = runtime;
    },
    async start() {
      if (!enabled || disposed) return;
      // ambient 是可选增强（flag 门控），启动面异常不得阻断 app 创建：记 warn 后
      // 由下一次 onScheduleCreated 的重启缝重试。startPromise 缓存保证幂等。
      startPromise ??= startRunner().catch((error) => {
        logWarn("Ambient runner start failed", {
          event: "ambient.runner.start_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
      await startPromise;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const handle = runnerHandle;
      runnerHandle = null;
      await handle?.dispose();
      // 关停路径显式落盘缓冲（ledger 的 flush 语义：dispose/关停面调用）。
      await ledger.flush();
    },
  };
  return wiring;
}
