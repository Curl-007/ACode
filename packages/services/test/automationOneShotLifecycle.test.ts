import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";

/**
 * CronCreate recurring:false 的 one-shot 语义直接钉住（价值提取第二轮 W2-M1 件5
 * 「SchedulePrompt one-shot 自删语义核对」的测试面）：
 *
 * 核对结论——语义已存在且分两段：
 * 1. 触发即完成：markDispatched 对有限次任务（recurring=0）在
 *    scheduled_run_count >= (max_runs ?? 1) 时转 completed（enabled=0、
 *    next_run_at=NULL）——未显式设 maxRuns 的一次性任务默认上限 1，派发一次
 *    即终态，不会被 cron 反复触发（automationRepo.ts markDispatched）。
 * 2. 自删（保留窗后清理）：completed 定义过 AUTOMATION_EXHAUSTED_RETENTION_MS
 *    （7 天）保留窗后由 pruneExhaustedAutomations 删除、释放创建额度
 *    （desktop scheduler 启动清理接线；prune 行为已由
 *    automationNotifyDecision.test.ts 钉住，本文件不重复）。
 *
 * 本文件补的是第 1 段的**直接断言**（既有测试只经 prune 计数间接覆盖）：
 * 一次性默认上限 1、显式 maxRuns=N 的第 N 次才终态、recurring=true 永不因
 * 派发次数转 completed。
 */

function createTempRepo(): { repo: AutomationRepo; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "acode-automation-oneshot-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  return {
    repo,
    cleanup: () => {
      // Windows：sqlite/WAL 句柄未关时目录被锁；先 close 再带重试删。
      repo.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function createParams(title: string, extra: { recurring: boolean; maxRuns?: number }) {
  return {
    title,
    cronExpr: "0 9 * * *",
    prompt: "one-shot work",
    workspacePath: join(tmpdir(), "acode-automation-oneshot-ws"),
    recurring: extra.recurring,
    ...(extra.maxRuns !== undefined ? { maxRuns: extra.maxRuns } : {}),
  };
}

test("one-shot 缺省上限 1：recurring=false 未设 maxRuns，派发一次即 completed+停用+清空调度", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const created = await repo.create(createParams("oneshot-default", { recurring: false }), {
    nextRunAt: Date.now() + 60_000,
  });
  assert.equal(created.lifecycleStatus, "active");
  assert.equal(created.maxRuns, undefined, "未显式设上限时 maxRuns 保持缺失（缺省口径 1 在派发结算处）");

  const dispatchedAt = Date.now();
  await repo.markDispatched(created.automationId, { dispatchedAt, nextRunAt: null });

  const settled = await repo.get(created.automationId);
  assert.ok(settled);
  assert.equal(settled.lifecycleStatus, "completed", "派发即完成：一次性任务触发后必须转终态");
  assert.equal(settled.enabled, false, "终态必须停用，不得再被 cron 触发");
  assert.equal(settled.nextRunAt, undefined, "终态必须清空调度");
  assert.equal(settled.runCount, 1);
  assert.equal(settled.lastRunAt, dispatchedAt);
});

test("有限次 maxRuns=2：第 1 次派发保持 active，第 2 次派发才 completed", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const created = await repo.create(
    createParams("finite-two", { recurring: false, maxRuns: 2 }),
    { nextRunAt: Date.now() + 60_000 },
  );
  const firstNext = Date.now() + 2 * 60_000;
  await repo.markDispatched(created.automationId, {
    dispatchedAt: Date.now(),
    nextRunAt: firstNext,
  });
  const afterFirst = await repo.get(created.automationId);
  assert.ok(afterFirst);
  assert.equal(afterFirst.lifecycleStatus, "active", "未达上限不得提前终态");
  assert.equal(afterFirst.enabled, true);
  assert.equal(afterFirst.nextRunAt, firstNext, "调用方重算的下次调度必须落库");

  await repo.markDispatched(created.automationId, { dispatchedAt: Date.now(), nextRunAt: null });
  const afterSecond = await repo.get(created.automationId);
  assert.ok(afterSecond);
  assert.equal(afterSecond.lifecycleStatus, "completed");
  assert.equal(afterSecond.enabled, false);
  assert.equal(afterSecond.nextRunAt, undefined);
  assert.equal(afterSecond.runCount, 2);
});

test("recurring=true：多次派发永不因次数转 completed（无限循环语义）", async (t) => {
  const { repo, cleanup } = createTempRepo();
  t.after(cleanup);
  await repo.ensureReady();

  const created = await repo.create(createParams("recurring-daily", { recurring: true }), {
    nextRunAt: Date.now() + 60_000,
  });
  for (let i = 0; i < 3; i += 1) {
    const next = Date.now() + (i + 2) * 60_000;
    await repo.markDispatched(created.automationId, { dispatchedAt: Date.now(), nextRunAt: next });
    const state = await repo.get(created.automationId);
    assert.ok(state);
    assert.equal(state.lifecycleStatus, "active", `第 ${i + 1} 次派发后必须仍 active`);
    assert.equal(state.enabled, true);
    assert.equal(state.nextRunAt, next);
  }
});
