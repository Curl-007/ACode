/**
 * Context Init 状态的所有者（R1-01 批次 B4，ContextMemory 5 子 owner 之一）。
 *
 * 背景：`methods/` 下约 180 个函数经 installAgentRuntimeMethods 原型注入，签名一律
 * `this: AgentRuntimeInternal`。该类型组合了全部 7 簇，含 `RuntimeContextMemoryState`
 * 的扁平可写字段——任何 method 都能直接 `this.contextBuilder = ...` /
 * `this.contextInitialized = ...` / `this.contextSourceSnapshot = ...` 等
 * 绕过收敛（2026-10-22 review R1-01，P1）。
 *
 * 本切片把 ContextMemory 的「上下文初始化事务」9 字段（contextInitialized /
 * contextBuilder / contextSourceSnapshot / latestContextBuildResult / memoryRoot /
 * memoryIndexContent / promptFileRouting / skillLoadOutcome + 容器引用 messageHistory）
 * 收敛进一个私有 owner，形态与 `runtime-turn-timing.ts`/`runtime-cache-diagnostics.ts`
 * 完全一致：WeakMap 持有真值、构造期用 Object.defineProperty 装只读 getter
 * （无 setter、configurable:false）、写者只能经有限写端口。method 的读面
 * （`this.contextInitialized` 等）保持不变，只把**赋值点**改成端口调用，行为逐点等价。
 *
 * 字段归属（唯一写入方 = methods/context.ts 的 ensureContextInitialized /
 * initializeMessageHistoryFromContext、methods/config.ts 的 getContextBuilder、
 * methods/context-refresh.ts 的 rebuildContextPrefix、
 * methods/session-shell-environment.ts 的 refreshPreConversationShellContext、
 * methods/resume.ts 的 cold resume、agent-runtime 构造期）：
 * - contextSourceSnapshot / skillLoadOutcome / memoryRoot / memoryIndexContent /
 *   promptFileRouting / contextBuilder：ensureContextInitialized 的异步初始化面逐点写入
 *   （每字段一个端口，写点位置与迁移前逐行对应——初始化面允许并发观察者看到部分提交，
 *   与迁移前一致；收敛门是最后写入的 contextInitialized，不加固也不放宽）；
 * - latestContextBuildResult：initializeMessageHistoryFromContext 与 rebuildContextPrefix
 *   的 build() 结果记录；
 * - contextInitialized：单调提交（false → true），只由 ensureContextInitialized 尾部与
 *   构造期 builder 分支提交；resume cold 路径回退 false；
 * - messageHistory：容器实例。容器内写（19 个 method 文件的 addUser/addEntries/
 *   replaceMessages/delete 等 34 处调用）**不在本批范围**；owner 只封「整体替换」写面——
 *   构造期默认值（owner 初始值）+ resume.ts 的 `new MessageHistoryImpl()` 重赋值。
 *   经查全仓无任何 by-value 长持有方（runtime-tools 的 getToolSearchContext/hasLoadedSkill
 *   是调用期读 `runtime.messageHistory` 的闭包；resume/rewind 的 `history: this.messageHistory`
 *   是调用期传参），因此 resume 整体替换安全。替换与 contextBuilder=null /
 *   contextInitialized=false 是 resume cold 路径的同一连续同步块，合并为单个
 *   `resetForResume()` 端口保持块的原子性逐点等价。
 *
 * 关键不变量（spec §B4）：ensureContextInitialized 的并发语义与迁移前一致——
 * `contextInitialized` 是最后提交的单调旗标，读面以此收敛；owner 不新增跨 await 的
 * 互斥（迁移前没有，逐点等价硬约束），只保证「写必须经端口」。
 */
import type {
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  MessageHistory,
  SkillLoadOutcome,
} from "./deps.js";
import { MessageHistoryImpl } from "./deps.js";
import type { PromptFileRouting } from "../context/prompt-files.js";

