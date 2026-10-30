/**
 * Foreground Execution 状态的所有者（R1-01 批次 B2）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeTurnState` 剩余的
 * 扁平可写字段——任何 method 都能直接 `this.activeForegroundExecution = ...` /
 * `this.foregroundPromotionLease = ...` / `this.currentTurnFileChanges = ...`
 * 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 TurnState 剩余的 3 个字段（activeForegroundExecution / foregroundPromotionLease /
 * currentTurnFileChanges）收敛进一个私有 owner，形态与
 * `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts` 完全一致：WeakMap 持有真值、
 * 构造期用 Object.defineProperty 装只读 getter（无 setter、configurable:false）、写者只能经
 * 有限写端口。method 的读面（`this.activeForegroundExecution` 等）保持不变，只把
 * **赋值点**改成端口调用，行为逐点等价。
 * 第 4 个字段 `runtimeCommandQueue` 零 method 写点（唯一赋值在构造期），不进 owner——
 * agent-runtime 构造期改为不可写数据属性（writable:false, configurable:false）+
 * 类型级 readonly。
 *
 * 字段归属（唯一写入方 = runtime-command-queue / turn / rewind-message）：
 * - activeForegroundExecution：beginForegroundExecution 建立、finishForegroundExecution
 *   identity 命中清除；state 引用**不冻结**（stopActiveForegroundExecution 的
 *   preserveQueueAutoDrainOnCancel 容器内写保留，与 activeTurn 同先例）；
 * - foregroundPromotionLease：acquireForegroundPromotionLease 提交、
 *   releaseForegroundPromotionLease 比对释放、dequeueNextRunnableBatch 出队 promoted
 *   command 成功后同步消费；lease 入库时浅冻结（现有路径从不原地修改）；
 * - currentTurnFileChanges：turn/rewind 整体替换为新空 Map；Map 内容写
 *   （recordTurnFileChange）保留，owner 只封整体替换。
 *
 * 关键不变量（spec §B2）：lease 消费与 promoted command 出队必须同一同步片——
 * consumePromotionLease 只在 removeById 成功后调用，未命中/失败时 lease 保持。
 */
import type {
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  RuntimeTurnFileChangeMap,
} from "./types.js";

export interface RuntimeForegroundExecutionView {
  readonly activeForegroundExecution?: ActiveForegroundExecutionState;
  readonly foregroundPromotionLease?: ForegroundPromotionLeaseState;
  readonly currentTurnFileChanges: RuntimeTurnFileChangeMap;
}

export interface RuntimeForegroundExecutionPort {
  /**
   * 建立当前前台执行状态（原 `this.activeForegroundExecution = state`）。
   * state 由调用方构造（AbortController 接线是方法职责），owner 只持有引用、不冻结。
   * 只由 runtime-command-queue 的 beginForegroundExecution 调用。
   */
  beginForegroundExecution(state: ActiveForegroundExecutionState): void;
  /**
   * identity 命中才清除当前前台执行（`===` 不匹配是 no-op）。
   * 等价于原 finishForegroundExecution 的 `if (this.activeForegroundExecution === state)`
   * 段；`disposeParentAbort` 副作用留在调用方。
   */
  finishForegroundExecution(state: ActiveForegroundExecutionState): void;
  /**
   * 提交 promotion lease（原 `this.foregroundPromotionLease = {...}`）。
   * acquire 的 conflict/busy 裁决留在方法内（读面含其他 owner 字段，不内移避免跨
   * owner 耦合）。lease 入库时浅冻结——现有路径从不原地修改 lease，冻结不改变行为，
   * 只阻止未来读面反向改写。
   */
  commitPromotionLease(lease: ForegroundPromotionLeaseState): void;
  /**
   * 原子「比对 leaseId + 清除」：不匹配返回 false 且 lease 保持；命中清除返回 true。
   * drain 恢复副作用（`void drainRuntimeCommandQueue()`）留在调用方，只在返回 true 后执行。
   */
  releasePromotionLease(leaseId: string): boolean;
  /**
   * 出队 promoted command 成功后同步消费 lease（原 dequeueNextRunnableBatch 的清除点）。
   * 与 removeById 同一同步片：未命中/失败时不调用，lease 保持。
   */
  consumePromotionLease(): void;
  /**
   * turn/rewind 整体替换 turn 内文件改动图为新空 Map
   * （原 `this.currentTurnFileChanges = new Map()`）。Map 内容写
   * （recordTurnFileChange）不经本端口。
   */
  resetTurnFileChanges(): void;
}

class RuntimeForegroundExecutionOwner {
  #activeForegroundExecution?: ActiveForegroundExecutionState;
  #foregroundPromotionLease?: ForegroundPromotionLeaseState;
  #currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();

  get activeForegroundExecution(): ActiveForegroundExecutionState | undefined {
    return this.#activeForegroundExecution;
  }

  get foregroundPromotionLease(): ForegroundPromotionLeaseState | undefined {
    return this.#foregroundPromotionLease;
  }

  get currentTurnFileChanges(): RuntimeTurnFileChangeMap {
    return this.#currentTurnFileChanges;
  }

  readonly port: RuntimeForegroundExecutionPort = Object.freeze({
    beginForegroundExecution: (state: ActiveForegroundExecutionState): void => {
      this.#activeForegroundExecution = state;
    },
    finishForegroundExecution: (state: ActiveForegroundExecutionState): void => {
      if (this.#activeForegroundExecution === state) {
        this.#activeForegroundExecution = undefined;
      }
    },
    commitPromotionLease: (lease: ForegroundPromotionLeaseState): void => {
      this.#foregroundPromotionLease = Object.freeze({ ...lease });
    },
    releasePromotionLease: (leaseId: string): boolean => {
      if (this.#foregroundPromotionLease?.leaseId !== leaseId) return false;
      this.#foregroundPromotionLease = undefined;
      return true;
    },
    consumePromotionLease: (): void => {
      this.#foregroundPromotionLease = undefined;
    },
    resetTurnFileChanges: (): void => {
      this.#currentTurnFileChanges = new Map();
    },
  });
}

const owners = new WeakMap<object, RuntimeForegroundExecutionOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeForegroundExecution(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeForegroundExecutionOwner();
  Object.defineProperties(runtime, {
    activeForegroundExecution: {
      configurable: false,
      enumerable: true,
      get: () => owner.activeForegroundExecution,
    },
    foregroundPromotionLease: {
      configurable: false,
      enumerable: true,
      get: () => owner.foregroundPromotionLease,
    },
    currentTurnFileChanges: {
      configurable: false,
      enumerable: true,
      get: () => owner.currentTurnFileChanges,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeForegroundExecutionPort(
  runtime: object,
): RuntimeForegroundExecutionPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime foreground execution has not been initialized");
  return owner.port;
}
