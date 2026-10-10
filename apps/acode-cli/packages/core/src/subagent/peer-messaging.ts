// 编排方案 Phase 3 / P0（specs/agent-peer-messaging.md R1-R8）：进程内同父兄弟的 peer
// 消息窄面。设计红线（逐条对应 spec）：
// - R1 窄面：只暴露 listPeers（父 registry 的派生只读投影）+ sendMessage（定向投递）；
//   不透传 registry 句柄、不含 stop/cancel、不含跨父寻址——「父中介」收口的侵蚀面被
//   压到「同父兄弟定向发消息」一条能力上。
// - R2 寻址域：本 port 由父 registry 闭包构造，同父性是构造保证；仍校验目标是
//   local_agent 且非自己（防错址与自环）。
// - R7 peer 不得触发 resume：终态目标结构化拒绝（兄弟复活 = 算力/计费提权，peer-1；
//   审计 §6.1 已核实闲时轮复活路径的泄漏面）。本文件不得 import 任何 resume 路径。
// - R8 双维度速率限制：发送方 20/60s + 会话对 10/60s；A→B→A 的模型中介乒乓由联合
//   限额封顶。计数器是 run 生命周期内存态，不持久化（风暴守卫不是审计事实）。
// - R5 持久镜像：成功受理即回调 mirror 落父会话；镜像失败吞掉留痕，不阻断投递。
//
// 两条非本地路径（P1 跨进程 mailbox store-and-forward、P2 同树跨层树表 live 投递）
// 与其共享辅助在 peer-send-paths.ts（max-lines 纪律拆分，依赖方向单向）；查询顺序
// 固定：本地 registry → 树表 → mailbox → 拒绝（tree-addressing spec R2，即时性
// 递减），接缝全缺席时拒绝文案与 P0 逐字节一致（R0）。

import {
  createMessageId,
  type Logger,
  type SessionId,
  type SubagentSendMessageResult,
} from "@acode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/contract.js";
import { deliverPendingMessageViaSink } from "./message-delivery.js";
import {
  createPeerPendingMessage,
  formatPeerMirrorText,
  pairRateLimitText,
  PEER_PAIR_MAX_PER_WINDOW,
  PEER_SEND_MAX_PER_WINDOW,
  PEER_SEND_WINDOW_MS,
  sendPeerViaMailbox,
  sendPeerViaTreeAddress,
  senderRateLimitText,
  truncateForModel,
  warnPeerMirrorFailure,
  type PeerMailboxOptions,
  type PeerMirrorInput,
  type PeerRateClaim,
  type PeerSendContext,
  type PeerSendMessageInput,
  type PeerTreeAddressingOptions,
} from "./peer-send-paths.js";

// 类型再导出：runner.ts / subagent.ts / 测试沿用本文件为 peer 面的唯一 import 点。
export type {
  PeerMailboxOptions,
  PeerMailboxWriteSeam,
  PeerMirrorInput,
  PeerSendMessageInput,
  PeerTreeAddressingOptions,
} from "./peer-send-paths.js";

export interface PeerInfo {
  agentId: string;
  agentType?: string;
  description?: string;
  status: string;
}

export interface PeerMessagingPort {
  listPeers(): PeerInfo[];
  sendMessage(input: PeerSendMessageInput): Promise<SubagentSendMessageResult>;
}

interface RateWindow {
  count: number;
  windowStartMs: number;
}

