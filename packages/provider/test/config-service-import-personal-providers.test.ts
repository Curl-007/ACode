import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderTemplate,
  ProviderTemplateMap,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "../src/index.js";

/**
 * importPersonalProviders 单事务导入单测（docs/specs/provider-config-import.md R6）：
 * 整批单 revision、group 约束、名称唯一化、明文只进 access.apiKey（迁移交给写入漏斗）、
 * 按协议补默认模型、失败整批放弃、不伪造模型元数据。
 */

interface FakeLayer {
  read(): Promise<ProviderConfigLayerSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
  update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

function createLayer(
  snapshot: Omit<ProviderConfigLayerSnapshot, "revision"> & { revision?: string },
): FakeLayer & { updateCount: number } {
  let current: ProviderConfigLayerSnapshot = { revision: "", ...snapshot };
  const layer = {
    updateCount: 0,
    read: async () => current,
    onDidChange: () => () => {},
    update: async (transform: (cur: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate) => {
      layer.updateCount += 1;
      current = { ...current, ...transform(current) } as ProviderConfigLayerSnapshot;
      return current;
    },
  };
  return layer;
}

function emptyBuiltinLayer(templates: readonly ProviderTemplate[] = []) {
  return createLayer({
    providers: new ProviderConfigMap([]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
    providerTemplates: new ProviderTemplateMap(
      templates.map((template) => [template.templateId, template] as const),
    ),
  });
}

function createService(personalSnapshot?: Omit<ProviderConfigLayerSnapshot, "revision">) {
  const builtin = emptyBuiltinLayer();
  const personal = createLayer({
    providers: new ProviderConfigMap([]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
    ...personalSnapshot,
  });
  const service = new ProviderConfigService({ acodeBuiltinSource: builtin, personalRepository: personal });
  return { service, personal, builtin };
}

function anthropicInput(name: string, overrides: Record<string, unknown> = {}) {
  return {
    providerName: name,
    api: { type: "anthropic-messages" as const, baseUrl: "https://api.example.test" },
    apiKey: "sk-test-fake-anthropic-token-0001",
    modelIds: ["claude-sonnet-4-5"],
    ...overrides,
  };
}

test("单事务：两条候选一次 update，产出一条 revision 与逐条结果", async () => {
  const { service, personal } = createService();
  const outcome = await service.importPersonalProviders([
    anthropicInput("Claude A"),
    anthropicInput("Codex B", {
      api: { type: "openai-responses", baseUrl: "https://codex.example.test/v1" },
      apiKey: "sk-test-fake-openai-token-0002",
      modelIds: ["gpt-5"],
    }),
  ]);
  assert.equal(personal.updateCount, 1, "整批只应产生一次 Personal update");
  assert.equal(outcome.items.length, 2);
  const snapshot = await service.read();
  const personalProviders = snapshot.personalProviders;
  assert.equal(personalProviders.keys().length, 2);
  assert.deepEqual([...personalProviders.get(outcome.items[0]!.providerId)!.personalModelIds!], [
    "claude-sonnet-4-5",
  ]);
  // 明文只进 access.apiKey，迁移（→ credentialRef）由 provider-node 写入漏斗承担。
  assert.equal(
    (personalProviders.get(outcome.items[0]!.providerId)!.access as ApiKeyAccessConfig).apiKey,
    "sk-test-fake-anthropic-token-0001",
  );
  // 序尾追加（两条按入参顺序）。
  assert.deepEqual(snapshot.personalProviderOrder, outcome.items.map((item) => item.providerId));
});

test("group 固定 standard-personal，无 key 时仍建 ApiKeyAccessConfig 供后续补 key", async () => {
  const { service } = createService();
  const outcome = await service.importPersonalProviders([
    anthropicInput("NoKey", { apiKey: undefined }),
  ]);
  const snapshot = await service.read();
  const config = snapshot.personalProviders.get(outcome.items[0]!.providerId)!;
  assert.equal(config.group, "standard-personal");
  assert.ok(config.access instanceof ApiKeyAccessConfig);
  assert.equal((config.access as ApiKeyAccessConfig).apiKey, undefined);
});

test("同批重名自动加后缀（名称唯一化复用既有 helper）", async () => {
  const { service } = createService();
  const outcome = await service.importPersonalProviders([
    anthropicInput("Duplicated"),
    anthropicInput("Duplicated", { modelIds: ["claude-opus-4-1"] }),
  ]);
  assert.deepEqual(outcome.items.map((item) => item.providerName), ["Duplicated", "Duplicated 2"]);
});

test("空批 no-op：不写盘、不产 revision", async () => {
  const { service, personal } = createService();
  const outcome = await service.importPersonalProviders([]);
  assert.deepEqual(outcome.items, []);
  assert.equal(personal.updateCount, 0);
});

test("按协议补默认模型：候选未带模型时取同协议内置模板成员", async () => {
  const template = new ProviderTemplate({
    templateId: "anthropic-template",
    templateNameMap: { "zh-CN": "模板", "en-US": "Template" },
    config: new ProviderConfig({
      api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: "https://template.test" }),
      builtinModelIds: ["template-model-a", "template-model-b"],
    }),
  });
  const builtin = emptyBuiltinLayer([template]);
  const personal = createLayer({
    providers: new ProviderConfigMap([]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
  const service = new ProviderConfigService({ acodeBuiltinSource: builtin, personalRepository: personal });
  const outcome = await service.importPersonalProviders([
    anthropicInput("Default Models", { modelIds: [] }),
  ]);
  assert.deepEqual([...outcome.items[0]!.modelIds], ["template-model-a", "template-model-b"]);
});

test("目录外模型不伪造元数据：只落最小 enabled 档", async () => {
  const { service } = createService();
  const outcome = await service.importPersonalProviders([
    anthropicInput("Honest", { modelIds: ["claude-sonnet-4-5"] }),
  ]);
  const snapshot = await service.read();
  const json = snapshot.personalModels.getExact(outcome.items[0]!.providerId, "claude-sonnet-4-5")!.toJSON();
  assert.equal(json.enabled, true);
  assert.ok(!("contextWindow" in json), "不得伪造 contextWindow");
  assert.ok(!("maxOutputTokens" in json), "不得伪造 maxOutputTokens");
});

test("事务失败整批放弃：写失败时不留下任何 provider", async () => {
  let current: ProviderConfigLayerSnapshot = {
    revision: "",
    providers: new ProviderConfigMap([]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  };
  const failingRepository = {
    updateCount: 0,
    read: async () => current,
    onDidChange: () => () => {},
    update: async (transform: (cur: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate) => {
      failingRepository.updateCount += 1;
      const next = { ...current, ...transform(current) } as ProviderConfigLayerSnapshot;
      // 模拟 repository 写入阶段失败（EI-12：整批放弃、不留半成品）。
      throw new Error("write failed");
      return next;
    },
  };
  const service = new ProviderConfigService({
    acodeBuiltinSource: emptyBuiltinLayer(),
    personalRepository: failingRepository,
  });
  await assert.rejects(() =>
    service.importPersonalProviders([anthropicInput("A"), anthropicInput("B")]),
  );
  const after = await failingRepository.read();
  assert.equal(after.providers.keys().length, 0, "失败后不得留下半成品 provider");
});