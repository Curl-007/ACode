import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelConfigRules } from "../src/config/model-config.js";
import { ProviderConfig, ProviderConfigMap } from "../src/config/provider-config.js";
import type { ProviderConfigLayerSnapshot } from "../src/config-service.js";
import {
  appendCurrentProviderOrder,
  assertMembershipCurrent,
  assertNonEmptyId,
  assertProviderLabelMutationIsUnique,
  isStructurallyEmpty,
  nextPersonalProviderId,
  nextPersonalProviderLabel,
  normalizeId,
  normalizeModelOrder,
  normalizePersonalProviderMembership,
  normalizeProviderIdSeed,
  normalizeProviderOrder,
  uniqueInOrder,
  writableProviderOverlay,
} from "../src/config-service-helpers.js";

/**
 * 2026-12-31 例外债务偿还的拆分验收：config-service.ts 纯函数 helper 叶子的行为钉板。
 * 守护的核心性质：迁移后每个 helper 的判定/规范化语义与原文件逐字一致——
 * 成员守卫的 revision 与归属检查、Overlay 复活禁令、ID/顺序/标签规范化边界。
 */

function layerSnapshot(providers: ProviderConfigMap): ProviderConfigLayerSnapshot {
  return { revision: "r1", providers, models: ModelConfigRules.empty() };
}

test("assertMembershipCurrent: 无 membership 直接放行", () => {
  assertMembershipCurrent(undefined, "p1", layerSnapshot(ProviderConfigMap.empty()));
});

test("assertMembershipCurrent: 归属与 revision 匹配时调用 assertCurrent 后放行", () => {
  let calls = 0;
  assertMembershipCurrent(
    {
      providerId: "p1",
      inheritedModelIds: [],
      personalRevision: "r1",
      assertCurrent: () => {
        calls += 1;
      },
    },
    "p1",
    layerSnapshot(ProviderConfigMap.empty()),
  );
  assert.equal(calls, 1);
});

test("assertMembershipCurrent: providerId 或 revision 漂移即拒绝", () => {
  const base = {
    providerId: "p1",
    inheritedModelIds: [] as readonly string[],
    personalRevision: "r1",
    assertCurrent: () => {},
  };
  assert.throws(
    () =>
      assertMembershipCurrent(
        { ...base, providerId: "p2" },
        "p1",
        layerSnapshot(ProviderConfigMap.empty()),
      ),
    /Provider Settings membership revision conflict/,
  );
  assert.throws(
    () =>
      assertMembershipCurrent(
        { ...base, personalRevision: "r0" },
        "p1",
        layerSnapshot(ProviderConfigMap.empty()),
      ),
    /Provider Settings membership revision conflict/,
  );
  assert.throws(
    () =>
      assertMembershipCurrent(
        {
          ...base,
          assertCurrent: () => {
            throw new Error("stale!");
          },
        },
        "p1",
        layerSnapshot(ProviderConfigMap.empty()),
      ),
    /stale!/,
  );
});

test("writableProviderOverlay: 现有 Personal Overlay 原样返回", () => {
  const personal = new ProviderConfig({ group: "standard-personal" });
  const current = layerSnapshot(
    new ProviderConfigMap([{ providerId: "p1", config: personal }]),
  );
  const builtin = layerSnapshot(ProviderConfigMap.empty());
  assert.equal(writableProviderOverlay(builtin, current, "p1"), personal);
});

test("writableProviderOverlay: 仅 Built-in 存在时返回空 Overlay，不复活已删除 Provider", () => {
  const builtin = layerSnapshot(
    new ProviderConfigMap([{ providerId: "bp", config: new ProviderConfig({}) }]),
  );
  const current = layerSnapshot(ProviderConfigMap.empty());
  const overlay = writableProviderOverlay(builtin, current, "bp");
  assert.ok(overlay instanceof ProviderConfig);
  assert.equal(overlay.group, undefined);
  assert.throws(
    () => writableProviderOverlay(builtin, current, "ghost"),
    /Provider 不存在: ghost/,
  );
});

test("normalizePersonalProviderMembership: 过滤与 Built-in 重叠的成员并保持去重顺序", () => {
  const personal = new ProviderConfig({
    personalModelIds: ["m1", "b1", "m1", "m2"],
  });
  const normalized = normalizePersonalProviderMembership(personal, undefined, ["b1"]);
  assert.deepEqual(normalized?.personalModelIds, ["m1", "m2"]);
  assert.equal(normalizePersonalProviderMembership(undefined, undefined), undefined);
});

test("normalizePersonalProviderMembership: 存在 modelOrder 时按成员名单归一化", () => {
  const personal = new ProviderConfig({
    personalModelIds: ["m1"],
    modelOrder: ["m1", "b1", "m1"],
  });
  const normalized = normalizePersonalProviderMembership(personal, undefined, ["b1", "b2"]);
  // resolveOwnedOrder 语义：未排序 Built-in（b2）在前，随后是有效请求顺序（m1, b1）。
  assert.deepEqual(normalized?.modelOrder, ["b2", "m1", "b1"]);
});

