// ============================================================
// Provider Doctor 契约面（J3-1）
// 规格：apps/acode-cli/specs/provider-doctor.md
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 本文件只放类型与 Port 定义：诊断的**唯一契约面**。检查点目录与下一步建议在
// checkpoints.ts，编排逻辑在 run-provider-doctor.ts。
//
// 隐私硬约束（spec R5 / specs/no-telemetry.md）：任何进入报告或账本的事实都必须来自
// 这里的白名单字段。Registry 原始 config（含 hydration 后的 apiKey 明文）只在
// `ProviderDoctorProviderFacts.providerConfig` 里内存流转，绝不序列化、绝不落盘。

import type {
  Logger,
  Model,
  ModelInvocationContext,
  ModelRequestDependencies,
  ModelSelection,
} from "@acode/contracts";
import type {
  ConfigValidationIssue,
  RegistryModelConfig,
  RegistryProviderConfig,
} from "@acode/provider";
import type { ACodeProviderAccountAccess } from "@acode/shared";
import type { DnsLookup } from "../http/public-egress-policy.js";

/** 诊断档位；缺省 offline（未显式要求就不触网、不花费）。 */
export const PROVIDER_DOCTOR_TIERS = ["offline", "catalog", "live"] as const;
export type ProviderDoctorTier = (typeof PROVIDER_DOCTOR_TIERS)[number];

export type ProviderDoctorCheckStatus = "passed" | "failed" | "skipped" | "blocked";

/**
 * 12 个检查点的稳定 id（spec R3）。账本、输出、覆盖视图共用同一套 id，
 * 因此改这里等于改账本 schema——新增只能追加，不能重命名既有条目。
 */
export type ProviderDoctorCheckpointId =
  | "config_sources_loaded"
  | "provider_schema_valid"
  | "endpoint_shape_valid"
  | "credential_available"
  | "catalog_models_declared"
  | "model_route_resolved"
  | "endpoint_public_egress"
  | "catalog_live_endpoint"
  | "catalog_model_listed"
  | "non_streaming_chat_completion"
  | "streaming_chat_completion"
  | "tool_call_parse";

/** ready 只可能出现在 live 档全通过；轻档最高只到 tier-passed（不越档背书）。 */
export type ProviderDoctorVerdict = "ready" | "tier-passed" | "failed";

/** 凭据来源类型：只描述「凭据从哪来」，不含任何值或值的派生物（spec R5）。 */
export type ProviderDoctorCredentialSource =
  | "credential-ref"
  | "inline-config"
  | "account-credential"
  | "none";

/**
 * 复用 `@acode/provider` 的诊断事实类型（含 severity 语义），使「阻断级」判定能直接走
 * `isBlockingConfigIssue`——该谓词是仓库唯一门控，禁止调用点手写 severity 过滤。
 */
export interface ProviderDoctorConfigIssue {
  readonly code: ConfigValidationIssue["code"];
  readonly path: readonly string[];
  readonly message: string;
  readonly severity?: ConfigValidationIssue["severity"];
}

export interface ProviderDoctorAccessFacts {
  readonly type: "api-key" | "zhipu-coding-plan-api-key" | "zhipu-account" | "none";
  readonly accountType?: "zai" | "bigmodel";
  readonly accountMode?: string;
  readonly entitled?: boolean;
  /** 配置文件里是否残留明文 apiKey（迁移前/回退态）；只记布尔，不记值。 */
  readonly hasInlineApiKey: boolean;
  /** 是否存在凭据库引用（引用是否可解密由 credential port 判定）。 */
  readonly hasCredentialRef: boolean;
  /**
   * 凭据库引用键名（形如 `provider:apikey:<id>`）。键名是确定性字符串、不是秘密，
   * 但它只用于内存里定位凭据：报告与账本都不携带（spec R5）。
   */
  readonly credentialRef?: string;
  readonly apiKeyManagementUrl?: string;
}

/**
 * 账号型 provider 的请求级鉴权端口。CLI 接线用 bootstrap 返回的
 * `providerRuntimeHeadersPort` 实现；诊断只在内存中拿它构造请求头，
 * 输出与账本永远看不到值。
 */
