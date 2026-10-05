// 机制参照 jcode (MIT)：crates/jcode-app-core/src/overnight.rs（run_supervisor 循环 /
// 三层时间点消费 / 四种一次性 poke / run_turn_monitored 双 ticker），自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 R2/R4/R6）。
//
// 本文件是纯模块层状态机骨架：真实 turn 驱动、runtime-task 注册、fork 接线属于下一段；
// 所有副作用（时间、sleep、取消源、晨报探测、资源采样）均为注入接口，可离线单测。
import {
  MAX_CONSECUTIVE_TURN_FAILURES,
  RESOURCE_SAMPLE_MS,
  SUPERVISOR_TICK_MS,
  TURN_LONG_NOTICE_MS,
} from "./constants.js";
import {
  computeOvernightPhase,
  nextPhasePointMs,
  selectOvernightPoke,
  type OvernightManifest,
  type OvernightPhase,
} from "./manifest.js";
import { renderOvernightPokePrompt } from "./prompts.js";

/** 一轮 coordinator turn 的结果形态（注入接口约定；抛错由 supervisor 折算为失败）。 */
export interface OvernightTurnResult {
  ok: boolean;
  error?: string;
}

/** supervisor 事件面（R4 点名 `overnight.turn_long_running` 为 warn 级）。 */
export type OvernightSupervisorEvent =
  | { type: "overnight.started"; runId: string; atMs: number; targetWakeAtMs: number }
  | {
      type: "overnight.phase";
      runId: string;
      atMs: number;
      phase: OvernightPhase;
      previousPhase: OvernightPhase | null;
    }
  | { type: "overnight.poke_sent"; runId: string; atMs: number; kind: string; resend: boolean }
  | { type: "overnight.morning_report_missing"; runId: string; atMs: number; attempts: number }
  | { type: "overnight.morning_report_confirmed"; runId: string; atMs: number }
  | {
      type: "overnight.turn_failed";
      runId: string;
      atMs: number;
      consecutiveFailures: number;
      error?: string;
    }
  | { type: "overnight.turn_long_running"; runId: string; atMs: number; level: "warn"; elapsedMs: number }
  | { type: "overnight.resource_sampled"; runId: string; atMs: number; level: "info" }
  | { type: "overnight.completed"; runId: string; atMs: number; cancelled: boolean }
  | { type: "overnight.failed"; runId: string; atMs: number; error?: string };

export interface OvernightSupervisorDeps {
  /** 初始 manifest（supervisor 防御性拷贝后独占写权，R6：唯一写者）。 */
  manifest: OvernightManifest;
  /** 驱动一轮 coordinator turn（追加指令 prompt 作为用户侧消息注入）。 */
  runCoordinatorTurn(prompt: string): Promise<OvernightTurnResult>;
  /** 晨报文件探测（R5：完成标志 = 文件存在）。 */
  morningReportExists(): Promise<boolean>;
  /** 取消标志读取源（`/overnight cancel` 或 runtime-task 终止面写入，R1）。 */
  cancelRequested(): boolean;
  /** 墙钟（相位判定用；turn 监控间隔同源注入，见 schedule）。 */
  now(): number;
  onEvent(event: OvernightSupervisorEvent): void;
  /** 循环间等待（可注入测试桩；默认真实 setTimeout）。 */
  sleep?(ms: number): Promise<void>;
  /** monitored turn 的 ticker 调度（可注入测试桩；默认真实 setTimeout）。 */
  schedule?(callback: () => void, delayMs: number): () => void;
  /** 资源采样回调（R4：采样本体是接线层职责，本段只保证节奏）。 */
  sampleResource?(atMs: number): void;
}

export interface OvernightRunResult {
  status: "completed" | "failed";
  cancelled: boolean;
  manifest: OvernightManifest;
}

