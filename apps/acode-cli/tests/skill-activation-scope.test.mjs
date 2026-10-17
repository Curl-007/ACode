import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 技能激活期作用域验收（specs/skill-frontmatter-governance.md R4/R6）：
 * 历史判据收集（成功=非错误 tool 结果）、作用域纯函数构建（并集/去重/失活即清）、
 * per-session store（refresh/snapshot/clear）、模型清单双向门过滤与 when_to_use 拼接回归。
 */

const { collectLoadedSkillNames } = await import("../packages/core/src/agent/loaded-skills.ts");
const { buildSkillActivationScope, collectSkillActivationScope, createSkillActivationScopeStore } =
  await import("../packages/core/src/agent/skill-activation-scope.ts");
const { buildSkillsSection } = await import("../packages/core/src/context/sections/skills.ts");

function assistantSkillCall(id, input) {
  return {
    kind: "message",
    message: { role: "assistant", toolCalls: [{ id, name: "Skill", input }] },
  };
}

function toolResult(id, isError = false) {
  return { kind: "message", message: { role: "tool", toolCallId: id, isError } };
}

const CATALOG = [
  {
    name: "alpha",
    qualifiedName: "demo:alpha",
    governance: {
      allowedTools: [{ toolName: "Bash", ruleContent: "node x.mjs" }, { toolName: "Read" }],
      disallowedTools: [{ toolName: "Edit", ruleContent: ".specs/**" }],
    },
  },
  { name: "delta" }, // 无 governance：贡献空集
  {
    name: "gated",
    description: "gated skill",
    governance: { disableModelInvocation: true },
  },
  {
    name: "modelonly",
    description: "model-only skill",
    governance: { userInvocable: false },
  },
];

test("R4 collectLoadedSkillNames：成功判据/双输入形/错误结果不算/首载序去重", () => {
  const entries = [
    assistantSkillCall("c1", { skill: "alpha" }),
    toolResult("c1"),
    // 错误结果不算加载（被拒/失败不授予激活期规则）
    assistantSkillCall("c2", { skill: "missing" }),
    toolResult("c2", true),
    // 旧形 { name } 输入同样识别；attachment 条目跳过
    { kind: "attachment", content: "skills_listing" },
    assistantSkillCall("c3", { name: "demo:alpha" }),
    toolResult("c3"),
    assistantSkillCall("c4", { skill: "delta" }),
    toolResult("c4"),
  ];
  // 名字取调用原文（name 或 qualifiedName），目录身份解析在 scope 构建期
  assert.deepEqual(collectLoadedSkillNames(entries), ["alpha", "demo:alpha", "delta"]);
  // 只发出未落地（无 tool 结果）不算
  assert.deepEqual(collectLoadedSkillNames([assistantSkillCall("c9", { skill: "alpha" })]), []);
});

test("R4 buildSkillActivationScope：并集去重、name/qualifiedName 同技能只计一次、空历史空作用域", () => {
  const scope = buildSkillActivationScope({
    loadedSkillNames: ["alpha", "demo:alpha", "delta", "ghost"],
    catalog: CATALOG,
  });
  assert.deepEqual(scope.allow, [
    { toolName: "Bash", ruleContent: "node x.mjs" },
    { toolName: "Read" },
  ]);
  assert.deepEqual(scope.deny, [{ toolName: "Edit", ruleContent: ".specs/**" }]);
  assert.deepEqual(scope.skills, ["alpha"]); // delta 无 governance、ghost 不在目录
  const empty = buildSkillActivationScope({ loadedSkillNames: [], catalog: CATALOG });
  assert.deepEqual(empty.allow, []);
  assert.deepEqual(empty.deny, []);
  assert.deepEqual(empty.skills, []);
  // 失活即清：历史不再含调用（compaction 后）→ 重算出局
  const after = collectSkillActivationScope(
    [assistantSkillCall("c1", { skill: "alpha" })],
    CATALOG,
  );
  assert.deepEqual(after.skills, []);
});

test("R4 store：refresh/snapshot/clear，未登记会话返回共享空作用域", () => {
  const store = createSkillActivationScopeStore();
  const scope = buildSkillActivationScope({ loadedSkillNames: ["alpha"], catalog: CATALOG });
  store.refresh("s1", scope);
  assert.deepEqual(store.snapshot("s1").allow, scope.allow);
  assert.deepEqual(store.snapshot("s2").skills, []);
  // 空作用域 refresh 不落条目（Map 不随会话轮转膨胀）
  store.refresh("s1", { allow: [], deny: [], skills: [] });
  assert.deepEqual(store.snapshot("s1").allow, []);
  store.refresh("s1", scope);
  store.clear("s1");
  assert.deepEqual(store.snapshot("s1").deny, []);
  store.refresh("s2", scope);
  store.clearAll();
  assert.deepEqual(store.snapshot("s2").allow, []);
});

function skillListing(name, extra = {}) {
  return {
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    directory: `/skills/${name}`,
    rootPath: "/skills",
    scope: "project",
    source: "agents",
    safeToAutoLoad: true,
    frontmatterKeys: ["name", "description"],
    ...extra,
  };
}

test("R6/R9 模型清单：disable-model-invocation 过滤、user-invocable:false 不过滤、whenToUse 拼接", () => {
  const outcome = {
    skills: [
      skillListing("plain", { whenToUse: "use when testing" }),
      skillListing("gated", { governance: { disableModelInvocation: true } }),
      skillListing("modelonly", { governance: { userInvocable: false } }),
    ],
    diagnostics: [],
    totalDiscovered: 3,
  };
  const section = buildSkillsSection({ outcome });
  assert.ok(section);
  // R9：when_to_use 成为清单描述一部分（`description - whenToUse` 拼接现状回归）
  assert.ok(section.content.includes("plain description - use when testing"));
  // R6：仅用户可敲的技能对模型不可发现；仅模型可调的技能保留在模型清单
  assert.ok(!section.content.includes("gated"));
  assert.ok(section.content.includes("modelonly"));
});

test("R6 模型清单：全部被门过滤时返回 null（不产出空段）", () => {
  const section = buildSkillsSection({
    outcome: {
      skills: [skillListing("gated", { governance: { disableModelInvocation: true } })],
      diagnostics: [],
      totalDiscovered: 1,
    },
  });
  assert.equal(section, null);
});
