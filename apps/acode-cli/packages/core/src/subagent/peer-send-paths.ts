// 编排方案 Phase 3-5（specs/agent-peer-messaging.md / agent-peer-messaging-cross-process.md /
// agent-peer-tree-addressing.md）：peer 发送的两条非本地路径与共享辅助——从
// peer-messaging.ts 拆出（max-lines 400 纪律），port 工厂与本地 sink 路径留在那里。
// 依赖方向单向：peer-messaging → 本文件；本文件只 type-import 回 peer-messaging 的
// 对外类型（无运行时回边）。
//
// 设计红线（与 P0 spec 逐条对应，两路径同样适用）：
// - R7/peer-1：mailbox 路径只触文件系统（store-and-forward，零即时算力）；树表路径
//   只经目标侧 registry 的既有三语义单点投递——两条路径都不得 import resume 面，
//   终态目标一律结构化拒绝。
// - R8/R3：双维度限速（sender 20/60s + pair 10/60s）三路径共享同一窗口表——
//   claimRate 由 port 工厂闭包持有并经 PeerSendContext 传入，改道绕不开限额。
// - R6/R5：4096 截断同源常量、围栏单源（formatPeerMessageEnvelope 与 sink 注入共用）、
//   镜像每成功受理一次且失败吞掉留痕。

import type { Logger, SessionId, SubagentSendMessageResult, TraceContext } from "@acode/contracts";
import { MAX_SEND_MESSAGE_MODEL_BYTES } from "../tool/handlers/send-message.js";
import {
  escapeXml,
  isTerminalRuntimeTask,
  type RuntimeTaskPendingMessage,
} from "../runtime-task/contract.js";
import { deliverPendingMessageViaSink } from "./message-delivery.js";
import { formatPeerMessageEnvelope } from "./message-steering.js";
import { lookupTreeAddress } from "./tree-addressing.js";

export interface PeerSendMessageInput {
  message: string;
  summary: string;
  to: string;
  toolCallId?: string;
  traceContext: TraceContext;
}

/** R5 镜像回调入参：text 是 escapeXml 信封全文，metadata 供冷目录/GUI 结构化读取。 */
export interface PeerMirrorInput {
  metadata: Record<string, unknown>;
  text: string;
  traceContext: TraceContext;
}

/**
 * 跨进程 mailbox 写入接缝（cross-process spec R1/R2，duck-typing 窄面不进 contracts）：
 * subagent.ts 以 deps.sessionMailboxPort + deps.sessionStore 闭包铸造。
 * resolveTargetSession = 恒等式推导 childSessionId + getSession 存在性校验，miss 返回
 * undefined（零写副作用）。
 */
export interface PeerMailboxWriteSeam {
  deliver(input: {
    content: string;
    fromSessionId: SessionId;
    messageId: string;
    toSessionId: SessionId;
  }): Promise<void>;
  resolveTargetSession(agentId: string): Promise<SessionId | undefined>;
}

export interface PeerMailboxOptions {
  /** 发送方 child session id——runner 在 port 构造期铸造（lifecycle 事实），模型不可伪造。 */
  senderSessionId: SessionId;
  seam: PeerMailboxWriteSeam;
}

/** 整树寻址（tree-addressing spec R1）：树根键——每层以 rootSessionId ?? sessionId 机械自算。 */
export interface PeerTreeAddressingOptions {
  rootKey: string;
}

/** 两条路径共享的 port 侧上下文（工厂闭包铸造；claimRate = P0 R8 的窗口表）。 */
export interface PeerSendContext {
  agentId: string;
  agentType: string;
  claimRate: (key: string, limit: number, nowMs: number) => PeerRateClaim;
  logger?: Logger;
  mirror?: (input: PeerMirrorInput) => Promise<void>;
  parentSessionId: SessionId;
}

export type PeerRateClaim = { ok: true } | { ok: false; retryAfterMs: number };

/** R8 限额常量（窗口对齐 60s；MAILBOX_DRAIN_LIMIT=20 与 steer 重试上限 20 的同款量级先例）。 */
export const PEER_SEND_WINDOW_MS = 60_000;
export const PEER_SEND_MAX_PER_WINDOW = 20;
export const PEER_PAIR_MAX_PER_WINDOW = 10;

/** 限速拒绝文案：sink / mailbox / 树表三路径共用（共享闸的语义显式化，不立第二份）。 */
export function senderRateLimitText(retryAfterMs: number): string {
  return `Peer message rate limit reached for this agent. Retry after ~${Math.ceil(retryAfterMs / 1000)}s, or batch fewer, longer messages.`;
}

export function pairRateLimitText(to: string, retryAfterMs: number): string {
  return `Peer message rate limit reached for the conversation with ${to}. Retry after ~${Math.ceil(retryAfterMs / 1000)}s; do not keep a ping-pong exchange going — summarize and send once.`;
}

