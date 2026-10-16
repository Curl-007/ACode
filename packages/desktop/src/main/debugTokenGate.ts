/**
 * 签名短时调试令牌门（specs/desktop-startup-hardening.md §3）。
 *
 * 打包态的调试/E2E 能力不再「env 说是测试就是测试」：必须持有对应用内嵌 ed25519
 * 公钥可验签、且绑定当前 userData 覆写路径、5 分钟内有效的三段令牌
 * `<unix毫秒>.<base64url(userDataPath)>.<base64url(签名)>`。
 * 私钥永不入仓库，签发工具见 packages/desktop/scripts/issue-debug-token.mjs。
 *
 * 本模块只依赖 node:crypto（保持 boot 早期可加载、可脱离 Electron 单测）。
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";

export const DEBUG_TOKEN_ENV_KEY = "ACODE_DEBUG_TOKEN";
/** 令牌 payload 必须等于该身份覆写键的取值（成对出现约束，见 spec §3）。 */
export const DEBUG_TOKEN_PATH_CLAIM_ENV_KEY = "ACODE_DESKTOP_USER_DATA_DIR";

/** 令牌最大年龄：300s。 */
export const MAX_DEBUG_TOKEN_AGE_MS = 300_000;
/** 时钟 skew 容忍：签发钟快 60s 以内不按「未来令牌」拒绝。 */
export const DEBUG_TOKEN_CLOCK_SKEW_MS = 60_000;

/**
 * 内嵌 ed25519 公钥（SPKI DER 的 base64）。数组形态支持轮换期新旧双钥并存。
 * 更换密钥对：用 issue-debug-token.mjs --generate-keypair 生成，替换此常量并发版；
 * 对应私钥只保存在签发方本地（默认 ~/.acode/dev/acode-debug-token-signing-key.pem）。
 */
export const EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEAv5lhLrxcqifB981f7lHWfKrNSQSUBLgUqQPgIMnI7mk=",
];

/** 失败原因闭集（spec §3）；「无令牌」不是失败原因。 */
export type DebugTokenRejectionReason =
  | "malformed"
  | "path_mismatch"
  | "expired"
  | "invalid_signature";

export type DebugTokenVerification =
  | { valid: true }
  | { valid: false; reason: DebugTokenRejectionReason };

export interface VerifySignedDebugTokenOptions {
  /** 注入时钟（测试用）；缺省 Date.now()。 */
  now?: () => number;
  /** 注入公钥集合（测试用）；缺省内嵌公钥。 */
  publicKeys?: readonly string[];
}

function isFiniteIntegerText(value: string): boolean {
  return /^[+-]?\d+$/.test(value);
}

