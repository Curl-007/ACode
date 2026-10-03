import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createCredentialKeychain,
  type CredentialKeychainAccess,
  type CredentialKeychainReadResult,
} from "./credentialKeychain.js";

/**
 * 凭据主密钥解析（Node-only，**同步**）。
 *
 * 安全加固 P0-4：此前 AES-256-GCM 的密钥来自
 * `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")` —— 三个组成部分
 * 对同机任意进程公开可知、单轮 sha256、无盐、无机器绑定，且 `ACODE_CREDENTIAL_SECRET`
 * 在产物代码中从不被赋值，故**永远**走这条可离线推导的回退。凭据文件一旦被外带即可
 * 纯离线还原全部 OAuth token 与付费 Key。
 *
 * P0-4 把密钥来源改为「每安装随机生成、0600 独立文件」；R1-a（批次 4，设计文档
 * docs/credential-os-keychain-design.md）再把材料的家迁到 **OS 钥匙串**（macOS
 * Keychain / Windows DPAPI blob / Linux libsecret，见 credentialKeychain.ts），
 * 密钥文件退为钥匙串不可用时的降级模式与未迁移遗留。优先级：
 *
 * 1. `options.secret`（仅测试/宿主注入）
 * 2. **OS 钥匙串条目**（R1-a；材料与密钥文件同为 32 字节主密钥，HKDF 输入不变 →
 *    既有 enc:v2 密文零重加密）
 * 3. `<baseDir>/.acode/v2/credential-key.json`（未迁移遗留 / 降级模式）
 * 4. `ACODE_CREDENTIAL_SECRET` 环境变量（仅当钥匙串与密钥文件都不存在时生效）
 * 5. 生成新的每安装随机材料：钥匙串可用 → 直接入条目（不落文件）；不可用 →
 *    0600 密钥文件 + 一次性告警（D5 降级诚实）
 *
 * **为什么仍是同步**：`CredentialCipherProvider.encrypt/decrypt` 是同步接口，被
 * `credentialService` 与 CLI `shared-credentials` 在**文件锁内联**调用。P0-4 时点
 * 「safeStorage/keytar 皆异步」是事实；R1-a 的解法不是异步化整条链，而是平台工具
 * `spawnSync` 一次性解析 + 本模块对 found/unavailable 结果做**进程级缓存**（D2 裁决）——
 * 钥匙串访问频率 = 每进程每数据目录至多一次成功 spawn。真机实测（2026-10-03，Windows
 * PowerShell DPAPI，scripts/smoke-credential-keychain.mjs）：连发热态 ~225ms/次，间隔
 * 真实使用 ~860-930ms/次，冷启动（开机后首调/程序集缓存被逐出）0.9~2s——比毫秒级密钥
 * 文件读取高几个数量级，但按「每进程一次性启动开销」评估可接受（缓存后零 spawn；长驻
 * 进程付一次，CLI 短进程在触碰凭据的路径上付 ~0.9s）。若成为体感痛点，登记的后续优化
 * 是 bootstrap 异步预热（进程启动即并行 spawn 填充本缓存），而非回退材料落盘。跨进程
 * 一致性由「同一 keyFilePath → 同一条目命名」（D3）与平台访问器的排他写语义（macOS
 * 重复即回读赢家 / Windows blob `wx` / Linux 写前读+写后回读采用）保证。
 *
 * **诚实边界（R1-a 后更新）**：钥匙串模式下密钥材料与密文分离，「整个 `.acode` 目录
 * 被外带」在异机/异用户上不可解密（Windows DPAPI 为逻辑分离：blob 物理同目录但仅同机
 * 同用户可解）。降级文件模式维持 P0-4 的边界（挡离线推导，不挡目录外带），发生时有
 * 一次性告警。钥匙串条目丢失（OS 重装未迁移等）= 凭据不可解密，与既有「密钥文件
 * 单点」同性质（凭据本体可服务端重签发，README 披露口径在 R1-b 更新）。
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

export type CredentialMasterKeySource = "explicit" | "env" | "keyFile" | "keychain";

export interface ResolvedCredentialMasterKey {
  readonly key: Buffer;
  readonly source: CredentialMasterKeySource;
  /** 仅材料落在密钥文件（`source === "keyFile"`）时有值：实际读写的密钥文件路径。 */
  readonly keyFilePath?: string;
}

