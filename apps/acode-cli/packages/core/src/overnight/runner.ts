// 机制参照 jcode (MIT)：crates/jcode-app-core/src/overnight.rs:231-384（run_supervisor 的
// 装配段：preflight → coordinator 创建 → 循环启动），自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 接口节「slash 指令解析 → fork coordinator
// → supervisor 启动」）。
//
// 本文件是 run 编排层：把第一段的纯模块（manifest/prompts/supervisor）与接线依赖
// （coordinator 任务端口、preflight 采集、runtime-task registry）组装成一个可驱动的 run。
// 所有副作用仍走注入面——bootstrap 装配处绑定真实端口，单测绑 mock（验收场景 7/8/9）。
import type { MessageWithParts, ModelSelection, SessionInfo } from "@acode/contracts";
import type {
  RuntimeTaskRegistry,
  RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import { formatOvernightDuration } from "./duration.js";
import { createOvernightManifest, computeOvernightPhase } from "./manifest.js";
import {
  collectOvernightPreflight,
  overnightPreflightPath,
  type OvernightPreflightCollectors,
} from "./preflight.js";
import { buildInitialCoordinatorPrompt } from "./prompts.js";
import {
  projectOvernightParentMessages,
  type OvernightCoordinatorPort,
} from "./coordinator.js";
import {
  createOvernightSupervisor,
  type OvernightRunResult,
  type OvernightSupervisor,
  type OvernightSupervisorEvent,
} from "./supervisor.js";
/** 内存趋势环的容量上限（R4：趋势可查；无界增长会拖垮快照投影）。 */
const MEMORY_TREND_MAX_SAMPLES = 32;

export interface OvernightRunnerDeps {
  parentTaskId: string;
  /** 已经过入口解析校验的时长（parseOvernightDuration ok 分支的产物）。 */
  durationMs: number;
  coordinator: OvernightCoordinatorPort;
  /** 父任务事实采集面（真实绑定读会话存储与父 runtime 选型；单测给桩）。 */
  getParentFacts(): Promise<{
    parentMessages: MessageWithParts[];
    parentSession: SessionInfo;
    modelSelection: ModelSelection | undefined;
  }>;
  /** preflight 工件写盘（接线层直接 fs 写，理由见 preflight.ts 文件头）。 */
  writePreflightReport(path: string, content: string): Promise<void>;
  preflightCollectors: OvernightPreflightCollectors;
  /** 晨报文件探测（真实绑定 probe workspace 下 overnightMorningReportPath）。 */
  morningReportExists(runId: string): Promise<boolean>;
  /** runtime-task 投影（R1：run 的唯一 UI 可见面）。 */
  taskRegistry: RuntimeTaskRegistry;
  /** 任务卡片计数（可选；缺席时快照不带 cardCount）。 */
  countTaskCards?(runId: string): Promise<number>;
  /** 内存采样源（R4 点名 process.memoryUsage().rss；注入以便离线单测）。 */
  collectMemorySample(): number;
  now?(): number;
  onEvent?(event: OvernightSupervisorEvent): void;
  /** 测试时钟注入（透传给 supervisor）。 */
  sleep?(ms: number): Promise<void>;
  schedule?(callback: () => void, delayMs: number): () => void;
}

export interface OvernightRunHandle {
  runId: string;
  taskId: string;
  supervisor: OvernightSupervisor;
  /** run 终态 promise（completed/failed；app 退出场景无需等待它——R1 生命周期绑定进程）。 */
  completion: Promise<OvernightRunResult>;
  /** `/overnight cancel` 与 runtime-task 终止面的写入点（协作式，R6）。 */
  requestCancel(): void;
  /**
   * 宿主关闭面（R1：app 退出 = run 终止）。标记 runtime-task 终止并请求取消；
   * 不等待在飞 turn 落定——进程退出本来就会带走它，等待反而让关闭流程悬挂。
   */
  dispose(): void;
}

function createOvernightRunId(nowMs: number): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `overnight-${nowMs.toString(36)}-${random}`;
}

