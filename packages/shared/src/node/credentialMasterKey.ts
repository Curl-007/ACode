import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 凭据主密钥解析（Node-only，**同步**）。
 *
 * 安全加固 P0-4：此前 AES-256-GCM 的密钥来自
 * `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")` —— 三个组成部分
 * 对同机任意进程公开可知、单轮 sha256、无盐、无机器绑定，且 `ACODE_CREDENTIAL_SECRET`
 * 在产物代码中从不被赋值，故**永远**走这条可离线推导的回退。凭据文件一旦被外带即可
 * 纯离线还原全部 OAuth token 与付费 Key。
 *
 * 本模块把密钥来源改为「每安装随机生成、0600 独立文件」，并保留 env 显式覆盖：
 *
 * 1. `options.secret`（仅测试/宿主注入）
 * 2. `ACODE_CREDENTIAL_SECRET` 环境变量
 * 3. `<baseDir>/.acode/v2/credential-key.json`：首次使用时随机生成 32 字节，排他创建
 *
 * **为什么是同步**：`CredentialCipherProvider.encrypt/decrypt` 是同步接口，被
 * `credentialService` 与 CLI `shared-credentials` 在**文件锁内联**调用；Electron
 * `safeStorage` / `keytar` 都是异步（且 keytar 是原生依赖），无法在不改接口的前提下
 * 接入。接 OS 钥匙串需要把整条 cipher 链改成异步并解决「桌面 host 与 CLI 两个进程共用
 * 同一 credentials.json、却各自持有互不相通钥匙串」的跨进程密钥一致性问题——那是后续
 * 工作，不在本次无后悔改动范围内。
 *
 * **诚实边界**：密钥文件与密文同盘，本改动**不能**防住「整个 `.acode` 目录被外带」。
 * 它防住的是审计中实际演示的攻击面：由公开机器属性离线推导密钥、以及同用户名异机复用
 * 同一可推导密钥。真正的「密文与密钥分离」要靠 OS 钥匙串。
 */

/** 每安装随机主密钥的字节数（AES-256）。 */
const MASTER_KEY_BYTES = 32;

/** 密钥文件 schema 版本，便于将来轮换格式时区分。 */
export const CREDENTIAL_KEY_FILE_VERSION = 1;

/** 密钥文件默认名，位于 `.acode/v2/` 下（与 `credentials.json` 同目录）。 */
export const CREDENTIAL_KEY_FILE_NAME = "credential-key.json";

export const CREDENTIAL_SECRET_ENV_KEY = "ACODE_CREDENTIAL_SECRET";

/**
 * env 密钥派生用的固定盐。env secret 本身是高熵用户输入，盐在此只承担**域分离**职责
 * （让同一 secret 在别的用途下派生出不同密钥），不承担防撞库职责。
 */
const ENV_SECRET_SALT = Buffer.from("acode-credential-master-key/v1", "utf-8");

const ENV_SECRET_SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type CredentialMasterKeySource = "explicit" | "env" | "keyFile";

export interface ResolvedCredentialMasterKey {
  readonly key: Buffer;
  readonly source: CredentialMasterKeySource;
  /** 仅 `source === "keyFile"` 时有值：实际读写的密钥文件路径。 */
  readonly keyFilePath?: string;
}

export interface ResolveCredentialMasterKeyOptions {
  /** 数据基目录；缺省按 `ACODE_DATA_BASE_DIR` env，再退回 `homedir()`。 */
  baseDir?: string;
  env?: Record<string, string | undefined>;
  /** 直接指定密钥文件路径（优先于 baseDir 推导）。 */
  keyFilePath?: string;
  /** 显式密钥材料（十六进制/base64url 均可）；仅测试与宿主注入使用。 */
  secret?: string;
  /**
   * 告警回调（env 与已存在密钥文件冲突时使用）。缺省为 once-guarded console.warn；
   * 测试可注入以捕获断言，宿主可注入以走分级 logger。
   */
  onWarn?: (message: string) => void;
}

interface CredentialKeyFileShape {
  key: string;
  version: number;
}

/** 默认密钥文件路径：`<baseDir>/.acode/v2/credential-key.json`。 */
export function resolveCredentialKeyFilePath(
  options: ResolveCredentialMasterKeyOptions = {},
): string {
  if (options.keyFilePath) {
    return options.keyFilePath;
  }
  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? (env.ACODE_DATA_BASE_DIR?.trim() || homedir());
  return join(baseDir, ".acode", "v2", CREDENTIAL_KEY_FILE_NAME);
}

