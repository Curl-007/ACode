// scriptWorkflowMode 三档门的 CLI 侧落点：注册门（合取）、reminder 门、极性推导与
// shared/contracts 词表一致性。
// 依据：apps/acode-cli/specs/script-workflow-management-surface.md §4.4/§4.5，验收 C1-C3/C6。
//
// dwf 总闸（includeDynamicWorkflow / dynamicWorkflowEnabled）与脚本工作流开关
// （includeScriptWorkflow / scriptWorkflowEnabled）是两道独立的门，任一显式 false 即下架
// RunWorkflow；缺席即开启（缺席 = 调用方不参与门控）。

import assert from "node:assert/strict";
import test from "node:test";

const CORE = "../packages/core/src";
const SHARED = "../../../packages/shared/src";

function makeRegistry() {
  const entries = new Map();
  return {
    entries,
    registry: { register: (entry) => entries.set(entry.metadata.name, entry) },
  };
}

const DWF_ELEVEN = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "ListModels",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "FillWorkflowHole",
];

const PORT_ON = { includeWorkflow: true };

// ---------------------------------------------------------------------------
// 注册门（C1/C2/C6：九组合矩阵的工具面答案）
// ---------------------------------------------------------------------------

test("注册门：dwf 开 × script 关 → 只下架 RunWorkflow，dwf 十一个全在", async () => {
  const { registerBuiltInTools } = await import(`${CORE}/tool/handlers/index.ts`);
  const reg = makeRegistry();
  registerBuiltInTools(reg.registry, { ...PORT_ON, includeScriptWorkflow: false });
  assert.ok(!reg.entries.has("RunWorkflow"), "script 门显式 false 必须下架 RunWorkflow");
  for (const name of DWF_ELEVEN) {
    assert.ok(reg.entries.has(name), `script 门不碰 dwf 工具：${name} 必须保留`);
  }
});

test("注册门：dwf 关 × script 开/缺席 → 两套全关（GATED 名单合取，现状不变）", async () => {
  const { registerBuiltInTools } = await import(`${CORE}/tool/handlers/index.ts`);
  for (const scriptGate of [undefined, true]) {
    const reg = makeRegistry();
    registerBuiltInTools(reg.registry, {
      ...PORT_ON,
      includeDynamicWorkflow: false,
      includeScriptWorkflow: scriptGate,
    });
    assert.ok(
      !reg.entries.has("RunWorkflow"),
      `dwf 总闸关时 RunWorkflow 必须下架（script=${scriptGate}）`,
    );
    for (const name of DWF_ELEVEN) {
      assert.ok(!reg.entries.has(name), `dwf 总闸关时 ${name} 必须下架（script=${scriptGate}）`);
    }
  }
});

test("注册门：两门都开/缺席 → 全部保留（C1 缺省档无回归基线）", async () => {
  const { registerBuiltInTools } = await import(`${CORE}/tool/handlers/index.ts`);
  for (const gates of [
    {},
    { includeScriptWorkflow: true },
    { includeDynamicWorkflow: true },
    { includeDynamicWorkflow: true, includeScriptWorkflow: true },
  ]) {
    const reg = makeRegistry();
    registerBuiltInTools(reg.registry, { ...PORT_ON, ...gates });
    assert.ok(reg.entries.has("RunWorkflow"), `gates=${JSON.stringify(gates)}`);
    for (const name of DWF_ELEVEN) {
      assert.ok(reg.entries.has(name), `gates=${JSON.stringify(gates)} ${name}`);
    }
  }
});

test("极性推导：resolveRuntimeScriptWorkflowToolsIncluded 缺席即开启，显式 false 才关", async () => {
  const { resolveRuntimeScriptWorkflowToolsIncluded } = await import(
    `${CORE}/runtime/helpers/tool-allowlist.ts`
  );
  assert.equal(resolveRuntimeScriptWorkflowToolsIncluded({}), true);
  assert.equal(resolveRuntimeScriptWorkflowToolsIncluded({ scriptWorkflowEnabled: true }), true);
  assert.equal(resolveRuntimeScriptWorkflowToolsIncluded({ scriptWorkflowEnabled: false }), false);
});

// ---------------------------------------------------------------------------
// reminder 门（C2：disabled 档不注入）
// ---------------------------------------------------------------------------

