/**
 * Runtime 生命周期旗标的唯一所有者。
 *
 * 一次性 reminder、标题 sidecar 机会等生命周期旗标必须在评估时消费，不能暴露
 * 通用 setter；否则任意 runtime method 都可以把已消费的旗标写回 false，在后续
 * turn 重复注入同一事实。
 */
export interface RuntimeLifecycleView {
  readonly runtimeRestartReminderEmitted: boolean;
  readonly sessionTitleGenerationAttempted: boolean;
  readonly needsPlanModeExitReminder: boolean;
  readonly sessionStartHookRan: boolean;
  readonly shuttingDown: boolean;
}

export interface RuntimeLifecyclePort {
  /** 返回 true 并消费首个机会；后续调用返回 false。 */
  consumeRuntimeRestartReminder(): boolean;
  /** 返回 true 并消费首个标题生成机会；后续调用返回 false。 */
  consumeSessionTitleGenerationAttempted(): boolean;
  /** arm 一个待消费的 Plan 退出提醒；重复 arm 不产生第二个 token。 */
  armPlanModeExitReminder(): void;
  /** 返回 true 并消费当前 Plan 退出提醒；没有 pending token 时返回 false。 */
  consumePlanModeExitReminder(): boolean;
  /** 原子领取 session-start hook；已有成功结果或进行中的领取都会返回 false。 */
  tryClaimSessionStartHook(): boolean;
  /** 在 hook 成功完成后提交领取，使后续调用永久跳过。 */
  commitSessionStartHook(): void;
  /** activate 或 hook 失败时释放领取，允许后续调用重试。 */
  releaseSessionStartHookClaim(): void;
  /**
   * 提交 shutdown 旗标（CLI-05 I4）：false → true 单调、幂等，重复调用是 no-op。
   * 不提供写回 false 的端口——关闭链路一旦开始，读面（memory 提取、后台通知抑制、
   * runtime-tools）不能观察到「又活过来」的中间态。
   */
  commitShutdown(): void;
}

class RuntimeLifecycleOwner {
  #runtimeRestartReminderEmitted = false;
  #sessionTitleGenerationAttempted = false;
  #needsPlanModeExitReminder = false;
  #sessionStartHookRan = false;
  #sessionStartHookClaimed = false;
  #shuttingDown = false;

  get runtimeRestartReminderEmitted(): boolean {
    return this.#runtimeRestartReminderEmitted;
  }

  get sessionTitleGenerationAttempted(): boolean {
    return this.#sessionTitleGenerationAttempted;
  }

  get needsPlanModeExitReminder(): boolean {
    return this.#needsPlanModeExitReminder;
  }

  get sessionStartHookRan(): boolean {
    return this.#sessionStartHookRan;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  readonly port: RuntimeLifecyclePort = Object.freeze({
    consumeRuntimeRestartReminder: (): boolean => {
      if (this.#runtimeRestartReminderEmitted) return false;
      this.#runtimeRestartReminderEmitted = true;
      return true;
    },
    consumeSessionTitleGenerationAttempted: (): boolean => {
      if (this.#sessionTitleGenerationAttempted) return false;
      this.#sessionTitleGenerationAttempted = true;
      return true;
    },
    armPlanModeExitReminder: (): void => {
      this.#needsPlanModeExitReminder = true;
    },
    consumePlanModeExitReminder: (): boolean => {
      if (!this.#needsPlanModeExitReminder) return false;
      this.#needsPlanModeExitReminder = false;
      return true;
    },
    tryClaimSessionStartHook: (): boolean => {
      if (this.#sessionStartHookRan || this.#sessionStartHookClaimed) return false;
      this.#sessionStartHookClaimed = true;
      return true;
    },
    commitSessionStartHook: (): void => {
      if (!this.#sessionStartHookClaimed || this.#sessionStartHookRan) return;
      this.#sessionStartHookClaimed = false;
      this.#sessionStartHookRan = true;
    },
    releaseSessionStartHookClaim: (): void => {
      if (this.#sessionStartHookRan) return;
      this.#sessionStartHookClaimed = false;
    },
    commitShutdown: (): void => {
      // 单调提交：只允许 false → true，重复调用幂等，不产生第二次副作用窗口。
      this.#shuttingDown = true;
    },
  });
}

const owners = new WeakMap<object, RuntimeLifecycleOwner>();

/** 在 runtime 构造期绑定只读 getter；重复初始化不会替换已有 owner。 */
export function initializeRuntimeLifecycle(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeLifecycleOwner();
  Object.defineProperty(runtime, "runtimeRestartReminderEmitted", {
    configurable: false,
    enumerable: true,
    get: () => owner.runtimeRestartReminderEmitted,
  });
  Object.defineProperty(runtime, "sessionTitleGenerationAttempted", {
    configurable: false,
    enumerable: true,
    get: () => owner.sessionTitleGenerationAttempted,
  });
  Object.defineProperty(runtime, "needsPlanModeExitReminder", {
    configurable: false,
    enumerable: true,
    get: () => owner.needsPlanModeExitReminder,
  });
  Object.defineProperty(runtime, "sessionStartHookRan", {
    configurable: false,
    enumerable: true,
    get: () => owner.sessionStartHookRan,
  });
  Object.defineProperty(runtime, "shuttingDown", {
    configurable: false,
    enumerable: true,
    get: () => owner.shuttingDown,
  });
  owners.set(runtime, owner);
}

export function getRuntimeLifecyclePort(runtime: object): RuntimeLifecyclePort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime lifecycle has not been initialized");
  return owner.port;
}
