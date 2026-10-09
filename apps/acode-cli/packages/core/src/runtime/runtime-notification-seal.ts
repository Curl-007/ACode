import type { BackgroundTaskNotificationSealReason } from "./types.js";

/**
 * Subagent child 终态后的后台通知封口所有者。
 *
 * `AgentRuntimeInternal` 仍由历史 methods 共享，但封口状态不能依赖调用方把布尔值
 * 当作普通字段读写；这里只暴露只读 view 与一次性 seal port。reason 在首次提交后冻结，
 * 让 suppression 日志与实际封口原因保持同一事实。
 */
export interface RuntimeNotificationSealView {
  readonly backgroundTaskNotificationsSealed: boolean;
  readonly backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
}

export interface RuntimeNotificationSealPort {
  /** 首次成功封口返回 true；非 child 或重复封口返回 false。 */
  seal(reason: BackgroundTaskNotificationSealReason): boolean;
}

class RuntimeNotificationSealOwner {
  #sealed = false;
  #reason?: BackgroundTaskNotificationSealReason;

  constructor(private readonly isEnabled: () => boolean) {}

  get sealed(): boolean {
    return this.#sealed;
  }

  get reason(): BackgroundTaskNotificationSealReason | undefined {
    return this.#reason;
  }

  readonly port: RuntimeNotificationSealPort = Object.freeze({
    seal: (reason: BackgroundTaskNotificationSealReason): boolean => {
      if (!this.isEnabled() || this.#sealed) return false;
      this.#reason = reason;
      this.#sealed = true;
      return true;
    },
  });
}

const owners = new WeakMap<object, RuntimeNotificationSealOwner>();

/** 构造期绑定一次；重复初始化不能替换已有封口 owner 或 getter。 */
export function initializeRuntimeNotificationSeal(runtime: object, isEnabled: () => boolean): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeNotificationSealOwner(isEnabled);
  Object.defineProperties(runtime, {
    backgroundTaskNotificationsSealed: {
      configurable: false,
      enumerable: true,
      get: () => owner.sealed,
    },
    backgroundTaskNotificationSealReason: {
      configurable: false,
      enumerable: true,
      get: () => owner.reason,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeNotificationSealPort(runtime: object): RuntimeNotificationSealPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime notification seal has not been initialized");
  return owner.port;
}
