import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * 会话 worktree enter 验收（apps/acode-cli/specs/session-worktree-lifecycle.md
 * 场景 1/2/3）：真实 git 子进程 fixture（临时仓，绝不触碰用户仓库）——
 * 从 HEAD 建 worktree 且不携带未提交改动、经 setWorkingDirectory 漏斗切 cwd、
 * 拒绝面闭集 reason、幂等复用、tombstone 重挂（分支 tip 材料不丢）。
 */

const { enterSessionWorktree } = await import(
  "../packages/core/src/worktree/session-worktree-enter.ts"
);
const { adoptLedgerBindingForCwd } = await import(
  "../packages/core/src/worktree/session-worktree-adoption.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const { SessionWorktreeLedger, foldSessionWorktreeEvents } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const {
  bindSessionWorktreeFence,
  lookupSessionWorktreeFenceBinding,
  resetSessionWorktreeFenceForTest,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");
const { createEnterSessionWorktreeToolEntry } = await import(
  "../packages/core/src/tool/handlers/enter-session-worktree.ts"
);

const tempDirs = [];
function tempDir(prefix) {
  // realpath.native 展开 %TEMP% 的 8.3 短名（与 workflow-worktree-isolation.test.mjs
  // 同一实证依据：git 登记长名，短名比对会失配）。
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRealRepo() {
  const dir = tempDir("acode-swt-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "swt-eval@example.com"], dir);
  git(["config", "user.name", "swt-eval"], dir);
  writeFileSync(join(dir, "README.md"), "# shared repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function makeHarness(repo) {
  const tmpRoot = tempDir("acode-swt-tmp-");
  const ledgerFile = join(tempDir("acode-swt-data-"), "ledger.jsonl");
  const manager = createSessionWorktreeManager({ tmpRoot });
  const ledger = new SessionWorktreeLedger({ filePath: ledgerFile });
  return {
    tmpRoot,
    ledgerFile,
    manager,
    ledger,
    deps: { manager, ledger, fenceFlushIntervalMs: 60 * 60 * 1000 },
  };
}

function makeContext(workingDirectory, sessionId) {
  const ctx = {
    toolCallId: "tc-swt-test",
    traceId: "trace-swt-test",
    abortSignal: new AbortController().signal,
    workingDirectory,
    workspaceRoot: workingDirectory,
    sessionId,
    cwdCalls: [],
  };
  // 漏斗替身：与 runtime.setWorkingDirectory 同款效果（后续工具读到新 cwd）。
  ctx.setWorkingDirectory = (cwd) => {
    ctx.cwdCalls.push(cwd);
    ctx.workingDirectory = cwd;
  };
  return ctx;
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
});

// ── 场景 1：enter 全链（真实 git）──────────────────────────────────

test("(场景1) enter：从 HEAD 建 worktree、不携带未提交改动、经漏斗切 cwd、台账落 bind", async () => {
  const repo = createRealRepo();
  // 用户 checkout 的进行中材料：绝不搬走也绝不清掉（spec R2）。
  writeFileSync(join(repo, "wip.txt"), "user work in progress\n", "utf-8");
  const head = git(["rev-parse", "HEAD"], repo);

  const harness = makeHarness(repo);
  const entry = createEnterSessionWorktreeToolEntry(harness.deps);
  const ctx = makeContext(repo, "sess_alpha-1");
  const output = await entry.handler({}, ctx);

  assert.equal(output.outcome, "entered", JSON.stringify(output));
  assert.match(output.branch, /^acode\/session\/sess_alpha-1$/);
  assert.equal(output.base_ref, head);
  assert.equal(output.source_branch, "main");
  assert.equal(output.fence_mode, "warn", "围栏缺省档位是 warn（spec R4 裁决）");
  assert.ok(output.worktree_path.startsWith(harness.tmpRoot), "worktree 必须落在注入的 tmp 命名空间");
  assert.deepEqual(ctx.cwdCalls, [output.worktree_path], "cwd 只经 setWorkingDirectory 漏斗切换");
  assert.equal(ctx.workingDirectory, output.worktree_path);

  // 内容与 HEAD 一致；未提交改动**没有**被携带（EOL 归一照仓库测试惯例）。
  assert.equal(
    readFileSync(join(output.worktree_path, "README.md"), "utf-8").replace(/\r\n/g, "\n"),
    "# shared repo\n",
  );
  assert.ok(!existsSync(join(output.worktree_path, "wip.txt")), "未提交改动绝不携带进 worktree");
  assert.ok(existsSync(join(repo, "wip.txt")), "用户 checkout 的材料原地保留");

  // git 登记 + 分支真实存在：
  const listed = git(["worktree", "list", "--porcelain"], repo);
  assert.ok(listed.includes(output.branch), "分支必须真实存在");
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], output.worktree_path), output.branch);

  // 台账 bind 事件 + 围栏绑定：
  const bindings = await harness.ledger.load();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].state, "active");
  assert.equal(bindings[0].branch, output.branch);
  assert.equal(bindings[0].sourceBranch, "main");
  const fenceBinding = lookupSessionWorktreeFenceBinding(output.worktree_path);
  assert.ok(fenceBinding, "enter 后围栏注册表必须在绑");
  assert.equal(fenceBinding.sessionId, "sess_alpha-1");
  assert.equal(fenceBinding.sourceBranch, "main");
});

