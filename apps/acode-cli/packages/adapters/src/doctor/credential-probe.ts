// ============================================================
// Provider Doctor 凭据探测（J3-1 / spec R3 #4 + R5）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// offline 档要回答「凭据能不能用」，但**绝不**把值带出这个文件：
// - BYO provider：`vault.load(ref)` 的结果只参与「非空」判断，随即丢弃；
// - 账号型 provider：凭据键名约定属于 CLI/bootstrap（`standaloneAccountProviderCredentialKey`），
//   adapters 不复制它，改由接线注入 `ProviderDoctorAccountAuthPort`，探测只取「有没有」。
// 因此本模块的输出只有三种状态 + 来源类型 + 一句不含值的原因文本。

import { isApiKeyAccess } from "@acode/provider";
import type { RegistryProviderConfig } from "@acode/provider";
import type { ACodeProviderAccountAccess } from "@acode/shared";
import type {
  ProviderDoctorAccessFacts,
  ProviderDoctorAccountAuthPort,
  ProviderDoctorCredentialPort,
  ProviderDoctorCredentialProbe,
} from "./types.js";

/** `ProviderApiKeyVault` 的读侧结构子集（load 语义：null=引用悬空，抛错=库不可用）。 */
export interface ProviderDoctorApiKeyVaultReader {
  load(credentialRef: string): Promise<string | null>;
}

export interface ProviderDoctorCredentialProbeDeps {
  readonly vault?: ProviderDoctorApiKeyVaultReader;
  readonly accountAuth?: ProviderDoctorAccountAuthPort;
  readonly credentialsFilePath?: string;
}

export function createProviderDoctorCredentialPort(
  deps: ProviderDoctorCredentialProbeDeps = {},
): ProviderDoctorCredentialPort {
  const storeLabel = deps.credentialsFilePath ? `凭据库（${deps.credentialsFilePath}）` : "凭据库";
  return {
    async probe(input): Promise<ProviderDoctorCredentialProbe> {
      const { providerId, access } = input;
      if (access.type === "zhipu-account") {
        return probeAccountAccess(
          providerId,
          access,
          input.modelId,
          input.accountAccess,
          deps,
          storeLabel,
        );
      }
      if (access.type === "none") {
        return {
          status: "missing",
          source: "none",
          detail: `provider ${providerId} 未配置 access（既无 API Key 也无账号）`,
        };
      }
      return probeApiKeyAccess(providerId, access, deps, storeLabel);
    },
  };
}

/**
 * 从 Registry 原始配置里取运行期 API Key（可能来自凭据库 hydration）。
 * 只允许在构造请求头的那一刻使用；调用方必须把返回值登记进 redactor 的已知真值集合。
 */
export function resolveProviderDoctorApiKey(
  providerConfig: RegistryProviderConfig,
): string | undefined {
  const access = providerConfig.access;
  if (!access || !isApiKeyAccess(access)) return undefined;
  const apiKey = access.apiKey?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : undefined;
}

/**
 * 从 Registry 原始配置里取账号型 provider 的请求身份（评审 J3 修复）。
 * 与真实模型路径同一来源（runner.ts:151 `accountAccess: options.providerConfig.access`）：
 * 接线的 standalone headers port 用它判定「这是不是 individual-coding-plan 身份」，
 * 缺了它就抛「请求身份无效」，把已登录账号误报成凭据解密失败。
 * 只在内存流转，绝不进报告或账本（spec R5）。
 */
export function resolveProviderDoctorAccountAccess(
  providerConfig: RegistryProviderConfig,
): ACodeProviderAccountAccess | undefined {
  const access = providerConfig.access;
  return access && access.type === "zhipu-account" ? access : undefined;
}

async function probeApiKeyAccess(
  providerId: string,
  access: ProviderDoctorAccessFacts,
  deps: ProviderDoctorCredentialProbeDeps,
  storeLabel: string,
): Promise<ProviderDoctorCredentialProbe> {
  if (access.hasCredentialRef) {
    if (!deps.vault || !access.credentialRef) {
      return {
        status: "undecryptable",
        source: "credential-ref",
        detail: `provider ${providerId} 使用凭据库引用，但本次运行未注入凭据库，无法验证可解密`,
      };
    }
    try {
      const value = await deps.vault.load(access.credentialRef);
      if (value && value.trim().length > 0) {
        return {
          status: "available",
          source: "credential-ref",
          detail: `${storeLabel}中的 API Key 引用可解密（值不输出）`,
        };
      }
      return {
        status: "missing",
        source: "credential-ref",
        detail: `${storeLabel}中没有该引用对应的值（凭据被清理，或跨机迁移未带凭据）`,
      };
    } catch (error) {
      return {
        status: "undecryptable",
        source: "credential-ref",
        detail: `${storeLabel}不可用或解密失败: ${errorMessage(error)}`,
      };
    }
  }

  if (access.hasInlineApiKey) {
    return {
      status: "available",
      source: "inline-config",
      detail: `provider 配置内联了明文 API Key（建议迁移到${storeLabel}）`,
    };
  }

  return {
    status: "missing",
    source: "none",
    detail: `provider ${providerId} 既没有凭据库引用也没有内联 API Key`,
  };
}

async function probeAccountAccess(
  providerId: string,
  access: ProviderDoctorAccessFacts,
  modelId: string | undefined,
  accountAccess: ACodeProviderAccountAccess | undefined,
  deps: ProviderDoctorCredentialProbeDeps,
  storeLabel: string,
): Promise<ProviderDoctorCredentialProbe> {
  const planLabel = access.accountType === "bigmodel" ? "BigModel" : "Z.AI";
  const modeLabel = access.accountMode ? `（mode=${access.accountMode}）` : "";
  if (access.entitled === false) {
    return {
      status: "missing",
      source: "account-credential",
      detail: `${planLabel} 账号未获得该 Coding Plan 权益（entitled=false）${modeLabel}`,
    };
  }
  if (!deps.accountAuth) {
    return {
      status: "missing",
      source: "account-credential",
      detail: `${planLabel} 账号凭据探测端口未注入，无法确认${storeLabel}中的登录状态`,
    };
  }
  try {
    const auth = await deps.accountAuth.resolve({
      providerId,
      ...(modelId ? { modelId } : {}),
      // 请求身份随探测一起下发：接线的 headers port 靠它区分账号模式，缺了它会直接抛
      // 「请求身份无效」，从而把「已登录且可解密」误判成 undecryptable → blocked。
      ...(accountAccess ? { accountAccess } : {}),
    });
    return hasRequestAuth(auth)
      ? {
          status: "available",
          source: "account-credential",
          detail: `${planLabel} 账号凭据可解密${modeLabel}（值不输出）`,
        }
      : {
          status: "missing",
          source: "account-credential",
          detail: `${planLabel} 账号凭据缺失或已失效${modeLabel}：需要重新登录`,
        };
  } catch (error) {
    return {
      status: "undecryptable",
      source: "account-credential",
      detail: `${planLabel} 账号凭据解密失败: ${errorMessage(error)}`,
    };
  }
}

export function hasRequestAuth(
  auth: { apiKey?: string; headers?: Record<string, string> } | undefined,
): boolean {
  if (auth?.apiKey && auth.apiKey.trim().length > 0) return true;
  return Object.values(auth?.headers ?? {}).some((value) => value.trim().length > 0);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // 异常文本可能带出请求头或 Key（provider/HTTP 层拼接），这里只保留一行短原因，
  // 最终仍会再过一次 redactor（spec R5）。
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}
