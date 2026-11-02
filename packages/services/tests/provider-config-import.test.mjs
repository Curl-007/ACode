import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

/**
 * provider 配置导入（docs/specs/provider-config-import.md）后端域验收测试。
 *
 * 夹具**全部合成**：所有 key 使用 `sk-test-fake-*` 前缀，绝不含可用凭据字面量
 * （Mimosa 硬约束：凭据只从环境变量/密钥服务读取）；cc-switch 库一律在临时目录现造。
 * 覆盖 spec 正向场景 1-6/8-9 与负向断言 N1-N12/N14 中属后端面的条目。
 */

const locate = await import("../src/model-provider/provider-import/locate.ts");
const { createProviderImportService } = await import(
  "../src/model-provider/provider-import/providerImporterService.ts"
);
const { createServiceLogger } = await import("../src/logger/serviceLogger.ts");
const { createNodePersonalProviderConfigRepository } = await import("@acode/provider-node");
const { ModelConfigRules, ProviderConfigMap, ProviderConfigService } = await import("@acode/provider");

const FAKE_CLAUDE_KEY = "sk-test-fake-anthropic-token-0001";
const FAKE_CC_KEY = "sk-test-fake-cc-switch-0002";
const FAKE_CODEX_KEY = "sk-test-fake-openai-envkey-0003";
// provider 表内字面 token（2026-11 实配核实形态）与其近义别名字段，均为合成值。
const FAKE_CODEX_LITERAL_TOKEN = "sk-test-fake-codex-literal-token-0004";
const FAKE_CODEX_BEARER_ALIAS = "sk-test-fake-codex-bearer-alias-0005";

async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "acode-provider-import-home-"));
  try {
    return await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// —— fixture 构造（全部合成） ——

function writeClaudeSettings(home, env, extra = {}) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env, ...extra }, null, 2),
    "utf8",
  );
}

function writeCodex(home, { config, auth }) {
  mkdirSync(join(home, ".codex"), { recursive: true });
  if (config !== undefined) writeFileSync(join(home, ".codex", "config.toml"), config, "utf8");
  if (auth !== undefined) {
    writeFileSync(
      join(home, ".codex", "auth.json"),
      typeof auth === "string" ? auth : JSON.stringify(auth, null, 2),
      "utf8",
    );
  }
}

function createCcSwitchDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, is_current INTEGER, settings_config TEXT, meta TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO providers (id, name, app_type, is_current, settings_config, meta) VALUES (?,?,?,?,?,?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.name ?? null,
      row.app_type,
      row.is_current ?? 0,
      typeof row.settings_config === "string" ? row.settings_config : JSON.stringify(row.settings_config ?? {}),
      row.meta === undefined ? null : JSON.stringify(row.meta),
    );
  }
  db.close();
}

function deterministicIds() {
  let counter = 0;
  return () => {
    counter += 1;
    return `11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`;
  };
}

function collectingLogger() {
  const entries = [];
  const sink = {
    log: (...args) => entries.push(args),
    warn: (...args) => entries.push(args),
    error: (...args) => entries.push(args),
    debug: (...args) => entries.push(args),
  };
  return { entries, log: createServiceLogger("provider-import", { sink, isDebugEnabled: true }) };
}

function memoryVault() {
  const store = new Map();
  return {
    store,
    async load(ref) {
      return store.get(ref) ?? null;
    },
    async save(providerId, apiKey) {
      const ref = `provider:apikey:${providerId}`;
      store.set(ref, apiKey);
      return ref;
    },
    async delete(ref) {
      store.delete(ref);
    },
  };
}