export function createPeerMessagingPort(options: {
  agentId: string;
  agentType: string;
  logger?: Logger;
  mailbox?: PeerMailboxOptions;
  mirror?: (input: PeerMirrorInput) => Promise<void>;
  parentSessionId: SessionId;
  registry: RuntimeTaskRegistry;
  treeAddressing?: PeerTreeAddressingOptions;
}): PeerMessagingPort {
  // 速率窗口表：键 = `sender:<agentId>` 或 `pair:<from>-><to>`；固定窗口，过期重开。
  // 三路径（本地 sink / 树表 / mailbox）共享本表——改道绕不开限额。
  const rateWindows = new Map<string, RateWindow>();

  const claimRate = (
    key: string,
    limit: number,
    nowMs: number,
  ): PeerRateClaim => {
    const entry = rateWindows.get(key);
    if (entry === undefined || nowMs - entry.windowStartMs >= PEER_SEND_WINDOW_MS) {
      rateWindows.set(key, { count: 1, windowStartMs: nowMs });
      return { ok: true };
    }
    if (entry.count >= limit) {
      return { ok: false, retryAfterMs: PEER_SEND_WINDOW_MS - (nowMs - entry.windowStartMs) };
    }
    entry.count += 1;
    return { ok: true };
  };

  const siblingTasks = (): RuntimeTaskSnapshot[] =>
    Object.values(options.registry.all()).filter(
      (task): task is RuntimeTaskSnapshot =>
        task.type === "local_agent" && task.agentId !== options.agentId,
    );

  // 两条非本地路径的共享上下文（工厂闭包铸造一次）。
  const context: PeerSendContext = {
    agentId: options.agentId,
    agentType: options.agentType,
    claimRate,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.mirror ? { mirror: options.mirror } : {}),
    parentSessionId: options.parentSessionId,
  };

  return {
    listPeers(): PeerInfo[] {
      return siblingTasks().map((task) => ({
        agentId: task.agentId,
        ...(task.agentType ? { agentType: task.agentType } : {}),
        ...(task.description ? { description: task.description } : {}),
        status: task.status,
      }));
    },

    async sendMessage(input: PeerSendMessageInput): Promise<SubagentSendMessageResult> {
      const messageId = createMessageId();
      const fail = (error: string): SubagentSendMessageResult => ({
        error,
        messageId,
        status: "failed",
      });

      // R2：寻址域校验。域外目标（自己/非兄弟/不存在）结构化拒绝，指引父协调单路径。
      if (input.to === options.agentId) {
        return fail("Cannot send a peer message to yourself.");
      }
      const task = options.registry.get(input.to);
      if (task === undefined || task.type !== "local_agent") {
        // 三级链查询顺序固定（tree-addressing spec R2），每一步 miss 才走下一步。
        if (task === undefined && options.treeAddressing !== undefined) {
          const treeResult = await sendPeerViaTreeAddress(
            context,
            options.treeAddressing,
            input,
            messageId,
            fail,
          );
          if (treeResult !== undefined) return treeResult;
        }
        if (task === undefined && options.mailbox !== undefined) {
          return sendPeerViaMailbox(context, options.mailbox, input, messageId, fail);
        }
        return fail(
          `No sibling agent ${input.to} is reachable from this session. Peer messages can only address agents spawned by the same coordinator; to reach anyone else, respond to your coordinator via RespondToCoordinator.`,
        );
      }
      // R7（peer-1，阻塞级）：终态目标一律拒绝——peer 不得复活已停 agent 的算力/计费。
      if (isTerminalRuntimeTask(task)) {
        return fail(
          `Agent ${input.to} has stopped (${task.status}). Peer messages cannot resume stopped agents; if this work must continue, ask your coordinator via RespondToCoordinator to re-dispatch it.`,
        );
      }
      // R8：双维度速率限制（发送方 + 会话对）。
      const nowMs = Date.now();
      const senderRate = claimRate(`sender:${options.agentId}`, PEER_SEND_MAX_PER_WINDOW, nowMs);
      if (!senderRate.ok) {
        return fail(senderRateLimitText(senderRate.retryAfterMs));
      }
      const pairRate = claimRate(
        `pair:${options.agentId}->${input.to}`,
        PEER_PAIR_MAX_PER_WINDOW,
        nowMs,
      );
      if (!pairRate.ok) {
        return fail(pairRateLimitText(input.to, pairRate.retryAfterMs));
      }

      // R6.3：模型可见截断 + R3 origin（peer/hop=1），与两条非本地路径单源。
      const message = truncateForModel(input.message);
      const pending = createPeerPendingMessage({
        agentId: options.agentId,
        message,
        messageId,
        nowMs,
        send: input,
      });

      // R4：复用既有投递语义（steered/queued）；queued 由 turn 起点 drain 补投。
      const delivery = await deliverPendingMessageViaSink(options.registry, task, pending);

      // R5：持久镜像落共同父会话（冷目录看得到 peer 流量）。失败吞掉留痕，不阻断投递。
      if (options.mirror) {
        try {
          await options.mirror({
            metadata: {
              peerMessage: {
                delivery,
                from: options.agentId,
                fromAgentType: options.agentType,
                messageId,
                parentSessionId: String(options.parentSessionId),
                summary: input.summary,
                to: input.to,
              },
            },
            text: formatPeerMirrorText({
              from: options.agentId,
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
        agentId: task.agentId,
        delivery,
        message: `Message ${messageId} was ${delivery} for peer agent ${task.agentId}.`,
        messageId,
        status: "success",
      };
    },
  };
}