export interface RuntimeContextInitView {
  readonly messageHistory: MessageHistory;
  readonly contextBuilder: ContextBuilder | null;
  readonly contextInitialized: boolean;
  readonly contextSourceSnapshot?: ContextSourceSnapshot;
  readonly latestContextBuildResult?: ContextBuildResult;
  readonly memoryRoot?: string;
  readonly memoryIndexContent?: string;
  readonly promptFileRouting?: PromptFileRouting;
  readonly skillLoadOutcome?: SkillLoadOutcome;
}

export interface RuntimeContextInitPort {
  /**
   * 提交 context source 解析快照（原 `this.contextSourceSnapshot = snapshot`）。
   * 调用方 = ensureContextInitialized（context.ts）与
   * refreshPreConversationShellContext 的 shell 选择 patch（session-shell-environment.ts，
   * 调用方构造 `{...旧 snapshot, envInfo}` 新对象后经本端口提交，逐点等价）。
   */
  commitContextSourceSnapshot(snapshot: ContextSourceSnapshot): void;
  /** 提交技能发现结果（原 `this.skillLoadOutcome = ...`，可为 undefined）。 */
  commitSkillLoadOutcome(outcome: SkillLoadOutcome | undefined): void;
  /** 提交项目记忆根（原 `this.memoryRoot = ...`）。 */
  commitMemoryRoot(memoryRoot: string | undefined): void;
  /** 提交 MEMORY.md 索引内容（原 `this.memoryIndexContent = ...`）。 */
  commitMemoryIndexContent(content: string | undefined): void;
  /** 提交提示词文件路由（原 `this.promptFileRouting = ...`）。 */
  commitPromptFileRouting(routing: PromptFileRouting): void;
  /**
   * 提交/替换 context builder（原 `this.contextBuilder = ...`）。调用方 =
   * ensureContextInitialized、getContextBuilder 的 config-only 预览分支（config.ts）、
   * rebuildContextPrefix 的两处重建（context-refresh.ts）、构造期 builder 分支。
   */
  commitContextBuilder(builder: ContextBuilder | null): void;
  /**
   * 记录最近一次 build() 结果（原 `this.latestContextBuildResult = ...`）。
   * 调用方 = initializeMessageHistoryFromContext 与 rebuildContextPrefix。
   */
  commitContextBuildResult(result: ContextBuildResult): void;
  /**
   * 单调提交 contextInitialized = true（原 `this.contextInitialized = true`）。
   * 只由 ensureContextInitialized 尾部与构造期 builder 分支调用；重复提交是幂等 no-op
   * （与迁移前重复赋 true 等价）。
   */
  markContextInitialized(): void;
  /**
   * cold resume 的三联重置（原 resume.ts 连续同步块
   * `this.messageHistory = new MessageHistoryImpl(); this.contextBuilder = null;
   * this.contextInitialized = false;`）：同一端口调用保持块原子性。
   * 新 MessageHistoryImpl 由 owner 内部构造（与构造期默认值同源）；
   * 旧容器无 by-value 长持有方（见文件头注），替换安全。
   */
  resetForResume(): void;
}

class RuntimeContextInitOwner {
  // messageHistory 容器实例：构造期默认值与 resume 替换都由 owner 内部构造
  // （原 agent-runtime.ts 构造期 `new MessageHistoryImpl()` 与 resume.ts 重赋值）。
  #messageHistory: MessageHistory = new MessageHistoryImpl();
  #contextBuilder: ContextBuilder | null = null;
  #contextInitialized = false;
  #contextSourceSnapshot?: ContextSourceSnapshot;
  #latestContextBuildResult?: ContextBuildResult;
  #memoryRoot?: string;
  #memoryIndexContent?: string;
  #promptFileRouting?: PromptFileRouting;
  #skillLoadOutcome?: SkillLoadOutcome;

  get messageHistory(): MessageHistory {
    return this.#messageHistory;
  }

  get contextBuilder(): ContextBuilder | null {
    return this.#contextBuilder;
  }

