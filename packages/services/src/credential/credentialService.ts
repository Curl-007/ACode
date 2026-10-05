import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@acode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
  isCredentialDecryptError,
} from "@acode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 凭据存储路径
 *
 * 当前持久化格式仍是 JSON，但 value 会在写入前加密，读取时自动解密。
 * 后续可切换到 Electron safeStorage（钥匙串）托管密钥，
 * 届时 host process 需要向 main 进程请求 encrypt/decrypt。
 */
const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ACode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ACode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): ICredentialService {
  // 密钥文件必须与 credentials.json 同目录（同受 setDataBaseDir/ACODE_DATA_BASE_DIR 控制）。
  // 若各自独立解析 baseDir，宿主用 setDataBaseDir 切换数据根后会出现「凭据在新目录、
  // 密钥在旧目录」的分裂，直接导致解密失败。显式把凭据目录钉给 cipher。
  const cipherProvider =
    dependencies.cipherProvider ??
    createCredentialCipherProvider({ keyFilePath: join(getCredentialsDir(), "credential-key.json") });

  /**
   * R2 自愈收敛：把「分歧密钥文件材料回退命中」的值用主密钥材料重加密写回。
   * CAS 语义：锁内发现该值已被其他进程改写（已收敛或重新保存）则放弃本次重写。
   * 收敛失败不影响本次读取——值仍可经回退材料读取，下次读取重试。
   */
  async function reconvergeDivergentValue(
    key: string,
    expectedRawValue: string,
    plaintext: string,
    credentialsFile: string,
  ): Promise<void> {
    try {
      const rewrote = await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        if (creds[key] !== expectedRawValue) {
          return false;
        }
        creds[key] = cipherProvider.encrypt(plaintext);
        await writeAll(credentialsFile, creds);
        return true;
      });
      if (rewrote) {
        logger.info(
          undefined,
          "credential value re-encrypted with the primary master key after divergent-material fallback",
          { key },
        );
      }
    } catch (error) {
      logger.warn(
        undefined,
        "credential value reconvergence after divergent-material fallback failed; the value stays readable via the fallback material",
        { key, error },
      );
    }
  }

  return {
    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      const creds = await readAll(credentialsFile);
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      let plaintext: string;
      let usedFallbackKey = false;
      try {
        if (cipherProvider.decryptWithFallbackInfo) {
          ({ plaintext, usedFallbackKey } = cipherProvider.decryptWithFallbackInfo(rawValue));
        } else {
          plaintext = cipherProvider.decrypt(rawValue);
        }
      } catch (error) {
        // R2 留证：解密失败会被下游放大成 OAuth 强制登出（clearCorruptOAuthSession
        // 逐条删除条目）。删除前把原始密文完整留证，用户找回原密钥材料后还能从
        // .bak 恢复——「解不开」不再是不可逆丢失。backupCorruptFile 按内容哈希
        // 幂等收敛到一份证据（0600），日志只含路径不含凭据内容。
        if (isCredentialDecryptError(error)) {
          const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
          logger.warn(undefined, "credential decrypt failed; raw store backed up before recovery", {
            backupPath,
            credentialsFile,
          });
        }
        throw error;
      }

      if (usedFallbackKey) {
        // R2：该值是密钥分歧期间由旧密钥文件材料写入的，立即用主密钥材料重加密
        // 收敛，让存储回到单一材料态（全部分歧值收敛后删除多余密钥文件才安全）。
        await reconvergeDivergentValue(validatedKey, rawValue, plaintext, credentialsFile);
      }
      return plaintext;
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = cipherProvider.encrypt(validatedValue);
      const credentialsFile = getCredentialsFile();
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
