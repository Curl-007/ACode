import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import {
  ARCHIVE_GLOBAL_LIMITS,
  ARCHIVE_OWNER_EXECUTABLE_FILE_MODE,
  ARCHIVE_TRUST_POLICIES,
  ARCHIVE_TRUST_TIERS,
  ArchiveExtractionSession,
  ArchivePolicyViolationError,
  isOsMetadataArchiveEntry,
  normalizeArchiveEntryNameForCollision,
} from "../src/node.js";

/**
 * 解包信任档策略矩阵与会话守护测试。
 * 规格：packages/services/specs/file-containment-trust-tiers.md R3/R4。
 */

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "acode-archive-trust-"));
});

function violationReason(error: unknown): string | undefined {
  return error instanceof ArchivePolicyViolationError ? error.reason : undefined;
}

function fileEntry(name: string, overrides: Partial<Parameters<ArchiveExtractionSession["planEntry"]>[0]> = {}) {
  return {
    compressedSize: 100,
    isDirectory: false,
    name,
    uncompressedSize: 100,
    ...overrides,
  };
}

test("矩阵冻结：档位闭集、策略对象与全局上限不可写", () => {
  assert.deepEqual([...ARCHIVE_TRUST_TIERS], ["bundled", "store", "local", "uploaded"]);
  assert.ok(Object.isFrozen(ARCHIVE_TRUST_POLICIES));
  assert.ok(Object.isFrozen(ARCHIVE_GLOBAL_LIMITS));
  for (const tier of ARCHIVE_TRUST_TIERS) {
    assert.ok(Object.isFrozen(ARCHIVE_TRUST_POLICIES[tier]), `${tier} 策略必须冻结`);
  }
  assert.deepEqual(ARCHIVE_GLOBAL_LIMITS, {
    maxCompressionRatio: 50,
    maxFileCount: 100_000,
    maxFileNameLength: 255,
    maxFileSizeBytes: 512 * 1024 * 1024,
    maxPathLength: 1024,
  });
  // strict mode（ESM）下写冻结对象抛 TypeError。
  assert.throws(() => {
    (ARCHIVE_TRUST_POLICIES.store as { nestedArchiveBan: boolean }).nestedArchiveBan = true;
  }, TypeError);
});

test("矩阵旗标：store/local/uploaded/bundled 档位形状与 spec 一致", () => {
  assert.deepEqual(ARCHIVE_TRUST_POLICIES.store, {
    aggregateRatioCap: false,
    entryLengthCaps: true,
    lexicalPathSafety: true,
    nestedArchiveBan: false,
    perEntryRatioCap: false,
    perFileSizeCap: true,
    skipOsMetadata: true,
  });
  assert.deepEqual(ARCHIVE_TRUST_POLICIES.local, {
    aggregateRatioCap: false,
    entryLengthCaps: true,
    lexicalPathSafety: true,
    nestedArchiveBan: false,
    perEntryRatioCap: false,
    perFileSizeCap: false,
    skipOsMetadata: true,
  });
  assert.deepEqual(ARCHIVE_TRUST_POLICIES.uploaded, {
    aggregateRatioCap: true,
    entryLengthCaps: true,
    lexicalPathSafety: true,
    nestedArchiveBan: true,
    perEntryRatioCap: true,
    perFileSizeCap: true,
    skipOsMetadata: true,
  });
  assert.deepEqual(ARCHIVE_TRUST_POLICIES.bundled, {
    aggregateRatioCap: false,
    entryLengthCaps: false,
    lexicalPathSafety: true,
    nestedArchiveBan: false,
    perEntryRatioCap: false,
    perFileSizeCap: false,
    skipOsMetadata: true,
  });
  assert.equal(ARCHIVE_OWNER_EXECUTABLE_FILE_MODE, 0o700);
});