/** R6.3：模型可见截断（与 SendMessage maxOutputBytes 同源常量，不另立第二份）。 */
export function truncateForModel(message: string): string {
  return message.length > MAX_SEND_MESSAGE_MODEL_BYTES
    ? message.slice(0, MAX_SEND_MESSAGE_MODEL_BYTES)
    : message;
}

/**
 * peer 挂起消息的单源构造（本地 sink 与跨层树表投递共用）。R3：hop 恒 1——无自动
 * 转发，每条消息都是发送方模型的独立决策（tree-addressing spec 取舍 #2）。
 */
export function createPeerPendingMessage(input: {
  agentId: string;
  message: string;
  messageId: string;
  nowMs: number;
  send: PeerSendMessageInput;
}): RuntimeTaskPendingMessage {
  return {
    id: input.messageId,
    isMeta: true,
    message: input.message,
    origin: {
      agentId: input.agentId,
      hop: 1,
      kind: "peer",
      ...(input.send.toolCallId === undefined ? {} : { toolCallId: input.send.toolCallId }),
    },
    queuedAt: new Date(input.nowMs),
    summary: input.send.summary,
    traceContext: input.send.traceContext,
  };
}

/**
 * 镜像文本（R5/R6.2）：escapeXml 信封——peer 内容是兄弟模型产出（不可信数据），
 * 落父会话的镜像同样不给「指令」以裸文本形态。呈现 guidance（PEER_PERMISSION_GUIDANCE
 * 等）由 presentation 层负责（incoming-message.ts），镜像只背事实。
 */
export function formatPeerMirrorText(input: {
  from: string;
  message: string;
  summary: string;
  to: string;
}): string {
  return [
    "<peer-message-mirror>",
    `<from-agent-id>${escapeXml(input.from)}</from-agent-id>`,
    `<to-agent-id>${escapeXml(input.to)}</to-agent-id>`,
    `<summary>${escapeXml(input.summary)}</summary>`,
    `<message>${escapeXml(input.message)}</message>`,
    "</peer-message-mirror>",
  ].join("\n");
}

/** 镜像失败吞掉留痕（观察面纪律），不阻断投递。 */
export function warnPeerMirrorFailure(
  context: PeerSendContext,
  error: unknown,
  to: string,
): void {
  context.logger?.warn("Failed to persist peer message mirror", {
    errorMessage: error instanceof Error ? error.message : String(error),
    event: "subagent.peer.mirror_failed",
    from: context.agentId,
    module: "core.subagent",
    status: "failed",
    to,
  });
}

/**
 * 跨进程 store-and-forward（cross-process spec R2-R6）。唯一副作用 = mailbox 落盘；
 * 消费时机由目标会话自己的 hook 点决定（R3——本路径没有任何即时投递/复活语义）。
 */
