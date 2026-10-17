// 文件遏制层 · 身份打开面（五层防线中的第②③④⑤层）。
//
// Node 没有 openat2(RESOLVE_BENEATH)，"beneath 打开"用等价组合实现：
//   ② 逐目录段 lstat，链上任一符号链接/非目录即拒；
//   ③ 打开身份复核：O_NOFOLLOW（平台可用时）+ open 后 fstat 比对 dev/ino 与打开前
//      lstat，ino==0 平台二次按名 lstat 比对；dev/ino 不一致仅在 stat 通道 skew
//      探针（statSkewProbe.ts）实测吻合时容忍；
//   ④ fstat 拒 nlink>1 硬链接、非常规文件；O_TRUNC 拆「先验证后 ftruncate(0)」；
//   ⑤ fail-closed：身份复核不可用时拒绝降级为纯路径 open（错误文案明说）。
// 词法层与封闭错误词表在 fileContainmentLexical.ts（第①层）。
// 规格：packages/services/specs/file-containment-trust-tiers.md R1/R5。
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  FileContainmentError,
  resolveContainedPath,
  type RelativePathLexicalOptions,
} from "./fileContainmentLexical.js";
import {
  describeStatChannelSkew,
  getStatChannelSkew,
  type StatChannelSkewResult,
} from "./statSkewProbe.js";

/**
 * 锚根校验：根自身允许是符号链接（调用方钉住的路径可能经系统别名，如 macOS
 * /var → /private/var），但必须可 stat 且为目录；否则 root 拒绝。
 */
async function assertContainmentRoot(rootDir: string): Promise<void> {
  let stats;
  try {
    stats = await stat(rootDir);
  } catch (error) {
    throw new FileContainmentError("root", `containment root is not accessible: ${rootDir}`, {
      path: rootDir,
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw new FileContainmentError("root", `containment root is not a directory: ${rootDir}`, {
      path: rootDir,
    });
  }
}

/** 第②层：逐目录段 lstat，链上任一符号链接/非目录即拒（lstat 失败原样透传）。 */
export async function assertContainedDirectoryChain(
  rootDir: string,
  directorySegments: readonly string[],
): Promise<void> {
  let current = resolve(rootDir);
  for (const segment of directorySegments) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FileContainmentError(
        "symlink",
        `refusing to traverse a symlinked or non-directory segment under containment root: ${current}`,
        { path: current },
      );
    }
  }
}

/** 打开前后身份完全一致判定（nlink/size/birthtimeNs/mtimeNs/ctimeNs）。 */
function isSameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * dev/ino 不一致的容忍判定：仅当 skew 探针在该目录**实测** skew、dev 走向与
 * inoDelta 与实测吻合、且按名二次 lstat 与打开前身份完全一致时才容忍。
 * 同设备 dev 下的 ino 变化是真实换文件，任何 skew 都不能解释 → 不容忍。
 */
async function isIdentityMismatchTolerated(
  fullPath: string,
  before: BigIntStats,
  after: BigIntStats,
): Promise<{ tolerated: boolean; probe: StatChannelSkewResult | null }> {
  if (before.dev === after.dev || before.isSymbolicLink() || !before.isFile()) {
    return { tolerated: false, probe: null };
  }
  if (!isSameIdentity(before, after)) {
    return { tolerated: false, probe: null };
  }
  const probe = await getStatChannelSkew(dirname(fullPath));
  if (
    probe.kind !== "skew" ||
    before.ino === 0n ||
    after.ino === 0n ||
    before.dev !== BigInt(probe.byNameDev ?? "-1") ||
    after.dev !== BigInt(probe.byHandleDev ?? "-1") ||
    probe.inoDelta == null ||
    after.ino - before.ino !== BigInt(probe.inoDelta)
  ) {
    return { tolerated: false, probe };
  }
  const recheck = await lstat(fullPath, { bigint: true }).catch(() => null);
  const tolerated =
    recheck !== null &&
    !recheck.isSymbolicLink() &&
    recheck.isFile() &&
    recheck.dev === before.dev &&
    recheck.ino === before.ino &&
    isSameIdentity(recheck, before);
  return { tolerated, probe };
}

function identityRejection(
  fullPath: string,
  probe: StatChannelSkewResult | null,
): FileContainmentError {
  const probeNote =
    probe === null ? "" : ` (stat-channel probe: ${describeStatChannelSkew(probe)})`;
  // fail-closed 纪律：身份复核失败绝不降级为纯路径 open/readFile。
  return new FileContainmentError(
    "symlink",
    `file identity changed between pre-open lstat and open at ${fullPath}; refusing to fall back to an unverified path-based open${probeNote}`,
    { path: fullPath },
  );
}

export interface SafeOpenFileOptions extends RelativePathLexicalOptions {
  /** fstat 后的体积上限，超限 → size 拒绝（在读取/截断之前）。 */
  maxSizeBytes?: number;
  /** 显式放行 nlink>1（默认拒绝硬链接别名）。 */
  allowMultiLink?: boolean;
  /** O_TRUNC 的替代语义：全部验证通过后才 ftruncate(0)。 */
  truncateAfterVerify?: boolean;
}

/**
 * 第③④层：按绝对路径做"安全打开"（无锚根词法面，供遏制打开与 TOCTOU 复核共用）。
 * lstat 拒 reparse → open(O_RDONLY|O_NOFOLLOW?) → fstat 身份复核（含 ino==0 平台
 * 二次 lstat 与 skew 容忍）→ 常规文件/nlink/size 检查 → 可选验证后截断。
 */
