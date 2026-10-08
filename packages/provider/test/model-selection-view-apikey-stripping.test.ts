import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
} from "../src/config/provider-config.js";
import { ModelConfig, ModelConfigRules } from "../src/config/model-config.js";
import {
  ProviderConfigResolver,
  serializeRegistryProviderConfig,
  type ProviderConfigResolverInput,
  type RegistryProviderConfig,
} from "../src/resolver.js";
import {
  ModelSelectionFacade,
  projectModelSelectionProviderView,
  type ProviderRegistryFacadeSource,
} from "../src/facades.js";
import type { ProviderRegistryView } from "../src/registry.js";

/**
 * spec: packages/provider/specs/model-selection-view-apikey-stripping.md 的验收测试（审计 M3）。
 *
 * 守护的核心性质：ModelSelectionView 是发给所有 RPC 客户端（renderer/web/手机远控）的视图，
 * 其 provider.config.access 永不含明文 apiKey、也不含 credentialRef——即使内存对象已被
 * registry 的 vault hydration 填上真值。执行链读的是 Registry 类实例，不经序列化点，不受影响。
 */

const PROVIDER_ID = "byo-m3";
const MODEL_ID = "test-model";
const HYDRATED_PLAINTEXT = "sk-vault-hydrated-plaintext-value";
const LEGACY_PLAINTEXT = "sk-legacy-inline-plaintext-value";
const MANAGEMENT_URL = "https://keys.example.com/manage";

/** 完整可执行的模型数据：形状与内置 config 的模型一致，缺一项 registry 模型校验就不通过。 */
const completeModelData = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 200000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
    maxOutputTokens: { max: 32000, map: "{}" },
  },
};

function resolverInput(access: ProviderConfig["access"]): ProviderConfigResolverInput {
  return {
    acodeBuiltinProviders: new ProviderConfigMap(),
    personalProviders: new ProviderConfigMap([
      {
        providerId: PROVIDER_ID,
        providerName: "BYO M3 Test",
        enabled: true,
        config: new ProviderConfig({
          group: "standard-personal",
          access,
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1",
          }),
          personalModelIds: [MODEL_ID],
          modelOrder: [MODEL_ID],
        }),
      },
    ]),
    acodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        config: ModelConfig.fromData(completeModelData),
      },
    ]),
    accountProviders: new ProviderConfigMap(),
  };
}

/** 走真实 resolver 链路拿到 RegistryProviderConfig（与 registry 发布给投影的形态一致）。 */
function resolveRegistryProvider(access: ProviderConfig["access"]): RegistryProviderConfig {
  const resolution = new ProviderConfigResolver().resolve(resolverInput(access));
  const provider = resolution.registryProviders.find((item) => item.providerId === PROVIDER_ID);
  assert.ok(provider, "测试 provider 必须进入 registry（否则用例失去意义）");
  return provider.config;
}

test("hydrate 后的 BYO provider：selection 投影不含明文 apiKey，也不含 credentialRef", () => {
  // vault hydration 后的内存形态：apiKey 真值与 credentialRef 同时存在（registry-service.ts）。
  const registryConfig = resolveRegistryProvider(
    new ApiKeyAccessConfig({
      type: "api-key",
      apiKey: HYDRATED_PLAINTEXT,
      credentialRef: `provider:apikey:${PROVIDER_ID}`,
      apiKeyManagementUrl: MANAGEMENT_URL,
    }),
  );
  // 前提自检：内存类实例确实持有明文（否则「剥离」断言是空转）。
  assert.equal((registryConfig.access as ApiKeyAccessConfig).apiKey, HYDRATED_PLAINTEXT);

  const serialized = serializeRegistryProviderConfig(registryConfig);
  assert.deepEqual(serialized.access, {
    type: "api-key",
    apiKeyManagementUrl: MANAGEMENT_URL,
  });
  assert.ok(!JSON.stringify(serialized).includes(HYDRATED_PLAINTEXT), "序列化结果不得含明文");

  const view = projectModelSelectionProviderView({
    providerId: PROVIDER_ID,
    providerName: "BYO M3 Test",
    config: registryConfig,
    models: [],
  });
  const wire = JSON.stringify(view);
  assert.ok(!wire.includes(HYDRATED_PLAINTEXT), "selection 视图不得含明文 apiKey");
  assert.ok(!wire.includes("credentialRef"), "selection 视图也不发布 credentialRef");
  assert.deepEqual(view.config.access, { type: "api-key", apiKeyManagementUrl: MANAGEMENT_URL });
});

test("未迁移的明文回退态（无 ref）：selection 投影同样剥离明文", () => {
  const registryConfig = resolveRegistryProvider(
    new ApiKeyAccessConfig({ type: "api-key", apiKey: LEGACY_PLAINTEXT }),
  );
  const view = projectModelSelectionProviderView({
    providerId: PROVIDER_ID,
    providerName: "BYO M3 Test",
    config: registryConfig,
    models: [],
  });
  const wire = JSON.stringify(view);
  assert.ok(!wire.includes(LEGACY_PLAINTEXT), "任何形态的明文都不进 selection 视图");
  assert.deepEqual(view.config.access, { type: "api-key" });
});

test("zhipu-account 分支不受剥离影响：accountType/mode/entitled 原样保留", () => {
  const registryConfig = resolveRegistryProvider(
    new ZhipuAccountAccessConfig({
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    }),
  );
  const serialized = serializeRegistryProviderConfig(registryConfig);
  assert.deepEqual(serialized.access, {
    type: "zhipu-account",
    accountType: "zai",
    mode: "individual-coding-plan",
    entitled: true,
  });
});

test("ModelSelectionFacade.getView() 的完整 RPC 载荷面不含明文 Key", () => {
  const registryConfig = resolveRegistryProvider(
    new ApiKeyAccessConfig({
      type: "api-key",
      apiKey: HYDRATED_PLAINTEXT,
      credentialRef: `provider:apikey:${PROVIDER_ID}`,
    }),
  );
  const registryView: ProviderRegistryView = Object.freeze({
    revision: 7,
    providers: Object.freeze([
      Object.freeze({
        providerId: PROVIDER_ID,
        providerName: "BYO M3 Test",
        config: registryConfig,
        models: Object.freeze([]),
      }),
    ]),
  });
  const source: ProviderRegistryFacadeSource = {
    getSnapshot: () => null,
    getView: () => registryView,
    refresh: async () => {
      throw new Error("测试不触发 refresh");
    },
    onDidChange: () => () => {},
  };
  const view = new ModelSelectionFacade(source).getView();
  assert.equal(view.revision, 7);
  const wire = JSON.stringify(view);
  assert.ok(!wire.includes(HYDRATED_PLAINTEXT), "getView() 载荷不得含明文 apiKey");
  assert.equal(view.providers.length, 1);
  assert.deepEqual(view.providers[0]!.config.access, { type: "api-key" });
});
