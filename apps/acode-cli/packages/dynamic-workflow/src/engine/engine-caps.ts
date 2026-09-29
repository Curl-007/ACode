/**
 * run 级 caps 的装配、命令与 token 预算判定（R4/R6，specs/workflow-budget-fuses.md）。
 *
 * 从 engine.ts 拆出（该文件已抵 oxlint max-lines 上限），与 engine-settlement.ts /
 * engine-report.ts 同一姿态：自由函数经 {@link EngineState} 接缝读写引擎私有状态，
 * WorkflowEngine 上只留薄委托，公开面零变化。
 *
 * 三组事都围着 `Caps` 这**唯一载体**转：
 * - 创建装配（{@link creationCaps}）：把显式 token 预算折进 `caps.maxTokensPerRun`
 *   （生效值 = 与 `BUDGET_CAPS.maxTokensPerRun` 取更严），随 `run-started` 事件落
 *   journal——零 SQL，事件即锚点（R4「显式传入的值必须落 journal」/ R6「不做 migration」）。
 * - resume 装配（{@link resumedCaps}）：阈值从**第一世**的 run-started 读回，绝不接受
 *   调用方给的新阈值——与 args 的既有纪律同一条（engine.ts：「resume 从这里读回重放，
 *   绝不接受调用方给的新实参」）。生产仓储的 `dwf_run.caps_max_concurrency` 列只存并发
 *   （刻意不加列），所以事件是阈值唯一的持久化家。
 * - 就地并发命令（{@link setRunMaxConcurrency}，`WorkflowEngine.setMaxConcurrency` 的
 *   方法体）：整份换 caps 只改并发，其余成员（三道预算上界）原样带走（R6）。
 *
 * R4 的越顶判定（{@link failOnTokenBudget}）也住这里：判定是纯函数（累计值 vs 阈值），
 * 执行（failRun）经接缝走 engine-settlement 的 settleFailed——run 的裁决仍归引擎。
 */

import { BUDGET_CAPS } from "../facade/budget-caps.js";
import type { EngineState } from "./engine-state.js";
import type { AskStats, Caps, InstanceRef, JournalStorePort } from "./types.js";
import { WorkflowError } from "./types.js";

/**
 * 引擎自留的 caps 副本：整份拷贝、只挑声明过的成员，缺席的可选成员保持缺席（不落成
 * undefined 键——事件与 journal 里的 caps 形状必须与调用方给出的语义一致）。
 */
function copyCaps(caps: Caps): Caps {
  return {
    maxConcurrency: caps.maxConcurrency,
    ...(caps.maxAsksPerRun === undefined ? {} : { maxAsksPerRun: caps.maxAsksPerRun }),
    ...(caps.maxPendingAsks === undefined ? {} : { maxPendingAsks: caps.maxPendingAsks }),
    ...(caps.maxTokensPerRun === undefined ? {} : { maxTokensPerRun: caps.maxTokensPerRun }),
  };
}

/**
 * token 阈值的生效值（R4 阈值来源优先级：创建时显式传入 > `BUDGET_CAPS.maxTokensPerRun`
 * > 不设顶；显式值只允许**更严**——与常量取较小者，宽松方向被常量压回，与两道 ask 闸的
 * effectiveAskBudget 同一条「只能收紧」哲学）。
 *
 * 归一与 `inheritedTokens`（engine.ts）同一条纪律：非有限值与非正数按缺席、小数下取整——
 * 这个数要进事件与越顶判定，脏值必须死在装配之前。
 */
function effectiveTokenBudget(explicit: number | undefined): number | undefined {
  const normalized =
    explicit === undefined || !Number.isFinite(explicit) || explicit <= 0
      ? undefined
      : Math.floor(explicit);
  const constant: number | undefined = BUDGET_CAPS.maxTokensPerRun;
  if (constant === undefined) return normalized;
  return normalized === undefined ? constant : Math.min(normalized, constant);
}

/**
 * 建 run 那一世的 caps 装配：`tokenBudget`（EngineConfig 的显式通道）优先于 caps 上
 * 已带的成员，生效值折回 `maxTokensPerRun`——此后引擎、事件与判定读的都是同一个数
 * （单一真相：caps 成员），落 journal 走既有的 run-started 事件（R4/R6）。
 */
export function creationCaps(caps: Caps, tokenBudget: number | undefined): Caps {
  const copied = copyCaps(caps);
  const effective = effectiveTokenBudget(tokenBudget ?? copied.maxTokensPerRun);
  return effective === undefined ? copied : { ...copied, maxTokensPerRun: effective };
}

/**
 * resume 那一世的 caps 装配：token 阈值以 journal（第一世 run-started 事件）为唯一
 * 事实——读回 recorded 值，调用方这次带来的值（无论更松还是更严）一律丢弃。第一世没
 * 记录过阈值（本特性之前的老 run）时回落常量缺省——「缺席 = 用 BUDGET_CAPS 常量」与
 * Caps 成员的同一条规则；只有常量本身不设顶（P2 之前的形态）时成员才缺席。
 * 并发与两道 ask 闸成员照旧随调用方 caps（它们的 resume 语义各有归属：并发在
 * `dwf_run.caps_max_concurrency` 列，ask 闸是常量/更严覆盖，不随世变化）。
 */
export function resumedCaps(caps: Caps, journal: JournalStorePort, runId: string): Caps {
  const recorded = recordedTokenBudget(journal, runId);
  const { maxTokensPerRun: _callerValue, ...rest } = caps;
  return recorded === undefined ? rest : { ...rest, maxTokensPerRun: recorded };
}

/**
 * 第一世 run-started 事件里记录的阈值（经 effectiveTokenBudget 归一——老事件缺席该成员
 * 或值损坏时回落常量/不设顶，而不是把脏值带进判定）；从未有 run-started（合成 journal）
 * 同一条回落规则。
 */