test("OS 垃圾条目表：命中即跳过，正常条目不误伤", () => {
  for (const junk of [
    ".DS_Store",
    "dir/.DS_Store",
    "__MACOSX",
    "__MACOSX/dir/._x",
    "._resource",
    "Thumbs.db",
    "dir/ehthumbs.db",
    "desktop.ini",
    "icon\r",
  ]) {
    assert.equal(isOsMetadataArchiveEntry(junk), true, `应判垃圾: ${JSON.stringify(junk)}`);
  }
  for (const legit of ["readme.md", "dir/.hidden-config", "container.zip", "icon.png"]) {
    assert.equal(isOsMetadataArchiveEntry(legit), false, `不应误伤: ${legit}`);
  }
});

test("Windows 归一化碰撞键：反斜杠/尾点尾空格/大小写全部折叠", () => {
  assert.equal(normalizeArchiveEntryNameForCollision("Dir\\File.TXT"), "dir/file.txt");
  assert.equal(normalizeArchiveEntryNameForCollision("a./b "), "a/b");
  assert.equal(normalizeArchiveEntryNameForCollision("A.txt"), "a.txt");
  assert.equal(normalizeArchiveEntryNameForCollision("dir//x"), "dir/x");
});

test("会话：垃圾条目跳过且不计配额；配额/单文件/总量按档位与 override 拒绝", () => {
  // 垃圾跳过不计配额。
  const junk = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  assert.equal(
    junk.planEntry(fileEntry(".DS_Store", { uncompressedSize: 10_000 })).action,
    "skip",
  );
  assert.equal(junk.countedEntryCount, 0, "垃圾条目不计配额");

  // 条目数上限：被拒条目也计入配额（上游语义——fileCount 先自增后检查）。
  const countSession = new ArchiveExtractionSession({
    limits: { maxFileCount: 2 },
    rootDir: root,
    tier: "store",
  });
  assert.equal(countSession.planEntry(fileEntry("a.txt")).action, "file");
  assert.equal(countSession.planEntry(fileEntry("b.txt")).action, "file");
  assert.throws(
    () => countSession.planEntry(fileEntry("c.txt")),
    (error: unknown) => violationReason(error) === "too_many_files",
  );

  // 单文件上限（override 500）。
  const sizeSession = new ArchiveExtractionSession({
    limits: { maxFileSizeBytes: 500 },
    rootDir: root,
    tier: "store",
  });
  assert.equal(sizeSession.planEntry(fileEntry("ok.txt", { uncompressedSize: 500 })).action, "file");
  assert.throws(
    () => sizeSession.planEntry(fileEntry("big.txt", { uncompressedSize: 501 })),
    (error: unknown) => violationReason(error) === "file_too_large",
  );

  // 总量上限（400+450=850 ok，再 +100 → 950 > 900）。
  const totalSession = new ArchiveExtractionSession({
    limits: { maxTotalUncompressedBytes: 900 },
    rootDir: root,
    tier: "store",
  });
  totalSession.planEntry(fileEntry("a.txt", { uncompressedSize: 400 }));
  totalSession.planEntry(fileEntry("b.txt", { uncompressedSize: 450 }));
  assert.throws(
    () => totalSession.planEntry(fileEntry("c.txt", { uncompressedSize: 100 })),
    (error: unknown) => violationReason(error) === "total_too_large",
  );
});

test("会话：词法安全（../反斜杠/盘符/NUL/win32 段规则）按 unsafe_path 拒绝", () => {
  const session = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  for (const name of ["../escape.txt", "a/../../b", "dir\\file.txt", "C:/abs.txt", "/abs.txt", "a\0b", "a//b", "./dot/x"]) {
    assert.throws(
      () => session.planEntry(fileEntry(name)),
      (error: unknown) => violationReason(error) === "unsafe_path",
      `应拒绝: ${JSON.stringify(name)}`,
    );
  }
  const windowsSession = new ArchiveExtractionSession({ rootDir: root, tier: "store", windowsRules: true });
  for (const name of ["dir/con", "dir/NUL.txt", "com¹/x", "trail./x", "ads/a:b"]) {
    assert.throws(
      () => windowsSession.planEntry(fileEntry(name)),
      (error: unknown) => violationReason(error) === "unsafe_path",
      `windows 规则应拒绝: ${JSON.stringify(name)}`,
    );
  }
  const posixSession = new ArchiveExtractionSession({ rootDir: root, tier: "store", windowsRules: false });
  assert.equal(posixSession.planEntry(fileEntry("dir/con")).action, "file", "POSIX 上 con 是合法名");
});

