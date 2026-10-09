import type { ConnectConfig } from "ssh2";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

export type SSHHostKeyVerificationStatus =
  | "trusted"
  | "unknown"
  | "changed"
  | "revoked"
  | "unavailable";

export type SSHHostKeyDecisionAction = "approve" | "replace" | "reject";

export interface SSHHostKeyChallenge {
  /** Per-handshake nonce. A decision is valid only for this exact challenge. */
  readonly challengeId: string;
  readonly host: string;
  readonly port: number;
  readonly status: Exclude<SSHHostKeyVerificationStatus, "trusted" | "unavailable" | "revoked">;
  readonly candidateFingerprint: string;
  readonly expectedFingerprints: readonly string[];
}

export interface SSHHostKeyDecision {
  readonly challengeId: string;
  readonly action: SSHHostKeyDecisionAction;
  readonly candidateFingerprint: string;
}

/** Candidate-aware trust result. `revoked` is an unconditional deny and never a UI challenge. */
export interface SSHHostKeyResolution {
  readonly status: SSHHostKeyVerificationStatus;
  readonly expectedFingerprints: readonly string[];
  /** Only managed trust entries written by an explicit replace may override a known_hosts change. */
  readonly allowKnownHostsOverride?: boolean;
}

export type SSHHostKeyChallengeHandler = (
  challenge: SSHHostKeyChallenge,
) => Promise<SSHHostKeyDecision>;

/**
 * Host 进程拥有已批准主机密钥；SSH adapter 只读，不在连接过程中写入信任记录。
 * 返回值必须是 `hostHash: "sha256"` 产生的完整 hash（例如 `SHA256:...`）。
 */
export interface SSHHostKeyTrust {
  refresh?(): Promise<void>;
  resolve(host: string, port: number): string | readonly string[] | undefined;
  /**
   * Resolve a concrete candidate before authentication. Implementations that can distinguish revoked
   * or changed records should provide this method; callers retain the legacy resolve fallback.
   */
  resolveCandidate?(
    host: string,
    port: number,
    candidateFingerprint: string,
  ): SSHHostKeyResolution;
  /**
   * Persist a user decision for the exact candidate challenge. The adapter never
   * invents a decision; stores must re-read under their own lock before writing.
   */
  commitDecision?(challenge: SSHHostKeyChallenge, action: Exclude<SSHHostKeyDecisionAction, "reject">): Promise<void>;
}

export function normalizeSSHHostKeyFingerprint(value: string): string {
  const trimmed = value.trim();
  // ssh2 的 hostHash: sha256 输出 hex，OpenSSH known_hosts 派生的是 SHA256:base64。
  // 两者是同一密钥摘要，必须归一化后比较，不能把所有已批准主机误报为 changed。
  return /^[a-f0-9]{64}$/iu.test(trimmed)
    ? `SHA256:${Buffer.from(trimmed, "hex").toString("base64").replace(/=+$/u, "")}`
    : trimmed;
}

export class SSHHostKeyVerificationError extends Error {
  readonly code:
    | "ssh-host-key-unknown"
    | "ssh-host-key-changed"
    | "ssh-host-key-revoked"
    | "ssh-host-key-trust-unavailable";
  readonly challenge?: SSHHostKeyChallenge;

  constructor(
    status: Exclude<SSHHostKeyVerificationStatus, "trusted">,
    challenge?: SSHHostKeyChallenge,
  ) {
    const code =
      status === "unknown"
        ? "ssh-host-key-unknown"
        : status === "changed"
          ? "ssh-host-key-changed"
          : status === "revoked"
            ? "ssh-host-key-revoked"
          : "ssh-host-key-trust-unavailable";
    super(
      status === "unknown"
        ? "SSH 主机密钥未受信任：首次连接必须先批准该主机密钥"
        : status === "changed"
          ? "SSH 主机密钥已变化：为防止中间人攻击，连接已拒绝"
          : status === "revoked"
            ? "SSH 主机密钥已撤销：连接已拒绝"
          : "SSH 主机密钥信任记录不可用：非交互连接已拒绝",
    );
    this.name = "SSHHostKeyVerificationError";
    this.code = code;
    this.challenge = challenge;
  }
}

export class SSHHostKeyDecisionError extends Error {
  readonly code = "ssh-host-key-decision-invalid" as const;

  constructor(message = "SSH 主机密钥决策无效或已过期，连接已拒绝") {
    super(message);
    this.name = "SSHHostKeyDecisionError";
  }
}

export interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
  hostKeyTrust?: SSHHostKeyTrust;
  onHostKeyDecision?: (
    status: SSHHostKeyVerificationStatus,
    keyHash: string,
    expectedFingerprints: readonly string[],
  ) => void;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;
  const port = input.port ?? 22;

  // 密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。
  // 某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽，导致正确密码也无法进入认证。
  // 这里改成“显式传入 agent 才启用”；否则密码模式默认禁用隐式 agent。
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时。
    // 这里显式放宽连接握手超时，既给真实慢连接机会，也让错误归一化能和实际配置保持一致。
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close。
    // 启用 SSH-level keepalive，让 ssh2 在连续无响应后主动触发 error/close，避免 UI 任务长期卡在 loading。
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // 一些 SSH 服务端只开启 keyboard-interactive（challenge-response）而关闭 plain password。
    // 开启 tryKeyboard + 交互回调后，同一份密码可以覆盖这类主机，避免“命令行可登录、应用里认证失败”。
    tryKeyboard: hasPassword,
    // Never let ssh2's permissive default accept an unverified host. The verifier
    // is synchronous by design so user authentication cannot start before this check.
    hostHash: "sha256",
    hostVerifier: createSSHHostKeyVerifier({
      host: input.host,
      port,
      trust: input.hostKeyTrust,
      onDecision: input.onHostKeyDecision,
    }),
  };
}

