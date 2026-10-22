import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createShadowIndex,
  getShadowIndexPipelineStats,
  isShadowIndexStage,
  SHADOW_INDEX_COPY_BUDGET_DEFAULT,
  SHADOW_INDEX_ERROR_CODE,
  SHADOW_INDEX_MAX_BYTES_DEFAULT,
  SHADOW_INDEX_STAGES,
  SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT,
  type ShadowIndexHandle,
} from "../src/git/repo/gitShadowIndex.js";

/**
 * shadow git 私有 index 加固管线单测（specs/shadow-git-index.md R1-R6、验收 1-13/16）。
 * 蓝本证据：Claude-2.37337 beautified `index.chunk-PMGadqIZ.js:166-336`、
 * `index.chunk-CHbrg8it.js:207-253`。
 */

const MIB = 1024 * 1024;

function buildFakeGitIndex(totalBytes = 32): Buffer {
  // git index 头：DIRC 魔数 + version(2) + entry count(0)，尾部填假 checksum。
  // 管线只做魔数/size/常规文件校验，不解析 entry，因此假头足够。
  const buffer = Buffer.alloc(Math.max(totalBytes, 32));
  buffer.write("DIRC", 0, "ascii");
  buffer.writeUInt32BE(2, 4);
  buffer.writeUInt32BE(0, 8);
  buffer.fill(0x41, 12);
  return buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await sleep(10);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

let tempRoot: string;
let caseCounter = 0;
const disposables: ShadowIndexHandle[] = [];

async function createCaseDir(): Promise<string> {
  caseCounter += 1;
  const dir = join(tempRoot, `case-${caseCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeSourceIndex(
  dir: string,
  content: Buffer,
  options?: { mtimeSeconds?: number },
): Promise<string> {
  const sourcePath = join(dir, "index");
  await writeFile(sourcePath, content);
  if (options?.mtimeSeconds !== undefined) {
    await utimes(sourcePath, options.mtimeSeconds, options.mtimeSeconds);
  }
  return sourcePath;
}

/** 统一登记 handle，after 里兜底 dispose + 校验并发状态归零。 */
async function shadow(
  options: Parameters<typeof createShadowIndex>[0],
): Promise<ShadowIndexHandle> {
  const handle = await createShadowIndex(options);
  disposables.push(handle);
  return handle;
}

describe("gitShadowIndex pipeline (unit)", () => {
  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "acode-shadow-index-"));
  });

  after(async () => {
    for (const handle of disposables.splice(0)) {
      await handle.dispose();
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  test("常量与 spec 防漂移（R3/R6，验收 16）", () => {
    // 蓝本数值：T=536870912（PMGadqIZ.js:166）、D=2（:168）、ee=5e3（:172）。
    assert.equal(SHADOW_INDEX_MAX_BYTES_DEFAULT, 512 * MIB);
    assert.equal(SHADOW_INDEX_MAX_BYTES_DEFAULT, 536_870_912);
    assert.equal(SHADOW_INDEX_COPY_BUDGET_DEFAULT, 2);
    assert.equal(SHADOW_INDEX_WAIT_TIMEOUT_MS_DEFAULT, 5_000);
    // ACode stage 闭集 = 蓝本 20 值闭集的交集三值（specs/shadow-git-index.md R6）。
    assert.deepEqual([...SHADOW_INDEX_STAGES], ["shadow-root", "private-index", "real-index"]);
    assert.equal(isShadowIndexStage("private-index"), true);
    assert.equal(isShadowIndexStage("owned-dir"), false); // 差集值不得混入
    assert.equal(isShadowIndexStage(42), false);
    assert.equal(SHADOW_INDEX_ERROR_CODE.validation, "EGITSHADOW");
    assert.equal(SHADOW_INDEX_ERROR_CODE.copy, "EGITINDEXCOPY");
  });

  test("源缺失是合法降级：source-missing，目的地无 index（验收 5）", async () => {
    const caseDir = await createCaseDir();
    const handle = await shadow({
      sourceIndexPath: join(caseDir, "no-such-dir", "index"),
      rootDir: join(caseDir, "shadow-root"),
      writable: true,
    });
    assert.equal(handle.prime.kind, "source-missing");
    assert.equal(await pathExists(handle.indexFile), false);
    assert.equal(await pathExists(handle.dir), true);
    // null 源（rev-parse 解析失败的 checkpoint 形态）同样按缺失处理。
    const nullHandle = await shadow({
      sourceIndexPath: null,
      rootDir: join(caseDir, "shadow-root"),
    });
    assert.equal(nullHandle.prime.kind, "source-missing");
    await handle.dispose();
    assert.equal(await pathExists(handle.dir), false);
  });

  test("happy copy：字节一致 + mtime 整秒保留（R4，验收 6）", async () => {
    const caseDir = await createCaseDir();
    const content = buildFakeGitIndex(64);
    // 已知带 0.5s 小数的 mtime：期望副本按 floor(mtimeNs/1e9) 整秒截断。
    const sourcePath = await writeSourceIndex(caseDir, content, { mtimeSeconds: 1_700_000_000.5 });
    const sourceStat = await stat(sourcePath);
    const expectedSeconds = Math.floor(sourceStat.mtimeMs / 1000);

    const handle = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
      writable: true,
    });
    assert.equal(handle.prime.kind, "copied");
    if (handle.prime.kind !== "copied") {
      return;
    }
    assert.equal(handle.prime.bytes, content.length);
    assert.equal(handle.prime.mtimeSeconds, expectedSeconds);
    const copied = await readFile(handle.indexFile);
    assert.deepEqual(copied, content);
    const destStat = await stat(handle.indexFile);
    // 整秒口径：副本 mtime ≤ 源 mtime，racily-clean 集合只增不减（R4 安全方向）。
    assert.equal(Math.floor(destStat.mtimeMs / 1000), expectedSeconds);
    assert.ok(destStat.mtimeMs <= sourceStat.mtimeMs);
  });

  test("DIRC 魔数坏拒：EGITSHADOW/private-index，无半成品（验收 1）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(
      caseDir,
      Buffer.from("GARBAGE-INDEX-CONTENT".repeat(4)),
    );
    const handle = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
      writable: true,
    });
    assert.equal(handle.prime.kind, "rejected");
    if (handle.prime.kind !== "rejected") {
      return;
    }
    assert.equal(handle.prime.error.code, "EGITSHADOW");
    assert.equal(handle.prime.error.stage, "private-index");
    assert.match(handle.prime.error.message, /index signature/);
    assert.equal(await pathExists(handle.indexFile), false);
    // 短于魔数长度（<4 字节）同样拒。
    const tinyPath = join(caseDir, "tiny-index");
    await writeFile(tinyPath, Buffer.from("DI"));
    const tinyHandle = await shadow({
      sourceIndexPath: tinyPath,
      rootDir: join(caseDir, "shadow-root"),
    });
    assert.equal(tinyHandle.prime.kind, "rejected");
  });

  test("size 上限拒：可注入 maxBytes（验收 4）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex(64));
    const handle = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
      maxBytes: 16,
    });
    assert.equal(handle.prime.kind, "rejected");
    if (handle.prime.kind !== "rejected") {
      return;
    }
    assert.equal(handle.prime.error.code, "EGITSHADOW");
    assert.equal(handle.prime.error.stage, "private-index");
    assert.match(handle.prime.error.message, /larger than/);
    assert.equal(await pathExists(handle.indexFile), false);
  });

  test("symlink 源拒：EGITSHADOW/real-index（验收 2，平台不支持 symlink 则 skip）", async (t) => {
    const caseDir = await createCaseDir();
    const realPath = await writeSourceIndex(caseDir, buildFakeGitIndex());
    const linkPath = join(caseDir, "linked-index");
    try {
      await symlink(realPath, linkPath);
    } catch (error) {
      // Windows 无开发者模式/权限时 symlink 会 EPERM：平台限制，不是管线缺陷。
      t.skip(`symlink not permitted on this platform: ${(error as Error).message}`);
      return;
    }
    const handle = await shadow({
      sourceIndexPath: linkPath,
      rootDir: join(caseDir, "shadow-root"),
    });
    assert.equal(handle.prime.kind, "rejected");
    if (handle.prime.kind !== "rejected") {
      return;
    }
    assert.equal(handle.prime.error.code, "EGITSHADOW");
    assert.equal(handle.prime.error.stage, "real-index");
    assert.match(handle.prime.error.message, /link/);
  });

  test("非常规文件源拒：目录 → real-index（验收 3）", async () => {
    const caseDir = await createCaseDir();
    const dirAsSource = join(caseDir, "index-is-a-dir");
    await mkdir(dirAsSource, { recursive: true });
    const handle = await shadow({
      sourceIndexPath: dirAsSource,
      rootDir: join(caseDir, "shadow-root"),
    });
    assert.equal(handle.prime.kind, "rejected");
    if (handle.prime.kind !== "rejected") {
      return;
    }
    assert.equal(handle.prime.error.code, "EGITSHADOW");
    assert.equal(handle.prime.error.stage, "real-index");
    assert.match(handle.prime.error.message, /not a regular file/);
  });

  test("只读形态预占空 index.lock；writable 形态不预占（R5，验收 8）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex());

    const readOnly = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
    });
    assert.equal(readOnly.prime.kind, "copied");
    assert.equal(readOnly.lockFile, `${readOnly.indexFile}.lock`);
    const lockStat = await stat(readOnly.lockFile!);
    assert.equal(lockStat.size, 0);

    const writable = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
      writable: true,
    });
    assert.equal(writable.prime.kind, "copied");
    assert.equal(writable.lockFile, null);
    assert.equal(await pathExists(`${writable.indexFile}.lock`), false);
  });

  test("wx 独占复制：目的地已存在 → EGITINDEXCOPY + fail-closed 清理（R2-1，验收 7）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex());
    const handle = await shadow({
      sourceIndexPath: sourcePath,
      rootDir: join(caseDir, "shadow-root"),
      writable: true,
      beforeCopy: async (dest) => {
        // 模拟并发/重试路径抢先把目的地写坏：wx 必须拒绝覆盖而不是静默写坏。
        await writeFile(dest.indexFile, "pre-existing-garbage");
      },
    });
    assert.equal(handle.prime.kind, "rejected");
    if (handle.prime.kind !== "rejected") {
      return;
    }
    assert.equal(handle.prime.error.code, "EGITINDEXCOPY");
    assert.match(handle.prime.error.message, /private copy/);
    // fail-closed：失败后不留半成品（包括钩子预置的文件），降级路径拿到的是干净空 index。
    assert.equal(await pathExists(handle.indexFile), false);
  });

  test("per-path singleflight：同源串行，异目录各自成副本（R3，验收 9）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex());
    const rootDir = join(caseDir, "shadow-root");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let secondEnteredCopy = false;

    const firstPromise = shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      beforeCopy: async () => {
        await firstGate;
      },
    });
    await waitFor(() => getShadowIndexPipelineStats().activeCopyCount === 1);

    const secondPromise = shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      beforeCopy: async () => {
        secondEnteredCopy = true;
      },
    });
    await sleep(80);
    // 前者未释放时，后者不得进入自己的复制（singleflight 串行，不是结果合并）。
    assert.equal(secondEnteredCopy, false);
    assert.equal(getShadowIndexPipelineStats().activeCopyCount, 1);

    releaseFirst();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(secondEnteredCopy, true);
    assert.equal(first.prime.kind, "copied");
    assert.equal(second.prime.kind, "copied");
    assert.notEqual(first.dir, second.dir);
    assert.deepEqual(await readFile(first.indexFile), await readFile(second.indexFile));
    assert.deepEqual(getShadowIndexPipelineStats(), { activeCopyCount: 0, queuedSourcePaths: 0 });
  });

  test("singleflight 等待超时 → EGITINDEXCOPY fail-soft，前序不受影响（R3，验收 10）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex());
    const rootDir = join(caseDir, "shadow-root");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstPromise = shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      beforeCopy: async () => {
        await firstGate;
      },
    });
    await waitFor(() => getShadowIndexPipelineStats().activeCopyCount === 1);

    const second = await shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      waitTimeoutMs: 60,
    });
    assert.equal(second.prime.kind, "rejected");
    if (second.prime.kind === "rejected") {
      assert.equal(second.prime.error.code, "EGITINDEXCOPY");
      assert.match(second.prime.error.message, /still waiting for an earlier copy/);
    }
    // rejected 的 handle 仍然可用（空 index 目录，供调用方降级）。
    assert.equal(await pathExists(second.dir), true);
    assert.equal(await pathExists(second.indexFile), false);

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.prime.kind, "copied");
    assert.deepEqual(getShadowIndexPipelineStats(), { activeCopyCount: 0, queuedSourcePaths: 0 });
  });

  test("全局并发预算：budget=1 时异源排队，超时 → EGITINDEXCOPY（R3，验收 11）", async () => {
    const caseDir = await createCaseDir();
    await mkdir(join(caseDir, "a"), { recursive: true });
    await mkdir(join(caseDir, "b"), { recursive: true });
    const sourceA = await writeSourceIndex(join(caseDir, "a"), buildFakeGitIndex());
    const sourceB = await writeSourceIndex(join(caseDir, "b"), buildFakeGitIndex());
    const rootDir = join(caseDir, "shadow-root");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstPromise = shadow({
      sourceIndexPath: sourceA,
      rootDir,
      writable: true,
      copyBudget: 1,
      beforeCopy: async () => {
        await firstGate;
      },
    });
    await waitFor(() => getShadowIndexPipelineStats().activeCopyCount === 1);

    // 异源 → 不触发 singleflight，只受全局预算约束。
    const second = await shadow({
      sourceIndexPath: sourceB,
      rootDir,
      writable: true,
      copyBudget: 1,
      waitTimeoutMs: 60,
    });
    assert.equal(second.prime.kind, "rejected");
    if (second.prime.kind === "rejected") {
      assert.equal(second.prime.error.code, "EGITINDEXCOPY");
      assert.match(second.prime.error.message, /still waiting for 1 other index copies/);
    }

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.prime.kind, "copied");
    assert.deepEqual(getShadowIndexPipelineStats(), { activeCopyCount: 0, queuedSourcePaths: 0 });
  });

  test("等待期间 AbortSignal → EGITINDEXCOPY（R3，验收 12）", async () => {
    const caseDir = await createCaseDir();
    const sourcePath = await writeSourceIndex(caseDir, buildFakeGitIndex());
    const rootDir = join(caseDir, "shadow-root");

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstPromise = shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      beforeCopy: async () => {
        await firstGate;
      },
    });
    await waitFor(() => getShadowIndexPipelineStats().activeCopyCount === 1);

    const abortController = new AbortController();
    abortController.abort();
    const second = await shadow({
      sourceIndexPath: sourcePath,
      rootDir,
      writable: true,
      signal: abortController.signal,
      waitTimeoutMs: 5_000,
    });
    assert.equal(second.prime.kind, "rejected");
    if (second.prime.kind === "rejected") {
      assert.equal(second.prime.error.code, "EGITINDEXCOPY");
      assert.match(second.prime.error.message, /still waiting/);
    }

    releaseFirst();
    const first = await firstPromise;
    assert.equal(first.prime.kind, "copied");
    assert.deepEqual(getShadowIndexPipelineStats(), { activeCopyCount: 0, queuedSourcePaths: 0 });
  });

  test("shadow-root 硬失败：rootDir 不可建 → 抛 EGITSHADOW/shadow-root（R2-3，验收 13）", async () => {
    const caseDir = await createCaseDir();
    const blocker = join(caseDir, "root-dir-is-a-file");
    await writeFile(blocker, "not a dir");
    await assert.rejects(
      createShadowIndex({
        sourceIndexPath: join(caseDir, "whatever"),
        rootDir: blocker,
      }),
      (error: unknown) => {
        const shadowError = error as { code?: string; stage?: string };
        assert.equal(shadowError.code, "EGITSHADOW");
        assert.equal(shadowError.stage, "shadow-root");
        return true;
      },
    );
    assert.deepEqual(getShadowIndexPipelineStats(), { activeCopyCount: 0, queuedSourcePaths: 0 });
  });
});
