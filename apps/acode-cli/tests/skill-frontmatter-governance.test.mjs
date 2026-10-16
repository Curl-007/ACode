import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 技能 frontmatter 治理键解析验收（specs/skill-frontmatter-governance.md R1-R3/R6-R8/R10）。
 *
 * 两条路径：① parseSkillFrontmatterGovernance 直接单测（条目文法/转义/fail-closed）；
 * ② NodeSkillAdapter.discoverSkills 端到端（YAML 块列表形态、safeToAutoLoad、诊断流）。
 */

const { parseSkillFrontmatterGovernance } =
  await import("../packages/adapters/src/skills/frontmatter-governance.ts");
const { createNodeSkillAdapter } = await import("../packages/adapters/src/skills/index.ts");

const SKILL_DIR = join(tmpdir(), "acode-skill-gov-fixture").split("\\").join("/");

function parse(values, extra = {}) {
  const diagnostics = [];
  const governance = parseSkillFrontmatterGovernance({
    frontmatter: extra.frontmatter ?? null,
    values,
    skillDirectory: extra.skillDirectory ?? SKILL_DIR,
    skillName: extra.skillName ?? "fixture",
    path: extra.path ?? join(SKILL_DIR, "SKILL.md"),
    diagnostics,
  });
  return { governance, diagnostics };
}

