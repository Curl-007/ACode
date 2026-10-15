import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoCycle, computeReadyTaskIds, criticalPathDepth, isFailedQualityGate, tasksBlockedByFailedQuality } from "../src/state/dag.js";
import type { TeamTask } from "../src/state/types.js";
import { TeamError } from "../src/state/types.js";

function task(overrides: Partial<TeamTask> & { taskId: string }): TeamTask {
  return {
    title: "t",
    objective: "o",
    acceptance: ["a"],
    kind: "build",
    dependencies: [],
    status: "todo",
    attemptSeq: 0,
    attempts: [],
    revisions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("dag", () => {
  it("assertNoCycle rejects self dependency", () => {
    assert.throws(
      () => assertNoCycle([], "t-1", ["t-1"]),
      (error: unknown) => error instanceof TeamError && error.code === "cycle_detected",
    );
  });

  it("assertNoCycle rejects indirect cycles", () => {
    // t-1 → t-2（t-2 依赖 t-1）：给 t-1 加依赖 t-2 会成环。
    const tasks = [
      task({ taskId: "t-1" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
    ];
    assert.throws(
      () => assertNoCycle(tasks, "t-1", ["t-2"]),
      (error: unknown) => error instanceof TeamError && error.code === "cycle_detected",
    );
  });

  it("assertNoCycle accepts valid chains", () => {
    const tasks = [
      task({ taskId: "t-1" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
    ];
    assertNoCycle(tasks, "t-3", ["t-2", "t-1"]);
  });

  it("ready set requires all dependencies done", () => {
    const tasks = [
      task({ taskId: "t-1" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
      task({ taskId: "t-3", dependencies: [] }),
    ];
    assert.deepEqual(computeReadyTaskIds(tasks), ["t-1", "t-3"]);
    tasks[0].status = "done";
    // done 的 t-1 离开就绪集（ready 只含 todo）；其依赖 t-2 就绪。
    assert.deepEqual(computeReadyTaskIds(tasks), ["t-2", "t-3"]);
  });

  it("failed dependencies never unlock (quality gate blocks downstream)", () => {
    const tasks = [
      task({ taskId: "t-1", kind: "review", status: "failed" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
    ];
    assert.deepEqual(computeReadyTaskIds(tasks), []);
    assert.equal(isFailedQualityGate(tasks[0]), true);
    const blocked = tasksBlockedByFailedQuality(tasks);
    assert.equal(blocked[0]?.taskId, "t-2");
    assert.deepEqual(blocked[0]?.blockedBy, ["t-1"]);
  });

  it("failed build task also blocks downstream but is not a quality gate", () => {
    const tasks = [
      task({ taskId: "t-1", kind: "build", status: "failed" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
    ];
    assert.deepEqual(computeReadyTaskIds(tasks), []);
    assert.equal(isFailedQualityGate(tasks[0]), false);
    assert.equal(tasksBlockedByFailedQuality(tasks).length, 0);
  });

  it("criticalPathDepth counts chain length", () => {
    const tasks = [
      task({ taskId: "t-1" }),
      task({ taskId: "t-2", dependencies: ["t-1"] }),
      task({ taskId: "t-3", dependencies: ["t-2", "t-1"] }),
    ];
    const byId = new Map(tasks.map((item) => [item.taskId, item]));
    assert.equal(criticalPathDepth(tasks[2], byId), 3);
    assert.equal(criticalPathDepth(tasks[0], byId), 1);
  });
});
