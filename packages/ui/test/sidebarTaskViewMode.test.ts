// WorkspaceSidebar 批次 5 外迁（sidebarTaskViewMode）的接缝内决策表测试。纯函数。
import assert from "node:assert/strict";
import test from "node:test";

import { resolveSidebarTaskViewMode } from "../src/WorkspaceSidebar/sidebarTaskViewMode.js";

test("resolveSidebarTaskViewMode：archived 优先于 organizeBy", () => {
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: true, taskOrganizeBy: "grouped" }),
    "archived",
  );
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: true, taskOrganizeBy: "chronological" }),
    "archived",
  );
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: true, taskOrganizeBy: "project" }),
    "archived",
  );
});

test("resolveSidebarTaskViewMode：organizeBy 三态映射", () => {
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: false, taskOrganizeBy: "chronological" }),
    "timeline",
  );
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: false, taskOrganizeBy: "grouped" }),
    "grouped",
  );
  assert.equal(
    resolveSidebarTaskViewMode({ showArchivedTasks: false, taskOrganizeBy: "project" }),
    "workspace",
  );
});
