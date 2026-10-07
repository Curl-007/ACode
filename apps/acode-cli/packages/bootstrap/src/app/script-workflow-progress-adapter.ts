/**
 * 脚本工作流事件 → dwf 进度信封的适配器。
 *
 * 为什么是「翻译」而不是「另建一套投影」：dwf 的 `workflowRuns` 投影、共享 reducer
 * （`packages/shared/src/acode-protocol-v4/workflow-runs-reducer.ts`）、时间线卡、状态面板、
 * run 目录与详情侧栏是一整套已经打磨过的东西，而 TUI 与桌面**共用同一个 reducer**——
 * 两端不可能算出不同状态。脚本工作流的十二种事件里十一种能干净映射到 dwf 的 eventType
 * 词表（见下表），于是翻译一遍就能白拿整套渲染，不用改一行 UI 组件。
 *
 *   workflow_started    → run-started
 *   script_phase        → phase-entered
 *   script_log          → log
 *   activity_started    → actor-created + node-dispatched
 *   activity_completed  → node-settled { outcome: "ok" }
 *   activity_failed     → node-settled { outcome: "failed" }
 *   activity_cached     → node-settled { outcome: "ok", cached: true }
 *   workflow_usage      → usage-updated
 *   workflow_completed  → run-settled { status: "completed" }
 *   workflow_cancelled  → run-settled { status: "stopped", stopReason: "user" }
 *   workflow_failed     → run-settled { status: "errored" }
 *   entry_file_fallback → （无对应，丢弃）
 *
 * 三条终态词**必须**分开：reducer 的终态闭集是 completed / errored / stopped，而
 * `stopReason` 只在 stopped 时搬运，渲染侧按这两个字段决定颜色与文案。把用户取消折进
 * errored，用户看到的是「脚本崩了」而不是「你停的」。
 *
 * `log` 不在 reducer 的 switch 里——它不改任何表，只被两端的镜像/面板各自消费：TUI 的
 * `appendWorkflowLogTail`（`app-workflow-mirror.ts`）截一条尾巴挂在卡片上，桌面侧栏的
 * `workflowRunPanel.ts` 把它渲染成一行时间线。所以它是**信封**词表的一员而不是 reducer
 * 词表的一员，两处都得对上才算接好。
 *
 * `entry_file_fallback` 才是真没有对应物的那一个：它报的是「沙箱入口文件没能写进项目目录、
 * 回落到了临时目录」，属于宿主环境的告警而不是 run 的进度。dwf 侧走的是 `onWarning` 回调
 * 落 warn 日志（这边同样落了一份），不进投影。
 *
 * ## 已知边界（诚实声明）
 *
 * **只有运行期实时可见，冷恢复后从投影里消失。** dwf 的投影有两条来源：实时事件，以及
 * 冷启动时从 dwf journal 回放（`dynamic-workflow-run-introspection.ts` 的 replay +
 * TUI 的 `app-workflow-seed.ts`）。脚本工作流的 run 不在那份 journal 里——它有自己的
 * `workflow_activity` / 事件表。所以进程重启后，历史脚本工作流 run 不会出现在这套投影中；
 * 它们的真相仍在自己的表里，`scriptWorkflowStatus` 与 `listScriptWorkflows` 照旧能查。
 * 这是「只做实时进度」这一档的边界，不是 bug。要补冷恢复需要给回放路径加第二个来源，
 * 那是另一件事。
 *
 * ## 身份与序号
 *
 * 信封的 `sequence` 必须**每 run 单调递增**（reducer 用它判定重放 vs 新事件、并抬水位）。
 * 序号由本模块按 runId 各自维护；run 结算即清项，否则长会话里每个 run 漏一条 Map。
 * 这与 `ScriptWorkflowRuntime` 的 agent 计数同款道理——见那边字段注释里记的那个 bug。
 */

import type { DynamicWorkflowRunProgressPayload } from "@acode/contracts";

/** 与 dwf 进度汇同签名，于是可以直接复用 `createDynamicWorkflowRunProgressSink`。 */
export type ScriptWorkflowProgressEmit = (
  progress: DynamicWorkflowRunProgressPayload,
  routing?: { parentSessionId?: string },
) => void;