export function createSSHHostKeyVerifier(input: {
  host: string;
  port: number;
  trust?: SSHHostKeyTrust;
  onDecision?: (
    status: SSHHostKeyVerificationStatus,
    keyHash: string,
    expectedFingerprints: readonly string[],
  ) => void;
}): (keyHash: string) => boolean {
  const report = (
    status: SSHHostKeyVerificationStatus,
    keyHash: string,
    expectedFingerprints: readonly string[] = [],
  ): boolean => {
    try {
      input.onDecision?.(status, keyHash, expectedFingerprints);
    } catch {
      // A telemetry/observation callback cannot turn a failed verification into
      // an accepted host. Keep the verifier fail-closed and synchronous.
      return false;
    }
    return status === "trusted";
  };

  return (keyHash: string): boolean => {
    const normalizedCandidate = normalizeSSHHostKeyFingerprint(keyHash);
    if (!input.trust) {
      return report("unavailable", keyHash);
    }

    let resolution: SSHHostKeyResolution;
    try {
      resolution = input.trust.resolveCandidate
        ? input.trust.resolveCandidate(input.host, input.port, normalizedCandidate)
        : resolveLegacyCandidate(input.trust, input.host, input.port, normalizedCandidate);
    } catch {
      return report("unavailable", keyHash);
    }
    if (!isSSHHostKeyResolution(resolution)) {
      return report("unavailable", keyHash);
    }
    const expected = resolution.expectedFingerprints
      .map(normalizeSSHHostKeyFingerprint)
      .filter(Boolean);
    return report(resolution.status, keyHash, expected);
  };
}

function resolveLegacyCandidate(
  trust: SSHHostKeyTrust,
  host: string,
  port: number,
  candidateFingerprint: string,
): SSHHostKeyResolution {
  const expected = trust.resolve(host, port);
  if (expected === undefined) {
    return { status: "unknown", expectedFingerprints: [] };
  }
  const candidates = typeof expected === "string" ? [expected] : expected;
  if (!Array.isArray(candidates) || candidates.some((item) => typeof item !== "string")) {
    return { status: "unavailable", expectedFingerprints: [] };
  }
  const fingerprints = candidates.map(normalizeSSHHostKeyFingerprint).filter(Boolean);
  if (fingerprints.length === 0) {
    return { status: "unknown", expectedFingerprints: [] };
  }
  return {
    status: fingerprints.includes(candidateFingerprint) ? "trusted" : "changed",
    expectedFingerprints: fingerprints,
  };
}

function isSSHHostKeyResolution(value: unknown): value is SSHHostKeyResolution {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  const candidate = value as { status?: unknown; expectedFingerprints?: unknown };
  return (
    (candidate.status === "trusted" ||
      candidate.status === "unknown" ||
      candidate.status === "changed" ||
      candidate.status === "revoked" ||
      candidate.status === "unavailable") &&
    Array.isArray(candidate.expectedFingerprints) &&
    candidate.expectedFingerprints.every((item) => typeof item === "string")
  );
}

/** Compose host-owned stores while keeping revoked/changed known_hosts decisions authoritative. */
export function composeSSHHostKeyTrust(
  managed: SSHHostKeyTrust,
  knownHosts: SSHHostKeyTrust,
): SSHHostKeyTrust {
  return {
    async refresh() {
      await Promise.all([managed.refresh?.(), knownHosts.refresh?.()]);
    },
    resolve(host, port) {
      return managed.resolve(host, port) ?? knownHosts.resolve(host, port);
    },
    resolveCandidate(host, port, candidateFingerprint) {
      const known = resolveCandidateFromTrust(knownHosts, host, port, candidateFingerprint);
      if (known.status === "unavailable" || known.status === "revoked") {
        return known;
      }
      const managedResult = resolveCandidateFromTrust(
        managed,
        host,
        port,
        candidateFingerprint,
      );
      if (managedResult.status === "unavailable") {
        return managedResult;
      }
      if (known.status === "changed") {
        return managedResult.status === "trusted" && managedResult.allowKnownHostsOverride
          ? managedResult
          : known;
      }
      if (known.status === "trusted") {
        return known;
      }
      return managedResult.status === "unknown" ? known : managedResult;
    },
    commitDecision: managed.commitDecision,
  };
}

function resolveCandidateFromTrust(
  trust: SSHHostKeyTrust,
  host: string,
  port: number,
  candidateFingerprint: string,
): SSHHostKeyResolution {
  try {
    const resolution = trust.resolveCandidate
      ? trust.resolveCandidate(host, port, candidateFingerprint)
      : resolveLegacyCandidate(trust, host, port, candidateFingerprint);
    return isSSHHostKeyResolution(resolution)
      ? resolution
      : { status: "unavailable", expectedFingerprints: [] };
  } catch {
    return { status: "unavailable", expectedFingerprints: [] };
  }
}

export function createKeyboardInteractiveResponder(password?: string) {
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    finish(prompts.map(() => password));
  };
}

export function normalizeSSHConnectError(error: unknown): Error {
  if (error instanceof SSHHostKeyVerificationError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    return new Error("SSH 认证失败：请检查用户名、密码或私钥配置");
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  if (error instanceof Error) {
    // ssh2 对不同私钥格式（OpenSSH 旧/新格式、PPK）会返回不同文案。
    // 之前仅匹配单一字符串，导致部分“缺少口令/口令错误”场景泄露底层错误文本，用户难以判断应输入哪种凭据。
    // 这里改为模式化归一化，把同类错误稳定映射成产品语义提示，便于用户直接修正输入。
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令");
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确");
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH 连接失败");
}
