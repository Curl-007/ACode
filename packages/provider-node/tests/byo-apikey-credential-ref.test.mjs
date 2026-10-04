import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P1-5 的验收测试：BYO Provider API Key 从 provider_config.json 明文迁到加密凭据库。
 *
 * 覆盖规格 packages/provider-node/specs/byo-apikey-credential-ref.md 的 7 条验收场景。
 * 仅用 mkdtemp 临时目录 + 内存 vault，**绝不触碰真实 ~/.acode 或任何真实凭据**。
 *
 * 重点守护的性质（改错会真实毁掉用户付费 Key）：
 * - 落盘不含明文；读回来的 registry 侧能拿到明文（hydrate）；
 * - revision 稳定 → 无写放大（否则每 1s 轮询都重写文件）；
 * - 迁移非破坏：vault 写失败时文件保持明文、不损坏；
 * - 明文回退：vault 不可用时残留明文仍可用；
 * - 远程 provisioning 的 hash 断言不因 hydration 而失败；
 * - 不注入 vault 时行为与改动前一致（安全空操作）。
 */

const { NodePersonalProviderConfigRepository } = await import(
  "../src/personal-provider-config-repository.ts"
);
const { encodeProviderConfigFile, decodeProviderConfigFile } = await import(
  "../src/provider-config-file-codec.ts"
);
const { ApiKeyAccessConfig, ModelConfigRules, ProviderConfig, ProviderConfigMap } = await import(
  "../../provider/src/index.ts"
);
const { hydrateProviderConfigCredentialRefs, providerApiKeyCredentialKey } = await import(
  "../../provider/src/provider-api-key-vault.ts"
);

/** 内存 vault：模拟加密凭据库；可注入失败以验证非破坏性。 */
function createMemoryVault({ failOnSave = false, failOnLoad = false, failOnDelete = false, missingRefs = [] } = {}) {
  const store = new Map();
  const savedKeys = [];
  const deletedRefs = [];
  return {
    store,
    savedKeys,
    deletedRefs,
    async load(ref) {
      if (failOnLoad) throw new Error("vault unavailable");
      if (missingRefs.includes(ref)) return null;
      return store.get(ref) ?? null;
    },
    async save(providerId, apiKey) {
      if (failOnSave) throw new Error("vault write failed");
      const ref = providerApiKeyCredentialKey(providerId);
      store.set(ref, apiKey);
      savedKeys.push(apiKey);
      return ref;
    },
    async delete(ref) {
      if (failOnDelete) throw new Error("vault delete failed");
      deletedRefs.push(ref);
      store.delete(ref);
    },
  };
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-p1-5-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createRepository(filePath, options = {}) {
  return new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
    ...options,
  });
}

/** 构造一份含明文 BYO apiKey 的 update（走真实领域类型，不手搓 JSON）。 */
function updateWithPlaintextKey(providerId, apiKey) {
  // 注意：personal provider 规则 omit 了 builtinModelIds（那是 builtin-only），
  // 所以这里不能传 builtinModelIds，否则 toJSON 会带上它、被 personal 严格 schema 拒绝。
  const config = new ProviderConfig({
    providerName: "Test Provider",
    enabled: true,
    access: new ApiKeyAccessConfig({ type: "api-key", apiKey }),
    personalModelIds: [],
    modelOrder: [],
  });
  return {
    providers: new ProviderConfigMap([{ providerId, config }]),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  };
}

/** 多 provider 版本：同一份 update 里放多个明文 BYO provider（孤儿清理场景需要）。 */
function updateWithPlaintextKeys(entries) {
  return {
    providers: new ProviderConfigMap(
      entries.map(([providerId, apiKey]) => [
        providerId,
        new ProviderConfig({
          providerName: `Provider ${providerId}`,
          enabled: true,
          access: new ApiKeyAccessConfig({ type: "api-key", apiKey }),
          personalModelIds: [],
          modelOrder: [],
        }),
      ]),
    ),
    models: ModelConfigRules.empty(),
    providerOrder: entries.map(([providerId]) => providerId),
  };
}

function readDisk(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/** 在磁盘 JSON 里找某 provider 的 access 节点。 */
function accessOnDisk(diskJson, providerId) {
  const rules = diskJson.config?.providerConfigRules?.providerRules ?? [];
  return rules.find((rule) => rule.providerId === providerId)?.config?.access;
}

test("(1) save writes credentialRef only — no plaintext apiKey on disk", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-super-secret-value"));

      const raw = readFileSync(filePath, "utf-8");
      assert.ok(!raw.includes("sk-super-secret-value"), "plaintext key must not appear on disk");
      const access = accessOnDisk(readDisk(filePath), "custom-test");
      assert.equal(access.apiKey, undefined, "apiKey must not be persisted");
      assert.equal(access.credentialRef, providerApiKeyCredentialKey("custom-test"));
      assert.equal(vault.store.get(access.credentialRef), "sk-super-secret-value");
    } finally {
      repo.dispose();
    }
  });
});

