import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createShadowIndexError,
  isShadowIndexError,
  refusingToRead,
  SHADOW_INDEX_ERROR_CODE,
  SHADOW_INDEX_MAX_BYTES_DEFAULT,
  toErrorMessage,
  type ShadowIndexError,
} from "./gitShadowIndexErrors.js";
import {
  acquireCopySlot,
  SHADOW_INDEX_COPY_BUDGET_DEFAULT,
  SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT,
} from "./gitShadowIndexSlot.js";

/**
 * shadow git 私有 index 加固管线（specs/shadow-git-index.md）。
 *
 * 机制移植自 Claude Desktop 2.37337 `index.chunk-PMGadqIZ.js:166-336`：
 * DIRC 魔数验签 + symlink/size 拒 + wx 独占复制 + mtime 整秒保留 +
 * 只读 lock 预占 + per-path singleflight + 全局并发预算 + EGITSHADOW stage 闭集。
 *
 * 用户真实 index 是半可信输入：本管线保证"要么拿到校验过的完整私有副本，
 * 要么拿到分类失败结果且目的地无半成品"，任何路径都不写用户仓库。
 *
 * 错误分类在 gitShadowIndexErrors.ts，并发闸门在 gitShadowIndexSlot.ts
 * （单文件 400 行架构上限拆分，对外仍以本文件为唯一入口，见下方 re-export）。
 */

export {
  isShadowIndexStage,
  SHADOW_INDEX_ERROR_CODE,
  SHADOW_INDEX_MAX_BYTES_DEFAULT,
  SHADOW_INDEX_STAGES,
  type ShadowIndexError,
  type ShadowIndexErrorCode,
  type ShadowIndexStage,
} from "./gitShadowIndexErrors.js";
export {
  getShadowIndexPipelineStats,
  SHADOW_INDEX_COPY_BUDGET_DEFAULT,
  SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT,
} from "./gitShadowIndexSlot.js";

/** git index 文件魔数（蓝本 E=Buffer.from("DIRC")，PMGadqIZ.js:167）。 */
const DIRC_MAGIC = Buffer.from("DIRC");
const MIB = 1024 * 1024;
/** 复制流 chunk 大小，蓝本 createReadStream highWaterMark（1<<20）。 */
const COPY_STREAM_HIGH_WATER_MARK = 1 << 20;
const DISPOSE_RM_MAX_RETRIES = 3;
const DISPOSE_RM_RETRY_DELAY_MS = 100;

export type ShadowIndexPrimeResult =
  | { kind: "copied"; bytes: number; mtimeSeconds: number }
  | { kind: "source-missing" }
  | { kind: "rejected"; error: ShadowIndexError };

export interface ShadowIndexHandle {
  /** mkdtemp 出的私有目录；dispose 后失效。 */
  dir: string;
  /** GIT_INDEX_FILE 应指向的路径。prime 非 copied 时该文件不存在（空 index 语义）。 */
  indexFile: string;
  /** 只读形态预占的 lock 路径；writable 形态或未预占时为 null。 */
  lockFile: string | null;
  prime: ShadowIndexPrimeResult;
  /** best-effort 清理私有目录，永不抛错（清理失败不得掩盖主链路错误）。 */
  dispose(): Promise<void>;
}

export interface CreateShadowIndexOptions {
  /** 用户真实 index 绝对路径；null = 无源可复制（返回 source-missing 的空副本）。 */
  sourceIndexPath: string | null;
  /** 私有副本根目录（checkpoint：getGitCheckpointIndexRootDir()）。 */
  rootDir: string;
  dirPrefix?: string;
  /** true = 副本可被 git 写入（跳过只读 lock 预占）；默认 false（蓝本同款只读形态）。 */
  writable?: boolean;
  maxBytes?: number;
  copyBudget?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
  /** 测试/扩展接缝：复制开始前回调（蓝本无参，携带目的地信息是登记偏差 #4）。 */
  beforeCopy?: (dest: { dir: string; indexFile: string }) => Promise<void>;
}

