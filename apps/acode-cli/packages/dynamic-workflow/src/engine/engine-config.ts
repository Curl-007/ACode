import type { AskSpec, Caps, ImportedRunCache, ValidateFn, WorkflowDriver } from "./types.js";
import type { RunLaunchConfig } from "./engine-launch.js";

/** 引擎构造配置。 */
export interface EngineConfig {
  runId: string;
  driver: WorkflowDriver;
  /** 外部停止输入；引擎生命周期取消继续向 world execution port 传播。 */
  signal?: AbortSignal;
  caps: Caps;
  /**
   * 每 ask 站点的静态规格（typed + schema）。**必须覆盖脚本里的每一个 ask 站点**——
   * 站点表与 schema 合成来自同一次编译，因此缺席只可能是接线错误，引擎按硬错误处理
   * （MissingAskSpec）。untyped 站点要显式记为 `{ typed: false }`。
   */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /** 注入的 schema 校验器（核心不 import schema 实现）。 */
  validate: ValidateFn;
  /** run 元数据（落 dwf_run，仅在本次 createRun 时写入；resume 时不覆写记录）。 */
  scriptText?: string;
  /**
   * run 的展示名（`CreateWorkflow` 的可选 `input.name`）。引擎不读它，只在建 run 时随
   * `scriptText` 一起落库——宿主的枚举面据它给 run 起标签。见 {@link RunRecord.name}。
   */
  name?: string;
  /**
   * 脚本文本的哈希。resume 时与 journal 记录里的值比对：两侧都有且不同即拒绝本次 resume
   * （V1 的 resume 只对逐字节相同的脚本有效）。
   */
  scriptHash?: string;
  /**
   * 本次 run 的实参（已校验回填）。引擎不读它，只在建 run 时随 `scriptText` 一起落库；
   * 沙箱侧的注入走 harness 的 spawn payload，不经引擎。见 {@link RunRecord.args}。
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  ownerGeneration?: number;
  ownerToken?: string;
  cwd?: string;
  /**
   * 发起 run 的 CreateWorkflow 工具调用 id（见 {@link RunRecord.toolCallId}）。
   * 引擎不读它，只随其余元数据在 createRun 时落库。
   */
  toolCallId?: string;
  /**
   * 本次 run 修订自哪个前驱 run（见 {@link RunRecord.resumedFrom}）。引擎不读它，
   * 只随其余元数据在 createRun 时落库——导入缓存的构建在 run service，不在核心。
   */
  resumedFrom?: string;
  /**
   * 发起 run 那一轮的锚点。引擎不读它，只在建 run 那一世
   * 紧跟首条 `run-started` 记一条 `run-launched`；resume 命中既有行时不再记（锚点跨生命周期唯一）。
   * `phaseNames` 随锚点同车：脚本声明的阶段表，引擎同样不读，只落 journal。`phaseAlongside`
   * 与它按位置对齐（下标指向同一张表），同车同规。
   * `subagentModel` 也同车：本 run 子代理的选型（规范 picker 串），引擎同样不读——模型面整个
   * 在宿主侧（bootstrap 的 workflow-actor-model.ts），宿主从这条事件读回它，零 SQL。
   * `scriptPath` 同车同规：本 run 的脚本来自哪个文件（绝对路径），引擎不读，宿主从这条事件
   * 读回它交给模型面。
   */
  launch?: RunLaunchConfig;
  /**
   * 建 run 时的用量起点：前驱 run 的 `spentTokens`。amend 路径给出，全新 submit 缺席（= 从零起账），
   * resume 路径给了也无用——命中既有行时用量从行里恢复。
   *
   * 语义是「本 run 报的是整条 lineage 的花费」：每个前驱的数字本身已是累计值，所以链式修订
   * 按构造求和，没人需要走 `resumed_from` 链。命中缓存不再加钱（那笔账就在这个继承值里），
   * 只有本次现跑的 live turn 往上加。
   */
  inheritedTokens?: number;
  /**
   * 本次 run 的 token 预算显式阈值（R4，specs/workflow-budget-fuses.md）。生效值 = 它与
   * `BUDGET_CAPS.maxTokensPerRun` 取更严，装配进 `caps.maxTokensPerRun` 后随 run-started
   * 事件落 journal（零 SQL）；resume 从 journal 读回，**绝不接受调用方给的新阈值**——与
   * `args` 同一条纪律（见下面 args 的注释）。缺席 = 用常量；归一（非有限值与非正数按缺席、
   * 小数下取整）在 engine-caps.ts 的 creationCaps 一处做。
   */
  tokenBudget?: number;
  /**
   * amend-resume 的导入缓存（{@link ImportedRunCache}）。**纯数据注入**——核心因此仍是
   * 零 I/O 的确定性状态机：读前驱 journal、走 `resumed_from` 链、解析转录源，全部发生在
   * run service，引擎只拿到一张构建好的表并按运行期身份（actor 名 + persona、
   * `{op,args}` 内容 + 出现序）比对。缺席即本次不是修订续跑。
   */
  importedCache?: ImportedRunCache;
}
