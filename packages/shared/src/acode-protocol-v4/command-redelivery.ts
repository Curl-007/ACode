// exactly-one commandId 取代语义：重投递同 commandId 取代在飞运行（abort 旧的 + 压制旧响应，
// 每 commandId 恰好一个业务终态）。spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R2。
//
// 不回退保证：CommandInbox 对在飞重投递的既有语义是 dedupe——duplicate 共享同一 final
// promise（command-terminal-state-audit.md R3 不变量 2）。取代是**闭集 opt-in**：默认集为空，
// 全部现役命令保持 dedupe；只有满足 R2 规则 4 三条验收的命令类型才可入集。
import type { CommandAck, CommandType } from "./command.js";

/**
 * 取代语义的命令闭集。初始为空是产品决策而非欠账：现役命令面没有一条声明重跑安全，
 * 取代 = 双重执行（inbox 审计的历史坑）；未来 staged/尝试型命令按 R2 规则 4 评审入集。
 */
export const SUPERSEDE_ON_REDELIVERY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>();

export type CommandRedeliveryDecision =
  /** 既有 dedupe：晚到者与在飞运行共享同一个 final（不回退）。 */
  | { action: "share-final" }
  /** abort 在飞运行 + 压制其业务响应，本投递按新 admission 接管。 */
  | { action: "supersede" };

/**
 * 重投递裁决的唯一入口。集合可注入是为测试与评审工具；生产消费方（CommandInbox）必须用
 * 默认闭集，不得按 host 各自配置——取代语义是协议事实，不是每连接可自选的口味。
 */
export function resolveCommandRedelivery(
  commandType: CommandType,
  supersedeCommands: ReadonlySet<CommandType> = SUPERSEDE_ON_REDELIVERY_COMMANDS,
): CommandRedeliveryDecision {
  return supersedeCommands.has(commandType) ? { action: "supersede" } : { action: "share-final" };
}

/** 旧投递收口的 reasonCode（`proto.*` = 协议道：旧运行的业务响应被压制，这不是业务终态）。 */
export const SUPERSEDED_BY_REDELIVERY_REASON_CODE = "proto.supersededByRedelivery" as const;

/**
 * 旧 wire 投递的 close-out ack：只为防止 RPC 悬挂。`status:"stale"` 复用既有枚举；它
 * **不得**进入 settled LRU 或持久事实——否则新运行的 lookupExact 会命中它短路成
 * duplicate，取代永远跑不起来（R2 规则 2）。
 */
export function buildSupersededCloseOutAck(
  commandId: string,
  revisionAtDecision: number,
): CommandAck {
  return {
    commandId,
    status: "stale",
    reasonCode: SUPERSEDED_BY_REDELIVERY_REASON_CODE,
    revisionAtDecision,
  };
}

/**
 * close-out 判别：admission/事实层用它把「被取代的旧投递收口」与业务终态分开——
 * 前者不 remember、不持久化、不参与 exactly-one 计数；后者每 commandId 恰好一个。
 */
export function isSupersededCloseOutAck(ack: CommandAck): boolean {
  return ack.status === "stale" && ack.reasonCode === SUPERSEDED_BY_REDELIVERY_REASON_CODE;
}