test("会话：聚合比率与逐条目比率（zip bomb 早拒，按档位生效）", () => {
  // uploaded 档比率闸全开。
  const session = new ArchiveExtractionSession({
    compressedSizeBytes: 100,
    rootDir: root,
    tier: "uploaded",
  });
  // 聚合：5001/100 > 50 → 拒绝（先于逐条目判定）。
  assert.throws(
    () => session.planEntry(fileEntry("bomb.bin", { compressedSize: 10, uncompressedSize: 5001 })),
    (error: unknown) => violationReason(error) === "aggregate_ratio",
  );

  // 逐条目：聚合不超（compressedSizeBytes 大），单条目比率超。
  const perEntry = new ArchiveExtractionSession({
    compressedSizeBytes: 1_000_000,
    rootDir: root,
    tier: "uploaded",
  });
  assert.throws(
    () => perEntry.planEntry(fileEntry("bomb2.bin", { compressedSize: 10, uncompressedSize: 5001 })),
    (error: unknown) => violationReason(error) === "entry_ratio",
  );

  // store/local 档比率闸关闭（真实市场/同步归档高压缩比形态不误杀，见 spec R3）：
  // 同形态放行，炸弹损害由单文件/总量/条目数三重声明闸封顶。
  for (const tier of ["store", "local"] as const) {
    const relaxed = new ArchiveExtractionSession({
      compressedSizeBytes: 100,
      rootDir: root,
      tier,
    });
    assert.equal(
      relaxed.planEntry(fileEntry("text.md", { compressedSize: 10, uncompressedSize: 5001 }))
        .action,
      "file",
      `${tier} 档不应误杀高压缩比条目`,
    );
  }
});

test("会话：长度上限与嵌套归档禁令按档位生效", () => {
  const store = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  assert.throws(
    () => store.planEntry(fileEntry(`${"d/".repeat(600)}x.txt`)),
    (error: unknown) => violationReason(error) === "entry_too_long",
  );
  assert.throws(
    () => store.planEntry(fileEntry(`${"n".repeat(256)}.txt`)),
    (error: unknown) => violationReason(error) === "filename_too_long",
  );
  // store 档不禁嵌套（保留既有行为）。
  assert.equal(store.planEntry(fileEntry("inner.zip")).action, "file");

  const uploaded = new ArchiveExtractionSession({ rootDir: root, tier: "uploaded" });
  for (const name of ["inner.zip", "inner.TAR", "deep/nested.tgz", "x.tar.gz"]) {
    assert.throws(
      () => uploaded.planEntry(fileEntry(name)),
      (error: unknown) => violationReason(error) === "nested_archive",
      `uploaded 档应拒嵌套: ${name}`,
    );
  }
  // 目录条目豁免嵌套禁令。
  assert.equal(
    uploaded.planEntry({ compressedSize: 0, isDirectory: true, name: "assets.zip/", uncompressedSize: 0 }).action,
    "directory",
  );
});