export async function sendPeerViaMailbox(
  context: PeerSendContext,
  mailbox: PeerMailboxOptions,
  input: PeerSendMessageInput,
  messageId: string,
  fail: (error: string) => SubagentSendMessageResult,
): Promise<SubagentSendMessageResult> {
  // R2：恒等式推导 + 存在性校验；miss 结构化拒绝，零写副作用。
  const toSessionId = await mailbox.seam.resolveTargetSession(input.to);
  if (toSessionId === undefined) {
    return fail(
      `No agent ${input.to} is reachable from this session: it is not a live sibling here, and no session exists for that agent id. To reach anyone else, respond to your coordinator via RespondToCoordinator.`,
    );
  }
  // R4：限速与 sink 路径共享窗口表——「改走 mailbox」绕不开限额。
  const nowMs = Date.now();
  const senderRate = context.claimRate(
    `sender:${context.agentId}`,
    PEER_SEND_MAX_PER_WINDOW,
    nowMs,
  );
  if (!senderRate.ok) {
    return fail(senderRateLimitText(senderRate.retryAfterMs));
  }
  const pairRate = context.claimRate(
    `pair:${context.agentId}->${input.to}`,
    PEER_PAIR_MAX_PER_WINDOW,
    nowMs,
  );
  if (!pairRate.ok) {
    return fail(pairRateLimitText(input.to, pairRate.retryAfterMs));
  }
  // R5：4096 同源截断 + 信封围栏单源（与 sink 注入共用 formatPeerMessageEnvelope）。
  const message = truncateForModel(input.message);
  try {
    await mailbox.seam.deliver({
      content: formatPeerMessageEnvelope({
        agentId: context.agentId,
        message,
        summary: input.summary,
      }),
      fromSessionId: mailbox.senderSessionId,
      messageId,
      toSessionId,
    });
  } catch (error) {
    // IO 失败 = 结构化 failed：不伪装成功、不自动重试（重试语义归模型决策）。
    context.logger?.warn("Failed to persist peer message to session mailbox", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.peer.mailbox_deliver_failed",
      from: context.agentId,
      module: "core.subagent",
      status: "failed",
      to: input.to,
    });
    return fail(
      `Mailbox delivery to agent ${input.to} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // R6：受理成功即镜像落发送方父会话（失败吞掉留痕，不回滚投递）。
  if (context.mirror) {
    try {
      await context.mirror({
        metadata: {
          peerMessage: {
            delivery: "persisted_mailbox",
            from: context.agentId,
            fromAgentType: context.agentType,
            messageId,
            parentSessionId: String(context.parentSessionId),
            summary: input.summary,
            to: input.to,
            toSessionId: String(toSessionId),
          },
        },
        text: formatPeerMirrorText({
          from: context.agentId,
          message,
          summary: input.summary,
          to: input.to,
        }),
        traceContext: input.traceContext,
      });
    } catch (error) {
      warnPeerMirrorFailure(context, error, input.to);
    }
  }
  return {
    agentId: input.to,
    delivery: "persisted_mailbox",
    message: `Message ${messageId} was persisted to the session mailbox for agent ${input.to}; it will be delivered when that session next runs.`,
    messageId,
    status: "success",
  };
}

/**
 * 同树跨层 live 投递（tree-addressing spec R2-R4）。返回 undefined = 表项 miss 或
 * stale（瞬态事实不是错误），调用方降级到 mailbox/拒绝链；终态目标显式拒绝
 * （R7 延伸——settled-unregister 竞态窗口内也不复活算力）。
 */
export async function sendPeerViaTreeAddress(
  context: PeerSendContext,
  addressing: PeerTreeAddressingOptions,
  input: PeerSendMessageInput,
  messageId: string,
  fail: (error: string) => SubagentSendMessageResult,
): Promise<SubagentSendMessageResult | undefined> {
  // R1 域闸：只在发送方自己树的键下查询——跨树 agentId 结构性 miss。
  const entry = lookupTreeAddress({ agentId: input.to, rootKey: addressing.rootKey });
  if (entry === undefined) return undefined;
  const remoteTask = entry.registry.get(input.to);
  if (remoteTask === undefined || remoteTask.type !== "local_agent") return undefined;
  if (isTerminalRuntimeTask(remoteTask)) {
    return fail(
      `Agent ${input.to} has stopped (${remoteTask.status}). Peer messages cannot resume stopped agents; if this work must continue, ask your coordinator via RespondToCoordinator to re-dispatch it.`,
    );
  }
  // R3：限速三路径共享同一窗口表——本地/跨层/mailbox 改道都绕不开限额。
  const nowMs = Date.now();
  const senderRate = context.claimRate(
    `sender:${context.agentId}`,
    PEER_SEND_MAX_PER_WINDOW,
    nowMs,
  );
  if (!senderRate.ok) {
    return fail(senderRateLimitText(senderRate.retryAfterMs));
  }
  const pairRate = context.claimRate(
    `pair:${context.agentId}->${input.to}`,
    PEER_PAIR_MAX_PER_WINDOW,
    nowMs,
  );
  if (!pairRate.ok) {
    return fail(pairRateLimitText(input.to, pairRate.retryAfterMs));
  }
  const message = truncateForModel(input.message);
  const pending = createPeerPendingMessage({
    agentId: context.agentId,
    message,
    messageId,
    nowMs,
    send: input,
  });
  // R2：投递复用既有三语义单点——目标侧 registry 是表项事实，不是句柄透传。
  const delivery = await deliverPendingMessageViaSink(entry.registry, remoteTask, pending);
  // R4：镜像逐级向各自父收口——落发送方直接父会话（mirror 回调 owner），
  // metadata 带 toAgentSessionId 供冷目录归属。失败吞掉留痕，不阻断投递。
  if (context.mirror) {
    try {
      await context.mirror({
        metadata: {
          peerMessage: {
            delivery,
            from: context.agentId,
            fromAgentType: context.agentType,
            messageId,
            parentSessionId: String(context.parentSessionId),
            summary: input.summary,
            to: input.to,
            toAgentSessionId: String(entry.childSessionId),
          },
        },
        text: formatPeerMirrorText({
          from: context.agentId,
          message,
          summary: input.summary,
          to: input.to,
        }),
        traceContext: input.traceContext,
      });
    } catch (error) {
      warnPeerMirrorFailure(context, error, input.to);
    }
  }
  return {
    agentId: remoteTask.agentId,
    delivery,
    message: `Message ${messageId} was ${delivery} for peer agent ${remoteTask.agentId}.`,
    messageId,
    status: "success",
  };
}