test("isStructurallyEmpty: undefined/空对象/空数组为真，其余为假", () => {
  assert.equal(isStructurallyEmpty(undefined), true);
  assert.equal(isStructurallyEmpty({}), true);
  assert.equal(isStructurallyEmpty({ a: undefined, b: {} }), true);
  assert.equal(isStructurallyEmpty([]), true);
  assert.equal(isStructurallyEmpty(null), false);
  assert.equal(isStructurallyEmpty({ enabled: false }), false);
  assert.equal(isStructurallyEmpty({ nested: { x: 1 } }), false);
});

test("assertProviderLabelMutationIsUnique: 仅本次改名引入重名才拒绝", () => {
  const current = new ProviderConfigMap([
    { providerId: "p1", providerName: "Alpha", config: new ProviderConfig({}) },
    { providerId: "p2", providerName: "Beta", config: new ProviderConfig({}) },
  ]);
  const renamedUnique = new ProviderConfigMap([
    { providerId: "p1", providerName: "Gamma", config: new ProviderConfig({}) },
    { providerId: "p2", providerName: "Beta", config: new ProviderConfig({}) },
  ]);
  assertProviderLabelMutationIsUnique("p1", current, renamedUnique);
  // 大小写与首尾空白不敏感的冲突仍被拦下。
  const renamedConflict = new ProviderConfigMap([
    { providerId: "p1", providerName: " beta ", config: new ProviderConfig({}) },
    { providerId: "p2", providerName: "Beta", config: new ProviderConfig({}) },
  ]);
  assert.throws(
    () => assertProviderLabelMutationIsUnique("p1", current, renamedConflict),
    /Provider 名称已存在: beta/,
  );
  // 名称未变化时，背景里既有重名不阻断无关保存。
  assertProviderLabelMutationIsUnique("p1", current, current);
});

test("normalizeId/assertNonEmptyId: 去空白，空值抛错", () => {
  assert.equal(normalizeId("modelId", "  m1 "), "m1");
  assert.throws(() => normalizeId("modelId", "   "), /modelId 不能为空/);
  assertNonEmptyId("providerId", " p1");
  assert.throws(() => assertNonEmptyId("providerId", ""), /providerId 不能为空/);
});

test("uniqueInOrder/normalizeProviderIdSeed/nextPersonalProviderId", () => {
  assert.deepEqual(uniqueInOrder(["a", "b", "a"]), ["a", "b"]);
  assert.equal(normalizeProviderIdSeed("OpenAI Team!"), "openai-team");
  assert.equal(normalizeProviderIdSeed("!!!"), "new-provider");
  const occupied = new Set(["openai", "openai-2"]);
  assert.equal(nextPersonalProviderId(occupied, "OpenAI"), "openai-3");
  assert.equal(nextPersonalProviderId(occupied), "new-provider");
});

test("normalizeProviderOrder/appendCurrentProviderOrder: 仅纳入 standard-personal，未知项丢弃", () => {
  const personal = new ProviderConfigMap([
    { providerId: "a", config: new ProviderConfig({ group: "standard-personal" }) },
    { providerId: "b", config: new ProviderConfig({ group: "standard-personal" }) },
    { providerId: "c", config: new ProviderConfig({ group: "acode-builtin" }) },
  ]);
  const builtin = ProviderConfigMap.empty();
  assert.deepEqual(normalizeProviderOrder(builtin, personal, ["b", "ghost"]), ["b", "a"]);
  // 新增项落到归一化顺序末尾，重复声明被去重。
  assert.deepEqual(appendCurrentProviderOrder(builtin, personal, ["b"], "a"), ["b", "a"]);
  assert.deepEqual(appendCurrentProviderOrder(builtin, personal, ["b", "a"], "b"), ["a", "b"]);
});

test("normalizeModelOrder: 未排序 Built-in 在前，请求顺序居中，Personal 余项殿后", () => {
  assert.deepEqual(normalizeModelOrder(["b1", "b2"], ["m1"], ["m1", "b2"]), ["b1", "m1", "b2"]);
});

test("nextPersonalProviderLabel: 大小写不敏感避让，依次追加序号", () => {
  const providers = new ProviderConfigMap([
    { providerId: "p1", providerName: "Alpha", config: new ProviderConfig({}) },
    { providerId: "p2", providerName: "Alpha 2", config: new ProviderConfig({}) },
  ]);
  // 候选由输入 seed 拼接序号（沿用 seed 的大小写），仅冲突判定大小写不敏感。
  assert.equal(nextPersonalProviderLabel("alpha", providers), "alpha 3");
  assert.equal(nextPersonalProviderLabel("Fresh", providers), "Fresh");
  assert.equal(nextPersonalProviderLabel("   ", providers), "new-provider");
});
