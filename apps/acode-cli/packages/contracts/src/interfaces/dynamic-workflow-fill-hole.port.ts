// ============================================================
// Dynamic Workflow Fill Hole Port（挖洞-填充的请求/结果类型，specs/workflow-holes.md）
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出的叶子文件（与 retune / workspace / error 同一条
// 先例）：那一份顶在 architecture-policy 的 max-file-lines 门上，fillHole 的三个类型
// 落进来；主端口文件 `export type * from` 原样再导出，消费方的导入路径不变。

import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.fillHole} 的请求。
 *
 * splice 在**服务端**做（读 run 草稿、按 hole_ref 定位、AST 级替换、重编译）：工具层为了
 * 确认窗会做一次同样的纯函数变换（spliceWorkflowHole 是确定性的，两边逐字节相同），但
 * 「脚本必须对应**此刻正在等待的那条 run** 的草稿」只能由持有 run 的一侧保证——递进来
 * 一份预拼接的脚本等于让一个可能过期的快照冒充 run 的草稿。
 */
export interface DynamicWorkflowFillHoleRequest {
  /** 停在洞上的那条 run（不是 splice 后的新 run——后者的 id 由结果给出）。 */
  runId: string;
  /** 洞的复合身份（`hole#N@ordinal`）。 */
  holeId: string;
  /** 作者提交的 fill 语句原文（审计、fill 文件落盘与 hole-filled 事件摘要共用）。 */
  fill: string;
  /** run 的工作目录（fill 文件与后续 run 的落点）。 */
  cwd: string;
  /** fill 文件（工具层已落盘时在场；hole-filled 事件原样记录，audit 面）。 */
  fillPath?: string;
  /**
   * splice 后脚本的草稿文件（工具层落盘）。新 run 记的永远是**装着这一次脚本**的文件；
   * 前驱的 scriptPath 指向旧脚本，绝不沿用。缺席即草稿写不下去（与 submit 同义）。
   */
  scriptPath?: string;
  /** splice 后**新脚本**的声明阶段表；语义同 AmendWorkflow 请求的 phaseNames。 */
  phaseNames?: string[];
  /** 与 `phaseNames` 对齐的「同时在跑」表；语义同 AmendWorkflow 请求的 phaseAlongside。 */
  phaseAlongside?: number[][];
  parentSessionId?: SessionId | string;
  /** 发起这次填充的 FillWorkflowHole 工具调用（新 run 的工具卡 → 详情页关联键）。 */
  toolCallId?: ToolCallId | string;
  trace: TraceContext;
}

/**
 * fillHole 的结构化拒绝理由。两者对模型是**两个不同的下一步**（换正确的 id / 改 fill 再提），
 * 所以必须可分辨；判别键在 reason，可操作文案在 message（由实现侧写好）。
 */
export type DynamicWorkflowFillHoleRefusalReason =
  /**
   * run 不在飞，或不在该洞等待（已填 / 未到达 / 未知 id）。什么都没被 splice、没被停。
   */
  | "hole_not_waiting"
  /**
   * splice 后的脚本编不过（fill 语句本身不成立，或与草稿的最新版本相撞——工具层确认窗
   * 之后草稿被换过的竞态）。洞仍等待、run 未动；message 携带有界诊断与 fill 文件路径。
   */
  | "fill_compile_failed";

/**
 * `fillHole` 的结构化结果。成功语义：fill 已 splice、前驱以 superseded 停下、后继 run 已在
 * 飞行（`runId` 即后继 id）。`cacheImported: false` 时 `cacheImportedReason` 如实说明原因
 * ——例如前驱的世界在结果落定后已被改写（导入缓存关门），相关步骤安全优先地重跑。
 */
export type DynamicWorkflowFillHoleResult =
  | {
      ok: true;
      /** splice 后续跑的后继 run（= backgroundTaskId）。 */
      runId: string;
      /** 前驱在飞、被本次填充停下时在场（= 请求的 runId）。 */
      supersededRunId?: string;
      /** fill 文件（请求带了就在场；落盘归工具层，这里只回显）。 */
      fillPath?: string;
      /** 前驱的已完成工作是否作为缓存导入后继。 */
      cacheImported: boolean;
      /** `cacheImported === false` 时在场的原因说明。 */
      cacheImportedReason?: string;
    }
  | { ok: false; reason: DynamicWorkflowFillHoleRefusalReason; message: string };

/**
 * 一个停驻中的洞（挖洞-填充，specs/workflow-holes.md）。字段与 `hole-reached` 事件同源。
 * 与 pendingQuestion 的分工：升级问题欠的是**值**（actor 停在自己那次 ask 里等一句话，
 * `resolveQuestion` 作答）；洞欠的是**代码**（脚本进程停在洞站点，`fillHole` 提交该处
 * 函数体的语句并沿修订链续跑）。
 */
export interface DynamicWorkflowRunPendingHole {
  /** 复合身份 `${siteId}@${ordinal}`（如 `hole#1@1`）；`fillHole` 只认它。 */
  holeId: string;
  /** 站点实例序数（进引擎 nextOrdinal 体系；同洞不同轮次是不同实例）。 */
  ordinal: number;
  /** 站名（脚本里 `hole<T>(stage, prompt)` 的第一个字面量）。 */
  stage: string;
  /** 提示词（含插值后的进展账目）。 */
  prompt: string;
  /** 到达时刻（epoch ms）。事件侧必填；这里 optional 的理由与 askedAt 逐字相同（防旧事件）。 */
  askedAt?: number;
}