test("(场景1) branch_name 入参进同一前缀且 slug 化", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const result = await enterSessionWorktree(
    { repoDir: repo, sessionId: "sess_beta", branchName: "My Feature!!" },
    harness.deps,
  );
  assert.equal(result.outcome, "entered");
  assert.equal(result.handle.branch, "acode/session/My-Feature");
});

// ── 场景 2：拒绝面（闭集 reason）───────────────────────────────────

test("(场景2) 拒绝面：非 git 仓 / 空仓 / linked worktree / 已在受管 worktree / branch_in_use", async () => {
  // 非 git 仓：
  const notRepo = tempDir("acode-swt-notrepo-");
  const plain = await enterSessionWorktree({ repoDir: notRepo, sessionId: "s1" }, makeHarness(notRepo).deps);
  assert.deepEqual(
    { outcome: plain.outcome, reason: plain.reason },
    { outcome: "rejected", reason: "not_git_repo" },
  );

  // 空仓（unborn HEAD）：
  const emptyRepo = tempDir("acode-swt-empty-");
  git(["init", "-b", "main"], emptyRepo);
  const empty = await enterSessionWorktree(
    { repoDir: emptyRepo, sessionId: "s1" },
    makeHarness(emptyRepo).deps,
  );
  assert.deepEqual(
    { outcome: empty.outcome, reason: empty.reason },
    { outcome: "rejected", reason: "unborn_head" },
  );

  // cwd 已在 linked worktree（用户自建/workflow 域一视同仁）：
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const foreign = join(tempDir("acode-swt-foreign-"), "wt");
  git(["worktree", "add", "-b", "other-topic", foreign, "HEAD"], repo);
  const linked = await enterSessionWorktree({ repoDir: foreign, sessionId: "s2" }, harness.deps);
  assert.deepEqual(
    { outcome: linked.outcome, reason: linked.reason },
    { outcome: "rejected", reason: "inside_linked_worktree" },
  );

  // 已在本会话的受管 worktree 内：
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "s3" }, harness.deps);
  assert.equal(first.outcome, "entered");
  const again = await enterSessionWorktree(
    { repoDir: first.handle.path, sessionId: "s3" },
    harness.deps,
  );
  assert.deepEqual(
    { outcome: again.outcome, reason: again.reason },
    { outcome: "rejected", reason: "already_in_session_worktree" },
  );

  // 分支已被占用（绝不劫持既有分支）：
  git(["branch", "acode/session/taken", "HEAD"], repo);
  const taken = await enterSessionWorktree(
    { repoDir: repo, sessionId: "s4", branchName: "taken" },
    harness.deps,
  );
  assert.deepEqual(
    { outcome: taken.outcome, reason: taken.reason },
    { outcome: "rejected", reason: "branch_in_use" },
  );
});

