// ============================================================
// AgentRuntime-backed WorkflowDriver（Boundary B）
// ============================================================
// 把 dynamic-workflow 引擎核心的向下副作用端口 WorkflowDriver 落到真实 ACode AgentRuntime 上：
// 每个 actor 一个**持久** child runtime（重复 executeTurn 累积 messageHistory），每次 ask 一次
// executeTurn，typed ask 的结果经会话级 WorkflowSubmitPort 桥接回引擎裁决。
//
// Boundary B 的另外两半——`executeWorldRead` 与 `executeArtifactPublish`——分别住在
// workflow-world-read.ts 与 workflow-artifact-publish.ts，本文件只做转发。两者与这里没有
// 共同状态（不碰会话、turn、submit 桥接），所以分开之后本文件只剩「会话与 turn 的编排」
// 这一件事。
//
// 三条时序（本文件的核心不变式）：
//   1. accept：模型调用 submit_result → handler 阻塞在 port.respond → 本 driver 上报
//      askSubmitAttempted → 引擎校验通过 → respondToSubmit(accept) → 解开 deferred 为 {accept:true}
//      → handler 返回成功（挂 turnControl 停 turn）→ executeTurn resolve → 只上报 askStats（不再上报
//      askTurnEnded，因为该 ask 已被引擎结算）。
//   2. reject（同 turn 内修复）：respondToSubmit(reject, violations) → 解开 deferred 为
//      {accept:false, violations} → handler 抛错 → error tool_result（无 turnControl）→ 同一 turn 继续
//      → 模型重试 → 又一次 respond → 又一次 deferred。repair 预算耗尽时引擎改调 cancelAsk。
//   3. nudge（turn 结束未提交）：executeTurn resolve 且未 accept → 上报 askTurnEnded → 引擎决定 nudge
//      → respondToSubmit(nudge)（此时**无** parked deferred，turn 已结束）→ 在同一持久 runtime 上发起
//      一次**全新** executeTurn（nudge 提示）。
//
// 三值→二值裁决映射（引擎 SubmitVerdict 三值；contracts WorkflowSubmitPort 二值）：
//   accept → {accept:true}；reject → {accept:false, violations}（Violation 1:1 映射）；nudge → 无 deferred，
//   起新 turn。见 respondToSubmit。
//
// 第四条时序（升级问答）与上面三条**同层**：
//   4. escalate：模型调用 escalate → handler 阻塞在 escalatePort → driver 铸 qid、停驻 deferred、
//      把问题登记进升级注册表，并双轨发出 escalation-raised（journal + emit）→ 主代理经 run
//      service 的 resolveQuestion 查表 → driver.respondToEscalation 解开 deferred 并发出
//      escalation-resolved → 工具结果 = 答案文本 → actor 的轮次就地继续，ask 照常 settle。
//      引擎核心对此**零感知**：升级发生在 driver 执行 ask 的边界内（与 repair/nudge 轮次同层），
//      不写 dwf_node 行。逃生舱是 cancelAsk——它连同停驻的升级 deferred 一起拒绝。
//
// amend-resume 给本文件加了两件 driver 私有的事，两件都只
// 关乎会话转录，所以机制住在 workflow-actor-transcript.ts，这里只做编排（编排的三个实现体在
// workflow-driver-transcript.ts）：
//   - **ask 边界记账**：一次交换（含 repair / nudge 轮与 submit 之后的收尾消息）结束后，把该 actor
//     会话已落库的消息条数写进这个 ask 的 journal 行。每个 ask 都写——任何 run 都是未来修订的
//     潜在前驱。
//   - **转录截断**：`createActorSession` 带种子时，把源会话的前 N 条消息复制进新铸的会话再重水化。
// 本轮又多了第三件，同样只关乎转录、同样住在自己的模块（workflow-driver-quiescence.ts）：
//   - **会话静默登记**：dispose 时记下每个会话是否还有在写的 turn。修订一个在飞前驱时，amend
//     要据它判断「此刻数出来的消息条数可不可信」，才谈得上接续那条未完的 ask。
//
// W1-R3 max-lines 例外偿还：时序 1-3 的会话侧编排（铸造 / 派发 / 裁决回送 / 取消）拆到
// driver-ask-bridge.ts，turn 派发之后的生命周期（resolve / reject 分支）拆到
// driver-turn-lifecycle.ts；两条时序线的第四件（升级问答）早已住在 workflow-driver-escalation.ts。
// 本文件只剩装配（宿主面构造）与薄委托；公开面不变。
//
// 时序 1-3 的实现体注释随迁两个叶子文件；完整时序论证仍以本文件头为准。
// 时序 4 的实现体注释随迁 workflow-driver-escalation.ts。

