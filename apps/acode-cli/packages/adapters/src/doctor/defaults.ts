// ============================================================
// Provider Doctor Port 默认实现（J3-1）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 诊断本体只认 Port；这里把「ACode 真实的 provider 基础设施」接上去：
// - 模型调用 → `AiSdkModelAdapter`（既有 provider 客户端，绝不裸 fetch）
// - 目录请求 → `NodeHttpClientAdapter` + `egressPolicy:"public"`（既有 DNS 预检/过检建连）
// - 快照 → `@acode/provider` 的 Registry 视图 + resolution 诊断
// - offline 档 → blocked transport：任何网络尝试都变成可见失败，而不是静默出网

import type { Logger, Model, ModelRequestDependencies } from "@acode/contracts";
import type {
  ConfigValidationIssue,
  Provider,
  ProviderRegistryServiceSnapshot,
  RegistryModelConfig,
  ResolvedProvider,
} from "@acode/provider";
import { isApiKeyAccess } from "@acode/provider";
// 本文件是 doctor 唯一允许引用底层 HTTP adapter 的装配点（对抗复核 F7 后的测试钉住
// 豁免）：catalog+ 档经 createNodeHttpClientAdapter + `egressPolicy:"public"` 出网
// （DNS 预检 + 过检建连 + 代理缺省拒绝），offline 档由 run-provider-doctor.ts 的
// tier guard 换成 blocked transport。doctor 其余文件不得出现 node:http(s)/undici/
// node:dns 直接导入——出网只经 HttpClientPort / 模型客户端 Port。
import { createNodeHttpClientAdapter, type NodeHttpClientAdapterOptions } from "../http/index.js";
import type { DnsLookup } from "../http/public-egress-policy.js";
import { AiSdkModelAdapter } from "../model/runner.js";
import type { AiSdkNetworkConfig, EnvRecord } from "../model/model-execution.js";
import { resolveProviderDoctorApiKey } from "./credential-probe.js";
import type {
  ProviderDoctorAccessFacts,
  ProviderDoctorConfigIssue,
  ProviderDoctorHttpPort,
  ProviderDoctorModelFacts,
  ProviderDoctorModelPort,
  ProviderDoctorProviderFacts,
  ProviderDoctorRegistrySnapshot,
} from "./types.js";

// ------------------------------------------------------------
// HTTP：blocked（offline 档）/ Node 适配器（catalog+ 档）
// ------------------------------------------------------------

export interface BlockedProviderDoctorHttpPort extends ProviderDoctorHttpPort {
  /** 被拦下的请求次数；>0 说明有代码路径违背 offline 零网络承诺。 */
  readonly attempts: number;
}

export function createBlockedProviderDoctorHttpPort(
  reason = "provider doctor offline 档禁止网络请求",
): BlockedProviderDoctorHttpPort {
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    async request(request): Promise<never> {
      attempts += 1;
      throw new Error(`${reason}（目标 host: ${safeHost(request.url)}）`);
    },
  };
}

export function createNodeProviderDoctorHttpPort(
  options: NodeHttpClientAdapterOptions & { dnsLookup?: DnsLookup } = {},
): ProviderDoctorHttpPort {
  const client = createNodeHttpClientAdapter(options);
  return {
    async request(request) {
      const response = await client.request(
        {
          url: request.url,
          method: "GET",
          headers: request.headers,
          // 诊断请求走公网出口档：DNS 预检 + 过检解析建连 + 代理缺省拒绝（spec R4）。
          egressPolicy: "public",
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        },
        request.signal ? { signal: request.signal } : {},
      );
      return {
        status: response.status,
        bodyText: new TextDecoder().decode(response.body),
      };
    },
  };
}

// ------------------------------------------------------------
// Model：复用既有 AI SDK 适配器
// ------------------------------------------------------------

export interface AiSdkProviderDoctorModelPortOptions {
  readonly snapshot: ProviderDoctorRegistrySnapshot;
  readonly env?: EnvRecord;
  readonly logger?: Logger;
  readonly network?: AiSdkNetworkConfig;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** 账号型 provider 的 off-peak 请求级鉴权（runner.ts 的既有注入点）。 */
  readonly requestDependencies?: ModelRequestDependencies;
}