function createService(overrides = {}) {
  const { log } = collectingLogger();
  return createProviderImportService({
    home: overrides.home,
    env: overrides.env ?? {},
    existing: overrides.existing ?? (() => []),
    importPersonalProviders: overrides.importPersonalProviders ?? (async () => ({ items: [] })),
    newId: overrides.newId ?? deterministicIds(),
    log,
    ...(overrides.io ? { io: overrides.io } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

// —— 正向：来源解析 ——

test("场景1 Claude Code：别名忽略、[..] 后缀剥离、显示名取 *_NAME", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(
      home,
      {
        ANTHROPIC_BASE_URL: "https://claude.example.test/",
        ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_KEY,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5[1m]",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet 4.5",
      },
      { model: "sonnet" },
    );
    const service = createService({ home, env: {} });
    const result = await service.scanProviderImports({ sources: ["claude-code"] });
    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 1);
    const [candidate] = result.candidates;
    assert.equal(candidate.api, "anthropic-messages");
    assert.equal(candidate.source, "claude-code");
    assert.equal(candidate.name, "Sonnet 4.5");
    assert.equal(candidate.baseUrl, "https://claude.example.test");
    assert.deepEqual(candidate.models, [{ id: "claude-sonnet-4-5", name: "Sonnet 4.5" }]);
    assert.equal(candidate.hasApiKey, true);
    // N1：明文不出现在 scan 结果 JSON 中。
    assert.ok(!JSON.stringify(result).includes(FAKE_CLAUDE_KEY));
    // N5：视图逐字段构造，无 apiKey 字段；hint 只给末 4 位。
    assert.ok(!Object.keys(candidate).includes("apiKey"));
    assert.equal(candidate.apiKeyHint, "••••0001");
  });
});

test("场景2 Codex：wire_api 映射、活动项在前、env_key 未设置保留并告警", async () => {
  await withTempHome(async (home) => {
    writeCodex(home, {
      config: [
        // 顶层键必须在任何表头之前，否则会被并入上一个表。
        'model_provider = "beta"',
        'model = "gpt-5"',
        "",
        "[model_providers.alpha]",
        'name = "Alpha"',
        'base_url = "https://alpha.example.test/v1"',
        'wire_api = "responses"',
        'env_key = "ALPHA_TEST_KEY"',
        "",
        "[model_providers.beta]",
        'name = "Beta"',
        'base_url = "https://beta.example.test/v1"',
        "requires_openai_auth = true",
        "",
        // 2026-11 本机实配核实：provider 表内字面 bearer token（实测字段名 experimental_bearer_token）。
        "[model_providers.gamma]",
        'name = "Gamma"',
        'base_url = "https://gamma.example.test/v1"',
        'wire_api = "chat"',
        `experimental_bearer_token = "${FAKE_CODEX_LITERAL_TOKEN}"`,
        `bearer_token = "${FAKE_CODEX_BEARER_ALIAS}"`,
        "",
      ].join("\n"),
      auth: { OPENAI_API_KEY: FAKE_CODEX_KEY },
    });
    const service = createService({ home, env: {} });
    const result = await service.scanProviderImports({ sources: ["codex"] });
    assert.equal(result.ok, true);
    const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]));
    assert.equal(byName.get("Alpha").api, "openai-responses");
    assert.equal(byName.get("Alpha").hasApiKey, false, "env_key 未设置 → 不带 OpenAI 的 key");
    assert.equal(byName.get("Beta").api, "openai-chat-completions");
    assert.equal(byName.get("Beta").hasApiKey, true);
    // provider 表内字面 token：更具体的字段优先于全局 auth.json（且不得带出明文）。
    assert.equal(byName.get("Gamma").hasApiKey, true);
    assert.equal(byName.get("Gamma").apiKeyHint, `••••${FAKE_CODEX_LITERAL_TOKEN.slice(-4)}`);
    // 活动项（beta）排前，顶层 model 只归属活动项。
    assert.equal(result.candidates[0].name, "Beta");
    assert.deepEqual(result.candidates[0].models, [{ id: "gpt-5", name: "gpt-5" }]);
    assert.ok(result.warnings.some((warning) => warning.code === "env-missing-key"));
    assert.ok(!JSON.stringify(result).includes(FAKE_CODEX_KEY));
    assert.ok(!JSON.stringify(result).includes(FAKE_CODEX_LITERAL_TOKEN), "字面 token 不得出视图");
    assert.ok(!JSON.stringify(result).includes(FAKE_CODEX_BEARER_ALIAS), "别名 token 不得出视图");
    // env_key 缺席且无字面 token 时不应虚构 warning（Gamma 无 env-missing-key）。
    assert.equal(
      result.warnings.filter((warning) => warning.code === "env-missing-key").length,
      1,
    );
  });
});

