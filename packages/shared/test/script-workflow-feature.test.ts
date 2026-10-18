import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCRIPT_WORKFLOW_MODE,
  SCRIPT_WORKFLOW_MODES,
  isScriptWorkflowModeEnabled,
  normalizeScriptWorkflowMode,
} from "../src/script-workflow-feature.js";
import {
  listScriptWorkflowDefinitionsPayloadSchema,
  listScriptWorkflowDefinitionsResultSchema,
  listScriptWorkflowRunsPayloadSchema,
  listScriptWorkflowRunsResultSchema,
  scriptWorkflowRunEntrySchema,
} from "../src/acode-protocol-v4/script-workflow-management.js";

// 行为规格见 apps/acode-cli/specs/script-workflow-management-surface.md §3/§4；
// 用例对应 spec §9 C7（非法值归一化）与 §10 shared 层测试计划。

test("取值域与 dwf 逐字对齐，缺省档是 onDemand（不是 dwf 的 alwaysOn）", () => {
  assert.deepEqual([...SCRIPT_WORKFLOW_MODES], ["disabled", "onDemand", "alwaysOn"]);
  assert.equal(DEFAULT_SCRIPT_WORKFLOW_MODE, "onDemand");
});

test("归一化：闭集内原样返回、容忍空白、非法/形状错误归 undefined（调用方落缺省档）", () => {
  for (const mode of SCRIPT_WORKFLOW_MODES) {
    assert.equal(normalizeScriptWorkflowMode(mode), mode);
  }
  assert.equal(normalizeScriptWorkflowMode("  onDemand  "), "onDemand");
  assert.equal(normalizeScriptWorkflowMode("ondemand"), undefined);
  assert.equal(normalizeScriptWorkflowMode("bogus"), undefined);
  assert.equal(normalizeScriptWorkflowMode(42), undefined);
  assert.equal(normalizeScriptWorkflowMode(null), undefined);
  assert.equal(normalizeScriptWorkflowMode(undefined), undefined);
});

test("布尔折叠：disabled 之外全开（onDemand 与 alwaysOn 现阶段行为相同）", () => {
  assert.equal(isScriptWorkflowModeEnabled("disabled"), false);
  assert.equal(isScriptWorkflowModeEnabled("onDemand"), true);
  assert.equal(isScriptWorkflowModeEnabled("alwaysOn"), true);
});

test("listScriptWorkflowRuns payload：workspace 必带、limit 有上限、statuses 是逻辑态闭集", () => {
  const workspace = { workspacePath: "/tmp/proj", workspaceKey: "/tmp/proj" };
  const ok = listScriptWorkflowRunsPayloadSchema.safeParse({ workspace });
  assert.equal(ok.success, true);

  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({}).success,
    false,
    "workspace 是必带键",
  );
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace, limit: 0 }).success,
    false,
  );
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace, limit: 201 }).success,
    false,
    "上限 200",
  );
  assert.equal(listScriptWorkflowRunsPayloadSchema.safeParse({ workspace, limit: 200 }).success, true);
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace, statuses: ["interrupted"] })
      .success,
    true,
    "interrupted 是逻辑态，允许作为过滤词",
  );
  assert.equal(
    listScriptWorkflowRunsPayloadSchema.safeParse({ workspace, statuses: ["stopped"] }).success,
    false,
    "stopped 是 dwf 词，不在脚本工作流逻辑态闭集",
  );
});

const VALID_RUN_ENTRY = {
  runId: "wf_run-1",
  name: "review",
  logicalStatus: "completed",
  cwd: "/tmp/proj",
  budgetSpent: 120,
  stats: {
    agentCalls: 2,
    cachedAgentCalls: 0,
    failedAgentCalls: 0,
    toolCalls: 5,
    tokensTotal: 120,
    usageIncomplete: false,
  },
  createdAt: 1_000,
  updatedAt: 2_000,
};

test("run 条目：completed 终态不携带 stopReason；cancelled 必须区分 user/processExited", () => {
  assert.equal(scriptWorkflowRunEntrySchema.safeParse(VALID_RUN_ENTRY).success, true);

  const cancelledUser = scriptWorkflowRunEntrySchema.safeParse({
    ...VALID_RUN_ENTRY,
    logicalStatus: "cancelled",
    stopReason: "user",
  });
  assert.equal(cancelledUser.success, true);

  const interrupted = scriptWorkflowRunEntrySchema.safeParse({
    ...VALID_RUN_ENTRY,
    logicalStatus: "interrupted",
    stopReason: "processExited",
  });
  assert.equal(interrupted.success, true);

  assert.equal(
    scriptWorkflowRunEntrySchema.safeParse({
      ...VALID_RUN_ENTRY,
      logicalStatus: "interrupted",
      stopReason: "user",
    }).success,
    false,
    "interrupted 只能映射 processExited（唯一映射，spec §4.1）",
  );
  assert.equal(
    scriptWorkflowRunEntrySchema.safeParse({
      ...VALID_RUN_ENTRY,
      logicalStatus: "completed",
      stopReason: "user",
    }).success,
    false,
    "其余终态不携带 stopReason（strict schema 下多键拒绝）",
  );
});

test("run 条目：stats 展平显式键，tokens blob 不透传", () => {
  assert.equal(
    scriptWorkflowRunEntrySchema.safeParse({
      ...VALID_RUN_ENTRY,
      stats: { ...VALID_RUN_ENTRY.stats, tokensTotal: -1 },
    }).success,
    false,
  );
  assert.equal(
    scriptWorkflowRunEntrySchema.safeParse({
      ...VALID_RUN_ENTRY,
      extraField: true,
    }).success,
    false,
    "strict schema：未知键拒绝",
  );
});

test("listScriptWorkflowRuns result：runs 数组 + truncated 布尔（A5 截断语义）", () => {
  const ok = listScriptWorkflowRunsResultSchema.safeParse({
    type: "listScriptWorkflowRuns",
    runs: [VALID_RUN_ENTRY],
    truncated: false,
  });
  assert.equal(ok.success, true);
  assert.equal(
    listScriptWorkflowRunsResultSchema.safeParse({
      type: "listScriptWorkflowRuns",
      runs: [],
      truncated: "no",
    }).success,
    false,
  );
});

test("listScriptWorkflowDefinitions payload/result：定义条目含 scope 四词与 phaseTitles", () => {
  const workspace = { workspacePath: "/tmp/proj", workspaceKey: "/tmp/proj" };
  assert.equal(
    listScriptWorkflowDefinitionsPayloadSchema.safeParse({ workspace }).success,
    true,
  );
  const result = listScriptWorkflowDefinitionsResultSchema.safeParse({
    type: "listScriptWorkflowDefinitions",
    definitions: [
      {
        id: "script_abc123",
        name: "review",
        description: "Reviews the change",
        phaseTitles: ["plan", "execute"],
        scope: "project",
        scriptHash: "hash24hash24hash24hash24",
        enabled: true,
        trusted: true,
        timeCreated: 1,
        timeUpdated: 2,
      },
    ],
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    listScriptWorkflowDefinitionsResultSchema.safeParse({
      type: "listScriptWorkflowDefinitions",
      definitions: [{ ...result.data.definitions[0], scope: "nonsense" }],
    }).success,
    false,
    "scope 是四词闭集（builtin/explicit/project/user）",
  );
});
