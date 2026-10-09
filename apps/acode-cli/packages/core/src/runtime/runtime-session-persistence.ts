/**
 * AgentRuntime session shell 持久化事实的唯一所有者。
 *
 * `sessionPersisted` 只允许由完成 SessionStore 写入的路径提交一次；读面通过
 * 不可替换 getter 观察，避免任意 runtime method 把失败或未持久化状态伪装成已保存。
 */
export interface RuntimeSessionPersistenceView {
  readonly sessionPersisted: boolean;
}

export interface RuntimeSessionPersistencePort {
  /** 首次提交返回 true；重复提交是幂等 no-op。 */
  markPersisted(): boolean;
}

class RuntimeSessionPersistenceOwner {
  #persisted = false;

  get persisted(): boolean {
    return this.#persisted;
  }

  readonly port: RuntimeSessionPersistencePort = Object.freeze({
    markPersisted: (): boolean => {
      if (this.#persisted) return false;
      this.#persisted = true;
      return true;
    },
  });
}

const owners = new WeakMap<object, RuntimeSessionPersistenceOwner>();

/** 构造期绑定一次；重复初始化不能替换已有 owner 或 getter。 */
export function initializeRuntimeSessionPersistence(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeSessionPersistenceOwner();
  Object.defineProperty(runtime, "sessionPersisted", {
    configurable: false,
    enumerable: true,
    get: () => owner.persisted,
  });
  owners.set(runtime, owner);
}

export function getRuntimeSessionPersistencePort(
  runtime: object,
): RuntimeSessionPersistencePort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime session persistence has not been initialized");
  return owner.port;
}

