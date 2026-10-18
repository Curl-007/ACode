// specs/skills-bundled-visibility-and-official-cache-authority.md §七 S9：
// UI 纯函数投影——selectSkillsForScope / groupSkillsByPlugin / groupScopedSkillsBySource /
// filterSkillsForProvider 对 bundled scope 的行为（I4/I5）。
// SkillsSection 组件级渲染无测试基建，组件行为由本表 + typecheck 覆盖（§八诚实登记）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillSummary } from "@acode/shared";
import { filterSkillsForProvider } from "../src/lib/skillSourceFilter.js";
import {
  groupScopedSkillsBySource,
  selectSkillsForScope,
} from "../src/settings/pluginCapabilityProjection.js";
import { groupSkillsByPlugin } from "../src/settings/pluginManagedResourceGroups.js";

function skillOf(partial: Pick<SkillSummary, "scope"> & Partial<SkillSummary>): SkillSummary {
  const name = partial.name ?? `skill-${partial.scope}`;
  const dir = partial.path ?? `/fixture/${partial.scope}/${name}/SKILL.md`;
  return {
    id: partial.id ?? `glm:${partial.scope}:${name}:000000000000`,
    name,
    description: partial.description ?? `${name} description`,
    body: partial.body ?? `${name} body`,
    path: dir,
    sourcePath: dir,
    scope: partial.scope,
    enabled: partial.enabled ?? true,
    ...(partial.pluginName ? { pluginName: partial.pluginName } : {}),
    ...(partial.pluginId ? { pluginId: partial.pluginId } : {}),
  };
}

describe("selectSkillsForScope（S9：bundled 跨双 tab 展示）", () => {
  const skills = [
    skillOf({ scope: "workspace", name: "project-skill" }),
    skillOf({ scope: "user", name: "personal-skill" }),
    skillOf({ scope: "plugin", name: "plugin-skill", pluginName: "p1", pluginId: "p1@m" }),
    skillOf({ scope: "bundled", name: "built-in-skill" }),
  ];
  const enabledPlugins = [{ id: "p1@m", name: "p1", enabled: true }];

  it("user scope：保留 user 与 plugin（启用）与 bundled，排除 workspace", () => {
    const result = selectSkillsForScope(skills, enabledPlugins, "user");
    assert.deepEqual(result.map((skill) => skill.name).sort(), [
      "built-in-skill",
      "personal-skill",
      "plugin-skill",
    ]);
  });

  it("workspace scope：保留 workspace 与 plugin（启用）与 bundled，排除 user", () => {
    const result = selectSkillsForScope(skills, enabledPlugins, "workspace");
    assert.deepEqual(result.map((skill) => skill.name).sort(), [
      "built-in-skill",
      "plugin-skill",
      "project-skill",
    ]);
  });
});

describe("groupSkillsByPlugin（S9：bundled 不进 local 桶）", () => {
  it("bundled 条目进入独立 bundled 桶，不出现在 local（已安装）桶", () => {
    const { local, bundled, plugin } = groupSkillsByPlugin(
      [
        skillOf({ scope: "user", name: "personal-skill" }),
        skillOf({ scope: "bundled", name: "built-in-skill" }),
        skillOf({ scope: "plugin", name: "plugin-skill", pluginName: "p1" }),
      ],
      "",
    );
    assert.deepEqual(
      local.map((skill) => skill.name),
      ["personal-skill"],
    );
    assert.deepEqual(
      bundled.map((skill) => skill.name),
      ["built-in-skill"],
    );
    assert.deepEqual(
      plugin.map((skill) => skill.name),
      ["plugin-skill"],
    );
  });
});

describe("groupScopedSkillsBySource（S9：bundled 独立组与分组顺序）", () => {
  it("产出 id=bundled 的独立组，顺序 direct → bundled → plugin:N；bundled 为空时无该组", () => {
    const groups = groupScopedSkillsBySource(
      [
        skillOf({ scope: "user", name: "b-personal" }),
        skillOf({ scope: "bundled", name: "built-in-skill" }),
        skillOf({ scope: "plugin", name: "plugin-skill", pluginName: "zeta", pluginId: "zeta@m" }),
      ],
      "Workspace",
      "Built-in skills",
    );
    assert.deepEqual(
      groups.map((group) => group.id),
      ["direct", "bundled", "plugin:zeta@m"],
    );
    assert.equal(groups[1]?.label, "Built-in skills");
    assert.equal(groups[1]?.source, "bundled");
    assert.deepEqual(
      groups[1]?.skills.map((skill) => skill.name),
      ["built-in-skill"],
    );

    const withoutBundled = groupScopedSkillsBySource(
      [skillOf({ scope: "user", name: "b-personal" })],
      "Workspace",
      "Built-in skills",
    );
    assert.deepEqual(
      withoutBundled.map((group) => group.id),
      ["direct"],
    );
  });
});

describe("filterSkillsForProvider（S9：includeBundled 默认排除、显式放行）", () => {
  // bundled 条目无论 id/路径形状默认一律排除（isAcodeSkill 对 scope==="bundled" 显式闸）：
  // services list 的真实 bundled 条目 id 带 glm: 前缀，若无此显式闸会被 glm: 前缀条件
  // 误放行进 Composer `$` 面板（违反用户裁决 2）——两个 bundled fixture 分别覆盖
  // 「glm: 前缀 id」与「非 glm id + 非 glm 路径」两种形状。
  const skills = [
    skillOf({
      scope: "user",
      name: "personal-skill",
      path: "/home/u/.acode/skills/personal-skill/SKILL.md",
    }),
    skillOf({
      scope: "plugin",
      name: "plugin-skill",
      pluginName: "p1",
      path: "/data/cli/plugins/cache/official/p1/0.1.0/skills/plugin-skill/SKILL.md",
    }),
    skillOf({
      scope: "bundled",
      name: "built-in-skill",
      id: "ext:bundled:built-in-skill:000000000000",
      path: "/app/packages/bundled-skills/skills/built-in-skill/SKILL.md",
    }),
    skillOf({
      scope: "bundled",
      name: "glm-id-bundled",
      path: "/app/packages/bundled-skills/skills/glm-id-bundled/SKILL.md",
    }),
  ];

  it("默认（不传 options）：bundled 一律排除，无论 id 前缀与路径形状（裁决 2 双保险闸）", () => {
    const result = filterSkillsForProvider(skills, "glm");
    assert.deepEqual(result.map((skill) => skill.name).sort(), ["personal-skill", "plugin-skill"]);
  });

  it("includeBundled: false 显式传入：与默认一致", () => {
    const result = filterSkillsForProvider(skills, "glm", { includeBundled: false });
    assert.deepEqual(result.map((skill) => skill.name).sort(), ["personal-skill", "plugin-skill"]);
  });

  it("includeBundled: true：bundled 放行（设置页分组数据源）", () => {
    const result = filterSkillsForProvider(skills, "glm", { includeBundled: true });
    assert.deepEqual(result.map((skill) => skill.name).sort(), [
      "built-in-skill",
      "glm-id-bundled",
      "personal-skill",
      "plugin-skill",
    ]);
  });
});
