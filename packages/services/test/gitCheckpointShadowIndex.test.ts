import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setDataBaseDir } from "../src/paths.js";
import { createGitCheckpointRepo } from "../src/git/repo/gitCheckpointRepo.js";

/**
 * checkpoint × shadow index 集成回归（specs/shadow-git-index.md R2/R7、验收 14-15）。
 * 真实 git 临时 repo fixture（git 不可用则 skip），数据根重定向到临时目录。
 * 核心不变量：checkpoint 全程对用户真实 index 零写入；priming 失败 fail-soft 降级。
 */

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

let dataRoot: string;
let fixtureRoot: string;
let repoRoot: string;

function runGit(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: dataRoot,
      USERPROFILE: dataRoot,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { stdout: result.stdout ?? "", status: result.status };
}

function assertGitOk(result: { status: number | null }, label: string): void {
  assert.equal(result.status, 0, `${label} failed`);
}

async function snapshotRealIndex(): Promise<{ bytes: Buffer; mtimeMs: number }> {
  const indexPath = join(repoRoot, ".git", "index");
  const [bytes, stats] = await Promise.all([readFile(indexPath), lstat(indexPath)]);
  return { bytes, mtimeMs: stats.mtimeMs };
}

describe(
  "gitCheckpointRepo × shadow index (integration)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    before(async () => {
      dataRoot = await mkdtemp(join(tmpdir(), "acode-shadow-cp-data-"));
      fixtureRoot = await mkdtemp(join(tmpdir(), "acode-shadow-cp-fixture-"));
      // 数据根重定向：checkpoint 临时 index 根目录落在临时数据根下，测试互不污染。
      setDataBaseDir(dataRoot);

      repoRoot = join(fixtureRoot, "repo");
      await mkdir(repoRoot, { recursive: true });
      assertGitOk(runGit(["init", "-b", "main"], repoRoot), "git init");
      assertGitOk(runGit(["config", "user.name", "fixture"], repoRoot), "git config name");
      assertGitOk(runGit(["config", "user.email", "fixture@local"], repoRoot), "git config email");
      await writeFile(join(repoRoot, "a.txt"), "v1\n");
      assertGitOk(runGit(["add", "-A"], repoRoot), "git add");
      assertGitOk(runGit(["commit", "-m", "c1"], repoRoot), "git commit");
    });

    after(async () => {
      setDataBaseDir(null);
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 5 });
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    });

    test("createCheckpoint 固化 live 状态且用户真实 index 零污染（验收 14）", async () => {
      // live worktree 演进：a.txt 改动 + b.txt 新增，都不经过 git add（真实 index 停留在 v1）。
      await writeFile(join(repoRoot, "a.txt"), "v2\n");
      await writeFile(join(repoRoot, "b.txt"), "new\n");
      const indexBefore = await snapshotRealIndex();

      const checkpointRepo = createGitCheckpointRepo();
      const meta = await checkpointRepo.createCheckpoint({
        workspacePath: repoRoot,
        checkpointId: "cp-live",
      });

      // 隐藏 ref 锚定 commit。
      const refCheck = runGit(["rev-parse", meta.refName], repoRoot);
      assertGitOk(refCheck, "rev-parse checkpoint ref");
      assert.equal(refCheck.stdout.trim(), meta.commitOid);
      assert.equal(meta.scope, "workspace");

      // commit tree = live 状态（v2 + b.txt），而不是真实 index 里的 v1。
      const lsTree = runGit(["ls-tree", "-r", "--name-only", meta.commitOid], repoRoot);
      assertGitOk(lsTree, "ls-tree checkpoint commit");
      const treePaths = lsTree.stdout.split("\n").filter(Boolean).sort();
      assert.deepEqual(treePaths, ["a.txt", "b.txt"]);
      const showA = runGit(["show", `${meta.commitOid}:a.txt`], repoRoot);
      assertGitOk(showA, "show checkpoint a.txt");
      assert.equal(showA.stdout, "v2\n");

      // 零污染不变量：真实 index 字节与 mtime 均不变。
      const indexAfter = await snapshotRealIndex();
      assert.deepEqual(indexAfter.bytes, indexBefore.bytes);
      assert.equal(indexAfter.mtimeMs, indexBefore.mtimeMs);

      // 私有临时目录已被 dispose 清空（root 目录保留、内部无残留副本）。
      const checkpointIndexRoot = join(dataRoot, ".acode", "git-checkpoint-index");
      const leftovers = await readdir(checkpointIndexRoot);
      assert.deepEqual(leftovers, []);
    });

    test("真实 index 损坏（非 DIRC）→ prime 拒绝，checkpoint fail-soft 仍成功（验收 15）", async () => {
      const indexPath = join(repoRoot, ".git", "index");
      const garbage = Buffer.from("GARBAGE-NOT-A-GIT-INDEX".repeat(4));
      await writeFile(indexPath, garbage);
      await writeFile(join(repoRoot, "a.txt"), "v3\n");

      const checkpointRepo = createGitCheckpointRepo();
      const meta = await checkpointRepo.createCheckpoint({
        workspacePath: repoRoot,
        checkpointId: "cp-garbage-index",
      });

      // DIRC 魔数拒绝后走 read-tree HEAD 降级：checkpoint 语义不变，tree 仍固化 live 状态。
      const showA = runGit(["show", `${meta.commitOid}:a.txt`], repoRoot);
      assertGitOk(showA, "show checkpoint a.txt (garbage index)");
      assert.equal(showA.stdout, "v3\n");

      // 零写入不变量：坏 index 原样保留，管线没有替用户"修复"或触碰它。
      assert.deepEqual(await readFile(indexPath), garbage);

      // 恢复 fixture 真实 index，供后续用例使用（fixture 自有仓库，允许写）。
      assertGitOk(runGit(["read-tree", "HEAD"], repoRoot), "fixture index restore");
    });

    test("全新仓库无 index/无 HEAD：source-missing + read-tree 失败静默回落空 index", async () => {
      const freshRepo = join(fixtureRoot, "fresh-repo");
      await mkdir(freshRepo, { recursive: true });
      assertGitOk(runGit(["init", "-b", "main"], freshRepo), "git init fresh");
      await writeFile(join(freshRepo, "only.txt"), "fresh\n");

      const checkpointRepo = createGitCheckpointRepo();
      const meta = await checkpointRepo.createCheckpoint({
        workspacePath: freshRepo,
        checkpointId: "cp-fresh",
      });

      const lsTree = runGit(["ls-tree", "-r", "--name-only", meta.commitOid], freshRepo);
      assertGitOk(lsTree, "ls-tree fresh checkpoint");
      assert.deepEqual(lsTree.stdout.split("\n").filter(Boolean), ["only.txt"]);

      const checkpointIndexRoot = join(dataRoot, ".acode", "git-checkpoint-index");
      assert.deepEqual(await readdir(checkpointIndexRoot), []);
    });
  },
);
