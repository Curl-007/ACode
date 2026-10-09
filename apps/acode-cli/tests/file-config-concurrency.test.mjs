import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadFileConfig, updatePluginEnabledInFileConfig, updateUiLocaleInFileConfig } =
  await import("../packages/adapters/src/config/file-config.adapter.ts");

test("concurrent file config patches preserve both fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-file-config-"));
  const filePath = join(root, "config.json");
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await writeFile(filePath, "{}\n", "utf8");
      await Promise.all([
        updateUiLocaleInFileConfig(filePath, "en-US"),
        updatePluginEnabledInFileConfig(filePath, `plugin-${attempt}`, true),
      ]);
      const persisted = JSON.parse(await readFile(filePath, "utf8"));
      assert.equal(persisted.ui.locale, "en-US");
      assert.equal(persisted.plugins.enabledPlugins[`plugin-${attempt}`], true);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("legacy config migration cannot overwrite a concurrent patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-file-config-migration-"));
  const filePath = join(root, "config.json");
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        plugins: { enabledPlugins: { "acode-cua@acode-plugins-official": true } },
      }) + "\n",
      "utf8",
    );
    loadFileConfig(filePath);
    await updateUiLocaleInFileConfig(filePath, "zh-CN");
    await new Promise((resolve) => setImmediate(resolve));
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.ui.locale, "zh-CN");
    assert.equal(persisted.plugins.enabledPlugins["computer-use@acode-plugins-official"], true);
    assert.equal(persisted.plugins.enabledPlugins["acode-cua@acode-plugins-official"], undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
