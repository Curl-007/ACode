import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * ACode builtin 远程同步 + BYO apikey vault 持久化守护（review 测试专项 P2：provider-node
 * 「远程同步 / apikey vault 持久化」几乎裸奔）。
 *
 * 沿用仓内范式（byo-apikey-credential-ref.test.mjs）：真临时文件 + 内存 vault + 小时间参数，
 * t.after 清理。覆盖：
 * - ACodeBuiltinRemoteSynchronizer：首次刷新 fetch+apply、成功后 nextEligibleAt 前跳过（not-due）、
 *   force 绕过节流、控制文件落盘、dispose 后 refresh 短路。
 * - personal-provider-apikey-vaulting：明文检测、先入库后落 ref（顺序即安全）、无 vault 安全空操作、
 *   孤儿凭据清理只删消失的 ref。
 * - acode-builtin-download：审计版（isOfficialServiceEnabled=false）在网络前短路，绝不发请求。
 */
const { ACodeBuiltinRemoteSynchronizer } = await import("../src/acode-builtin-remote-synchronizer.ts");
const vaulting = await import("../src/personal-provider-apikey-vaulting.ts");
const { downloadACodeBuiltinRelease } = await import("../src/acode-builtin-download.ts");
const {
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ModelConfigRules,
} = await import("../../provider/src/index.ts");

/** 内存 vault（可注入失败），与 byo 测试同形。 */
function createMemoryVault({ failOnDelete = false } = {}) {
  const store = new Map();
  const deletedRefs = [];
  return {
    store,
    deletedRefs,
    async load(ref) {
      return store.get(ref) ?? null;
    },
    async save(providerId, apiKey) {
      const ref = `provider:apikey:${providerId}`;
      store.set(ref, apiKey);
      return ref;
    },
    async delete(ref) {
      if (failOnDelete) throw new Error("vault delete failed");
      deletedRefs.push(ref);
      store.delete(ref);
    },
  };
}

function updateWith(entries) {
  return {
    providers: new ProviderConfigMap(
      entries.map(
        ([providerId, apiKey]) => [
          providerId,
          new ProviderConfig({
            providerName: `P ${providerId}`,
            enabled: true,
            access: new ApiKeyAccessConfig({ type: "api-key", apiKey }),
            personalModelIds: [],
            modelOrder: [],
          }),
        ],
      ),
    ),
    models: ModelConfigRules.empty(),
    providerOrder: entries.map(([providerId]) => providerId),
  };
}

// ── 远程同步 ──────────────────────────────────────────────────────

test("首次 refresh 触发 fetch+apply；成功后未到期跳过；force 绕过节流", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlFilePath = join(root, "refresh.json");
  let now = 1_000;
  const calls = [];
  const sync = new ACodeBuiltinRemoteSynchronizer({
    source: {
      applyRemoteRelease: async (release) => {
        calls.push(`apply:${release.revision}`);
        return "updated";
      },
    },
    controlFilePath,
    resolveEndpointKey: async () => "endpoint-abc",
    fetchRelease: async (key) => {
      calls.push(`fetch:${key}`);
      return { revision: 7 };
    },
    now: () => now,
    successIntervalMs: 60_000,
    leaseDurationMs: 5_000,
  });
  t.after(() => sync.dispose());

  assert.equal(await sync.refresh(), "updated");
  assert.deepEqual(calls, ["fetch:endpoint-abc", "apply:7"], "首次必须 fetch 再 apply");

  // 控制文件已落盘，且记录了成功后的 nextEligibleAt。
  const control = JSON.parse(await readFile(controlFilePath, "utf8"));
  assert.equal(control.endpointKey, "endpoint-abc");
  assert.equal(control.failureCount, 0);
  assert.equal(control.leaseUntil, 0, "成功后租约必须释放");

  // 立即再刷新 → not-due（未到 nextEligibleAt），不发 fetch。
  calls.length = 0;
  assert.equal(await sync.refresh(), "skipped");
  assert.deepEqual(calls, [], "节流窗口内不得发起网络");

  // force → 绕过节流重新拉取。
  calls.length = 0;
  assert.equal(await sync.refresh({ force: true }), "updated");
  assert.deepEqual(calls, ["fetch:endpoint-abc", "apply:7"], "force 必须绕过节流");

  // dispose 后 refresh 短路，不再触网。
  sync.dispose();
  calls.length = 0;
  assert.equal(await sync.refresh({ force: true }), "disposed");
  assert.deepEqual(calls, [], "dispose 后不得再刷新");
});