function recordedTokenBudget(journal: JournalStorePort, runId: string): number | undefined {
  for (const stored of journal.listEvents(runId)) {
    if (stored.event.type !== "run-started") continue;
    return effectiveTokenBudget(stored.event.caps.maxTokensPerRun);
  }
  return effectiveTokenBudget(undefined);
}

/**
 * 就地改本 run **自己**的并发上界（`WorkflowEngine.setMaxConcurrency` 的方法体）。
 * 一次只带 `max_concurrency` 的修订作用在活着的 run 上：同一个 runId、不铸后继、不 supersede、
 * 在飞 ask 一个不丢——这正是它与 AmendWorkflow 的全部差别，也是它存在的唯一理由。
 *
 * 返回**这次是否真的改了**。两条 no-op 都返回 false 且不写库、不发事件：run 已结算（宿主的
 * 存活判定与本调用之间的竞态——调用方据此回落到一次真正的 amend），以及新值与当前值相同。
 *
 * 改成时三件事在同一个同步步骤里发生，于是三者永远一致：整份换掉 caps（调度器现读）、写
 * `dwf_run.caps_max_concurrency`（resume 沿用行里的 caps，不落库就恢复成旧上界）、记一条
 * `run-caps-changed`。**抬高**还多一次 `pumpAll()`——上界是派发前现读的，但没有别的事件会
 * 触发重扫，排队的 ask 否则要等到下一次结算。调低不召回在飞 ask：它们照常跑完，上界只管
 * 「还能不能再放一个」。
 *
 * 钳到 `[1, 天花板]` 归调用方——天花板是宿主事实（机器核数），引擎既看不见也不该看见。
 * 这里只做落库归一，与构造函数里的 `inheritedTokens` 同一条纪律：这个数要落
 * `caps_max_concurrency`（integer not null），一个 NaN 会同时毒化列值与派发判据。
 */
export function setRunMaxConcurrency(state: EngineState, maxConcurrency: number): boolean {
  if (state.isRunSettled()) return false;
  if (!Number.isFinite(maxConcurrency)) return false;
  const previous = state.caps();
  const next = Math.max(1, Math.floor(maxConcurrency));
  if (next === previous.maxConcurrency) return false;
  // 整份换掉、只改并发：其余成员（三道预算上界的更严覆盖，R6）原样带走——
  // 一次并发 retune 不得顺带丢弃或改写别的上界。
  const caps: Caps = { ...previous, maxConcurrency: next };
  state.applyCaps(caps);
  state.journal.updateRunCaps(state.runId, caps);
  state.record({ type: "run-caps-changed", runId: state.runId, caps, previous });
  if (next > previous.maxConcurrency) state.pumpAll();
  return true;
}

/**
 * ask 用量回报的记账 + R4 越顶判定（`WorkflowEngine.askStats` 的方法体——计量面的唯一
 * 累加点与唯一判定点住同一个模块）。三件事的顺序是载荷性的：
 *
 * 1. 节点侧回填（noteStats）照旧；
 * 2. 累计 + 立刻持久化，且早于事件——事件载荷与 `spent_tokens` 列值在同一同步步骤产生，
 *    二者永远相等（不能只在 createRun(0) 落库一次：累计不回写会让 resume 恢复出零用量）；
 * 3. 结算后到达的 straggler stats 只记账不发事件（run-settled 必须是事件流最后一条），
 *    也**不判定**——账仍要入：可 resume 的 run 用量跨生命周期连续，判定留给下一世；
 * 4. usage-updated 照常发出**之后**才做越顶判定（R6：不因超顶而多发或少发），run 级失败
 *    紧随其后（事件序：usage-updated → run-settled）。first-wins 由 settleFailed 再守一道。
 */
export function recordAskUsage(state: EngineState, instance: InstanceRef, stats: AskStats): void {
  state.noteStats(instance, stats);
  state.addSpentTokens(stats.tokens);
  const spent = state.spentTokens();
  state.journal.updateRunUsage(state.runId, spent);
  if (state.isRunSettled()) return;
  state.record({ type: "usage-updated", spentTokens: spent });
  failOnTokenBudget(state, spent, state.caps().maxTokensPerRun);
}

/**
 * R4 越顶判定（**事后**）：`spentTokens` 每次累加之后比较一次。不做请求前预估——预估会把
 * provider 的 token 计数变成引擎的猜测，而既有记账是事实；超顶一个在飞 ask 的量是刻意取舍。
 */
export function failOnTokenBudget(
  state: Pick<EngineState, "failRun">,
  spentTokens: number,
  budget: number | undefined,
): void {
  if (budget === undefined || spentTokens <= budget) return;
  state.failRun(tokenBudgetExceeded(spentTokens, budget));
}

/**
 * `TokenBudgetExceeded` 的构造：message 自撰、含两个数（累计与阈值），读面不必解析文本
 * 就有上下文；流程判断一律走 code。刻意不带结构化 details——`WorkflowError.details` 是
 * AgentBudgetExceeded 两道闸的区分面（limit total/pending），token 闸自成一码、无歧义，
 * 不再给它造第二个词汇。
 */
function tokenBudgetExceeded(spentTokens: number, budget: number): WorkflowError {
  return new WorkflowError(
    "TokenBudgetExceeded",
    `Token budget exhausted: this run has spent ${spentTokens} tokens against a budget of ` +
      `${budget}. The run failed as a whole — token spend is accumulated by the engine after ` +
      `each ask settles and is not on any call's return channel, so there is nothing the ` +
      `script could catch (the same rejection-channel rule as ReportCapExceeded). Settled ` +
      `nodes and reported items stay in the journal.`,
  );
}
