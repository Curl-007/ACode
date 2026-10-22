/**
 * Turn 时序状态的所有者（CLI-05 P1 第一切片，specs/runtime-state-ownership.md）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeTurnState` 的扁平
 * 可写字段——即便 reservation/drain/generation 已收敛到 turn-coordination owner，
 * `this` 面仍让任意 method 能读写 `turnNumber`/`activeTurn`/`pendingInput*`/`queue*Drain*`
 * 等时序字段，owner 只读约束对其余字段无效（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 turn 生命周期里**高频时序字段**收敛进一个私有 owner，形态与
 * `turn-coordination.ts`/`runtime-permission-grant.ts` 完全一致：WeakMap 持有真值、
 * 构造期用 Object.defineProperty 装只读 getter（无 setter、configurable:false）、
 * 写者只能经有限写端口。method 的读面（`this.turnNumber` 等）保持不变，只把**赋值点**
 * 改成端口调用，行为逐点等价。
 *
 * 字段归属（唯一写入方 = turn 编排路径：steering / turn / compact / control-only-turn /
 * resume / rewind）：
 * - turnNumber：turn 完成/边界推进，resume/rewind 从持久消息数重建；
 * - activeTurn：beginActiveTurn 建立、finishActiveTurn 清除（identity 比较的读面不变）；
 * - pendingInputSequence：createPendingInputId 自增铸造 pending id；
 * - pendingInputReservations：sendQueuedNow 预约/释放/查询（Map 内容经 owner 端口改写）；
 * - pendingInputDrains：drainPendingInput 的 in-flight 计数（try/finally 配对）；
 * - queueAutoDrain / queueExternalDrainActive：v4 setAutoDrain 授权位与 turn 失败/取消同步。
 *
 * activeTurn 本体**不冻结**：其 pendingInputs 数组由 steering 原地 splice/push 维护，
 * owner 只收窄「整体赋值/清除」这一写权限，不改内部可变语义（行为完全不变）。
 */
import type { ActiveTurnSteeringState } from "./types.js";

export interface RuntimeTurnTimingView {
  readonly turnNumber: number;
  readonly activeTurn?: ActiveTurnSteeringState;
  readonly pendingInputSequence: number;
  /** 读面（size/has/get）保持不变；写面只经 owner 端口的 reserve/release。 */
  readonly pendingInputReservations: ReadonlyMap<string, string>;
  readonly pendingInputDrains?: number;
  readonly queueAutoDrain: boolean;
  readonly queueExternalDrainActive: boolean;
}

export interface RuntimeTurnTimingPort {
  /** turn 完成/边界推进：turnNumber += 1。 */
  advanceTurn(): void;
  /** resume/rewind 从持久消息数重建 turnNumber（非自增，整体替换）。 */
  setTurnNumber(turnNumber: number): void;
  /** beginActiveTurn：建立当前 active turn（owner 保存引用，不冻结）。 */
  setActiveTurn(activeTurn: ActiveTurnSteeringState): void;
  /** finishActiveTurn：清除 active turn（无 active 时是安全 no-op）。 */
  clearActiveTurn(): void;
  /** createPendingInputId：自增并返回新序号（原 `+=1` 后读取的原子化）。 */
  nextPendingInputSequence(): number;
  /** sendQueuedNow 预约一个 pending input（原 Map.set）。 */
  reservePendingInput(pendingInputId: string, reservationId: string): void;
  /** 释放/撤销 pending input 预约（原 Map.delete，缺键是 no-op）。 */
  releasePendingInputReservation(pendingInputId: string): void;
  /** drainPendingInput 进入 in-flight 计数（try 前）。 */
  beginPendingInputDrain(): void;
  /** drainPendingInput 退出 in-flight 计数（finally）。 */
  endPendingInputDrain(): void;
  /** v4 setAutoDrain 的原子转换：暂停/恢复授权位 + 外层 FIFO drain 窗口（原三写点等价）。 */
  applyQueueAutoDrainChange(autoDrain: boolean): void;
  /** turn 失败/取消同步：queueAutoDrain=false 且关闭外层 drain 窗口（原成对写点等价）。 */
  pauseQueueAutoDrain(): void;
  /** CLI 投影确认恢复队列已空：关闭外层 FIFO drain 窗口（原 completeExternalQueueDrain）。 */
  completeExternalQueueDrain(): void;
}