test("fetch 失败 → 递增 failureCount 并向上抛错（不静默吞）", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acode-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlFilePath = join(root, "refresh.json");
  const sync = new ACodeBuiltinRemoteSynchronizer({
    source: { applyRemoteRelease: async () => "updated" },
    controlFilePath,
    resolveEndpointKey: async () => "endpoint-abc",
    fetchRelease: async () => {
      throw new Error("network down");
    },
    now: () => 1_000,
    failureBaseDelayMs: 1_000,
    failureMaxDelayMs: 10_000,
  });
  t.after(() => sync.dispose());

  await assert.rejects(() => sync.refresh({ force: true }), /network down/);
  const control = JSON.parse(await readFile(controlFilePath, "utf8"));
  assert.equal(control.failureCount, 1, "失败必须记录到控制文件");
  assert.ok(control.nextEligibleAt > 1_000, "失败必须安排退避重试窗口");
});

// ── BYO apikey vault 持久化 ───────────────────────────────────────

test("vaultPersonalProviderApiKeys：明文进库，update 只留 ref（顺序即安全）", async () => {
  const vault = createMemoryVault();
  const { update, vaulted } = await vaulting.vaultPersonalProviderApiKeys(
    updateWith([
      ["p1", "sk-secret"],
      ["p2", "sk-two"],
    ]),
    vault,
  );
  assert.equal(vaulted, 2);
  assert.equal(vault.store.get("provider:apikey:p1"), "sk-secret");
  assert.equal(vault.store.get("provider:apikey:p2"), "sk-two");
  const access = update.providers.get("p1").access;
  assert.equal(access.apiKey, undefined, "落盘的 access 不得含明文");
  assert.equal(access.credentialRef, "provider:apikey:p1");
  // 迁移后不再有明文（快通道判定依据）。
  assert.equal(vaulting.hasPlaintextApiKeys(update), false);
});

test("vaultPersonalProviderApiKeys：无 vault 注入是安全空操作（不迁移、不抛）", async () => {
  const original = updateWith([["p1", "sk-legacy"]]);
  const { update, vaulted } = await vaulting.vaultPersonalProviderApiKeys(original, undefined);
  assert.equal(vaulted, 0);
  assert.equal(update, original, "无 vault 时必须原样返回（同一引用）");
  assert.equal(vaulting.hasPlaintextApiKeys(update), true, "明文保留");
});

test("deleteOrphanedProviderApiKeys：只删消失的 ref，保留仍被引用的", async () => {
  const vault = createMemoryVault();
  const before = (await vaulting.vaultPersonalProviderApiKeys(updateWith([["p1", "a"], ["p2", "b"]]), vault)).update;
  const after = (await vaulting.vaultPersonalProviderApiKeys(updateWith([["p1", "a2"]]), vault)).update;
  const deleted = await vaulting.deleteOrphanedProviderApiKeys(before, after, vault);
  assert.equal(deleted, 1, "只有 p2 的 ref 变孤儿");
  assert.deepEqual(vault.deletedRefs, ["provider:apikey:p2"]);
  assert.equal(vault.store.has("provider:apikey:p1"), true, "仍被引用的条目不得删");
  assert.equal(vault.store.has("provider:apikey:p2"), false, "孤儿条目必须删");
});

test("deleteOrphanedProviderApiKeys：before 无 ref / 无 vault 时安全空操作", async () => {
  const vault = createMemoryVault();
  // before 全是明文（无 ref）→ 没有可清理的孤儿。
  const plainBefore = updateWith([["p1", "sk"]]);
  const after = (await vaulting.vaultPersonalProviderApiKeys(updateWith([["p2", "x"]]), vault)).update;
  assert.equal(await vaulting.deleteOrphanedProviderApiKeys(plainBefore, after, vault), 0);
  // 无 vault → 0，且不抛。
  assert.equal(await vaulting.deleteOrphanedProviderApiKeys(plainBefore, after, undefined), 0);
});

// ── 下载短路 ──────────────────────────────────────────────────────

test("审计版 downloadACodeBuiltinRelease 在触网前短路，绝不发请求", async () => {
  // isOfficialServiceEnabled("clientConfig") 在本构建恒为 false（官方服务断开）。
  let requested = false;
  const result = await downloadACodeBuiltinRelease({
    endpointOrigin: "https://api.example.com",
    appVersion: "1.0.3",
    platform: "windows-x86_64",
    request: async () => {
      requested = true;
      throw new Error("request must not be reached");
    },
  });
  assert.equal(result, null, "官方服务关闭时必须返回 null");
  assert.equal(requested, false, "短路必须发生在网络请求之前（含凭证读取）");
});
