import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isProviderProvisioningProviderApiKeyCredentialKey,
  providerProvisioningEnvelopeSchema,
  type ProviderProvisioningEnvelope,
} from "@acode/shared";
import { NodePersonalProviderConfigRepository } from "@acode/provider-node";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
} from "../src/model-provider/providerProvisioningSource.js";
import { validateCredentialEntries } from "../src/model-provider/providerProvisioningTarget.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import type { ISettingService } from "../src/setting/setting.js";

/**
 * 安全加固 P1-5 回归修复（R2）的验收测试：BYO Provider API Key（`provider:apikey:<id>`）
 * 必须随 provisioning envelope 同步，否则目标端拿到 ref 形态配置却没有真值，
 * hydrate 得 null → 远程/SSH/迁移环境的 BYO provider 静默失效。
 *
 * 覆盖规格 packages/provider-node/specs/byo-apikey-credential-ref.md 的 R2 与验收场景 11。
 * 仅用 mkdtemp 临时目录 + 独立密钥文件，绝不触碰真实 ~/.acode。
 */

const BYO_REF_KEY = "provider:apikey:custom-byo";

const emptySettingService = {
  get: async () => ({ providerFamilyDomain: null, providerFamilyConnectionSelections: {} }),
} as unknown as ISettingService;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acode-p1-5-provisioning-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("isProviderProvisioningProviderApiKeyCredentialKey matches only the vault namespace", () => {
  assert.ok(isProviderProvisioningProviderApiKeyCredentialKey(BYO_REF_KEY));
  assert.ok(isProviderProvisioningProviderApiKeyCredentialKey("provider:apikey:builtin:zhipu"));
  // 前后空白：与 account-provider 谓词同样拒绝（normalized !== key）。
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey(` ${BYO_REF_KEY}`));
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey("provider:apikey:"));
  // 其它凭据命名空间不得被误吞。
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey("account-provider:zai:api-key"));
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey("oauth:zai:access_token"));
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey("acodejwttoken"));
  assert.ok(!isProviderProvisioningProviderApiKeyCredentialKey("provider:apikey"));
});

test("source exports provider:apikey:* entries with scope provider-apikey", async () => {
  await withTempDir(async (dir) => {
    const cipher = createCredentialCipherProvider({
      keyFilePath: join(dir, "credential-key.json"),
    });
    const credentialFilePath = join(dir, "credentials.json");
    await writeFile(
      credentialFilePath,
      JSON.stringify(
        {
          [BYO_REF_KEY]: cipher.encrypt("sk-provision-byo"),
          "unrelated:secret": cipher.encrypt("must-not-sync"),
        },
        null,
        2,
      ),
      "utf-8",
    );
    // 真实 repository + 不存在的 personal 文件：走 readProvisionablePersonalConfig 的
    // ENOENT 早返回分支（首次空配置是合法的导出事实）。
    const personalRepository = new NodePersonalProviderConfigRepository({
      filePath: join(dir, "provider_config.json"),
      pollingIntervalMs: false,
    });

    try {
      const source = createProviderProvisioningSource({
        personalRepository,
        settingService: emptySettingService,
        credentialFilePath,
        personalConfigFilePath: join(dir, "provider_config.json"),
        cipherProvider: cipher,
      });

      // source.read 内部经 providerProvisioningEnvelopeSchema.parse —— 成功返回即证明
      // 新 scope 能通过信封 schema（版本契约）。
      const envelope = await source.read("sync-test-1");
      const byoEntry = envelope.credentials.find((entry) => entry.key === BYO_REF_KEY);
      assert.ok(byoEntry, "provider:apikey:* entry must be exported");
      assert.equal(byoEntry.scope, "provider-apikey");
      assert.equal(byoEntry.value, "sk-provision-byo");
      assert.equal(
        envelope.credentials.find((entry) => entry.key === "unrelated:secret"),
        undefined,
        "keys outside the allowlist must not be exported",
      );
    } finally {
      personalRepository.dispose();
    }

    // 目标端 replace-allowlist 删除语义依赖的物理键枚举必须包含同一 scope。
    const listed = await listProviderProvisioningCredentialKeys(credentialFilePath);
    assert.ok(listed.includes(BYO_REF_KEY), "listed keys must include provider:apikey:*");
    assert.ok(!listed.includes("unrelated:secret"), "listed keys must exclude other namespaces");
  });
});

function envelopeWithCredentials(
  credentials: ProviderProvisioningEnvelope["credentials"],
): ProviderProvisioningEnvelope {
  return providerProvisioningEnvelopeSchema.parse({
    schemaVersion: 1,
    syncId: "validate-test",
    personalConfig: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
    accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
    credentials,
  });
}

test("target validation accepts provider-apikey scope only with matching keys", () => {
  // 合法组合：scope 与键命名空间一致。
  validateCredentialEntries(
    envelopeWithCredentials([{ scope: "provider-apikey", key: BYO_REF_KEY, value: "sk-x" }]),
  );

  // scope 冒用其它命名空间的键 → 拒绝。
  assert.throws(
    () =>
      validateCredentialEntries(
        envelopeWithCredentials([
          { scope: "provider-apikey", key: "oauth:zai:access_token", value: "v" },
        ]),
      ),
    /不允许同步的 Credential key/,
  );
  // provider:apikey 键冒用其它 scope → 拒绝。
  assert.throws(
    () =>
      validateCredentialEntries(
        envelopeWithCredentials([{ scope: "account-provider", key: BYO_REF_KEY, value: "v" }]),
      ),
    /不允许同步的 Credential key/,
  );
});
