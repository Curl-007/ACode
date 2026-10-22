import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 官方插件播种端到端验收（specs/skill-seeding-registration.md R2/R3/R5，验收场景 4/5）。
 *
 * 在真实 monorepo 布局（filesystem seed 源）下对临时 storageRoot 跑 resolveOfficialPluginRoots：
 * - seed marker 携带完整归因字段（marketplace/plugin/pluginVersion/source/hash）；
 * - bundled 分区条目的 description/description_i18n 以插件包内 plugin.json 为事实源，
 *   包内未声明 i18n 时回退 definitions listing seed；
 * - 重跑幂等：marker hash 不变、无 .tmp- 与 .backup- 事务目录残留、outcome 全部 reused；
 * - seed 生命周期 info 汇总日志存在且 outcome 在闭集内；
 * - 播种失败（如 dist 未构建的 checkout）单插件降级：不产生无 marker 的残缺缓存代。
 *
 * 环境容忍：agent-teams / node-repl-host 的 dist 是 gitignore 构建产物，未构建的
 * checkout 上这两个插件走 rejected_incomplete 降级，属既有协议，本测试按条件断言。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repoRoot, "apps", "acode-cli");
const OFFICIAL_MARKETPLACE = "acode-plugins-official";
const OUTCOME_CLOSED_SET = new Set([
  "reused",
  "written",
  "degraded",
  "rejected_incomplete",
  "rejected_oversize",
]);

const { OFFICIAL_PLUGIN_DEFINITIONS } =
  await import("../packages/bootstrap/src/app/official-plugin-definitions.ts");
const { resolveOfficialPluginRoots } =
  await import("../packages/bootstrap/src/app/bundled-plugins.ts");

