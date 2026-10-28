// ============================================================
// dynamic-workflow run service · launch 半边（执行）
// ============================================================
// 把「启动一个 run」的执行编排装进 launchDynamicWorkflowRun：submit（新跑/修订）与
// resume（崩溃恢复）两条入口都汇到这里——见 dynamic-workflow-run-submit.ts 与 run service
// 的文件头。本文件只做执行编排；注册表、入口编排、事件扇出归 run service。
//
// 本文件持有两件事：
//   - launchDynamicWorkflowRun：装配 sequence 截取 → emit 钩子 → 真实 driver →
//     runWorkflowScript（本包对引擎的唯一调用点）；
//   - 子进程入口辅助：dynamicWorkflowChildSpawn（供 snippet 服务在 SEA 下找宿主）。
// 事件映射（RunEvent → 协议事件/进度载荷）在 dynamic-workflow-launch-event-adapter.ts，
// actor 会话接线在 dynamic-workflow-launch-actor-session.ts；两者经本文件再导出，
// 既有消费者的导入路径保持稳定。
//
// 两个不变式（见 run service 文件头）：
//   - launch 是 runWorkflowScript 的唯一调用点，submit 与 resume 汇到这里；
//   - runtimeFactory 是唯一的 runtime 装配点。
//
// 类型面（CompiledDynamicWorkflowScript / LaunchDynamicWorkflowRunInput）住在
// dynamic-workflow-launch-input.ts。
//
// 变更纪律：只动 launch 的执行编排；submit/resume/事件的改动去各自的半边。

import { ACODE_DWF_CHILD_COMMAND, type SessionId } from "@acode/contracts";
import { parseModelPickerValue } from "@acode/shared/model-selection";
import {
  validate,
  type JsonSchema,
  type RunSettlement,
  type ValidateFn,
} from "@acode/dynamic-workflow";
import { runWorkflowScript } from "@acode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import {
  readRunLaunchAnchor,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { LaunchDynamicWorkflowRunInput } from "./dynamic-workflow-launch-input.js";
import {
  attachActorSession,
  journalActorResolvedModel,
  persistActorSession,
  pinnedActorModel,
  requireActorModelSelection,
} from "./dynamic-workflow-launch-actor-session.js";
import {
  toProgressPayload,
  toProtocolEvent,
} from "./dynamic-workflow-launch-event-adapter.js";

/** 适配包内校验器到引擎的 ValidateFn 契约（launch 是 runWorkflowScript 的唯一调用点）。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

export type {
  CompiledDynamicWorkflowScript,
  LaunchDynamicWorkflowRunInput,
} from "./dynamic-workflow-launch-input.js";
export { journalActorResolvedModel };
export { toProgressPayload, toProtocolEvent };

/**
 * 启动（或恢复）一个 run：装配 sequence 截取 → emit 钩子 → 真实 driver → runWorkflowScript。
 * fire-and-forget 语义由调用方决定（本函数只返回结算 promise，不做注册表簿记）。
 */
