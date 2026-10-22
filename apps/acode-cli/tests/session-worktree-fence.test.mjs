import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * 写围栏 + 执行层 env 缝 + 台账验收（apps/acode-cli/specs/session-worktree-lifecycle.md
 * 场景 5/7/8）：
 *   - path-policy 收敛：warn 记录放行 / enforce 抛 PermissionDenied（既有权限语义）/
 *     off 开关放行 / 未绑定与 read/execute 行为与改动前一致 / repoRoot 外维持现状；
 *   - buildExecutionEnv 的 sessionWorktree 缝：注入、缺席键删除、overlay 优先、
 *     未接线零变化；
 *   - buildSessionWorktreeFenceEnv provider 载荷；
 *   - 台账机会式压实。
 */

const { resolveWorkspacePath } = await import("../packages/core/src/tool/path-policy.ts");
const {
  bindSessionWorktreeFence,
  buildSessionWorktreeFenceEnv,
  evaluateSessionWorktreeWriteFence,
  registerSessionWorktreeFenceWarnSink,
  resetSessionWorktreeFenceForTest,
  resolveSessionWorktreeFenceMode,
  setSessionWorktreeFenceWarnSink,
  snapshotSessionWorktreeFenceViolations,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");
const { SessionWorktreeLedger } = await import(
  "../packages/core/src/worktree/session-worktree-ledger.ts"
);
const { buildExecutionEnv } = await import(
  "../packages/adapters/src/exec/execution-command.ts"
);
const {
  SESSION_WORKTREE_ENV_KEY,
  SESSION_WORKTREE_FENCE_ENV_KEY,
  SESSION_WORKTREE_FENCE_OFF_ENV_KEY,
} = await import("../packages/contracts/src/tools/session-worktree.ts");

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 一套真实目录：repoRoot（用户 checkout 替身）+ worktree（tmp 命名空间替身）。 */
function makeFenceFixture() {
  const repoRoot = tempDir("acode-swtf-repo-");
  const worktreePath = tempDir("acode-swtf-wt-");
  const thirdParty = tempDir("acode-swtf-third-");
  bindSessionWorktreeFence({
    sessionId: "sess_fence",
    repoFingerprint: "fp-test",
    repoRoot,
    worktreePath,
    branch: "acode/session/sess_fence",
  });
  return { repoRoot, worktreePath, thirdParty };
}

const savedEnv = {};
function setEnv(key, value) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  resetSessionWorktreeFenceForTest();
  restoreEnv();
});

// ── 场景 5：围栏档位 ───────────────────────────────────────────────