test("R2 实参级规则：调用形/裸名/空 content/通配 content/转义括号", () => {
  const { governance, diagnostics } = parse({
    "allowed-tools":
      "Bash(node x.mjs status), Read(/abs/**), Edit(runs/*/proposed/*.md), " +
      "Skill(plugin:skill *), Agent(plugin:agent), mcp__srv__tool, Bash(), Edit(*), " +
      "Bash(echo \\(x\\))",
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(governance.allowedTools, [
    { toolName: "Bash", ruleContent: "node x.mjs status" },
    { toolName: "Read", ruleContent: "/abs/**" },
    { toolName: "Edit", ruleContent: "runs/*/proposed/*.md" },
    // 括号内空格不是分裂点：Skill(名 *) 整体是规则内容
    { toolName: "Skill", ruleContent: "plugin:skill *" },
    { toolName: "Agent", ruleContent: "plugin:agent" },
    { toolName: "mcp__srv__tool" },
    // 空 content 与 `*` content 都收敛为工具级规则
    { toolName: "Bash" },
    { toolName: "Edit" },
    // 转义括号反转义进 ruleContent
    { toolName: "Bash", ruleContent: "echo (x)" },
  ]);
});

test("R2 括号内逗号不分裂；`*` 独立条目按全工具通配原样登记", () => {
  const { governance } = parse({ "allowed-tools": "Bash(cmd a, b), *" });
  assert.deepEqual(governance.allowedTools, [
    { toolName: "Bash", ruleContent: "cmd a, b" },
    { toolName: "*" },
  ]);
});

test("R2 占位符三拼写替换为技能目录（正斜杠归一）", () => {
  const { governance } = parse(
    {
      "allowed-tools":
        "Bash(node ${ACODE_SKILL_DIR}/s/x.mjs run), Read(/${CLAUDE_SKILL_DIR}/**), " +
        "Edit(${SKILL_DIR}/out/*)",
    },
    { skillDirectory: "C:\\skills\\demo" },
  );
  assert.deepEqual(governance.allowedTools, [
    { toolName: "Bash", ruleContent: "node C:/skills/demo/s/x.mjs run" },
    { toolName: "Read", ruleContent: "/C:/skills/demo/**" },
    { toolName: "Edit", ruleContent: "C:/skills/demo/out/*" },
  ]);
});

test("R3 allow 畸形条目丢弃+warn；deny 畸形条目降级工具级+warn（fail-closed）", () => {
  // 块列表形态精确控制条目边界（内联 CSV 的括号内逗号不分裂，见上一用例）
  const { governance, diagnostics } = parse(
    {},
    {
      frontmatter: [
        "allowed-tools:",
        "  - Bash(ok cmd)",
        "  - Edit(.specs/**",
        "disallowed-tools:",
        "  - Edit(.specs/**",
        "  - mcp__srv__tool(a b",
        "  - Bash(a)b",
      ].join("\n"),
    },
  );
  assert.deepEqual(governance.allowedTools, [{ toolName: "Bash", ruleContent: "ok cmd" }]);
  // deny 侧：畸形但工具名可救援 → 工具级 deny（宁过度禁止不静默放行）
  assert.deepEqual(governance.disallowedTools, [
    { toolName: "Edit" },
    { toolName: "mcp__srv__tool" },
    { toolName: "Bash" },
  ]);
  const dropped = diagnostics.filter((d) => d.code === "skill_tool_rule_dropped");
  assert.equal(dropped.length, 4);
  assert.ok(dropped.every((d) => d.severity === "warning"));
  assert.ok(dropped[0].message.includes("grants nothing"));
  assert.ok(dropped[1].message.includes("downgraded to a tool-level deny on Edit"));
});

test("R3 不可解析占位符：allow 丢弃、deny 降级；整键非串非列表不生效", () => {
  const { governance, diagnostics } = parse({
    "allowed-tools": "Read(/${SOME_OTHER_DIR}/**)",
    "disallowed-tools": "Edit(${NOPE}/x/**)",
  });
  assert.equal(governance.allowedTools, undefined);
  assert.deepEqual(governance.disallowedTools, [{ toolName: "Edit" }]);
  assert.equal(diagnostics.filter((d) => d.code === "skill_tool_rule_dropped").length, 2);
  assert.ok(diagnostics[0].message.includes("unresolved placeholder"));
});

test("R6 双向门：布尔词闭集、非法值 warn+缺省、只在偏离缺省时落字段", () => {
  assert.equal(
    parse({ "disable-model-invocation": "true" }).governance.disableModelInvocation,
    true,
  );
  for (const word of ["yes", "ON", "1"]) {
    assert.equal(
      parse({ "disable-model-invocation": word }).governance.disableModelInvocation,
      true,
    );
  }
  // 缺省方向不落字段（false 不出现）
  assert.equal(parse({ "disable-model-invocation": "false" }).governance, undefined);
  assert.equal(parse({ "user-invocable": "false" }).governance.userInvocable, false);
  assert.equal(parse({ "user-invocable": "true" }).governance, undefined);
  const { governance, diagnostics } = parse({ "disable-model-invocation": "maybe" });
  assert.equal(governance, undefined);
  assert.equal(diagnostics[0].code, "skill_frontmatter_value_invalid");
});

test("R7 shell 闭集：大小写不敏感、非法值 warn+回落缺席", () => {
  assert.equal(parse({ shell: "PowerShell" }).governance.shell, "powershell");
  assert.equal(parse({ shell: "bash" }).governance.shell, "bash");
  const { governance, diagnostics } = parse({ shell: "cmd" });
  assert.equal(governance, undefined);
  assert.equal(diagnostics[0].code, "skill_frontmatter_value_invalid");
  assert.ok(diagnostics[0].message.includes("falling back to bash"));
});

test("R8 argument-hint 透传、arguments 过滤纯数字、effort 闭集/别名/整数/非法", () => {
  const { governance } = parse({
    "argument-hint": "[app folder] [spec words | fix]",
    arguments: "target mode 3 extra",
    effort: "med",
  });
  assert.equal(governance.argumentHint, "[app folder] [spec words | fix]");
  assert.deepEqual(governance.argumentNames, ["target", "mode", "extra"]);
  assert.equal(governance.effort, "medium");
  assert.equal(parse({ effort: "xhigh" }).governance.effort, "xhigh");
  assert.equal(parse({ effort: "7" }).governance.effort, 7);
  const invalid = parse({ effort: "turbo" });
  assert.equal(invalid.governance, undefined);
  assert.equal(invalid.diagnostics[0].code, "skill_frontmatter_value_invalid");
});

test("R10 端到端：YAML 块列表形态解析、safeToAutoLoad 键集、诊断随 outcome 回流", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-skill-gov-"));
  try {
    // 治理键全声明（块列表 + 双向门 + shell/effort）→ safeToAutoLoad 保持 true
    await mkdir(join(root, "listed"), { recursive: true });
    await writeFile(
      join(root, "listed", "SKILL.md"),
      [
        "---",
        "name: listed",
        "description: block-list governance fixture",
        "allowed-tools:",
        "  - Bash(node ${ACODE_SKILL_DIR}/scripts/x.mjs status)",
        '  - "Read(/${CLAUDE_SKILL_DIR}/**)"',
        "  - mcp__plugin_demo_s__tool",
        "disallowed-tools:",
        "  - Edit(.demo/specs/**)",
        "paths:",
        "  - src/**/*.ts",
        "  - docs/**",
        "disable-model-invocation: true",
        "shell: powershell",
        "argument-hint: [target]",
        "effort: high",
        "hooks:",
        "  PreToolUse: []",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    );
    // 未知键 → safeToAutoLoad=false（现状策略保持）；插件组件键同样保守
    await mkdir(join(root, "unknownkey"), { recursive: true });
    await writeFile(
      join(root, "unknownkey", "SKILL.md"),
      "---\nname: unknownkey\ndescription: d\nvendor-extra: 1\n---\n\nbody\n",
    );
    await mkdir(join(root, "componentkey"), { recursive: true });
    await writeFile(
      join(root, "componentkey", "SKILL.md"),
      "---\nname: componentkey\ndescription: d\nmcpServers: {}\n---\n\nbody\n",
    );
    // allow 畸形 → warning 诊断进 outcome，技能仍可发现（fail-closed 不阻断加载）
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(
      join(root, "broken", "SKILL.md"),
      "---\nname: broken\ndescription: d\nallowed-tools: Bash(unclosed\n---\n\nbody\n",
    );

    const adapter = createNodeSkillAdapter();
    const outcome = await adapter.discoverSkills({
      workingDirectory: root,
      roots: [{ path: root, scope: "project", source: "agents", priority: 1 }],
    });
    const byName = new Map(outcome.skills.map((skill) => [skill.name, skill]));
    assert.deepEqual([...byName.keys()].sort(), ["broken", "componentkey", "listed", "unknownkey"]);

    const listed = byName.get("listed");
    const listedDir = join(root, "listed").split("\\").join("/");
    assert.equal(listed.safeToAutoLoad, true);
    assert.deepEqual(listed.governance.allowedTools, [
      { toolName: "Bash", ruleContent: `node ${listedDir}/scripts/x.mjs status` },
      { toolName: "Read", ruleContent: `/${listedDir}/**` },
      { toolName: "mcp__plugin_demo_s__tool" },
    ]);
    assert.deepEqual(listed.governance.disallowedTools, [
      { toolName: "Edit", ruleContent: ".demo/specs/**" },
    ]);
    // R5：尾 /** 剥离、`**` 段保留
    assert.deepEqual(listed.governance.pathTriggers, ["src/**/*.ts", "docs"]);
    assert.equal(listed.governance.disableModelInvocation, true);
    assert.equal(listed.governance.userInvocable, undefined);
    assert.equal(listed.governance.shell, "powershell");
    assert.equal(listed.governance.argumentHint, "[target]");
    assert.equal(listed.governance.effort, "high");

    assert.equal(byName.get("unknownkey").safeToAutoLoad, false);
    assert.equal(byName.get("unknownkey").governance, undefined);
    assert.equal(byName.get("componentkey").safeToAutoLoad, false);

    const broken = byName.get("broken");
    assert.ok(broken, "畸形规则不阻断技能发现");
    assert.equal(broken.governance, undefined);
    const dropped = outcome.diagnostics.filter((d) => d.code === "skill_tool_rule_dropped");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].severity, "warning");
    assert.equal(dropped[0].skillName, "broken");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R10 别名 disallowedTools 与流式列表 [a, b] 形态", () => {
  const { governance } = parse({ disallowedTools: "[Edit(x/**), Bash(rm -rf /)]" });
  assert.deepEqual(governance.disallowedTools, [
    { toolName: "Edit", ruleContent: "x/**" },
    { toolName: "Bash", ruleContent: "rm -rf /" },
  ]);
});