import {
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@acode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { executeWorldRead } from "./workflow-world-read.js";
import {
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import type { ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  createActorSessionQuiescence,
  releaseActorSessions,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";
import {
  respondToParkedEscalation,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import type { SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import {
  cancelSessionAsk,
  createActorSessionState,
  respondToSessionSubmit,
  startSessionAsk,
  type AskBridgeHost,
} from "./driver-ask-bridge.js";
import { runActorTurn, type TurnLifecycleHost } from "./driver-turn-lifecycle.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * WorkflowDriver 的真实实现。构造经 {@link createAgentRuntimeWorkflowDriver}（绑定 deps，回填 sink）。
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → 其所属会话，供 respondToSubmit / cancelAsk 反查。 */
  private readonly instanceToSession = new Map<string, SessionState>();
  /** qid → 停驻它的会话，供 respondToEscalation 反查（与 instanceToSession 同族）。 */
  private readonly qidToSession = new Map<string, SessionState>();
  /** per-run 单调的升级序号；qid 的第二段。与 runId 一起构成无碰撞的 id。 */
  private escalationSeq = 0;
  /** dispose 幂等门（引擎契约是恰好一次，但门在这里更便宜也更稳）。 */
  private disposed = false;
  /** 本 run 对治理器 cap 变化的订阅（run 级一次，dispose 时退订）。 */
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * 交给升级桥接（workflow-driver-escalation.ts）的宿主面：两张表按引用共享，序号与 record
   * 经闭包回到本类——私有状态不外露，桥接函数也不需要知道类的形状。
   */
  private readonly escalationHost: EscalationHost;
  /** 交给模型侧失败收容（workflow-driver-model-failure.ts）的宿主面：同一套按引用共享的思路。 */
  private readonly modelFailureHost: ModelFailureHost;
  /** 交给 submit 桥接（workflow-driver-submit-bridge.ts）的宿主面：同上，两样都按引用共享。 */
  private readonly submitHost: SubmitBridgeHost;
  /** run 级 stall 时钟：所有 actor 的成功 / 重试节拍汇到这一只表。 */
  private readonly stallClock: RunStallClock;
  /**
   * 会话静默账（workflow-driver-quiescence.ts）：dispose 那一刻每个会话还有没有在写的 turn。
   * 唯一的读者是 amend——接续前驱的在飞 ask 之前它要确认那个会话已经写完了。
   */
  private readonly quiescence: ActorSessionQuiescenceLedger;
  /**
   * 交给 ask 桥接（driver-ask-bridge.ts）与 turn 生命周期（driver-turn-lifecycle.ts）的宿主面：
   * 同一份私有状态的引用合在一个对象里，两条时序线各取所需。runTurn 是对本类方法的懒自引用，
   * 调用时才求值，不构成构造期环。
   */
  private readonly methodHost: AskBridgeHost & TurnLifecycleHost;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // 引擎的 record() 对**每一条**事件都紧接着调 driver.emit（engine.ts），所以这里是 driver
    // 看得见 ask 终点的唯一一处：`node-settled` 是三条结算路（settleOk / settleFailed /
    // abortInFlight）共同的出口，也就是座位闸门等的那条「这一位不工作了」。
    //
    // 为什么不用 driver 自己的状态判：`state.currentInstance` 从不清空，untyped ask 经
    // askTurnEnded 在引擎侧结算之后 `live()` 仍然为真——照它腾座位就永远腾不掉，FIFO 会死等。
    //
    // 递下去的**必须是同一个对象引用**：launch 侧的 sequence 截取按引用相等核对序号
    // （dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.submitHost = { sessions: this.sessions, sink };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    // 探针在**构造时**就交出去：run service 要在条目上挂住它，而 amend 可能在这个 run 生命的
    // 任意一刻到来。dispose 之后才交就晚了——那时 service 已经在数会话了。
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
      // 扇出只到在该 key 上有在飞/排队请求的 run，所以订阅本身可以在构造时一次做完。
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
    this.methodHost = {
      deps,
      escalationHost: this.escalationHost,
      instanceToSession: this.instanceToSession,
      modelFailureHost: this.modelFailureHost,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
      sessions: this.sessions,
      sink,
      stallClock: this.stallClock,
      submitHost: this.submitHost,
    };
  }

  async createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    return createActorSessionState(this.methodHost, actor, persona, seed);
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    startSessionAsk(this.methodHost, session, instance, message);
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    respondToSessionSubmit(this.methodHost, instance, verdict);
  }

  cancelAsk(instance: InstanceRef): void {
    cancelSessionAsk(this.methodHost, instance);
  }

  /**
   * run 结算后的资源释放（引擎在 run-settled 之后恰好调一次，见 WorkflowDriver.dispose）。
   *
   * 对每个 actor runtime 跑 app 关会话的**同一条**链——`closeBrowserSession` 内部依次
   * beginShutdown、node_repl 会话释放、浏览器会话关闭；不另造一套子代理关闭链，那会漂移。
   * 不关 execution / MCP / session store：子代理不拥有它们。有在飞 turn 的会话等它落地再关
   * （见 SessionState.turn）；关闭失败只 warn，结算不因它抛。三张表随之清空。
   *
   * 本方法**同步**，而且刻意不等在飞 turn——引擎的契约是结算之后立刻释放资源。代价是
   * 「结算 promise 已解决」不蕴含「被中止的 turn 已经把尾巴写完」，所以释放的同时把每个会话
   * 此刻的在飞 turn 记进静默账：amend 随后据它判断哪个会话的消息条数可信。两件事的编排在
   * {@link releaseActorSessions}（workflow-driver-quiescence.ts 的文件头写了完整论证）。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    releaseActorSessions(this.deps, this.sessions.values(), this.quiescence);
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  /**
   * 结算一个停驻中的升级问答（run service 经注册表调进来）。实现体在
   * workflow-driver-escalation.ts（{@link respondToParkedEscalation}），这里只做委托。
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /**
   * 世界读取：整段委托给 {@link executeWorldRead}（workflow-world-read.ts）。
   *
   * 这里只做转发，是因为世界读取与本文件的其余部分**没有共同状态**：它不碰 actor 会话、
   * 不碰 turn、不碰 submit 桥接，只需要三样东西（两个端口加一个 cwd）。分出去之后本文件
   * 只剩"会话与 turn 的编排"这一件事，而 op 元数、上限执行、git 的固定 argv 集中在一处。
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    return await executeWorldRead(
      { ...this.deps, ...(signal === undefined ? {} : { signal }) },
      op,
      args,
    );
  }

  /**
   * 用户面产物的发布：整段委托给 {@link executeArtifactPublish}（workflow-artifact-publish.ts），
   * 理由与上面的世界读取逐字相同——它与本文件没有共同状态，只需要两个端口、一个 cwd 与
   * 一个会话 id。
   *
   * 方法在 Boundary B 上是**可选**的（`executeArtifactPublish?`），而本 driver 恒实现它：
   * 「有没有存储」是装配事实，由 deps 里的 `artifactStore` 表达并在那一侧大声失败，不该由
   * 「方法在不在」这条第二条通道再表达一次（两条通道会给同一件事两种失败形态）。
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    return await executeArtifactPublish(this.deps, request);
  }

  // ——————————————————————————————— 内部：turn 派发 ———————————————————————————————

  private runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    runActorTurn(this.methodHost, state, instance, input, epilogueStart);
  }

  /**
   * 一条 driver 侧事件的双轨落地：durable 进 `dwf_event`，实时经 emit 扇出。
   *
   * 与引擎的 `record()`（engine.ts）逐字节同形，且顺序不可换：launch 侧的 sequence 截取靠
   * 「appendEvent 之后同步紧接着 emit、同一个事件对象引用」这个前提把刚分配到的 sequence 交给
   * emit（dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * 造一个绑定了 deps 的 driver 工厂，直接充当 harness 的 makeDriver。journal 与 emit 由 deps 提供，
 * 调用方（测试/生产）持有其引用以做断言与 Boundary C 扇出。
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