export interface ResolveCredentialMasterKeyOptions {
  /** 数据基目录；缺省按 `ACODE_DATA_BASE_DIR` env，再退回 `homedir()`。 */
  baseDir?: string;
  env?: Record<string, string | undefined>;
  /** 直接指定密钥文件路径（优先于 baseDir 推导）。 */
  keyFilePath?: string;
  /** 显式密钥材料（十六进制/base64url 均可）；仅测试/宿主注入使用。 */
  secret?: string;
  /**
   * OS 钥匙串访问器（R1-a）。缺省为真实平台访问器（credentialKeychain.ts）；
   * 测试注入 stub 以固定文件模式/钥匙串模式语义。
   */
  keychain?: CredentialKeychainAccess;
  /**
   * 告警回调（env 冲突、钥匙串并存、钥匙串降级时使用）。缺省为 once-guarded
   * console.warn；测试可注入以捕获断言，宿主可注入以走分级 logger。
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
 * 优先级（P0-4 顺序经对抗评审修正；R1-a 插入钥匙串档，设计文档 D4）：
 * 1. 显式 `secret`（测试/宿主注入）——调用方的明确意图，最高。
 * 2. **OS 钥匙串条目**——迁移后材料的新家；与密钥文件**并存**时钥匙串优先并告警
 *    （两者材料本应相同，不同说明备份错位，告警给出双路径提示）。条目存在但读不出
 *    合法材料 → **抛错保留现场**，绝不降级生成（生成 = 换密钥 = 既有 v2 凭据永久垃圾，
 *    与密钥文件损坏同一纪律）。
 * 3. **已存在的密钥文件**——未迁移遗留/降级模式，它拥有已写入的全部 `enc:v2` 凭据，
 *    绝不能被静默替换。若此时 `ACODE_CREDENTIAL_SECRET` 也存在，env 被**忽略**并告警。
 * 4. `ACODE_CREDENTIAL_SECRET`——仅当钥匙串与密钥文件**都尚无**材料时生效（全新安装
 *    显式配置 env 的合法用法），此时不生成任何持久材料，后续调用同样走 env，保持一致。
 * 5. 都没有——生成每安装随机 32 字节：钥匙串可用 → 直接入条目（不落文件）；
 *    不可用/写入失败 → 0600 密钥文件 + 一次性告警（D5 降级诚实）。
 *
 * 修复的坑（对抗评审核实）：旧实现把 env 检查放在密钥文件之前且不受文件是否存在约束，
 * 导致「正常升级（已写 v2）后再设 ACODE_CREDENTIAL_SECRET」会静默换密钥、让全部 v2 凭据
 * 变成不可解密的垃圾，且无任何诊断。新顺序让既有材料（钥匙串/密钥文件）优先于 env，
 * 把静默数据丢失改为显式告警。
 *
 * **反向脚注**：第 4 步（env 优先于「尚未存在的持久材料」）意味着，若用户先用 env 写入了
 * v2 凭据、之后又取消该 env，则会落到第 5 步生成一把新密钥、令 env 时期写入的凭据解不开。
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
  const keychain = options.keychain ?? getDefaultKeychain();
  const fromEnv = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();

  // 2. 钥匙串（found/unavailable 结果进程级缓存：spawnSync 不能随 cipher 实例高频创建
  //    而反复执行；absent/error 不缓存——前者在生成写入后应变 found，后者必须每次现场报错）。
  const keychainRead = readKeychainCached(keychain, keyFilePath);
  if (keychainRead.status === "found") {
    const key = decodeKeychainSecret(keychainRead.secret, keyFilePath);
    if (existsSync(keyFilePath)) {
      warn(
        `SECURITY WARNING: both an OS keychain entry and a credential key file exist for ` +
          `${keyFilePath}. Using the keychain entry (post-migration home of the key material). ` +
          `If credentials fail to decrypt, the two materials have diverged (stale backup ` +
          `restored?) — remove whichever copy is not the original.`,
      );
    }
    return { key, source: "keychain" };
  }
  if (keychainRead.status === "error") {
    // fail-loud：条目/blob 存在但读不出合法材料。降级或生成都会孤立既有凭据。
    throw new Error(
      `ACode credential keychain entry exists but is not readable: ${keychainRead.reason}. ` +
        `Fix the entry, or remove it deliberately (existing enc:v2 credentials will then ` +
        `become unreadable).`,
    );
  }

  // 3. 先探测密钥文件（带竞争重试）：它一旦存在就拥有既有 v2 数据，优先级高于 env。
  const existing = readKeyFileWithRetry(keyFilePath);
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
    // R1-b 一次性迁移：钥匙串可用（read 返回 absent 而非 unavailable/error）且条目缺失 →
    // 把文件材料搬入条目（零重加密：材料字节不变）。写入→回读逐字节验证→通过才删文件；
    // 任一步失败 → 尽力清掉刚写入的条目 + 保持文件模式 + 下次解析重试（绝不留半迁移态：
    // 解析链里钥匙串优先于文件，坏条目会压过权威材料）。
    if (keychainRead.status === "absent") {
      const migrated = migrateKeyFileToKeychain(keychain, keyFilePath, existing, warn);
      if (migrated) {
        return { key: migrated, source: "keychain" };
      }
    }
    return { key: existing, source: "keyFile", keyFilePath };
  }

  // 4. env：仅当钥匙串与密钥文件都无材料时生效。
  if (fromEnv) {
    return { key: deriveKeyFromSecret(fromEnv), source: "env" };
  }

  // 5. 生成：钥匙串优先（新装直接入条目，密钥材料从此不落盘）；不可用或写入失败
  //    降级文件模式并一次性告警（D5：诚实声明降级，不假装已分离）。
  if (keychainRead.status !== "unavailable") {
    const generated = randomBytes(MASTER_KEY_BYTES).toString("base64url");
    const written = keychain.write(keyFilePath, generated);
    if (written.status === "written") {
      return { key: decodeKeychainSecret(written.secret, keyFilePath), source: "keychain" };
    }
    warn(
      `OS keychain unavailable for the credential master key (${written.reason}); ` +
        `falling back to the 0600 key file mode — the key file shares the disk with the ` +
        `ciphertext (see README "本地凭据保护").`,
    );
  } else {
    warn(
      `OS keychain unavailable (${keychainRead.reason}); the credential master key will be ` +
        `stored as a 0600 key file next to the ciphertext (see README "本地凭据保护").`,
    );
  }
  return { key: createKeyFileExclusive(keyFilePath), source: "keyFile", keyFilePath };
}

// ── R1-a 钥匙串接入辅助 ───────────────────────────────────────────────

let defaultKeychainInstance: CredentialKeychainAccess | undefined;
function getDefaultKeychain(): CredentialKeychainAccess {
  defaultKeychainInstance ??= createCredentialKeychain();
  return defaultKeychainInstance;
}

/**
 * 钥匙串读取的进程级缓存（per keyFilePath）。只缓存 found 与 unavailable：
 * - found：条目被外部删除时进程内材料继续可用——与既有「DEK 按 cipher 实例缓存」
 *   同语义，不引入新的失效面。
 * - unavailable：headless Linux 每次 spawn 都会失败，缓存避免重复付费。
 * - absent 不缓存：生成写入后下一次解析必须能看到 found。
 * - error 不缓存：现场损坏必须每次 fail-loud，不能被一次瞬时失败永久钉死。
 */
const keychainReadCache = new Map<string, CredentialKeychainReadResult>();
function readKeychainCached(
  keychain: CredentialKeychainAccess,
  keyFilePath: string,
): CredentialKeychainReadResult {
  const cached = keychainReadCache.get(keyFilePath);
  if (cached && (cached.status === "found" || cached.status === "unavailable")) {
    return cached;
  }
  const result = keychain.read(keyFilePath);
  if (result.status === "found" || result.status === "unavailable") {
    keychainReadCache.set(keyFilePath, result);
  }
  return result;
}

/**
 * 钥匙串材料解码与长度校验。base64url/base64 都接受（平台工具对密码本体是透明字符串，
 * 写入端统一 base64url；历史/手工写入可能是标准 base64）。长度不符 = 条目损坏 →
 * 抛错保留现场（绝不生成新密钥孤立既有凭据，与 readKeyFileOnce 同一纪律）。
 */
function decodeKeychainSecret(secret: string, keyFilePath: string): Buffer {
  const key = Buffer.from(secret, "base64url");
  const keyStrict = key.length === MASTER_KEY_BYTES ? key : Buffer.from(secret, "base64");
  if (keyStrict.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `ACode credential keychain entry is malformed for ${keyFilePath}: ` +
        `expected ${MASTER_KEY_BYTES} bytes of key material. Fix or remove the entry ` +
        `(regenerating would orphan existing enc:v2 credentials).`,
    );
  }
  return keyStrict;
}

