// ============================================================
// AgentRuntime-backed WorkflowDriver：ask 生命周期桥接（时序 1-3 的前半）
// ============================================================
// workflow-driver.ts 偿还 W1-R3 max-lines 例外：把三条核心时序在「会话侧」的编排——会话铸造、
// ask 派发、submit 裁决回送、ask 取消——拆到本文件成自由函数；driver 类上只留薄薄的委托。
// 公开面不变，仍从 workflow-driver.ts 导出（工厂与 mintActorSessionId 留在原文件）。
//
// 对 driver 状态的全部触碰都经 {@link AskBridgeHost} 显式递进来（会话表、反查表、升级/提交宿主面、
// stall 时钟、以及在同一会话上再起一轮 turn 的回调），本文件不持有任何自己的状态——
// 原方法体逐字保留，只把 `this.` 换成 `host.`。
//
// 三条时序（workflow-driver.ts 文件头有完整版）在这里的落点：
//   1. accept：startSessionAsk 派出 turn（时序的 2/3 在 driver-turn-lifecycle.ts）。
//   2. reject：respondToSessionSubmit 解开同一 deferred。
//   3. nudge：respondToSessionSubmit(nudge) 经 host.runTurn 起一轮全新 turn。

import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type AskMessage,
  type InstanceRef,
  type PersonaSpec,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowReportSink,
} from "@acode/dynamic-workflow";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { createActorModelActivity, type RunStallClock } from "./workflow-driver-concurrency.js";
import {
  makeSessionEscalatePort,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  mapViolations,
  mintActorSessionId,
  schemaEpilogue,
} from "./workflow-driver-helpers.js";
import { makeSessionSubmitPort, type SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import { seedActorSession } from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * driver 交给 ask 桥接的宿主面。除两个闭包回调外全是私有状态的**引用**（不是副本）：
 * `sessions` / `instanceToSession` 就是类里的那两张表，`escalationHost` / `submitHost` 是同一批
 * 宿主对象（引用相等），`runTurn` 回到类的 turn 编排（driver-turn-lifecycle.ts）。
 */
export interface AskBridgeHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly escalationHost: EscalationHost;
  readonly instanceToSession: Map<string, SessionState>;
  /** 在同一持久 runtime 上再起一轮 turn（startAsk / nudge 共用）。
   * 懒自引用：构造时以闭包回到类方法，调用时 `this` 才求值，不构成初始化期环。 */
  runTurn(state: SessionState, instance: InstanceRef, input: string, epilogueStart: number): void;
  readonly sessions: Map<string, SessionState>;
  readonly sink: WorkflowReportSink;
  readonly stallClock: RunStallClock;
  readonly submitHost: SubmitBridgeHost;
}

/**
 * 为一个 actor 铸造持久会话（原 {@link AgentRuntimeWorkflowDriver.createActorSession} 方法体）。
 */