test("(场景2) 复用：cwd 飘走后重进 → reused，路径与材料原样", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_reuse" }, harness.deps);
  assert.equal(first.outcome, "entered");
  writeFileSync(join(first.handle.path, "agent-notes.md"), "in progress\n", "utf-8");

  // 模拟 bash cd 回主 checkout 后重进：
  const second = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_reuse" }, harness.deps);
  assert.equal(second.outcome, "reused");
  assert.equal(second.handle.path, first.handle.path);
  assert.equal(second.handle.branch, first.handle.branch);
  assert.ok(existsSync(join(first.handle.path, "agent-notes.md")), "复用不得触碰既有材料");
});

// ── 场景 3：tombstone 重挂（分支 tip 材料不丢）────────────────────

test("(场景3) 收割/丢失后重进：重挂既有分支 tip；分支也没了 → 从 HEAD 新建", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_gone" }, harness.deps);
  assert.equal(first.outcome, "entered");
  // 会话在 worktree 里提交了材料：
  writeFileSync(join(first.handle.path, "feature.txt"), "committed work\n", "utf-8");
  git(["add", "."], first.handle.path);
  git(["commit", "-m", "session work"], first.handle.path);
  const tip = git(["rev-parse", "HEAD"], first.handle.path);

  // 模拟收割：移除 worktree（材料留在分支上）+ 台账落 tombstone。
  git(["worktree", "remove", first.handle.path], repo);
  await harness.ledger.tombstone("sess_gone", first.fingerprint, "reaped");
  resetSessionWorktreeFenceForTest();

  const second = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_gone" }, harness.deps);
  assert.equal(second.outcome, "reattached");
  assert.equal(second.handle.branch, first.handle.branch);
  assert.equal(second.handle.path, first.handle.path);
  assert.equal(git(["rev-parse", "HEAD"], second.handle.path), tip, "重挂必须落在分支 tip");
  assert.equal(
    readFileSync(join(second.handle.path, "feature.txt"), "utf-8").replace(/\r\n/g, "\n"),
    "committed work\n",
  );

  // 分支也被删（外部清理）→ 从 HEAD 全新建，不失败：
  git(["worktree", "remove", second.handle.path], repo);
  git(["branch", "-D", second.handle.branch], repo);
  await harness.ledger.tombstone("sess_gone", first.fingerprint, "released");
  resetSessionWorktreeFenceForTest();
  const third = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_gone" }, harness.deps);
  assert.equal(third.outcome, "entered");
  assert.equal(third.handle.branch, first.handle.branch);
});

test("(场景3) 台账丢失但 git 仍登记（crash 残留）：同分支领养，不劫持不同分支", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_crash" }, harness.deps);
  assert.equal(first.outcome, "entered");

  // 换一个空台账（模拟 crash 前 bind 事件没落盘）：
  const orphanLedger = new SessionWorktreeLedger({
    filePath: join(tempDir("acode-swt-data2-"), "ledger.jsonl"),
  });
  const orphanDeps = { ...harness.deps, ledger: orphanLedger };
  resetSessionWorktreeFenceForTest();
  const adopted = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_crash" }, orphanDeps);
  assert.equal(adopted.outcome, "reattached", "git 已登记 + 分支一致 → 领养");
  assert.equal(adopted.handle.path, first.handle.path);

  // 同路径但要求不同分支名 → 绝不劫持，闭集拒绝：
  resetSessionWorktreeFenceForTest();
  const otherLedger = new SessionWorktreeLedger({
    filePath: join(tempDir("acode-swt-data3-"), "ledger.jsonl"),
  });
  const conflicting = await enterSessionWorktree(
    { repoDir: repo, sessionId: "sess_other", branchName: "totally-different" },
    { ...harness.deps, ledger: otherLedger },
  );
  // sess_other 的计算路径 slug 不同（totally-different），走全新分支 → entered；
  // 劫持判定针对的是**同路径不同分支**形态，由 branch_in_use 分支覆盖（见场景 2）。
  assert.equal(conflicting.outcome, "entered");
  assert.equal(conflicting.handle.branch, "acode/session/totally-different");
});

// ── 领养（进程重启后 merge 的前置）─────────────────────────────────

