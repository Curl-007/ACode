// 跨回合临时性故障自动恢复（specs/turn-auto-resume.md）领域类型。
//
// 状态所有者纪律：分类/退避/守卫/计数/定时器的唯一写入点是本目录的 coordinator；
// turn.ts 失败路径只做观察通知，不改判定语义。运行态只住进程内 per-session 内存，
// 不跨进程持久化——参数与长期开关走 config（AutoResumeConfig）。
import type { AutoResumeConfig, ErrorAttribution, TraceContext } from "@acode/contracts";
import { DefaultRuntimeConfig } from "@acode/contracts";
import type { ModelExecutionContext } from "../types.js";

/** 全字段落定的生效配置；invalid/缺席值回落 DefaultRuntimeConfig.autoResume（单一默认值来源）。 */
export interface ResolvedAutoResumeConfig {
  enabled: boolean;
  maxResumes: number;
  cooldownBaseSec: number;
  cooldownFactor: number;
  cooldownMaxSec: number;
  loopGuardRepeats: number;
  continueMessage?: string;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveAutoResumeConfig(
  config: Partial<AutoResumeConfig> | undefined,
): ResolvedAutoResumeConfig {
  const defaults = DefaultRuntimeConfig.autoResume;
  const continueMessage = config?.continueMessage?.trim();
  return {
    enabled: config?.enabled ?? defaults.enabled,
    maxResumes: Math.max(1, Math.trunc(positiveNumber(config?.maxResumes, defaults.maxResumes))),
    cooldownBaseSec: positiveNumber(config?.cooldownBaseSec, defaults.cooldownBaseSec),
    cooldownFactor: positiveNumber(config?.cooldownFactor, defaults.cooldownFactor),
    cooldownMaxSec: positiveNumber(config?.cooldownMaxSec, defaults.cooldownMaxSec),
    loopGuardRepeats: Math.max(
      1,
      Math.trunc(positiveNumber(config?.loopGuardRepeats, defaults.loopGuardRepeats)),
    ),
    ...(continueMessage ? { continueMessage } : {}),
  };
}

/**
 * turn 失败观察挂点交给分类器的结构化归因（闭集 token / 结构化字段，不收自由文本——
 * 分类只认结构化 reason，specs/turn-auto-resume.md「分类」）。
 */
export interface AutoResumeFailureFacts {
  /** CoreErrorType（闭集）。 */
  coreErrorType: string;
  /** projectExecutionErrorPayload 投影出的结构化归因；缺席 = 无可聚合事实。 */
  attribution?: ErrorAttribution;
}

/** turn 结局档位（成功/取消路径通知重置；预算结局不是故障恢复面）。 */
export type AutoResumeSettlement = "success" | "cancelled" | "budget";

export type AutoResumeClassification =
  | { kind: "transient"; errorSummary: string; signature: string }
  | { kind: "permanent" }
  | { kind: "budget" }
  /** success/cancelled/无法结构化归因：不干预。 */
  | { kind: "none" };

/**
 * 注入 turn 必须携带的失败 turn 事实（安全红线：automation/off-peak 身份透传，
 * 继承同款 mutation 限制；工具面与 execution-scoped 模型选择同批透传）。
 */
export interface AutoResumeInjectionContext {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
  toolDisallowlist?: readonly string[];
  modelExecution?: ModelExecutionContext;
  /** 失败 turn 的 trace（注入 turn 以其为父派生新 turn trace）。 */
  traceContext: TraceContext;
}

/** 一次已排定的自动继续（定时器载荷）。 */
export interface AutoResumeInjectionPlan {
  /** 第几次自动继续（1-based）。 */
  attempt: number;
  maxResumes: number;
  delayMs: number;
  errorSummary: string;
  attribution?: ErrorAttribution;
  injectionContext: AutoResumeInjectionContext;
}

/** /auto-resume status 与 UI 状态投影消费的只读快照。 */
export interface AutoResumeStatusSnapshot {
  /** 生效开关 = 进程内命令面 override ?? config。 */
  enabled: boolean;
  /** config 层的长期开关（裸 on/off 持久化面）。 */
  configEnabled: boolean;
  /** off <时长> 的进程内暂停到期（ms epoch）；缺席 = 未暂停。 */
  pausedUntilMs?: number;
  /** 生效自定义继续指令 = 进程内 override ?? config.continueMessage。 */
  continueMessage?: string;
  /** 当前链连续自动继续次数；重置条件命中后清零。 */
  count: number;
  /** 相同错误签名连续命中次数。 */
  repeats: number;
  lastSignature?: string;
  updatedAt?: number;
  /** 待触发退避定时器的触发时刻（ms epoch）；缺席 = 无 pending。 */
  pendingResumeAtMs?: number;
  maxResumes: number;
}

/** runtime 进程内命令面（config 持久化在 bootstrap app 层，另行叠加）。 */
export type AutoResumeRuntimeCommand =
  | { kind: "setEnabled"; enabled: boolean }
  | { kind: "pause"; durationMs: number }
  | { kind: "setContinueMessage"; message: string | null };
