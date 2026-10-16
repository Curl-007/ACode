import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * 收割验收（apps/acode-cli/specs/session-worktree-lifecycle.md 场景 6）：
 * 保护序（本进程在绑 / 最近使用 / dirty 材料优先）先于删除判定；clean 才移除；
 * 分支保留；目录丢失 → tombstone(worktree-missing)；单条失败不阻断其余。
 */

const { enterSessionWorktree } = await import(
  "../packages/core/src/worktree/session-worktree-enter.ts"
);
const { reapSessionWorktrees } = await import(
  "../packages/core/src/worktree/session-worktree-reap.ts"
);
const { createSessionWorktreeManager } = await import(
  "../packages/core/src/worktree/session-worktree-manager.ts"
);
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const {
  bindSessionWorktreeFence,
  resetSessionWorktreeFenceForTest,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");
const { createReapSessionWorktreesToolEntry } = await import(
  "../packages/core/src/tool/handlers/reap-session-worktrees.ts"
);

const tempDirs = [];
function tempDir(prefix) {
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
  const dir = tempDir("acode-swtr-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "swt-eval@example.com"], dir);
  git(["config", "user.name", "swt-eval"], dir);
  writeFileSync(join(dir, "README.md"), "# shared repo\n", "utf-8");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 建一个真实 worktree 并把它按指定年龄写进台账。 */
async function seedBinding({ repo, harness, sessionId, ageDays, dirty = false, branchName }) {
  const entered = await enterSessionWorktree(
    { repoDir: repo, sessionId, ...(branchName ? { branchName } : {}) },
    harness.deps,
  );
  assert.equal(entered.outcome, "entered");
  if (dirty) {
    writeFileSync(join(entered.handle.path, "wip.txt"), "uncommitted material\n", "utf-8");
  }
  // 台账时间回拨：bind 事件重写为 ageDays 天前（折叠后 lastUsedAt 即回拨值）。
  const fingerprint = entered.fingerprint;
  await harness.ledger.append({
    v: 1,
    event: "bind",
    sessionId,
    repoFingerprint: fingerprint,
    repoRoot: entered.handle.repoRoot,
    worktreePath: entered.handle.path,
    branch: entered.handle.branch,
    baseRef: entered.handle.baseRef,
    at: Date.now() - ageDays * DAY_MS,
  });
  // enter 已把绑定放进围栏注册表；收割测试大多要求「不在本进程使用」，先解绑。
  resetSessionWorktreeFenceForTest();
  return entered;
}

function makeHarness() {
  const tmpRoot = tempDir("acode-swtr-tmp-");
  const ledgerFile = join(tempDir("acode-swtr-data-"), "ledger.jsonl");
  const manager = createSessionWorktreeManager({ tmpRoot });
  const ledger = new SessionWorktreeLedger({ filePath: ledgerFile });
  return { tmpRoot, ledgerFile, manager, ledger, deps: { manager, ledger } };
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
});

test("(场景6) 只收老龄 clean：dirty/新鲜/在绑绝不动，分支保留，台账落 tombstone", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();

  const oldClean = await seedBinding({ repo, harness, sessionId: "sess_old_clean", ageDays: 31 });
  const oldDirty = await seedBinding({ repo, harness, sessionId: "sess_old_dirty", ageDays: 45, dirty: true });
  const fresh = await seedBinding({ repo, harness, sessionId: "sess_fresh", ageDays: 3 });
  const inUse = await seedBinding({ repo, harness, sessionId: "sess_in_use", ageDays: 100 });
  // 本进程在绑（= 运行中/打开着）：
  bindSessionWorktreeFence({
    sessionId: "sess_in_use",
    repoFingerprint: inUse.fingerprint,
    repoRoot: inUse.handle.repoRoot,
    worktreePath: inUse.handle.path,
    branch: inUse.handle.branch,
  });

  const result = await reapSessionWorktrees({ olderThanDays: 30 }, harness.deps);

  const bySession = Object.fromEntries(result.entries.map((entry) => [entry.sessionId, entry.outcome]));
  assert.deepEqual(bySession, {
    sess_old_clean: "reaped",
    sess_old_dirty: "dirty_kept",
    sess_fresh: "recently_used",
    sess_in_use: "in_use_current_process",
  });
  assert.deepEqual(
    { reaped: result.reaped, kept: result.kept, tombstoned: result.tombstoned },
    { reaped: 1, kept: 3, tombstoned: 0 },
  );

  // clean 的目录移除、**分支保留**（重开重挂的材料）：
  assert.ok(!existsSync(oldClean.handle.path), "被收割的 worktree 目录必须移除");
  assert.ok(
    git(["branch", "--list", oldClean.handle.branch], repo).includes(oldClean.handle.branch),
    "分支必须保留",
  );
  // dirty 材料在场：
  assert.ok(existsSync(join(oldDirty.handle.path, "wip.txt")), "dirty 材料绝不销毁");
  assert.ok(existsSync(fresh.handle.path), "新鲜条目不动");
  assert.ok(existsSync(inUse.handle.path), "在绑条目不动");

  // 台账终态：reaped 条目 tombstone，其余仍 active：
  const bindings = await harness.ledger.load();
  const states = Object.fromEntries(bindings.map((binding) => [binding.sessionId, binding.state]));
  assert.equal(states["sess_old_clean"], "tombstone");
  assert.equal(states["sess_old_dirty"], "active");
  assert.equal(states["sess_fresh"], "active");
  assert.equal(states["sess_in_use"], "active");

  // 收割后重开 → reattached 重挂分支 tip（场景 3 的收割侧闭环）：
  const reentered = await enterSessionWorktree(
    { repoDir: repo, sessionId: "sess_old_clean" },
    harness.deps,
  );
  assert.equal(reentered.outcome, "reattached");
  assert.equal(reentered.handle.branch, oldClean.handle.branch);
});

test("(场景6) 目录已丢失 → tombstone(worktree-missing)，计入 tombstoned 而非 reaped", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  const gone = await seedBinding({ repo, harness, sessionId: "sess_gone_dir", ageDays: 91 });
  // 模拟 tmp 清理/外部删除：目录连同 git 登记一起消失。
  git(["worktree", "remove", "--force", gone.handle.path], repo);
  rmSync(gone.handle.path, { recursive: true, force: true });

  const result = await reapSessionWorktrees({ olderThanDays: 90 }, harness.deps);
  assert.deepEqual(
    { reaped: result.reaped, kept: result.kept, tombstoned: result.tombstoned },
    { reaped: 0, kept: 0, tombstoned: 1 },
  );
  assert.equal(result.entries[0].outcome, "tombstoned_missing");
  const bindings = await harness.ledger.load();
  const binding = bindings.find((entry) => entry.sessionId === "sess_gone_dir");
  assert.equal(binding.state, "tombstone");
  assert.equal(binding.tombstoneReason, "worktree-missing");
});

