import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
} from "../src/index.js";

/**
 * addPersonalModels 批量写入单测（packages/services/specs/provider-model-discovery.md
 * 验收场景 2）：单事务单 revision 守卫、批内去重、重复整批拒绝（不部分写入）、
 * 空批 no-op、序尾追加不重排既有顺序。
 */

function createLayer(snapshot: ProviderConfigLayerSnapshot) {
  let current = snapshot;
  return {
    read: async () => current,
    onDidChange: () => () => {},
    update: async (transform: (cur: ProviderConfigLayerSnapshot) => ProviderConfigLayerSnapshot) => {
      current = transform(current);
      return current;
    },
  };
}

function personalProviderConfig() {
  return new ProviderConfig({
    providerName: "Discovery Test",
    enabled: true,
    access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "sk-test" }),
    personalModelIds: [],
    modelOrder: [],
  });
}

function createService() {
  const builtin = createLayer({
    providers: new ProviderConfigMap([]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
  const personal = createLayer({
    providers: new ProviderConfigMap([{ providerId: "p1", config: personalProviderConfig() }]),
    models: ModelConfigRules.empty(),
    providerOrder: ["p1"],
  });
  const service = new ProviderConfigService({
    acodeBuiltinSource: builtin,
    personalRepository: personal,
  });
  return { service, personal };
}

function personalModelIdsOf(snapshot: ProviderConfigLayerSnapshot): readonly string[] {
  return snapshot.providers.get("p1")?.personalModelIds ?? [];
}

test("批量添加：单事务写入 models 与序尾顺序", async () => {
  const { service } = createService();
  const snapshot = await service.addPersonalModels("p1", ["m1", "m2"], undefined, true);
  assert.deepEqual([...personalModelIdsOf(snapshot)], ["m1", "m2"]);
  const rulesJson = JSON.stringify(snapshot.models.rules());
  assert.ok(rulesJson.includes("m1") && rulesJson.includes("m2"));
  // 序尾追加：既有顺序不被成员名单重排（再添加一个仍在尾部）。
  const second = await service.addPersonalModels("p1", ["m3"], undefined, true);
  assert.deepEqual([...personalModelIdsOf(second)], ["m1", "m2", "m3"]);
});

test("批内去重：同批重复 id 只写一次", async () => {
  const { service } = createService();
  const snapshot = await service.addPersonalModels("p1", ["m1", "m1", "m2"], undefined, true);
  assert.deepEqual([...personalModelIdsOf(snapshot)], ["m1", "m2"]);
});

test("重复整批拒绝：既有 id 在场时整批不落（无部分写入）", async () => {
  const { service } = createService();
  await service.addPersonalModels("p1", ["m1"], undefined, true);
  await assert.rejects(() => service.addPersonalModels("p1", ["m1", "m2"], undefined, true));
  const after = await service.read();
  // m2 不得因同批部分写入而存在（单事务语义）；read() 返回合并快照，个人层在 personalProviders。
  assert.deepEqual([...(after.personalProviders.get("p1")?.personalModelIds ?? [])], ["m1"]);
});

test("空批 no-op：不写不抛", async () => {
  const { service, personal } = createService();
  const before = await personal.read();
  const snapshot = await service.addPersonalModels("p1", [], undefined, true);
  assert.equal(snapshot, before);
});