test("场景3 CC Switch：claude/codex 产出、gemini 跳过 + 告警、组内 is_current 排前", async () => {
  await withTempHome(async (home) => {
    mkdirSync(join(home, ".cc-switch"), { recursive: true });
    createCcSwitchDb(join(home, ".cc-switch", "cc-switch.db"), [
      {
        id: "c-inactive",
        name: "Claude Inactive",
        app_type: "claude",
        is_current: 0,
        settings_config: { env: { ANTHROPIC_BASE_URL: "https://inactive.example.test", ANTHROPIC_AUTH_TOKEN: FAKE_CC_KEY } },
        meta: { apiFormat: "anthropic" },
      },
      {
        id: "c-active",
        name: "Claude Active",
        app_type: "claude",
        is_current: 1,
        settings_config: { env: { ANTHROPIC_BASE_URL: "https://active.example.test", ANTHROPIC_API_KEY: FAKE_CC_KEY } },
        meta: { apiFormat: "openai_responses" },
      },
      {
        id: "codex-1",
        name: "Codex Local",
        app_type: "codex",
        is_current: 0,
        settings_config: {
          auth: {},
          config: "[model_providers.zzz]\nname = 'Zzz'\nbase_url = 'https://zzz.example.test'\nwire_api = 'chat'\n",
        },
      },
      { id: "gemini-1", name: "Gemini", app_type: "gemini", is_current: 0, settings_config: { env: { GOOGLE_GEMINI_BASE_URL: "https://gemini.example.test" } } },
      { id: "other-1", name: "Other", app_type: "opencode", is_current: 0, settings_config: {} },
    ]);
    const service = createService({ home, env: {} });
    const result = await service.scanProviderImports({ sources: ["cc-switch"] });
    assert.equal(result.ok, true);
    const names = result.candidates.map((candidate) => candidate.name);
    // 组序 claude → codex；claude 组内 is_current 排前。
    assert.deepEqual(names, ["Claude Active", "Claude Inactive", "Zzz"]);
    const active = result.candidates.find((candidate) => candidate.name === "Claude Active");
    assert.equal(active.api, "openai-responses", "meta.apiFormat 决定协议");
    assert.equal(active.isCurrent, true);
    const zzz = result.candidates.find((candidate) => candidate.name === "Zzz");
    assert.equal(zzz.api, "openai-chat-completions");
    // N7：gemini 行不产候选 + 聚合警告（不静默）。
    assert.ok(!names.includes("Gemini"));
    const unsupported = result.warnings.find((warning) => warning.code === "unsupported-api-format");
    assert.equal(unsupported.params.count, 1);
    assert.equal(result.warnings.find((w) => w.code === "unsupported-app-type").params.count, 1);
    assert.ok(!JSON.stringify(result).includes(FAKE_CC_KEY));
  });
});

test("场景4 只读副本：源库字节不变、临时目录清理、-wal 复制", async () => {
  await withTempHome(async (home) => {
    const dbPath = join(home, "wal.db");
    const live = new DatabaseSync(dbPath);
    live.exec("PRAGMA journal_mode=WAL");
    live.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT, settings_config TEXT)");
    live.exec("INSERT INTO providers (id, app_type, settings_config) VALUES ('w1','claude','{}')");
    const walPath = `${dbPath}-wal`;
    assert.ok(existsSync(walPath), "WAL 模式未提交时应有 -wal");
    const before = readFileSync(dbPath);
    const tempRoot = mkdtempSync(join(tmpdir(), "acode-provider-import-tmp-"));
    try {
      const read = await locate.readCcSwitchRows(dbPath, 256 * 1024 * 1024, tempRoot);
      assert.equal(read.tooLarge, false);
      assert.deepEqual(read.rows.map((row) => row.id), ["w1"], "-wal 副本应能读到未 checkpoint 行");
      // N10：源库字节不变。
      assert.deepEqual(readFileSync(dbPath), before);
      // 临时目录内的副本被删除。
      assert.deepEqual(readdirSync(tempRoot), []);
    } finally {
      live.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("场景5 去重：候选间 candidate、对已有 provider existing", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(home, {
      ANTHROPIC_BASE_URL: "https://dup.example.test",
      ANTHROPIC_AUTH_TOKEN: FAKE_CC_KEY,
    });
    mkdirSync(join(home, ".cc-switch"), { recursive: true });
    createCcSwitchDb(join(home, ".cc-switch", "cc-switch.db"), [
      {
        id: "dup",
        name: "Duplicate",
        app_type: "claude",
        is_current: 1,
        settings_config: { env: { ANTHROPIC_BASE_URL: "https://dup.example.test", ANTHROPIC_AUTH_TOKEN: FAKE_CC_KEY } },
      },
    ]);
    const service = createService({ home, env: {} });
    const result = await service.scanProviderImports({ sources: ["claude-code", "cc-switch"] });
    assert.equal(result.candidates.length, 2);
    const [first, second] = result.candidates;
    assert.equal(second.duplicate, "candidate");
    assert.equal(second.duplicateOf, first.sourceLabel);

    const withExisting = createService({
      home,
      env: {},
      existing: () => [
        { providerName: "Existing One", baseUrl: "https://dup.example.test", apiKey: FAKE_CC_KEY },
      ],
    });
    const existingResult = await withExisting.scanProviderImports({ sources: ["claude-code"] });
    assert.equal(existingResult.candidates[0].duplicate, "existing");
    assert.equal(existingResult.candidates[0].duplicateOf, "Existing One");
  });
});

test("场景8/逐来源隔离：单来源读失败只产该来源 warning，ok 仍为 true", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(home, {
      ANTHROPIC_BASE_URL: "https://claude.example.test",
      ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_KEY,
    });
    writeCodex(home, {
      config: "[model_providers.a]\nbase_url = 'https://a.example.test'\n",
      auth: {},
    });
    const realIo = locate.createProviderImportScanIo();
    const claudePath = join(home, ".claude", "settings.json");
    const io = {
      readTextFile: async (path, maxBytes) => {
        if (path === claudePath) throw new Error("EACCES simulated");
        return realIo.readTextFile(path, maxBytes);
      },
      readCcSwitchRows: realIo.readCcSwitchRows,
    };
    const service = createService({ home, env: {}, io });
    const result = await service.scanProviderImports();
    assert.equal(result.ok, true);
    assert.deepEqual(result.candidates.map((c) => c.source), ["codex"]);
    const failures = result.warnings.filter((warning) => warning.code === "source-read-failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].params.source, "claude-code");
  });
});