test("(场景6) 阈值闭集经工具面：30/60/90 之外被 schema 拒绝；handler 输出契约形状", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  await seedBinding({ repo, harness, sessionId: "sess_tool_reap", ageDays: 61 });
  const entry = createReapSessionWorktreesToolEntry(harness.deps);

  const output = await entry.handler({ older_than_days: 60 }, {
    toolCallId: "tc",
    traceId: "tr",
    abortSignal: new AbortController().signal,
    workingDirectory: repo,
    workspaceRoot: repo,
    sessionId: "sess_tool_reap",
  });
  assert.equal(output.reaped, 1);
  assert.equal(output.entries[0].outcome, "reaped");
  assert.match(output.message, /older than 60 days/);

  // 阈值是闭集（zod union of literals）：
  await assert.rejects(() => entry.handler({ older_than_days: 7 }, {}), /invalid|expected/i);
});

test("(场景6) tombstone 条目不再参与收割（重开后新 bind 才重新可见）", async () => {
  const repo = createRealRepo();
  const harness = makeHarness();
  const seeded = await seedBinding({ repo, harness, sessionId: "sess_tomb_skip", ageDays: 40 });
  await harness.ledger.tombstone("sess_tomb_skip", seeded.fingerprint, "released");
  const result = await reapSessionWorktrees({ olderThanDays: 30 }, harness.deps);
  assert.deepEqual(result.entries, [], "tombstone 无目录可收，必须整体跳过");
  assert.ok(existsSync(seeded.handle.path), "released 墓碑不触发目录删除（本工具只按台账事实行动）");
});

// ── 清理 ───────────────────────────────────────────────────────────

test("清理临时目录", () => {
  resetSessionWorktreeFenceForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