export interface ProviderDoctorAccountAuthPort {
  resolve(input: {
    providerId: string;
    modelId?: string;
    /**
     * 账号型 provider 的请求身份（评审 J3 修复）。与真实模型路径同源：runner 每次调用都带
     * `accountAccess: options.providerConfig.access`（adapters/src/model/runner.ts:151/216/242/254），
     * 而 standalone headers port 在缺它时直接抛「请求身份无效」
     * （bootstrap/src/app/standalone-account-provider-runtime.ts:180-183）。诊断端口不给这个事实，
     * 已登录且凭据可解密的账号型 provider 就会被误报成「凭据解密失败，请重新登录」（违反 spec R3 #4）。
     */
    accountAccess?: ACodeProviderAccountAccess;
    abortSignal?: AbortSignal;
  }): Promise<{ apiKey?: string; headers?: Record<string, string> } | undefined>;
}

export interface ProviderDoctorModelFacts {
  readonly modelId: string;
  readonly supportsToolCall: boolean;
  readonly supportsJsonSchemaOutput: boolean;
  readonly reasoningLevels: readonly string[];
  readonly maxOutputTokens: number;
  readonly issues: readonly ProviderDoctorConfigIssue[];
}

export interface ProviderDoctorProviderFacts {
  readonly providerId: string;
  readonly providerName?: string;
  readonly templateId?: string;
  readonly access: ProviderDoctorAccessFacts;
  readonly apiType?: string;
  readonly baseUrl?: string;
  readonly models: readonly ProviderDoctorModelFacts[];
  readonly issues: readonly ProviderDoctorConfigIssue[];
  /** live 档构造真实 Model 用的 Registry 原始事实；只在内存流转，绝不序列化。 */
  readonly providerConfig: RegistryProviderConfig;
  readonly modelConfigs: Readonly<Record<string, RegistryModelConfig>>;
  /**
   * 本次运行在内存中可见的凭据真值，供脱敏器逐字剔除（spec R5）。
   * 只用于「从输出里删掉它」，绝不写入任何输出、日志或账本。
   */
  readonly secretValues: readonly string[];
}

export interface ProviderDoctorRegistrySnapshot {
  readonly revision: string;
  readonly sources: {
    readonly acodeBuiltinFilePath?: string;
    readonly personalFilePath?: string;
    readonly credentialsFilePath?: string;
  };
  readonly providers: readonly ProviderDoctorProviderFacts[];
  readonly issues?: readonly ProviderDoctorConfigIssue[];
}

export interface ProviderDoctorCredentialProbe {
  readonly status: "available" | "missing" | "undecryptable";
  readonly source: ProviderDoctorCredentialSource;
  /** 人类可读原因，只允许出现来源/路径/布尔事实，不允许出现值。 */
  readonly detail: string;
}

export interface ProviderDoctorSpend {
  readonly billableCalls: number;
  readonly catalogCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly hasTokenData: boolean;
}

export interface ProviderDoctorRunnerInfo {
  /** release 构建 = user（真实用户证据）；dev/dirty = developer。由 CLI 接线判定。 */
  readonly actor: "user" | "developer";
  readonly cliVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly sea: boolean;
  readonly pid: number;
}

export interface ProviderDoctorLedgerCheck {
  readonly id: ProviderDoctorCheckpointId;
  readonly status: ProviderDoctorCheckStatus;
  /** 仅非通过项保留，已脱敏并截断（spec R5/R6）。 */
  readonly detail?: string;
}

export interface ProviderDoctorLedgerEvent {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly recordedAt: string;
  readonly tier: ProviderDoctorTier;
  readonly providerId: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  /** 只记 host：不含 query、header、凭据。 */
  readonly endpointHost?: string;
  readonly result: ProviderDoctorVerdict;
  readonly checks: readonly ProviderDoctorLedgerCheck[];
  readonly firstFailure?: { readonly id: ProviderDoctorCheckpointId; readonly hint: string };
  readonly spend: ProviderDoctorSpend;
  readonly runner?: ProviderDoctorRunnerInfo;
  readonly retestAfter: string;
}

export interface ProviderDoctorCheckResult {
  readonly id: ProviderDoctorCheckpointId;
  readonly label: string;
  readonly status: ProviderDoctorCheckStatus;
  readonly detail: string;
  readonly durationMs?: number;
}

