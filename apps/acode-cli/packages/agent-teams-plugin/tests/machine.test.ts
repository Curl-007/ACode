import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canTransition, isTaskTerminal } from "../src/state/machine.js";
import type { TaskStatus } from "../src/state/types.js";

const ALL_STATUSES: TaskStatus[] = ["todo", "in_progress", "done", "failed", "blocked", "cancelled"];
const ALL_ACTIONS = ["claim", "update_done", "update_failed", "update_blocked", "reassign", "cancel"] as const;

const EXPECTED: Record<TaskStatus, Partial<Record<(typeof ALL_ACTIONS)[number], TaskStatus>>> = {
  todo: { claim: "in_progress", reassign: "todo", cancel: "cancelled" },
  in_progress: { update_done: "done", update_failed: "failed", update_blocked: "blocked", reassign: "todo" },
  done: {},
  failed: { reassign: "todo" },
  blocked: { reassign: "todo" },
  cancelled: {},
};

describe("machine", () => {
  it("transition table matches the PRD exactly (exhaustive)", () => {
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
  });

  it("terminal statuses are closed under all actions except none", () => {
    // done 与 cancelled 完全封闭（PRD：终态任务不可再改；重派只对失败/阻塞开放）。
    for (const status of [ "done", "cancelled" ] as const) {
      assert.equal(isTaskTerminal(status), true);
      for (const action of ALL_ACTIONS) {
        assert.equal(canTransition(status, action), false, `${status} must not accept ${action}`);
      }
    }
  });

  it("in_progress accepts all three terminal updates and reassign", () => {
    for (const action of ["update_done", "update_failed", "update_blocked", "reassign"] as const) {
      assert.equal(canTransition("in_progress", action), true);
    }
    assert.equal(canTransition("in_progress", "claim"), false);
    assert.equal(canTransition("in_progress", "cancel"), false);
  });
});
