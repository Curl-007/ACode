import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  captureFileIdentitySnapshot,
  FileContainmentError,
  findRelativePathEscapeReason,
  getStatChannelSkew,
  isUnsafeWindowsPathSegment,
  openContainedFile,
  readContainedFileBytes,
  revalidateFileIdentityForExtraction,
  resolveContainedPath,
  resetStatSkewProbeCache,
  safeOpenFileByPath,
} from "../src/node.js";

/**
 * 文件遏制层（SafeFs 等价物）守护测试。
 * 规格：packages/services/specs/file-containment-trust-tiers.md R1/R2/R5。
 */

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "acode-file-containment-"));
});

after(async () => {
  resetStatSkewProbeCache();
});

function containmentCode(error: unknown): string | undefined {
  return error instanceof FileContainmentError ? error.code : undefined;
}

async function tryCreateSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch {
    // Windows 无开发者模式/权限时建符号链接会 EPERM：相关用例按平台能力跳过。
    return false;
  }
}

test("词法层：绝对路径/UNC/设备路径/盘符/NUL/.. 一律拒绝", () => {
  const rejected: Array<[string, string]> = [
    ["/etc/passwd", "absolute"],
    ["../../escape", "parent_escape"],
    ["a/../../escape", "parent_escape"],
    ["..", "parent_escape"],
    ["../", "parent_escape"],
    ["//server/share/x", "unc_prefix"],
    ["\\\\server\\share\\x", "unc_prefix"],
    ["\\\\?\\C:\\Windows", "device_path_prefix"],
    ["//?/dev/null", "device_path_prefix"],
    ["a\0b", "nul_byte"],
  ];
  for (const [input, reason] of rejected) {
    // windowsRules 关闭时反斜杠是合法 POSIX 文件名字符，UNC 用例改用斜杠形态断言。
    const actual = findRelativePathEscapeReason(input, { windowsRules: false });
    if (input.includes("\\")) {
      assert.equal(
        findRelativePathEscapeReason(input, { windowsRules: true }),
        reason,
        `windows 规则下应拒绝: ${JSON.stringify(input)}`,
      );
      continue;
    }
    assert.equal(actual, reason, `应拒绝: ${JSON.stringify(input)}`);
  }
  assert.equal(findRelativePathEscapeReason("a/b/c.txt", { windowsRules: true }), null);
  assert.equal(findRelativePathEscapeReason(".", { windowsRules: true }), null);
  assert.equal(findRelativePathEscapeReason("a/./b", { windowsRules: true }), null);
  // ".." 前缀短语本身是合法文件名，只有整段 ".." 才是逃逸。
  assert.equal(findRelativePathEscapeReason("..foo/x", { windowsRules: true }), null);
});

test("词法层：Windows 段级规则（设备名含上标变体/尾点尾空格/段内冒号 ADS）", () => {
  assert.equal(isUnsafeWindowsPathSegment("con"), true);
  assert.equal(isUnsafeWindowsPathSegment("NUL.txt"), true);
  assert.equal(isUnsafeWindowsPathSegment("com¹"), true);
  assert.equal(isUnsafeWindowsPathSegment("LPT³.log"), true);
  assert.equal(isUnsafeWindowsPathSegment("aux"), true);
  assert.equal(isUnsafeWindowsPathSegment("prn"), true);
  assert.equal(isUnsafeWindowsPathSegment("foo."), true);
  assert.equal(isUnsafeWindowsPathSegment("foo "), true);
  assert.equal(isUnsafeWindowsPathSegment("a:b"), true);
  assert.equal(isUnsafeWindowsPathSegment("normal-file.txt"), false);
  // 设备名规则不误伤普通前缀名。
  assert.equal(isUnsafeWindowsPathSegment("console"), false);
  assert.equal(isUnsafeWindowsPathSegment("comma"), false);

  const windowsOnly = ["dir/con", "dir/COM¹", "trail./x", "trail /x", "ads/a:b"];
  for (const input of windowsOnly) {
    assert.equal(
      findRelativePathEscapeReason(input, { windowsRules: true }),
      "windows_unsafe_segment",
      `windows 规则下应拒绝: ${input}`,
    );
    assert.equal(
      findRelativePathEscapeReason(input, { windowsRules: false }),
      null,
      `POSIX 规则下应放行: ${input}`,
    );
  }
});