  get contextInitialized(): boolean {
    return this.#contextInitialized;
  }

  get contextSourceSnapshot(): ContextSourceSnapshot | undefined {
    return this.#contextSourceSnapshot;
  }

  get latestContextBuildResult(): ContextBuildResult | undefined {
    return this.#latestContextBuildResult;
  }

  get memoryRoot(): string | undefined {
    return this.#memoryRoot;
  }

  get memoryIndexContent(): string | undefined {
    return this.#memoryIndexContent;
  }

  get promptFileRouting(): PromptFileRouting | undefined {
    return this.#promptFileRouting;
  }

  get skillLoadOutcome(): SkillLoadOutcome | undefined {
    return this.#skillLoadOutcome;
  }

  readonly port: RuntimeContextInitPort = Object.freeze({
    commitContextSourceSnapshot: (snapshot: ContextSourceSnapshot): void => {
      this.#contextSourceSnapshot = snapshot;
    },
    commitSkillLoadOutcome: (outcome: SkillLoadOutcome | undefined): void => {
      this.#skillLoadOutcome = outcome;
    },
    commitMemoryRoot: (memoryRoot: string | undefined): void => {
      this.#memoryRoot = memoryRoot;
    },
    commitMemoryIndexContent: (content: string | undefined): void => {
      this.#memoryIndexContent = content;
    },
    commitPromptFileRouting: (routing: PromptFileRouting): void => {
      this.#promptFileRouting = routing;
    },
    commitContextBuilder: (builder: ContextBuilder | null): void => {
      this.#contextBuilder = builder;
    },
    commitContextBuildResult: (result: ContextBuildResult): void => {
      this.#latestContextBuildResult = result;
    },
    markContextInitialized: (): void => {
      this.#contextInitialized = true;
    },
    resetForResume: (): void => {
      this.#messageHistory = new MessageHistoryImpl();
      this.#contextBuilder = null;
      this.#contextInitialized = false;
    },
  });
}

const owners = new WeakMap<object, RuntimeContextInitOwner>();

/**
 * 构造期绑定一次；重复初始化不能替换已有 owner 或 getter（与其余 owner 同款幂等）。
 * 只读 getter 无 setter、configurable:false——原型注入 method 经 `this.X` 只读，
 * 任何 `this.X = ...` 在运行时抛 TypeError、在 tsc 下报 readonly 违例。
 */
export function initializeRuntimeContextInit(runtime: object): void {
  if (owners.has(runtime)) return;
  const owner = new RuntimeContextInitOwner();
  Object.defineProperties(runtime, {
    messageHistory: {
      configurable: false,
      enumerable: true,
      get: () => owner.messageHistory,
    },
    contextBuilder: {
      configurable: false,
      enumerable: true,
      get: () => owner.contextBuilder,
    },
    contextInitialized: {
      configurable: false,
      enumerable: true,
      get: () => owner.contextInitialized,
    },
    contextSourceSnapshot: {
      configurable: false,
      enumerable: true,
      get: () => owner.contextSourceSnapshot,
    },
    latestContextBuildResult: {
      configurable: false,
      enumerable: true,
      get: () => owner.latestContextBuildResult,
    },
    memoryRoot: {
      configurable: false,
      enumerable: true,
      get: () => owner.memoryRoot,
    },
    memoryIndexContent: {
      configurable: false,
      enumerable: true,
      get: () => owner.memoryIndexContent,
    },
    promptFileRouting: {
      configurable: false,
      enumerable: true,
      get: () => owner.promptFileRouting,
    },
    skillLoadOutcome: {
      configurable: false,
      enumerable: true,
      get: () => owner.skillLoadOutcome,
    },
  });
  owners.set(runtime, owner);
}

export function getRuntimeContextInitPort(runtime: object): RuntimeContextInitPort {
  const owner = owners.get(runtime);
  if (!owner) throw new Error("Runtime context init has not been initialized");
  return owner.port;
}