export function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    control,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  const childSpawn = dynamicWorkflowChildSpawn();
  // 本 run 自己上界的**第二个**执行点：调度器管「还能不能再派一个 ask」，闸门管「已经在跑的那些下一次请求能不能发出去」。
  // 起点就是这次启动的 caps（submit 是钳过的请求值，resume 是 journal 行里的那一份），所以一个
  // 从未被 retune 过的 run 永远走闸门的快路径——不发事件、不持票、与从前逐字相同。
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  control?.bindSeatGate(seatGate);
  // 锚点：submit 给的（本次建 run）或 journal 里的（resume）。升级前的 run 两边都没有 → 缺席，
  // 进度事件不带 launchInputId，子代理不上报。
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // lineage 指针：submit/amend 路径由入参给出；resume 路径入参缺席（createRun 早已写死），从
  // journal 行读回——两条路径的 `run-started` 载荷因此同形。
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // 并发天花板：`run-started` 载荷的第二个宿主派生字段。每次 launch 算一次而不是每条事件算
  // 一次——它是进程事实，一个 run 跑到一半核数不会变，而 `availableParallelism()` 是系统调用。
  const concurrencyCeiling = resolveWorkflowConcurrencyCeiling(deps.availableParallelism);
  // 子代理模型：submit 给的（随锚点同车）或 journal 里的（resume 从同一条 run-launched 读回）。
  // 与锚点同一条论证，两条路径因此同形；升级前的 run 两边都没有 → 缺席 = 跑在会话模型上。
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // 字符串 → 选择，每次 launch 解析一次。进度载荷走原串（下面的 toProgressPayload），
  // actor runtime 工厂要的是结构化选择（含 reasoning 档位，pin 的两段身份带不回来）。
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);

  // 事件的 journal sequence 只有 appendEvent 知道，而引擎在 record() 里
  // `journal.appendEvent(...)` 之后**同步**紧接着 `driver.emit(...)`，并丢掉了返回的
  // StoredEvent（engine.ts）。所以这里包一层 journal 把分配到的 sequence 截下来：
  // emit 拿到的一定是刚才那一条。替代方案都更差——本地自增计数器会在 resume（sequence
  // 从既有最大值续下去）时整体偏移，而每条事件回查一次 journal 是白付一次 IO。
  // 「append 紧跟 emit、一一对应」这个前提由测试钉住：钩子看到的 sequence 序列必须与
  // listEvents 返回的逐条相等。
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // 事件扇出绝不能把 run 打挂：钩子是观察者，异常吞在此边界并记日志。
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling,
            ...(subagentModel === undefined ? {} : { subagentModel }),
          }),
          // 路由与载荷分开：事件必须落在**发起该 run 的**会话里，而 parentSessionId 是
          // 判断"是不是那个会话"的唯一依据。
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    signal,
    escalationRegistry,
    cwd,
    // 用户面产物的落点。会话作用域取**本服务
    // 的**父会话（= 本 app 的会话）而不是 launch 入参里那个可选的 parentSessionId：两者在
    // 生产里同值（run start 传的就是 runtime 自己的 sessionId），但只有前者是必填的，而
    // 「字节写进哪个会话的目录」不该有一条 undefined 的分支。store 缺席时整对都不传，
    // driver 侧因此以 ArtifactStoreUnavailable 大声拒绝。
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    declaredRunCommands: compiled.declaredRunCommands,
    // 每个 actor 站点拿哪一种 submit_result（typed / generic / 无），编译期已定。
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // 边界记账与种子复制都要读写 actor 会话的消息（driver 侧，见 workflow-driver.ts 的文件头）。
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // 进程级并发治理器的窄端口：在场时 driver 给每个
    // actor runtime 一个请求级准入端口（下面 runtimeFactory 原样下传）；缺席即 actor 不受闸门约束。
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // 本 run 的座位闸门：driver 把每个 actor 的准入端口包进它，并把 ask 的起止喂给它
    // （startAsk 与引擎的 `node-settled`）。
    seatGate,
    // 测试注入的 driver 时钟（故障矩阵）；生产缺席，driver 走真时间。
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    // 会话静默探针的回填口（见入参字段注释）：driver 在构造时调一次。
    ...(input.onQuiescenceProbe === undefined
      ? {}
      : { onQuiescenceProbe: input.onQuiescenceProbe }),
    runtimeFactory: async ({
      sessionId,
      actor,
      persona,
      escalatePort,
      seed,
      submitPort,
      submitProfile,
      modelRequestAdmission,
    }) => {
      const runtime = deps.createActorRuntime({
        runId,
        sessionId,
        actor,
        persona,
        submitPort,
        // 工厂据 profile 决定端口是否注入、声明是否 typed（create-app.ts 的 createActorRuntime）。
        submitProfile,
        // 请求级准入端口与两个工具端口同路下传到 runtime deps。
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // 升级端口与 submit 端口同路下传：core 侧的注册门以端口存在为准，所以恒传。
        escalatePort,
        // resume 的 pin：这个 actor 上一次跑在哪个模型上。必须在**造 runtime 之前**读，
        // 因为下面那行 journalActorResolvedModel 会把这一轮的解析结果写回同一个字段。
        //
        // 种子带来的 pin 是**承袭**（amend-resume）：修订 run 的第一次派发时本 run 的 journal 还
        // 没有解析结果，pin 只能来自前驱——转录接续下静默换模型正是 pin 要防的身份突变。两者都在
        // 场（修订 run 崩溃后 resume）时以本 run 的记录为准：那是这个 actor 在**这个 run 里**实际
        // 跑过的模型，比前驱的更具体，且两者本就应当相等。畸形 pin 的大声失败沿用既有那一套
        // （workflow-actor-model.ts 的 WorkflowActorPinnedModelError），此处不分叉。
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // 本 run 的子代理模型：在 pin **之上**（workflow-actor-model.ts 的优先级表）。它是用户对
        // 这一次 run 的显式表态（AmendWorkflow 带 subagent_model 就是「resume 时换模型」的那个显式
        // 决定），pin 只守没有它时的隐式缺省。与 pin 不同，它整条带着 reasoning 档位下去——
        // journal 的 pin 只记身份两段。
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
      });
      // persona 的模型档位实际解析成了哪个模型，只有造好的 runtime 说得准（档位映射见
      // workflow-actor-model.ts）。先落库再接入会话：一次失败的会话持久化会让这次 ask 失败，
      // 但「当时选了哪个模型」这条审计事实照旧留在 journal 里。rehydrate 路径也要写——
      // pin 缺席（升级前的旧 run）时这一轮才是第一次有解析结果可记。
      journalActorResolvedModel({
        actor,
        journal: deps.journal,
        selection: requireActorModelSelection(runtime, actor),
        runId,
      });
      const attached = await attachActorSession({
        actor,
        deps,
        runId,
        runtime,
        sessionId,
      });
      if (attached === "rehydrated") return runtime;
      await persistActorSession({
        actor,
        deps,
        parentSessionId,
        runId,
        runtime,
        sessionId,
      });
      return runtime;
    },
  });

  return runWorkflowScript({
    askSpecs: compiled.askSpecs,
    caps,
    // SEA 下必须换 spawn 策略，非 SEA 一律不传。
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // 入口文件写不进项目 `.acode/` 时 harness 回落到 OS 临时目录并报一声——run 照常启动，
    // 但这条日志是排查「项目里为什么没有 workflow-runs 存档」的唯一线索。
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name 与 scriptText 同一条元数据路：harness 原样转交 EngineConfig（resume 时 journal
    // 命中短路 createRun，传它无害且保持 submit/resume 两条 launch 输入同形）。
    ...(name === undefined ? {} : { name }),
    // 实参与 name / scriptText 同一条元数据路，但多一个去处：harness 既转交 EngineConfig
    // （落 args_json），也放进 spawn payload 注入沙箱。
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(deps.ownerGeneration === undefined ? {} : { ownerGeneration: deps.ownerGeneration }),
    ...(deps.ownerToken === undefined ? {} : { ownerToken: deps.ownerToken }),
    runId,
    // 落库的是作者原文与它的哈希，不是 lowered 函数体（resume 的比对基准是原文）。
    scriptHash: compiled.scriptHash,
    scriptText,
    // 关联锚点随 run 落库：重启后工具卡 join 与 resume 通知都只能从 dwf_run 还原它。
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // 修订续跑：lineage 指针落库（createRun 一次写死），导入缓存注入引擎（纯数据，核心零 I/O）。
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // 用量起点与缓存同车：引擎在 createRun 时把它写成 spent_tokens 的初值，命中既有行时忽略。
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // 锚点只在建 run 那一世落 journal（引擎侧的门），resume 时传它无害。
    ...(launch === undefined ? {} : { launch }),
    signal,
    // 控制面与 signal 同一条缝：那个是「停下这个 run」，这个是「改这个 run 的一项设置」。
    // harness 在引擎构造好的同一同步片里 bind（harness.ts），所以 run 从第一条事件起就可被改。
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
}

/**
 * 沙箱子进程的 spawn 策略：SEA 下走隐藏子命令自 re-exec，否则不表态（harness 缺省
 * `node --max-old-space-size=… <entry>`）。
 *
 * SEA 单文件二进制不解释 Node CLI 旗标，harness 缺省 argv 里的
 * `--max-old-space-size` 会原样落进 CLI 的严格 parseArgs，子进程立即报错退出——**SEA 下每一个
 * workflow run 必然失败**。修法与 official plugin host 同款
 * （official-plugin-runtime.ts 的 `officialPluginHostPrefixArgs`）。
 *
 * SEA 判定留在 bootstrap 而不下沉到 harness：harness 是 app-free 的（只依赖
 * `@acode/dynamic-workflow` 与 node 内建），既拿不到 contracts 的子命令常量，也不该知道
 * 自己被哪种宿主打包。`isSea` 可注入只为可测——默认探针在测试进程里必然返回 false，
 * 于是「非 SEA 不得带 argsPrefix」也是一条可断言的事实。
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [ACODE_DWF_CHILD_COMMAND] } : undefined;
}

/** SEA 运行时探针（official-plugin-runtime.ts 私有同名 helper 的本地镜像，刻意不跨文件复用）。 */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}