function createLogger() {
  const records = [];
  const record = (level) => (message, details) => records.push({ details, level, message });
  return {
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    records,
    warn: record("warn"),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function cacheRootFor(storageRoot, definition) {
  return join(storageRoot, "cache", OFFICIAL_MARKETPLACE, definition.name, definition.version);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listTreeNames(root) {
  const names = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      names.push(entry.name);
      if (entry.isDirectory()) await walk(join(dir, entry.name));
    }
  };
  try {
    await walk(root);
  } catch {
    // 目录缺席 = 空名单
  }
  return names;
}

test("播种→归因→幂等：marker/分区条目/summary 日志/重跑 reused（spec R2/R3/R5）", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "acode-seed-integration-"));
  t.after(() => rm(storageRoot, { force: true, recursive: true }));

  const firstLogger = createLogger();
  resolveOfficialPluginRoots({ env: {}, logger: firstLogger, storageRoot });
  // 返回值是根路径数组（string[]）；降级集合必须从 seed_summary 的 outcomes 取
  // （spec R5 闭集）。旧实现把返回值当 failed definitions：string[].name 恒 undefined，
  // dist 未构建的 checkout 上会对降级插件（node-repl-host 等）误断言 marker 存在。
  const degradedNames = (logger) =>
    new Set(
      (
        logger.records.find(
          (record) => record.level === "info" && record.details?.operation === "seed_summary",
        )?.details?.outcomes ?? []
      )
        .filter((item) => item.outcome !== "written" && item.outcome !== "reused")
        .map((item) => item.pluginId.split("@")[0]),
    );
  const firstFailedNames = degradedNames(firstLogger);

  // 每个定义要么成功播种（marker 完整），要么在 failedSeeds 里（降级协议），二者必居其一。
  const seededDefinitions = [];
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const cacheRoot = cacheRootFor(storageRoot, definition);
    if (firstFailedNames.has(definition.name)) {
      // 降级不得留下无 marker 的残缺当前代（spec R2：播种失败不毁既有、不写残缺）。
      const markerProbe = await readFile(join(cacheRoot, ".acode-plugin-seed.json"), "utf8").then(
        () => "present",
        (error) => (error.code === "ENOENT" ? "missing" : "unexpected"),
      );
      assert.ok(
        markerProbe !== "unexpected",
        `${definition.name}: 降级插件的 marker 读取出现非 ENOENT 错误`,
      );
      continue;
    }
    seededDefinitions.push(definition);
    const marker = await readJson(join(cacheRoot, ".acode-plugin-seed.json"));
    assert.equal(marker.version, 1, `${definition.name}: marker 版本`);
    assert.equal(
      marker.marketplace,
      OFFICIAL_MARKETPLACE,
      `${definition.name}: marker 归因 marketplace`,
    );
    assert.equal(marker.plugin, definition.name, `${definition.name}: marker 归因 plugin`);
    assert.equal(marker.pluginVersion, definition.version, `${definition.name}: marker 归因版本`);
    assert.equal(marker.source, "filesystem", `${definition.name}: marker 归因 seed 源`);
    assert.match(marker.hash, /^[0-9a-f]{64}$/u, `${definition.name}: marker hash 形态`);
  }
  assert.ok(
    seededDefinitions.length >= 10,
    `成功播种数量异常（${seededDefinitions.length}），检查 seed 源解析`,
  );

  // 分区条目：source/cachePath 归因 + description 事实源（R3）。
  const partitionsRoot = join(storageRoot, "marketplaces", OFFICIAL_MARKETPLACE);
  const bundledPartition = await readJson(join(partitionsRoot, "bundled-marketplace.json"));
  const merged = await readJson(join(partitionsRoot, "marketplace.json"));
  assert.equal(bundledPartition.version, 1);
  assert.equal(merged.name, OFFICIAL_MARKETPLACE);
  const entries = new Map(merged.plugins.map((entry) => [entry.name, entry]));
  for (const definition of seededDefinitions) {
    const entry = entries.get(definition.name);
    assert.ok(entry, `${definition.name}: merged marketplace.json 缺条目`);
    assert.equal(entry.source, "filesystem", `${definition.name}: 条目归因 source`);
    assert.equal(
      entry.cachePath,
      cacheRootFor(storageRoot, definition),
      `${definition.name}: cachePath`,
    );

    const manifest = await readJson(
      join(cliRoot, definition.rootCandidates[0], ".acode-plugin", "plugin.json"),
    );
    if (typeof manifest.description === "string" && manifest.description.trim().length > 0) {
      assert.equal(
        entry.description,
        manifest.description,
        `${definition.name}: description 事实源是 plugin.json`,
      );
    }
    if (manifest.description_i18n) {
      // 包内声明整表覆盖 listing seed。
      assert.deepEqual(
        entry.description_i18n,
        manifest.description_i18n,
        `${definition.name}: description_i18n 应以 plugin.json 整表覆盖`,
      );
    } else if (definition.listing?.description_i18n) {
      assert.deepEqual(
        entry.description_i18n,
        definition.listing.description_i18n,
        `${definition.name}: 包内未声明 i18n 时回退 definitions listing seed`,
      );
    }
  }

  // seed 生命周期 info 汇总（R5）：operation 闭集键 + outcome 闭集。
  const summaries = firstLogger.records.filter(
    (record) => record.level === "info" && record.details?.operation === "seed_summary",
  );
  assert.equal(summaries.length, 1, "一次 seeding 恰好一条 seed_summary info 日志");
  assert.equal(summaries[0].details.module, "bootstrap.official_plugin_cache");
  assert.equal(summaries[0].details.source, "filesystem");
  const outcomes = summaries[0].details.outcomes;
  assert.equal(
    outcomes.length,
    OFFICIAL_PLUGIN_DEFINITIONS.length,
    "每个官方插件恰好一条 outcome 记录",
  );
  for (const item of outcomes) {
    assert.ok(OUTCOME_CLOSED_SET.has(item.outcome), `outcome 越出闭集: ${item.outcome}`);
    assert.equal(item.pluginId, `${item.pluginId.split("@")[0]}@${OFFICIAL_MARKETPLACE}`);
  }
  const writtenNames = outcomes
    .filter((item) => item.outcome === "written")
    .map((item) => item.pluginId);
  assert.equal(writtenNames.length, seededDefinitions.length, "首跑成功插件 outcome 应为 written");

  // 无事务残留（moveExistingAside 语义收口：唯一 backup/tmp 必须清理）。
  const cacheTree = await listTreeNames(join(storageRoot, "cache", OFFICIAL_MARKETPLACE));
  for (const name of cacheTree) {
    assert.ok(!name.includes(".tmp-"), `临时目录残留: ${name}`);
    assert.ok(!name.includes(".backup"), `备份目录残留: ${name}`);
    assert.ok(!name.includes(".seed-lock"), `seed 锁残留: ${name}`);
  }

  // 重跑幂等：marker hash 不变、成功插件全部 reused。
  const markersBefore = new Map();
  for (const definition of seededDefinitions) {
    markersBefore.set(
      definition.name,
      await readFile(
        join(cacheRootFor(storageRoot, definition), ".acode-plugin-seed.json"),
        "utf8",
      ),
    );
  }
  const secondLogger = createLogger();
  resolveOfficialPluginRoots({ env: {}, logger: secondLogger, storageRoot });
  assert.deepEqual(
    [...degradedNames(secondLogger)].sort(),
    [...firstFailedNames].sort(),
    "重跑的降级集合必须稳定",
  );
  for (const definition of seededDefinitions) {
    const markerAfter = await readFile(
      join(cacheRootFor(storageRoot, definition), ".acode-plugin-seed.json"),
      "utf8",
    );
    assert.equal(
      markerAfter,
      markersBefore.get(definition.name),
      `${definition.name}: 重跑 marker 必须逐字节不变`,
    );
  }
  const secondSummary = secondLogger.records.find(
    (record) => record.level === "info" && record.details?.operation === "seed_summary",
  );
  assert.ok(secondSummary, "重跑同样要有 seed_summary info 日志");
  for (const item of secondSummary.details.outcomes) {
    const name = item.pluginId.split("@")[0];
    if (!firstFailedNames.has(name)) {
      assert.equal(item.outcome, "reused", `${name}: 重跑 outcome 应为 reused`);
    }
  }
  const cacheTreeAfter = await listTreeNames(join(storageRoot, "cache", OFFICIAL_MARKETPLACE));
  for (const name of cacheTreeAfter) {
    assert.ok(!name.includes(".tmp-") && !name.includes(".backup"), `重跑事务残留: ${name}`);
  }
  assert.ok(await pathExists(join(storageRoot, "cache")), "sanity: cache 根存在");
});
