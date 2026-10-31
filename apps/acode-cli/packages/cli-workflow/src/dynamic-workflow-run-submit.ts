// ============================================================
// Dynamic Workflow Run Service：启动半边（submit / amend）与「编译一次」
// ============================================================
// run service 的启动半边。三条入口（全新提交、修订续跑、崩溃恢复）方向相反、绝不共用门（见
// run service 文件头不变式 1），但它们共享同一份注册表、同一张停驻表与同一条结算簿记——
// 这三样经 {@link DynamicWorkflowRunEntryContext} 从 service 显式递进来，本文件不持有任何自己的状态。
//
// 拆分后本文件持有：
//   - submitDynamicWorkflowRun / amendDynamicWorkflowRun 两条入口；
//   - 它们共用的启动尾 startNewRun（编译 → 锚点 → 注册表条目 → fire-and-forget launch）。
// resume 入口与 EntryContext 住在 dynamic-workflow-run-resume.ts（经本文件再导出，
// 既有消费者的导入路径不变）；「编译一次」的公共编译面在 dynamic-workflow-run-compile.ts。
//
// 变更纪律：只动 submit / amend 的入口编排与启动尾；resume 的改动去 resume 叶。

import type {
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  TraceContext,
} from "@acode/contracts";
import {
  type ImportedRunCache,
  type RunSettlement,
} from "@acode/dynamic-workflow";
import {
  formatModelPickerValue,
  type ModelSelection,
} from "@acode/shared/model-selection";
import {
  buildImportedCache,
  preflightAmendImport,
} from "./dynamic-workflow-import.js";
import { launchDynamicWorkflowRun } from "./dynamic-workflow-run-launch.js";
import {
  readRunLaunchAnchor,
  resolveLaunchAnchor,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";
import { compileOnce, mintRunId } from "./dynamic-workflow-run-compile.js";
import type { DynamicWorkflowRunEntryContext } from "./dynamic-workflow-run-resume.js";

export {
  resumeDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-resume.js";

/** `DynamicWorkflowRunPort.submit` 的实现体：全新 run，没有前驱、没有缓存。 */
export async function submitDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunSubmitRequest,
): Promise<DynamicWorkflowRunSubmitResult> {
  const runId = startNewRun(ctx, {
    runId: mintRunId(),
    scriptText: request.scriptText,
    cwd: request.cwd,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.launchInputId === undefined ? {} : { launchInputId: request.launchInputId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // 脚本文件与子代理模型同车：原样下传，
    // 端口不做任何推断——写没写下草稿是工具侧的事实，缺席就是真的没有文件。
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
  });
  return { ok: true, runId };
}

/**
 * `DynamicWorkflowRunPort.amend` 的实现体。
 *
 * 顺序就是全部的语义：
 *   1. **预检**前驱（存在 ∧ 边界齐全）——被拒时什么都没动，前驱照旧在跑；
 *   2. 铸新 id；
 *   3. 前驱在飞则以 `{ superseded: newRunId }` 取消并 **await 它自己的结算 promise**——不是超时、
 *      不是轮询 journal；前驱因此结算成 `stopped(superseded, supersededBy)`；
 *   4. 有界地等被中止的 turn 把尾巴写完，问出「哪些会话此刻可以放心去数」——只有它影响在飞
 *      ask 的接续，完结前缀的边界是 journal 事实（见下面那段注释的完整论证）；
 *   5. 从已结算的前驱构建缓存——预检已过，这里再被拒只可能是宿主故障，上抛；
 *   6. 与全新 submit 同一条 launch 路启动，带 `resumedFrom` 与缓存。
 *
 * 旧版让 `submit({resumeFrom})` 对在飞前驱回 `not_amendable`，模型只能 TaskStop → 轮询到
 * stopped → 重提交三步；本方法把停止与结算等待收进 service，竞态随之消失。
 */
export async function amendDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunAmendRequest,
): Promise<DynamicWorkflowRunAmendResult> {
  const { deps, runs } = ctx;
  const preflight = preflightAmendImport(deps.journal, request.predecessorRunId);
  if (!preflight.ok) {
    deps.logger?.info?.("Dynamic workflow amend refused", {
      event: "dynamic_workflow.amend.refused",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      reason: preflight.reason,
    });
    return { ok: false, reason: preflight.reason };
  }
  const predecessor = preflight.run;
  const runId = mintRunId();

  // 在飞判定看**本进程注册表**而不是 journal 状态：journal 说 running 而注册表里没有它，是别的
  // 进程（或死进程）的 run，本 service 停不了也等不到——按已结算处理，让导入构建的终态门说话
  // （非终态即抛，见下）。
  const live = runs.get(request.predecessorRunId);
  let supersededRunId: string | undefined;
  if (live !== undefined && live.terminal === undefined) {
    live.controller.abort({ superseded: runId });
    // 等前驱自己的结算 promise（与 waitForTask 同一个 promise；trackSettlement 保证它永不 reject）。
    await live.settlement;
    supersededRunId = request.predecessorRunId;
    deps.logger?.info?.("Dynamic workflow run superseded by an amendment", {
      event: "dynamic_workflow.amend.superseded",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      runId,
    });
  }

  // 静默闸门。
  //
  // 根因：`dispose()` 是同步的，对还有在飞 turn 的会话只挂了一条 `state.turn.then(close, close)`
  // 而不等它；引擎在 `cancelAsk` 中止 turn 之后立刻结算。所以上面那句 `await live.settlement`
  // 保证的是「run 结算了」，**不是**「被中止的 turn 把它的尾巴写完了」。此刻去数前驱会话的
  // 消息条数，可能少数一条，或者数到一条 part 还没落全的消息——而那个数会变成接续位置
  // （`inFlight.messageBoundary`），被 driver 拿去截断复制。已完结前缀不在此列：它们的边界在
  // ask 结算时就已经 journal 了，是事实而不是此刻的观察。
  //
  // 所以问一次 driver「哪些会话已经静默」，只对静默的会话谈接续。**这不是用超时掩盖竞态**：
  // 到点仍未落地的会话不会被当作静默继续用，它只是拿不到 `inFlight`——也就是本特性之前的
  // 行为（整段在飞转录丢弃，ask 从完整前缀重开）。我们宁可少做一次优化，也绝不拿一个正在
  // 变动的条数去截断转录。
  //
  // 两种情形一秒都不等，因为两者都没有可疑的数可言：
  //   - 本进程没有这个前驱的活条目（早已终态，或死进程留下的行）→ 没有 driver 就没有东西在
  //     写它的会话；
  //   - 整个装配没有转录存取面 → 根本数不出条数，`inFlight` 无从产生（构建器那边同样要
  //     `messageCount` 才谈接续），等待纯属白付。
  // 两者都落到「缺席 = 全部静默」这一条上（见 AmendImportOptions.quietSessions）。
  const quietSessions =
    deps.actorTranscriptStore === undefined ? undefined : await live?.quiescence?.quietSessions();

  const built = await buildImportedCache(
    deps,
    request.predecessorRunId,
    quietSessions === undefined ? undefined : { quietSessions },
  );
  if (!built.ok) {
    // 预检刚通过：run 存在、边界齐全；到这里还被拒只剩「前驱非终态」——注册表说它不在飞而
    // journal 说它还在跑（别的进程持有）。这不是模型能改的输入，按接线故障上抛。
    throw new Error(
      `dynamic workflow amend could not import from run ${request.predecessorRunId} after preflight: ${built.reason}`,
    );
  }

  // 用量起点：**前驱结算之后**再读一次行。preflight 那一份是停止之前的快照，用它会漏掉前驱最后几轮的
  // 花费——修订一个在飞 run 恰好是这条路最常见的用法。读不到行按 0 处理（前驱刚被清理）。
  const settledPredecessor = deps.journal.getRun(request.predecessorRunId);
  const inheritedTokens = settledPredecessor?.spentTokens ?? 0;
  // 实参只在调用方明说时沿用（GUI「配置」重跑的是前驱自己的脚本，见端口字段注释）；工具路径
  // 不传，修订照旧不带实参。前驱没有实参（内联脚本 / 老行）时整个字段缺席。
  const inheritedArgs =
    request.inheritArgs === true && settledPredecessor?.args !== undefined
      ? settledPredecessor.args
      : undefined;

  startNewRun(ctx, {
    runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    inheritedTokens,
    // 展示名沿用前驱：修订是同一件工作的下一版，卡片与通知里换个名字只会让用户以为是另一条工作流。
    ...(request.name !== undefined
      ? { name: request.name }
      : predecessor.name === undefined
        ? {}
        : { name: predecessor.name }),
    ...(inheritedArgs === undefined ? {} : { args: inheritedArgs }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    // 并发上界不从前驱继承：「省略即沿用前驱」是**工具面**的三态，`AmendWorkflow` 的
    // resolveInput 已经把它归一成这里的一个数或缺席（缺席 = 天花板）。端口若再继承一次，
    // 「解除限制」（`null`）就永远到不了这里。
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    // 子代理模型同样不从前驱继承，与上面的并发上界同一条论证：「省略即沿用前驱」是**工具面**
    // 的三态，`AmendWorkflow` 的 resolveInput 已经把它归一成这里的一条选择或缺席（缺席 = 回到
    // 会话模型）。端口若再继承一次，「回到会话模型」（`null`）就永远到不了这里。
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // 脚本文件**绝不从前驱继承**：修订记的是这一次修订的脚本来自哪个文件（`path` 提交就是
    // 那个文件，内联提交就是刚写下的草稿）。沿用前驱的路径等于让模型下次去编辑旧脚本。
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
    imported: { cache: built.cache, resumedFrom: built.resumedFrom },
  });
  return { ok: true, runId, ...(supersededRunId === undefined ? {} : { supersededRunId }) };
}

interface StartNewRunInput {
  runId: string;
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  launchInputId?: string;
  /** 脚本声明的阶段表（submit 与 amend 都传：修订用**新脚本**的阶段表）。 */
  phaseNames?: string[];
  /** 请求的并发上界；缺席即天花板。钳制在 {@link DynamicWorkflowRunEntryContext.caps} 里。 */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型。缺席即子代理跑在会话模型上。
   * 结构化选择进来，落库前归一成 picker 字符串——见 startNewRun 里的注释。
   */
  subagentModel?: ModelSelection;
  /**
   * 本 run 脚本文件的绝对路径。缺席即这个
   * run 没有可编辑的脚本文件。纯模型面元数据：不参与执行，也不参与 resume 校验。
   */
  scriptPath?: string;
  /** 与 `phaseNames` 对齐的「同时在跑」表；下标指向的就是上面这张表，两者同来同走。 */
  phaseAlongside?: number[][];
  trace: TraceContext;
  /**
   * 本 run 的用量起点（前驱结算后的 `spentTokens`）。amend 路径给出，全新 submit 缺席（= 0）。
   */
  inheritedTokens?: number;
  /** amend 路径：lineage 指针与导入缓存成对出现。 */
  imported?: { cache: ImportedRunCache; resumedFrom: string };
}

/**
 * submit 与 amend 共用的启动尾：编译 → 锚点 → 注册表条目 → fire-and-forget launch。
 * 返回 runId（同步：注册表条目在本函数返回前就已存在，见下面的注释）。
 */
function startNewRun(ctx: DynamicWorkflowRunEntryContext, input: StartNewRunInput): string {
  const { deps, runs, escalations } = ctx;
  const { imported, runId } = input;
  const compiled = compileOnce(input.scriptText);
  // 钳过的上界只算**一次**：它既要随 EngineConfig 落 dwf_run.caps_max_concurrency，也要作为
  // 注册表条目的间隙副本（journal 行出现之前 getTask / getRunDetail 唯一能读到的地方）。
  // 算两次就等于让两条读面在天花板变化的那一瞬间给出不同的数。
  const caps = ctx.caps(input.maxConcurrency);
  // 规范字符串形态（`providerId/modelId[$reasoningLevel]`）。端口收的是结构化选择，而 journal
  // 事件、两条读面与进度载荷要的都是一个字符串——在这里归一一次，下游全程搬运。
  const subagentModel =
    input.subagentModel === undefined ? undefined : formatModelPickerValue(input.subagentModel);

  // 发起锚点：修订沿用前驱、直接启动用显式值、聊天用活动轮，
  // 都没有就铸一个。引擎在建 run 那一世把它记成 run-launched。
  // 脚本声明的阶段表与本 run 的子代理模型和锚点并列合入：修订续跑沿用前驱的 inputId，
  // 却用**新脚本**的阶段表、也绝不继承前驱的模型，所以两者都不进 resolveLaunchAnchor。
  const launch: RunLaunch = {
    ...resolveLaunchAnchor({
      ...(input.launchInputId === undefined ? {} : { requested: input.launchInputId }),
      trace: input.trace,
      ...(deps.resolveLaunchInputId === undefined
        ? {}
        : { resolveLaunchInputId: deps.resolveLaunchInputId }),
      ...(imported === undefined
        ? {}
        : (() => {
            const predecessor = readRunLaunchAnchor(deps.journal, imported.resumedFrom);
            return predecessor === undefined ? {} : { predecessor };
          })()),
    }),
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // 子代理模型与阶段表并列同车（同样不进 resolveLaunchAnchor：修订绝不继承前驱的模型）。
    // 零 SQL——它活在这条事件里，`dwf_run` 上没有对应的列（刻意不做迁移）。
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // 脚本文件与子代理模型并列同车（同样不进 resolveLaunchAnchor：修订记的是新脚本的文件）。
    // 零 SQL——它活在这条事件里，`dwf_run` 上没有对应的列。
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(input.phaseAlongside === undefined ? {} : { phaseAlongside: input.phaseAlongside }),
  };

  // 注册必须先于启动：取消可能在 submit 返回后的任意时刻到达，而后台追踪器也会
  // 立刻开始轮询快照——注册表是「run 已存在」的唯一同步事实（journal 的 dwf_run 行
  // 要等引擎构造，晚若干个微任务）。
  const controller = new AbortController();
  // 活体控制面与 AbortController 同时造、同时进条目（见 RunRegistryEntry.control）：
  // 「停下这个 run」与「改这个 run 的一项设置」是同一刻就该可用的两条通道，而两者都要在
  // launch 之前存在——retune 可能在 submit 返回后的任意一个微任务里到达。
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    // 枚举面在 journal 行出现之前唯一能读到的项目键与标签来源（见 RunRegistryEntry）。
    cwd: input.cwd,
    ...(input.name === undefined ? {} : { name: input.name }),
    scriptText: input.scriptText,
    // 生效的并发上界（= 落库那一份）。同一条间隙论证：`AmendWorkflow` 的 resolveInput 读
    // getTask 判「沿用什么」，而修订一个刚起步的 run 恰好会落在这个间隙里。
    maxConcurrency: caps.maxConcurrency,
    // 子代理模型的间隙副本，与并发上界同规（见 RunRegistryEntry.subagentModel）。这里就是
    // 「结构化选择 → 规范字符串」的**唯一**归一点：记进 `run-launched` 的是它，两条读面与
    // `run-started` 载荷读到的也是它，所以格式不可能在三处之间分叉。
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // 脚本文件的间隙副本，与子代理模型同规（见 RunRegistryEntry.scriptPath）。
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(imported === undefined ? {} : { resumedFrom: imported.resumedFrom }),
    // 用量起点的间隙副本，与并发上界同规：journal 行落下之前，两条读面只能从条目读到用量，
    // 而修订一个刚起步的 run 恰好落在那几个微任务里——报 0 会让详情面说「这条 lineage 没花钱」。
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // 真正的结算 promise 在下面替换；先占位以满足类型（同步可见）。
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  // fire-and-forget：绝不在 submit 里 await 结算。submit 的契约是「启动并交出 runId」。
  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      caps,
      compiled,
      cwd: input.cwd,
      deps,
      // name 与 scriptText / cwd 同一条元数据路：launch → harness 原样转交 EngineConfig，
      // 引擎在 createRun 时落 dwf_run.name。service 侧刻意不做第二次 UPDATE 补写——那会
      // 造出 dwf_run 的第二个写入者（文件头不变式 1 的同一条论证）。
      ...(entry.name === undefined ? {} : { name: entry.name }),
      // 实参走同一条元数据路：launch → harness → EngineConfig（落 args_json）+ spawn
      // payload（注入沙箱的 args 全局）。内联脚本没有实参，字段整个缺席。
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
      escalationRegistry: escalations,
      control,
      runId,
      scriptText: input.scriptText,
      signal: controller.signal,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      // 会话静默探针回填到条目上：本 run 将来被修订时，那次 amend 要问它
      // （dynamic-workflow-import.ts 的 quietSessions）。三条入口都接，因为哪个 run 会成为
      // 前驱是将来才知道的事。
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // lineage 指针与缓存表成对下传（launch → harness → EngineConfig）：前者落 dwf_run
      // 的 resumed_from（createRun 一次写死），后者只活在本次执行里。
      ...(imported === undefined
        ? {}
        : { importedCache: imported.cache, resumedFrom: imported.resumedFrom }),
      // 用量起点走同一条路（launch → harness → EngineConfig）：引擎据它写 spent_tokens 的初值。
      ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
      // 子代理模型不单走一路：它就在 launch 里（见上面的 RunLaunch），随同一条 `run-launched`
      // 落 journal，launch 侧再从同一个对象里取出来解析成选择交给 actor runtime 工厂。
      launch,
    }),
  );

  return runId;
}
