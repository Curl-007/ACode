// ============================================================
// jcode 桥接：V4GatewayHost 实现（spec R1 北向复用 / 接口节）
//
// 复用现有 ConversationV4Gateway（约 2.4 万行投影/inbox/attachment 账本），shim 只提供
// 它的南向 host：3 个必选方法 + 少量建议可选方法。其余可选方法（sessions-index/
// workflow/cua/network-capture）**全部不实现**——网关对缺席的可选方法优雅降级为 no-op
// （v4-gateway.ts:245/280/299 反复声明），对应面板降级但不阻断对话主链（spec「未做与取舍」）。
//
// 关键：executeCommand 委托 command-translator，必须恰好 settle 一次（spec R5）——
// 成功 return、失败 throw，绝不返回悬挂 promise，否则 CommandInbox 的 per-session
// FIFO gate 永久卡死。
// ============================================================

import type { Logger } from "@acode/contracts";
import { V4_NOTIFICATIONS } from "@acode/shared/acode-protocol-v4";
import type { V4GatewayHost } from "@acode/bootstrap";
import type { CommandEnvelope, CommandResult } from "@acode/shared/acode-protocol-v4";

import { executeJcodeCommand, type JcodeBridgeRuntime } from "./command-translator.js";
import type { JcodeSessionMap } from "./session-map.js";

/** emitWireFrame 的下游：把物理帧包进 conversationFrame 通知写到 stdout。 */
export type WireFrameSink = (frame: unknown) => void;

export interface CreateJcodeHostOptions {
  runtime: JcodeBridgeRuntime;
  sessions: JcodeSessionMap;
  /** 出帧口（entry.ts 回填 connection.send）。 */
  sendWireFrame: WireFrameSink;
  logger?: Logger;
}

/**
 * 构造 V4GatewayHost。
 *
 * loadPersistedEvents 返回安全空基线：网关据此走 live hydration 路径（非冷恢复），
 * 缺席会退空基线也不 reject（v4-gateway.ts:3072-3084）；这里显式返回同形状，语义更清晰。
 * resumePersistedSession **不实现**：shim 无持久状态（spec R3），冷订阅（sessionExists=false）
 * 应 reject sessionNotFound，符合「重启即新映射」的诚实边界。
 */
export function createJcodeHost(options: CreateJcodeHostOptions): V4GatewayHost {
  const { runtime, sessions, sendWireFrame, logger } = options;
  return {
    // inbox 的 sessionNotFound 裁决依据：会话是否在本进程映射表内。
    sessionExists: (sessionId: string) => sessions.has(sessionId),

    // 北向唯一出口：网关把物理帧交给这里，包进 conversationFrame 通知写 stdout。
    emitWireFrame: (frame) => {
      sendWireFrame({ method: V4_NOTIFICATIONS.conversationFrame, params: frame });
    },

    // 命令副作用执行口 → command-translator → jcode ACP。恰好 settle 一次（R5）。
    executeCommand: (
      envelope: CommandEnvelope,
      _admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
    ): Promise<CommandResult | undefined> => executeJcodeCommand(runtime, envelope),

    // live hydration 安全空基线：无持久事件、非合成、水位 0（网关据此不 reject）。
    loadPersistedEvents: async () => ({ events: [], synthesized: false, sourceEventSeq: 0 }),

    // 诊断走 logger（entry.ts 接到 stderr）；错误不静默（spec R5 onError 留痕）。
    onDebug: (message: string) => logger?.debug(message),
    onError: (scope: string, error: unknown) => {
      logger?.error(
        `jcode bridge v4 host error [${scope}]`,
        error instanceof Error ? error : new Error(String(error)),
      );
    },
  };
}
