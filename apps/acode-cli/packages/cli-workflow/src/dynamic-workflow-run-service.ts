// ============================================================
// Dynamic Workflow Run Service（DynamicWorkflowRunPort 的生产实现）
// ============================================================
// 本服务负责：
// 编译一次 → 注册 AbortController → 启动引擎（fire-and-forget，执行体在
// dynamic-workflow-run-launch.ts）→ 把 run 的观察面（快照 / 等待 / 取消 / 恢复 / 枚举 /
// 事件分页）经窄端口交出去。
//
// 按职责拆分的叶面：启动半边（submit / amend）在 dynamic-workflow-run-submit.ts，
// resume 入口在 dynamic-workflow-run-resume.ts，执行编排在 dynamic-workflow-run-launch.ts，
// 11 条只读端口方法在 dynamic-workflow-run-read-side.ts；本文件持有工厂装配、
// owner 门、关闭门与结算簿记。
//
// 七条不变式，违反任何一条都会以「离成因很远」的方式表现，所以写在文件头：
//
//   1. **引擎独占 createRun**。本服务绝不预插 dwf_run 行。预先存在的行会把引擎构造函数翻进
//      resume 分支（engine.ts）：节点计数按已完结记录重算、预算从记录恢复、状态被
//      updateRunStatus 覆写。一个全新的 run 走 resume 分支不报错，只会静默从一份空 journal
//      「恢复」。resume 恰恰反过来**依赖**这条机制：它对既有 runId 重新 launch，让引擎命中
//      已存在的行。两个入口方向相反，绝不共用门。
//   2. **编译恰好一次**。一个 ts.Program 同时喂站点表、schema 合成与 lowering；scriptHash 由
//      本服务算（harness 刻意不算——它若哈希「自己看到的文本」，lowered 路径落库的就是
//      lowered 函数体的哈希，resume 校验的比对对象就静默错了）。
//   3. **没有 journal 就不构造本服务**。durability 是 run 的前提：一个静默丢失持久化的 run
//      比没有 run 更糟（resume 无据、详情页无源、取消后无记录）。narrowing 失败时
//      {@link createDynamicWorkflowRunService} 的调用方拿到 undefined，CreateWorkflow 因此
//      回到占位诊断路径——这是一个可见的降级，而不是一个坏掉的功能。
//   4. **构造时收敛本会话的孤儿 run，且只收敛本会话的**。见 {@link reconcileOrphanRuns}：
//      死进程留下的 `running` 行只有在这一刻才可判定，而「本会话」是唯一安全的作用域。
//      收敛写成 `stopped(interrupted)`（携 `Interrupted` 失败编码），与其余 stopped 同为可恢复。
//   5. **resume 先替换注册表条目，再启动**。`waitForTask` 对不在注册表里的 runId 直接回
//      journal 快照——条目晚一步，重臂的通知 watcher 会立刻对着旧的终态行结算。
//   6. **每次启动都在启动的同一同步片登记为常驻阻塞工作**。引擎是父会话 App 的闭包，不进
//      runtime task registry；常驻池因此只看见「registry 已退休」而把带着在飞引擎的
//      App 按 idle 关掉（10 分钟），resume 又起了第二个引擎。登记点只有一个——
//      {@link trackSettlement}，submit / amend / resume 共用它——计数在 launch 的同一同步片
//      增加、在结算的 finally 释放。
//   7. **close 停下自己拥有的每一个 run，而那一笔由引擎自己写**。App 关闭时本服务以
//      `"interrupted"` abort 每个在飞条目并**等它们结算**（不是超时、不是轮询），harness 把
//      这个原因归一成 `engine.stop("interrupted", Interrupted)`，于是行经引擎正常的 finishRun
//      尾巴落成可 resume 的 `stopped(interrupted)`。service 绝不自己写终态行：绕过引擎写，就会
//      造出 dwf_run 的第二个写入者（同不变式 1 的论证），且 journal 里不会有对应的 run-settled。
//      关闭之后 submit / amend / resume 直接抛——常驻池的关闭闸门本就挡住了命令，走到这里是
//      接线错误，不该让 contracts 的拒绝枚举为它变宽（同不变式 1 的论证）。

