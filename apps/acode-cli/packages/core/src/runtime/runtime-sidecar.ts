/**
 * Sidecar 状态的所有者（R1-01 批次 B4，ContextMemory 5 子 owner 之四）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeContextMemoryState`
 * 的扁平可写字段——任何 method 都能直接 `this.memoryExtractionScheduler ??= ...` /
 * `this.memorySemanticRecallChannel = ...` / `this.residencyBlockingWorkCount += 1`
 * 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 ContextMemory 的「会话级 sidecar」3 字段（memoryExtractionScheduler /
 * memorySemanticRecallChannel / residencyBlockingWorkCount）收敛进一个私有 owner，
 * 形态与 `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts` 完全一致：WeakMap
 * 持有真值、构造期用 Object.defineProperty 装只读 getter（无 setter、
 * configurable:false）、写者只能经有限写端口。method 的读面（`this.residencyBlockingWorkCount`
 * 等）保持不变，只把**赋值点**改成端口调用，行为逐点等价。
 *
 * 字段归属：
 * - memoryExtractionScheduler：scheduleProjectMemoryExtraction 的 `??=` 惰性构造
 *   （helpers/project-memory-extraction.ts）——收敛为 getOrCreate 原子端口，
 *   factory 只在缺席时求值（与 `??=` 的 RHS 短路语义逐点等价）；
 * - memorySemanticRecallChannel：ensureChannel 的「读 → 同步构造 → 写」惰性构造
 *   （helpers/memory-semantic-recall.ts）——构造段无任何 await，收敛为 getOrCreate
 *   原子端口无观察窗变化；
 * - residencyBlockingWorkCount：trackResidencyBlockingWork 的计数器
 *   （residency.ts：`+= 1` 与 `Math.max(0, n - 1)`）——begin/end 端口各保持原子化，
 *   计数必须在 Promise 启动的同一同步片增加、只在 finally 释放（原注释语义不变）。
 */
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { MemorySemanticRecallChannel } from "./helpers/memory-semantic-recall.js";

export interface RuntimeSidecarView {
  readonly memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  /**
   * K1 会话级语义召回通道（specs/memory-semantic-recall.md R6/R9）：injector（含四层
   * 去重账本）+ 检索管线 + 度量账本。会话唯一所有者（非模块级全局），首轮检索时惰性
   * 构造；resume/rewind 不跨会话复用。
   */
  readonly memorySemanticRecallChannel?: MemorySemanticRecallChannel;
  readonly residencyBlockingWorkCount: number;
}

export interface RuntimeSidecarPort {
  /**
   * 惰性构造项目记忆提取调度器（原 `runtime.memoryExtractionScheduler ??= create(...)`）：
   * 已存在直接返回；缺席时求值 factory 并持有。factory 只在缺席时求值，
   * 与 `??=` 的 RHS 短路语义逐点等价。
   */
  getOrCreateExtractionScheduler(
    factory: () => ProjectMemoryExtractionScheduler,
  ): ProjectMemoryExtractionScheduler;
  /**
   * 惰性构造语义召回通道（原 ensureChannel 的「读 → 构造 → 写」段）：
   * 已存在直接返回；缺席时求值 factory 并持有。迁移前构造段同步无 await，
   * getOrCreate 原子化不改变可观察行为。
   */
  getOrCreateSemanticRecallChannel(
    factory: () => MemorySemanticRecallChannel,
  ): MemorySemanticRecallChannel;
  /**
   * residency 阻塞计数 +1（原 `this.residencyBlockingWorkCount += 1`）——
   * 必须在 Promise 启动的同一同步片调用。
   */
  beginBlockingWork(): void;
  /**
   * residency 阻塞计数释放（原 `this.residencyBlockingWorkCount = Math.max(0, ... - 1)`，
   * 含 0 下界钳制）——只在 trackResidencyBlockingWork 的 finally 调用。
   */
  endBlockingWork(): void;
}

class RuntimeSidecarOwner {
  #memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  #memorySemanticRecallChannel?: MemorySemanticRecallChannel;
  #residencyBlockingWorkCount = 0;

  get memoryExtractionScheduler(): ProjectMemoryExtractionScheduler | undefined {
    return this.#memoryExtractionScheduler;
  }

  get memorySemanticRecallChannel(): MemorySemanticRecallChannel | undefined {
    return this.#memorySemanticRecallChannel;
  }

  get residencyBlockingWorkCount(): number {
    return this.#residencyBlockingWorkCount;
  }

  readonly port: RuntimeSidecarPort = Object.freeze({
    getOrCreateExtractionScheduler: (
      factory: () => ProjectMemoryExtractionScheduler,
    ): ProjectMemoryExtractionScheduler => {
      this.#memoryExtractionScheduler ??= factory();
      return this.#memoryExtractionScheduler;
    },
    getOrCreateSemanticRecallChannel: (
      factory: () => MemorySemanticRecallChannel,
    ): MemorySemanticRecallChannel => {
      this.#memorySemanticRecallChannel ??= factory();
      return this.#memorySemanticRecallChannel;
    },
    beginBlockingWork: (): void => {
      this.#residencyBlockingWorkCount += 1;
    },
    endBlockingWork: (): void => {
      this.#residencyBlockingWorkCount = Math.max(0, this.#residencyBlockingWorkCount - 1);
    },
  });
}

const owners = new WeakMap<object, RuntimeSidecarOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeSidecar(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeSidecarOwner();
  Object.defineProperties(runtime, {
    memoryExtractionScheduler: {
      configurable: false,
      enumerable: true,
      get: () => owner.memoryExtractionScheduler,
    },
    memorySemanticRecallChannel: {
      configurable: false,
      enumerable: true,
      get: () => owner.memorySemanticRecallChannel,
    },
    residencyBlockingWorkCount: {
      configurable: false,
      enumerable: true,
      get: () => owner.residencyBlockingWorkCount,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeSidecarPort(runtime: object): RuntimeSidecarPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime sidecar has not been initialized");
  return owner.port;
}
