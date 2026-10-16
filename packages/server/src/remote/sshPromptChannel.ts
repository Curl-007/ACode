// 连接期提示通道：host-key challenge 一次性 challengeId 闭环的泛化。
// 规格见 packages/server/specs/ssh-prompt-mediation.md R4/R5 与
// packages/server/specs/ssh-host-key-trust.md「连接期提示通道（扩展节）」。
//
// 一次连接一个通道实例；通道是「对端已确认」状态与 pending 提示表的唯一
// 所有者。host_key 是第一个消费者：存量 SSHHostKeyChallengeHandler（含
// Desktop IPC 闭环）经 createHostKeyChallengePromptHandler 适配为通道
// handler，行为与既有测试保持不变。
import { randomUUID } from "node:crypto";
import {
  normalizeSSHHostKeyFingerprint,
  SSHHostKeyDecisionError,
  type SSHHostKeyChallenge,
  type SSHHostKeyChallengeHandler,
  type SSHHostKeyDecision,
  type SSHHostKeyVerificationStatus,
} from "@acode/server/remote/sshAuth.js";
import { sanitizeSSHPromptText } from "@acode/server/remote/sshPromptSanitize.js";
import {
  isSSHPromptReplyShape,
  normalizeSSHPromptAnswerValue,
  type SSHPromptAbortReason,
  type SSHPromptKind,
  type SSHPromptOutcome,
  type SSHPromptReply,
  type SSHSecretPromptKind,
} from "@acode/server/remote/sshPromptTypes.js";

export interface SSHPromptRequest {
  /** 一次性提示 id；应答必须回显，错位/重复应答 fail-closed。 */
  readonly promptId: string;
  readonly kind: SSHPromptKind;
  readonly host: string;
  readonly port: number;
  /** 应答是否属于凭据（UI 掩码输入 + 顺序闸治理范围）。 */
  readonly secret: boolean;
  /** 已消毒的提示文本；原始对端文本不得离开 server 包。 */
  readonly text: string;
  /** kind === "host_key" 时携带的结构化 challenge 载荷。 */
  readonly hostKeyChallenge?: SSHHostKeyChallenge;
}

export interface SSHPromptHandler {
  (request: SSHPromptRequest): Promise<SSHPromptReply>;
}

export interface SSHPromptChannelOptions {
  handler: SSHPromptHandler;
  host: string;
  port: number;
  /** 缺省不超时（host_key 等待用户裁决）；配置后超时按 expired 结算。 */
  promptTimeoutMs?: number;
  logWarn?: (message: string) => void;
  generatePromptId?: () => string;
}

export interface SSHPromptChannel {
  /** 对端 host key 是否已确认（trusted 裁决或用户经通道 approve/replace）。 */
  readonly peerConfirmed: boolean;
  /** verifier 裁决通知：trusted 打开顺序闸；其余状态不产生确认。 */
  notifyHostKeyOutcome(status: SSHHostKeyVerificationStatus): void;
  /** secret 类提示（passphrase/otp/generic）：受顺序闸治理，abort 走闭集。 */
  requestSecretPrompt(request: {
    kind: SSHSecretPromptKind;
    text: string;
    secret?: boolean;
  }): Promise<SSHPromptOutcome>;
  /** host_key 提示：决策绑定校验与 SSHBackend 现行规则一致。 */
  requestHostKeyDecision(challenge: SSHHostKeyChallenge): Promise<SSHHostKeyDecision>;
  /** 连接结束/取消：全部 pending 以 expired 结算，后续请求一律 expired。 */
  dispose(): void;
}

type PromptRoundResult =
  | { readonly status: "reply"; readonly reply: SSHPromptReply }
  | { readonly status: "abort"; readonly abort: SSHPromptAbortReason; readonly error?: unknown };

interface PendingPromptEntry {
  expire(): void;
}

function describeHostKeyChallengeText(challenge: SSHHostKeyChallenge): string {
  return challenge.status === "unknown"
    ? `首次连接 ${challenge.host}:${challenge.port}：该主机的 SSH 主机密钥未知，请核对指纹 ${challenge.candidateFingerprint} 后决定是否信任。`
    : `${challenge.host}:${challenge.port} 的 SSH 主机密钥与已记录的不一致（候选指纹 ${challenge.candidateFingerprint}）；为防止中间人攻击，需要你显式决定是否替换。`;
}

function hostKeyAbortDecisionMessage(abort: SSHPromptAbortReason): string {
  return abort === "expired"
    ? "SSH 主机密钥决策已过期，连接已拒绝"
    : "SSH 主机密钥决策无效或已过期，连接已拒绝";
}