export async function startOvernightRun(deps: OvernightRunnerDeps): Promise<OvernightRunHandle> {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const runId = createOvernightRunId(startedAtMs);
  const manifest = createOvernightManifest({
    runId,
    parentTaskId: deps.parentTaskId,
    startedAtMs,
    durationMs: deps.durationMs,
  });

  // 1. preflight 采集 + 工件落盘（R5：run 开始前；失败不阻断 run——采集物是观测面）。
  const preflightReport = await collectOvernightPreflight(
    {
      runId,
      startedAtMs,
      durationMs: deps.durationMs,
      targetWakeAtMs: manifest.targetWakeAtMs,
      parentTaskId: deps.parentTaskId,
    },
    deps.preflightCollectors,
  );
  await deps.writePreflightReport(overnightPreflightPath(runId), preflightReport);

  // 2. fork coordinator（R1：经任务服务面 fork 隐藏任务，继承父 messages 投影与 provider 配置）。
  const facts = await deps.getParentFacts();
  const projection = projectOvernightParentMessages(facts.parentMessages, facts.parentSession);
  if (!projection) {
    throw new Error(
      "overnight coordinator fork 需要父会话已有消息（当前会话为空，没有可继承的上下文）",
    );
  }
  const initialPrompt = buildInitialCoordinatorPrompt({
    runId,
    durationMs: deps.durationMs,
    targetWakeAtMs: manifest.targetWakeAtMs,
    preflightReport,
  });
  const lease = await deps.coordinator.forkCoordinatorTask({
    runId,
    parentTaskId: deps.parentTaskId,
    title: `Overnight ${formatOvernightDuration(deps.durationMs)}（${runId}）`,
    hidden: true,
    initialPrompt,
    inheritedMessages: projection.inheritedMessages,
    inheritedModelSelection: facts.modelSelection,
    targetMessageId: projection.targetMessageId,
  });

  // 3. runtime-task 投影注册（R1：唯一可见面；phase/卡片计数/内存趋势随事件刷新）。
  const taskId = lease.taskId;
  const memoryTrend: Array<{ atMs: number; rssBytes: number }> = [];
  const readPhase = (): string => computeOvernightPhase(manifest, now());
  const taskRegistry = deps.taskRegistry;
  taskRegistry.register({
    taskId,
    agentId: taskId,
    agentType: "overnight-coordinator",
    description: `Overnight run ${runId}（${formatOvernightDuration(deps.durationMs)}，父任务 ${deps.parentTaskId}）`,
    status: "running",
    startedAt: new Date(startedAtMs),
    type: "overnight",
    taskType: "overnight",
    isBackgrounded: true,
    overnight: {
      runId,
      phase: readPhase(),
    },
  });
  const patchOvernightSummary = (
    patch: Partial<NonNullable<RuntimeTaskSnapshot["overnight"]>>,
  ): void => {
    taskRegistry.update(taskId, (current) => ({
      ...current,
      overnight: {
        ...(current.overnight ?? { runId, phase: readPhase() }),
        ...patch,
      },
    }));
  };
  const refreshCardCount = (): void => {
    if (!deps.countTaskCards) return;
    void deps
      .countTaskCards(runId)
      .then((cardCount) => {
        patchOvernightSummary({ cardCount });
      })
      .catch(() => undefined);
  };

  // 4. supervisor 装配（真实驱动绑定：lease 的 turn 面 + 晨报探测 + 内存采样）。
  // 首轮 turn 输入 = fork 请求携带的 initialPrompt（角色/运营契约/产物约定/preflight）与
  // supervisor 本轮选出的 poke 指令拼接——fork 只建立会话与上下文继承，turn 驱动统一走
  // lease，避免「fork 时偷偷跑一轮」与 supervisor 循环形成两条驱动路径（R6 单写者原则的
  // turn 面等价物）。后续轮只发 poke 指令（首条 prompt 已完整声明契约，R3）。
  let initialPromptDelivered = false;
  // 取消源：handle 的两个入口（/overnight cancel 与 dispose）共写这一份标志，
  // supervisor 每轮循环顶重读（R1 协作式取消）。
  let cancelRequestedFlag = false;
  const supervisor = createOvernightSupervisor({
    manifest,
    runCoordinatorTurn: (pokePrompt) => {
      const input = initialPromptDelivered ? pokePrompt : `${initialPrompt}\n\n---\n\n${pokePrompt}`;
      initialPromptDelivered = true;
      return lease.runCoordinatorTurn(input);
    },
    morningReportExists: () => deps.morningReportExists(runId),
    cancelRequested: () => cancelRequestedFlag,
    now,
    onEvent: (event) => {
      deps.onEvent?.(event);
      if (event.type === "overnight.phase") {
        patchOvernightSummary({ phase: event.phase });
      } else if (event.type === "overnight.poke_sent") {
        refreshCardCount();
      } else if (event.type === "overnight.completed") {
        taskRegistry.update(taskId, (current) => ({
          ...current,
          completedAt: new Date(event.atMs),
          status: event.cancelled ? "cancelled" : "completed",
        }));
      } else if (event.type === "overnight.failed") {
        taskRegistry.update(taskId, (current) => ({
          ...current,
          completedAt: new Date(event.atMs),
          error: event.error,
          status: "failed",
        }));
      }
    },
    sampleResource: (atMs) => {
      // R4：采样本体在此（supervisor 只保证节奏）；趋势环有界。
      let rssBytes: number;
      try {
        rssBytes = deps.collectMemorySample();
      } catch {
        return;
      }
      memoryTrend.push({ atMs, rssBytes });
      if (memoryTrend.length > MEMORY_TREND_MAX_SAMPLES) memoryTrend.shift();
      const first = memoryTrend[0]!;
      const last = memoryTrend[memoryTrend.length - 1]!;
      patchOvernightSummary({
        memoryTrend: { samples: memoryTrend.length, firstRssBytes: first.rssBytes, lastRssBytes: last.rssBytes },
      });
    },
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  });

  let disposed = false;
  const handle: OvernightRunHandle = {
    runId,
    taskId,
    supervisor,
    completion: supervisor.start(),
    requestCancel: () => {
      cancelRequestedFlag = true;
      supervisor.requestCancel();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelRequestedFlag = true;
      supervisor.requestCancel();
      // R1：宿主关闭即终。任务条目打 cancelled（registry first-wins 保证不被后续终态覆盖），
      // 不等待在飞 turn——进程退出的语义本来就是硬终止，这里只把投影收口。
      taskRegistry.update(taskId, (current) => ({
        ...current,
        completedAt: new Date(now()),
        status: "cancelled",
        stopInitiator: "user",
      }));
    },
  };
  return handle;
}
