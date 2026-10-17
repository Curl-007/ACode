// Coordinator（specs/turn-auto-resume.md「退避、守卫与状态」）：per-session 内存状态
// {count, repeats, lastSignature, updatedAt} + 命令面 overlay（enabled/pause/message）。
// 运行态唯一写入点；不跨进程持久化——进程亡即重试链亡，杜绝重启后幽灵续跑。
// 定时器纪律：abort/停止/新用户输入/shutdown 必须取消 pending；触发前重查最新会话状态
// （可能已被用户手动续上），不能用定时器掩盖同步问题。
import { classifyAutoResumeFailure } from "./classifier.js";
import type {
  AutoResumeFailureFacts,
  AutoResumeInjectionContext,
  AutoResumeInjectionPlan,
  AutoResumeRuntimeCommand,
  AutoResumeSettlement,
  AutoResumeStatusSnapshot,
  ResolvedAutoResumeConfig,
} from "./types.js";

export interface AutoResumeCoordinatorLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export type AutoResumeTimerHandle = unknown;

/**
 * 可注入定时器面（测试替换）；默认实现 setTimeout + unref（不吊住进程退出）。
 * fire 允许返回 promise——默认实现吞掉 rejection（#onTimerFire 内部自带 containment，
 * 这里只是最后防线）；测试调度器可以 await 完整触发链，消除微任务竞态。
 */
export interface AutoResumeTimerScheduler {
  set(delayMs: number, fire: () => void | Promise<void>): AutoResumeTimerHandle;
  clear(handle: AutoResumeTimerHandle): void;
}

