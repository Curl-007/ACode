import assert from "node:assert/strict";
import test from "node:test";
import {
  activateDetail,
  deactivateDetail,
  EMPTY_DETAIL_GROUP_STATE,
  isDetailVisible,
} from "../src/v4/composer/usage-bar/usageBarDetailGroup.js";

test("last activation wins; the previous instance is no longer visible (pin included)", () => {
  const first = activateDetail(EMPTY_DETAIL_GROUP_STATE, "subagents");
  assert.equal(isDetailVisible(first, "subagents", { open: false, pinned: true }), true);
  const second = activateDetail(first, "today");
  assert.equal(isDetailVisible(second, "subagents", { open: true, pinned: true }), false);
  assert.equal(isDetailVisible(second, "today", { open: true, pinned: false }), true);
});

test("deactivate only clears the active id, never someone else's expansion", () => {
  const state = activateDetail(EMPTY_DETAIL_GROUP_STATE, "tools");
  assert.equal(deactivateDetail(state, "today"), state);
  assert.deepEqual(deactivateDetail(state, "tools"), EMPTY_DETAIL_GROUP_STATE);
});

test("visibility requires both being active and locally open or pinned", () => {
  const state = activateDetail(EMPTY_DETAIL_GROUP_STATE, "speed");
  assert.equal(isDetailVisible(state, "speed", { open: false, pinned: false }), false);
  assert.equal(isDetailVisible(state, "speed", { open: true, pinned: false }), true);
  assert.equal(isDetailVisible(state, "speed", { open: false, pinned: true }), true);
  assert.equal(isDetailVisible(state, "session", { open: true, pinned: true }), false);
});
