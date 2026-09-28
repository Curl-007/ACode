import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 安全加固 P1-5 回归修复（R1）的验收测试：协议 worker（桌面 host 拉起的
 * `acode.cjs app-server --stdio`，经 acode-protocol-entrypoint 以**无 options** 方式调用
 * startProcessProviderRegistryRuntime）也必须注入 vault。
 *
 * 回归场景：桌面 host 把 provider_config.json 迁成 credentialRef 形态、抹掉明文后，
 * worker 若无 vault，会把 ref 字符串当 apiKey 用 → 桌面 BYO provider 全线静默 401。
 *
 * 仅用 mkdtemp 临时目录（ACODE_DATA_BASE_DIR 指向临时根），绝不触碰真实 ~/.acode。
 * 覆盖规格 packages/provider-node/specs/byo-apikey-credential-ref.md 的 R1 与验收场景 10。
 */

const { startProcessProviderRegistryRuntime } = await import(
  "../packages/bootstrap/src/app/process-provider-registry-runtime.ts"
);
const { encodeACodeBuiltinRelease } = await import(
  "../../../packages/provider-node/src/acode-builtin-release.ts"
);
const { encodeProviderConfigFile } = await import(
  "../../../packages/provider-node/src/provider-config-file-codec.ts"
);
const {
  ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} = await import("../../../packages/provider-node/src/runtime-paths.ts");
const {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplateMap,
} = await import("../../../packages/provider/src/index.ts");

const PROVIDER_ID = "custom-worker-byo";
const SECRET = "sk-protocol-worker-secret";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-p1-5-worker-vault-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 与桌面 host 相同的进程环境：路径 env + 数据根 env（凭据库落在 data-root/.acode/v2）。 */
function workerEnv(dir) {
  return {
    [ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: join(dir, "builtin.json"),
    [ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(dir, "provider_config.json"),
    ACODE_DATA_BASE_DIR: join(dir, "data-root"),
  };
}

function writeBuiltinRelease(filePath) {
  writeFileSync(
    filePath,
    JSON.stringify(
      encodeACodeBuiltinRelease({
        schemaVersion: 1,
        revision: 1,
        config: {
          providers: ProviderConfigMap.empty(),
          providerTemplates: ProviderTemplateMap.empty(),
          modelConfigRules: ModelConfigRules.empty(),
        },
      }),
      null,
      2,
    ),
    "utf-8",
  );
}

/** 一份完整可准入的明文 BYO provider（api-key access + openai 兼容 endpoint + 一个 personal 模型）。 */
function plaintextPersonalUpdate() {
  // Registry 只收录「有可执行模型」的 provider；无模型的 provider 会被 resolver 跳过。
  const model = ModelConfig.fromData({
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128000,
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
  });
  return {
    providers: new ProviderConfigMap([
      [
        PROVIDER_ID,
        new ProviderConfig({
          group: "standard-personal",
          providerName: "Worker Vault Provider",
          access: new ApiKeyAccessConfig({ type: "api-key", apiKey: SECRET }),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: "https://byo.example.test/v1",
          }),
          personalModelIds: ["custom-model"],
          modelOrder: ["custom-model"],
        }),
      ],
    ]),
    models: ModelConfigRules.empty().setExact(PROVIDER_ID, "custom-model", model, true),
    providerOrder: [PROVIDER_ID],
  };
}

function registryApiKey(snapshot) {
  const provider = snapshot.registry.providers.find((p) => p.providerId === PROVIDER_ID);
  assert.ok(provider, `registry must admit the BYO provider (got issues: ${JSON.stringify(snapshot.resolution?.issues ?? [])})`);
  return provider.config.access.apiKey;
}

test("protocol worker vaults plaintext on first start and hydrates refs on later starts", async () => {
  await withTempDir(async (dir) => {
    const env = workerEnv(dir);
    writeBuiltinRelease(env[ACODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]);
    writeFileSync(
      env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV],
      JSON.stringify(encodeProviderConfigFile(plaintextPersonalUpdate()), null, 2),
      "utf-8",
    );
    const credentialFilePath = join(dir, "data-root", ".acode", "v2", "credentials.json");

    // 第一段：模拟「桌面 host/任一进程首次迁移」——无 options（协议 worker 模式）启动，
    // 写入漏斗把明文搬进凭据库、文件只剩 credentialRef。
    const first = await startProcessProviderRegistryRuntime(env);
    try {
      assert.equal(registryApiKey(first.snapshot), SECRET, "first start must resolve the plaintext key");
      const personalRaw = readFileSync(env[ACODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV], "utf-8");
      assert.ok(!personalRaw.includes(SECRET), "plaintext key must not remain on disk after migration");
      assert.ok(personalRaw.includes(`provider:apikey:${PROVIDER_ID}`), "file must hold the credentialRef");
      assert.ok(existsSync(credentialFilePath), "the shared credential store must be materialized");
    } finally {
      first.dispose();
    }

    // 第二段（回归断言）：模拟「桌面已迁移、worker 随后启动」——文件已是 ref 形态，
    // hydration 必须把 ref 还原成明文。修复前 worker 不注入 vault，
    // access.apiKey 会是 ref 字符串本身（被当 Key 用 → 静默 401）。
    const second = await startProcessProviderRegistryRuntime(env);
    try {
      assert.equal(
        registryApiKey(second.snapshot),
        SECRET,
        "protocol worker must hydrate credentialRef back to the plaintext key",
      );
      assert.notEqual(
        registryApiKey(second.snapshot),
        `provider:apikey:${PROVIDER_ID}`,
        "the credentialRef string must never leak into access.apiKey",
      );
    } finally {
      second.dispose();
    }
  });
});