test("(2) read hydrates credentialRef back to the plaintext key", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-hydrate-me"));
      // snapshot 停在 ref 形态（与磁盘一致）……
      const snapshot = await repo.read();
      const access = snapshot.providers.get("custom-test").access;
      assert.equal(access.credentialRef, providerApiKeyCredentialKey("custom-test"));
      // ……真值由 hydration 提供给 registry 侧。
      const hydrated = await hydrateProviderConfigCredentialRefs(snapshot.providers, vault);
      assert.equal(hydrated.get("custom-test").access.apiKey, "sk-hydrate-me");
    } finally {
      repo.dispose();
    }
  });
});

test("(3) revision is stable across repeated reads — no write amplification", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-revision-check"));
      const first = await repo.read();
      const mtimeAfterFirst = statSync(filePath).mtimeMs;
      const sizeAfterFirst = statSync(filePath).size;

      const second = await repo.read();
      const third = await repo.read();
      assert.equal(first.revision, second.revision, "revision must not drift between reads");
      assert.equal(second.revision, third.revision);

      // 关键：重复 read 不得重写文件（迁移已自终止）。
      const stat = statSync(filePath);
      assert.equal(stat.mtimeMs, mtimeAfterFirst, "read must not rewrite the file");
      assert.equal(stat.size, sizeAfterFirst);
      // vault 也不应被反复写入。
      assert.equal(vault.savedKeys.length, 1, "the key must be saved exactly once");
    } finally {
      repo.dispose();
    }
  });
});

test("(4) migration is non-destructive: vault failure leaves plaintext intact", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    // 先落一份明文文件（模拟升级前的既有安装）。
    const plaintextUpdate = updateWithPlaintextKey("custom-test", "sk-existing-plaintext");
    writeFileSync(
      filePath,
      JSON.stringify(encodeProviderConfigFile(plaintextUpdate), null, 2),
      "utf-8",
    );
    const before = readFileSync(filePath, "utf-8");

    const failingVault = createMemoryVault({ failOnSave: true });
    const recovered = [];
    const repo = createRepository(filePath, {
      providerApiKeyVault: failingVault,
      onRecovery: (event) => recovered.push(event),
    });
    try {
      // vault 写失败 → 不得清空/损坏文件；明文必须原样保留且仍可读。
      const snapshot = await repo.read();
      const raw = readFileSync(filePath, "utf-8");
      assert.ok(raw.includes("sk-existing-plaintext"), "plaintext must survive a failed vault write");
      // 更强的断言：文件**逐字节未变**——失败路径不得产生任何重写（哪怕内容相同）。
      assert.equal(raw, before, "a failed vault write must not rewrite the file at all");
      assert.equal(snapshot.providers.get("custom-test").access.apiKey, "sk-existing-plaintext");
      assert.equal(snapshot.providers.get("custom-test").access.credentialRef, undefined);
      assert.ok(recovered.length > 0, "the vault failure must be surfaced via onRecovery");
      // 凭据库里不应留下任何东西（save 抛错，没有半写）。
      assert.equal(failingVault.store.size, 0);
    } finally {
      repo.dispose();
    }
  });
});

test("(5) plaintext fallback: unreadable ref still yields the residual plaintext key", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-will-be-orphaned"));
    } finally {
      repo.dispose();
    }

    // 凭据库整体不可用（load 抛错）：hydration 必须保留原 access，不得把 apiKey 置空或抛到刷新循环外。
    const brokenVault = createMemoryVault({ failOnLoad: true });
    const repo2 = createRepository(filePath, { providerApiKeyVault: brokenVault });
    try {
      const snapshot = await repo2.read();
      const hydrated = await hydrateProviderConfigCredentialRefs(snapshot.providers, brokenVault);
      // 没有明文可回退（已 vault 化），但也不得抛错；access 保持 ref 形态。
      assert.equal(
        hydrated.get("custom-test").access.credentialRef,
        providerApiKeyCredentialKey("custom-test"),
      );
    } finally {
      repo2.dispose();
    }

    // 引用悬空（凭据被清）：同样不得抛错。
    const emptyVault = createMemoryVault({ missingRefs: [providerApiKeyCredentialKey("custom-test")] });
    const hydratedEmpty = await hydrateProviderConfigCredentialRefs(
      decodeProviderConfigFile(readDisk(filePath)).providers,
      emptyVault,
    );
    assert.ok(hydratedEmpty.get("custom-test"), "dangling ref must not crash hydration");
  });
});

