// 拆分依据：localTarGz.ts 拆出纯格式/路径叶子后，按例外偿还纪律为新叶子补最小单测，
// 覆盖 tar 头校验和、八进制字段往返、路径逃逸拒绝与归档创建→解包往返。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TAR_BLOCK_SIZE,
  TAR_END_BLOCK_BYTES,
  createTarHeader,
  isZeroBlock,
  parseTarOctal,
  readTarEntryPath,
  readTarTypeFlag,
  roundUpToTarBlock,
} from "../src/remote/localTarGzFormat.ts";
import {
  ensureTrailingSlash,
  normalizeCreateEntryPath,
  normalizeExtractEntryPath,
  normalizeExtractSymlinkTarget,
  resolvePathWithinBase,
} from "../src/remote/localTarGzPaths.ts";
import { createTarGzArchive, extractTarGzArchive } from "../src/remote/localTarGz.ts";

test("tar header checksum matches an independent recomputation", () => {
  const header = createTarHeader({
    entryPath: "server/acode-server.cjs",
    mode: 0o755,
    mtimeSeconds: 1_700_000_000,
    size: 1234,
    typeFlag: "0",
  });

  assert.equal(header.length, TAR_BLOCK_SIZE);

  const storedChecksum = Number.parseInt(header.subarray(148, 154).toString("ascii").trim(), 8);
  const recomputed = (() => {
    const probe = Buffer.from(header);
    // 规范校验和：计算时 checksum 字段按空格（0x20）处理。
    probe.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of probe) {
      sum += byte;
    }
    return sum;
  })();
  assert.equal(storedChecksum, recomputed);
});

test("tar header octal fields round-trip through parseTarOctal", () => {
  const header = createTarHeader({
    entryPath: "glm/acode.cjs",
    mode: 0o644,
    mtimeSeconds: 1_700_000_000,
    size: 4096,
    typeFlag: "0",
  });

  assert.equal(parseTarOctal(header, 100, 8), 0o644);
  assert.equal(parseTarOctal(header, 124, 12), 4096);
  assert.equal(parseTarOctal(header, 136, 12), 1_700_000_000);
  assert.equal(readTarTypeFlag(header), "0");
  assert.equal(header.subarray(257, 263).toString("ascii"), "ustar\0");
});

test("tar entry path round-trips including prefix-split long paths", () => {
  const shortPath = "tools/linux-x64/bfs/bfs";
  const shortHeader = createTarHeader({
    entryPath: shortPath,
    mode: 0o755,
    mtimeSeconds: 1,
    size: 0,
    typeFlag: "0",
  });
  assert.equal(readTarEntryPath(shortHeader), shortPath);

  const longPath = `${"very-long-component-dir".repeat(6)}/nested/${"file".repeat(20)}.bin`;
  const longHeader = createTarHeader({
    entryPath: longPath,
    mode: 0o600,
    mtimeSeconds: 2,
    size: 10,
    typeFlag: "0",
  });
  assert.equal(readTarEntryPath(longHeader), longPath);
});

test("tar block helpers align and detect zero blocks", () => {
  assert.equal(TAR_BLOCK_SIZE, 512);
  assert.equal(TAR_END_BLOCK_BYTES, 1024);
  assert.equal(roundUpToTarBlock(0), 0);
  assert.equal(roundUpToTarBlock(1), 512);
  assert.equal(roundUpToTarBlock(512), 512);
  assert.equal(roundUpToTarBlock(513), 1024);
  assert.equal(isZeroBlock(Buffer.alloc(TAR_BLOCK_SIZE)), true);
  assert.equal(isZeroBlock(Buffer.alloc(TAR_BLOCK_SIZE, 1)), false);
});

test("normalizeCreateEntryPath strips ./ and trailing slashes but rejects empties", () => {
  assert.equal(normalizeCreateEntryPath("./server/acode-server.cjs"), "server/acode-server.cjs");
  assert.equal(normalizeCreateEntryPath("server/"), "server");
  assert.throws(() => normalizeCreateEntryPath(""), /must not be empty/u);
  assert.throws(() => normalizeCreateEntryPath("./"), /must not be empty/u);
});

test("normalizeExtractEntryPath rejects absolute, backslash and escaping paths", () => {
  assert.equal(normalizeExtractEntryPath("./server/acode-server.cjs"), "server/acode-server.cjs");
  assert.equal(normalizeExtractEntryPath("server/../glm/acode.cjs"), "glm/acode.cjs");
  assert.equal(normalizeExtractEntryPath("."), null);
  assert.equal(normalizeExtractEntryPath(""), null);

  for (const unsafe of [
    "/etc/passwd",
    "C:/Windows/system32.dll",
    "..\\evil",
    "../escape",
    "a/../../escape",
    "..",
  ]) {
    assert.throws(() => normalizeExtractEntryPath(unsafe), /unsafe tar entry path/u, unsafe);
  }
});