export interface ProviderDoctorReport {
  readonly providerId: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly tier: ProviderDoctorTier;
  readonly endpointHost?: string;
  readonly checks: readonly ProviderDoctorCheckResult[];
  readonly verdict: ProviderDoctorVerdict;
  readonly tierPassed: boolean;
  readonly ready: boolean;
  readonly spend: ProviderDoctorSpend;
  /** 未通过项的下一步命令建议（spec R7），按检查点顺序。 */
  readonly nextSteps: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ProviderDoctorCoverageRow {
  readonly providerId: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly ready: boolean;
  readonly clearedCheckpoints: number;
  readonly totalCheckpoints: number;
  readonly firstBlockerId?: ProviderDoctorCheckpointId;
  readonly nextCommand?: string;
  readonly recordedAt: string;
  readonly tier: ProviderDoctorTier;
  readonly runner?: ProviderDoctorRunnerInfo;
  readonly spend: ProviderDoctorSpend;
  readonly stale: boolean;
}

export interface ProviderDoctorCoverageSummary {
  readonly rows: readonly ProviderDoctorCoverageRow[];
  readonly recordedSpend: ProviderDoctorSpend;
  readonly corruptLines: number;
}

export interface ProviderDoctorRunResult {
  readonly tier: ProviderDoctorTier;
  readonly reports: readonly ProviderDoctorReport[];
  readonly coverage?: ProviderDoctorCoverageSummary;
  readonly ledgerPath?: string;
  /** offline 档被拦下的网络尝试次数；>0 说明有代码路径违背零网络承诺。 */
  readonly blockedNetworkCalls: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

// ------------------------------------------------------------
// Ports：全部可注入。默认实现见 defaults.ts；测试与 offline 档用 fake/blocked 实现。
// ------------------------------------------------------------

export interface ProviderDoctorRegistryPort {
  /** 本地读取：配置源、schema 准入、目录声明。**必须零网络**（spec R2）。 */
  loadLocalSnapshot(): Promise<ProviderDoctorRegistrySnapshot>;
  /** catalog/live 档可刷新配置源（可能触网）；缺省时编排回退到本地快照。 */
  refreshSnapshot?(): Promise<ProviderDoctorRegistrySnapshot>;
}

export interface ProviderDoctorCredentialPort {
  /** 只回答「有没有、能不能解密、从哪来」，绝不返回值本身（spec R5）。 */
  probe(input: {
    providerId: string;
    access: ProviderDoctorAccessFacts;
    modelId?: string;
    /**
     * 账号型 provider 的请求身份（来自 `providerConfig.access`，只在内存流转）。
     * 探测端口需要它才能向接线的 headers port 证明「这是哪一种账号身份」，
     * 否则已登录账号会被判成解密失败（见 ProviderDoctorAccountAuthPort.accountAccess）。
     */
    accountAccess?: ACodeProviderAccountAccess;
  }): Promise<ProviderDoctorCredentialProbe>;
}

export interface ProviderDoctorHttpPort {
  request(input: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; bodyText: string }>;
}

export interface ProviderDoctorModelPort {
  /** 复用既有 AI SDK 模型客户端；诊断不自己构造 provider 请求。 */
  createModel(input: { providerId: string; modelId: string }): Model;
}

export interface ProviderDoctorLedgerPort {
  record(event: ProviderDoctorLedgerEvent): Promise<void>;
  read(): Promise<{ events: readonly ProviderDoctorLedgerEvent[]; corruptLines: number }>;
}

export interface ProviderDoctorRunInput {
  readonly tier: ProviderDoctorTier;
  readonly registry: ProviderDoctorRegistryPort;
  readonly credentials: ProviderDoctorCredentialPort;
  readonly http: ProviderDoctorHttpPort;
  readonly models: ProviderDoctorModelPort;
  readonly ledger?: ProviderDoctorLedgerPort;
  readonly ledgerPath?: string;
  /** 缺省 = 诊断快照里的全部 provider。 */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly defaultModelSelection?: ModelSelection;
  readonly runner?: ProviderDoctorRunnerInfo;
  readonly dnsLookup?: DnsLookup;
  /** 账号型 provider 的凭据探测与目录请求鉴权（spec R3 #4 / #8）。 */
  readonly accountAuth?: ProviderDoctorAccountAuthPort;
  /** 账号型 provider 的请求级鉴权（invocation context 路径，spec R2/接口章）。 */
  readonly invocationContext?: ModelInvocationContext;
  readonly requestDependencies?: ModelRequestDependencies;
  readonly now?: () => Date;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** 单次模型探测的超时；缺省 30s。 */
  readonly probeTimeoutMs?: number;
  /** 证据新鲜度窗口（天），缺省 14（spec R6）。 */
  readonly retestDays?: number;
}

export const PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION = 1;
export const PROVIDER_DOCTOR_DEFAULT_RETEST_DAYS = 14;
/** live 档探针的输出上限：够解析出结果即可，刻意压到最小花费。 */
export const PROVIDER_DOCTOR_PROBE_MAX_OUTPUT_TOKENS = 64;