test("adoptLedgerBindingForCwd：围栏注册表为空时按台账把 cwd 领养回绑定", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_resume" }, harness.deps);
  assert.equal(first.outcome, "entered");

  // 模拟进程重启：注册表清空，但台账还在。
  resetSessionWorktreeFenceForTest();
  assert.equal(lookupSessionWorktreeFenceBinding(first.handle.path), undefined);

  const adopted = await adoptLedgerBindingForCwd(join(first.handle.path, "docs"), {
    ledger: harness.ledger,
  });
  assert.ok(adopted, "子目录 cwd 也必须命中绑定");
  assert.equal(adopted.sessionId, "sess_resume");
  assert.equal(adopted.branch, first.handle.branch);
  assert.equal(adopted.sourceBranch, "main");
  assert.ok(lookupSessionWorktreeFenceBinding(first.handle.path), "领养后注册表在绑");

  // 主 checkout 的 cwd 领养不到任何绑定：
  resetSessionWorktreeFenceForTest();
  assert.equal(await adoptLedgerBindingForCwd(repo, { ledger: harness.ledger }), undefined);
});

// ── 台账折叠（场景 7 的 enter 相关部分）────────────────────────────

test("台账折叠：bind+touch+tombstone 序、坏行跳过", () => {
  const lines = [
    JSON.stringify({ v: 1, event: "bind", sessionId: "s", repoFingerprint: "f", repoRoot: "/r", worktreePath: "/w", branch: "b", baseRef: "sha", at: 100 }),
    JSON.stringify({ v: 1, event: "touch", sessionId: "s", repoFingerprint: "f", at: 200 }),
    "not json at all",
    JSON.stringify({ v: 2, event: "bind", sessionId: "s", repoFingerprint: "f", at: 250 }), // 版本不符 → 跳过
    JSON.stringify({ v: 1, event: "tombstone", sessionId: "s", repoFingerprint: "f", reason: "reaped", at: 300 }),
  ].join("\n");
  const folded = foldSessionWorktreeEvents(lines);
  assert.equal(folded.lineCount, 5);
  assert.equal(folded.skippedLines, 2);
  const binding = folded.bindings.get("s\u0000f");
  assert.equal(binding.state, "tombstone");
  assert.equal(binding.tombstoneReason, "reaped");
  assert.equal(binding.lastUsedAt, 300);
  assert.equal(binding.branch, "b", "bind 的身份字段在 tombstone 后保留（重开重挂的材料）");
});

// ── 心跳（touch 节流回调）──────────────────────────────────────────

test("围栏心跳：活动推进后 flushTouch 落台账 touch（节流结算缝）", async () => {
  const repo = createRealRepo();
  const harness = makeHarness(repo);
  const first = await enterSessionWorktree({ repoDir: repo, sessionId: "sess_beat" }, harness.deps);
  assert.equal(first.outcome, "entered");

  const { flushSessionWorktreeFenceTouchesForTest } = await import(
    "../packages/core/src/worktree/session-worktree-fence.ts"
  );
  // 触发一次活动（lookup 即活动），再结算心跳：
  // bind 与 lookup 同毫秒时活动时刻未推进（lastActivityAt <= lastFlushedAt），
  // 节流语义会正确地不落 touch——Linux CI 够快曾同毫秒假红。实等 2ms 保证
  // Date.now 推进后再触发活动，消除同毫秒竞态。
  await new Promise((resolve) => setTimeout(resolve, 2));
  lookupSessionWorktreeFenceBinding(first.handle.path);
  await flushSessionWorktreeFenceTouchesForTest();
  const text = readFileSync(harness.ledgerFile, "utf-8");
  assert.ok(
    text.split("\n").some((line) => line.includes('"event":"touch"') && line.includes("sess_beat")),
    "touch 事件必须落台账（跨进程收割保护的事实源）",
  );
});

// ── 绑定事实（bindSessionWorktreeFence 直接面）────────────────────

test("bindSessionWorktreeFence：重复 bind 同一 worktree 不产生双份注册", () => {
  const binding = {
    sessionId: "s-dup",
    repoFingerprint: "f",
    repoRoot: tempDir("acode-swt-duproot-"),
    worktreePath: tempDir("acode-swt-dup-"),
    branch: "acode/session/s-dup",
  };
  bindSessionWorktreeFence(binding);
  bindSessionWorktreeFence(binding);
  assert.ok(lookupSessionWorktreeFenceBinding(binding.worktreePath));
});

// ── 清理 ───────────────────────────────────────────────────────────

test("清理临时目录", () => {
  resetSessionWorktreeFenceForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
