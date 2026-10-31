/**
 * Tool Cache 状态的所有者（R1-01 批次 B4，ContextMemory 5 子 owner 之三）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeContextMemoryState`
 * 的扁平可写字段——任何 method 都能直接 `this.cachedTools = ...` /
 * `this.toolSearchContext = ...` 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 ContextMemory 的「工具面派生态」2 字段（cachedTools / toolSearchContext）
 * 收敛进一个私有 owner，形态与 `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts`
 * 完全一致：WeakMap 持有真值、构造期用 Object.defineProperty 装只读 getter（无 setter、
 * configurable:false）、写者只能经有限写端口。method 的读面（`this.cachedTools` 等）
 * 保持不变，只把**赋值点**改成端口调用，行为逐点等价。
 *
 * 两字段同 owner、不同端口组的理由（scoping §2.2 组 C 的开放项）：
 * - cachedTools 是「派生缓存 + invalidate」——getTools 的 `=== null` 检查与度量日志留在
 *   调用方（tools-schema-token-metrics 套件以源码字符串钉住该分支形态，端口只封赋值），
 *   invalidate 写点 = invalidateToolCache（config.ts）与 refreshBranchAwareBuiltInTools
 *   （embedded-search-branch.ts）；
 * - toolSearchContext 是「请求级单点写入 + executor 读缝」（specs/tool-search.md R8）——
 *   唯一写入方是 projectToolSearchRequest（tool-search-request.ts），executor deps 经
 *   getToolSearchContext 闭包调用期读取；
 * - 两者语义不同但都属于「工具面供给 executor/模型请求的派生态」，写入方各 1-2 个文件；
 *   拆成两个 owner 文件会为各 2 个端口复制整套样板（WeakMap/initialize/getPort），
 *   语义边界由同 owner 内的两组独立端口表达即可。
 */
import type { ToolSearchExecutionContext } from "@acode/contracts";
import type { ModelToolContract } from "./deps.js";

export interface RuntimeToolCacheView {
  readonly cachedTools: ModelToolContract[] | null;
  /**
   * 当前请求的工具搜索 context（specs/tool-search.md R8）：请求准备单点写入，
   * executor deps 经 getToolSearchContext 读取注入 handler；undefined = 未启用。
   * 发现集合唯一所有者是请求决策（每次准备重建），这里只是 executor 的读取缝，
   * 不建第二缓存。
   */
  readonly toolSearchContext?: ToolSearchExecutionContext;
}

export interface RuntimeToolCachePort {
  /**
   * 提交重建后的可见工具契约缓存（原 getTools 的 `this.cachedTools = filterRuntimeVisibleTools...`）。
   * `cachedTools === null` 的判定与度量日志（logToolsSchemaTokenMetric）留在调用方——
   * tools-schema-token-metrics 套件以源码字符串钉住该分支形态。
   */
  commitCachedTools(tools: ModelToolContract[]): void;
  /**
   * 失效工具缓存（原 `this.cachedTools = null`）。调用方 = invalidateToolCache
   * （config.ts）与 refreshBranchAwareBuiltInTools（embedded-search-branch.ts）。
   */
  invalidateCachedTools(): void;
  /**
   * 请求级工具搜索 context 写入（原 projectToolSearchRequest 的
   * `runtime.toolSearchContext = exposure.context`）。
   */
  commitToolSearchContext(context: ToolSearchExecutionContext): void;
  /**
   * 请求级工具搜索 context 清除（原 projectToolSearchRequest off 路径的
   * `runtime.toolSearchContext = undefined`）。
   */
  clearToolSearchContext(): void;
}

class RuntimeToolCacheOwner {
  #cachedTools: ModelToolContract[] | null = null;
  #toolSearchContext?: ToolSearchExecutionContext;

  get cachedTools(): ModelToolContract[] | null {
    return this.#cachedTools;
  }

  get toolSearchContext(): ToolSearchExecutionContext | undefined {
    return this.#toolSearchContext;
  }

  readonly port: RuntimeToolCachePort = Object.freeze({
    commitCachedTools: (tools: ModelToolContract[]): void => {
      this.#cachedTools = tools;
    },
    invalidateCachedTools: (): void => {
      this.#cachedTools = null;
    },
    commitToolSearchContext: (context: ToolSearchExecutionContext): void => {
      this.#toolSearchContext = context;
    },
    clearToolSearchContext: (): void => {
      this.#toolSearchContext = undefined;
    },
  });
}

const owners = new WeakMap<object, RuntimeToolCacheOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeToolCache(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeToolCacheOwner();
  Object.defineProperties(runtime, {
    cachedTools: {
      configurable: false,
      enumerable: true,
      get: () => owner.cachedTools,
    },
    toolSearchContext: {
      configurable: false,
      enumerable: true,
      get: () => owner.toolSearchContext,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeToolCachePort(runtime: object): RuntimeToolCachePort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime tool cache has not been initialized");
  return owner.port;
}