import type {
  DynamicWorkflowFillHoleRequest,
  DynamicWorkflowFillHoleResult,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
} from "@acode/contracts";
import { supportsRunIntrospection } from "@acode/workflow-run-read/contract";
import type { DynamicWorkflowTaskLinkStore } from "@acode/workflow-run-read/contract";
import type { Caps } from "@acode/dynamic-workflow";
import { createRunIntrospectionMethods } from "./dynamic-workflow-run-introspection.js";
import { createRunReadSideMethods } from "./dynamic-workflow-run-read-side.js";
import { reconcileOrphanRuns } from "./dynamic-workflow-run-reconcile.js";
import {
  resumeDynamicWorkflowRun,
  amendDynamicWorkflowRun,
  submitDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-submit.js";
// 挖洞-填充（specs/workflow-holes.md）：fill 的 supersede 续跑链（splice → amend 链 →
// hole-filled 事件），与三条启动入口共用同一份 ctx。
import { fillWorkflowHole } from "./dynamic-workflow-hole-fill.js";
import { type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import {
  createRunServiceLifecycle,
  type DynamicWorkflowRunSettledNotice,
} from "./dynamic-workflow-run-lifecycle.js";
import { retuneRunConcurrency } from "./dynamic-workflow-run-retune.js";
import {
  clampRunConcurrency,
  resolveWorkflowConcurrencyCeiling,
} from "./workflow-concurrency-ceiling.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "./workflow-escalation-registry.js";
import { resolveWriteBoundaryOwner } from "./workflow-owner-lease.js";
// W1-R3 解环：deps 类型住在中立文件（见 dynamic-workflow-run-deps.ts 头注），
// launch/submit 从那里导入；此处 re-export 保持既有消费面形状不变。
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-deps.js";
export type {
  DynamicWorkflowActorRuntimeInput,
  DynamicWorkflowRunServiceDeps,
} from "./dynamic-workflow-run-deps.js";

export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "@acode/workflow-run-read/contract";

/**
 * 本服务的完整面：{@link DynamicWorkflowRunPort}（引擎 / 工具层用）加两条**会话级**生命周期
 * 读面。后者的唯一消费者是宿主的 provider registry 安全边界：
 * 子代理共用父会话的 live adapter，一个在飞的 run 就是父会话的一段 active Loop——
 * registry replace 必须等它结算。
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** 此刻仍未结算的 run 数（registry 里 `terminal === undefined` 的条目）。 */
  countLiveRuns(): number;
  /**
   * 订阅结算：每个 run 进终态（completed / errored / stopped，含 launch 前失败）后恰好通知
   * 一次，簿记已经完成（计数已经扣掉它）。返回退订函数。监听器抛错只记日志，不影响结算。
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * 停下本服务拥有的每一个在飞 run 并等它们结算（文件头不变式 7）。**不在 contracts 的
   * {@link DynamicWorkflowRunPort} 上**：它是宿主 App 的生命周期动作，不是引擎与工具层的能力。
   * 幂等——第二次调用返回同一个 promise，不再 abort 任何东西。
   */
  close(): Promise<void>;
}

/**
 * 造 workflow run 服务。返回 {@link DynamicWorkflowRunService}：端口实现 + 两条会话级的
 * 生命周期读面（在飞 run 计数、结算订阅），后者不进 contracts 的窄端口——它们服务的是
 * 宿主的 registry 安全边界，不是引擎与工具层。
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /** 同一 runId 的 resume 在 rebuild/launch await 期间的同步 admission reservation。 */
  const resumeAdmissions = new Set<string>();
  /**
   * 升级问答的停驻表。**一张，跨本服务名下所有在飞 run**：
   * qid 全局唯一正是为此——`resolveQuestion` 只收一个不透明 token，多 run 并发时让模型自己配对
   * `(runId, qid)` 是错配的温床。纯内存，与停驻的 deferred 同命（进程亡故即清空，靠 resume
   * 后 actor 重新提问自愈；持久化一张 pending 表只会说谎）。
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();

  // 先拿共享 owner。claim 失败时只能让当前实例读/停留，不能把另一个进程的 live run
  // 当成孤儿收敛；legacy 内存装配没有 owner gate，保持原有直接收敛语义。
  // claim 失败（null）不再是终局：ensure 路径经 workflowOwnerReclaim 惰性重试，
  // 首次成功后补跑这里被跳过的收敛（deferredOwnerReconcile，spec R5）。
  const deferredOwnerReconcile = { pending: false };
  const ownerReady = deps.workflowOwnerReady;
  if (ownerReady === undefined) {
    reconcileOrphanRuns(deps);
  } else {
    void ownerReady.then((owner) => {
      if (owner === null) {
        deferredOwnerReconcile.pending = true;
        return;
      }
      if (owner !== undefined) {
        deps.ownerToken = owner.ownerToken;
        deps.ownerGeneration = owner.ownerGeneration;
      }
      reconcileOrphanRuns({ ...deps, ...(owner ?? {}) });
    });
  }

  /**
   * 本进程的并发天花板。
   * 与进程级治理器的桶天花板同一份实现：run 上界与桶天花板永远对得上。
   *
   * 本服务里它有四个读者，全部经这一个函数：新 run 的 caps 起点、端口上的
   * {@link DynamicWorkflowRunPort.concurrencyCeiling}（工具层据它钳制与判断「值不值得一提」）、
   * 两条读面的 `maxConcurrency` 判据，以及 `run-started` 载荷上的派生字段。
   */
  const concurrencyCeiling = (): number =>
    resolveWorkflowConcurrencyCeiling(deps.availableParallelism);

  // caps 只含并发上界，无墙钟超时；取消是唯一的停止手段。
  // 上界**起于天花板**，只能被请求压低、永不抬高——
  // 缺席即天花板，给了就钳到 [1, 天花板]。
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: clampRunConcurrency(requested, concurrencyCeiling()) };
  };

  // 内省面按能力探测接上（那四条查询不在引擎端口上）。缺席时下面两个**可选成员整个不实现**：
  // 消费方的 `typeof port.listRuns === "function"` 探测因此为假，工具层把它归一成
  // 「本会话没有这个能力」的业务失败——而不是一个静默的空列表。
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // 生命周期簿记（结算 / 关闭 / 关闭闸门 / 外来终态行留痕；文件头不变式 6、7）的实现体在
  // dynamic-workflow-run-lifecycle.ts：它们只借用这里的注册表与 journal，经窄依赖递过去。
  const {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  } = createRunServiceLifecycle({
    journal: deps.journal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    parentSessionId: deps.parentSessionId,
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runs,
  });

  // 两条入口（submit / resume）的实现体在 dynamic-workflow-run-submit.ts：它们只借用这里的
  // 注册表、停驻表、caps 与结算簿记，经 ctx 显式递过去，本文件不再复制那两段。
  const entryContext: DynamicWorkflowRunEntryContext = {
    deps,
    runs,
    resumeAdmissions,
    escalations,
    caps,
    trackSettlement,
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    close,

    // 三条入口的关闭门。`async` 只为把这个接线错误变成 rejection 而不是同步抛；门与随后的
    // 委托之间没有 await，所以不变式 6 的「登记与 launch 同一同步片」不受影响。
    async submit(
      request: DynamicWorkflowRunSubmitRequest,
    ): Promise<DynamicWorkflowRunSubmitResult> {
      assertOpen();
      await ensureWorkflowOwner(deps, deferredOwnerReconcile);
      return submitDynamicWorkflowRun(entryContext, request);
    },

    async amend(request: DynamicWorkflowRunAmendRequest): Promise<DynamicWorkflowRunAmendResult> {
      assertOpen();
      await ensureWorkflowOwner(deps, deferredOwnerReconcile);
      return amendDynamicWorkflowRun(entryContext, request);
    },

    /**
     * 本进程的并发天花板（端口契约见 {@link DynamicWorkflowRunPort.concurrencyCeiling}）。
     * 与 caps 的起点是**同一个** {@link concurrencyCeiling}：工具层钳出来的值必须与端口随后
     * 落库的值相等，否则确认窗显示的就不是将要生效的那个数。
     */
    concurrencyCeiling,

    /**
     * 就地改一个在飞 run 自己的并发上界（端口契约见
     * {@link DynamicWorkflowRunPort.retuneConcurrency}；实现体在 dynamic-workflow-run-retune.ts）。
     *
     * 刻意**不过关闭门**：三条启动入口要 `assertOpen` 是因为它们会起引擎，而这一条什么都不起——
     * 关闭中的 service 里每个条目都在结算，存活判定自己会把它报成 `not_live`。
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, concurrencyCeiling }, request);
    },

    async resume(runId: string): Promise<DynamicWorkflowRunResumeResult> {
      assertOpen();
      await ensureWorkflowOwner(deps, deferredOwnerReconcile);
      return resumeDynamicWorkflowRun(entryContext, runId);
    },

    // 11 条只读端口方法（枚举 / 回放 / 快照 / 等待 / 事件 / 产物 / 工作区）。全是读，不过关闭门
    // 与 owner 门：实现体在 dynamic-workflow-run-read-side.ts，运行态事实经 host 显式递过去。
    ...createRunReadSideMethods({
      deps,
      runs,
      escalations,
      concurrencyCeiling,
      noteForeignTerminalRow,
    }),

    /**
     * 回答一个 actor 升级上来的阻塞问题。查表 → driver 结算 → `escalate` 的工具结果变成这段
     * 答案，actor 的轮次就地继续。**run 状态全程不动**：升级是 ask 内部的一次慢工具调用，
     * 不是 run 生命周期事件（按设计 escalate 不终结/冻结 run）。
     *
     * 三类结构化拒绝的判别与文案都在注册表里（它才知道一个 qid 是从没存在过、已被回答，
     * 还是随 ask 一起撤下了）。本方法刻意不加二次判断——两处各判一次，同一个 qid 迟早会在
     * 两个层上得到不同的解释。
     */
    async resolveQuestion(
      qid: string,
      answer: string,
    ): Promise<DynamicWorkflowResolveQuestionResult> {
      return escalations.resolve(qid, answer);
    },

    /**
     * 填一个停驻中的洞（挖洞-填充，specs/workflow-holes.md；实现体在
     * dynamic-workflow-hole-fill.ts）。与三条启动入口同过关闭门：它会停前驱并起一个新 run。
     * splice、在飞/等待判定、hole-filled 事件与 cacheImported 的裁断全在实现体里。
     */
    async fillHole(
      request: DynamicWorkflowFillHoleRequest,
    ): Promise<DynamicWorkflowFillHoleResult> {
      assertOpen();
      await ensureWorkflowOwner(deps, deferredOwnerReconcile);
      return fillWorkflowHole(entryContext, request);
    },

    async cancel(
      runId: string,
      initiator: DynamicWorkflowRunCancelInitiator = "user",
    ): Promise<boolean> {
      const entry = runs.get(runId);
      // 未知 run（或已结算）没有可中止的东西。返回 false 让上层归一成结构化的 not_found，
      // 而不是报告一次没发生的取消。
      if (entry === undefined || entry.terminal !== undefined) return false;
      // abort 是 harness 里唯一的「真停止」：中止在飞 ask、kill 子进程，引擎经 stop(initiator)
      // 结算 stopped（已完结 journal 条目保留 → 可 resume）。abort 的 reason 就是 initiator——
      // harness 读 `signal.reason` 决定 stopped(user) 还是 stopped(model)，从此原因落库，
      // 不再只活在后台任务注册表里。
      entry.controller.abort(initiator);
      return true;
    },

    ...(introspection === undefined
      ? {}
      : createRunIntrospectionMethods({
          introspection,
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          runs,
          escalations,
          concurrencyCeiling,
        })),
  };
}

