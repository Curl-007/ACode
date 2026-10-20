import assert from "node:assert/strict";
import {
  chmodSync,
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
import { basename, join } from "node:path";
import test from "node:test";
import {
  appendDataRootMigrationRecord,
  forfeitConflictingDataRoot,
  readDataRootStatus,
  writeDataRootManifestIntoRoot,
} from "../src/data-root/ownership.js";
import {
  ACODE_DATA_ROOT_DIR_NAME,
  DATA_ROOT_MANIFEST_FILE_NAME,
  DATA_ROOT_MANIFEST_SCHEMA_VERSION,
  DATA_ROOT_PRODUCT_ID,
  parseDataRootManifest,
} from "../src/data-root/types.js";
import { copyDataDirectory } from "../src/paths.js";

/**
 * 归属判定 / 备份让路 / 迁移记录追加的单测：只操作临时目录 fixture，不触碰真实 HOME。
 * spec: packages/services/specs/data-root-ownership.md
 */

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), "acode-ownership-"));
}

function writeManifestFile(base: string, raw: string): void {
  const root = join(base, ACODE_DATA_ROOT_DIR_NAME);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, DATA_ROOT_MANIFEST_FILE_NAME), raw);
}

function validManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    product: DATA_ROOT_PRODUCT_ID,
    schemaVersion: DATA_ROOT_MANIFEST_SCHEMA_VERSION,
    createdBy: "desktop",
    createdAt: new Date().toISOString(),
    migrations: [],
    ...overrides,
  });
}