/** dwf 投影里节点与子代理的身份引用形状（reducer 的 `workflowInstanceRef` 逐字要求）。 */
interface InstanceRef {
  ordinal: number;
  siteId: string;
}

interface RunProjectionContext {
  /** 下一个信封的序号；每 run 各自一份。 */
  nextSequence: number;
  /** 下一个 phase 的 ordinal；reducer 要求 > 0 的整数。 */
  nextPhaseOrdinal: number;
  /**
   * 已经发过 `actor-created` 的实例身份。
   *
   * 为什么必须记：reducer 的 actor upsert 是**整条替换**而不是字段合并
   * （`workflowActorEntry` 每次都造一个全新对象，`sessionId` 缺席就是键缺席），所以一条
   * 不带 `actorSessionId` 的 `actor-created` 会把先前那条带 sessionId 的**抹掉**。
   * 而结算事件的补发恰恰不带 sessionId——子会话 id 只在 `activity_started` 的载荷里。
   * 后果是：每个正常起跑又结算的 agent 都会先拿到 sessionId、再被自己的结算事件抹掉，
   * 名册上一个能点开的都没有。补发只对「从没 started 过」的实例有意义，所以要按身份去重。
   *
   * 键形如 `siteId#ordinal`，只用于本模块去重，不上线也不是 dwf 的身份键格式。
   */
  announcedActors: Set<string>;
  parentSessionId?: string;
  toolCallId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actorKey(instance: InstanceRef): string {
  return `${instance.siteId}#${instance.ordinal}`;
}

/**
 * 把 `callPath` 折成 dwf 的 `{siteId, ordinal}`。
 *
 * callPath 形如 `root/parallel0/item3/stage1/agent0`，本身就是这次调用的唯一身份，
 * 所以直接当 siteId 用；ordinal 取 0——脚本工作流里一次 `agent()` 就是一个子会话、
 * 一条活动，没有 dwf 那种「同一个 actor 上多次 ask」的概念，于是每个站点恒只有一次。
 * 这也让 resume 缓存键（callPath + inputHash）与投影身份用的是同一个东西，不会出现
 * 「缓存认得、投影认不得」的裂缝。
 */
function instanceRefOf(callPath: string | undefined, fallback: string): InstanceRef {
  return { ordinal: 0, siteId: readString(callPath) ?? fallback };
}

export interface ScriptWorkflowProgressAdapter {
  /** run 起跑时登记投影上下文（toolCallId 用于把 run 卡联接到发起它的工具调用）。 */
  registerRun(input: {
    parentSessionId?: string;
    runId: string;
    toolCallId?: string;
  }): void;
  /** 唯一入口：脚本工作流的每个事件都经这里，映射得出发信封、映射不出就静默丢弃。 */
  onEvent(input: { payload: unknown; runId: string; type: string }): void;
  /** run 结算即清项。 */
  forgetRun(runId: string): void;
}

export function createScriptWorkflowProgressAdapter(deps: {
  emit: ScriptWorkflowProgressEmit;
}): ScriptWorkflowProgressAdapter {
  const contexts = new Map<string, RunProjectionContext>();

  function contextFor(runId: string): RunProjectionContext {
    const existing = contexts.get(runId);
    if (existing) return existing;
    // 未登记就收到事件（例如 resume 走了别的路径）：临时建一份，序号从 1 起。
    // 宁可少一个 toolCallId 联接，也不要丢掉整条 run 的进度。
    const created: RunProjectionContext = {
      announcedActors: new Set<string>(),
      nextPhaseOrdinal: 1,
      nextSequence: 1,
    };
    contexts.set(runId, created);
    return created;
  }

  /**
   * `derived` 装的是**信封顶层**的派生字段，与 `payload` 平级而不是塞进它里面。
   *
   * 这不是风格问题：reducer 只从 `envelope.actorSessionId` 取子代理会话 id
   * （`workflow-runs-reducer.ts:143` → `applyWorkflowRunEvent` 的 `derived.actorSessionId`
   * → `workflowActorEntry(...)`），塞进 payload 的那份**根本不会被读到**。dwf 侧也是这么挂的
   * （`dynamic-workflow-run-launch.ts` 的 toProgressPayload），契约注释明写它是「payload 之外
   * 的派生字段」。挂错的后果很隐蔽：名册上有名字、点进去没有转写。
   */
  function send(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    derived?: { actorSessionId?: string },
  ): void {
    const context = contextFor(runId);
    const sequence = context.nextSequence;
    context.nextSequence += 1;
    deps.emit(
      {
        eventType,
        payload,
        runId,
        sequence,
        ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
        ...(derived?.actorSessionId === undefined
          ? {}
          : { actorSessionId: derived.actorSessionId }),
      },
      context.parentSessionId === undefined
        ? undefined
        : { parentSessionId: context.parentSessionId },
    );
  }

  return {
    forgetRun(runId) {
      contexts.delete(runId);
    },

    onEvent({ payload, runId, type }) {
      const fields = isRecord(payload) ? payload : {};
      switch (type) {
        case "workflow_started":
          // dialect 是这一整套的支点：侧栏靠它决定门掉哪些按钮（Resume / Amend 是 dwf 专有
          // 命令，打在 wf_ 前缀的 run 上必然失败），卡片与详情头靠它标出跑的是哪套系统。
          // 只在这条事件上带，因为 reducer 只在 run-started 里读它。
          send(runId, "run-started", { dialect: "script" });
          return;

        case "script_phase": {
          const name = readString(fields.title);
          if (name === undefined) return;
          const context = contextFor(runId);
          const ordinal = context.nextPhaseOrdinal;
          context.nextPhaseOrdinal += 1;
          send(runId, "phase-entered", { name, ordinal });
          return;
        }

        case "script_log": {
          // 子进程的 log() 载荷就是 {message, phase}（script-workflow-child-source.ts），
          // 而两端读的键都叫 message：TUI 的 logMessage() 与桌面 workflowRunPanel 的
          // `case "log"`。phase 不搬——dwf 的 log 行不带相位，多塞一个键只会让两端的
          // 行形状不一致。
          //
          // 空白消息在这里就丢掉，不留给下游：两端的读面都会把折叠后为空的行扔掉
          // （TUI 的 logMessage 明写 `collapsed.length === 0` → undefined），发过去只是
          // 白吃一个序号，而序号必须与实际发出的信封一一对应。
          const raw = fields.message;
          if (typeof raw !== "string") return;
          const message = raw.trim();
          if (message.length === 0) return;
          send(runId, "log", { message });
          return;
        }

        case "activity_started": {
          const activityId = readString(fields.activityId) ?? "activity";
          const instance = instanceRefOf(readString(fields.callPath), activityId);
          const label = readString(fields.label);
          const phaseName = readString(fields.phase);
          const childSessionId = readString(fields.childSessionId);
          // 两条信封：dwf 里 actor（子代理会话）与 node（一次 ask）是分开的实体，
          // 脚本工作流里一次 agent() 同时是这两者，所以两条都要发，否则时间线上
          // 会出现「有活没人干」或「有人没活干」的半截行。
          send(
            runId,
            "actor-created",
            {
              actor: instance,
              ...(label === undefined ? {} : { name: label }),
              ...(phaseName === undefined ? {} : { phaseName }),
            },
            // 会话 id 走信封顶层（见 send 的注释）：这是「点开子代理看它的转写」唯一的接线，
            // 挂进 payload 会被 reducer 无视，名册上于是只剩一个点不动的名字。
            childSessionId === undefined ? undefined : { actorSessionId: childSessionId },
          );
          // node-dispatched 也带上：reducer 在派发那一刻会用它重铸 actor 条目
          // （`dispatchActor`），于是即便 actor-created 因表满被拒，派活时仍能连人带活回到表上。
          send(
            runId,
            "node-dispatched",
            {
              instance,
              actor: instance,
              kind: "ask",
              ...(label === undefined ? {} : { actorName: label }),
              ...(phaseName === undefined ? {} : { actorPhaseName: phaseName }),
            },
            childSessionId === undefined ? undefined : { actorSessionId: childSessionId },
          );
          // 记下「这个实例已经带着 sessionId 出生过」，结算事件就不要再补一条把它抹掉。
          contextFor(runId).announcedActors.add(actorKey(instance));
          return;
        }

        case "activity_completed":
        case "activity_failed":
        case "activity_cached": {
          const activityId = readString(fields.activityId) ?? "activity";
          const instance = instanceRefOf(readString(fields.callPath), activityId);
          const label = readString(fields.label);
          const phaseName = readString(fields.phase);
          const failed = type === "activity_failed";
          const cached = type === "activity_cached";
          const context = contextFor(runId);
          const key = actorKey(instance);
          // 结算事件**只在没有 started 过时**补一条 actor-created。两种情况需要补：
          //   - cached：缓存命中直接返回，`activity_started` 根本不会发；
          //   - failed：失败可能发生在子会话铸造之前（例如 worktree 建不起来）。
          // 不补的后果是节点坐上了表、子代理名册上却没有这个人——时间线出现「有活没人干」。
          //
          // 而**已经 started 过的绝不能再补**：那条补发不带 actorSessionId（子会话 id 只在
          // started 的载荷里），而 reducer 的 actor upsert 是整条替换而不是字段合并，
          // 于是它会把 started 那条带来的 sessionId 抹掉。每个正常起跑又结算的 agent 都会
          // 中招——名册上一个能点开转写的都没有。这一条是端到端测试跑出来的，手写夹具
          // （started 与结算分成两个用例）看不见它。
          if (!context.announcedActors.has(key)) {
            context.announcedActors.add(key);
            send(runId, "actor-created", {
              actor: instance,
              ...(label === undefined ? {} : { name: label }),
              ...(phaseName === undefined ? {} : { phaseName }),
            });
          }
          // reducer 把 `node-settled { cached: true }` 当作节点的**出生事件**，
          // 所以 cached 这条自己就能把节点放上表，不需要再补 node-dispatched。
          send(runId, "node-settled", {
            instance,
            actor: instance,
            kind: "ask",
            outcome: failed ? "failed" : "ok",
            ...(cached ? { cached: true } : {}),
            ...(phaseName === undefined ? {} : { phaseName }),
          });
          return;
        }

        case "workflow_usage": {
          // dwf 的 usage-updated 携带的是**已花总量**而不是增量（reducer 直接覆写
          // `usage.spentTokens`，见 workflow-runs-reducer.ts:439）。runtime 的 addRunStats
          // 是累计总量的唯一写入点，所以那边发的就是总量，这里原样搬。
          const spentTokens = fields.spentTokens;
          if (typeof spentTokens !== "number" || !Number.isFinite(spentTokens)) return;
          send(runId, "usage-updated", { spentTokens });
          return;
        }

        case "workflow_completed":
          send(runId, "run-settled", { status: "completed" });
          return;

        case "workflow_cancelled":
          // 用户停下 ≠ 脚本崩了。两者的终态词不同，渲染侧据此着色并决定文案：
          // `stopped` + `stopReason:"user"` 在 TUI 上是 muted 的「stopped (by you)」，
          // `errored` 是 danger 的错误卡。把取消归进 errored，用户会以为自己的脚本坏了。
          // 与 dwf 的 `settleStopped(state, "user")` 逐字同一笔语义。
          //
          // 刻意**不**带 `resumable`：脚本工作流确实能按 `resumeFromRunId` 续跑，但那是模型
          // 经 RunWorkflow 走的路，用户面前没有任何一条 `/dwf resume` 式的命令能续它
          // （`/dwf resume` 打到 dwf 的 run service，对 wf_ 前缀的 run 必然失败）。
          // 亮起一个按不动的 Resume 比不亮更糟——dwf 侧的注释里就记着这条裂缝。
          send(runId, "run-settled", { status: "stopped", stopReason: "user" });
          return;

        case "workflow_failed": {
          const message = readString(fields.message);
          send(runId, "run-settled", {
            status: "errored",
            ...(message === undefined ? {} : { error: { message } }),
          });
          return;
        }

        default:
          // entry_file_fallback 以及任何将来新增的类型：dwf 词表里没有对应物，静默丢弃。
          // reducer 对未知 eventType 本来就只抬水位，所以发过去也是白发的。
          // 丢弃**不消耗序号**——序号必须与实际发出的信封一一对应，否则水位会虚抬。
          return;
      }
    },

    registerRun({ parentSessionId, runId, toolCallId }) {
      contexts.set(runId, {
        announcedActors: new Set<string>(),
        nextPhaseOrdinal: 1,
        nextSequence: 1,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });
    },
  };
}