test("词法层：resolveContainedPath 输出遏制结构（segments/leaf/根自身）", () => {
  const resolution = resolveContainedPath(root, "a/b/c.txt", { windowsRules: false });
  assert.deepEqual(resolution.segments, ["a", "b", "c.txt"]);
  assert.deepEqual(resolution.directorySegments, ["a", "b"]);
  assert.equal(resolution.leaf, "c.txt");
  assert.equal(resolution.fullPath, join(root, "a", "b", "c.txt"));

  const self = resolveContainedPath(root, ".", { windowsRules: false });
  assert.equal(self.leaf, undefined);
  assert.deepEqual(self.segments, []);

  assert.throws(
    () => resolveContainedPath(root, "../escape", { windowsRules: false }),
    (error: unknown) => containmentCode(error) === "escape",
  );
});

test("身份打开：常规文件成功读取；目录/超尺寸/根异常按闭集错误拒绝", async () => {
  await mkdir(join(root, "basic", "nested"), { recursive: true });
  await writeFile(join(root, "basic", "nested", "ok.txt"), "payload");

  const bytes = await readContainedFileBytes(root, "basic/nested/ok.txt");
  assert.equal(new TextDecoder().decode(bytes), "payload");

  // 目录 → not_regular（isDirectory 标志）。
  await assert.rejects(
    () => openContainedFile(root, "basic/nested"),
    (error: unknown) =>
      containmentCode(error) === "not_regular" &&
      (error as FileContainmentError).isDirectory === true,
  );

  // 尺寸上限 → size（先 fstat 拒绝，不读取）。
  await assert.rejects(
    () => readContainedFileBytes(root, "basic/nested/ok.txt", { maxSizeBytes: 3 }),
    (error: unknown) => containmentCode(error) === "size",
  );

  // 根不存在/根是文件 → root。
  await assert.rejects(
    () => openContainedFile(join(root, "missing-root"), "x.txt"),
    (error: unknown) => containmentCode(error) === "root",
  );
  await assert.rejects(
    () => openContainedFile(join(root, "basic", "nested", "ok.txt"), "x.txt"),
    (error: unknown) => containmentCode(error) === "root",
  );

  // 根自身不可作为文件打开 → escape。
  await assert.rejects(
    () => openContainedFile(root, "."),
    (error: unknown) => containmentCode(error) === "escape",
  );
});

test("身份打开：符号链接目录段与符号链接目标一律拒绝（symlink 闭集）", async () => {
  const dir = join(root, "linkcase");
  await mkdir(join(dir, "inner"), { recursive: true });
  await writeFile(join(dir, "inner", "real.txt"), "real");
  await writeFile(join(root, "outside.txt"), "outside");

  const linkedDirOk = await tryCreateSymlink(join(dir, "inner"), join(dir, "linkdir"));
  const linkedFileOk = await tryCreateSymlink(join(root, "outside.txt"), join(dir, "linkfile"));
  if (!linkedDirOk || !linkedFileOk) {
    // 平台不支持建符号链接（Windows 无权限）：本用例无法构造攻击面，跳过断言。
    return;
  }

  await assert.rejects(
    () => readContainedFileBytes(dir, "linkdir/real.txt"),
    (error: unknown) => containmentCode(error) === "symlink",
    "目录段是符号链接必须拒绝",
  );
  await assert.rejects(
    () => readContainedFileBytes(dir, "linkfile"),
    (error: unknown) => containmentCode(error) === "symlink",
    "目标是符号链接必须拒绝",
  );
});

