import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { GitRefRangeDiffResult } from "@acode/shared";
import { createGitService } from "../src/git/gitService.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";

/**
 * IGitService.getRefRangeDiff（team-acceptance-review-contract.md 契约 B）验收。
 *
 * 用真实 git 临时仓库夹具（git 不可用则 skip，形态同 gitPostureGatewayWiring.test.ts）；
 * 服务经 createGitService + createGitCliRepo 组装，覆盖 service→repo 真实调用面。
 * 负向断言：显式 SHA 必须逐字进入命令行、结果绝不回落 HEAD 或工作区状态（EI-9）。
 */

const gitProbe = spawnSync("git", ["--version"], { stdio: "ignore" });
const gitAvailable = gitProbe.status === 0;

const createdRoots: string[] = [];

after(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed (status=${result.status}): ${result.stderr}`,
  );
  return result.stdout.trim();
}

/** 建一个带 seed 提交（a.txt = "one\n"）的临时仓库，返回 repo 路径与 seed SHA。 */
async function createRepoWithSeed(): Promise<{ repo: string; seed: string }> {
  const root = await mkdtemp(join(tmpdir(), "acode-ref-range-"));
  createdRoots.push(root);
  const repo = join(root, "repo");
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "refrange@test.local"], repo);
  git(["config", "user.name", "refrange-test"], repo);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "seed"], repo);
  return { repo, seed: git(["rev-parse", "HEAD"], repo) };
}

interface Harness {
  provider: GitCommandProvider;
  /** 每次 git 命令的执行 argv（posture 网关重写后的形态）。 */
  calls: string[][];
  setNumstatTruncation(value: boolean): void;
}

/**
 * 真实 provider 的包装：记录 argv，并支持故障注入 numstat 输出溢出
 * （真实 512KiB numstat 需要约 2.6 万个文件，不适合做夹具；这里注入等价结果以覆盖分支）。
 */
function createHarness(): Harness {
  const base = createGitCommandProvider();
  const calls: string[][] = [];
  let truncateNumstat = false;
  const provider: GitCommandProvider = {
    resolveGitBinary: () => base.resolveGitBinary(),
    run: async (options) => {
      calls.push([...options.args]);
      const result = await base.run(options);
      if (truncateNumstat && options.args.includes("--numstat")) {
        return { ...result, outputTruncated: true, stdout: "" };
      }
      return result;
    },
  };
  return {
    provider,
    calls,
    setNumstatTruncation(value: boolean) {
      truncateNumstat = value;
    },
  };
}

function createService(harness: Harness) {
  return createGitService({ repo: createGitCliRepo({ commandProvider: harness.provider }) });
}

/** 断言所有已执行的 git 命令都没有把显式 rev 换成 HEAD（EI-9：绝不回落 HEAD）。 */
function assertNoHeadFallback(calls: readonly string[][]): void {
  for (const args of calls) {
    assert.equal(
      args.includes("HEAD"),
      false,
      `命令不得回落 HEAD: git ${args.join(" ")}`,
    );
  }
}

describe(
  "git ref-range diff (real git, temp repo)",
  { skip: gitAvailable ? false : "git binary not available" },
  () => {
    test("可达 range：正常返回 files/stat/patch（reason ok, availability patch）", async () => {
      const { repo, seed } = await createRepoWithSeed();
      // a.txt 同时有增有删（避免 numstat 的 append-only 歧义被推断成 added）；
      // b.txt 是新增文件。
      await writeFile(join(repo, "a.txt"), "ONE\n");
      await writeFile(join(repo, "b.txt"), "new\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "member change"], repo);
      const head = git(["rev-parse", "HEAD"], repo);

      const harness = createHarness();
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: head,
      });

      assert.equal(result.reason, "ok");
      assert.equal(result.availability, "patch");
      assert.equal(result.resolvedBase, seed);
      assert.equal(result.resolvedHead, head);
      assert.deepEqual(result.filesTruncated, false);
      assert.equal(result.files.length, 2);

      const aFile = result.files.find((file) => file.path === "a.txt");
      assert.ok(aFile, "a.txt 应出现在 files[]");
      assert.equal(aFile.kind, "modified");
      assert.equal(aFile.added, 1);
      assert.equal(aFile.removed, 1);

      const bFile = result.files.find((file) => file.path === "b.txt");
      assert.ok(bFile, "b.txt 应出现在 files[]");
      assert.equal(bFile.kind, "added");
      assert.equal(bFile.added, 1);

      assert.deepEqual(result.stat, { added: 2, removed: 1, fileCount: 2 });
      assert.ok(result.patch?.includes("+ONE"), "patch 应含成员修改行");
      assert.ok(result.patch?.includes("-one"), "patch 应含被删行");
      assert.ok(result.patch?.includes("+new"), "patch 应含新增文件内容");
    });

    test("path 过滤：files/stat/patch 一并收敛到单文件", async () => {
      const { repo, seed } = await createRepoWithSeed();
      await writeFile(join(repo, "a.txt"), "one\ntwo\n");
      await writeFile(join(repo, "b.txt"), "new\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "member change"], repo);
      const head = git(["rev-parse", "HEAD"], repo);

      const harness = createHarness();
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: head,
        path: "b.txt",
      });

      assert.equal(result.reason, "ok");
      assert.deepEqual(
        result.files.map((file) => file.path),
        ["b.txt"],
      );
      assert.deepEqual(result.stat, { added: 1, removed: 0, fileCount: 1 });
      assert.ok(result.patch?.includes("+new"));
      assert.equal(result.patch?.includes("+two") ?? false, false, "path 过滤后不应含其它文件");
    });

    test("提交不可达（清理后 GC 场景）：unavailable + ref_unresolved，且不回落 HEAD", async () => {
      const { repo, seed } = await createRepoWithSeed();
      const missingBase = "1".repeat(40);
      const missingHead = "2".repeat(40);

      const harness = createHarness();
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: missingBase,
        headRef: missingHead,
      });

      assert.equal(result.reason, "ref_unresolved");
      assert.equal(result.availability, "unavailable");
      assert.equal(result.resolvedBase, null);
      assert.equal(result.resolvedHead, null);
      assert.deepEqual(result.files, []);
      assert.equal(result.stat, null);
      assert.equal(result.patch, null);
      assert.equal(typeof result.summary, "string");
      assert.ok((result.summary ?? "").length > 0);
      // 解析命令逐字含两个显式 SHA（契约验收场景 7）。
      const resolveCalls = harness.calls.filter((args) => args[0] === "rev-parse");
      assert.ok(
        resolveCalls.some((args) => args.includes(`${missingBase}^{commit}`)),
        "命令行必须含显式 baseRef SHA",
      );
      assert.ok(
        resolveCalls.some((args) => args.includes(`${missingHead}^{commit}`)),
        "命令行必须含显式 headRef SHA",
      );
      assertNoHeadFallback(harness.calls);

      // 一端可达、另一端不可达：resolvedBase 如实给出、resolvedHead 为 null（不编造）。
      const partial = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: missingHead,
      });
      assert.equal(partial.reason, "ref_unresolved");
      assert.equal(partial.resolvedBase, seed);
      assert.equal(partial.resolvedHead, null);
      assert.equal(partial.patch, null);
    });

    test("base==head：no_changes 诚实返回空改动（不是错误）", async () => {
      const { repo, seed } = await createRepoWithSeed();

      const harness = createHarness();
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: seed,
      });

      assert.equal(result.reason, "no_changes");
      assert.equal(result.availability, "unavailable");
      assert.deepEqual(result.files, []);
      assert.equal(result.filesTruncated, false);
      assert.deepEqual(result.stat, { added: 0, removed: 0, fileCount: 0 });
      assert.equal(result.patch, null);
      assert.equal(result.resolvedBase, seed);
      assert.equal(result.resolvedHead, seed);
      assertNoHeadFallback(harness.calls);
    });

    test("patch 输出溢出：availability truncated + reason output_too_large + patch null（真实大 diff）", async () => {
      const { repo, seed } = await createRepoWithSeed();
      // 约 1.6MiB 的新增文件，patch 输出超过 DEFAULT_GIT_DIFF_BYTES(1MiB)。
      const line = `${"x".repeat(60)}\n`;
      const big = line.repeat(28_000);
      await writeFile(join(repo, "big.txt"), big);
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "big file"], repo);
      const head = git(["rev-parse", "HEAD"], repo);

      const harness = createHarness();
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: head,
      });

      assert.equal(result.availability, "truncated");
      assert.equal(result.reason, "output_too_large");
      assert.equal(result.patch, null);
      // 结构化清单一小段，未触发整段丢弃。
      assert.equal(result.filesTruncated, false);
      assert.deepEqual(
        result.files.map((file) => file.path),
        ["big.txt"],
      );
      assert.deepEqual(result.stat, { added: 28_000, removed: 0, fileCount: 1 });
    });

    test("结构化文件清单溢出：files[] 整段丢弃 + filesTruncated（patch 仍可用）", async () => {
      const { repo, seed } = await createRepoWithSeed();
      await writeFile(join(repo, "a.txt"), "one\ntwo\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "change"], repo);
      const head = git(["rev-parse", "HEAD"], repo);

      const harness = createHarness();
      harness.setNumstatTruncation(true);
      const result = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: head,
      });

      // EI-97：结构化序列绝不从中间截断——整段丢弃并置失步标记。
      assert.equal(result.filesTruncated, true);
      assert.deepEqual(result.files, []);
      assert.equal(result.stat, null);
      assert.equal(typeof result.summary, "string");
      // patch 是另一路输出，未被文件清单溢出牵连，仍如实可用。
      assert.equal(result.reason, "ok");
      assert.equal(result.availability, "patch");
      assert.ok(result.patch?.includes("+two"));
    });

    test("负向断言：不拿主仓库当前 HEAD 冒充成员提交（分叉夹具 + 命令行逐字含 SHA）", async () => {
      const { repo, seed } = await createRepoWithSeed();
      // 成员分支从 seed 分出，提交成员改动。
      git(["checkout", "-q", "-b", "member"], repo);
      await writeFile(join(repo, "a.txt"), "one\nMEMBER_ONLY\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "member commit"], repo);
      const memberHead = git(["rev-parse", "HEAD"], repo);

      // 主分支前进到与成员提交分叉的 HEAD（含只属于主 HEAD 的内容）。
      git(["checkout", "-q", "main"], repo);
      await writeFile(join(repo, "a.txt"), "one\nMAIN_HEAD_ONLY\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "main moves on"], repo);
      const mainHead = git(["rev-parse", "HEAD"], repo);
      assert.notEqual(mainHead, memberHead);

      const harness = createHarness();
      const result: GitRefRangeDiffResult = await createService(harness).getRefRangeDiff({
        workspacePath: repo,
        baseRef: seed,
        headRef: memberHead,
      });

      assert.equal(result.reason, "ok");
      assert.equal(result.resolvedBase, seed);
      assert.equal(result.resolvedHead, memberHead);
      assert.ok(result.patch?.includes("MEMBER_ONLY"), "patch 必须来自成员提交");
      assert.equal(
        result.patch?.includes("MAIN_HEAD_ONLY") ?? false,
        false,
        "结果绝不能含主仓库当前 HEAD 的内容冒充成员提交",
      );

      // 命令行逐字含两个显式 SHA（验收场景 7）：不得替换成 HEAD / 分支名。
      assertNoHeadFallback(harness.calls);
      const diffCalls = harness.calls.filter((args) => args[0] === "diff");
      assert.ok(
        diffCalls.some((args) => args.includes(seed) && args.includes(memberHead)),
        "diff 命令必须同时逐字含 baseRef 与 headRef SHA",
      );
      for (const args of diffCalls) {
        if (args.includes("--numstat") || args.includes("--binary")) {
          assert.ok(args.includes(seed) && args.includes(memberHead));
          assert.equal(args.includes(mainHead), false, "命令行不得出现主仓库 HEAD");
        }
      }
    });
  },
);