export function createAiSdkProviderDoctorModelPort(
  options: AiSdkProviderDoctorModelPortOptions,
): ProviderDoctorModelPort {
  const adapter = new AiSdkModelAdapter({
    ...(options.env ? { env: options.env } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.network ? { network: options.network } : {}),
    ...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  });
  const providerById = new Map(options.snapshot.providers.map((item) => [item.providerId, item]));
  const cache = new Map<string, Model>();

  return {
    createModel(input) {
      const key = `${input.providerId}\u0000${input.modelId}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const provider = providerById.get(input.providerId);
      const modelConfig = provider?.modelConfigs[input.modelId];
      if (!provider || !modelConfig) {
        throw new Error(
          `provider doctor 无法构造模型客户端: ${input.providerId}/${input.modelId} 不在快照内`,
        );
      }
      const model = adapter.createModel({
        providerId: input.providerId,
        modelId: input.modelId,
        providerConfig: provider.providerConfig,
        modelConfig,
        ...(options.requestDependencies ? { requestDependencies: options.requestDependencies } : {}),
      });
      cache.set(key, model);
      return model;
    },
  };
}

// ------------------------------------------------------------
// Registry 快照投影
// ------------------------------------------------------------

export interface ProviderDoctorSnapshotProjectionInput {
  /** Registry 视图（已 hydrate 凭据的运行期事实）。 */
  readonly providers: readonly Provider[];
  /** resolution 层的诊断（schema issue、模型级 issue）；缺席时按无 issue 处理。 */
  readonly resolvedProviders?: readonly ResolvedProvider[];
  readonly resolutionIssues?: readonly ConfigValidationIssue[];
  readonly revision?: string | number;
  readonly sources?: ProviderDoctorRegistrySnapshot["sources"];
}

/**
 * 把 Registry 事实投影成诊断用的白名单快照。
 *
 * 原始 `providerConfig`/`modelConfig` 被保留（live 档构造 Model 必需），但只走内存；
 * 同时把其中出现的凭据真值收集进 `secretValues`，供 redactor 逐字剔除（spec R5）。
 */
export function toProviderDoctorRegistrySnapshot(
  input: ProviderDoctorSnapshotProjectionInput,
): ProviderDoctorRegistrySnapshot {
  const resolvedById = new Map(
    (input.resolvedProviders ?? []).map((provider) => [provider.providerId, provider]),
  );
  const providers: ProviderDoctorProviderFacts[] = input.providers.map((provider) => {
    const resolved = resolvedById.get(provider.providerId);
    const secretValues: string[] = [];
    const access = toProviderDoctorAccessFacts(provider, secretValues);
    const modelIssuesById = new Map<string, readonly ConfigValidationIssue[]>();
    for (const model of resolved?.models ?? []) {
      modelIssuesById.set(model.modelId, model.issues);
    }
    const modelConfigs: Record<string, RegistryModelConfig> = {};
    const models: ProviderDoctorModelFacts[] = provider.models.map((model) => {
      modelConfigs[model.modelId] = model.config;
      const optionSpecs = model.config.optionSpecs;
      return Object.freeze({
        modelId: model.modelId,
        supportsToolCall: model.config.properties?.supportsToolCall === true,
        supportsJsonSchemaOutput: model.config.properties?.supportsJsonSchemaOutput === true,
        reasoningLevels: Object.freeze([...(optionSpecs?.reasoningLevel?.values ?? [])]),
        maxOutputTokens: optionSpecs?.maxOutputTokens?.max ?? 0,
        issues: Object.freeze(toProviderDoctorIssues(modelIssuesById.get(model.modelId))),
      });
    });

    return Object.freeze({
      providerId: provider.providerId,
      ...(provider.providerName ? { providerName: provider.providerName } : {}),
      ...(provider.templateId ? { templateId: provider.templateId } : {}),
      access,
      ...(provider.config.api?.type ? { apiType: provider.config.api.type } : {}),
      ...(provider.config.api?.baseUrl ? { baseUrl: provider.config.api.baseUrl } : {}),
      models: Object.freeze(models),
      issues: Object.freeze(toProviderDoctorIssues(resolved?.providerIssues)),
      providerConfig: provider.config,
      modelConfigs: Object.freeze(modelConfigs),
      secretValues: Object.freeze(secretValues),
    });
  });

  return Object.freeze({
    revision: String(input.revision ?? 0),
    sources: Object.freeze({ ...input.sources }),
    providers: Object.freeze(providers),
    ...(input.resolutionIssues
      ? { issues: Object.freeze(toProviderDoctorIssues(input.resolutionIssues)) }
      : {}),
  });
}

/**
 * 直接把 `ProviderRegistryService` 的快照投影成诊断快照。
 *
 * 放在 adapters 而不是 CLI：投影需要 `@acode/provider` 的类型事实，而 CLI 包不依赖
 * `@acode/provider`（依赖方向：cli → adapters → provider）。CLI 只递快照与来源路径。
 */
export function projectProviderRegistryServiceSnapshot(
  snapshot: ProviderRegistryServiceSnapshot,
  sources: ProviderDoctorRegistrySnapshot["sources"],
): ProviderDoctorRegistrySnapshot {
  return toProviderDoctorRegistrySnapshot({
    providers: snapshot.registry.providers,
    resolvedProviders: snapshot.resolution.resolvedProviders,
    resolutionIssues: snapshot.resolution.issues,
    revision: snapshot.sourceRevisions.config,
    sources,
  });
}

function toProviderDoctorAccessFacts(
  provider: Provider,
  secretValues: string[],
): ProviderDoctorAccessFacts {  const access = provider.config.access;
  if (!access) {
    return Object.freeze({ type: "none", hasInlineApiKey: false, hasCredentialRef: false });
  }
  if (access.type === "zhipu-account") {
    return Object.freeze({
      type: "zhipu-account",
      accountType: access.accountType,
      accountMode: access.mode,
      entitled: access.entitled,
      hasInlineApiKey: false,
      hasCredentialRef: false,
    });
  }
  if (isApiKeyAccess(access)) {
    const apiKey = resolveProviderDoctorApiKey(provider.config);
    if (apiKey) secretValues.push(apiKey);
    const credentialRef = access.credentialRef?.trim();
    return Object.freeze({
      type: access.type as "api-key" | "zhipu-coding-plan-api-key",
      hasInlineApiKey: Boolean(apiKey),
      hasCredentialRef: Boolean(credentialRef),
      ...(credentialRef ? { credentialRef } : {}),
      ...(access.apiKeyManagementUrl
        ? { apiKeyManagementUrl: access.apiKeyManagementUrl }
        : {}),
    });
  }
  return Object.freeze({ type: "none", hasInlineApiKey: false, hasCredentialRef: false });
}

function toProviderDoctorIssues(
  issues: readonly ConfigValidationIssue[] | undefined,
): readonly ProviderDoctorConfigIssue[] {
  if (!issues || issues.length === 0) return [];
  return issues.map((issue) => ({
    code: issue.code,
    path: Object.freeze([...issue.path]),
    message: issue.message,
    ...(issue.severity ? { severity: issue.severity } : {}),
  }));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