test("会话：归一化碰撞预检（大小写/尾点变体/冒号），完全同名后者替换前者", () => {
  // 碰撞预检是平台无关层：显式关 Windows 段规则，隔离 win32 词法闸的先行拒绝
  // （win32 上 "b./c"、含 ":" 名会先命中 unsafe_path，该路径由上一用例守护）。
  const session = new ArchiveExtractionSession({ rootDir: root, tier: "store", windowsRules: false });
  session.planEntry(fileEntry("dir/A.txt"));
  assert.throws(
    () => session.planEntry(fileEntry("dir/a.txt")),
    (error: unknown) => violationReason(error) === "name_collision",
  );

  const trailing = new ArchiveExtractionSession({ rootDir: root, tier: "store", windowsRules: false });
  trailing.planEntry(fileEntry("b./c"));
  assert.throws(
    () => trailing.planEntry(fileEntry("b/c")),
    (error: unknown) => violationReason(error) === "name_collision",
  );

  const colon = new ArchiveExtractionSession({ rootDir: root, tier: "store", windowsRules: false });
  assert.throws(
    () => colon.planEntry(fileEntry("ads/stream:x")),
    (error: unknown) => violationReason(error) === "name_collision",
  );

  // 完全同名重复条目：不拒，配额照计，计划按后者替换（保留首插入顺序）。
  const dup = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  dup.planEntry(fileEntry("dup.txt", { unixMode: 0o100644, uncompressedSize: 1 }));
  dup.planEntry(fileEntry("dup.txt", { unixMode: 0o100755, uncompressedSize: 2 }));
  assert.equal(dup.countedEntryCount, 2);
  assert.equal(dup.plannedFiles.length, 1);
  assert.equal(dup.plannedFiles[0]?.restoreOwnerExecutable, true);
  assert.equal(dup.totalPlannedUncompressedBytes, 3);
});

test("会话：文件/目录冲突（含祖先展开）与 containment 目标解析", () => {
  const session = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  const filePlan = session.planEntry(fileEntry("pkg/dir/leaf.md"));
  assert.equal(filePlan.action, "file");
  assert.equal(
    (filePlan as { targetPath: string }).targetPath,
    join(root, "pkg", "dir", "leaf.md"),
  );
  // 祖先已登记为文件（"pkg/dir" 是 leaf.md 的祖先目录，同时被文件条目占位）→ 冲突。
  assert.throws(
    () => session.planEntry(fileEntry("pkg/dir")),
    (error: unknown) => violationReason(error) === "file_dir_conflict",
  );

  // 文件 "x" 已占位，再规划 "x/y"：祖先 x 是文件 → 冲突。
  const fileThenChild = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  fileThenChild.planEntry(fileEntry("x"));
  assert.throws(
    () => fileThenChild.planEntry(fileEntry("x/y")),
    (error: unknown) => violationReason(error) === "file_dir_conflict",
  );

  // 目录 "d/" 与文件 "d" 归一化后同名：碰撞预检先于冲突检测拒绝（上游 I() 先于 Mt()）。
  const dirFirst = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  dirFirst.planEntry({ compressedSize: 0, isDirectory: true, name: "d/", uncompressedSize: 0 });
  assert.throws(
    () => dirFirst.planEntry(fileEntry("d")),
    (error: unknown) => violationReason(error) === "name_collision",
  );

  // 文件 "c/d" 之后显式目录 "c/"：c 已是登记祖先目录 → 合法（不冲突）。
  const implicitAncestor = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  implicitAncestor.planEntry(fileEntry("c/d"));
  assert.equal(
    implicitAncestor.planEntry({
      compressedSize: 0,
      isDirectory: true,
      name: "c/",
      uncompressedSize: 0,
    }).action,
    "directory",
  );
});

test("会话：可执行位策略——仅 owner-exec 位触发恢复标记", () => {
  const session = new ArchiveExtractionSession({ rootDir: root, tier: "store" });
  const exec = session.planEntry(fileEntry("bin/run.sh", { unixMode: 0o100755 }));
  assert.equal(exec.action === "file" && exec.restoreOwnerExecutable, true);
  const plain = session.planEntry(fileEntry("doc/readme.md", { unixMode: 0o100644 }));
  assert.equal(plain.action === "file" && plain.restoreOwnerExecutable, false);
  const noMode = session.planEntry(fileEntry("doc/notes.md"));
  assert.equal(noMode.action === "file" && noMode.restoreOwnerExecutable, false);
});