export interface OvernightSupervisor {
  /** 启动循环；终态（completed/failed）时 resolve。重复调用返回同一 promise。 */
  start(): Promise<OvernightRunResult>;
  /** manifest 快照（浅拷贝 + pokes 拷贝；调用方不得借此改状态）。 */
  snapshot(): OvernightManifest;
  /** 本实例内存取消标志（R6：取消是协作式，当前 turn 跑完才终态）。 */
  requestCancel(): void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export function createOvernightSupervisor(deps: OvernightSupervisorDeps): OvernightSupervisor {
  // R6 不变量：supervisor 是 manifest 唯一写者——拷贝入参，调用方持有的引用改字段不影响状态机
  const manifest: OvernightManifest = { ...deps.manifest, pokes: { ...deps.manifest.pokes } };
  const sleep = deps.sleep ?? defaultSleep;
  const schedule = deps.schedule ?? defaultSchedule;

  let consecutiveFailures = 0;
  let lastPhase: OvernightPhase | null = null;
  let cancelRequestedLocally = false;
  let runPromise: Promise<OvernightRunResult> | null = null;

  const emit = (event: OvernightSupervisorEvent): void => {
    try {
      deps.onEvent(event);
    } catch {
      // 事件面是可观测性而非控制面：观察者抛错不能中断 run
    }
  };

  function snapshot(): OvernightManifest {
    return { ...manifest, pokes: { ...manifest.pokes } };
  }

  function finish(): OvernightRunResult {
    return {
      status: manifest.status === "failed" ? "failed" : "completed",
      cancelled: manifest.cancelled,
      manifest: snapshot(),
    };
  }

  function reportPhase(nowMs: number): void {
    const phase = computeOvernightPhase(manifest, nowMs);
    if (phase !== lastPhase) {
      emit({ type: "overnight.phase", runId: manifest.runId, atMs: nowMs, phase, previousPhase: lastPhase });
      lastPhase = phase;
    }
  }

  /**
   * R4 monitored turn：turn 上叠双 ticker（30min 长运行 warn / 5min 资源采样），
   * jcode tokio::select! 双 ticker 的 JS 等价——用可取消的自续 ticker 实现，
   * turn 落定即取消全部计时，不留悬挂定时器（R2 场景 9 的「无残留定时器」要求）。
   */
  async function runTurnMonitored(prompt: string): Promise<OvernightTurnResult> {
    const startMs = deps.now();
    let nextNoticeAt = startMs + TURN_LONG_NOTICE_MS;
    let nextSampleAt = startMs + RESOURCE_SAMPLE_MS;
    let settled = false;
    // 用持有对象而非裸 let：cancel 只在闭包内被赋值，裸变量会被 TS 流分析缩窄成 null
    const tick = { cancel: (): void => {} };

    const armNextTick = (): void => {
      const nextAt = Math.min(nextNoticeAt, nextSampleAt);
      tick.cancel = schedule(() => {
        if (settled) return;
        const atMs = deps.now();
        if (atMs >= nextNoticeAt) {
          // 长任务合法，不中断，只保证可观测；每 30min 重复提醒
          emit({
            type: "overnight.turn_long_running",
            runId: manifest.runId,
            atMs,
            level: "warn",
            elapsedMs: atMs - startMs,
          });
          nextNoticeAt += TURN_LONG_NOTICE_MS;
        }
        if (atMs >= nextSampleAt) {
          deps.sampleResource?.(atMs);
          emit({ type: "overnight.resource_sampled", runId: manifest.runId, atMs, level: "info" });
          nextSampleAt += RESOURCE_SAMPLE_MS;
        }
        armNextTick();
      }, Math.max(0, nextAt - deps.now()));
    };
    armNextTick();

    try {
      const result = await deps.runCoordinatorTurn(prompt);
      if (result && result.ok) return { ok: true };
      return { ok: false, error: result?.error };
    } catch (error) {
      // turn 抛错 ≠ supervisor 崩溃：折算为一次失败，交由连续失败熔断（R4/R2）
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      settled = true;
      tick.cancel();
    }
  }

  /**
   * R5 收紧语义：晨报标志只在文件确认后置位。文件探测失败按「不存在」处理——
   * 宁可下轮重发（前置提醒），不误置完成标志（fail-safe 方向）。
   */
  async function settleMorningReport(): Promise<void> {
    let exists = false;
    try {
      exists = await deps.morningReportExists();
    } catch {
      exists = false;
    }
    const atMs = deps.now();
    if (exists) {
      manifest.morningReportPostedAtMs = atMs;
      manifest.pokes.morningReport = true;
      emit({ type: "overnight.morning_report_confirmed", runId: manifest.runId, atMs });
    } else {
      manifest.morningReportAttempts += 1;
      emit({
        type: "overnight.morning_report_missing",
        runId: manifest.runId,
        atMs,
        attempts: manifest.morningReportAttempts,
      });
    }
  }

  async function runLoop(): Promise<OvernightRunResult> {
    emit({
      type: "overnight.started",
      runId: manifest.runId,
      atMs: deps.now(),
      targetWakeAtMs: manifest.targetWakeAtMs,
    });
    for (;;) {
      // 1. 每轮重读取消标志（R1：跨轮取消必须生效；来源 = 注入源 ∪ 本实例内存标志）
      if (manifest.status === "running" && (cancelRequestedLocally || deps.cancelRequested())) {
        manifest.status = "cancel-requested";
      }
      if (manifest.status === "cancel-requested") {
        // 协作式取消（R6）：当前 turn 已在上一轮完整收尾，此刻才落终态——不做 mid-turn kill，
        // kill 会掩盖状态不一致（与「不能用超时掩盖同步问题」同族约束）
        manifest.status = "completed";
        manifest.cancelled = true;
        emit({ type: "overnight.completed", runId: manifest.runId, atMs: deps.now(), cancelled: true });
        return finish();
      }

      // 2. 完成判定（R2）：finalWrapup 上一轮已发出 → 本轮直接终态，不再驱动 turn
      if (manifest.pokes.finalWrapup) {
        manifest.status = "completed";
        emit({ type: "overnight.completed", runId: manifest.runId, atMs: deps.now(), cancelled: false });
        return finish();
      }

      // 3. 相位判定 + poke 选择（均为纯函数，R2/R6：phase 计算无状态）
      const nowMs = deps.now();
      reportPhase(nowMs);
      const poke = selectOvernightPoke(manifest, nowMs);
      const prompt = renderOvernightPokePrompt(poke, { runId: manifest.runId });
      emit({ type: "overnight.poke_sent", runId: manifest.runId, atMs: nowMs, kind: poke.kind, resend: poke.resend });

      // 4. 驱动一轮 monitored turn
      const result = await runTurnMonitored(prompt);

      // 5. turn 后更新：失败熔断先行（failed 终态优先于任何标志语义）
      if (result.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        emit({
          type: "overnight.turn_failed",
          runId: manifest.runId,
          atMs: deps.now(),
          consecutiveFailures,
          error: result.error,
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_TURN_FAILURES) {
          manifest.status = "failed";
          emit({ type: "overnight.failed", runId: manifest.runId, atMs: deps.now() });
          return finish();
        }
      }

      // 6. 一次性标志更新（R3）：三种 poke 对齐 jcode「发出即置位」；
      //    晨报是唯一例外——R5 收紧为文件确认后置位（不确认则每轮重发）。
      if (poke.kind === "handoff-ready") {
        manifest.pokes.handoffReady = true;
      } else if (poke.kind === "post-wake-continuation") {
        manifest.pokes.postWakeContinuation = true;
      } else if (poke.kind === "final-wrapup") {
        manifest.pokes.finalWrapup = true;
      } else if (poke.kind === "morning-report") {
        await settleMorningReport();
      }

      // 7. finalWrapup 已发 → 终态已定，跳过等待直接进入下一轮完成判定
      if (manifest.pokes.finalWrapup) continue;

      // 8. 等待间隔 = min(下次相位点剩余, 60s)（R2）——相位点临近时收窄等待，
      //    否则固定 tick，保证取消标志的响应延迟上界为 60s
      const afterMs = deps.now();
      const nextPoint = nextPhasePointMs(manifest, afterMs);
      const remaining = nextPoint === null ? Number.POSITIVE_INFINITY : nextPoint - afterMs;
      await sleep(Math.max(0, Math.min(remaining, SUPERVISOR_TICK_MS)));
    }
  }

  return {
    start(): Promise<OvernightRunResult> {
      if (!runPromise) {
        // 兜底：supervisor 自身 bug 也不能让 start() 的 promise 悬死（调用方依赖可观测终态）
        runPromise = runLoop().catch((error: unknown): OvernightRunResult => {
          manifest.status = "failed";
          emit({
            type: "overnight.failed",
            runId: manifest.runId,
            atMs: deps.now(),
            error: error instanceof Error ? error.message : String(error),
          });
          return finish();
        });
      }
      return runPromise;
    },
    snapshot,
    requestCancel(): void {
      cancelRequestedLocally = true;
    },
  };
}
