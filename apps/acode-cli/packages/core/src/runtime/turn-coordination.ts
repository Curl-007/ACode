import { CoreErrorType, createCoreError } from "./deps.js";
import type { SessionInfo, TurnId } from "./deps.js";
import type { ActiveTurnStartReservation, ActiveTurnSteeringState } from "./types.js";
import type { RuntimeTaskRegistry } from "../runtime-task/contract.js";

export interface RuntimeTurnCoordinationView {
  readonly activeTurnStartReservation: Readonly<ActiveTurnStartReservation> | undefined;
  readonly branchGeneration: number;
  readonly runtimeCommandDrainActive: boolean;
}

export interface RuntimeTurnReservationPort {
  reserve(reservation: ActiveTurnStartReservation): void;
  release(turnId: TurnId): void;
}

export interface RuntimeCommandDrainLease {
  release(): void;
}

export interface RuntimeCommandDrainPort {
  tryAcquire(): RuntimeCommandDrainLease | null;
}

export interface RuntimeBranchTransition {
  readonly generation: number;
  commitAfterPersist(
    persist: () => Promise<void>,
    afterCommit?: () => Promise<void>,
  ): Promise<boolean>;
}

export interface RuntimeBranchRestorePort {
  restoreFromSession(session: Pick<SessionInfo, "revert">): Promise<number>;
  restoreAndHydrate<Result>(
    load: () => Promise<SessionInfo>,
    hydrate: (session: SessionInfo) => Promise<Result>,
  ): Promise<Result>;
  prepareRewind(session: Pick<SessionInfo, "revert"> | null): RuntimeBranchTransition;
  persistNotificationIfCurrent<Result>(
    expectedGeneration: number,
    persist: () => Promise<Result>,
  ): Promise<Result | null>;
  commitTargetStateIfCurrent<Result>(
    expectedGeneration: number,
    commit: () => Promise<Result>,
  ): Promise<Result | null>;
}

interface CoordinationContext {
  readonly activeTurn?: Pick<ActiveTurnSteeringState, "turnId">;
  readonly runtimeTaskRegistry?: Pick<RuntimeTaskRegistry, "setActiveBranchGeneration">;
}

/**
 * reservation、drain 与分支代际只保存在这个私有 owner 中。
 * methods 只能显式取得自己需要的有限能力，不能经 AgentRuntimeInternal 任意覆写。
 */
class RuntimeTurnCoordinationOwner {
  #reservation: Readonly<ActiveTurnStartReservation> | undefined;
  #drainLease: symbol | undefined;
  #generation = 0;
  #branchWrites = Promise.resolve();

  constructor(private readonly context: CoordinationContext) {}

  get reservation(): Readonly<ActiveTurnStartReservation> | undefined {
    return this.#reservation;
  }

  get draining(): boolean {
    return this.#drainLease !== undefined;
  }

  get generation(): number {
    return this.#generation;
  }