test("resolvePathWithinBase keeps targets inside and rejects escapes", () => {
  const baseDir = join(tmpdir(), "acode-tar-test-base");
  assert.equal(resolvePathWithinBase(baseDir, "server/acode.cjs"), join(baseDir, "server", "acode.cjs"));
  assert.throws(() => resolvePathWithinBase(baseDir, "../escape"), /unsafe tar entry path/u);
});

test("normalizeExtractSymlinkTarget rejects links escaping the extraction root", () => {
  const targetRoot = join(tmpdir(), "acode-tar-test-root");
  const targetPath = join(targetRoot, "server", "link");

  assert.equal(
    normalizeExtractSymlinkTarget({
      rawLinkTarget: "./acode.cjs",
      targetPath,
      targetRoot,
    }),
    "acode.cjs",
  );
  assert.throws(
    () =>
      normalizeExtractSymlinkTarget({
        rawLinkTarget: "../../outside",
        targetPath,
        targetRoot,
      }),
    /unsafe tar symlink target/u,
  );
  assert.throws(
    () =>
      normalizeExtractSymlinkTarget({
        rawLinkTarget: "C:\\outside",
        targetPath,
        targetRoot,
      }),
    /unsafe tar symlink target/u,
  );
});

test("ensureTrailingSlash only appends when missing", () => {
  assert.equal(ensureTrailingSlash("server"), "server/");
  assert.equal(ensureTrailingSlash("server/"), "server/");
});

test("createTarGzArchive and extractTarGzArchive round-trip files and directories", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "acode-tar-roundtrip-"));
  try {
    const sourceDir = join(workDir, "source");
    const nestedDir = join(sourceDir, "server", "packages");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(sourceDir, "server", "acode-server.cjs"), "console.log('server');\n");
    await writeFile(join(nestedDir, "plugin.json"), '{"name":"demo"}\n');
    await writeFile(join(sourceDir, "root.txt"), "root");

    const archivePath = join(workDir, "archive.tar.gz");
    await createTarGzArchive(archivePath, [
      { sourcePath: join(sourceDir, "server"), archivePath: "server" },
      { sourcePath: join(sourceDir, "root.txt"), archivePath: "root.txt" },
    ]);

    const extractDir = join(workDir, "extract");
    await extractTarGzArchive(archivePath, extractDir);

    assert.equal(
      await readFile(join(extractDir, "server", "acode-server.cjs"), "utf8"),
      "console.log('server');\n",
    );
    assert.equal(
      await readFile(join(extractDir, "server", "packages", "plugin.json"), "utf8"),
      '{"name":"demo"}\n',
    );
    assert.equal(await readFile(join(extractDir, "root.txt"), "utf8"), "root");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("createTarGzArchive preserves a real symlink but extract refuses escaping links", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "acode-tar-symlink-"));
  try {
    const sourceDir = join(workDir, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "target.txt"), "target");

    // Windows 无管理员/开发者模式时创建 symlink 会 EPERM；此时跳过 symlink 往返，
    // 但保留恶意条目解包拒绝断言（不依赖本机建链能力）。
    let symlinkCreated = true;
    try {
      await symlink("target.txt", join(sourceDir, "link.txt"));
    } catch {
      symlinkCreated = false;
    }

    const archivePath = join(workDir, "archive.tar.gz");
    await createTarGzArchive(archivePath, [
      { sourcePath: join(sourceDir, "target.txt"), archivePath: "target.txt" },
      ...(symlinkCreated
        ? [{ sourcePath: join(sourceDir, "link.txt"), archivePath: "link.txt" }]
        : []),
    ]);

    const extractDir = join(workDir, "extract");
    await extractTarGzArchive(archivePath, extractDir);
    assert.equal(await readFile(join(extractDir, "target.txt"), "utf8"), "target");
    if (symlinkCreated) {
      assert.equal(await readFile(join(extractDir, "link.txt"), "utf8"), "target");
    }

    // 解包器必须拒绝路径逃逸条目：构造一个带 ../ 条目的归档并断言失败。
    const maliciousArchive = join(workDir, "malicious.tar.gz");
    const { gzipSync } = await import("node:zlib");
    const maliciousHeader = createTarHeader({
      entryPath: "../escaped.txt",
      mode: 0o644,
      mtimeSeconds: 1,
      size: 3,
      typeFlag: "0",
    });
    const payload = Buffer.concat([
      maliciousHeader,
      Buffer.from("bad"),
      Buffer.alloc(TAR_BLOCK_SIZE - 3),
      Buffer.alloc(TAR_END_BLOCK_BYTES),
    ]);
    await writeFile(maliciousArchive, gzipSync(payload));

    const maliciousExtractDir = join(workDir, "malicious-extract");
    await assert.rejects(extractTarGzArchive(maliciousArchive, maliciousExtractDir), /unsafe/u);
    assert.equal(
      await readFile(join(workDir, "escaped.txt"), "utf8").catch(() => null),
      null,
      "malicious entry must not escape the extraction root",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