/**
 * 源检查 + fd 锚定校验 + 复制（蓝本 oe() 主体，PMGadqIZ.js:243-330）。
 * 校验阶段失败 → EGITSHADOW（带 stage）；lock/复制/utimes 失败 → EGITINDEXCOPY。
 * fd 锚定：stat/魔数/复制读同一 fd，git lockfile+rename 交换不产生跨读。
 */
async function inspectAndCopy(
  sourceIndexPath: string,
  destIndexFile: string,
  options: { maxBytes: number; writable: boolean },
): Promise<{ prime: ShadowIndexPrimeResult; lockFile: string | null }> {
  let lstats;
  try {
    lstats = await lstat(sourceIndexPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 源不存在是合法状态（刚 init 的空仓 git 不落 index 文件），按空副本降级。
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { prime: { kind: "source-missing" }, lockFile: null };
    }
    if (code === "ELOOP") {
      throw refusingToRead(sourceIndexPath, "it is a link", "real-index");
    }
    throw createShadowIndexError(
      `[git] could not read ${sourceIndexPath}: ${toErrorMessage(error)}`,
      "EGITSHADOW",
      { stage: "private-index", cause: error },
    );
  }
  // lstat 前置层比蓝本 copy 路径更严（登记偏差 #5）：symlink/非常规文件在 open 前拒绝。
  if (lstats.isSymbolicLink()) {
    throw refusingToRead(sourceIndexPath, "the repository's index is a link", "real-index");
  }
  if (!lstats.isFile()) {
    throw refusingToRead(
      sourceIndexPath,
      "the repository's index is not a regular file",
      "real-index",
    );
  }

  const sourceHandle = await open(sourceIndexPath, "r").catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw createShadowIndexError(
      `[git] could not read ${sourceIndexPath}: ${toErrorMessage(error)}`,
      "EGITSHADOW",
      { stage: "private-index", cause: error },
    );
  });
  if (sourceHandle === null) {
    // lstat 与 open 之间源被删除（git index 重写交换窗口）：按缺失降级。
    return { prime: { kind: "source-missing" }, lockFile: null };
  }

  try {
    const stats = await sourceHandle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw refusingToRead(sourceIndexPath, "it is not a regular file", "private-index");
    }
    if (stats.size > BigInt(options.maxBytes)) {
      throw refusingToRead(
        sourceIndexPath,
        `it is larger than ${Math.floor(options.maxBytes / MIB)} MiB`,
        "private-index",
      );
    }

    // DIRC 魔数验签：循环读满 4 字节，短读/不匹配都拒绝（蓝本同款循环）。
    const magic = Buffer.alloc(DIRC_MAGIC.length);
    let bytesReadTotal = 0;
    while (bytesReadTotal < magic.length) {
      const { bytesRead } = await sourceHandle.read(
        magic,
        bytesReadTotal,
        magic.length - bytesReadTotal,
        bytesReadTotal,
      );
      if (bytesRead === 0) {
        break;
      }
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal < magic.length || !magic.equals(DIRC_MAGIC)) {
      throw refusingToRead(
        sourceIndexPath,
        "it does not start with git's index signature",
        "private-index",
      );
    }

    // 只读形态预占空 index.lock（wx）：他进程 git 对该副本的 index 写会立即撞锁失败。
    // writable 形态（checkpoint）跳过——git add/read-tree 需要自己创建 lock。
    let lockFile: string | null = null;
    if (!options.writable) {
      lockFile = `${destIndexFile}.lock`;
      await writeFile(lockFile, "", { flag: "wx" });
    }

    // wx 独占复制：目的地已存在即 EEXIST 失败，绝不覆盖写坏；精确复制 [0, size-1]。
    await pipeline(
      sourceHandle.createReadStream({
        start: 0,
        end: Number(stats.size) - 1,
        highWaterMark: COPY_STREAM_HIGH_WATER_MARK,
        autoClose: false,
      }),
      createWriteStream(destIndexFile, { flags: "wx" }),
    );

    // mtime 整秒保留（R4）：floor(mtimeNs/1e9)，副本 mtime ≤ 源 mtime，
    // git racily-clean 集合只增不减（偏差方向是多验内容，安全）。
    const mtimeSeconds = Number(stats.mtimeNs / 1_000_000_000n);
    await utimes(destIndexFile, mtimeSeconds, mtimeSeconds);

    return {
      prime: { kind: "copied", bytes: Number(stats.size), mtimeSeconds },
      lockFile,
    };
  } finally {
    await sourceHandle.close().catch(() => undefined);
  }
}

