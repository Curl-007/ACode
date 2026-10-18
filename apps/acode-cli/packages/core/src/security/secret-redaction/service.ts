/**
 * 转录密钥混淆服务（WI-17·进程级单例门面）。
 *
 * 所有权（spec R1/R2/R3）：本服务是「候选秘密快照 + 占位符还原表」的唯一所有者。
 * 出站投影（runtime-model.ts 的 createRuntimeModel 包装）与执行前还原
 * （executor/call-runner.ts 权限后）是两个唯一消费插点，其余任何层不得私建还原表。
 *
 * 生命周期：进程级惰性初始化一次；env 收集快照缓存（不每条消息扫全 env）；
 * 子代理/舰队/workflow 子代理同进程共享同一实例——这是跨会话占位符一致还原的前提。
 *
 * 日志红线：秘密值、HMAC 私钥值永不出现在日志/事件/遥测；本文件只输出布尔/计数/路径。
 */
import type { ModelInputMessage } from "@acode/contracts";
import { builtinCredentialSecretEntries, collectEnvSecrets, type SecretEntry } from "./collect.js";
import {
  defaultSecretKeyDir,
  loadOrCreateSecretPlaceholderKey,
  SECRET_PLACEHOLDER_KEY_FILENAME,
} from "./key.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretRedactor, type RestoreOutcome } from "./redactor.js";

interface SecretRedactionWarnSink {
  (message: string, details?: Record<string, unknown>): void;
}

interface SecretRedactionInitOptions {
  env?: NodeJS.ProcessEnv;
  /** 可选 warn 出口（接 runtime logger）；缺省静默（禁 console.log）。 */
  warn?: SecretRedactionWarnSink;
  /** 测试注入点：显式 key 目录（默认 <dataRoot>/cli/security/）。 */
  keyDir?: string;
}

interface SecretRedactionService {
  /** ACODE_SECRET_REDACTION 开关判定结果（spec R6）。 */
  readonly enabled: boolean;
  /** 出站消息投影：无命中/禁用时返回原数组引用。 */
  projectModelMessages(messages: readonly ModelInputMessage[]): ModelInputMessage[];
  /** 工具执行入参还原（深遍历）；unresolvedPlaceholders 供 fail-loud 提示。 */
  restoreToolInput(input: unknown): RestoreOutcome<unknown>;
  /** 收集面统计（仅计数，日志用）。 */
  readonly stats: { plainSecrets: number; regexEntries: number };
}

interface ServiceState {
  service: SecretRedactionService | undefined;
}

const state: ServiceState = { service: undefined };

/** ACODE_SECRET_REDACTION 开关：0/false/off（大小写不敏感）禁用；未设置/其他值启用。 */
export function parseSecretRedactionSwitch(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return true;
  return !(normalized === "0" || normalized === "false" || normalized === "off");
}

/**
 * 获取（并惰性初始化）进程级单例。初始化只做同步的 env 快照收集与 key 文件探测；
 * key 文件的**创建**推迟到第一次真正铸造占位符（无活跃秘密的会话不落 key 文件，
 * omp secretEntryNeedsPlaceholderKey 纪律，spec R5）。
 */
export function getSecretRedactionService(
  options: SecretRedactionInitOptions = {},
): SecretRedactionService {
  if (state.service !== undefined) return state.service;
  state.service = buildService(options);
  return state.service;
}

/** 测试专用：重置单例（生产代码不得调用——还原表跨请求存活是正确性前提）。 */
export function resetSecretRedactionServiceForTests(): void {
  state.service = undefined;
}