function deriveKeyFromSecret(secret: string): Buffer {
  // scrypt 取代单轮 sha256：带盐、可调工作因子，抵抗离线爆破。
  return scryptSync(
    Buffer.from(secret, "utf-8"),
    ENV_SECRET_SALT,
    MASTER_KEY_BYTES,
    ENV_SECRET_SCRYPT_PARAMS,
  );
}

function decodeStoredKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64url");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `ACode credential key file is malformed: expected ${MASTER_KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * 同步小睡（仅用于密钥文件竞争回退路径）。
 *
 * 本模块必须保持同步（cipher 接口是同步的、被文件锁内联调用），所以不能用
 * `setTimeout` + await。`Atomics.wait` 是同步阻塞等待的标准做法，只在极罕见的
 * 「另一进程正在首次写入密钥文件」时触发，总时长以百毫秒计。
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** EEXIST 竞争回读的重试次数与退避（赢家 writeFileSync 可能正在进行中）。 */
const KEY_FILE_RACE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;

/**
 * 读一次密钥文件。
 *
 * 返回 `undefined` 表示「文件不存在」；**抛错**表示「文件存在但读不出合法密钥」
 * （JSON 半截、schema 不符、长度不对）。这两种情况必须区分：前者可以生成，
 * 后者绝不能生成——生成等于换一把新密钥，把已写入的全部 `enc:v2` 凭据变成永久垃圾。
 */
function readKeyFileOnce(keyFilePath: string): Buffer | undefined {
  let raw: string;
  try {
    raw = readFileSync(keyFilePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: CredentialKeyFileShape;
  try {
    parsed = JSON.parse(raw) as CredentialKeyFileShape;
  } catch (error) {
    // 另一进程可能正在首次写入（writeFileSync 非原子），此刻读到的是半截 JSON。
    // 抛给上层由重试循环处理；重试耗尽仍失败则**保留现场报错**，不生成新密钥。
    throw new Error(
      `ACode credential key file is not readable as JSON: ${keyFilePath}`,
      { cause: error },
    );
  }

  if (parsed.version !== CREDENTIAL_KEY_FILE_VERSION || typeof parsed.key !== "string") {
    throw new Error(
      `ACode credential key file has an unsupported shape: ${keyFilePath}. ` +
        "Delete it to regenerate (existing enc:v2 credentials will then be unreadable), " +
        "or restore it from backup.",
    );
  }
  return decodeStoredKey(parsed.key);
}

/**
 * 带竞争重试的密钥文件读取。
 *
 * 修复的问题（对抗评审核实）：`wx` 排他创建的落败方在 EEXIST 分支里直接
 * `readKeyFile()`，若赢家的 `writeFileSync` 尚未写完，`JSON.parse` 会抛未捕获的
 * SyntaxError 直接崩进程——这与「两个进程必然收敛到同一把密钥」的声明矛盾。
 *
 * 重试只针对「读不出合法内容」，耗尽后**抛出**而不是回退到生成：宁可启动失败并留下
 * 明确错误，也不能静默换密钥毁掉既有凭据。
 */
function readKeyFileWithRetry(keyFilePath: string): Buffer | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt <= KEY_FILE_RACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return readKeyFileOnce(keyFilePath);
    } catch (error) {
      lastError = error;
      const delayMs = KEY_FILE_RACE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        break;
      }
      sleepSync(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`ACode credential key file could not be read: ${keyFilePath}`);
}

/**
 * 排他创建密钥文件（0600）。`wx` 保证并发首次启动时只有一个进程写入成功，
 * 落败方 EEXIST 后**重试回读**赢家写入的密钥——两个进程因此收敛到同一把密钥，
 * 这是桌面 host 与 CLI 共用同一 credentials.json 的前提。
 */
