import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** 错误信息写作规范 + 认知诚实工具契约验收（specs/error-message-style.md 场景 1-4）：
 * 规范类断言 =「描述文本含必备要素」；应用点断言打在真实构造出的 message 上。 */

const {
  bindSessionWorktreeFence,
  evaluateSessionWorktreeWriteFence,
  resetSessionWorktreeFenceForTest,
} = await import("../packages/core/src/worktree/session-worktree-fence.ts");
const { FleetRegistry } = await import("../packages/core/src/fleet/registry.ts");
const { globToolEntry } = await import("../packages/core/src/tool/handlers/glob.ts");
const { grepToolEntry } = await import("../packages/core/src/tool/handlers/grep.ts");
const { listWorkflowRunsToolEntry } = await import("../packages/core/src/tool/handlers/list-workflow-runs.ts");
const { sessionSearchToolEntry } = await import("../packages/core/src/tool/handlers/session-search.ts");
const { SESSION_WORKTREE_FENCE_ENV_KEY } = await import("../packages/contracts/src/tools/session-worktree.ts");

test("(场景1) 围栏 enforce 拒绝：原子性保证 + 范围限定 + 替代路径（模板①④）", () => {
  const root = realpathSync.native(tmpdir());
  const repoRoot = mkdtempSync(join(root, "acode-ems-repo-"));
  const worktreePath = mkdtempSync(join(root, "acode-ems-wt-"));
  bindSessionWorktreeFence({
    sessionId: "sess_ems",
    repoFingerprint: "fp-ems",
    repoRoot,
    worktreePath,
    branch: "acode/session/sess_ems",
  });
  try {
    let thrown;
    try {
      evaluateSessionWorktreeWriteFence({
        workingDirectory: worktreePath,
        targetPath: join(repoRoot, "src", "leak.ts"),
        env: { [SESSION_WORKTREE_FENCE_ENV_KEY]: "enforce" },
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "enforce 档必须拒绝");
    assert.match(thrown.message, /write fence/i); // 既有钉保留
    assert.match(thrown.message, /before anything was modified/i); // ①原子性保证句
    assert.match(thrown.message, /Only writes into the main checkout are fenced/i); // ④范围限定
    assert.match(thrown.message, /as usual/i); // ④其余照常（防过度泛化）
    assert.ok(thrown.message.includes(worktreePath), "必须给出 worktree 替代路径");
  } finally {
    resetSessionWorktreeFenceForTest();
  }
});

test("(场景2/3) fleet 所有权拒绝：活路 + 不可重试 + 报告用户（模板②④⑤）", () => {
  const registry = new FleetRegistry();
  const now = Date.now();
  registry.register({
    sessionId: "sess_target", agentId: "agent_target", title: "Refactor auth",
    agentType: "general-purpose", launchedBySessionId: "sess_other",
    launchedByToolCallId: "tc-other", startedAt: now, mode: "build",
    modeLineage: "ceiling", lastActivityAt: now, archived: false,
  });

  const unknown = registry.resolveOwned("sess_caller", "sess_made-up");
  assert.equal(unknown.reason, "unknown_session");
  assert.match(unknown.message, /never inferred|titles/i); // 既有钉：反归因句
  assert.match(unknown.message, /Do not guess other ids/i); // ②④死路禁令
  assert.match(unknown.message, /ListSessions/); // ④活路指引

  const stolen = registry.resolveOwned("sess_caller", "sess_target");
  assert.equal(stolen.reason, "not_owned_by_caller");
  assert.match(stolen.message, /no retry will change that/i); // ④不可重试定性
  assert.match(stolen.message, /Tell the user/i); // ⑤报告用户
  assert.match(stolen.message, /guessing other ids/i); // 不猜 id 禁令
});

test("(场景4) 四工具描述：R2 措辞义务要素在场", () => {
  // glob：cap + truncated=部分页 + at-least 义务（义务 1/2/4）：
  const glob = globToolEntry.metadata.description;
  assert.match(glob, /capped at 100 paths/i);
  assert.match(glob, /partial page, not the full match set/i);
  assert.match(glob, /at least 100 files/i);
  assert.match(glob, /never present a truncated page/i);
  // grep：默认页界 + pagination 读法 + at-least + count 混合计数（义务 1/2/3/4）：
  const grep = grepToolEntry.metadata.description;
  assert.match(grep, /at most 250 lines\/entries/);
  assert.match(grep, /pagination line/);
  assert.match(grep, /at least N/);
  assert.match(grep, /count mode mixes two baselines/);
  // ListWorkflowRuns：count=本页行数 + truncated + limit 指引（义务 1/4）：
  const lwr = listWorkflowRunsToolEntry.metadata.description;
  assert.match(lwr, /number of rows on this page, not the journal's total/);
  assert.match(lwr, /at least N runs/);
  assert.match(lwr, /default 20, max 50/);
  // SessionSearch modelInstructions：truncated 双语义 + at-least + limit 指引：
  const ss = (sessionSearchToolEntry.metadata.modelInstructions ?? []).join("\n");
  assert.match(ss, /this page, not a total/);
  assert.match(ss, /time budget/);
  assert.match(ss, /at least N results/);
  assert.match(ss, /default 10, max 50/);
  assert.match(ss, /untrusted historical data/i); // 既有纪律保留
});
