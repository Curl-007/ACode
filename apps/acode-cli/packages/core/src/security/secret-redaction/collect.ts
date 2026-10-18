/**
 * 候选秘密收集（WI-17 转录密钥混淆·收集面）。
 *
 * 语义移植自 oh-my-pi（MIT License, Copyright (c) oh-my-pi contributors）
 * `packages/coding-agent/src/secrets/index.ts` 的 collectEnvSecrets /
 * builtinCredentialSecretEntries。omp 的 secrets.yml 加载面不移植：ACode 无
 * 项目级 secrets 配置面，按任务纪律不发明（spec R1-5）。
 *
 * 快照纪律：收集是纯同步函数，由服务单例在进程内调用**一次**并缓存（spec R1），
 * 不在每条消息的出站投影里重扫 process.env。
 */
import { CREDENTIAL_PATTERNS } from "./patterns.js";

/** 秘密条目：plain 原文精确匹配，regex 模式匹配（内置凭据族）。 */
export interface SecretEntry {
  type: "plain" | "regex";
  content: string;
  /** 正则 flags（仅 regex 类型）。 */
  flags?: string;
  /** 占位符友好标签（净化后作前缀，仅 regex 内置族使用）。 */
  friendlyName?: string;
  /** 见 patterns.ts：正则的快速跳过字面量门。 */
  literalPrefixes?: readonly string[];
}

/** env 值被视为秘密的最短长度（omp MIN_ENV_VALUE_LENGTH 同款）。 */
export const MIN_ENV_VALUE_LENGTH = 8;

/** 命中即视为秘密载体的变量名模式（omp SECRET_ENV_PATTERNS 原样）。 */
export const SECRET_ENV_PATTERNS =
  /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** 从 `scheme://user:password@host` 形态值提取密码组（omp CONNECTION_URL_PASSWORD_RE 原样）。 */
export const CONNECTION_URL_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/:@?#\s]*:([^/?#\s]+)@/i;

/**
 * 收集环境变量中形似秘密的值：
 *  1. 名字命中 SECRET_ENV_PATTERNS 且值长度 ≥8；
 *  2. 第二遍：任何变量值形如连接串时提取内嵌密码（无视变量名，如 DATABASE_URL），
 *     原文与 percent-decoded 形态各收一次（都需 ≥8）。
 * 按值去重。已知的过度收集（SSH_AUTH_SOCK 之类）是可逆混淆，代价透明（spec R1）。
 */
export function collectEnvSecrets(env: NodeJS.ProcessEnv = process.env): SecretEntry[] {
  const entries: SecretEntry[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!SECRET_ENV_PATTERNS.test(name)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    entries.push({ type: "plain", content: value });
  }
  for (const value of Object.values(env)) {
    const match = CONNECTION_URL_PASSWORD_RE.exec(value ?? "");
    if (!match) continue;
    const password = match[1];
    if (password.length >= MIN_ENV_VALUE_LENGTH && !seen.has(password)) {
      seen.add(password);
      entries.push({ type: "plain", content: password });
    }
    try {
      const decoded = decodeURIComponent(password);
      if (decoded !== password && decoded.length >= MIN_ENV_VALUE_LENGTH && !seen.has(decoded)) {
        seen.add(decoded);
        entries.push({ type: "plain", content: decoded });
      }
    } catch {
      // 畸形 percent 编码——原文形态已注册，跳过解码形态。
    }
  }
  return entries;
}

/**
 * 内置凭据正则族条目（omp builtinCredentialSecretEntries 同款动机）：厂商 token 若
 * 只靠不可逆脱敏，模型会把脱敏标记回写进 Edit old_string，永远匹配不上磁盘真字节。
 * 走可逆占位符则工具执行前能还原，编辑闭环不破。这里没有熵门——假阳性只是过度
 * 混淆，往返无损。
 */
export function builtinCredentialSecretEntries(): SecretEntry[] {
  return CREDENTIAL_PATTERNS.map((pattern) => ({
    type: "regex" as const,
    content: pattern.source,
    ...(pattern.flags === undefined ? {} : { flags: pattern.flags }),
    friendlyName: pattern.name,
    ...(pattern.literalPrefixes === undefined ? {} : { literalPrefixes: pattern.literalPrefixes }),
  }));
}
