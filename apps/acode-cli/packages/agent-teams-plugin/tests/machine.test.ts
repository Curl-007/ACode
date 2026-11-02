import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertKnownTaskStatus,
  assertTransition,
  canTransition,
  isKnownTaskStatus,
  isTaskTerminal,
} from "../src/state/machine.js";
import type { TaskStatus } from "../src/state/types.js";

const ALL_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "done",
  "failed",
  "blocked",
  "cancelled",
];
const ALL_ACTIONS = [
  "claim",
  "update_done",
  "update_failed",
  "update_blocked",
  "accept",
  "reassign",
  "cancel",
] as const;

const EXPECTED: Record<TaskStatus, Partial<Record<(typeof ALL_ACTIONS)[number], TaskStatus>>> = {
  todo: { claim: "in_progress", reassign: "todo", cancel: "cancelled" },
  in_progress: {
    // 批次 1：汇报落到 in_review（非终态），验收才到 done。
    update_done: "in_review",
    update_failed: "failed",
    update_blocked: "blocked",
    reassign: "todo",
  },
  in_review: { accept: "done", update_failed: "failed", reassign: "todo" },
  done: {},
  failed: { reassign: "todo" },
  blocked: { reassign: "todo" },
  cancelled: {},
};

describe("machine", () => {
  it("transition table matches the PRD exactly (exhaustive)", () => {
    // EXPECTED 是独立手写的表：TRANSITIONS 若被改错，这里即变红（穷举变红证明）。
    let legal = 0;
    for (const from of ALL_STATUSES) {
      for (const action of ALL_ACTIONS) {
        const expected = EXPECTED[from][action];
        const actual = canTransition(from, action);
        assert.equal(actual, expected !== undefined, `${from} + ${action}`);
        if (expected) {
          assert.equal(actual, true, `${from} --${action}--> should be legal`);
        }
      }
    }
    legal = ALL_STATUSES.reduce(
      (sum, from) => sum + ALL_ACTIONS.filter((action) => canTransition(from, action)).length,
      0,
    );
    // 12 条合法边（todo 3 + in_progress 4 + in_review 3 + failed 1 + blocked 1）。
    assert.equal(legal, 12, "legal-edge count is a tripwire against table drift");
  });

  it("terminal statuses are closed under all actions except none", () => {
    // done 与 cancelled 完全封闭（真终态）；in_review 不是终态（待验收仍需处理）。
    for (const status of ["done", "cancelled"] as const) {
      assert.equal(isTaskTerminal(status), true);
      for (const action of ALL_ACTIONS) {
        assert.equal(canTransition(status, action), false, `${status} must not accept ${action}`);
      }
    }
    assert.equal(isTaskTerminal("in_review"), false);
  });

  it("in_review accepts only accept / reassign / update_failed (negative enumeration)", () => {
    for (const action of ["accept", "reassign", "update_failed"] as const) {
      assert.equal(canTransition("in_review", action), true, `in_review must accept ${action}`);
    }
    for (const action of ["claim", "update_done", "update_blocked", "cancel"] as const) {
      assert.equal(canTransition("in_review", action), false, `in_review must not accept ${action}`);
    }
    // 「未合并就 done」不存在：到 done 的唯一入边是 in_review --accept-->。
    for (const from of ALL_STATUSES) {
      if (from === "in_review") continue;
      assert.equal(canTransition(from, "accept"), false, `${from} must not accept`);
    }
  });

  it("in_progress accepts all three terminal updates and reassign", () => {
    for (const action of ["update_done", "update_failed", "update_blocked", "reassign"] as const) {
      assert.equal(canTransition("in_progress", action), true);
    }
    assert.equal(canTransition("in_progress", "claim"), false);
    assert.equal(canTransition("in_progress", "cancel"), false);
    assert.equal(canTransition("in_progress", "accept"), false, "accept is only from in_review");
  });

  it("unknown 'from' status fails loudly with a structured invalid_input, not a TypeError", () => {
    // 模拟磁盘上的外来 / 未来状态值：不能抛 TypeError，要抛结构化 invalid_input（R2.5）。
    assert.throws(
      () => assertTransition("shipped" as TaskStatus, "claim"),
      (error: unknown) => {
        const typed = error as { code?: string; name?: string };
        assert.equal(typed.code, "invalid_input");
        assert.notEqual(typed.name, "TypeError");
        return true;
      },
    );
    assert.equal(canTransition("shipped" as TaskStatus, "claim"), false);
    assert.equal(isKnownTaskStatus("shipped"), false);
    assert.equal(isKnownTaskStatus("in_review"), true);
    assert.throws(
      () => assertKnownTaskStatus("shipped", "task t-9"),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    assert.throws(
      () => assertKnownTaskStatus(undefined, "task t-9"),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    assert.doesNotThrow(() => assertKnownTaskStatus("in_review", "task t-1"));
  });
});