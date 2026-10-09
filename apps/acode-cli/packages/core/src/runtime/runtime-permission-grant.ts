/**
 * 完全访问授权状态的所有者（CLI-05 I7，specs/runtime-state-ownership.md）。
 *
 * `permissionFullAccessPending` 不是一次性旗标，而是授权事务的 in-flight 互斥
 * guard：steering、execution-state 等读面在它期间拒绝并发的队列/模式变更。若把它
 * 当作普通布尔字段共享，任何 runtime method 都能在事务中途写回 false，让第二个
 * 授权与第一个的事务竞态。这里只暴露「原子预约 / finally 释放」两个端口。
 *
 * `lastPermissionGrantId` 是 v4 bridge 读取的授权 receipt 标记：只能整体替换或
 * 清除（set 语义），调用方不得读-改-写；写方仅有 permission-full-access 事务提交
 * 后的 applied-grant dedupe 块与 permission-grant-resume 的恢复/重置路径。
 */
export interface RuntimePermissionGrantView {
  readonly permissionFullAccessPending: boolean;
  readonly lastPermissionGrantId: string | undefined;
}

export interface RuntimePermissionGrantPort {
  /** 原子预约授权事务；已 pending 时返回 false（调用方沿用既有 busy 拒绝），成功预约返回 true。 */
  tryBeginPermissionFullAccess(): boolean;
  /** 释放预约；只应出现在成功预约后的 finally，无预约时是安全 no-op。 */
  endPermissionFullAccess(): void;
  /** 替换或清除授权 receipt 标记；undefined 表示清除（resume 重置路径）。 */
  setLastPermissionGrantId(id: string | undefined): void;
}

class RuntimePermissionGrantOwner {
  #pending = false;
  #lastPermissionGrantId: string | undefined;

  get pending(): boolean {
    return this.#pending;
  }

  get lastPermissionGrantId(): string | undefined {
    return this.#lastPermissionGrantId;
  }

  readonly port: RuntimePermissionGrantPort = Object.freeze({
    tryBeginPermissionFullAccess: (): boolean => {
      // 检查与预约必须在同一同步片完成：await 之后再判 pending 会重新打开双授权窗口。
      if (this.#pending) return false;
      this.#pending = true;
      return true;
    },
    endPermissionFullAccess: (): void => {
      // 幂等释放：重复释放或未预约时释放都是 no-op，不影响后来者的预约。
      this.#pending = false;
    },
    setLastPermissionGrantId: (id: string | undefined): void => {
      this.#lastPermissionGrantId = id;
    },
  });
}

const owners = new WeakMap<object, RuntimePermissionGrantOwner>();

/** 构造期绑定一次；重复初始化不能替换已有授权 owner 或 getter。 */
export function initializeRuntimePermissionGrant(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimePermissionGrantOwner();
  Object.defineProperties(runtime, {
    permissionFullAccessPending: {
      configurable: false,
      enumerable: true,
      get: () => owner.pending,
    },
    lastPermissionGrantId: {
      configurable: false,
      enumerable: true,
      get: () => owner.lastPermissionGrantId,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimePermissionGrantPort(runtime: object): RuntimePermissionGrantPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime permission grant has not been initialized");
  return owner.port;
}