test("reminder 门：两道门合取，任一显式 false 即不注入；缺席保留", async () => {
  const { shouldEmitUltracodeKeywordReminder } = await import(
    `${CORE}/runtime/helpers/ultracode-keyword.ts`
  );
  const entries = [
    {
      message: { content: "please ultracode this", role: "user" },
      metadata: { source: "real_user" },
    },
  ];
  const base = { entries };
  assert.equal(shouldEmitUltracodeKeywordReminder(base), true);
  assert.equal(shouldEmitUltracodeKeywordReminder({ ...base, dynamicWorkflowEnabled: true }), true);
  assert.equal(shouldEmitUltracodeKeywordReminder({ ...base, scriptWorkflowEnabled: true }), true);
  assert.equal(
    shouldEmitUltracodeKeywordReminder({ ...base, scriptWorkflowEnabled: false }),
    false,
    "dwf 开、script 关：工具没注册，reminder 不许把模型指向不存在的 RunWorkflow",
  );
  assert.equal(
    shouldEmitUltracodeKeywordReminder({ ...base, dynamicWorkflowEnabled: false }),
    false,
    "dwf 总闸关：现状语义保留",
  );
  assert.equal(
    shouldEmitUltracodeKeywordReminder({
      ...base,
      dynamicWorkflowEnabled: false,
      scriptWorkflowEnabled: false,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// /ultracode 命令展开门（C2：目录之外用户仍可手打命令名，展开必须同结论）
// ---------------------------------------------------------------------------

test("/ultracode 展开门：scriptWorkflowEnabled === false 时不展开；/workflow 只看 dwf 总闸", async () => {
  const { resolveACodeBuiltinPromptCommand } =
    await import("../packages/bootstrap/src/builtin-prompt-command.ts");
  const open = { dynamicWorkflowEnabled: true, scriptWorkflowEnabled: true };
  assert.match(
    resolveACodeBuiltinPromptCommand("/ultracode audit the auth layer", open) ?? "",
    /RunWorkflow/,
    "两门全开时正常展开",
  );
  assert.equal(
    resolveACodeBuiltinPromptCommand("/ultracode audit the auth layer", {
      dynamicWorkflowEnabled: true,
      scriptWorkflowEnabled: false,
    }),
    undefined,
    "dwf 开、script 关：/ultracode 不展开（工具不存在时命令展开是说谎）",
  );
  assert.equal(
    resolveACodeBuiltinPromptCommand("/ultracode audit the auth layer", {
      dynamicWorkflowEnabled: false,
      scriptWorkflowEnabled: true,
    }),
    undefined,
    "dwf 总闸关：现状语义保留",
  );
  assert.match(
    resolveACodeBuiltinPromptCommand("/workflow plan a refactor", open) ?? "",
    /CreateWorkflow/,
    "/workflow 只看 dwf 总闸，不受 scriptWorkflowEnabled 影响",
  );
  assert.match(
    resolveACodeBuiltinPromptCommand("/workflow plan a refactor", {
      dynamicWorkflowEnabled: true,
      scriptWorkflowEnabled: false,
    }) ?? "",
    /CreateWorkflow/,
    "script 关不下架 /workflow（dwf 工具面仍由总闸单门管，§4.5）",
  );
});

// ---------------------------------------------------------------------------
// 技能面门矩阵（P2 修复：第二道 script 门此前未接进技能面，dwf 开 × script 关时
// RunWorkflow 工具/命令/reminder 三面已下架，script-workflows SKILL.md 仍可加载）
// ---------------------------------------------------------------------------

const FAKE_SKILL_ROOT = { path: "/bundled", scope: "builtin", source: "core", priority: 0 };

test("技能面门矩阵：script=false 只剔 RunWorkflow 技能；dwf=false 剔两份；缺席全保留", async () => {
  const { collectWorkflowDisabledSkillPaths } =
    await import("../packages/cli-workflow/src/dynamic-workflow-gate.ts");
  // 期望路径与生产同构（生产用 node:path join，测试必须跨平台等价，不能硬编码分隔符）。
  const { join } = await import("node:path");
  const manifest = (root, skill) => join(root, skill, "SKILL.md");
  const dwfSkill = manifest("/bundled", "dynamic-workflows");
  const scriptSkill = manifest("/bundled", "script-workflows");
  const extraScriptSkill = manifest("/extra", "script-workflows");

  // script 门关、dwf 缺席：只剔 RunWorkflow 技能——dwf 十工具还在，dynamic-workflows
  // 技能必须保留（少剔和错剔都会让技能面与工具面结论分裂）。
  assert.deepEqual(
    collectWorkflowDisabledSkillPaths({
      bundledSkillRoots: [FAKE_SKILL_ROOT],
      scriptWorkflowEnabled: false,
    }),
    [scriptSkill],
  );
  // dwf 总闸关：两份全剔（现状语义保留）。
  assert.deepEqual(
    [
      ...collectWorkflowDisabledSkillPaths({
        bundledSkillRoots: [FAKE_SKILL_ROOT],
        dynamicWorkflowEnabled: false,
      }),
    ].sort(),
    [dwfSkill, scriptSkill].sort(),
  );
  // 两门都关：并集去重（script-workflows 的路径在两份名单里都出现）。
  const both = collectWorkflowDisabledSkillPaths({
    bundledSkillRoots: [FAKE_SKILL_ROOT],
    dynamicWorkflowEnabled: false,
    scriptWorkflowEnabled: false,
  });
  assert.equal(both.length, 2, "并集去重，同一 SKILL.md 不得重复登记");
  assert.deepEqual([...both].sort(), [dwfSkill, scriptSkill].sort());
  // 极性与注册门一致：只有显式 false 才剔（缺席 = 不参与门控 = 全保留）。
  for (const flags of [
    {},
    { dynamicWorkflowEnabled: true },
    { scriptWorkflowEnabled: true },
    { dynamicWorkflowEnabled: true, scriptWorkflowEnabled: true },
  ]) {
    assert.deepEqual(
      collectWorkflowDisabledSkillPaths({ bundledSkillRoots: [FAKE_SKILL_ROOT], ...flags }),
      [],
      `flags=${JSON.stringify(flags)} 不得剔任何技能`,
    );
  }
  // 多 root 逐个展开，路径不存在的 root 只是永不命中的 Set 成员（无副作用）。
  assert.deepEqual(
    collectWorkflowDisabledSkillPaths({
      bundledSkillRoots: [FAKE_SKILL_ROOT, { ...FAKE_SKILL_ROOT, path: "/extra" }],
      scriptWorkflowEnabled: false,
    }),
    [scriptSkill, extraScriptSkill],
  );
});

test("技能面接线：create-app 的 skillPort disabledPaths 走两道开关的组合判定", async () => {
  // 接线钉子（source 级断言，同 script-workflow-orphan-reconcile.test.mjs 先例）：
  // 判定收在 dynamic-workflow-gate.ts，create-app 只传两面开关。
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../packages/bootstrap/src/app/create-app.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /collectWorkflowDisabledSkillPaths\(\{/);
  assert.match(
    source,
    /scriptWorkflowEnabled:\s*runtimeConfig\.scriptWorkflowEnabled/,
    "script 门必须参与技能面判定",
  );
  assert.doesNotMatch(
    source,
    /collectDynamicWorkflowDisabledSkillPaths\(/,
    "dwf 单门函数不再被 create-app 直接调用（矩阵收进组合判定）",
  );
});

// ---------------------------------------------------------------------------
// 词表一致性：shared 逻辑态 schema ⊇ contracts 物理词表 + interrupted（唯一映射的两侧）
// ---------------------------------------------------------------------------

test("shared 逻辑态词表 = contracts 物理六词 + interrupted（两侧独立声明，测试钉住一致）", async () => {
  const { SCRIPT_WORKFLOW_RUN_STATUSES } =
    await import("../packages/contracts/src/workflow/script.ts");
  const { scriptWorkflowLogicalStatusSchema } = await import(
    `${SHARED}/acode-protocol-v4/script-workflow-management.ts`
  );
  const logicalWords = scriptWorkflowLogicalStatusSchema.options;
  assert.deepEqual(
    logicalWords.filter((word) => word !== "interrupted").sort(),
    [...SCRIPT_WORKFLOW_RUN_STATUSES].sort(),
    "物理六词必须逐字出现在逻辑态闭集里（CHECK 约束词表 ↔ 协议词表）",
  );
  assert.deepEqual(
    [...logicalWords].sort(),
    ["cancelled", "completed", "failed", "interrupted", "paused", "pending", "running"],
    "逻辑态闭集恰好是六物理词 + interrupted（孤儿收敛投影）",
  );
});
