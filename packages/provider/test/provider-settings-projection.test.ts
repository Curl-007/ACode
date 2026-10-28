import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelConfigRules } from "../src/config/model-config.js";
import {
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplateMap,
} from "../src/config/provider-config.js";
import type { ProviderRegistryFacadeSource } from "../src/facades.js";
import {
  createProviderSettingsView,
  requireEffectiveProvider,
  requireSnapshot,
} from "../src/provider-settings-projection.js";
import type { ProviderRegistryServiceSnapshot } from "../src/registry-service.js";
import type { ProviderConfigResolution } from "../src/resolver.js";

/**
 * 2026-12-31 例外债务偿还的拆分验收：facades.ts 快照投影叶子的行为钉板。
 * 守护的核心性质：未 start 与未知 Provider 的守卫报错逐字保持；空输入投影出
 * 合法的 Settings 视图骨架（revision/providerTemplates/providerOrder/providers）。
 */

function sourceReturning(snapshot: ProviderRegistryServiceSnapshot | null): ProviderRegistryFacadeSource {
  return {
    getSnapshot: () => snapshot,
    getView: () => {
      throw new Error("unreachable");
    },
    refresh: async () => {
      throw new Error("unreachable");
    },
    onDidChange: () => () => {},
  };
}

test("requireSnapshot: 未 start 抛固定文案，已 start 原样返回", () => {
  assert.throws(() => requireSnapshot(sourceReturning(null)), /ProviderRegistryService 尚未 start()/);
  const snapshot = { marker: "snapshot" } as unknown as ProviderRegistryServiceSnapshot;
  assert.equal(requireSnapshot(sourceReturning(snapshot)), snapshot);
});

test("requireEffectiveProvider: 命中返回规则，未命中抛固定文案", () => {
  const snapshot = {
    resolution: {
      effectiveProviders: new ProviderConfigMap([
        { providerId: "p1", providerName: "Alpha", config: new ProviderConfig({}) },
      ]),
    },
  } as unknown as ProviderRegistryServiceSnapshot;
  const rule = requireEffectiveProvider(snapshot, "p1");
  assert.equal(rule.providerId, "p1");
  assert.equal(rule.providerName, "Alpha");
  assert.throws(() => requireEffectiveProvider(snapshot, "ghost"), /Provider 不存在: ghost/);
});

test("createProviderSettingsView: 空输入投影出合法空视图骨架", () => {
  const view = createProviderSettingsView({
    revision: 7,
    acodeBuiltinProviders: ProviderConfigMap.empty(),
    acodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    personalModels: ModelConfigRules.empty(),
    resolution: {
      resolvedProviders: [],
      registryProviders: [],
    } as unknown as ProviderConfigResolution,
  });
  assert.deepEqual(view, {
    revision: 7,
    providerTemplates: [],
    providerOrder: [],
    providers: [],
  });
});