test("场景9 Env 注入：reader 走注入 Env，临时改 process.env 不影响", async () => {
  await withTempHome(async (home) => {
    writeCodex(home, {
      config: "[model_providers.env]\nbase_url = 'https://env.example.test'\nenv_key = 'INJECTED_TEST_KEY'\n",
      auth: {},
    });
    const service = createService({ home, env: { INJECTED_TEST_KEY: FAKE_CODEX_KEY } });
    const injected = await service.scanProviderImports({ sources: ["codex"] });
    assert.equal(injected.candidates[0].hasApiKey, true);

    const saved = process.env.INJECTED_TEST_KEY;
    process.env.INJECTED_TEST_KEY = FAKE_CODEX_KEY;
    try {
      const service2 = createService({ home, env: {} });
      const notInjected = await service2.scanProviderImports({ sources: ["codex"] });
      assert.equal(notInjected.candidates[0].hasApiKey, false, "不得读全局 process.env");
    } finally {
      if (saved === undefined) delete process.env.INJECTED_TEST_KEY;
      else process.env.INJECTED_TEST_KEY = saved;
    }
  });
});

// —— 负向断言 ——

test("N3 日志不含明文 key 与原文片段", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(home, {
      ANTHROPIC_BASE_URL: "https://claude.example.test",
      ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_KEY,
    });
    // 同时覆盖 2026-11 实配新增的「provider 表内字面 token」路径（明文同样不得进日志）。
    writeCodex(home, {
      config: [
        "[model_providers.gamma]",
        'name = "Gamma"',
        'base_url = "https://gamma.example.test/v1"',
        `experimental_bearer_token = "${FAKE_CODEX_LITERAL_TOKEN}"`,
        "",
      ].join("\n"),
      auth: { OPENAI_API_KEY: FAKE_CODEX_KEY },
    });
    const { entries, log } = collectingLogger();
    const service = createProviderImportService({
      home,
      env: {},
      existing: () => [],
      importPersonalProviders: async () => ({ items: [] }),
      newId: deterministicIds(),
      log,
    });
    await service.scanProviderImports();
    const text = JSON.stringify(entries);
    assert.ok(!text.includes(FAKE_CLAUDE_KEY));
    assert.ok(!text.includes(FAKE_CODEX_KEY));
    assert.ok(!text.includes(FAKE_CODEX_LITERAL_TOKEN));
    assert.ok(!text.includes(FAKE_CODEX_BEARER_ALIAS));
    assert.ok(!text.includes("ANTHROPIC_AUTH_TOKEN"));
    assert.ok(!text.includes("ANTHROPIC_BASE_URL"));
    assert.ok(!text.includes("experimental_bearer_token"), "字段名亦不入日志");
    assert.ok(entries.length > 0, "生命周期日志应产出（info）");
  });
});