test("(场景5) 档位解析：off 开关 > 显式 enforce > 缺省 warn", () => {
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  assert.equal(resolveSessionWorktreeFenceMode({}), "warn", "缺省档必须是 warn（spec R4 裁决）");
  assert.equal(resolveSessionWorktreeFenceMode({ [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce" }), "enforce");
  assert.equal(
    resolveSessionWorktreeFenceMode({
      [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce",
      [SESSION_WORKTREE_FENCE_OFF_ENV_KEY]: "1",
    }),
    "off",
    "off 开关优先于 enforce",
  );
  assert.equal(resolveSessionWorktreeFenceMode({ [SESSION_WORKTREE_FENCE_OFF_ENV_KEY]: "on" }), "off");
  assert.equal(resolveSessionWorktreeFenceMode({ [SESSION_WORKTREE_FENCE_ENV_KEY]: "nonsense" }), "warn");
});

test("(场景5) warn 档：写主 checkout 记录违规并放行；写 worktree 内放行", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, undefined);
  const { repoRoot, worktreePath, thirdParty } = makeFenceFixture();
  const before = snapshotSessionWorktreeFenceViolations().total;

  // 写主 checkout（围栏要保护的面）→ 放行但记录：
  const escaped = resolveWorkspacePath({
    inputPath: join(repoRoot, "src", "leak.ts"),
    workingDirectory: worktreePath,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(escaped, join(repoRoot, "src", "leak.ts"), "warn 档必须放行（现状语义）");
  const after = snapshotSessionWorktreeFenceViolations();
  assert.equal(after.total, before + 1);
  const violation = after.recent.at(-1);
  assert.equal(violation.fenceMode, "warn");
  assert.equal(violation.targetPath, join(repoRoot, "src", "leak.ts"));
  assert.ok(!("status" in violation), "遥测记录不得使用保留闭集键 status（spec R8）");

  // 写 worktree 内 → 放行且不记录：
  resolveWorkspacePath({
    inputPath: "feature.ts",
    workingDirectory: worktreePath,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(snapshotSessionWorktreeFenceViolations().total, before + 1);

  // repoRoot 外的第三方路径 → 维持现状放行（围栏不是通用沙箱，spec R4 违规边界裁决）：
  resolveWorkspacePath({
    inputPath: join(thirdParty, "notes.md"),
    workingDirectory: worktreePath,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(snapshotSessionWorktreeFenceViolations().total, before + 1);

  // read/execute 不受围栏影响（即使目标在主 checkout）：
  for (const operation of ["read", "execute"]) {
    resolveWorkspacePath({
      inputPath: join(repoRoot, "src", "leak.ts"),
      workingDirectory: worktreePath,
      workspaceRoot: repoRoot,
      operation,
    });
  }
  assert.equal(snapshotSessionWorktreeFenceViolations().total, before + 1);
});

test("(场景5) enforce 档：写主 checkout 抛 PermissionDenied（recoverable，既有权限语义）", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, "enforce");
  const { repoRoot, worktreePath } = makeFenceFixture();

  let thrown;
  try {
    resolveWorkspacePath({
      inputPath: join(repoRoot, "src", "leak.ts"),
      workingDirectory: worktreePath,
      workspaceRoot: repoRoot,
      operation: "write",
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "enforce 档必须拒绝");
  assert.equal(thrown.type, "permission_denied");
  assert.equal(thrown.recoverable, true, "拒绝必须可恢复（模型改写路径重试）");
  assert.match(thrown.message, /write fence/i);

  // worktree 内写入照常放行：
  const inside = resolveWorkspacePath({
    inputPath: "feature.ts",
    workingDirectory: worktreePath,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(inside, join(worktreePath, "feature.ts"));
});

test("(场景5) off 开关：enforce 配置下也一律放行（E2E/测试逃生舱）", () => {
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, "enforce");
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, "1");
  const { repoRoot, worktreePath } = makeFenceFixture();
  const before = snapshotSessionWorktreeFenceViolations().total;
  const resolved = resolveWorkspacePath({
    inputPath: join(repoRoot, "src", "leak.ts"),
    workingDirectory: worktreePath,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(resolved, join(repoRoot, "src", "leak.ts"));
  assert.equal(snapshotSessionWorktreeFenceViolations().total, before, "off 档不记录违规");
});

test("(场景5) 回归：未绑定会话的行为与改动前逐字节一致", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, "enforce"); // 即使 enforce 配置在场
  const repoRoot = tempDir("acode-swtf-unbound-");
  const otherDir = tempDir("acode-swtf-unbound-wd-");
  // 注册表为空（未绑定任何会话）：工作区外绝对路径照旧不硬拦（path-policy 现状注释）。
  const resolved = resolveWorkspacePath({
    inputPath: join(otherDir, "anywhere.txt"),
    workingDirectory: repoRoot,
    workspaceRoot: repoRoot,
    operation: "write",
  });
  assert.equal(resolved, join(otherDir, "anywhere.txt"));
  assert.equal(snapshotSessionWorktreeFenceViolations().total, 0);
  // 相对路径解析、空路径错误等既有语义：
  assert.equal(
    resolveWorkspacePath({
      inputPath: "rel.txt",
      workingDirectory: repoRoot,
      workspaceRoot: repoRoot,
      operation: "write",
    }),
    join(repoRoot, "rel.txt"),
  );
  assert.throws(
    () =>
      resolveWorkspacePath({
        inputPath: "",
        workingDirectory: repoRoot,
        workspaceRoot: repoRoot,
        operation: "write",
      }),
    /must not be empty/,
  );
});

test("(场景5) warn sink：装配层可接 logger（缺省不 console 刷屏）", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, undefined);
  const { repoRoot, worktreePath } = makeFenceFixture();
  const seen = [];
  setSessionWorktreeFenceWarnSink((message, details) => seen.push({ message, details }));
  evaluateSessionWorktreeWriteFence({
    workingDirectory: worktreePath,
    targetPath: join(repoRoot, "x.ts"),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].details.module, "core.worktree");
  assert.ok(!("status" in seen[0].details), "sink 细节键避开保留闭集键");
});

test("(CLI-04 残余) 双 App fence warn 按 sessionId 路由，一个 close 不影响另一个", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, undefined); // warn 档
  // 两个 App 各绑定自己的 worktree/repoRoot（注册表按 worktree 路径键控）。
  const repoA = tempDir("acode-swtf-repoA-");
  const worktreeA = tempDir("acode-swtf-wtA-");
  const repoB = tempDir("acode-swtf-repoB-");
  const worktreeB = tempDir("acode-swtf-wtB-");
  bindSessionWorktreeFence({
    sessionId: "sess_app_a",
    repoFingerprint: "fp-a",
    repoRoot: repoA,
    worktreePath: worktreeA,
    branch: "acode/session/sess_app_a",
  });
  bindSessionWorktreeFence({
    sessionId: "sess_app_b",
    repoFingerprint: "fp-b",
    repoRoot: repoB,
    worktreePath: worktreeB,
    branch: "acode/session/sess_app_b",
  });
  const seenA = [];
  const seenB = [];
  const unregisterA = registerSessionWorktreeFenceWarnSink("sess_app_a", (message, details) =>
    seenA.push({ message, details }),
  );
  registerSessionWorktreeFenceWarnSink("sess_app_b", (message, details) =>
    seenB.push({ message, details }),
  );

  // App A 的 worktree 越界写主 checkout → 只落 App A 的 sink。
  evaluateSessionWorktreeWriteFence({
    workingDirectory: worktreeA,
    targetPath: join(repoA, "leak.ts"),
  });
  assert.equal(seenA.length, 1, "App A 违规落 App A sink");
  assert.equal(seenB.length, 0, "App A 违规不得串到 App B");
  // App B 的违规只落 App B。
  evaluateSessionWorktreeWriteFence({
    workingDirectory: worktreeB,
    targetPath: join(repoB, "leak.ts"),
  });
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1, "App B 违规落 App B sink");

  // App A close（幂等释放自己的注册项）：App B 的 warn 通道不受影响。
  unregisterA();
  seenA.length = 0;
  seenB.length = 0;
  evaluateSessionWorktreeWriteFence({
    workingDirectory: worktreeA,
    targetPath: join(repoA, "leak2.ts"),
  });
  evaluateSessionWorktreeWriteFence({
    workingDirectory: worktreeB,
    targetPath: join(repoB, "leak2.ts"),
  });
  assert.equal(seenA.length, 0, "App A 释放后不再落其 sink（回落进程级缺省）");
  assert.equal(seenB.length, 1, "App A close 不得影响在跑 App B 的 warn 遥测");
});

// ── 场景 8：执行层 env 缝 ──────────────────────────────────────────

test("(场景8) provider 载荷：绑定 cwd → 边界 env；未绑定/关闭 → 空对象", () => {
  setEnv(SESSION_WORKTREE_FENCE_OFF_ENV_KEY, undefined);
  setEnv(SESSION_WORKTREE_FENCE_ENV_KEY, undefined);
  const { worktreePath, repoRoot } = makeFenceFixture();

  const fenced = buildSessionWorktreeFenceEnv(join(worktreePath, "src"), {});
  assert.deepEqual(fenced, {
    [SESSION_WORKTREE_ENV_KEY]: worktreePath,
    [SESSION_WORKTREE_FENCE_ENV_KEY]: "warn",
  });
  assert.deepEqual(buildSessionWorktreeFenceEnv(repoRoot, {}), {}, "主 checkout 不注入");
  assert.deepEqual(buildSessionWorktreeFenceEnv(undefined, {}), {});
  assert.deepEqual(
    buildSessionWorktreeFenceEnv(worktreePath, { [SESSION_WORKTREE_FENCE_OFF_ENV_KEY]: "1" }),
    {},
    "off 开关下不注入",
  );
  assert.deepEqual(
    buildSessionWorktreeFenceEnv(worktreePath, { [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce" }),
    { [SESSION_WORKTREE_ENV_KEY]: worktreePath, [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce" },
  );
});

test("(场景8) buildExecutionEnv：注入、陈旧继承键删除、overlay.set 优先、未接线零变化", () => {
  const staleEnv = {
    PATH: "/usr/bin",
    [SESSION_WORKTREE_ENV_KEY]: "/stale/path/from/parent",
    [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce",
  };

  // 未接线（sessionWorktree 缺席）→ 继承原样（零行为变化）：
  const untouched = buildExecutionEnv(undefined, { platform: "linux", processEnv: staleEnv });
  assert.equal(untouched[SESSION_WORKTREE_ENV_KEY], "/stale/path/from/parent");

  // 接线 + 绑定命中 → provider 值覆盖陈旧继承：
  const injected = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: staleEnv,
    sessionWorktree: {
      [SESSION_WORKTREE_ENV_KEY]: "/tmp/acode-session-worktrees/fp/sess",
      [SESSION_WORKTREE_FENCE_ENV_KEY]: "warn",
    },
  });
  assert.equal(injected[SESSION_WORKTREE_ENV_KEY], "/tmp/acode-session-worktrees/fp/sess");
  assert.equal(injected[SESSION_WORKTREE_FENCE_ENV_KEY], "warn");

  // 接线 + 未绑定（空对象）→ 名单内陈旧键删除（防漏给未绑定会话）：
  const stripped = buildExecutionEnv(undefined, {
    platform: "linux",
    processEnv: staleEnv,
    sessionWorktree: {},
  });
  assert.ok(!(SESSION_WORKTREE_ENV_KEY in stripped), "陈旧边界标记必须删除");
  assert.ok(!(SESSION_WORKTREE_FENCE_ENV_KEY in stripped), "陈旧档位必须删除");
  assert.equal(stripped.PATH, "/usr/bin", "名单外键不受影响");

  // overlay.set 的显式意图后置优先：
  const overridden = buildExecutionEnv(
    { set: { [SESSION_WORKTREE_ENV_KEY]: "/explicit/caller/intent" } },
    { platform: "linux", processEnv: staleEnv, sessionWorktree: {} },
  );
  assert.equal(overridden[SESSION_WORKTREE_ENV_KEY], "/explicit/caller/intent");
});

// ── 场景 7：台账压实 ───────────────────────────────────────────────

test("(场景7) 台账机会式压实：行数远超键数时重写，绑定终态不丢", async () => {
  const filePath = join(tempDir("acode-swtf-ledger-"), "ledger.jsonl");
  const ledger = new SessionWorktreeLedger({ filePath });
  await ledger.bind({
    sessionId: "sess_compact",
    repoFingerprint: "fp1",
    repoRoot: "/r",
    worktreePath: "/w",
    branch: "acode/session/sess_compact",
    baseRef: "sha1",
  });
  // 1 键 → 阈值 4×1+64=68 行；写 80 条 touch 触发压实。
  for (let index = 0; index < 80; index += 1) {
    await ledger.touch("sess_compact", "fp1");
  }
  const beforeLines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
  assert.ok(beforeLines > 68, `前置：行数应超阈值（实际 ${beforeLines}）`);

  const bindings = await ledger.load();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].state, "active");

  // 压实是异步旁路：轮询等待文件收缩（上限 5s，超时如实失败）。
  const deadline = Date.now() + 5000;
  let afterLines = beforeLines;
  while (Date.now() < deadline) {
    afterLines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
    if (afterLines < beforeLines) break;
    await new Promise((sleep) => setTimeout(sleep, 50));
  }
  assert.ok(afterLines <= 3, `压实后应只剩终态事件（实际 ${afterLines} 行）`);

  // 压实后语义不变：
  const reloaded = await ledger.load();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].sessionId, "sess_compact");
  assert.equal(reloaded[0].branch, "acode/session/sess_compact");
});

// ── 清理 ───────────────────────────────────────────────────────────

test("清理临时目录", () => {
  resetSessionWorktreeFenceForTest();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
