import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_SNIPPETS_PLUGIN_ID, loadBuiltinSnippets } from "./builtinSnippets.js";

// 内置库的读取路径靠环境变量重定向到临时 HOME：真实缓存目录属用户资产，测试不得写。

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

interface Fixture {
  home: string;
  pluginRoot: string;
}

async function createFixture(options: {
  config?: Record<string, unknown>;
  manifestName?: string;
  library?: string;
  manifestDir?: string;
  withFile?: boolean;
}): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "snippets-builtin-"));
  const pluginRoot = join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    "acode-plugins-official",
    options.manifestName ?? "prompt-snippets",
    "0.1.0",
  );
  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "snippets"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: options.manifestName ?? "prompt-snippets", version: "0.1.0" }),
    "utf-8",
  );
  if (options.withFile !== false) {
    await writeFile(
      join(pluginRoot, "snippets", "builtin.json"),
      options.library ??
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: "builtin:discipline:no-hands",
              group: "discipline",
              kind: "suffix",
              title: { "zh-CN": "先别动手", "en-US": "Don't start yet" },
              content: { "zh-CN": "先别动手。", "en-US": "Don't start yet." },
              requiresMcp: [],
              localOnly: false,
            },
          ],
        }),
      "utf-8",
    );
  }
  await mkdir(join(home, ".acode", "cli"), { recursive: true });
  await writeFile(
    join(home, ".acode", "cli", "config.json"),
    JSON.stringify(options.config ?? {}),
    "utf-8",
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, pluginRoot };
}

async function cleanupFixture(fixture: Fixture | undefined): Promise<void> {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (fixture) {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

test("插件存在且默认启用时读出条目", async () => {
  const fixture = await createFixture({});
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "ready");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.id, "builtin:discipline:no-hands");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("插件被显式停用时返回 unavailable 且不读内容", async () => {
  const fixture = await createFixture({
    config: { plugins: { enabledPlugins: { [BUILTIN_SNIPPETS_PLUGIN_ID]: false } } },
  });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.entries, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("插件被卸载（suppressedBuiltins）时返回 unavailable", async () => {
  const fixture = await createFixture({
    config: { plugins: { suppressedBuiltins: [BUILTIN_SNIPPETS_PLUGIN_ID] } },
  });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "unavailable");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("JSON 非法时返回 loadError 且条目为空", async () => {
  const fixture = await createFixture({ library: "{ not json" });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "loadError");
    assert.deepEqual(result.entries, []);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("schema 校验失败（discipline 组非 suffix）返回 loadError", async () => {
  const fixture = await createFixture({
    library: JSON.stringify({
      version: 1,
      entries: [
        {
          id: "builtin:discipline:bad",
          group: "discipline",
          kind: "prompt",
          title: { "en-US": "x" },
          content: { "en-US": "x" },
          requiresMcp: [],
          localOnly: false,
        },
      ],
    }),
  });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "loadError");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("同名的其他插件不会被当成内置库", async () => {
  const fixture = await createFixture({ manifestName: "some-other-plugin" });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "unavailable");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("数据文件缺失时返回 unavailable", async () => {
  const fixture = await createFixture({ withFile: false });
  try {
    const result = await loadBuiltinSnippets();
    assert.equal(result.status, "unavailable");
  } finally {
    await cleanupFixture(fixture);
  }
});
