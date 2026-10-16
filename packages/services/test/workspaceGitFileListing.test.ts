import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { GitEnvironmentProvider } from "../src/git/providers/gitEnvironmentProvider.js";
import {
  createWorkspaceGitFileListingSource,
  WORKSPACE_GIT_LISTING_LIMITS,
  type CreateWorkspaceGitFileListingSourceOptions,
  type WorkspaceGitFileListingLimits,
} from "../src/file/workspaceGitFileListing.js";
import {
  buildWorkspaceFileEntriesFromGitListing,
  computeWorkspaceFileIndexReuseMs,
  filterGitListingNewlinePaths,
  WORKSPACE_FILE_INDEX_CACHE_MIN_COST_MS,
  WORKSPACE_FILE_INDEX_CACHE_MIN_ENTRIES,
  WORKSPACE_FILE_INDEX_CACHE_TTL_MAX_MS,
  WORKSPACE_FILE_INDEX_CACHE_TTL_MIN_MS,
  WORKSPACE_FILE_INDEX_CACHE_TTL_MULTIPLIER,
  type WorkspaceGitListingEntryContext,
} from "../src/file/workspaceGitListingEntries.js";
import { defaultWorkspaceFileSearchFilter } from "../src/file/workspaceFileMentionFilter.js";
import { loadWorkspaceFileSearchIgnoreRules } from "../src/file/workspaceFileIgnore.js";

/**
 * 文件索引降级栈守护（specs/file-index-degradation.md）。
 * git 主源采集/冷却表/换行注入过滤用真实 git 临时 repo fixture（git 不可用则 skip）；
 * entries 组装与成本比例 TTL 是纯函数，无平台依赖。
 */

const warnings: string[] = [];
const fakeLogger = {
  warn: (_traceId: unknown, ...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  },
};

function createFakeEnvironmentProvider(binary: string | null): GitEnvironmentProvider {
  return {
    async resolveGitBinary() {
      return binary;
    },
    createCommandEnv() {
      return { ...process.env };
    },
  };
}

// ---- 纯函数段：entries 组装（R5）与成本比例 TTL（R4）----

describe("workspace git file listing (pure)", () => {
  let rulesRoot: string;

  before(async () => {
    rulesRoot = await mkdtemp(join(tmpdir(), "acode-git-listing-rules-"));
    // .acodeignore：dist/ 排除（模拟"用户在 .acodeignore 里排除但 .gitignore 未排除"的目录）。
    await writeFile(join(rulesRoot, ".acodeignore"), "dist/\n");
  });

  after(async () => {
    await rm(rulesRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  test("git 清单 → entries：目录合成 / 隐藏目录 / .acodeignore 剪枝 / .acodeignore 自身剔除", async () => {
    const ignoreRules = await loadWorkspaceFileSearchIgnoreRules(rulesRoot);
    const context: WorkspaceGitListingEntryContext = {
      rootPath: rulesRoot,
      ignoreRules,
      filter: defaultWorkspaceFileSearchFilter,
    };
    const entries = buildWorkspaceFileEntriesFromGitListing(
      [
        "a/b.txt",
        "a/c.txt",
        ".hidden/d.txt",
        "top.txt",
        "dist/x.js",
        "dist/deep/y.js",
        ".acodeignore",
      ],
      context,
    );
    const byRelativePath = new Map(entries.map((entry) => [entry.relativePath, entry]));

    // 文件与合成目录条目。
    assert.equal(byRelativePath.get("a/b.txt")?.type, "file");
    assert.equal(byRelativePath.get("a/c.txt")?.type, "file");
    assert.equal(byRelativePath.get("a")?.type, "directory");
    assert.equal(byRelativePath.get("top.txt")?.type, "file");
    // 隐藏目录：不出目录条目，但子文件保留（与扫描 traverse=true/include=false 语义一致）。
    assert.equal(byRelativePath.has(".hidden"), false);
    assert.equal(byRelativePath.get(".hidden/d.txt")?.type, "file");
    // .acodeignore 规则剪枝：dist/ 下文件与目录条目都不出现。
    assert.equal(byRelativePath.has("dist"), false);
    assert.equal(byRelativePath.has("dist/x.js"), false);
    assert.equal(byRelativePath.has("dist/deep"), false);
    assert.equal(byRelativePath.has("dist/deep/y.js"), false);
    // 根级 .acodeignore 自身剔除。
    assert.equal(byRelativePath.has(".acodeignore"), false);
    // 绝对路径拼接与 name。
    assert.equal(byRelativePath.get("a/b.txt")?.path, join(rulesRoot, "a", "b.txt"));
    assert.equal(byRelativePath.get("a/b.txt")?.name, "b.txt");
  });

  test("成本比例 TTL 边界（R4）", () => {
    // 常量与 spec 数值一致（防漂移）。
    assert.equal(WORKSPACE_FILE_INDEX_CACHE_MIN_COST_MS, 250);
    assert.equal(WORKSPACE_FILE_INDEX_CACHE_MIN_ENTRIES, 50_000);
    assert.equal(WORKSPACE_FILE_INDEX_CACHE_TTL_MULTIPLIER, 20);
    assert.equal(WORKSPACE_FILE_INDEX_CACHE_TTL_MIN_MS, 30_000);
    assert.equal(WORKSPACE_FILE_INDEX_CACHE_TTL_MAX_MS, 120_000);
    // 门槛：耗时 <250ms 或条目 <5 万 → 0（不缓存）。
    assert.equal(computeWorkspaceFileIndexReuseMs(249, 60_000), 0);
    assert.equal(computeWorkspaceFileIndexReuseMs(250, 49_999), 0);
    // 达标：TTL=耗时×20，clamp 到 [30s, 120s]。
    assert.equal(computeWorkspaceFileIndexReuseMs(250, 50_000), 30_000);
    assert.equal(computeWorkspaceFileIndexReuseMs(1_000, 50_000), 30_000); // 20s → 下限 30s
    assert.equal(computeWorkspaceFileIndexReuseMs(3_000, 60_000), 60_000);
    assert.equal(computeWorkspaceFileIndexReuseMs(10_000, 60_000), 120_000); // 200s → 上限 120s
  });

  test("限额常量与 spec 一致（R2/R3）", () => {
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.softTimeoutMs, 10_000);
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.hardTimeoutMs, 15_000);
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.maxOutputBytes, 64 * 1024 * 1024);
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.maxRecordChars, 64 * 1024);
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.cooldownMs, 10 * 60_000);
    assert.equal(WORKSPACE_GIT_LISTING_LIMITS.cooldownMaxEntries, 64);
  });

  test("换行注入过滤纯函数：\\n/\\r 路径剔除并计数（R5，全平台可验证）", () => {
    const { paths, droppedNewlinePaths } = filterGitListingNewlinePaths([
      "normal.txt",
      "bad\nname.txt",
      "bad\rname.txt",
      "dir/ok.ts",
    ]);
    assert.deepEqual(paths, ["normal.txt", "dir/ok.ts"]);
    assert.equal(droppedNewlinePaths, 2);
  });
});