/** 解码但不抛错（迁移验证用：读回材料非法 = 验证失败，走「清条目保文件」路径而非中断解析）。 */
function tryDecodeKeychainSecret(secret: string): Buffer | undefined {
  const key = Buffer.from(secret, "base64url");
  if (key.length === MASTER_KEY_BYTES) return key;
  const strict = Buffer.from(secret, "base64");
  return strict.length === MASTER_KEY_BYTES ? strict : undefined;
}

/**
 * R1-b 一次性迁移：密钥文件材料 → OS 钥匙串条目（零重加密，材料字节不变）。
 *
 * 返回迁移成功的材料（调用方以 `source: "keychain"` 返回）；任何一步失败返回
 * `undefined`（调用方保持文件模式，下次解析重试）。失败路径必须**尽力删除刚写入的
 * 条目**：解析链里钥匙串优先于密钥文件，留下与文件材料不一致的坏条目会压过权威材料、
 * 让既有 enc:v2 凭据解不开——比不迁移严重得多。
 *
 * 并发：桌面 host 与 CLI 同时首跑迁移时，双方搬的是**同一份文件材料**——macOS/Windows
 * 的排他写入让落败方回读赢家（材料相同，验证必过）；Linux last-writer-wins 写入的也是
 * 同一材料。删除文件的失败方拿到 ENOENT → 同样按失败路径返回文件模式？不：删除竞争
 * （另一进程已删）视同成功——材料已验证入条目，文件消失正是目标状态。
 */