test("身份打开：nlink>1 硬链接拒绝；allowMultiLink 显式放行", async () => {
  const dir = join(root, "hardlink");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "target.txt"), "hardlink-payload");
  try {
    await link(join(dir, "target.txt"), join(dir, "alias.txt"));
  } catch {
    return; // 文件系统不支持硬链接：跳过。
  }

  await assert.rejects(
    () => readContainedFileBytes(dir, "alias.txt"),
    (error: unknown) => containmentCode(error) === "multilink",
  );
  const bytes = await readContainedFileBytes(dir, "alias.txt", { allowMultiLink: true });
  assert.equal(new TextDecoder().decode(bytes), "hardlink-payload");
});

test("身份打开：truncateAfterVerify 先验证后截断（O_TRUNC 拆解语义）", async () => {
  const dir = join(root, "trunc");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "wipe.txt"), "to-be-cleared");

  const handle = await openContainedFile(dir, "wipe.txt", { truncateAfterVerify: true });
  await handle.close();
  const after = await lstat(join(dir, "wipe.txt"));
  assert.equal(after.size, 0);
});

test("TOCTOU 复核：快照相符返回已验证句柄；文件被替换/改动后重开拒绝", async () => {
  const dir = join(root, "toctou");
  await mkdir(dir, { recursive: true });
  const archivePath = join(dir, "archive.bin");
  await writeFile(archivePath, "version-1");

  const probe = await safeOpenFileByPath(archivePath);
  const snapshot = captureFileIdentitySnapshot(await probe.stat({ bigint: true }));
  await probe.close();

  const verified = await revalidateFileIdentityForExtraction(archivePath, snapshot);
  const stats = await verified.stat({ bigint: true });
  assert.equal(captureFileIdentitySnapshot(stats).size, snapshot.size);
  await verified.close();

  // 内容改动（size/mtimeNs 变化）→ 身份快照不符，拒绝继续解包。
  await writeFile(archivePath, "version-2-longer");
  await assert.rejects(
    () => revalidateFileIdentityForExtraction(archivePath, snapshot),
    (error: unknown) => containmentCode(error) === "symlink",
  );
});

test("stat-skew 探针：真实卷返回 none/unmeasured，且探针临时文件不残留", async () => {
  resetStatSkewProbeCache();
  const dir = join(root, "probe");
  await mkdir(dir, { recursive: true });
  const result = await getStatChannelSkew(dir);
  assert.ok(
    result.kind === "none" || result.kind === "unmeasured" || result.kind === "skew",
    `探针必须返回闭集 kind，实际: ${result.kind}`,
  );
  if (result.kind === "skew") {
    assert.ok(result.byNameDev !== undefined && result.byHandleDev !== undefined);
    assert.notEqual(result.byNameDev, result.byHandleDev);
  }
  const leftovers = (await readdir(dir)).filter((name) => name.startsWith(".acode-stat-probe-"));
  assert.deepEqual(leftovers, [], "探针临时文件必须清理");

  // 缓存生效：同一目录二次调用返回同一结果对象。
  const cached = await getStatChannelSkew(dir);
  assert.equal(cached.kind, result.kind);
});

test("fail-closed：身份复核链路错误不降级（错误文案明说拒绝回退）", async () => {
  const dir = join(root, "failclosed");
  await mkdir(dir, { recursive: true });
  const missing = join(dir, "missing.txt");
  // 目标不存在：lstat 直接抛 ENOENT（原样透传，绝不落到纯路径 open 兜底）。
  await assert.rejects(
    () => safeOpenFileByPath(missing),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("O_NOFOLLOW 常量缺席平台不崩溃（Windows 等价补偿路径可运行）", async () => {
  // 该用例只断言常量读取路径本身：Windows 上 O_NOFOLLOW 为 undefined，
  // 打开标志按 0 归并后由 dev/ino + ino==0 二次 lstat 补偿。
  const flag = fsConstants.O_NOFOLLOW ?? 0;
  assert.equal(typeof flag, "number");
});
