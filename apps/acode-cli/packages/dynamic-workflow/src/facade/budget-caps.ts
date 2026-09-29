/**
 * 预算保险丝的上限常量（D2，specs/workflow-budget-fuses.md R1–R4）。
 *
 * 与 `report-caps.ts` / `world-read-caps.ts` / `artifact-caps.ts` 同姿态：常量住纯包、
 * 数字即契约、执行侧写在这里——**按成员族分裂**（与 artifact-caps 同一姿态）：两道 ask 闸
 * （总量 / 积压）由引擎核心的**调度器**执行（ask 准入时判定，见 scheduler-types.ts 的
 * runBudgetGatedAdmission）；token 闸由**引擎核心**执行（askStats 累加后事后判定，见
 * engine-caps.ts 的 failOnTokenBudget），不经 driver。
 *
 * 溢出策略同样按拒绝通道分裂：`agent().ask()` 返回 PromiseLike，脚本有 catch 通道，两道
 * ask 闸是**节点级拒绝**（`AgentBudgetExceeded`）；token 累计发生在 ask 结算**之后**、不在
 * 任何单次调用的返回通道上，脚本无处 catch，所以 token 闸按 report-caps 的 void 先例走
 * **failRun**（`TokenBudgetExceeded`）。ask 闸**绝不静默截断**：`Promise.all` 的语义要求
 * 每个元素都有结果，截断会让脚本 await 一个永不结算的 promise；所以积压闸是拒绝超出的
 * 条目（每个被拒的 ask 都拿到结构化 rejection），不是「只取前 K 个」。
 *
 * 三道闸不合并（R3）：派发闸（`caps.maxConcurrency`）管**速率**——同时跑几个；积压闸管
 * **同一时刻排了几个**；总量闸管**一个 run 累计烧了几个**；token 闸管**累计烧的钱**。
 * 合并会把并发 retune 与预算上界耦成同一个数字。数字必须宽到一份讲道理的脚本永远碰不到
 * （report-caps 同一论证）；定值依据回写在 spec 的「常量定值记录」小节。
 */

/** run 级的 ask 总量、扇出积压与 token 上限。数字即契约（见本模块顶部）。 */
export const BUDGET_CAPS = {
  /**
   * 一个 run 内最多能准入多少个 ask 节点（R2 总量保险丝）。计数口径 = journal 里
   * `kind:"ask"` 的行数（含 amend 导入命中物化的行），跨 resume 连续、绝不因反复
   * resume 刷新。失控回环（`while(true){ ask(...) }`）在这里止步。
   */
  maxAsksPerRun: 4096,
  /**
   * 同一时刻最多能有多少个未结算的 ask 节点（R3 fan-out 积压保险丝）。判定读
   * scheduler 的 liveNodes 现值，只在 live 准入前判——导入命中不占积压，resume 的
   * 记录再派发不是创建、不受此闸（拒掉它会破坏 replay 保真）。
   */
  maxPendingAsks: 2048,
  /**
   * 一个 run 累计 token 的硬顶（R4，P2 已落地）。计量面是既有的 `spentTokens`
   * （driver 每轮 turn 解析回报 `usage.totalTokens`，引擎在 askStats 里累加、落
   * `dwf_run.spent_tokens`、跨 resume/amend 继承）——本成员只是阈值：**事后**判定
   * （累加落库、usage-updated 照发之后才比较，不做请求前预估），越顶即整个 run 失败
   * （`TokenBudgetExceeded`，无 catch 通道故走 failRun）。超顶一个在飞 ask 的量是
   * 刻意取舍（宁可不猜 provider 的计数）。定值依据见 spec「常量定值记录」。
   */
  maxTokensPerRun: 2_000_000_000,
} as const;
