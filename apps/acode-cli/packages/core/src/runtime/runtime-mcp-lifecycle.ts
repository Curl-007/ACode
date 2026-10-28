/**
 * MCP Lifecycle 状态的所有者（R1-01 批次 B4，ContextMemory 5 子 owner 之二）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeContextMemoryState`
 * 的扁平可写字段——任何 method 都能直接 `this.mcpInitialized = ...` /
 * `this.mcpStartupPromise = ...` / `this.mcpInitializationPromise = ...` /
 * `this.mcpToolsRegistered = ...` 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 ContextMemory 的「MCP 启动/注册并发事务」4 字段（mcpInitialized /
 * mcpStartupPromise / mcpInitializationPromise / mcpToolsRegistered）收敛进一个私有
 * owner，形态与 `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts` 完全一致：
 * WeakMap 持有真值、构造期用 Object.defineProperty 装只读 getter（无 setter、
 * configurable:false）、写者只能经有限写端口。method 的读面（`this.mcpToolsRegistered`
 * 等）保持不变，只把**赋值点**改成端口调用，行为逐点等价。
 *
 * 字段归属（唯一写入方 = methods/mcp.ts 的 startMcpStartup / initializeMcp /
 * initializeMcpOnce）：
 * - mcpInitialized：startMcpStartup 的一次性 claim（「读 false + 写 true」原子化，
 *   并发/重复调用只第一个调用方拿到 claimed:true）；
 * - mcpStartupPromise：claim 成功后提交 startup 连接 promise（仅此一次提交）；
 * - mcpInitializationPromise：initializeMcp 的并发守卫——先占住同一个 promise 再 await，
 *   避免两个调用都通过 false 检查并重复注册工具；finally 释放；
 * - mcpToolsRegistered：单调提交（false → true）——成功路径尾部、无 startup 可跟的
 *   提前返回、失败路径的一次性 fail-closed 三处写点共用同一端口。
 *
 * 关键不变量（spec §B4）：
 * - MCP initialize 只允许一次真实注册：mcpInitializationPromise 的「读 undefined +
 *   写 promise」在同一同步片（initializeMcp 从检查到 claimInitialization 之间无 await，
 *   initializeMcpOnce.call 同步段含 startMcpStartup 的 startup claim），并发第二个
 *   initializeMcp 只能 await 既有 promise；
 * - mcpToolsRegistered 单调不回退：失败路径也提交 true（fail-closed，
 *   startup 拒绝后不在同一 runtime 重试连接——runtime-mcp-lifecycle 套件钉住）；
 * - claimStartup 的「读 + 写」原子化：并发 startMcpStartup 只一个 claimed:true，
 *   其余拿到既有 startupPromise。
 */
import type { McpConnectionSnapshot } from "./deps.js";

export interface RuntimeMcpLifecycleView {
  readonly mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  readonly mcpInitializationPromise?: Promise<void>;
  readonly mcpInitialized: boolean;
  readonly mcpToolsRegistered: boolean;
}

export interface RuntimeMcpLifecyclePort {
  /**
   * startup 一次性 claim（原子「读 mcpInitialized + 写 true」）：第一个调用方拿到
   * `{ claimed: true, startupPromise: undefined }`；后续调用方拿到
   * `{ claimed: false, startupPromise: 已提交的 startup promise }`。
   * 等价于原 startMcpStartup 入口的
   * `if (this.mcpInitialized) return this.mcpStartupPromise; this.mcpInitialized = true;`。
   */
  claimStartup(): {
    claimed: boolean;
    startupPromise: Promise<McpConnectionSnapshot> | undefined;
  };
  /**
   * 提交 startup 连接 promise（原 `this.mcpStartupPromise = this.trackResidencyBlockingWork(startup)`）。
   * 只在 claimStartup 成功后调用一次；promise 由调用方构造（trackResidencyBlockingWork
   * 包装是方法职责），owner 只持有引用。
   */
  commitStartupPromise(startup: Promise<McpConnectionSnapshot>): void;
  /**
   * initializeMcp 的并发守卫 claim（原 `this.mcpInitializationPromise = initialization`）。
   * 从入口检查（`this.mcpInitializationPromise !== undefined` → await 既有）到本端口的
   * claim 之间无 await（initializeMcpOnce.call 同步段完成 startup claim），与迁移前同一片。
   */
  claimInitialization(initialization: Promise<void>): void;
  /** 释放 initialization 守卫（原 finally 的 `this.mcpInitializationPromise = undefined`）。 */
  releaseInitialization(): void;
  /**
   * 单调提交 mcpToolsRegistered = true（三处写点：无 startup 可跟的提前返回、
   * 失败路径 fail-closed、成功路径尾部）。重复提交是幂等 no-op（与迁移前重复赋 true 等价）。
   */
  commitToolsRegistered(): void;
}

class RuntimeMcpLifecycleOwner {
  #mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  #mcpInitializationPromise?: Promise<void>;
  #mcpInitialized = false;
  #mcpToolsRegistered = false;

  get mcpStartupPromise(): Promise<McpConnectionSnapshot> | undefined {
    return this.#mcpStartupPromise;
  }

  get mcpInitializationPromise(): Promise<void> | undefined {
    return this.#mcpInitializationPromise;
  }

  get mcpInitialized(): boolean {
    return this.#mcpInitialized;
  }

  get mcpToolsRegistered(): boolean {
    return this.#mcpToolsRegistered;
  }

  readonly port: RuntimeMcpLifecyclePort = Object.freeze({
    claimStartup: (): {
      claimed: boolean;
      startupPromise: Promise<McpConnectionSnapshot> | undefined;
    } => {
      if (this.#mcpInitialized) {
        return { claimed: false, startupPromise: this.#mcpStartupPromise };
      }
      this.#mcpInitialized = true;
      return { claimed: true, startupPromise: undefined };
    },
    commitStartupPromise: (startup: Promise<McpConnectionSnapshot>): void => {
      this.#mcpStartupPromise = startup;
    },
    claimInitialization: (initialization: Promise<void>): void => {
      this.#mcpInitializationPromise = initialization;
    },
    releaseInitialization: (): void => {
      this.#mcpInitializationPromise = undefined;
    },
    commitToolsRegistered: (): void => {
      this.#mcpToolsRegistered = true;
    },
  });
}

const owners = new WeakMap<object, RuntimeMcpLifecycleOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeMcpLifecycle(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeMcpLifecycleOwner();
  Object.defineProperties(runtime, {
    mcpStartupPromise: {
      configurable: false,
      enumerable: true,
      get: () => owner.mcpStartupPromise,
    },
    mcpInitializationPromise: {
      configurable: false,
      enumerable: true,
      get: () => owner.mcpInitializationPromise,
    },
    mcpInitialized: {
      configurable: false,
      enumerable: true,
      get: () => owner.mcpInitialized,
    },
    mcpToolsRegistered: {
      configurable: false,
      enumerable: true,
      get: () => owner.mcpToolsRegistered,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeMcpLifecyclePort(runtime: object): RuntimeMcpLifecyclePort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime MCP lifecycle has not been initialized");
  return owner.port;
}
