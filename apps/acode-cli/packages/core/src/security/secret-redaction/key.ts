/**
 * per-install HMAC 私钥生命周期（WI-17 转录密钥混淆·密钥面）。
 *
 * 语义移植自 oh-my-pi（MIT License, Copyright (c) oh-my-pi contributors）
 * `packages/coding-agent/src/secrets/index.ts` 的 getSecretPlaceholderKeySync /
 * readPlaceholderKeyFile；Bun API 降解为 node:fs / node:crypto，异步读改写同步
 * （理由见 spec R5：Model.streamText 契约要求同步返回 AsyncIterable，惰性异步
 * 初始化会让内层调用脱离 runWithModelInvocationContext 的 ALS 作用域；omp 的
 * getSecretPlaceholderKeySync 是同型先例。一次/进程、43 字节，非热路径）。
 *
 * 红线：key 值永不出现在日志/事件/遥测——本文件与调用方只允许记录路径、布尔与
 * 错误类别。key 文件内容另由收集面注册为 plain 秘密（spec R1-4），模型 Read 到
 * 它时出站投影同样占位。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLACEHOLDER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export const SECRET_PLACEHOLDER_KEY_FILENAME = "secret-placeholder.key";

/**
 * 数据根目录：镜像 core/src/ambient/usage-ledger.ts 的 defaultAmbientDataRootDir
 * 优先级（ACODE_DATA_BASE_DIR > HOME > homedir()），CLI 安全面落 `<root>/cli/security/`。
 * 不 import usage-ledger（避免 security→ambient 的横向依赖），约定以注释互指。
 */
export function defaultSecretKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ACODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir();
  return join(base, ".acode", "cli", "security");
}

interface SecretPlaceholderKeyOutcome {
  /** 可用密钥（持久化的或进程 ephemeral 的）。 */
  key: string;
  /** 密钥是否成功持久化（false = ephemeral 降级，占位符跨重启不稳定）。 */
  persisted: boolean;
  /** 持久化失败时的错误类别（不含 key 值），供 warn 日志。 */
  persistenceError?: string;
}

/**
 * 读取或创建 per-install 私钥。
 *
 * - 已存在且合法（43 字符 base64url）→ 直接复用（跨会话占位符稳定性的来源）。
 * - 不存在 → randomBytes(32) 以 `wx`（O_EXCL）+ mode 0600 创建；EEXIST 竞态时读
 *   赢家并校验（omp 同款：赢家可能写到一半，空/非法内容按失败处理）。
 * - 已存在但非法（截断/损坏）→ 不覆盖、不抛：ephemeral 降级（占位符仍可逆，
 *   只是本进程私有）。
 * - 目录不可写等持久化失败 → ephemeral 降级 + persistenceError（调用方 warn）。
 *
 * win32 语义如实：NTFS 忽略 POSIX mode 位，0600 不产生 ACL 收紧（spec R5/R8-6）。
 */
export function loadOrCreateSecretPlaceholderKey(keyDir: string): SecretPlaceholderKeyOutcome {
  const keyPath = join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME);
  const existing = tryReadKeyFile(keyPath);
  if (existing !== undefined) {
    return { key: existing, persisted: true };
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(keyPath, generated, { flag: "wx", mode: 0o600 });
    return { key: generated, persisted: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // 竞态：另一进程先创建。读赢家；空/非法则本进程 ephemeral（不缓存空 key——
      // 空 key 是已知值，可被字典化，omp readPlaceholderKeyFile 注释同款理由）。
      const winner = tryReadKeyFile(keyPath);
      if (winner !== undefined) {
        return { key: winner, persisted: true };
      }
      return {
        key: randomBytes(32).toString("base64url"),
        persisted: false,
        persistenceError: "key_file_present_but_unreadable",
      };
    }
    return {
      key: randomBytes(32).toString("base64url"),
      persisted: false,
      persistenceError: describeKeyError(err),
    };
  }
}

function tryReadKeyFile(keyPath: string): string | undefined {
  try {
    const value = readFileSync(keyPath, "utf8").trim();
    return PLACEHOLDER_KEY_RE.test(value) ? value : undefined;
  } catch {
    // 不存在或不可读——交给创建路径处理。
    return undefined;
  }
}

/** 错误类别化（绝不把 err.message 之外的敏感上下文带出；message 不含 key 值）。 */
function describeKeyError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ?? "unknown";
}