/**
 * 建立一份加固的私有 index 副本。
 *
 * 唯一抛出路径是 shadow-root（私有目录建不出来，调用方无法继续）；
 * 其余失败以 `prime: {kind:"rejected"}` 分类返回，由调用方裁决
 * （checkpoint = fail-soft 降级 read-tree HEAD，见 specs/shadow-git-index.md R2）。
 */
export async function createShadowIndex(
  options: CreateShadowIndexOptions,
): Promise<ShadowIndexHandle> {
  const dirPrefix = options.dirPrefix ?? "read-index-";
  const maxBytes = options.maxBytes ?? SHADOW_INDEX_MAX_BYTES_DEFAULT;
  const budget = options.copyBudget ?? SHADOW_INDEX_COPY_BUDGET_DEFAULT;
  const waitTimeoutMs = options.waitTimeoutMs ?? SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT;
  const writable = options.writable ?? false;

  // 阶段 1：shadow-root。目录先行（登记偏差 #1）：rejected 结果也要返回可用 handle。
  let dir: string;
  try {
    await mkdir(options.rootDir, { recursive: true });
    dir = await mkdtemp(join(options.rootDir, dirPrefix));
  } catch (error) {
    throw createShadowIndexError(
      `[git] could not create a shadow index root at ${options.rootDir}: ${toErrorMessage(error)}`,
      "EGITSHADOW",
      { stage: "shadow-root", cause: error },
    );
  }

  const indexFile = join(dir, "index");
  const handle: ShadowIndexHandle = {
    dir,
    indexFile,
    lockFile: null,
    prime: { kind: "source-missing" },
    async dispose() {
      // best-effort：Windows 上残留句柄/杀软扫描可能让 rm 瞬时 EBUSY，带重试后吞错。
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: DISPOSE_RM_MAX_RETRIES,
        retryDelay: DISPOSE_RM_RETRY_DELAY_MS,
      }).catch(() => undefined);
    },
  };

  if (!options.sourceIndexPath) {
    return handle;
  }
  const sourceIndexPath = resolve(options.sourceIndexPath);

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireCopySlot(sourceIndexPath, {
      signal: options.signal,
      budget,
      waitTimeoutMs,
    });
  } catch (error) {
    handle.prime = { kind: "rejected", error: classifyPrimeError(sourceIndexPath, error) };
    return handle;
  }

  try {
    if (options.beforeCopy) {
      await options.beforeCopy({ dir, indexFile });
    }
    const result = await inspectAndCopy(sourceIndexPath, indexFile, { maxBytes, writable });
    handle.prime = result.prime;
    handle.lockFile = result.lockFile;
  } catch (error) {
    // fail-closed 清理（R2-1）：复制阶段失败不得留下半成品，否则 git add 会读到截断 index。
    await rm(indexFile, { force: true }).catch(() => undefined);
    handle.prime = { kind: "rejected", error: classifyPrimeError(sourceIndexPath, error) };
  } finally {
    releaseSlot();
  }
  return handle;
}

function classifyPrimeError(sourceIndexPath: string, error: unknown): ShadowIndexError {
  if (isShadowIndexError(error)) {
    return error;
  }
  return createShadowIndexError(
    `[git] could not make a private copy of ${sourceIndexPath}: ${toErrorMessage(error)}`,
    SHADOW_INDEX_ERROR_CODE.copy,
    { cause: error },
  );
}