class RuntimeTurnTimingOwner {
  #turnNumber = 0;
  #activeTurn: ActiveTurnSteeringState | undefined;
  #pendingInputSequence = 0;
  readonly #pendingInputReservations = new Map<string, string>();
  #pendingInputDrains = 0;
  #queueAutoDrain = true;
  #queueExternalDrainActive = false;

  get turnNumber(): number {
    return this.#turnNumber;
  }

  get activeTurn(): ActiveTurnSteeringState | undefined {
    return this.#activeTurn;
  }

  get pendingInputSequence(): number {
    return this.#pendingInputSequence;
  }

  get pendingInputReservations(): ReadonlyMap<string, string> {
    return this.#pendingInputReservations;
  }

  get pendingInputDrains(): number | undefined {
    // 迁移前 pendingInputDrains 为 `number | undefined`（读面 `if (this.pendingInputDrains)`）；
    // owner 用 0 表示「无 in-flight drain」，映射回 undefined 保持读面语义完全不变。
    return this.#pendingInputDrains === 0 ? undefined : this.#pendingInputDrains;
  }

  get queueAutoDrain(): boolean {
    return this.#queueAutoDrain;
  }

  get queueExternalDrainActive(): boolean {
    return this.#queueExternalDrainActive;
  }

  readonly port: RuntimeTurnTimingPort = Object.freeze({
    advanceTurn: (): void => {
      this.#turnNumber += 1;
    },
    setTurnNumber: (turnNumber: number): void => {
      this.#turnNumber = turnNumber;
    },
    setActiveTurn: (activeTurn: ActiveTurnSteeringState): void => {
      this.#activeTurn = activeTurn;
    },
    clearActiveTurn: (): void => {
      this.#activeTurn = undefined;
    },
    nextPendingInputSequence: (): number => {
      this.#pendingInputSequence += 1;
      return this.#pendingInputSequence;
    },
    reservePendingInput: (pendingInputId: string, reservationId: string): void => {
      this.#pendingInputReservations.set(pendingInputId, reservationId);
    },
    releasePendingInputReservation: (pendingInputId: string): void => {
      this.#pendingInputReservations.delete(pendingInputId);
    },
    beginPendingInputDrain: (): void => {
      this.#pendingInputDrains += 1;
    },
    endPendingInputDrain: (): void => {
      this.#pendingInputDrains -= 1;
    },
    applyQueueAutoDrainChange: (autoDrain: boolean): void => {
      // 与迁移前 setQueueAutoDrain 逐行等价：
      // false→true（用户从暂停队列恢复）打开外层 FIFO 提升窗口；
      // →false 关闭窗口；autoDrain 授权位同时进 owner（drain 门）。
      if (autoDrain && !this.#queueAutoDrain) {
        this.#queueExternalDrainActive = true;
      } else if (!autoDrain) {
        this.#queueExternalDrainActive = false;
      }
      this.#queueAutoDrain = autoDrain;
    },
    pauseQueueAutoDrain: (): void => {
      // turn 失败（非取消）/取消同步：队列重新暂停，外层 FIFO 恢复窗口同时关闭。
      this.#queueAutoDrain = false;
      this.#queueExternalDrainActive = false;
    },
    completeExternalQueueDrain: (): void => {
      this.#queueExternalDrainActive = false;
    },
  });
}

const owners = new WeakMap<object, RuntimeTurnTimingOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeTurnTiming(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeTurnTimingOwner();
  Object.defineProperties(runtime, {
    turnNumber: { configurable: false, enumerable: true, get: () => owner.turnNumber },
    activeTurn: { configurable: false, enumerable: true, get: () => owner.activeTurn },
    pendingInputSequence: {
      configurable: false,
      enumerable: true,
      get: () => owner.pendingInputSequence,
    },
    pendingInputReservations: {
      configurable: false,
      enumerable: true,
      get: () => owner.pendingInputReservations,
    },
    pendingInputDrains: {
      configurable: false,
      enumerable: true,
      get: () => owner.pendingInputDrains,
    },
    queueAutoDrain: { configurable: false, enumerable: true, get: () => owner.queueAutoDrain },
    queueExternalDrainActive: {
      configurable: false,
      enumerable: true,
      get: () => owner.queueExternalDrainActive,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeTurnTimingPort(runtime: object): RuntimeTurnTimingPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime turn timing has not been initialized");
  return owner.port;
}
