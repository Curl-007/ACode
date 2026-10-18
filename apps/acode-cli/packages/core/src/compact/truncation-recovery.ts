/**
 * 截断恢复轨道（stopReason=length）的分类策略（specs/failure-recovery-tracks.md 轨道 2）。
 *
 * 机制参照 oh-my-pi (MIT) packages/coding-agent/src/session/session-maintenance.ts
 * （checkCompaction case 3：response.incomplete 分派；INCOMPLETE_RECOVERY_MAX_RETRIES = 3
 * 连续无产出封顶；窗口未耗尽 + 已交付 → 保留告警不重试），自撰实现，未复制代码。
 * omp 的执行体（dropPersistedAssistantTurn/developer 注入/scheduleAgentContinue）与其
 * 会话树耦合；ACode 映射到既有续写机制（turn-output-token-continuation.ts）与正常收口，
 * 本文件只做纯分类，不持有状态、不做 IO。
 */
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  type AutoCompactPolicyConfig,
} from "./policy.js";

/**
 * 连续无产出的 length 截断恢复封顶。与 omp INCOMPLETE_RECOVERY_MAX_RETRIES 同值同义：
 * 持续返回空/纯推理 length 轮的模型（omp #10594 的 zai/glm-4.5-flash 事故）否则会永远
 * 重试并每轮持久化一个死 assistant；任何交付了产出的轮次都会重置计数，正当的多步
 * 恢复不会被误杀。ACode 复用既有 outputTokenContinuationCount 作为该计数（单一计数器，
 * 不新造第二份状态）。
 */
export const TRUNCATION_NO_OUTPUT_MAX_RETRIES = 3;

type TruncationRecoveryAction =
  /** 窗口未耗尽且已有可见产出：保留截断产出 + 告警收口，不续写（续写只会重复撞同一输出上限）。 */
  | "keep_with_warning"
  /** 窗口未耗尽且无产出：移除该轮（空 assistant 不入请求历史）+ 注入续写提示重试。 */
  | "discard_and_retry"
  /** 连续无产出恢复达到封顶：抛输出上限耗尽错误，fail-loud（auto-resume permanent，不接管）。 */
  | "fail_loud"
  /** 窗口本身耗尽（或未知）：交接给压缩轨道——下一 loop 边界 threshold auto compact。 */
  | "compact";

interface TruncationRecoveryDecision {
  action: TruncationRecoveryAction;
  /** 判定用的窗口耗尽事实（日志/测试断言口径统一）。 */
  windowExhausted: boolean;
  /** discard_and_retry 时的本次尝试序号（1-based）；fail_loud 时为已消耗的连续次数。 */
  attempt?: number;
}

interface TruncationRecoveryFacts {
  /** 与 autoCompactIfNeeded 同构的策略配置；阈值/有效窗口从 compact/policy.ts 单一来源计算。 */
  config: AutoCompactPolicyConfig;
  /** 已连续消耗的 length 恢复次数（TurnRequestState.outputTokenContinuationCount）。 */
  consecutiveLengthRetries: number;
  /** 本轮是否交付了可见产出（非空文本；tool call 轮不进本轨道，reasoning-only 不算产出）。 */
  hasDeliveredOutput: boolean;
  /** 本轮请求的输入侧占用（provider usage 优先，estimateCurrentModelInputTokens 口径）。 */
  promptTokens: number;
  /** 本轮输出的 output tokens（usage 缺席按 0）。 */
  outputTokens: number;
}

/**
 * 窗口是否已被本轮占满。三个证据任一成立即耗尽：
 * 1. 窗口未知/非正数——没有「窗口还有余量」的证据，保守按耗尽处理（omp 同口径：
 *    unknown windows keep compacting）；
 * 2. 输入占用达到 auto compact 阈值——被截断的输出在下轮请求前会被丢弃，只有输入侧
 *    计入阈值（omp #15870 同口径），阈值与 shouldAutoCompact 共用 policy.ts 单一来源；
 * 3. 输入 + 输出达到有效窗口——生成把窗口本身填满（Anthropic
 *    model_context_window_exceeded 的成功响应形态）。
 */
export function isTruncationWindowExhausted(input: {
  config: AutoCompactPolicyConfig;
  outputTokens: number;
  promptTokens: number;
}): boolean {
  const contextWindow = input.config.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return true;
  }
  const threshold = getAutoCompactThreshold(input.config);
  if (input.promptTokens >= threshold) return true;
  return input.promptTokens + input.outputTokens >= getEffectiveContextWindowSize(input.config);
}

/** 截断恢复四分类（状态机图见 specs/failure-recovery-tracks.md）。 */
export function classifyTruncationRecovery(
  facts: TruncationRecoveryFacts,
): TruncationRecoveryDecision {
  const windowExhausted = isTruncationWindowExhausted({
    config: facts.config,
    outputTokens: facts.outputTokens,
    promptTokens: facts.promptTokens,
  });

  // 有产出 + 窗口未耗尽：输出上限截断了真实交付物。更大的窗口和压缩都换不来输出预算，
  // 重试只会再生成同样的截断——保留产出、告警、让用户掌舵（omp 同语义）。
  if (!windowExhausted && facts.hasDeliveredOutput) {
    return { action: "keep_with_warning", windowExhausted };
  }
  // 窗口耗尽：先压缩再续（由既有 loop 边界的 threshold auto compact 执行，本轨道不自行压缩）。
  if (windowExhausted) {
    return { action: "compact", windowExhausted };
  }
  // 无产出 + 窗口未耗尽：推理烧光了输出预算。移除该轮重试并封顶，防死循环（omp #10594）。
  const attempt = facts.consecutiveLengthRetries + 1;
  if (attempt > TRUNCATION_NO_OUTPUT_MAX_RETRIES) {
    return { action: "fail_loud", windowExhausted, attempt: facts.consecutiveLengthRetries };
  }
  return { action: "discard_and_retry", windowExhausted, attempt };
}