  readonly reservationPort: RuntimeTurnReservationPort = Object.freeze({
    reserve: (reservation: ActiveTurnStartReservation): void => {
      const activeTurnId = this.context.activeTurn?.turnId ?? this.#reservation?.turnId;
      if (activeTurnId !== undefined) {
        throw createCoreError(
          CoreErrorType.TurnInProgress,
          `Cannot start ${reservation.kind} turn while another turn is active`,
          {
            context: { activeTurnId, nextTurnId: reservation.turnId },
            recoverable: true,
          },
        );
      }
      // 只读 getter 仍会返回对象；冻结身份字段，避免消费方从 turnId 旁路改预约。
      this.#reservation = Object.freeze({ ...reservation });
    },
    release: (turnId: TurnId): void => {
      if (this.#reservation?.turnId === turnId) this.#reservation = undefined;
    },
  });

  readonly drainPort: RuntimeCommandDrainPort = Object.freeze({
    tryAcquire: (): RuntimeCommandDrainLease | null => {
      if (this.#drainLease !== undefined) return null;
      const lease = Symbol("runtime-command-drain");
      this.#drainLease = lease;
      return Object.freeze({
        release: (): void => {
          // finally 或迟到回调只能释放自己的 lease，不能清掉后来者的授权位。
          if (this.#drainLease === lease) this.#drainLease = undefined;
        },
      });
    },
  });

  readonly branchPort: RuntimeBranchRestorePort = Object.freeze({
    restoreFromSession: (session: Pick<SessionInfo, "revert">): Promise<number> =>
      this.withBranchWrite(() => {
        // 同实例再次 resume 不能把 generation 倒退，否则旧后台命令会重新变成当前分支。
        this.#generation = Math.max(this.#generation, persistedGeneration(session));
        this.syncRegistry();
        return this.#generation;
      }),
    restoreAndHydrate: <Result>(
      load: () => Promise<SessionInfo>,
      hydrate: (session: SessionInfo) => Promise<Result>,
    ): Promise<Result> =>
      this.withBranchWrite(async () => {
        // 快照读取也必须在授权内；锁外旧 session/messages 会在等待后覆盖新分支。
        const session = await load();
        if (persistedGeneration(session) < this.#generation) {
          throw new Error("Session restore branch snapshot is stale");
        }
        this.#generation = persistedGeneration(session);
        this.syncRegistry();
        return hydrate(session);
      }),
    persistNotificationIfCurrent: <Result>(
      expectedGeneration: number,
      persist: () => Promise<Result>,
    ): Promise<Result | null> =>
      this.withBranchWrite(async () => {
        if (expectedGeneration !== this.#generation) return null;
        // context 初始化也会改 history，不能在 resume/rewind 重建授权之外越代回写。
        return persist();
      }),
    commitTargetStateIfCurrent: <Result>(
      expectedGeneration: number,
      commit: () => Promise<Result>,
    ): Promise<Result | null> =>
      this.withBranchWrite(() => (expectedGeneration === this.#generation ? commit() : null)),
    prepareRewind: (session: Pick<SessionInfo, "revert"> | null): RuntimeBranchTransition => {
      const base = Math.max(this.#generation, persistedGeneration(session));
      let committed = false;
      return Object.freeze({
        generation: base + 1,
        commitAfterPersist: (
          persist: () => Promise<void>,
          afterCommit?: () => Promise<void>,
        ): Promise<boolean> =>
          this.withBranchWrite(async () => {
            // stale 必须在取消/持久化之前拒绝；授权覆盖 await，恢复不能在写入中途越过它。
            if (committed || this.#generation > base) return false;
            await persist();
            committed = true;
            this.#generation = base + 1;
            this.syncRegistry();
            // 持久提交不可回滚；即使重建失败，也保留已落盘 generation 并释放授权。
            await afterCommit?.();
            return true;
          }),
      });
    },
  });

  syncRegistry(): void {
    this.context.runtimeTaskRegistry?.setActiveBranchGeneration?.(this.#generation);
  }

  private withBranchWrite<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const next = this.#branchWrites.then(operation);
    // 失败只释放本次授权，不阻塞之后的合法恢复或 rewind。
    this.#branchWrites = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function persistedGeneration(session: Pick<SessionInfo, "revert"> | null): number {
  return session?.revert?.branchGeneration ?? 0;
}

const owners = new WeakMap<object, RuntimeTurnCoordinationOwner>();

/** 构造期绑定一次；原型注入方法仍读原字段，实际没有可写字段或可替换的 getter。 */
export function initializeRuntimeTurnCoordination(runtime: CoordinationContext): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeTurnCoordinationOwner(runtime);
  Object.defineProperties(runtime, {
    activeTurnStartReservation: {
      configurable: false,
      enumerable: true,
      get: () => owner.reservation,
    },
    branchGeneration: { configurable: false, enumerable: true, get: () => owner.generation },
    runtimeCommandDrainActive: { configurable: false, enumerable: true, get: () => owner.draining },
  });
  owners.set(runtime, owner);
  owner.syncRegistry();
}

function requireOwner(runtime: object): RuntimeTurnCoordinationOwner {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime turn coordination has not been initialized");
  return owner;
}

export function getRuntimeTurnReservationPort(runtime: object): RuntimeTurnReservationPort {
  return requireOwner(runtime).reservationPort;
}

export function getRuntimeCommandDrainPort(runtime: object): RuntimeCommandDrainPort {
  return requireOwner(runtime).drainPort;
}

export function getRuntimeBranchRestorePort(runtime: object): RuntimeBranchRestorePort {
  return requireOwner(runtime).branchPort;
}