async function ensureWorkflowOwner(
  deps: DynamicWorkflowRunServiceDeps,
  deferredOwnerReconcile: { pending: boolean },
): Promise<void> {
  // D3/R4 修复：写边界恒经 resolveWriteBoundaryOwner 读 **live** 所有权（内部走 reclaim），
  // 不再读冻结的一次性 workflowOwnerReady。旧形状 `owner = await ownerReady; if (owner ===
  // null) owner = await reclaim()` 在初始 claim 成功后 ownerReady 永久非 null，于是接管后
  // reclaim 永不触发、闸门拿陈旧 facts 继续写（不带闸门的 createRun 落库陈旧行，首个 gated
  // 写入被拒，行冻结在非终态；且 reclaim 不可达 → 自愈/收敛永不发生 → 进程级锁死）。
  const owner = await resolveWriteBoundaryOwner({
    ownerReady: deps.workflowOwnerReady,
    ownerReclaim: deps.workflowOwnerReclaim,
  });
  if (owner === null) throw new Error("Workflow session owner lease is held by another process");
  if (owner !== undefined) {
    if (deferredOwnerReconcile.pending) {
      // R5：构造期收敛因 claim 失败被跳过；首次取得所有权时补跑一次。安全论证与
      // 构造期相同：本进程此前从未持有所有权 ⇒ 名下零在飞 run ⇒ 本会话 journal 里的
      // 非终态行只可能是死进程遗物（现场证据：冻结在 running 的 dwfrun-ba4e6ad0）。
      deferredOwnerReconcile.pending = false;
      reconcileOrphanRuns({ ...deps, ...owner });
    }
    deps.ownerToken = owner.ownerToken;
    deps.ownerGeneration = owner.ownerGeneration;
  }
}
