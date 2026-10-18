// 脚本工作流管理面投影：physical → logical → stopReason 全词表 + stats 展平 +
// 定义条目可见性过滤。依据：apps/acode-cli/specs/script-workflow-management-surface.md
// §4.1/§4.2 与 §10 测试计划（cli-workflow 行）。

import assert from "node:assert/strict";
import test from "node:test";

const {
  isVisibleScriptWorkflowDefinition,
  scriptWorkflowStopReasonOf,
  toScriptWorkflowManagementDefinitionEntry,
  toScriptWorkflowManagementRunEntry,
} = await import("../packages/cli-workflow/src/script-workflow-management-projection.ts");
const { SCRIPT_WORKFLOW_RUN_STATUSES } =
  await import("../packages/contracts/src/workflow/script.ts");

/** 铸一条最小合法 run 行；词表受 CHECK 约束（真实库词表），类型即测试夹具。 */
function runRow(overrides = {}) {
  return {
    id: "wf_projection-1",
    name: "review",
    kind: "script",
    cwd: "/tmp/proj",
    status: "completed",
    budgetSpent: 7,
    stats: {
      agentCalls: 2,
      cachedAgentCalls: 1,
      failedAgentCalls: 0,
      toolCalls: 5,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 3, output: 4, reasoning: 0, total: 7 },
    },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

test("stop_reason 全词表：cancelled→user、interrupted→processExited、其余终态不携带", () => {
  assert.equal(scriptWorkflowStopReasonOf("cancelled"), "user");
  assert.equal(scriptWorkflowStopReasonOf("interrupted"), "processExited");
  for (const status of ["pending", "running", "paused", "completed", "failed"]) {
    assert.equal(scriptWorkflowStopReasonOf(status), undefined, status);
  }
});

test("逻辑态投影全词表：物理六词原样透传，cancelled+code 投影 interrupted", () => {
  // 物理词表逐词过一遍（与 CHECK 约束同源）。
  for (const status of SCRIPT_WORKFLOW_RUN_STATUSES) {
    const entry = toScriptWorkflowManagementRunEntry(runRow({ status }), false);
    assert.equal(entry.logicalStatus, status, `物理词 ${status} 必须原样透传`);
  }
  const interrupted = toScriptWorkflowManagementRunEntry(
    runRow({
      status: "cancelled",
      failure: { code: "ScriptWorkflowInterrupted", message: "anything" },
    }),
    false,
  );
  assert.equal(interrupted.logicalStatus, "interrupted");
  assert.equal(interrupted.stopReason, "processExited");
  // 不解析 message 文本：code 缺席/拼错时 cancelled 就是用户取消。
  const userCancelled = toScriptWorkflowManagementRunEntry(
    runRow({ status: "cancelled", failure: { message: "ScriptWorkflowInterrupted" } }),
    false,
  );
  assert.equal(userCancelled.logicalStatus, "cancelled");
  assert.equal(userCancelled.stopReason, "user");
});

test("stats 展平显式键：tokensTotal = tokens.total；usageIncomplete 如实透传", () => {
  const entry = toScriptWorkflowManagementRunEntry(runRow(), true);
  assert.deepEqual(entry.stats, {
    agentCalls: 2,
    cachedAgentCalls: 1,
    failedAgentCalls: 0,
    toolCalls: 5,
    tokensTotal: 7,
    usageIncomplete: true,
  });
  // 存量行 stats 缺席：零值但 usageIncomplete 不被吞掉（不把读不到的账本伪装成完整零）。
  const legacy = toScriptWorkflowManagementRunEntry(runRow({ stats: undefined }), true);
  assert.equal(legacy.stats.tokensTotal, 0);
  assert.equal(legacy.stats.usageIncomplete, true);
});

// usageIncomplete 的判据与读面覆盖已随 P2 修复迁往 store 层
// （script-workflow-management-store.test.mjs：SQL exists 探测 ↔
// scriptWorkflowActivityUsageIncomplete 判据对同一批行互钉）；投影模块自此只收布尔。

test("definition 条目：meta.description / phaseTitles 顺序 / scope 原样（B2）", () => {
  const record = {
    id: "script_def-1",
    name: "review",
    source: "user",
    scope: "project",
    scriptPath: "/tmp/review.ts",
    scriptHash: "hash24hash24hash24hash24",
    enabled: true,
    trusted: true,
    timeCreated: 1,
    timeUpdated: 2,
    meta: {
      name: "review",
      description: "Reviews the change",
      phases: [{ title: "plan" }, { title: "execute" }, { title: "report" }],
    },
  };
  const entry = toScriptWorkflowManagementDefinitionEntry(record);
  assert.equal(entry.description, "Reviews the change");
  assert.deepEqual(entry.phaseTitles, ["plan", "execute", "report"], "顺序即脚本声明顺序");
  assert.equal(entry.scope, "project");
  assert.equal(entry.scriptPath, "/tmp/review.ts");
});

test("定义可见性：builtin 恒可见；其余 scope 必须有实体脚本路径（§4.2 过滤口径）", () => {
  const base = {
    id: "script_x",
    name: "x",
    scriptHash: "h",
    enabled: true,
    trusted: true,
    timeCreated: 1,
    timeUpdated: 2,
    meta: { name: "x", description: "d", phases: [] },
  };
  assert.equal(
    isVisibleScriptWorkflowDefinition({ ...base, source: "builtin", scope: "builtin" }),
    true,
    "预定义工作流没有脚本路径也在清单内（UI 分「预定义」小节）",
  );
  assert.equal(
    isVisibleScriptWorkflowDefinition({
      ...base,
      source: "user",
      scope: "project",
      scriptPath: "/p.ts",
    }),
    true,
  );
  assert.equal(
    isVisibleScriptWorkflowDefinition({
      ...base,
      source: "user",
      scope: "user",
      scriptPath: "/u.ts",
    }),
    true,
  );
  assert.equal(
    isVisibleScriptWorkflowDefinition({ ...base, source: "user", scope: "project" }),
    false,
    "project 档无实体路径不可见",
  );
});
