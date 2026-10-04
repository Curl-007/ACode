// 机制参照 jcode (MIT)：crates/jcode-overnight-core（OvernightManifest / 三层时间点 /
// 相位计算 overnight_phase / 四种一次性 poke），自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 R2）。
import { POST_WAKE_GRACE_MS, handoffLeadMs, OVERNIGHT_MAX_MS, OVERNIGHT_MIN_MS } from "./constants.js";

export type OvernightRunStatus = "running" | "cancel-requested" | "completed" | "failed";

/** 五相位（R2）：running → wind-down → morning-report → post-wake → finalizing。 */
export type OvernightPhase = "running" | "wind-down" | "morning-report" | "post-wake" | "finalizing";

/** 五种 poke：四种一次性（R3 表）+ 常规 continuation。 */
export type OvernightPokeKind =
  | "continuation"
  | "handoff-ready"
  | "morning-report"
  | "post-wake-continuation"
  | "final-wrapup";

/** 一次性标志（R6：单调置位不回清；supervisor 是唯一写者）。 */
export interface OvernightPokeFlags {
  handoffReady: boolean;
  morningReport: boolean;
  postWakeContinuation: boolean;
  finalWrapup: boolean;
}

export interface OvernightManifest {
  runId: string;
  parentTaskId: string;
  startedAtMs: number;
  targetWakeAtMs: number;
  /** 派生：target − min(30min, duration/4)（R2）。 */
  handoffReadyAtMs: number;
  /** 派生：target + 2h（R2）。 */
  postWakeGraceUntilMs: number;
  /** R5 收紧语义：只在晨报文件确认后写入。 */
  morningReportPostedAtMs: number | null;
  /** 晨报 poke 已发出但文件未确认的次数（重发 prompt 的前置提醒依据，R5）。 */
  morningReportAttempts: number;
  pokes: OvernightPokeFlags;
  status: OvernightRunStatus;
  /** 取消落终态时打标记：completed + cancelled（R2 完成判定）。 */
  cancelled: boolean;
}

/** poke 选择结果：`resend` 仅对晨报为真（文件未确认导致的重发，R5）。 */
export interface OvernightPokeSelection {
  kind: OvernightPokeKind;
  resend: boolean;
}

/**
 * 构造 manifest 并派生三个时间点。duration 应先经 parseOvernightDuration 校验；
 * 此处的范围断言只防「绕过解析直调工厂」的编程错误（不可达路径），不是用户输入面。
 */
export function createOvernightManifest(input: {
  runId: string;
  parentTaskId: string;
  startedAtMs: number;
  durationMs: number;
}): OvernightManifest {
  if (input.durationMs < OVERNIGHT_MIN_MS || input.durationMs > OVERNIGHT_MAX_MS) {
    throw new Error(
      `overnight duration 越界：${input.durationMs}ms，允许范围 [${OVERNIGHT_MIN_MS}, ${OVERNIGHT_MAX_MS}]（应经 parseOvernightDuration 校验后传入）`,
    );
  }
  return {
    runId: input.runId,
    parentTaskId: input.parentTaskId,
    startedAtMs: input.startedAtMs,
    targetWakeAtMs: input.startedAtMs + input.durationMs,
    handoffReadyAtMs: input.startedAtMs + input.durationMs - handoffLeadMs(input.durationMs),
    postWakeGraceUntilMs: input.startedAtMs + input.durationMs + POST_WAKE_GRACE_MS,
    morningReportPostedAtMs: null,
    morningReportAttempts: 0,
    pokes: { handoffReady: false, morningReport: false, postWakeContinuation: false, finalWrapup: false },
    status: "running",
    cancelled: false,
  };
}

/**
 * 相位计算（纯函数，墙钟）。优先级从高到低：
 *   finalizing（宽限尽）> 晨报已发（post-wake）/ 到点未发（morning-report）> wind-down > running。
 * 说明：若到点后一直未发晨报且睡过宽限期，直接判 finalizing——墙钟跳进是正确行为
 * （R2：app 睡眠醒来就该收尾），此时由 final-wrapup 承担终局汇报，与 selectOvernightPoke 同序。
 */
export function computeOvernightPhase(manifest: OvernightManifest, nowMs: number): OvernightPhase {
  if (nowMs >= manifest.postWakeGraceUntilMs) return "finalizing";
  if (manifest.morningReportPostedAtMs !== null) return "post-wake";
  if (nowMs >= manifest.targetWakeAtMs) return "morning-report";
  if (nowMs >= manifest.handoffReadyAtMs) return "wind-down";
  return "running";
}

/**
 * poke 选择（纯函数，不写 manifest）。supervisor 每轮消费一次；判定与置位分离，
 * 使「下一轮该发什么」完全可单测。优先级与 computeOvernightPhase 一致：
 * final-wrapup > morning-report > post-wake-continuation > handoff-ready > continuation。
 */
export function selectOvernightPoke(manifest: OvernightManifest, nowMs: number): OvernightPokeSelection {
  if (nowMs >= manifest.postWakeGraceUntilMs) {
    // 纯函数自洽兜底：supervisor 循环里 finalWrapup 已发时完成判定先于 poke 选择终态，
    // 理论上走不到这个 fallback，但纯函数单独调用时仍需返回合法值。
    return manifest.pokes.finalWrapup
      ? { kind: "continuation", resend: false }
      : { kind: "final-wrapup", resend: false };
  }
  if (manifest.morningReportPostedAtMs === null && nowMs >= manifest.targetWakeAtMs) {
    // 晨报未确认前每轮重选（R5：一次性标志只在文件确认后置位），重发带前置提醒
    return { kind: "morning-report", resend: manifest.morningReportAttempts > 0 };
  }
  if (manifest.morningReportPostedAtMs !== null && !manifest.pokes.postWakeContinuation) {
    return { kind: "post-wake-continuation", resend: false };
  }
  if (nowMs >= manifest.handoffReadyAtMs && nowMs < manifest.targetWakeAtMs && !manifest.pokes.handoffReady) {
    return { kind: "handoff-ready", resend: false };
  }
  return { kind: "continuation", resend: false };
}

/** 下一个相位时间点（等待间隔计算的「下次相位点剩余」侧，R2）；已越过全部点位时返回 null。 */
export function nextPhasePointMs(manifest: OvernightManifest, nowMs: number): number | null {
  const candidates = [manifest.handoffReadyAtMs, manifest.targetWakeAtMs, manifest.postWakeGraceUntilMs].filter(
    (point) => point > nowMs,
  );
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
