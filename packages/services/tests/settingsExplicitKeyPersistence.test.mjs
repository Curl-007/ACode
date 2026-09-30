import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 配置持久化「只写显式键」回归测试（J1-4 配置持久化全量覆盖审计）。
 *
 * jcode 事故教训：Config::save() 全量序列化把旧默认值冻结进 168 个用户配置文件，
 * 之后翻转默认值也救不回来。settingService 的普通偏好保存曾复现同一模式
 * （单键 update 会把 schema 全部默认值物化落盘，实测 33 键）。
 * 修复后：写回键集合 = 磁盘已有键 ∪ 本次显式 patch 键 ∪ 迁移标记键；
 * 一次性迁移提交路径保持全量写盘的既有语义。
 *
 * 对应 spec：apps/acode-cli/specs/config-persistence-audit.md
 */

const { createSettingService } = await import("../src/setting/settingService.ts");

function settingsFilePath(home) {
  return join(home, ".acode", "v2", "setting.json");
}

async function createTempHome() {
  return mkdtemp(join(tmpdir(), "acode-settings-explicit-keys-"));
}

async function readRawSettings(home) {
  return JSON.parse(await readFile(settingsFilePath(home), "utf8"));
}

async function seedRawSettings(home, value) {
  await mkdir(join(home, ".acode", "v2"), { recursive: true });
  await writeFile(settingsFilePath(home), JSON.stringify(value, null, 2), "utf8");
}

// resolveUserHomeDir 在每次调用时读取 ACODE_DESKTOP_HOME_DIR，测试逐个串行改指向。
function useHome(home) {
  process.env.ACODE_DESKTOP_HOME_DIR = home;
}

test("单键 update 不再把 schema 默认值冻结进 setting.json", async (t) => {
  const home = await createTempHome();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  useHome(home);
  const service = createSettingService();

  await service.update({ locale: "en-US" });
  const raw = await readRawSettings(home);

  assert.equal(raw.locale, "en-US");
  // normalizeSettingsPatch 把 locale 升级为显式 localePreference 偏好，属显式键
  assert.equal(raw.localePreference, "en-US");
  // 迁移标记键必须落盘，否则 shouldPersistSettingsMigrations 判定不收敛，get() 反复触发迁移写
  assert.equal(raw.closeToTrayOnWindowsMigrationInitialized, true);
  assert.equal(raw.closeToTrayOnWindows, true);
  assert.equal(raw.messageStreamShowReasoningMigrationInitialized, true);
  assert.equal(raw.messageStreamShowReasoning, true);
  // 用户从未显式设置过的键必须保持缺席——这是 jcode 冻结事故的回归守卫
  assert.equal("computerUseComposerEntryHidden" in raw, false);
  assert.equal("taskAutoArchiveOlderThanDays" in raw, false);
  assert.equal("recentProjects" in raw, false);
  assert.equal("memoryEnabled" in raw, false);
  assert.equal("skippedElectronUpdateVersions" in raw, false);

  // 读取侧不受影响：schema 对缺席键补当前默认值
  const textBeforeGet = await readFile(settingsFilePath(home), "utf8");
  const settings = await service.get();
  assert.equal(settings.locale, "en-US");
  assert.equal(settings.computerUseComposerEntryHidden, true);
  assert.equal(settings.taskAutoArchiveOlderThanDays, 7);
  // 标记键已收敛，get() 不得再触发迁移重写把默认值全量物化
  const textAfterGet = await readFile(settingsFilePath(home), "utf8");
  assert.equal(textAfterGet, textBeforeGet, "get() 不应重写已收敛的 setting.json");
});

test("磁盘已有键在普通保存时保留，新增默认键不被写入", async (t) => {
  const home = await createTempHome();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  useHome(home);
  await seedRawSettings(home, {
    keepAwakeWhileRunning: true,
    taskAutoArchiveOlderThanDays: 30,
    closeToTrayOnWindowsMigrationInitialized: true,
    messageStreamShowReasoningMigrationInitialized: true,
  });
  const service = createSettingService();

  await service.update({ taskAutoArchiveOlderThanDays: 14 });
  const raw = await readRawSettings(home);

  assert.equal(raw.taskAutoArchiveOlderThanDays, 14);
  // 未在 patch 里但已在磁盘上的用户键必须原样保留
  assert.equal(raw.keepAwakeWhileRunning, true);
  // 未在磁盘也未在 patch 的键不因合并写被物化
  assert.equal("memoryEnabled" in raw, false);
  assert.equal("computerUseComposerEntryHidden" in raw, false);
});

test("清空设置把键从磁盘删除，而不是残留旧值", async (t) => {
  const home = await createTempHome();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  useHome(home);
  await seedRawSettings(home, {
    httpProxy: "http://127.0.0.1:7890",
    closeToTrayOnWindowsMigrationInitialized: true,
    messageStreamShowReasoningMigrationInitialized: true,
  });
  const service = createSettingService();

  // normalizeSettingsPatch 把空串归一成 undefined（清空语义）；
  // 显式键集合必须来自归一化结果，删除才不会被「只写显式键」模式吞掉。
  await service.update({ httpProxy: "" });
  const raw = await readRawSettings(home);
  assert.equal("httpProxy" in raw, false);

  const settings = await service.get();
  assert.equal(settings.httpProxy, undefined);
});

test("官方服务开关随显式 patch 持久化并可跨 get() 读回", async (t) => {
  const home = await createTempHome();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  useHome(home);
  const service = createSettingService();

  await service.update({ officialServices: { account: true, clientConfig: false } });
  const raw = await readRawSettings(home);
  assert.equal(raw.officialServices.account, true);
  assert.equal(raw.officialServices.clientConfig, false);

  const settings = await service.get();
  assert.equal(settings.officialServices.account, true);
  assert.equal(settings.officialServices.clientConfig, false);
});

test("一次性迁移提交保持全量写盘且幂等收敛", async (t) => {
  const home = await createTempHome();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  useHome(home);
  // 空对象文件：迁移标记缺席 → 首次 get() 触发一次性迁移提交（既有语义：全量写盘）
  await seedRawSettings(home, {});
  const service = createSettingService();

  const settings = await service.get();
  assert.equal(settings.closeToTrayOnWindows, true);
  const raw = await readRawSettings(home);
  assert.equal(raw.closeToTrayOnWindowsMigrationInitialized, true);
  assert.equal(raw.messageStreamShowReasoningMigrationInitialized, true);

  const textAfterFirstGet = await readFile(settingsFilePath(home), "utf8");
  await service.get();
  const textAfterSecondGet = await readFile(settingsFilePath(home), "utf8");
  assert.equal(textAfterSecondGet, textAfterFirstGet, "迁移收敛后 get() 不得反复重写");
});
