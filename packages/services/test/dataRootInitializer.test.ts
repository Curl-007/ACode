import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  initializeDataRoot,
  recordUserMigrationInDataRoot,
} from "../src/data-root/initializer.js";
import {
  ACODE_DATA_ROOT_DIR_NAME,
  DATA_ROOT_MANIFEST_FILE_NAME,
  DATA_ROOT_PRODUCT_ID,
} from "../src/data-root/types.js";

/**
 * 初始化器四态判定测试（spec: packages/services/specs/data-root-ownership.md）：
 * normal 放行 / absent 创建 / unowned-adopt 零改动接管 / unowned-foreign+corrupt 备份让路。
 * 全部用例显式传 baseDir（临时目录 fixture），不改全局 dataBaseDir，不触碰真实 HOME。
 */

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), "acode-initializer-"));
}

function manifestPathOf(base: string): string {
  return join(base, ACODE_DATA_ROOT_DIR_NAME, DATA_ROOT_MANIFEST_FILE_NAME);
}

function readManifest(base: string): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPathOf(base), "utf8"));
}

test("normal：合法根直接放行，归属文件字节不变", () => {
  const base = makeBase();
  try {
    const first = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(first.state, "initialized");
    const bytesBefore = readFileSync(manifestPathOf(base), "utf8");
    const second = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(second.state, "ready");
    assert.equal(readFileSync(manifestPathOf(base), "utf8"), bytesBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("absent：目录不存在 → 创建 + 写归属文件", () => {
  const base = makeBase();
  try {
    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "initialized");
    const manifest = readManifest(base);
    assert.equal(manifest.product, DATA_ROOT_PRODUCT_ID);
    assert.equal(manifest.createdBy, "desktop");
    assert.deepEqual(manifest.migrations, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "absent：新建数据根目录 POSIX 权限 0700",
  { skip: process.platform === "win32" ? "Windows 无 POSIX 权限位" : false },
  () => {
    const base = makeBase();
    try {
      initializeDataRoot({ baseDir: base, createdBy: "desktop" });
      const mode = statSync(join(base, ACODE_DATA_ROOT_DIR_NAME)).mode & 0o777;
      assert.equal(mode, 0o700, "数据根含凭据类数据，必须仅当前用户可访问");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test("absent：空目录同样按首次运行初始化", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME), { recursive: true });
    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "initialized");
    assert.equal(existsSync(manifestPathOf(base)), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unowned-adopt：存量 ACode 数据零改动接管（内容与 mtime 均不变）", () => {
  const base = makeBase();
  try {
    const v2 = join(base, ACODE_DATA_ROOT_DIR_NAME, "v2");
    mkdirSync(v2, { recursive: true });
    const settingsFile = join(v2, "setting.json");
    writeFileSync(settingsFile, '{"locale":"zh-CN"}');
    writeFileSync(join(v2, "user-data.txt"), "precious");
    // 固定旧时间戳：接管若触碰数据文件（重写/chmod 目录树遍历写）mtime 会变化。
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    utimesSync(settingsFile, old, old);
    utimesSync(join(v2, "user-data.txt"), old, old);

    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "adopted");
    if (result.state === "adopted") {
      assert.equal(result.marker, "v2/setting.json");
    }

    const manifest = readManifest(base);
    assert.equal(manifest.createdBy, "adoption");
    assert.equal(manifest.adoptedFrom, "v2/setting.json");
    assert.deepEqual(manifest.migrations, []);

    // 数据零改动：内容、mtime、v2 目录清单全部保持原样。
    assert.equal(readFileSync(settingsFile, "utf8"), '{"locale":"zh-CN"}');
    assert.equal(readFileSync(join(v2, "user-data.txt"), "utf8"), "precious");
    assert.equal(statSync(settingsFile).mtimeMs, old.getTime());
    assert.equal(statSync(join(v2, "user-data.txt")).mtimeMs, old.getTime());
    assert.deepEqual(readdirSync(v2).sort(), ["setting.json", "user-data.txt"]);
    // 接管只新增归属文件一个文件。
    assert.deepEqual(
      readdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME)).sort(),
      [DATA_ROOT_MANIFEST_FILE_NAME, "v2"],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unowned-foreign：备份让路 + 全新初始化，新归属记录 backupPath", () => {
  const base = makeBase();
  try {
    const rootDir = join(base, ACODE_DATA_ROOT_DIR_NAME);
    mkdirSync(join(rootDir, "other-product"), { recursive: true });
    writeFileSync(join(rootDir, "other-product", "data.bin"), "foreign-bytes");

    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "initialized");
    assert.ok(result.backupPath);
    if (result.state !== "initialized") return;

    // 旧内容整体保留在备份落点，不删除、不合并。
    assert.equal(
      readFileSync(join(result.backupPath, "other-product", "data.bin"), "utf8"),
      "foreign-bytes",
    );
    assert.match(result.backupPath, /\.acode\.backup-/u);
    // 断言 basename：Windows 绝对路径本身含盘符冒号（C:），只有文件名部分需要冒号安全。
    assert.equal(basename(result.backupPath).includes(":"), false, "Windows 文件名安全");

    // 新根干净：不含旧数据，归属文件 migrations 记录 backupPath。
    assert.equal(existsSync(join(rootDir, "other-product")), false);
    const manifest = readManifest(base);
    assert.equal(manifest.createdBy, "desktop");
    const migrations = manifest.migrations as Array<Record<string, unknown>>;
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0]?.kind, "conflict-backup");
    assert.equal(migrations[0]?.backupPath, result.backupPath);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt：归属文件不可解析 → 备份让路，不静默复用", () => {
  const base = makeBase();
  try {
    const rootDir = join(base, ACODE_DATA_ROOT_DIR_NAME);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, DATA_ROOT_MANIFEST_FILE_NAME), "{ broken");
    writeFileSync(join(rootDir, "keep.txt"), "kept");

    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "initialized");
    if (result.state !== "initialized") return;
    assert.ok(result.backupPath);
    assert.equal(readFileSync(join(result.backupPath ?? "", DATA_ROOT_MANIFEST_FILE_NAME), "utf8"), "{ broken");
    assert.equal(readFileSync(join(result.backupPath ?? "", "keep.txt"), "utf8"), "kept");
    assert.equal(readManifest(base).createdBy, "desktop");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt：product 不匹配 → 备份让路 + 全新初始化", () => {
  const base = makeBase();
  try {
    const rootDir = join(base, ACODE_DATA_ROOT_DIR_NAME);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(
      join(rootDir, DATA_ROOT_MANIFEST_FILE_NAME),
      JSON.stringify({
        product: "some-other-app",
        schemaVersion: 1,
        createdBy: "desktop",
        createdAt: new Date().toISOString(),
        migrations: [],
      }),
    );

    const result = initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    assert.equal(result.state, "initialized");
    if (result.state !== "initialized") return;
    assert.ok(result.backupPath);
    const manifest = readManifest(base);
    assert.equal(manifest.product, DATA_ROOT_PRODUCT_ID);
    const migrations = manifest.migrations as Array<Record<string, unknown>>;
    assert.equal(migrations[0]?.kind, "conflict-backup");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recordUserMigrationInDataRoot：目标根已有合法归属 → 追加 user-migration 记录", async () => {
  const base = makeBase();
  try {
    initializeDataRoot({ baseDir: base, createdBy: "desktop" });
    await recordUserMigrationInDataRoot({ targetBaseDir: base, fromBaseDir: "/old/base" });
    const manifest = readManifest(base);
    const migrations = manifest.migrations as Array<Record<string, unknown>>;
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0]?.kind, "user-migration");
    assert.equal(migrations[0]?.from, "/old/base");
    assert.equal(migrations[0]?.to, base);
    // 再次迁移继续追加，不覆盖历史。
    await recordUserMigrationInDataRoot({ targetBaseDir: base, fromBaseDir: "/older/base" });
    const second = readManifest(base).migrations as Array<Record<string, unknown>>;
    assert.equal(second.length, 2);
    assert.equal(second[1]?.from, "/older/base");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recordUserMigrationInDataRoot：目标根无归属（首次迁移/旧布局）→ 补写完整归属文件", async () => {
  const base = makeBase();
  try {
    // 模拟 copyDataDirectory 完成后的目标根：有 v2 数据、无归属文件。
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2"), { recursive: true });
    writeFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2", "data.txt"), "migrated");
    await recordUserMigrationInDataRoot({ targetBaseDir: base, fromBaseDir: "/old/base" });
    const manifest = readManifest(base);
    assert.equal(manifest.product, DATA_ROOT_PRODUCT_ID);
    assert.equal(manifest.createdBy, "desktop");
    const migrations = manifest.migrations as Array<Record<string, unknown>>;
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0]?.kind, "user-migration");
    // 数据本身零改动。
    assert.equal(
      readFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2", "data.txt"), "utf8"),
      "migrated",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