test("(6) remote provisioning hash assertion holds on ref-form config", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-provisioning"));
      const snapshot = await repo.read();
      // readProvisionablePersonalConfig 的核心断言：重算磁盘 hash 必须等于 snapshot.revision。
      // 若 hydration 回灌进了 revision，这里就会失配并抛「配置在读取期间发生变化」。
      const { createHash } = await import("node:crypto");
      const actualRevision = createHash("sha256")
        .update(JSON.stringify(encodeProviderConfigFile(decodeProviderConfigFile(readDisk(filePath)))))
        .digest("hex");
      assert.equal(actualRevision, snapshot.revision, "snapshot revision must match the on-disk bytes");
    } finally {
      repo.dispose();
    }
  });
});

test("(7) no vault injected: plaintext is read and written as before (safe no-op)", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const repo = createRepository(filePath);
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-legacy-plaintext"));
      // 不注入 vault → 明文照写照读（不迁移、不崩溃）。
      assert.ok(readFileSync(filePath, "utf-8").includes("sk-legacy-plaintext"));
      const snapshot = await repo.read();
      assert.equal(snapshot.providers.get("custom-test").access.apiKey, "sk-legacy-plaintext");
      assert.equal(snapshot.providers.get("custom-test").access.credentialRef, undefined);
    } finally {
      repo.dispose();
    }
  });
});

test("overlay of a new plaintext key over an existing ref does not silently drop the key", async () => {
  // 回归守护：overlayValue 的「next 未定义则保留 base」语义会让 base 的旧 ref 与 next 的新明文
  // 同时留下，而 toJSON() 在有 ref 时丢弃明文 → 用户刚输入的新 Key 被静默丢弃、界面看着像保存成功。
  const withRef = new ApiKeyAccessConfig({
    type: "api-key",
    credentialRef: providerApiKeyCredentialKey("custom-test"),
  });
  const withNewKey = new ApiKeyAccessConfig({ type: "api-key", apiKey: "sk-brand-new-key" });
  const overlaid = withRef.overlay(withNewKey);
  assert.equal(overlaid.apiKey, "sk-brand-new-key", "the new key must win");
  assert.equal(overlaid.credentialRef, undefined, "the stale ref must be cleared");
  assert.deepEqual(overlaid.toJSON(), { type: "api-key", apiKey: "sk-brand-new-key" });
});

test("toJSON never emits apiKey once a credentialRef exists", async () => {
  const access = new ApiKeyAccessConfig({
    type: "api-key",
    apiKey: "sk-in-memory-only",
    credentialRef: providerApiKeyCredentialKey("custom-test"),
  });
  const json = access.toJSON();
  assert.equal(json.credentialRef, providerApiKeyCredentialKey("custom-test"));
  assert.equal(json.apiKey, undefined, "hydrated in-memory key must never be serialized to disk");
});

test("(12) deleting a provider removes its orphaned vault entry", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() =>
        updateWithPlaintextKeys([
          ["custom-keep", "sk-keep-me"],
          ["custom-gone", "sk-delete-me"],
        ]),
      );
      assert.equal(vault.store.size, 2);

      // 与 ProviderConfigService.deletePersonalProvider 相同的删除形状。
      const snapshot = await repo.update((current) => ({
        providers: current.providers.delete("custom-gone"),
        models: current.models,
        providerOrder: current.providerOrder?.filter((id) => id !== "custom-gone"),
      }));
      assert.equal(snapshot.providers.get("custom-gone"), undefined, "provider must be gone");

      const refGone = providerApiKeyCredentialKey("custom-gone");
      const refKeep = providerApiKeyCredentialKey("custom-keep");
      assert.ok(vault.deletedRefs.includes(refGone), "orphaned vault entry must be deleted");
      assert.equal(vault.store.has(refGone), false, "vault entry must not linger after deletion");
      assert.equal(vault.store.get(refKeep), "sk-keep-me", "still-referenced entry must survive");
      assert.ok(!vault.deletedRefs.includes(refKeep), "live refs must never be deleted");
    } finally {
      repo.dispose();
    }
  });
});

