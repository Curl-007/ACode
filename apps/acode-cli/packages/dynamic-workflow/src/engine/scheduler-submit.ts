/**
 * scheduler.ts 顶到 oxlint max-lines 上限（400 行），把 Boundary B 的向上回报处理
 * （submit_result 到达、turn 结束、ask 用量 stats）及其 repair / nudge 预算与 submit
 * 归一化拆到本文件；公开面仍从 scheduler.ts 导出。
 *
 * 自由函数经 {@link SubmitSeam} 拿到调度器的 live 节点表与两条结算入口；AskScheduler 上的
 * submitAttempted / turnEnded / noteStats 只是薄委托。
 */

import { journaledStats, type AskNode, type SchedulerHost } from "./scheduler-types.js";
import type { AskStats, InstanceRef, Violation } from "./types.js";
import { REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

/** 调度器暴露给回报处理的最小接缝：查 live 节点、按结果结算。 */
export interface SubmitSeam {
  readonly host: SchedulerHost;
  /** 按实例查 live 节点（已离开 liveNodes 的返回 undefined）。 */
  liveNode(instance: InstanceRef): AskNode | undefined;
  settleOk(node: AskNode, artifact: unknown): void;
  settleFailed(node: AskNode, error: WorkflowError): void;
}

export function handleSubmitAttempted(
  seam: SubmitSeam,
  instance: InstanceRef,
  payload: unknown,
): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  // untyped ask 不提供 submit_result；即便收到也不据其结算。
  if (!node.spec.typed) return;

  const { value, violations } = normalizeSubmit(seam.host, node.spec.schema, payload);
  if (violations.length === 0) {
    seam.host.driver.respondToSubmit(instance, { kind: "accept" });
    seam.settleOk(node, value);
    return;
  }
  if (node.repairsRemaining > 0) {
    node.repairsRemaining--;
    const attempt = REPAIR_ATTEMPTS - node.repairsRemaining;
    seam.host.driver.respondToSubmit(instance, { kind: "reject", violations });
    seam.host.record({ type: "node-repairing", instance, attempt, violations });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ValidationFailed",
      "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
      { violations },
    ),
  );
}

/**
 * 宽松归一化 submit payload：先按原值校验；仅当原值不过、且原值是 string 时，做一次 JSON.parse
 * 再校验，成功则以解析后的值为准（既回裁决也落 journal）。
 *
 * 实盘发现（GLM-5.3 经 Anthropic 兼容端点）：真实模型常把 submit_result 的 `result` 参数序列化成
 * JSON 字符串（如 `"{\"title\":...}"`）而非 JSON 对象，导致校验器正确报「expected object, got string」、
 * repair 3 次后 run 失败。legacy script-workflow 的 parseStructuredResponse 早以宽松 JSON 解析容忍此
 * 情形；此处补上同等容忍，但 schema-aware：
 *   1. 原值直接过 → 用原值，绝不解析（保住合法的 string 结果，如 `string | null` schema，`"42"` 须留 `"42"`）。
 *   2. 原值不过且是 string → 单次 JSON.parse（不递归、不双解析，沿用 legacy 单次抽取先例）后再校验，过则取解析值。
 *   3. 否则 → 回原值 + 原始违规，交模型 repair。
 * 引擎是纯包，JSON.parse 纯确定、无 I/O，放这里安全。
 */
function normalizeSubmit(
  host: SchedulerHost,
  schema: unknown,
  payload: unknown,
): { value: unknown; violations: Violation[] } {
  const direct = host.validate(schema, payload);
  if (direct.length === 0) return { value: payload, violations: [] };
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      const after = host.validate(schema, parsed);
      if (after.length === 0) return { value: parsed, violations: [] };
      // bug：解析成功但解析值仍不过时，曾上报解析前的
      // `direct` 违规（"$: expected object, got string"），模型面对的其实是已解码对象，无从修起，
      // 只能反复重引号/双重编码/退化成 "{}"，耗尽 repair 预算。修复违规必须描述模型可修改的值，
      // 故此处返回 `after`（解析后对象上的路径级违规），单次解析契约不变。
      return { value: parsed, violations: after };
    } catch {
      // 非 JSON 字符串：JSON.parse 抛出，回落到原值违规，交模型 repair。
    }
  }
  return { value: payload, violations: direct };
}

export function handleTurnEnded(seam: SubmitSeam, instance: InstanceRef, finalText: string): void {
  const node = seam.liveNode(instance);
  if (node === undefined || node.settled) return;
  if (!node.spec.typed) {
    seam.settleOk(node, finalText);
    return;
  }
  if (node.nudgesRemaining > 0) {
    node.nudgesRemaining--;
    seam.host.driver.respondToSubmit(instance, { kind: "nudge" });
    seam.host.record({ type: "node-nudged", instance });
    return;
  }
  seam.host.driver.cancelAsk(instance);
  seam.settleFailed(
    node,
    new WorkflowError(
      "ResultNotSubmitted",
      "The typed ask ended without a submit_result call, so there is no result.",
      { finalText },
    ),
  );
}

/**
 * ask 用量回报（原 AskScheduler.noteStats 的方法体；预算闸合入后调度器顶到 max-lines 门，
 * 按本文件既定的「向上回报处理」职责迁出，行为不变）。
 *
 * live 节点直接把 stats 挂在节点上（结算时随 nodeRecordFor 落库）。节点已离开 liveNodes
 * ——typed-accept 主导路径：submit 停 turn 并在 settle 时落库，而真实 actor 的用量在 turn
 * 解析后（submit 之后）才知道，故 stats 在结算之后才到达。回填已结算的 journal 记录：
 * 只新增/覆写 stats，保留 status/result/actorSeq/inputHash/error/kind/actor 身份。
 * 尽力而为且幂等；预算扣减仍在 engine.askStats（此处只补 journal 完整性）。
 */
export function handleNoteStats(
  seam: SubmitSeam,
  priorTranscriptAsks: ReadonlySet<string>,
  instance: InstanceRef,
  stats: AskStats,
): void {
  const node = seam.liveNode(instance);
  if (node !== undefined) {
    node.lastStats = stats;
    return;
  }
  const journal = seam.host.driver.journal;
  const recorded = journal.getNode(seam.host.runId, instance.siteId, instance.ordinal);
  if (recorded === undefined) return;
  journal.putNode({ ...recorded, stats: journaledStats(priorTranscriptAsks, instance, stats) });
}