function verifyAgainstPublicKey(signedPayload: string, signatureB64Url: string, publicKeyB64: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    // 只接受 ed25519：防止未来误嵌其它算法的键后 verify(null, …) 语义漂移。
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }
    return verifySignature(
      null,
      Buffer.from(signedPayload, "utf8"),
      publicKey,
      Buffer.from(signatureB64Url, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * 校验三段签名调试令牌。任何失败都返回闭集原因，绝不抛错——boot 早期调用方
 * 没有异常处理预算，且失败必须 fail-closed 为「无令牌」。
 */
export function verifySignedDebugToken(
  token: string,
  expectedUserDataPath: string,
  options: VerifySignedDebugTokenOptions = {},
): DebugTokenVerification {
  const now = options.now ?? Date.now;
  const publicKeys = options.publicKeys ?? EMBEDDED_DEBUG_TOKEN_PUBLIC_KEYS;

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed" };
  }
  const [timestampText = "", payloadB64Url = "", signatureB64Url = ""] = parts;
  if (!isFiniteIntegerText(timestampText) || payloadB64Url === "" || signatureB64Url === "") {
    return { valid: false, reason: "malformed" };
  }

  // payload 解码必须精确等于当前（声明的）userDataPath——令牌被搬到另一台机器/
  // 另一个身份目录上立即失效。
  let decodedPath: string;
  try {
    decodedPath = Buffer.from(payloadB64Url, "base64url").toString("utf8");
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (decodedPath !== expectedUserDataPath) {
    return { valid: false, reason: "path_mismatch" };
  }

  const issuedAt = Number.parseInt(timestampText, 10);
  const ageMs = now() - issuedAt;
  // 过期与时钟 skew 共用 expired：未来钟超过容忍窗同样不可信（可能来自时钟篡改）。
  if (ageMs > MAX_DEBUG_TOKEN_AGE_MS || ageMs < -DEBUG_TOKEN_CLOCK_SKEW_MS) {
    return { valid: false, reason: "expired" };
  }

  const signedPayload = `${timestampText}.${payloadB64Url}`;
  for (const publicKey of publicKeys) {
    if (verifyAgainstPublicKey(signedPayload, signatureB64Url, publicKey)) {
      return { valid: true };
    }
  }
  return { valid: false, reason: "invalid_signature" };
}

export interface DebugTokenDecision {
  /** 环境里是否存在令牌（存在但无效也会 warn 原因）。 */
  tokenPresent: boolean;
  tokenValid: boolean;
  /** tokenPresent && !tokenValid 时的闭集原因。 */
  rejectionReason?: DebugTokenRejectionReason;
}

export interface ResolveDebugTokenDecisionOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  publicKeys?: readonly string[];
  /** 失败原因逐条 warn（原因码可入日志，令牌与路径值不入日志）。 */
  warn?: (message: string) => void;
}

/**
 * 从 env 解析启动期令牌决策：令牌必须与 ACODE_DESKTOP_USER_DATA_DIR 成对出现，
 * payload 对齐该声明路径（spec §3 校验规则 2）。
 */
export function resolveDebugTokenDecision(
  options: ResolveDebugTokenDecisionOptions = {},
): DebugTokenDecision {
  const env = options.env ?? process.env;
  const warn =
    options.warn ??
    ((message: string) => {
      try {
        console.warn(message);
      } catch {
        // boot 早期 stdout/stderr 可能已关闭（EPIPE），诊断输出不得反过来打断启动。
      }
    });

  const token = env[DEBUG_TOKEN_ENV_KEY]?.trim();
  if (!token) {
    return { tokenPresent: false, tokenValid: false };
  }

  const claimedPath = env[DEBUG_TOKEN_PATH_CLAIM_ENV_KEY]?.trim();
  if (!claimedPath) {
    // 有令牌但没有配套的身份覆写声明：按 path_mismatch 拒绝（期望路径无从对齐）。
    warn(`[debug-token] rejected: path_mismatch (missing ${DEBUG_TOKEN_PATH_CLAIM_ENV_KEY})`);
    return { tokenPresent: true, tokenValid: false, rejectionReason: "path_mismatch" };
  }

  const verification = verifySignedDebugToken(token, claimedPath, {
    now: options.now,
    publicKeys: options.publicKeys,
  });
  if (verification.valid) {
    return { tokenPresent: true, tokenValid: true };
  }

  warn(`[debug-token] rejected: ${verification.reason}`);
  return { tokenPresent: true, tokenValid: false, rejectionReason: verification.reason };
}

let bootDebugTokenDecision: DebugTokenDecision | undefined;

/**
 * 进程内一次性决策（memoized）：boot 段的清洗漏斗与拒启表共享同一结果，
 * 避免多处各自读 env 造成决策漂移。测试用 resetBootDebugTokenDecisionForTest 复位。
 */
export function getBootDebugTokenDecision(): DebugTokenDecision {
  bootDebugTokenDecision ??= resolveDebugTokenDecision();
  return bootDebugTokenDecision;
}

export function resetBootDebugTokenDecisionForTest(): void {
  bootDebugTokenDecision = undefined;
}