function migrateKeyFileToKeychain(
  keychain: CredentialKeychainAccess,
  keyFilePath: string,
  fileKey: Buffer,
  warn: (message: string) => void,
): Buffer | undefined {
  const secret = fileKey.toString("base64url");
  const written = keychain.write(keyFilePath, secret);
  if (written.status !== "written") {
    warn(
      `Credential master key migration to the OS keychain was skipped (${written.reason}); ` +
        `staying on the 0600 key file mode. Will retry on a later launch.`,
    );
    return undefined;
  }

  // 回读逐字节验证：确认条目里的材料就是文件里的那把（写入成功 ≠ 可读回，
  // 例如 secret service 在 store 与 lookup 之间掉线）。
  const verify = keychain.read(keyFilePath);
  const verified = verify.status === "found" ? tryDecodeKeychainSecret(verify.secret) : undefined;
  if (!verified || !verified.equals(fileKey)) {
    keychain.delete(keyFilePath);
    warn(
      `Credential master key migration verification failed (read-back ${verify.status}); ` +
        `the partially written keychain entry was removed and the key file remains authoritative. ` +
        `Will retry on a later launch.`,
    );
    return undefined;
  }

  try {
    unlinkSync(keyFilePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // ENOENT = 并发迁移的另一进程已删除，目标状态已达成，按成功处理。
      keychain.delete(keyFilePath);
      warn(
        `Credential master key was written to the OS keychain but the key file could not be ` +
        `removed (${code}); the entry was rolled back and the key file remains authoritative. ` +
        `Will retry on a later launch.`,
      );
      return undefined;
    }
  }

  warn(
    `INFO: the credential master key was migrated from ${keyFilePath} into the OS keychain ` +
      `and the key file was removed. Directory backups no longer carry the key material — ` +
      `see README "Local credential protection" for the new backup/rollback semantics.`,
  );
  return fileKey;
}