export async function createActorSessionState(
  host: AskBridgeHost,
  actor: ActorRef,
  persona: PersonaSpec,
  seed?: ActorSessionSeed,
): Promise<SessionRef> {
  const sessionId = mintActorSessionId(host.deps.runId ?? "run", actor);
  // resume 会话身份互证：journal 的 dwf_actor.session_id 是**记录**，铸造函数才是权威
  // （按 (runId, actorRef) 纯确定，重挂时必然铸出同一个 id）。两者不一致只可能是铸造规则
  // 漂移（改名/第二处实现）——后果是重水化读错会话、详情页打开不存在的会话，离成因很远，
  // 所以在重挂的第一步就大声失败，携结构化 mismatch（与两个哈希不匹配错误同形）。
  const journaled = host.deps.journal.getActor(
    host.deps.runId ?? "run",
    actor.siteId,
    actor.ordinal,
  )?.sessionId;
  if (journaled !== undefined && journaled !== sessionId) {
    throw new WorkflowError(
      "DriverError",
      `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
        `id and the minted one differ.`,
      { mismatch: { expected: journaled, got: sessionId } },
    );
  }
  const ref: SessionRef = { id: sessionId };
  // 会话级 submit 端口（实现体在 workflow-driver-submit-bridge.ts，与紧随其后的升级端口
  // 逐条对称）：closure 绑定本会话，模型无法覆盖路由身份（instance 取自 currentInstance）。
  const submitPort = makeSessionSubmitPort(host.submitHost, sessionId);
  // 升级端口同构：同样按会话 closure 绑定，同样恒注入（见 ActorRuntimeFactory 的字段注释）。
  // persona 一并入 closure：有效名是**冻结**的（引擎在 createActor 时定下，此后不变），
  // 所以在这里算一次比每次 escalate 现查便宜，也不会中途换名。
  const escalatePort = makeSessionEscalatePort(host.escalationHost, sessionId, actor, persona);
  // 模型活动面：准入端口随 runtime deps 下传（runner 每次尝试先过闸门），
  // waiting / executing 观察只在有在飞 ask、且它还没被引擎结算/取消时上报——迟到的观察对一个
  // 已完结的 ask 没有意义，引擎侧也会再挡一次。state 在下面才建，所以经 closure 晚绑定。
  let state: SessionState | undefined;
  const live = (): InstanceRef | undefined =>
    state === undefined ||
    state.currentInstance === undefined ||
    state.accepted ||
    state.cancelled
      ? undefined
      : state.currentInstance;
  const modelActivity = createActorModelActivity({
    port: host.deps.concurrency,
    runId: host.deps.runId ?? "run",
    live,
    // 座位闸门按 **actor** 键入（不是 ask 实例）：per-actor FIFO 保证一个 actor 至多一个在飞
    // ask，所以「工作中的子代理」与「在飞的 ask」是同一个计数，而准入端口本就是按 actor 会话
    // 造的。
    ...(host.deps.seatGate === undefined
      ? {}
      : { seat: { gate: host.deps.seatGate, key: refToString(actor) } }),
    handlers: {
      // 子代理的第一笔工作区写入 ⇒ 引擎关导入缓存。
      onMutating: (instance) => host.sink.askMutating(instance),
      onWaiting: (info) => {
        const instance = live();
        if (instance !== undefined) host.sink.askWaiting(instance, info);
      },
      onExecuting: () => {
        const instance = live();
        if (instance !== undefined) host.sink.askExecuting(instance);
      },
      // run 级 stall 时钟的两个节拍：任一 actor 的成功归零、任一重试上膛。
      onRequestCompleted: () => host.stallClock.noteSuccess(),
      onRetryScheduled: (reason) => host.stallClock.noteRetryScheduled(reason),
    },
  });
  // submit profile：按 actor **站点**查——同一站点
  // 的每个 ordinal（fan-out 的每条 lane）跑的是同一组 ask 站点，profile 自然相同。缺席 = generic。
  const submitProfile =
    host.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
  // await：生产工厂在返回前把会话落库并建 task link（FK 要求 session 行先存在）。
  // 引擎的 ensureSession 会 await 本方法，所以第一次 ask 派发前持久化已完成。
  const runtime = await host.deps.runtimeFactory({
    sessionId,
    actor,
    persona,
    submitPort,
    submitProfile,
    escalatePort,
    ...(seed === undefined ? {} : { seed }),
    ...(modelActivity.admission === undefined
      ? {}
      : { modelRequestAdmission: modelActivity.admission }),
  });
  if (seed !== undefined) {
    await seedActorSession(host.deps, {
      journaledSessionId: journaled,
      runtime,
      seed,
      sessionId,
    });
  }
  state = {
    ref,
    sessionId,
    runtime,
    submitProfile,
    currentTyped: false,
    accepted: false,
    cancelled: false,
    turnGeneration: 0,
    pendingEscalations: new Map(),
    escalationsUsed: 0,
    modelActivity,
    actor,
    actorName: effectiveActorName(persona),
    transientAttempts: 0,
  };
  modelActivity.observe(runtime, sessionId);
  host.sessions.set(sessionId, state);
  return ref;
}

/**
 * 派发一次 ask（原 {@link AgentRuntimeWorkflowDriver.startAsk} 方法体）。
 */
export function startSessionAsk(
  host: AskBridgeHost,
  session: SessionRef,
  instance: InstanceRef,
  message: AskMessage,
): void {
  const state = host.sessions.get(session.id);
  if (state === undefined) {
    // 理论不会发生（引擎先建会话再 ask）；归一成 DriverError 上报而非静默。
    host.sink.askFailed(
      instance,
      new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
    );
    return;
  }
  // 上一个 ask 若在异常路径上留下了停驻项（turn 被 abort 之外的方式打断），在这里一并撤下：
  // 新的 ask 一旦开跑，那些问题就再也不会有人读答案了，留在注册表里只会让快照说谎。
  withdrawSessionEscalations(host.escalationHost, state);
  state.currentInstance = instance;
  state.currentTyped = message.typed;
  state.accepted = false;
  state.cancelled = false;
  state.pendingSubmit = undefined;
  // per-ask 预算归零（nudge 走的是 runTurn，不经这里——nudge 仍在同一个 ask 里）。
  state.escalationsUsed = 0;
  state.abortController = new AbortController();
  // 上一个 ask 的 waiting / executing 相位、工具计数都不能带到这个 ask 上；瞬态重驱计数同理。
  state.modelActivity.reset();
  // ask 的起点喂给座位闸门（终点在 emit 里认 `node-settled`）：从这一刻起这个子代理算"在工作"，
  // 它的下一个 turn step 因此要过座位。同一个 actor 连着接到下一个 ask 时这是幂等的加入——
  // 它本来就一直在工作，中途没有空过。
  host.deps.seatGate?.askStarted(refToString(state.actor), instance);
  state.transientAttempts = 0;
  state.cancelRedrive?.();
  state.cancelRedrive = undefined;
  host.instanceToSession.set(refToString(instance), state);

  // 质量尾注对 typed / untyped 一视同仁；schema 尾注只有 typed 有。两段都在 scheduler 算完
  // inputHash 之后追加，所以不进缓存身份。
  // typed ask 的 schema 尾注按 submit profile 分叉：mono 子代理的 schema 已在工具声明里，尾注只剩
  // 一句；generic 子代理照旧把整份 schema 写进尾注。守卫先跑：静态 profile 与这次 ask 不符时它会
  // 把会话降成 generic（或让 ask 失败），下面读到的就是修正后的形态。
  if (message.typed && !ensureSubmitProfileFits(host.deps, host.sink, state, instance, message)) {
    return;
  }
  const input = message.typed
    ? `${message.instructions}${qualityEpilogue(message.schema)}${
        state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
      }`
    : `${message.instructions}${qualityEpilogue(undefined)}`;
  // 尾注边界：GUI 据此把尾注折进披露。指令正文
  // 之后全是引擎文本，边界就是正文长度；模型收到的仍是全文，持久 text part 也是。
  // fire-and-forget：绝不在 startAsk 内 await turn 完成（Boundary B 契约）。
  host.runTurn(state, instance, input, message.instructions.length);
}

/**
 * 把引擎对一次 submit 的裁决送回会话（原 {@link AgentRuntimeWorkflowDriver.respondToSubmit} 方法体）。
 */
export function respondToSessionSubmit(
  host: AskBridgeHost,
  instance: InstanceRef,
  verdict: EngineSubmitVerdict,
): void {
  const state = host.instanceToSession.get(refToString(instance));
  if (state === undefined) return;
  switch (verdict.kind) {
    case "accept": {
      // 标记 accept：该 ask 的 turn resolve 时不再上报 askTurnEnded（引擎已 settleOk）。
      state.accepted = true;
      const deferred = state.pendingSubmit;
      state.pendingSubmit = undefined;
      deferred?.resolve({ accept: true });
      return;
    }
    case "reject": {
      // 同 turn 内修复：handler 收到 {accept:false} 会抛错 → error tool_result → 模型重试。
      const deferred = state.pendingSubmit;
      state.pendingSubmit = undefined;
      deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
      return;
    }
    case "nudge": {
      // turn 已结束、无 parked deferred：在同一持久 runtime 上发起一次全新 turn 促其提交。
      // nudge 整条都是引擎文本：边界 0。
      host.runTurn(state, instance, NUDGE_PROMPT, 0);
      return;
    }
  }
}

/**
 * 取消一个在飞 ask（原 {@link AgentRuntimeWorkflowDriver.cancelAsk} 方法体）。
 */
export function cancelSessionAsk(host: AskBridgeHost, instance: InstanceRef): void {
  const state = host.instanceToSession.get(refToString(instance));
  if (state === undefined) return;
  // 引擎主动取消（repair/nudge 预算耗尽、run 取消/失败）：中止在飞 turn，并解开可能挂起的 submit
  // deferred，避免 handler 永久阻塞；标记 cancelled 使 turn reject 不再上报 askFailed。
  state.cancelled = true;
  const deferred = state.pendingSubmit;
  state.pendingSubmit = undefined;
  deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
  // 停驻中的升级问答与 submit deferred **同待遇**：一并拒绝，否则 `escalate` handler 会在一个
  // 已被取消的 ask 里永久阻塞。这条正是「无答案 = 无限期阻塞」的逃生舱（按设计不设超时）：
  // run cancel 与 CLI 进程亡故的行为因此与今天逐字节一致——ask 拒 Cancelled、run 转
  // Interrupted，resume 后该 ask 重跑、actor 重新提问并得到新 qid。
  withdrawSessionEscalations(host.escalationHost, state);
  // 退避等待中的重驱一并撤下：ask 已被引擎结算，再起一轮只会对着一个没人听的节点烧 token。
  state.cancelRedrive?.();
  state.cancelRedrive = undefined;
  state.abortController?.abort(new Error("workflow ask cancelled"));
}
