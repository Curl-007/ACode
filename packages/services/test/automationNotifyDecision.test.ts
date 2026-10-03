import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_EXHAUSTED_RETENTION_MS } from "@acode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";

/**
 * heartbeat 协议 R4/R5 的仓库层验收（packages/desktop/specs/automation-heartbeat-protocol.md）：
 * - migration 0004 后 notify_decision 可写可读（additive、旧行 undefined）；
 * - running 起始写不抹决策（COALESCE）；同轮重试（upsertRunClaimed 冲突分支）必须复位；
 * - pruneExhaustedAutomations 只删「completed 且过窗」，active/failed/新鲜 completed 不删。
 * 每个测试独立临时库（构造期注入 dbPath，见 automationRepo.ts 的 vitest-threads 注释）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createTempRepo(): { repo: AutomationRepo; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "acode-automation-notify-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  return {
    repo,
    cleanup: () => {
      // Windows：sqlite/WAL 句柄未关时目录被锁，rmSync 会 EPERM；先 close 再带重试删。
      repo.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function createParams(title: string) {
  return {
    title,
    cronExpr: "0 9 * * *",
    prompt: "daily work",
    workspacePath: join(tmpdir(), "acode-automation-notify-ws"),
    recurring: false,
  };
}

test("notify_decision 写读往返：settle 写入、旧行/未提供时 undefined", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  await repo.upsertRunClaimed({
    runId: "a1:1000",
    automationId: "a1",
    workspaceKey: "ws",
    scheduledAt: 1000,
    trigger: "schedule",
  });
  const before = await repo.getRun("a1:1000");
  assert.equal(before?.notifyDecision, undefined);

  await repo.markRunOutcome("a1:1000", "succeeded", undefined, "notify");
  const settled = await repo.getRun("a1:1000");
  assert.equal(settled?.outcome, "succeeded");
  assert.equal(settled?.notifyDecision, "notify");

  // absent 也是合法落库值（fail-safe 诊断依据），不是「没写」。
  await repo.upsertRunClaimed({
    runId: "a1:2000",
    automationId: "a1",
    workspaceKey: "ws",
    scheduledAt: 2000,
    trigger: "schedule",
  });
  await repo.markRunOutcome("a1:2000", "succeeded", undefined, "absent");
  assert.equal((await repo.getRun("a1:2000"))?.notifyDecision, "absent");
});

test("running 起始写不抹已有决策；同轮重试复位决策", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const runId = "a2:3000";
  await repo.upsertRunClaimed({
    runId,
    automationId: "a2",
    workspaceKey: "ws",
    scheduledAt: 3000,
    trigger: "schedule",
  });
  await repo.markRunOutcome(runId, "succeeded", undefined, "dont_notify");
  // 乱序的 running 写（补偿路径）不得抹掉 settle 决策：COALESCE 保留现值。
  await repo.markRunOutcome(runId, "running");
  assert.equal((await repo.getRun(runId))?.notifyDecision, "dont_notify");

  // 同 runId 重试认领：outcome/error/notify_decision 一起复位，不继承上一轮。
  await repo.upsertRunClaimed({
    runId,
    automationId: "a2",
    workspaceKey: "ws",
    scheduledAt: 3000,
    trigger: "schedule",
  });
  const retried = await repo.getRun(runId);
  assert.equal(retried?.outcome, undefined);
  assert.equal(retried?.notifyDecision, undefined);
  assert.equal(retried?.attempts, 1);
});

test("pruneExhaustedAutomations：completed 过窗即删、新鲜 completed 与 active 保留", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const stale = await repo.create(createParams("stale-one-shot"), {
    nextRunAt: Date.now() + 60_000,
  });
  // active 永不删（cutoff 放到未来也不行）。
  assert.equal(await repo.pruneExhaustedAutomations(-1), 0);

  // 一次性任务派发即达上限 → completed；updated_at = dispatchedAt（8 天前）。
  await repo.markDispatched(stale.automationId, {
    dispatchedAt: Date.now() - 8 * DAY_MS,
    nextRunAt: null,
  });
  assert.equal(await repo.pruneExhaustedAutomations(AUTOMATION_EXHAUSTED_RETENTION_MS), 1);

  const fresh = await repo.create(createParams("fresh-one-shot"), {
    nextRunAt: Date.now() + 60_000,
  });
  await repo.markDispatched(fresh.automationId, { dispatchedAt: Date.now(), nextRunAt: null });
  // 7 天窗内不删（Q1 裁决：删除前管理页仍可见可手动删）。
  assert.equal(await repo.pruneExhaustedAutomations(AUTOMATION_EXHAUSTED_RETENTION_MS), 0);
});

test("pruneExhaustedAutomations：failed 终态不自动删（用户要能看到坏掉的任务）", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const broken = await repo.create(createParams("broken"), { nextRunAt: Date.now() + 60_000 });
  await repo.markDispatchFailed(broken.automationId, {
    failedAt: Date.now() - 30 * DAY_MS,
    error: "permanent boom",
    kind: "permanent",
  });
  // cutoff 放到未来（-1）也不得碰 failed。
  assert.equal(await repo.pruneExhaustedAutomations(-1), 0);
  const all = await repo.list();
  assert.ok(all.some((entry) => entry.automationId === broken.automationId));
});

test("pruneRuns：migration 0004 后既有清理路径可用（R5a 调用方在 scheduler）", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  await repo.upsertRunClaimed({
    runId: "a5:5000",
    automationId: "a5",
    workspaceKey: "ws",
    scheduledAt: 5000,
    trigger: "schedule",
  });
  assert.equal(await repo.pruneRuns(7 * DAY_MS), 0);
  assert.equal(await repo.pruneRuns(-1), 1);
  assert.equal(await repo.getRun("a5:5000"), null);
});
