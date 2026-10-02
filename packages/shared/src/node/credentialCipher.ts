import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
// oauth.ts 无任何 import，不会与 node/ 子路径形成循环依赖。
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
} from "../oauth.js";
import {
  CREDENTIAL_SECRET_ENV_KEY,
  resolveCredentialMasterKey,
  type ResolveCredentialMasterKeyOptions,
} from "./credentialMasterKey.js";

/**
 * 凭据加密原语（Node-only，同步）。
 *
 * 安全加固 P0-4：桌面 host（`@acode/services`）与 CLI（`@acode/adapters/auth`）此前各持一份
 * **完全等价**的 cipher 实现，密钥均为可离线推导的 `sha256(fallback)`。两份实现收敛到这里，
 * 与 `serverAuth.ts` / `hostCapability.ts` 同一套去分叉做法。
 *
 * **版本语义**：
 * - `enc:v2:` —— 当前格式。密钥来自 `credentialMasterKey`（每安装随机 / env / 显式），
 *   经 HKDF-SHA256 域分离派生出数据加密密钥，AES-256-GCM + 每值随机 IV + 版本绑定 AAD。
 * - `enc:v1:` —— **仅可解密**，永不产出。密钥沿用旧的可离线推导回退串，唯一目的是让升级前
 *   已落盘的 OAuth token / 付费 Key 仍可读。`encrypt()` 只写 v2，因此「新密文不落在可推导密钥下」
 *   这条不变量成立。
 *
 * **为什么不直接删掉 v1 的派生串**：删掉等于让所有升级前已保存的凭据当场变成垃圾——这正是
 * 本改动最不能接受的失败模式（不可逆地毁掉用户真实 token）。保留 decrypt-only 是唯一安全路径；
 * 待将来接入 OS 钥匙串并提供一次性重加密迁移后，才能移除 v1 支持。
 */

const ENCRYPTED_VALUE_PREFIX_V1 = "enc:v1:";
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";

const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;

/** HKDF 域分离参数：固定盐 + info，把「凭据数据加密」与其他潜在用途隔开。 */
const DATA_KEY_SALT = Buffer.from("acode-credential-cipher/v2", "utf-8");
const DATA_KEY_INFO = Buffer.from("acode-credential-data-encryption-key", "utf-8");

/**
 * AAD 绑定格式版本。没有它，攻击者可把一段 v1 密文重新贴上 `enc:v2:` 前缀投递给
 * 解密路径；GCM 的认证标签会因 AAD 不匹配而拒绝，从而在密码学层面封死版本混淆。
 * 注意 v1 历史密文加密时未绑 AAD，故只定义 v2 的 AAD。
 */
const AAD_V2 = Buffer.from("acode-credential-enc/v2", "utf-8");

export interface ACodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface CreateACodeCredentialCipherOptions extends ResolveCredentialMasterKeyOptions {
  /** 注入数据加密密钥，绕过主密钥解析；仅测试使用。 */
  dataKey?: Buffer;
}

export function isEncryptedACodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX_V1) || value.startsWith(ENCRYPTED_VALUE_PREFIX_V2);
}

/** 是否为当前版本写入的密文（用于「不产出可推导密钥密文」类不变量断言）。 */
export function isEncryptedACodeCredentialValueV1(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX_V1);
}

function deriveDataKey(masterKey: Buffer): Buffer {
  const derived = hkdfSync("sha256", masterKey, DATA_KEY_SALT, DATA_KEY_INFO, DATA_KEY_BYTES);
  return Buffer.from(derived);
}

/**
 * 旧 `enc:v1:` 的密钥：`sha256(ACODE_CREDENTIAL_SECRET ?? 可推导回退串)`。
 * **仅供解密历史密文**；`encrypt()` 从不调用它。
 */
function deriveLegacyV1Key(env: Record<string, string | undefined>): Buffer {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  let secret: string;
  if (configuredSecret) {
    secret = configuredSecret;
  } else {
    let username = "unknown";
    try {
      username = userInfo().username;
    } catch {
      // 部分打包/沙箱运行时取不到 OS 用户信息。
    }
    secret = `acode-credential-fallback:${platform()}:${homedir()}:${username}`;
  }
  return createHash("sha256").update(secret).digest();
}

interface SplitCiphertext {
  iv: Buffer;
  authTag: Buffer;
  cipherText: Buffer;
}

/**
 * 解密失败错误必须携带稳定 code + CJK 前缀。
 *
 * 这不是风格问题：`isCredentialDecryptError`（`../oauth.js`）只认 code 或前缀，
 * 而 `oauthCredentialRepo.ts` 有 4 处靠它把「本地凭据解密失败」降级为
 * clearCorruptOAuthSession → 强制干净登出 → 让用户重新登录。抛出不带 code 的裸 Error
 * 会让该谓词恒为 false，恢复路径失效，解密失败改为沿 OAuth 加载链上抛。
 * （合并两份 cipher 时曾丢失此约定，由对抗评审核实后补回。）
 */
