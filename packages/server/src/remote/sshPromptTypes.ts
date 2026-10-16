// 连接期提示通道的自足词汇表（种类/abort/结果闭集）。
// 规格见 packages/server/specs/ssh-prompt-mediation.md。
//
// 本文件是叶子模块：不 import 任何 sshAuth/通道实现，供 keyboard-interactive
// 应答器与提示通道共同消费，避免 auth → keyboard-interactive → types → auth 环。

/** 提示种类闭集。host_key 是通道的第一消费者（见 ssh-host-key-trust.md 扩展节）。 */
export type SSHPromptKind = "host_key" | "passphrase" | "otp" | "generic";

/** 需要真人应答、应答值属于凭据的提示种类（受顺序闸治理）。 */
export type SSHSecretPromptKind = Exclude<SSHPromptKind, "host_key">;

/**
 * abort 闭集：
 * - peer_unconfirmed：顺序闸——对端 host key 未经确认前 secret 提示不展示；
 * - dismissed：用户关闭/拒绝，或 handler 抛错（fail-closed 视同拒绝）；
 * - undeliverable：应答无法交付（超过 1023 字节上限、应答形状非法）；
 * - expired：promptId 过期（通道 dispose、超时、迟到应答）。
 */
export type SSHPromptAbortReason =
  | "peer_unconfirmed"
  | "dismissed"
  | "undeliverable"
  | "expired";

export type SSHPromptOutcome =
  | { readonly answered: true; readonly value: string }
  | { readonly answered: false; readonly abort: SSHPromptAbortReason };

/**
 * handler 应答形状（与 UI wire 形状一致，见 spec「UI 接口形状」）。
 * promptId 一次性；错位/重复应答由通道忽略并 fail-closed。
 */
export type SSHPromptReply =
  | { readonly promptId: string; readonly value: string }
  | { readonly promptId: string; readonly abort: "dismissed" }
  | {
      readonly promptId: string;
      readonly decision: "approve" | "replace" | "reject";
      /** host_key 决策绑定回显；通道校验与 challenge 一致，缺失或不符 fail-closed。 */
      readonly challengeId?: string;
      readonly candidateFingerprint?: string;
    };

/** 应答剥除的字符（\r \n \0）与字节上限：与 ssh askpass 交付边界对齐。 */
export const SSH_PROMPT_ANSWER_MAX_BYTES = 1023;

export function isSSHPromptReplyShape(value: unknown): value is SSHPromptReply {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { promptId?: unknown };
  return typeof candidate.promptId === "string" && candidate.promptId.length > 0;
}

/** 应答归一：剥 \r\n\0；超 1023 字节返回 null（undeliverable）。 */
export function normalizeSSHPromptAnswerValue(raw: string): string | null {
  // 用 replaceAll 而非控制字符正则：语义相同（剥 \r \n NUL），避免 no-control-regex 告警。
  const stripped = raw.replaceAll("\r", "").replaceAll("\n", "").replaceAll("\0", "");
  if (Buffer.byteLength(stripped, "utf8") > SSH_PROMPT_ANSWER_MAX_BYTES) {
    return null;
  }
  return stripped;
}