function buildService(options: SecretRedactionInitOptions): SecretRedactionService {
  const env = options.env ?? process.env;
  const enabled = parseSecretRedactionSwitch(env.ACODE_SECRET_REDACTION);
  const keyDir = options.keyDir ?? defaultSecretKeyDir(env);
  const warn = options.warn;

  // key 文件已存在 → 读出（不创建）：① 作为 HMAC 私钥；② 内容注册为 plain 秘密
  // （模型 Read 到 key 文件时出站同样占位——可复用私钥永不进转录，spec R1-4）。
  const existingKey = tryReadExistingKey(keyDir);
  const entries: SecretEntry[] = [...collectEnvSecrets(env), ...builtinCredentialSecretEntries()];
  if (existingKey !== undefined) {
    entries.unshift({ type: "plain", content: existingKey });
  }

  let resolvedKey = existingKey;
  let ephemeralWarned = false;
  const redactor = new SecretRedactor({
    entries,
    keyProvider: () => {
      if (resolvedKey !== undefined) return resolvedKey;
      if (!enabled) {
        // 禁用态绝不创建 key 文件；无既有 key 则存量占位符无法还原（如实放行）。
        throw new SecretKeyUnavailableError();
      }
      const outcome = loadOrCreateSecretPlaceholderKey(keyDir);
      resolvedKey = outcome.key;
      if (!outcome.persisted && !ephemeralWarned) {
        ephemeralWarned = true;
        warn?.("Secret placeholder key could not be persisted; using a process-ephemeral key", {
          errorCategory: outcome.persistenceError,
          event: "security.secret_redaction.key_ephemeral",
          keyDir,
          module: "core.security",
        });
      }
      // 新建的 key 内容同样注册为 plain 秘密（本进程后半段被 Read 也占位）。
      redactor.addPlainSecret(outcome.key);
      return outcome.key;
    },
  });

  if (!enabled && existingKey !== undefined) {
    // 禁用开关只关「新混淆」不关「还原」（spec R6）：预铸造 plain 占位符，
    // 让历史里的存量占位符在禁用态下仍能被工具执行还原。
    try {
      redactor.premintPlainPlaceholders();
    } catch {
      // key 不可用（理论上 existingKey 已在此分支非空，不可达）——还原表为空即放行。
    }
  }

  return {
    enabled,
    projectModelMessages(messages) {
      if (!enabled) return messages as ModelInputMessage[];
      try {
        return redactor.projectModelMessages(messages);
      } catch (error) {
        // 混淆面故障绝不阻断模型请求（防线失效降级为现状，而不是会话不可用）；
        // 只 warn 类别，不带任何文本内容。
        warn?.("Secret redaction projection failed; sending messages unredacted", {
          errorCategory: errorCategoryOf(error),
          event: "security.secret_redaction.projection_failed",
          module: "core.security",
        });
        return messages as ModelInputMessage[];
      }
    },
    restoreToolInput(input) {
      // 还原面在禁用态同样生效（R6）；key 不可用时查表为空 → 占位符原样放行。
      try {
        return redactor.restoreValue(input);
      } catch (error) {
        warn?.("Secret placeholder restoration failed; passing tool input through", {
          errorCategory: errorCategoryOf(error),
          event: "security.secret_redaction.restore_failed",
          module: "core.security",
        });
        return { value: input, unresolvedPlaceholders: 0 };
      }
    },
    stats: {
      plainSecrets: redactor.plainSecretCount,
      regexEntries: redactor.regexEntryCount,
    },
  };
}

class SecretKeyUnavailableError extends Error {}

function errorCategoryOf(error: unknown): string {
  if (error instanceof SecretKeyUnavailableError) return "key_unavailable";
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
}

function tryReadExistingKey(keyDir: string): string | undefined {
  try {
    const value = readFileSync(join(keyDir, SECRET_PLACEHOLDER_KEY_FILENAME), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * fail-loud 提示文案（spec R3）：工具失败且入参含严格形态未解析占位符时，由
 * call-runner 追加进 modelContent。告诉模型「为什么坏」与「能做什么」——占位符
 * 指向的秘密已不在本会话注册表（轮换/移除/跨重启），模型自己无法重建原文
 * （出站投影会对新读到的原文再次占位），只能请用户重新提供。
 */
export function formatUnresolvedSecretPlaceholderHint(toolName: string): string {
  return (
    `<secret_placeholder_error>The ${toolName} input contained redacted-secret placeholders ` +
    `($$…$$) that could not be restored: the referenced secret is no longer registered in this ` +
    `session (it may have been rotated, removed from the environment, or minted by an earlier ` +
    `process). Placeholders are never valid literal values. Re-read the source of the value, or ` +
    `ask the user to provide it again.</secret_placeholder_error>`
  );
}