export async function safeOpenFileByPath(
  filePath: string,
  options: SafeOpenFileOptions = {},
): Promise<FileHandle> {
  const loopError = (detail: string): FileContainmentError =>
    new FileContainmentError(
      "symlink",
      `refusing to follow a symlink or reparse point at ${filePath} (${detail})`,
      { path: filePath },
    );
  const before = await lstat(filePath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw loopError("pre-open lstat saw a symbolic link");
  }
  // O_TRUNC 拆解语义需要可写句柄：验证全部通过后才 ftruncate(0)，
  // 只读场景保持 O_RDONLY（最小权限）。
  const accessFlag = options.truncateAfterVerify
    ? (fsConstants.O_RDWR ?? 0)
    : (fsConstants.O_RDONLY ?? 0);
  const handle = await open(
    filePath,
    accessFlag | (fsConstants.O_NOFOLLOW ?? 0),
  ).catch((error: unknown) => {
    // Linux 上 O_NOFOLLOW 命中符号链接竞态时以 ELOOP 失败：归一为 symlink 拒绝。
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ELOOP") throw loopError("open failed with ELOOP");
    throw error;
  });
  let verified = false;
  try {
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || (before.ino !== 0n && after.ino !== before.ino)) {
      const { tolerated, probe } = await isIdentityMismatchTolerated(filePath, before, after);
      if (!tolerated) {
        throw identityRejection(filePath, probe);
      }
    }
    if (before.ino === 0n) {
      // ino 不可用平台（部分 Windows 卷/网络盘）：二次按名 lstat 比对退化身份字段。
      const recheck = await lstat(filePath, { bigint: true }).catch(() => null);
      if (
        recheck === null ||
        recheck.isSymbolicLink() ||
        !recheck.isFile() ||
        recheck.dev !== before.dev ||
        recheck.size !== after.size ||
        recheck.mtimeNs !== after.mtimeNs
      ) {
        throw identityRejection(filePath, null);
      }
    }
    if (!after.isFile()) {
      throw new FileContainmentError("not_regular", `not a regular file: ${filePath}`, {
        path: filePath,
        isDirectory: after.isDirectory(),
      });
    }
    if (!options.allowMultiLink && after.nlink > 1n) {
      throw new FileContainmentError(
        "multilink",
        `refusing a multi-link inode (nlink=${after.nlink}) under containment: ${filePath}`,
        { path: filePath },
      );
    }
    if (options.maxSizeBytes !== undefined && after.size > BigInt(options.maxSizeBytes)) {
      throw new FileContainmentError(
        "size",
        `file exceeds the containment size limit (${after.size} > ${options.maxSizeBytes} bytes): ${filePath}`,
        { path: filePath },
      );
    }
    if (options.truncateAfterVerify) {
      await handle.truncate(0);
    }
    verified = true;
    return handle;
  } finally {
    if (!verified) {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * 五层全量遏制打开：根校验 + 词法 + 逐段 lstat + 身份打开。
 * 返回的句柄已通过全部身份复核，读取必须经该句柄（不再按名二次打开）。
 */
export async function openContainedFile(
  rootDir: string,
  relativePath: string,
  options: SafeOpenFileOptions = {},
): Promise<FileHandle> {
  await assertContainmentRoot(rootDir);
  const resolution = resolveContainedPath(rootDir, relativePath, options);
  if (resolution.leaf === undefined) {
    throw new FileContainmentError(
      "escape",
      `cannot open the containment root itself as a file: ${JSON.stringify(relativePath)}`,
      { path: relativePath },
    );
  }
  await assertContainedDirectoryChain(rootDir, resolution.directorySegments);
  return await safeOpenFileByPath(resolution.fullPath, options);
}

/** 便捷读取面：五层打开后经同一已验证句柄读全量字节（读后再校验一次体积上限）。 */
export async function readContainedFileBytes(
  rootDir: string,
  relativePath: string,
  options: SafeOpenFileOptions = {},
): Promise<Uint8Array> {
  const handle = await openContainedFile(rootDir, relativePath, options);
  try {
    const bytes = new Uint8Array(await readFile(handle));
    if (options.maxSizeBytes !== undefined && bytes.byteLength > options.maxSizeBytes) {
      throw new FileContainmentError(
        "size",
        `file grew past the containment size limit while reading (${bytes.byteLength} > ${options.maxSizeBytes} bytes): ${relativePath}`,
        { path: relativePath },
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 校验→解包 TOCTOU 复核用的身份快照（字符串化 bigint，可跨 RPC 序列化）。 */
export interface FileIdentitySnapshot {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
}

export function captureFileIdentitySnapshot(stats: BigIntStats): FileIdentitySnapshot {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

/**
 * 归档"先校验后解包"的 TOCTOU 复核：按快照重开文件（走安全打开全流程），fstat
 * 四元组（dev/ino/size/mtimeNs）与快照不符即拒；相符返回**已验证句柄**，
 * 解包流必须从该同一 fd 读取，杜绝按名二次打开的换包窗口。
 */
export async function revalidateFileIdentityForExtraction(
  filePath: string,
  expected: FileIdentitySnapshot,
  options: SafeOpenFileOptions = {},
): Promise<FileHandle> {
  const handle = await safeOpenFileByPath(filePath, options);
  try {
    const stats = await handle.stat({ bigint: true });
    const actual = captureFileIdentitySnapshot(stats);
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs
    ) {
      throw new FileContainmentError(
        "symlink",
        `archive changed between validation and extraction (identity snapshot mismatch): ${filePath}`,
        { path: filePath },
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