function createKeyFileExclusive(keyFilePath: string): Buffer {
  const key = randomBytes(MASTER_KEY_BYTES);
  const payload: CredentialKeyFileShape = {
    key: key.toString("base64url"),
    version: CREDENTIAL_KEY_FILE_VERSION,
  };
  mkdirSync(dirname(keyFilePath), { recursive: true });
  try {
    writeFileSync(keyFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") {
      throw error;
    }
    // 竞争落败：赢家已创建文件，重试回读它写入的密钥（赢家可能仍在写，故需退避重试）。
    // 读不出就抛错，**绝不**在此生成新密钥——那会让两个进程各持一把，
    // 一方写入的凭据另一方解不开。
    const winnerKey = readKeyFileWithRetry(keyFilePath);
    if (winnerKey) {
      return winnerKey;
    }
    throw new Error(
      `ACode credential key file disappeared during concurrent first launch: ${keyFilePath}`,
    );
  }
  // Windows 上 writeFileSync 的 mode 不一定生效，显式补一次。
  try {
    chmodSync(keyFilePath, 0o600);
  } catch {
    // 权限收紧失败不阻断启动；文件已排他创建成功。
  }
  return key;
}

/** 冲突/降级告警默认走 once-guarded console.warn（与 server http.ts 的弃用告警同风格）。 */
const warnedMessages = new Set<string>();
function defaultWarnOnce(message: string): void {
  if (warnedMessages.has(message)) {
    return;
  }
  warnedMessages.add(message);
  console.warn(message);
}

/**
 * 解析当前安装应使用的凭据主密钥。**同步**，供 cipher 构造时调用。
 *
 * 优先级（安全加固 P0-4，顺序经过对抗评审修正）：
 * 1. 显式 `secret`（测试/宿主注入）——调用方的明确意图，最高。
 * 2. **已存在的密钥文件**——它拥有已写入的全部 `enc:v2` 凭据，绝不能被静默替换。
 *    若此时 `ACODE_CREDENTIAL_SECRET` 也存在，env 被**忽略**并告警（见下），因为
 *    切到 env 派生的密钥会让所有既有 v2 凭据解不开。
 * 3. `ACODE_CREDENTIAL_SECRET`——仅当**尚无**密钥文件时生效（全新安装显式配置 env 的合法用法），
 *    此时不生成密钥文件，后续调用同样走 env，保持一致。
 * 4. 都没有——生成每安装随机密钥文件。
 *
 * 修复的坑（对抗评审核实）：旧实现把 env 检查放在密钥文件之前且不受文件是否存在约束，
 * 导致「正常升级（已写 v2）后再设 ACODE_CREDENTIAL_SECRET」会静默换密钥、让全部 v2 凭据
 * 变成不可解密的垃圾，且无任何诊断。新顺序让密钥文件优先于 env，把静默数据丢失改为显式告警。
 *
 * **反向脚注**：第 3 步（env 优先于「尚未存在的密钥文件」）意味着，若用户先用 env 写入了 v2
 * 凭据、之后又取消该 env，则会落到第 4 步生成一把新密钥、令 env 时期写入的凭据解不开。
 * 这是 env 配置的固有取舍，已在 credential-storage.md 记录；用 env 就必须一直用同一个 env。
 */
export function resolveCredentialMasterKey(
  options: ResolveCredentialMasterKeyOptions = {},
): ResolvedCredentialMasterKey {
  const env = options.env ?? process.env;
  const warn = options.onWarn ?? defaultWarnOnce;

  const explicit = options.secret?.trim();
  if (explicit) {
    return { key: deriveKeyFromSecret(explicit), source: "explicit" };
  }

  const keyFilePath = resolveCredentialKeyFilePath(options);
  // 先探测密钥文件（带竞争重试）：它一旦存在就拥有既有 v2 数据，优先级高于 env。
  const existing = readKeyFileWithRetry(keyFilePath);
  const fromEnv = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (existing) {
    if (fromEnv) {
      warn(
        `SECURITY WARNING: ${CREDENTIAL_SECRET_ENV_KEY} is set but a per-install credential key ` +
          `file already exists at ${keyFilePath}. Ignoring the environment variable to avoid ` +
          `orphaning existing enc:v2 credentials (switching keys would make them unrecoverable). ` +
          `Unset ${CREDENTIAL_SECRET_ENV_KEY}, or remove the key file to start over ` +
          `(which discards existing credentials).`,
      );
    }
    return { key: existing, source: "keyFile", keyFilePath };
  }

  if (fromEnv) {
    return { key: deriveKeyFromSecret(fromEnv), source: "env" };
  }

  return { key: createKeyFileExclusive(keyFilePath), source: "keyFile", keyFilePath };
}