export function createSSHPromptChannel(options: SSHPromptChannelOptions): SSHPromptChannel {
  let peerConfirmed = false;
  let disposed = false;
  const pending = new Map<string, PendingPromptEntry>();
  const nextPromptId = options.generatePromptId ?? ((): string => randomUUID());

  const runPromptRound = (request: SSHPromptRequest): Promise<PromptRoundResult> => {
    if (disposed) {
      return Promise.resolve({ status: "abort", abort: "expired" });
    }
    return new Promise<PromptRoundResult>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: PromptRoundResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        pending.delete(request.promptId);
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        resolve(result);
      };
      if (options.promptTimeoutMs != null && options.promptTimeoutMs > 0) {
        timeoutId = setTimeout(
          () => settle({ status: "abort", abort: "expired" }),
          options.promptTimeoutMs,
        );
      }
      pending.set(request.promptId, {
        expire: () => settle({ status: "abort", abort: "expired" }),
      });
      void (async () => {
        try {
          const reply = await options.handler(request);
          // promptId 一次性绑定：形状非法或错位应答一律按 expired 忽略（fail-closed）。
          if (!isSSHPromptReplyShape(reply) || reply.promptId !== request.promptId) {
            options.logWarn?.(
              `[ssh-prompt] reply ignored: promptId mismatch (kind=${request.kind})`,
            );
            settle({ status: "abort", abort: "expired" });
            return;
          }
          settle({ status: "reply", reply });
        } catch (error) {
          // handler 抛错：secret 提示按 dismissed fail-closed；host_key 由调用方
          // 转换成 SSHHostKeyDecisionError（保留 handler 原始 message 语义）。
          settle({ status: "abort", abort: "dismissed", error });
        }
      })();
    });
  };

  return {
    get peerConfirmed(): boolean {
      return peerConfirmed;
    },

    notifyHostKeyOutcome(status: SSHHostKeyVerificationStatus): void {
      // 只有 trusted 裁决产生「对端已确认」；revoked/changed 未获显式 replace
      // 前不打开顺序闸（ssh-host-key-trust.md 扩展节规则 3）。
      if (status === "trusted") {
        peerConfirmed = true;
      }
    },

    async requestSecretPrompt(request) {
      // 顺序闸：对端未经确认前，secret 类提示不展示、不交给 handler，直接 abort。
      if (!peerConfirmed) {
        return { answered: false, abort: "peer_unconfirmed" } as const;
      }
      const prompt: SSHPromptRequest = {
        promptId: nextPromptId(),
        kind: request.kind,
        host: options.host,
        port: options.port,
        secret: request.secret ?? true,
        text: sanitizeSSHPromptText(request.text),
      };
      const round = await runPromptRound(prompt);
      if (round.status === "abort") {
        return { answered: false, abort: round.abort };
      }
      const reply = round.reply;
      if ("abort" in reply) {
        return { answered: false, abort: "dismissed" };
      }
      if ("decision" in reply) {
        // secret 提示收到 decision 形状应答 = handler 违约 → 不可交付。
        return { answered: false, abort: "undeliverable" };
      }
      const normalized = normalizeSSHPromptAnswerValue(reply.value);
      if (normalized === null) {
        return { answered: false, abort: "undeliverable" };
      }
      if (prompt.secret && normalized.length === 0) {
        // secret 空应答视同用户放弃（与「password/pin 空串按 dismissed」语义对齐）。
        return { answered: false, abort: "dismissed" };
      }
      return { answered: true, value: normalized };
    },

    async requestHostKeyDecision(challenge) {
      const prompt: SSHPromptRequest = {
        promptId: nextPromptId(),
        kind: "host_key",
        host: challenge.host,
        port: challenge.port,
        secret: false,
        text: sanitizeSSHPromptText(describeHostKeyChallengeText(challenge)),
        hostKeyChallenge: challenge,
      };
      const round = await runPromptRound(prompt);
      if (round.status === "abort") {
        if (round.abort === "dismissed" && round.error !== undefined) {
          throw new SSHHostKeyDecisionError(
            round.error instanceof Error ? round.error.message : "SSH 主机密钥决策失败",
          );
        }
        throw new SSHHostKeyDecisionError(hostKeyAbortDecisionMessage(round.abort));
      }
      const reply = round.reply;
      if (!("decision" in reply)) {
        throw new SSHHostKeyDecisionError();
      }
      // 决策绑定校验（ssh-host-key-trust.md 规则 6）：challengeId 与候选
      // fingerprint 必须回显一致；缺失或不符 fail-closed。
      if (
        reply.challengeId !== challenge.challengeId ||
        normalizeSSHHostKeyFingerprint(reply.candidateFingerprint ?? "") !==
          challenge.candidateFingerprint
      ) {
        throw new SSHHostKeyDecisionError();
      }
      const action = reply.decision;
      if (action !== "reject") {
        if (
          (challenge.status === "unknown" && action !== "approve") ||
          (challenge.status === "changed" && action !== "replace")
        ) {
          throw new SSHHostKeyDecisionError(
            challenge.status === "unknown"
              ? "未知 SSH 主机密钥只能执行 approve"
              : "变化的 SSH 主机密钥必须显式 replace",
          );
        }
        // 用户对同一候选作出显式 approve/replace → 顺序闸打开。
        peerConfirmed = true;
      }
      return {
        challengeId: challenge.challengeId,
        action,
        candidateFingerprint: challenge.candidateFingerprint,
      } satisfies SSHHostKeyDecision;
    },

    dispose(): void {
      disposed = true;
      for (const entry of pending.values()) {
        entry.expire();
      }
      pending.clear();
    },
  };
}

/**
 * 把存量 SSHHostKeyChallengeHandler（Desktop requestId IPC 闭环等）适配为通道
 * handler：host_key 提示还原为 challenge 交给旧 handler，决策转回 reply 形状
 * （回显 challengeId/candidateFingerprint 供通道绑定校验）。非 host_key 提示
 * 该适配器不消费（按 dismissed 处理），由真实 UI/IPC handler 实现。
 */
export function createHostKeyChallengePromptHandler(
  handler: SSHHostKeyChallengeHandler,
): SSHPromptHandler {
  return async (request) => {
    if (request.kind !== "host_key" || !request.hostKeyChallenge) {
      return { promptId: request.promptId, abort: "dismissed" as const };
    }
    const decision = await handler(request.hostKeyChallenge);
    return {
      promptId: request.promptId,
      decision: decision.action,
      challengeId: decision.challengeId,
      candidateFingerprint: decision.candidateFingerprint,
    };
  };
}