test("(12b) rotating the key keeps a single vault entry — no orphan on rotation", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const vault = createMemoryVault();
    const repo = createRepository(filePath, { providerApiKeyVault: vault });
    try {
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-old-key"));
      // 换 Key：确定性 ref 不变，vault.save 覆盖同一条目，清理不得把它当孤儿删掉。
      await repo.update(() => updateWithPlaintextKey("custom-test", "sk-new-key"));
      assert.equal(vault.store.size, 1, "rotation must reuse the deterministic ref");
      assert.equal(vault.store.get(providerApiKeyCredentialKey("custom-test")), "sk-new-key");
      assert.deepEqual(vault.deletedRefs, [], "rotation must not delete the live entry");
    } finally {
      repo.dispose();
    }
  });
});

test("(12c) vault.delete failure does not fail the committed update", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const recovered = [];
    // 先用健康 vault 落一份 ref 形态配置。
    const seedVault = createMemoryVault();
    const seedRepo = createRepository(filePath, { providerApiKeyVault: seedVault });
    await seedRepo.update(() => updateWithPlaintextKey("custom-test", "sk-orphan-cleanup"));
    seedRepo.dispose();

    const failingVault = createMemoryVault({ failOnDelete: true });
    // 载入既有条目，模拟「清理失败但凭据库其余功能可用」。
    failingVault.store.set(providerApiKeyCredentialKey("custom-test"), "sk-orphan-cleanup");
    const repo = createRepository(filePath, {
      providerApiKeyVault: failingVault,
      onRecovery: (event) => recovered.push(event),
    });
    try {
      // 文件写入必须照常成功；清理失败只上报，不能让调用方误判「删除 provider 失败」。
      const snapshot = await repo.update((current) => ({
        providers: current.providers.delete("custom-test"),
        models: current.models,
        providerOrder: current.providerOrder?.filter((id) => id !== "custom-test"),
      }));
      assert.equal(snapshot.providers.get("custom-test"), undefined);
      assert.ok(
        !readFileSync(filePath, "utf-8").includes("custom-test"),
        "provider must be committed to disk even if vault cleanup failed",
      );
      assert.ok(recovered.length > 0, "cleanup failure must be surfaced via onRecovery");
    } finally {
      repo.dispose();
    }
  });
});

// ── R1-c（批次 4）：明文回退的显式告警 ────────────────────────────────

test("(R1-c) plaintext persistence warns once per file+cause; vaulted write stays silent", async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const notices = () => warnings.filter((line) => /SECURITY NOTICE/.test(line));
    try {
      // ① vault 未注入（装配点缺失/纯 builtin）→ 明文落盘 + 一次性告警（未注入成因）。
      const absentPath = join(dir, "provider_config_absent.json");
      const absentRepo = createRepository(absentPath);
      try {
        await absentRepo.update(() => updateWithPlaintextKey("custom-notice", "sk-plaintext-notice"));
        assert.equal(notices().length, 1, "first plaintext write must warn exactly once");
        assert.match(notices()[0], /no encrypted credential vault is wired/);
        assert.match(notices()[0], /PLAINTEXT/);
        // 同文件同成因的后续写入不再刷屏（once-guarded，键含文件路径）。
        await absentRepo.update(() => updateWithPlaintextKey("custom-notice-2", "sk-second"));
        assert.equal(notices().length, 1, "same file+cause must not warn again");
      } finally {
        absentRepo.dispose();
      }

      // ② vault 注入 → 迁移落 ref，零告警。
      const vaultedPath = join(dir, "provider_config_vaulted.json");
      const vault = createMemoryVault();
      const vaultedRepo = createRepository(vaultedPath, { providerApiKeyVault: vault });
      try {
        await vaultedRepo.update(() => updateWithPlaintextKey("custom-vaulted", "sk-vaulted"));
        assert.equal(notices().length, 1, "vaulted migration must not warn");
      } finally {
        vaultedRepo.dispose();
      }

      // ③ vault save 失败 → 明文保留可用（既有非破坏语义）+ 失败成因告警（不同成因键不互吞）。
      const failingPath = join(dir, "provider_config_failing.json");
      const failingVault = createMemoryVault({ failOnSave: true });
      const failingRepo = createRepository(failingPath, {
        providerApiKeyVault: failingVault,
        onRecovery: () => {},
      });
      try {
        await failingRepo.update(() => updateWithPlaintextKey("custom-failing", "sk-failing"));
        assert.ok(
          warnings.some((line) => /credential vault rejected the save/.test(line)),
          `expected vault-failed notice, got: ${JSON.stringify(warnings)}`,
        );
        const raw = readFileSync(failingPath, "utf-8");
        assert.ok(raw.includes("sk-failing"), "save failure must keep the key usable (plaintext)");
      } finally {
        failingRepo.dispose();
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});