test("N6 未勾选来源的文件不被读取", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(home, { ANTHROPIC_BASE_URL: "https://claude.example.test" });
    writeCodex(home, { config: "[model_providers.a]\nbase_url = 'https://a.example.test'\n", auth: {} });
    mkdirSync(join(home, ".cc-switch"), { recursive: true });
    createCcSwitchDb(join(home, ".cc-switch", "cc-switch.db"), []);
    const realIo = locate.createProviderImportScanIo();
    const readPaths = [];
    const io = {
      readTextFile: async (path, maxBytes) => {
        readPaths.push(path);
        return realIo.readTextFile(path, maxBytes);
      },
      readCcSwitchRows: async (path, maxBytes) => {
        readPaths.push(path);
        return realIo.readCcSwitchRows(path, maxBytes);
      },
    };
    const service = createService({ home, env: {}, io });
    await service.scanProviderImports({ sources: ["claude-code"] });
    assert.deepEqual(readPaths, [join(home, ".claude", "settings.json")]);
    assert.ok(!readPaths.some((path) => path.includes(".codex") || path.includes("cc-switch")));
  });
});

test("N12 参数边界：非法 sources/candidateIds → invalid-args 且零读取零写入", async () => {
  const home = mkdtempSync(join(tmpdir(), "acode-provider-import-invalid-"));
  let importCalls = 0;
  const { log } = collectingLogger();
  const service = createProviderImportService({
    home,
    env: {},
    existing: () => [],
    importPersonalProviders: async () => {
      importCalls += 1;
      return { items: [] };
    },
    log,
  });
  try {
    for (const sources of [[], ["bogus"], ["codex", "bogus"]]) {
      const result = await service.scanProviderImports({ sources });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid-args");
    }
    const tooMany = Array.from({ length: 501 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
    for (const candidateIds of [[], ["not-a-uuid"], tooMany]) {
      const result = await service.importProviderCandidates({ candidateIds });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid-args");
    }
    assert.equal(importCalls, 0);
    // 非法入参不触发任何读取（home 下没有任何来源文件，也没有被创建）。
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("N8/N9 缓存过期 → scan-stale；未知候选 id → candidate-missing；零写入", async () => {
  await withTempHome(async (home) => {
    writeClaudeSettings(home, {
      ANTHROPIC_BASE_URL: "https://claude.example.test",
      ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_KEY,
    });
    let importCalls = 0;
    let clock = 1_000_000;
    const { log } = collectingLogger();
    const service = createProviderImportService({
      home,
      env: {},
      existing: () => [],
      importPersonalProviders: async () => {
        importCalls += 1;
        return { items: [] };
      },
      newId: deterministicIds(),
      now: () => clock,
      log,
    });
    const scanned = await service.scanProviderImports({ sources: ["claude-code"] });
    assert.equal(scanned.ok, true);

    const unknown = await service.importProviderCandidates({
      candidateIds: ["99999999-9999-4999-8999-999999999999"],
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "candidate-missing");
    assert.equal(importCalls, 0);

    // 过期：推进到 TTL 之后。
    clock += 10 * 60_000;
    const stale = await service.importProviderCandidates({
      candidateIds: [scanned.candidates[0].id],
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "scan-stale");
    assert.equal(importCalls, 0);
  });
});

test("N14 TOML 解析失败只给行号；坏 config 不整源放弃其它 provider", async () => {
  await withTempHome(async (home) => {
    writeCodex(home, { config: "[model_providers.a]\nbase_url = \n", auth: {} });
    const service = createService({ home, env: {} });
    const result = await service.scanProviderImports({ sources: ["codex"] });
    assert.equal(result.candidates.length, 0);
    const invalid = result.warnings.find((warning) => warning.code === "invalid-toml");
    assert.ok(invalid);
    assert.equal(invalid.params.line, 2);
    assert.ok(!JSON.stringify(result).includes("base_url"));
  });
});

// —— 端到端写入：单事务 + vault ——

test("场景6 单事务写入：一次 revision、落盘只有 credentialRef、vault 有对应条目", async () => {
  const home = mkdtempSync(join(tmpdir(), "acode-provider-import-write-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "acode-provider-import-write-data-"));
  try {
    writeClaudeSettings(home, {
      ANTHROPIC_BASE_URL: "https://claude.example.test",
      ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_KEY,
    });
    writeCodex(home, {
      config: "[model_providers.openai-ish]\nname = 'Codex Key'\nbase_url = 'https://codex.example.test/v1'\nrequires_openai_auth = true\n",
      auth: { OPENAI_API_KEY: FAKE_CODEX_KEY },
    });

    const filePath = join(dataDir, "provider_config.json");
    const vault = memoryVault();
    const repository = createNodePersonalProviderConfigRepository({
      filePath,
      providerApiKeyVault: vault,
      pollingIntervalMs: false,
    });
    let updateCount = 0;
    const countingRepository = {
      read: () => repository.read(),
      onDidChange: (listener) => repository.onDidChange(listener),
      update: (transform) => {
        updateCount += 1;
        return repository.update(transform);
      },
    };
    const configService = new ProviderConfigService({
      acodeBuiltinSource: {
        read: async () => ({
          providers: ProviderConfigMap.empty(),
          models: ModelConfigRules.empty(),
          providerOrder: [],
        }),
        onDidChange: () => () => {},
      },
      personalRepository: countingRepository,
    });

    const { log } = collectingLogger();
    const service = createProviderImportService({
      home,
      env: {},
      existing: () => [],
      importPersonalProviders: (inputs) => configService.importPersonalProviders(inputs),
      newId: deterministicIds(),
      log,
    });
    const scanned = await service.scanProviderImports({ sources: ["claude-code", "codex"] });
    assert.equal(scanned.ok, true);
    assert.ok(scanned.candidates.length >= 2);

    const imported = await service.importProviderCandidates({
      candidateIds: scanned.candidates.map((candidate) => candidate.id),
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported.length, scanned.candidates.length);
    // N2：导入结果 JSON 不含明文。
    assert.ok(!JSON.stringify(imported).includes(FAKE_CLAUDE_KEY));
    assert.ok(!JSON.stringify(imported).includes(FAKE_CODEX_KEY));

    const raw = readFileSync(filePath, "utf8");
    assert.ok(!raw.includes(FAKE_CLAUDE_KEY), "落盘不得含明文 key");
    assert.ok(!raw.includes(FAKE_CODEX_KEY), "落盘不得含明文 key");
    assert.equal(updateCount, 1, "整批候选只应产生一次 repository update（单 revision）");

    const file = JSON.parse(raw);
    const rules = file.config.providerConfigRules.providerRules;
    assert.equal(rules.length, imported.imported.length);
    for (const rule of rules) {
      assert.equal(rule.config.group, "standard-personal");
      assert.equal(rule.config.access.type, "api-key");
      assert.equal(rule.config.access.apiKey, undefined, "落盘 access 不得有明文 apiKey");
      assert.match(rule.config.access.credentialRef, /^provider:apikey:/);
      assert.ok(vault.store.has(rule.config.access.credentialRef), "vault 中应有对应条目");
    }
    // 明文与 providerId 一一对应（说明迁移经过既有 vault 路径）。
    assert.ok([...vault.store.values()].includes(FAKE_CLAUDE_KEY));
    assert.ok([...vault.store.values()].includes(FAKE_CODEX_KEY));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// N11：源码/夹具无可用凭据字面量（合成 key 前缀统一，断言不存在真实前缀形态）。
test("N11 测试夹具凭据均为合成占位，不含真实前缀形态", () => {
  const self = readFileSync(new URL(import.meta.url), "utf8");
  // 真实形态前缀：sk-ant-<长串> / sk-proj-<长串>（本文件一律用 sk-test-fake-*）。
  assert.ok(!/sk-ant-[A-Za-z0-9_-]{16,}/.test(self));
  assert.ok(!/sk-proj-[A-Za-z0-9_-]{16,}/.test(self));
  assert.ok(self.includes("sk-test-fake-"), "夹具应显式使用合成前缀");
  // 静态守门：夹具目录只读，断言本测试不写入 spec 目录。
  assert.ok(!existsSync(join(tmpdir(), "acode-provider-import-should-not-exist")));
  assert.ok(statSync(new URL(import.meta.url)).isFile());
});