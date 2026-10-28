// ============================================================
// launch 的事件适配器（从 dynamic-workflow-run-launch.ts 拆出）
// ============================================================
// RunEvent → 协议事件 / 会话事件载荷的映射。与 dynamic-workflow-launch-actor-session.ts
// 同属 launch（submit/resume 共享半身）的两条支线：那边管 actor 会话接入，这边管事件有界化与派生字段。
// 冷回放（dynamic-workflow-run-replay.ts）只复用 toProgressPayload，不复用 emit 闭包。
//
// 注意：journal sequence 截取（createJournalSequenceCapture）仍在 launch 主体——它持有 emit
// 的 sequence 游标，不是本文件的职责。
//
// 新增一个事件种类：本文件零改动（映射不按种类分支），但下游投影侧有一个按种类的 switch：
// `acode-protocol-v4/product-projection.ts` 的 `applyWorkflowRunEvent`——见 toProtocolEvent 注释。

import {
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
} from "@acode/contracts";
import type { ActorRef, RunEvent } from "@acode/dynamic-workflow";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import { mintActorSessionId } from "./workflow-driver-helpers.js";

/**
 * RunEvent → 协议事件的映射（**本注释即契约**）：`type` 取事件的判别式，`payload` 是同一个
 * 事件对象去掉 `type` 后的其余字段，经 {@link boundDynamicWorkflowRunEventPayload} 有界化。
 * 刻意不重塑字段名——读端（详情页事件日志）按事件种类解释 payload，而引擎的词汇表就是那份 schema。
 *
 * 引擎实际发出的种类：run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled。
 * （`executing` 不是可观察事件；`compaction` v1 从不发出。）另有两种由 **driver** 发出、
 * 走同样两条轨的事件：escalation-raised / escalation-resolved（workflow-driver.ts 的升级桥接）。
 *
 * 新增一个事件种类在**本函数**里是零改动的，这正是"不重塑字段名"买到的东西：`type` 取判别式、
 * payload 是其余字段，这里没有按种类的分支可漏。**但下游确实有一个按种类的 switch**：
 * `acode-protocol-v4/product-projection.ts` 的 `applyWorkflowRunEvent` 逐种类归约，其
 * `eventType` 形参是 `string` 而不是 `RunEvent["type"]`，漏一支 tsc 不会报——加事件种类时
 * 要去读那个 switch，不能指望编译器。
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent → 会话事件载荷。`payload` 与 {@link toProtocolEvent} 使用同一次序列化，
 * 派生字段放在 payload 之外，保留引擎事件原文。
 *
 * `actorSessionId` 通过与 driver 相同的生成函数获取，避免 renderer 重复实现会话 ID 规则。
 * `actor-created` 和带 actor 的 `node-dispatched` 都补充该字段，使运行中实例被收进有界表时，
 * 仍能关联到对应的子代理会话。进程并发上限和子代理来源按下方各自的事件条件补充。
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** run 的锚点 inputId；只在 actor-created / run-settled 上派生（子代理归属的两个时刻）。 */
  launchInputId?: string;
  /** 修订 run 的前驱；只在 `run-started` 上派生（卡片的「调整自 run X」）。 */
  resumedFrom?: string;
  /**
   * 铸造这条载荷那一刻的进程并发天花板；在 `run-started` 与 `run-caps-changed` 两种事件上派生。
   *
   * 引擎事件只带它自己的 `caps.maxConcurrency`，而「这个数值不值得显示」要拿它和天花板比——
   * 天花板是宿主事实（机器核数），引擎既看不见也不该看见。投影侧据 `caps.maxConcurrency <
   * concurrencyCeiling` 记下本 run 的自有上界，UI 的并发 chip 再取 min(共享 cap, 本 run 上界)。
   *
   * 一次就地 retune 发的 `run-caps-changed` 带着**新的** caps，判据却是同一条：低于天花板就写下
   * 上界、等于天花板就把它清掉（= 解除限制）。所以两种事件必须拿到同一个天花板，也就是这一个。
   */
  concurrencyCeiling?: number;
  /**
   * 本 run 的子代理模型（规范 picker 串）；只在 `run-started` 上派生，且**只在设过时**在场。
   * 与 `concurrencyCeiling` 不同，它不需要与任何默认值比对：
   * 引擎压根不知道有这件事（模型面整个在宿主侧），所以缺席即「子代理跑在会话模型上」。
   * 冷回放从同一条 `run-launched` 事件给出同一个键，两侧载荷因此逐字节相等。
   */
  subagentModel?: string;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // `run-settled` 多带一位 `resumable`：
    // resume 门的谓词只在 CLI 有，投影与 UI 只搬运这一位、绝不自行按 status 推导。
    // 谓词 = stopped ∧ 非 superseded；冷回放对孤儿收敛过的
    // 行给同一个键——两条链、一个谓词（isResumableSettlement）。stopReason / supersededBy 随事件载荷原样透出。
    // `run-started` 多带 `resumedFrom`：引擎事件不带它（引擎不读 lineage），但卡片要画这条边。
    // 同一条缝里还多带 `concurrencyCeiling`：引擎只发自己的 caps，而「这个上界是不是默认值」
    // 要拿它和宿主的天花板比（见上面的字段注释）。两者互不相关，各自缺席即各自不出。
    // `run-caps-changed` 走**同一条**缝、同一个天花板：一次就地 retune 之后读面要靠它判断新上界
    // 该写下还是该清掉，缺了它这条事件就只是两个没有标尺的数。
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // 第三个派生字段：埋点事实层只在这两种事件上
    // 需要锚点——actor-created 登记子代理归属，run-settled 结算该 run 全部子代理。
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 * 这条事件点名了哪个子代理（要补 `actorSessionId` 的那个 ref），没点名即 undefined。
 *
 * 两种事件：`actor-created`（子代理的出生），以及带 `actor` 的 `node-dispatched`（ask 派发时重复出生事实）。
 * world-read 的派发不带 `actor`，因此不补——它没有转录可开。
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  return undefined;
}