// ---- 集成段：真实 git 采集 / 冷却表 / 换行过滤 ----

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

describe(
  "workspace git file listing (real git)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    let repoRoot: string;
    let plainRoot: string;

    const runGit = (args: string[], cwd: string) =>
      spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });

    before(async () => {
      repoRoot = await mkdtemp(join(tmpdir(), "acode-git-listing-repo-"));
      plainRoot = await mkdtemp(join(tmpdir(), "acode-git-listing-plain-"));
      assert.equal(runGit(["init", "-q", "."], repoRoot).status, 0);
      runGit(["config", "user.email", "listing@test.local"], repoRoot);
      runGit(["config", "user.name", "listing-test"], repoRoot);
      await writeFile(join(repoRoot, ".gitignore"), "ignored.txt\n");
      await writeFile(join(repoRoot, "tracked.txt"), "tracked\n");
      await writeFile(join(repoRoot, "ignored.txt"), "ignored\n");
      await writeFile(join(repoRoot, "untracked.txt"), "untracked\n");
      await mkdir(join(repoRoot, "sub"), { recursive: true });
      await writeFile(join(repoRoot, "sub", "deep.txt"), "deep\n");
      assert.equal(
        runGit(["add", ".gitignore", "tracked.txt", "sub/deep.txt"], repoRoot).status,
        0,
      );
      assert.equal(runGit(["commit", "-q", "-m", "init"], repoRoot).status, 0);
    });

    after(async () => {
      await rm(repoRoot, { recursive: true, force: true, maxRetries: 5 });
      await rm(plainRoot, { recursive: true, force: true, maxRetries: 5 });
    });

    test("git 主源：tracked + untracked 收录，.gitignore 忽略文件不收录（R1/R2）", async () => {
      const source = createWorkspaceGitFileListingSource({ logger: fakeLogger });
      const outcome = await source.collect(repoRoot);
      assert.equal(outcome.kind, "listing");
      if (outcome.kind !== "listing") return;
      assert.ok(outcome.paths.includes("tracked.txt"));
      assert.ok(outcome.paths.includes("untracked.txt"));
      assert.ok(outcome.paths.includes("sub/deep.txt"));
      assert.ok(!outcome.paths.includes("ignored.txt"));
      assert.equal(outcome.droppedNewlinePaths, 0);
    });

    test("非 git 目录 → not-a-repository（静默）；git 不可用 → git-unavailable（静默）", async () => {
      const source = createWorkspaceGitFileListingSource({ logger: fakeLogger });
      const warningsBefore = warnings.length;
      assert.deepEqual(await source.collect(plainRoot), { kind: "not-a-repository" });
      assert.equal(warnings.length, warningsBefore, "非 git 目录必须静默降级");

      const noGitSource = createWorkspaceGitFileListingSource({
        logger: fakeLogger,
        environmentProvider: createFakeEnvironmentProvider(null),
      });
      assert.deepEqual(await noGitSource.collect(repoRoot), { kind: "git-unavailable" });
    });

    test("超限 → oversized + 冷却表；冷却期内 cooling-down 不 spawn；到期恢复（R3）", async () => {
      let fakeNow = 1_000_000;
      // 微小输出预算：正常 repo 的清单输出即触发 oversized(output)。
      const tinyBudget: Partial<WorkspaceGitFileListingLimits> = { maxOutputBytes: 8 };
      const oversizedOptions: CreateWorkspaceGitFileListingSourceOptions = {
        logger: fakeLogger,
        limits: tinyBudget,
        now: () => fakeNow,
      };
      const source = createWorkspaceGitFileListingSource(oversizedOptions);
      const first = await source.collect(repoRoot);
      assert.equal(first.kind, "oversized");
      if (first.kind === "oversized") {
        assert.equal(first.reason, "output");
      }
      // 冷却期内：不 spawn（瞬间返回），带剩余重试时间。
      fakeNow += 60_000;
      const second = await source.collect(repoRoot);
      assert.equal(second.kind, "cooling-down");
      if (second.kind === "cooling-down") {
        assert.ok(second.retryAfterMs > 0);
        assert.ok(second.retryAfterMs <= WORKSPACE_GIT_LISTING_LIMITS.cooldownMs);
      }
      // 警告只发一次（含影响与重试时间）。
      const oversizedWarnings = warnings.filter((message) => message.includes("超限中止"));
      assert.equal(oversizedWarnings.length, 1);
      assert.match(oversizedWarnings[0]!, /目录扫描/);
      assert.match(oversizedWarnings[0]!, /10 分钟/);
      // 冷却到期：恢复尝试（仍会超限，但 kind 回到 oversized 而非 cooling-down）。
      fakeNow += WORKSPACE_GIT_LISTING_LIMITS.cooldownMs + 1;
      const third = await source.collect(repoRoot);
      assert.equal(third.kind, "oversized");
    });

    test("冷却表 LRU 容量 64：满员逐最旧（R3）", async () => {
      let fakeNow = 2_000_000;
      const source = createWorkspaceGitFileListingSource({
        logger: fakeLogger,
        // maxOutputBytes=1：连 "not a git repository" 的 stderr 都触发 oversized，
        // 便于用普通目录批量制造冷却 key（生产限额下非 git 目录走静默 not-a-repository）。
        limits: { maxOutputBytes: 1 },
        now: () => fakeNow,
      });
      const baseRoot = await mkdtemp(join(tmpdir(), "acode-git-listing-lru-"));
      try {
        const dirs: string[] = [];
        for (let index = 0; index <= WORKSPACE_GIT_LISTING_LIMITS.cooldownMaxEntries; index += 1) {
          const dir = join(baseRoot, `d${index}`);
          await mkdir(dir, { recursive: true });
          dirs.push(dir);
        }
        // d0 先进冷却，再灌满 64 个其它 key → d0 应被 LRU 逐出。
        assert.equal((await source.collect(dirs[0]!)).kind, "oversized");
        for (const dir of dirs.slice(1)) {
          fakeNow += 1;
          assert.equal((await source.collect(dir)).kind, "oversized");
        }
        fakeNow += 1;
        // d0 已不在冷却表：重新尝试（再次 oversized），而非 cooling-down。
        assert.equal((await source.collect(dirs[0]!)).kind, "oversized");
        // 最后一个 key 仍在冷却表内。
        assert.equal((await source.collect(dirs[dirs.length - 1]!)).kind, "cooling-down");
      } finally {
        await rm(baseRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    });

    test("换行注入过滤：含 \\n 的路径剔除并计数 + 一次性警告（R5/R7）", async (t) => {
      // NTFS 内核层允许 \n，但 Win32 API 拒绝——Windows 上本用例显式 skip，
      // 过滤逻辑本身由纯函数用例全平台覆盖。
      const weirdName = "weird\nname.txt";
      const weirdPath = join(repoRoot, weirdName);
      try {
        await writeFile(weirdPath, "weird\n");
      } catch {
        t.skip("platform forbids \\n in file names");
        return;
      }
      const added = runGit(["add", "-A"], repoRoot);
      if (added.status !== 0) {
        await rm(weirdPath, { force: true });
        t.skip("git refused to track \\n file name on this platform");
        return;
      }
      try {
        const source = createWorkspaceGitFileListingSource({ logger: fakeLogger });
        const warningsBefore = warnings.length;
        const outcome = await source.collect(repoRoot);
        assert.equal(outcome.kind, "listing");
        if (outcome.kind !== "listing") return;
        assert.ok(!outcome.paths.some((path) => path.includes("\n")));
        assert.ok(outcome.droppedNewlinePaths >= 1);
        const newlineWarnings = warnings
          .slice(warningsBefore)
          .filter((message) => message.includes("换行/回车"));
        assert.equal(newlineWarnings.length, 1);
        assert.match(newlineWarnings[0]!, /不会出现在文件搜索结果中/);
      } finally {
        runGit(["rm", "-q", "--cached", "--", weirdName], repoRoot);
        await rm(weirdPath, { force: true });
      }
    });
  },
);