test("absent：数据根目录不存在", () => {
  const base = makeBase();
  try {
    assert.equal(readDataRootStatus(base).kind, "absent");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("absent：数据根目录存在但为空", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME), { recursive: true });
    assert.equal(readDataRootStatus(base).kind, "absent");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("normal：合法归属文件", () => {
  const base = makeBase();
  try {
    writeManifestFile(base, validManifest());
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "normal");
    if (status.kind === "normal") {
      assert.equal(status.manifest.product, DATA_ROOT_PRODUCT_ID);
      assert.equal(status.manifest.createdBy, "desktop");
      assert.deepEqual(status.manifest.migrations, []);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unowned-adopt：v2/setting.json 特征（存量用户升级路径）", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2"), { recursive: true });
    writeFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2", "setting.json"), "{}");
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "unowned-adopt");
    if (status.kind === "unowned-adopt") {
      assert.equal(status.marker, "v2/setting.json");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unowned-adopt：仅 v2/ 子目录也构成 ACode 特征", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2"), { recursive: true });
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "unowned-adopt");
    if (status.kind === "unowned-adopt") {
      assert.equal(status.marker, "v2/");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unowned-foreign：非空目录但无归属文件、无 ACode 特征", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "other-product"), { recursive: true });
    writeFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "stray.txt"), "not-acode");
    assert.equal(readDataRootStatus(base).kind, "unowned-foreign");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt：归属文件不可解析", () => {
  const base = makeBase();
  try {
    writeManifestFile(base, "{ not-json");
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "corrupt");
    if (status.kind === "corrupt") {
      assert.equal(status.reason, "manifest-unreadable");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt：product 不匹配（他产品归属文件）", () => {
  const base = makeBase();
  try {
    writeManifestFile(base, validManifest({ product: "some-other-app" }));
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "corrupt");
    if (status.kind === "corrupt") {
      assert.equal(status.reason, "product-mismatch");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("corrupt：schemaVersion 过新（降级场景禁止读取）", () => {
  const base = makeBase();
  try {
    writeManifestFile(
      base,
      validManifest({ schemaVersion: DATA_ROOT_MANIFEST_SCHEMA_VERSION + 1 }),
    );
    const status = readDataRootStatus(base);
    assert.equal(status.kind, "corrupt");
    if (status.kind === "corrupt") {
      assert.equal(status.reason, "schema-unsupported");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseDataRootManifest：字段非法一律拒绝（createdBy / migrations / adoptedFrom）", () => {
  assert.equal(parseDataRootManifest(validManifest({ createdBy: "installer" })), null);
  assert.equal(parseDataRootManifest(validManifest({ migrations: "none" })), null);
  assert.equal(parseDataRootManifest(validManifest({ migrations: [{ kind: "user-migration" }] })), null);
  assert.equal(parseDataRootManifest(validManifest({ adoptedFrom: 42 })), null);
  assert.equal(parseDataRootManifest("[]"), null);
  const parsed = parseDataRootManifest(
    validManifest({
      createdBy: "adoption",
      adoptedFrom: "v2/",
      migrations: [
        { at: "2026-10-20T00:00:00.000Z", kind: "conflict-backup", backupPath: "/tmp/x.backup-1" },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.createdBy, "adoption");
  assert.equal(parsed?.adoptedFrom, "v2/");
  assert.equal(parsed?.migrations[0]?.backupPath, "/tmp/x.backup-1");
});

test("writeDataRootManifestIntoRoot：原子写内容完整且不残留 tmp", () => {
  const base = makeBase();
  try {
    const rootDir = join(base, ACODE_DATA_ROOT_DIR_NAME);
    const manifestPath = writeDataRootManifestIntoRoot(rootDir, {
      product: DATA_ROOT_PRODUCT_ID,
      schemaVersion: DATA_ROOT_MANIFEST_SCHEMA_VERSION,
      createdBy: "cli",
      createdAt: new Date().toISOString(),
      migrations: [],
    });
    assert.equal(manifestPath, join(rootDir, DATA_ROOT_MANIFEST_FILE_NAME));
    assert.equal(readDataRootStatus(base).kind, "normal");
    assert.equal(
      readdirSync(rootDir).some((name) => name.endsWith(".tmp")),
      false,
    );
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(parsed.createdBy, "cli");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("forfeitConflictingDataRoot：整体改名备份，内容保留，名字 Windows 安全", () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "other"), { recursive: true });
    writeFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "other", "data.json"), "keep-me");
    const backup = forfeitConflictingDataRoot(base);
    assert.equal(existsSync(join(base, ACODE_DATA_ROOT_DIR_NAME)), false);
    assert.equal(readFileSync(join(backup, "other", "data.json"), "utf8"), "keep-me");
    assert.match(backup, /\.acode\.backup-/u);
    // 断言 basename：Windows 绝对路径本身含盘符冒号（C:），只有文件名部分需要冒号安全。
    assert.equal(basename(backup).includes(":"), false, "备份目录名不得含冒号（Windows 文件名非法）");
    assert.ok(statSync(backup).isDirectory());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("appendDataRootMigrationRecord：normal 归属上追加记录", async () => {
  const base = makeBase();
  try {
    writeManifestFile(base, validManifest());
    const updated = await appendDataRootMigrationRecord(base, {
      at: "2026-10-20T01:00:00.000Z",
      from: "/old/base",
      to: base,
      kind: "user-migration",
    });
    assert.equal(updated.migrations.length, 1);
    assert.equal(updated.migrations[0]?.kind, "user-migration");
    const onDisk = JSON.parse(
      readFileSync(join(base, ACODE_DATA_ROOT_DIR_NAME, DATA_ROOT_MANIFEST_FILE_NAME), "utf8"),
    );
    assert.equal(onDisk.migrations[0].from, "/old/base");
    assert.equal(
      readdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME)).some((name: string) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("appendDataRootMigrationRecord：归属缺失或非法时抛错（由调用方补写）", async () => {
  const base = makeBase();
  try {
    mkdirSync(join(base, ACODE_DATA_ROOT_DIR_NAME, "v2"), { recursive: true });
    await assert.rejects(
      () =>
        appendDataRootMigrationRecord(base, {
          at: new Date().toISOString(),
          kind: "user-migration",
        }),
      /无法追加迁移记录/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "copyDataDirectory：POSIX 迁移后凭据文件 0600 不被放宽",
  { skip: process.platform === "win32" ? "Windows 无 POSIX 权限位" : false },
  async () => {
    const oldBase = makeBase();
    const newBase = makeBase();
    try {
      const v2 = join(oldBase, ACODE_DATA_ROOT_DIR_NAME, "v2");
      mkdirSync(join(v2, "credential"), { recursive: true });
      writeFileSync(join(v2, "credential", "cred.json"), "secret");
      chmodSync(join(v2, "credential", "cred.json"), 0o600);
      chmodSync(join(v2, "credential"), 0o700);
      writeFileSync(join(v2, "notes.txt"), "note");
      await copyDataDirectory(oldBase, newBase);
      const copiedCred = join(newBase, ACODE_DATA_ROOT_DIR_NAME, "v2", "credential", "cred.json");
      assert.equal(readFileSync(copiedCred, "utf8"), "secret");
      assert.equal(statSync(copiedCred).mode & 0o777, 0o600, "凭据文件权限不得被放宽");
      assert.equal(
        statSync(join(newBase, ACODE_DATA_ROOT_DIR_NAME, "v2", "credential")).mode & 0o777,
        0o700,
        "凭据目录权限不得被放宽",
      );
      assert.equal(
        readFileSync(join(newBase, ACODE_DATA_ROOT_DIR_NAME, "v2", "notes.txt"), "utf8"),
        "note",
      );
    } finally {
      rmSync(oldBase, { recursive: true, force: true });
      rmSync(newBase, { recursive: true, force: true });
    }
  },
);
