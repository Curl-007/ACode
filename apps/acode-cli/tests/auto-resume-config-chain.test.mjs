// 验收场景 6（apps/acode-cli/specs/turn-auto-resume.md）：配置链——schema 解析 / 默认值 /
// 覆盖 / merge / 文件 patch 面（/auto-resume 裸 on|off 与 msg 的持久化落点）。
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigScope, DefaultRuntimeConfig } from "../packages/contracts/src/index.ts";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../packages/adapters/src/config/schema.ts";
import {
  createPrioritizedConfig,
  mergeConfigs,
} from "../packages/adapters/src/config/config-merger.ts";
import { updateAutoResumeInFileConfig } from "../packages/adapters/src/config/file-config.adapter.ts";

describe("ACodeConfigFileSchema - autoResume", () => {
  it("parses the full autoResume section", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
      autoResume: {
        continueMessage: "keep going {count}/{max}",
        cooldownBaseSec: 5,
        cooldownFactor: 1.5,
        cooldownMaxSec: 30,
        enabled: false,
        loopGuardRepeats: 2,
        maxResumes: 3,
      },
    });
    assert.deepEqual(config.autoResume, {
      continueMessage: "keep going {count}/{max}",
      cooldownBaseSec: 5,
      cooldownFactor: 1.5,
      cooldownMaxSec: 30,
      enabled: false,
      loopGuardRepeats: 2,
      maxResumes: 3,
    });
  });

  it("accepts partial overrides and strips unknown inner keys", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({
      autoResume: { bogus: 1, enabled: false },
    });
    assert.deepEqual(config.autoResume, { enabled: false });
  });

  it("omits autoResume from the patch when absent", () => {
    const { config } = parseConfigFileToRuntimePatchWithDiagnostics({});
    assert.equal(config.autoResume, undefined);
  });

  it("rejects invalid values (non-positive counters, wrong types, blank message)", () => {
    for (const autoResume of [
      { maxResumes: 0 },
      { cooldownBaseSec: -1 },
      { loopGuardRepeats: 1.5 },
      { enabled: "yes" },
      { continueMessage: "" },
    ]) {
      assert.throws(
        () => parseConfigFileToRuntimePatchWithDiagnostics({ autoResume }),
        undefined,
        JSON.stringify(autoResume),
      );
    }
  });
});

describe("DefaultRuntimeConfig.autoResume - spec 默认值", () => {
  it("matches true/8/10/2/60/3", () => {
    assert.deepEqual(DefaultRuntimeConfig.autoResume, {
      cooldownBaseSec: 10,
      cooldownFactor: 2,
      cooldownMaxSec: 60,
      enabled: true,
      loopGuardRepeats: 3,
      maxResumes: 8,
    });
  });
});

describe("mergeConfigs - autoResume 逐字段合并", () => {
  it("user partial override inherits the remaining default fields", () => {
    const merged = mergeConfigs(
      createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
      createPrioritizedConfig({ autoResume: { maxResumes: 2 } }, ConfigScope.User),
    );
    assert.deepEqual(merged.autoResume, {
      cooldownBaseSec: 10,
      cooldownFactor: 2,
      cooldownMaxSec: 60,
      enabled: true,
      loopGuardRepeats: 3,
      maxResumes: 2,
    });
  });

  it("higher scope wins per field, lower scopes survive elsewhere", () => {
    const merged = mergeConfigs(
      createPrioritizedConfig(
        { autoResume: { cooldownBaseSec: 5, enabled: true } },
        ConfigScope.User,
      ),
      createPrioritizedConfig({ autoResume: { enabled: false } }, ConfigScope.Project),
    );
    assert.deepEqual(merged.autoResume, { cooldownBaseSec: 5, enabled: false });
  });
});

describe("updateAutoResumeInFileConfig - 文件 patch 面", () => {
  it("writes enabled/continueMessage without touching other sections, and clears on null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-resume-config-"));
    const filePath = join(dir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ autoResume: { maxResumes: 5 }, ui: { locale: "zh-CN" } }),
      "utf8",
    );

    const persisted = await updateAutoResumeInFileConfig(filePath, {
      continueMessage: "go {count}",
      enabled: false,
    });
    assert.equal(persisted.path, filePath);
    const afterSet = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(afterSet.autoResume, {
      continueMessage: "go {count}",
      enabled: false,
      maxResumes: 5,
    });
    assert.deepEqual(afterSet.ui, { locale: "zh-CN" });

    await updateAutoResumeInFileConfig(filePath, { continueMessage: null, enabled: true });
    const afterClear = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(afterClear.autoResume, { enabled: true, maxResumes: 5 });
    assert.equal("continueMessage" in afterClear.autoResume, false);
  });

  it("creates the file and section when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-resume-config-"));
    const filePath = join(dir, "nested", "config.json");
    await updateAutoResumeInFileConfig(filePath, { enabled: false });
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(parsed, { autoResume: { enabled: false } });
  });
});