function createCredentialDecryptError(
  reason: string,
  cause?: unknown,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(
    new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`, cause === undefined ? undefined : { cause }),
    { code: CREDENTIAL_DECRYPT_ERROR_CODE },
  );
}

function splitCiphertext(value: string, prefix: string, label: string): SplitCiphertext {
  const payload = value.slice(prefix.length);
  const parts = payload.split(".");
  const [ivRaw, authTagRaw, cipherRaw] = parts;

  if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
    throw createCredentialDecryptError(`${label} 密文格式非法`);
  }

  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(authTagRaw, "base64url");
  const cipherText = Buffer.from(cipherRaw, "base64url");

  if (iv.length !== IV_BYTES) {
    throw createCredentialDecryptError(`${label} IV 长度非法`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw createCredentialDecryptError(`${label} AuthTag 长度非法`);
  }

  return { iv, authTag, cipherText };
}

function decryptWithKey(
  key: Buffer,
  value: string,
  prefix: string,
  aad: Buffer | undefined,
  label: string,
): string {
  const { iv, authTag, cipherText } = splitCiphertext(value, prefix, label);
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    // v1 密文加密时**从未** setAAD（旧实现没有 AAD）。若这里给它绑 AAD，GCM 标签必然
    // 校验失败——等于把升级前已落盘的全部 OAuth token / 付费 Key 变成不可解密的垃圾。
    // 因此 v1 必须不传 AAD；AAD 只用于我们自己两端都控制的 v2。
    if (aad) {
      decipher.setAAD(aad);
    }
    const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return plainText.toString("utf-8");
  } catch (error) {
    throw createCredentialDecryptError(`${label} 密钥不匹配或密文已损坏`, error);
  }
}

function encryptWithKey(key: Buffer, value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  cipher.setAAD(AAD_V2);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTED_VALUE_PREFIX_V2,
    iv.toString("base64url"),
    ".",
    authTag.toString("base64url"),
    ".",
    encrypted.toString("base64url"),
  ].join("");
}

export function createACodeCredentialCipher(
  options: CreateACodeCredentialCipherOptions = {},
): ACodeCredentialCipher {
  const env = options.env ?? process.env;
  // 主密钥**惰性**解析：只在真正加解密时才触碰密钥文件。构造 cipher 是同步且高频的
  // （每次 store 工厂调用都会建一个），提前解析会让「密钥文件不可用」变成一个
  // 与凭据无关的启动期崩溃点。
  let cachedDataKey: Buffer | undefined = options.dataKey;
  const dataKey = (): Buffer => {
    if (!cachedDataKey) {
      cachedDataKey = deriveDataKey(resolveCredentialMasterKey(options).key);
    }
    return cachedDataKey;
  };

  let cachedLegacyKey: Buffer | undefined;
  const legacyKey = (): Buffer => {
    if (!cachedLegacyKey) {
      cachedLegacyKey = deriveLegacyV1Key(env);
    }
    return cachedLegacyKey;
  };

  return {
    decrypt(value: string): string {
      // 非密文（历史明文值）原样返回，与旧实现行为一致。用谓词而非内联 startsWith，
      // 让 isEncryptedACodeCredentialValue / ...ValueV1 成为真实解密路径的一部分，
      // 而不是仅供测试引用的死导出（对抗评审 #6）。
      if (!isEncryptedACodeCredentialValue(value)) {
        return value;
      }
      if (isEncryptedACodeCredentialValueV1(value)) {
        // 历史密文：沿用旧的派生密钥，保证升级后既有凭据仍可读。AAD 传 undefined，
        // 因为 v1 加密时没有绑 AAD（见 decryptWithKey 注释）。
        return decryptWithKey(
          legacyKey(),
          value,
          ENCRYPTED_VALUE_PREFIX_V1,
          undefined,
          "历史凭据",
        );
      }
      return decryptWithKey(dataKey(), value, ENCRYPTED_VALUE_PREFIX_V2, AAD_V2, "凭据");
    },

    encrypt(value: string): string {
      // 新写入一律 v2；绝不产出可离线推导密钥下的密文。
      return encryptWithKey(dataKey(), value);
    },
  };
}

/** `@acode/services` 侧的历史别名，保持既有导入点不变。 */
export type CredentialCipherProvider = ACodeCredentialCipher;
export const createCredentialCipherProvider = createACodeCredentialCipher;