export const defaultAutoResumeTimerScheduler: AutoResumeTimerScheduler = {
  set(delayMs, fire) {
    const timer = setTimeout(() => {
      void Promise.resolve(fire()).catch(() => undefined);
    }, delayMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface AutoResumeCoordinatorDeps {
  sessionId: string;
  now(): number;
  getConfig(): ResolvedAutoResumeConfig;
  /**
   * 子代理/工作流 child runtime 的 turn 失败收口归各自 supervisor（subagent runner /
   * dwf engine）所有；auto-resume 注入新 turn 会与其竞态双写，故一律不干预。
   */
  isChildSession(): boolean;
  /** 触发前重查：会话仍空闲、未 shutdown、无新排队工作才允许注入。 */
  isSessionInjectable(): boolean;
  inject(plan: AutoResumeInjectionPlan): Promise<void>;
  emitScheduled(input: { plan: AutoResumeInjectionPlan; delayMs: number }): Promise<void>;
  logger?: AutoResumeCoordinatorLog;
  scheduler?: AutoResumeTimerScheduler;
}

/** 第 n 次等待 = min(cooldownBaseSec × cooldownFactor^(n−1), cooldownMaxSec)。 */
export function computeAutoResumeBackoffDelayMs(
  attempt: number,
  config: Pick<ResolvedAutoResumeConfig, "cooldownBaseSec" | "cooldownFactor" | "cooldownMaxSec">,
): number {
  const seconds = Math.min(
    config.cooldownBaseSec * Math.pow(config.cooldownFactor, Math.max(attempt, 1) - 1),
    config.cooldownMaxSec,
  );
  return Math.round(seconds * 1_000);
}

interface PendingResume {
  plan: AutoResumeInjectionPlan;
  fireAtMs: number;
  handle: AutoResumeTimerHandle;
}

interface ChainState {
  count: number;
  repeats: number;
  lastSignature?: string;
  updatedAt?: number;
}

export class AutoResumeCoordinator {
  readonly #deps: AutoResumeCoordinatorDeps;
  readonly #scheduler: AutoResumeTimerScheduler;
  #chain: ChainState = { count: 0, repeats: 0 };
  #enabledOverride?: boolean;
  #pausedUntilMs?: number;
  #messageOverride?: string;
  #pending?: PendingResume;
  #disposed = false;
  /**
   * 通知序号（单调）：#onTimerFire 据此区分「注入 turn 真跑过、其终态已被失败/结算
   * 挂点消化」与「注入机构自身失败」——前者的链状态归挂点所有，这里不得二次重置。
   */
  #notifySeq = 0;

  constructor(deps: AutoResumeCoordinatorDeps) {
    this.#deps = deps;
    this.#scheduler = deps.scheduler ?? defaultAutoResumeTimerScheduler;
  }

  /**
   * turn 失败观察通知（turn.ts 失败路径 throw 前 await）。分类 → 守卫 → 排定退避；
   * permanent/budget/不干预 → 计数清零。事件语义由调用方保持不变，这里只追加
   * auto_resume_scheduled 观测事件。
   */
  async notifyTurnFailure(
    facts: AutoResumeFailureFacts,
    injectionContext: AutoResumeInjectionContext,
  ): Promise<void> {
    if (this.#disposed) return;
    this.#notifySeq += 1;
    const config = this.#deps.getConfig();
    const classification = classifyAutoResumeFailure(facts);
    if (classification.kind !== "transient") {
      // permanent/budget 判定与「无法结构化归因」都是链终点：计数清零（spec 重置条件）。
      this.#cancelPending(`classification_${classification.kind}`);
      this.#resetChain(`classification_${classification.kind}`);
      return;
    }
    if (this.#deps.isChildSession()) {
      this.#logInfo("auto_resume.child_session_skipped", {
        reason: "child_session_supervisor_owns_failure",
      });
      return;
    }
    if (!this.#isEffectivelyEnabled(config)) {
      this.#cancelPending("disabled");
      this.#logInfo("auto_resume.skipped_disabled", {});
      return;
    }
    if (this.#isPaused()) {
      this.#logInfo("auto_resume.skipped_paused", { pausedUntilMs: this.#effectivePausedUntil() });
      return;
    }

    const signature = classification.signature;
    if (signature === this.#chain.lastSignature) {
      this.#chain.repeats += 1;
    } else {
      this.#chain.repeats = 1;
      this.#chain.lastSignature = signature;
    }
    if (this.#chain.repeats > config.loopGuardRepeats) {
      // 循环守卫：相同 reason+statusCode+providerCode 签名连续出现超过阈值 = 等待不会
      // 改变结果，停止本链（清零，后续无关故障可另起新链）。
      this.#logWarn("auto_resume.loop_guard_stop", {
        loopGuardRepeats: config.loopGuardRepeats,
        repeats: this.#chain.repeats,
        signature,
      });
      this.#cancelPending("loop_guard");
      this.#resetChain("loop_guard");
      return;
    }
    if (this.#chain.count + 1 > config.maxResumes) {
      this.#logWarn("auto_resume.max_resumes_stop", {
        count: this.#chain.count,
        maxResumes: config.maxResumes,
      });
      this.#cancelPending("max_resumes");
      this.#resetChain("max_resumes");
      return;
    }

    this.#chain.count += 1;
    this.#chain.updatedAt = this.#deps.now();
    const plan: AutoResumeInjectionPlan = {
      attempt: this.#chain.count,
      maxResumes: config.maxResumes,
      delayMs: computeAutoResumeBackoffDelayMs(this.#chain.count, config),
      errorSummary: classification.errorSummary,
      ...(facts.attribution ? { attribution: facts.attribution } : {}),
      injectionContext,
    };
    this.#cancelPending("rescheduled");
    const handle = this.#scheduler.set(plan.delayMs, () => this.#onTimerFire(plan));
    this.#pending = { handle, plan, fireAtMs: this.#deps.now() + plan.delayMs };
    this.#logInfo("auto_resume.scheduled", {
      attempt: plan.attempt,
      delayMs: plan.delayMs,
      errorSummary: plan.errorSummary,
      maxResumes: plan.maxResumes,
      repeats: this.#chain.repeats,
    });
    await this.#emitScheduled(plan, plan.delayMs);
  }

  /** 成功 turn / 用户取消 / 预算结局：取消 pending + 计数清零。 */
  notifyTurnSettled(settlement: AutoResumeSettlement): void {
    if (this.#disposed) return;
    this.#notifySeq += 1;
    this.#cancelPending(`settled_${settlement}`);
    this.#resetChain(`settled_${settlement}`);
  }

  /** 新用户输入被 admission：用户已接管，取消 pending + 计数清零。 */
  notifyUserInputAdmitted(): void {
    if (this.#disposed) return;
    this.#notifySeq += 1;
    this.#cancelPending("user_input_admitted");
    this.#resetChain("user_input_admitted");
  }

  /** 停止命令/会话 abort：用户显式取消语义，取消 pending + 计数清零。 */
  abortChain(reason: string): void {
    if (this.#disposed) return;
    this.#cancelPending(reason);
    this.#resetChain(reason);
  }

  /** 只取消定时器不动计数（内部抢占等非用户取消路径）。 */
  cancelPending(reason: string): void {
    this.#cancelPending(reason);
  }

  /** 进程退出/会话关闭：取消 pending，之后所有通知一律忽略。 */
  dispose(): void {
    this.#cancelPending("disposed");
    this.#disposed = true;
  }

  applyCommand(input: AutoResumeRuntimeCommand): void {
    switch (input.kind) {
      case "setEnabled":
        this.#enabledOverride = input.enabled;
        if (input.enabled) {
          // 显式 on 同时解除进程内 pause overlay（用户意图 = 立刻恢复可用）。
          this.#pausedUntilMs = undefined;
        } else {
          this.#cancelPending("command_disabled");
        }
        return;
      case "pause":
        this.#pausedUntilMs = this.#deps.now() + Math.max(0, Math.trunc(input.durationMs));
        this.#cancelPending("command_pause");
        return;
      case "setContinueMessage":
        this.#messageOverride = input.message?.trim() ? input.message.trim() : undefined;
        return;
    }
  }

  getStatus(): AutoResumeStatusSnapshot {
    const config = this.#deps.getConfig();
    const pausedUntilMs = this.#effectivePausedUntil();
    const continueMessage = this.#messageOverride ?? config.continueMessage;
    return {
      enabled: this.#enabledOverride ?? config.enabled,
      configEnabled: config.enabled,
      ...(pausedUntilMs !== undefined ? { pausedUntilMs } : {}),
      ...(continueMessage ? { continueMessage } : {}),
      count: this.#chain.count,
      repeats: this.#chain.repeats,
      ...(this.#chain.lastSignature ? { lastSignature: this.#chain.lastSignature } : {}),
      ...(this.#chain.updatedAt !== undefined ? { updatedAt: this.#chain.updatedAt } : {}),
      ...(this.#pending ? { pendingResumeAtMs: this.#pending.fireAtMs } : {}),
      maxResumes: config.maxResumes,
    };
  }

  async #onTimerFire(plan: AutoResumeInjectionPlan): Promise<void> {
    this.#pending = undefined;
    if (this.#disposed) return;
    // 触发前重查最新会话状态：用户可能已手动续上/新输入在飞/会话正在关闭——
    // 任何一种都放弃注入并清零（用户已接管，链没有继续的意义）。
    if (!this.#deps.isSessionInjectable()) {
      this.#logInfo("auto_resume.fire_skipped_not_injectable", { attempt: plan.attempt });
      this.#resetChain("session_not_injectable");
      return;
    }
    const config = this.#deps.getConfig();
    if (!this.#isEffectivelyEnabled(config) || this.#isPaused()) {
      this.#logInfo("auto_resume.fire_skipped_disabled_or_paused", { attempt: plan.attempt });
      return;
    }
    const seqBeforeInject = this.#notifySeq;
    try {
      // 发射点二：注入前（delayMs=0），UI 从「等待重试」切到「正在继续」。
      await this.#emitScheduled(plan, 0);
      await this.#deps.inject(plan);
    } catch (error) {
      // 注入的 turn 真跑起来后自身失败时，turn.ts 失败挂点会先行 notify（链状态已由
      // 它接管：或排定下一次退避、或按 permanent/budget 清零）——notifySeq 会前进。
      // 此时本 catch 不得二次 resetChain，否则会撤销挂点刚排定的下一级恢复。只有
      // notifySeq 未变（注入机构失败：队列关闭/落库失败，turn 根本没跑）才放弃本链。
      if (this.#notifySeq !== seqBeforeInject) {
        this.#logInfo("auto_resume.injected_turn_failure_already_handled", {
          attempt: plan.attempt,
        });
        return;
      }
      this.#logWarn("auto_resume.injection_failed", {
        attempt: plan.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#resetChain("injection_failed");
    }
  }

  async #emitScheduled(plan: AutoResumeInjectionPlan, delayMs: number): Promise<void> {
    try {
      await this.#deps.emitScheduled({ plan, delayMs });
    } catch (error) {
      // 观测事件失败绝不阻断恢复链本身。
      this.#logWarn("auto_resume.status_emit_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #isEffectivelyEnabled(config: ResolvedAutoResumeConfig): boolean {
    return this.#enabledOverride ?? config.enabled;
  }

  #effectivePausedUntil(): number | undefined {
    if (this.#pausedUntilMs === undefined) return undefined;
    if (this.#deps.now() >= this.#pausedUntilMs) {
      // 到期自动恢复：惰性判定，不为 pause 另设定时器。
      this.#pausedUntilMs = undefined;
      return undefined;
    }
    return this.#pausedUntilMs;
  }

  #isPaused(): boolean {
    return this.#effectivePausedUntil() !== undefined;
  }

  #cancelPending(reason: string): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.#scheduler.clear(pending.handle);
    this.#logInfo("auto_resume.pending_cancelled", {
      attempt: pending.plan.attempt,
      reason,
    });
  }

  #resetChain(reason: string): void {
    if (this.#chain.count === 0 && this.#chain.repeats === 0 && !this.#chain.lastSignature) {
      return;
    }
    this.#logInfo("auto_resume.chain_reset", {
      count: this.#chain.count,
      reason,
      repeats: this.#chain.repeats,
    });
    this.#chain = { count: 0, repeats: 0, updatedAt: this.#deps.now() };
  }

  #logInfo(event: string, fields: Record<string, unknown>): void {
    this.#deps.logger?.info("Auto-resume", {
      ...fields,
      event,
      module: "core.runtime",
      sessionId: this.#deps.sessionId,
      status: "info",
    });
  }

  #logWarn(event: string, fields: Record<string, unknown>): void {
    this.#deps.logger?.warn("Auto-resume", {
      ...fields,
      event,
      module: "core.runtime",
      sessionId: this.#deps.sessionId,
      status: "warn",
    });
  }
}
