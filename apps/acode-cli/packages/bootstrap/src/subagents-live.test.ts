import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginMetadata } from "@acode/contracts";
import { createAgentStateId, createPluginAgentStateId, type ModelSelection } from "@acode/shared";
import {
  applyPluginAgentModelOverrides,
  loadCurrentACodeAgentProfiles,
  loadPluginAgentProfiles,
  loadACodeAgentProfiles,
  ACodeAgentConfigError,
} from "./subagents.js";

const general: ModelSelection = {
  providerId: "provider",
  modelId: "general-model",
  options: { reasoningLevel: "medium" },
};
const dedicated: ModelSelection = {
  providerId: "provider",
  modelId: "team-model",
  options: { reasoningLevel: "high" },
};

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "subagents-live-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAgentMarkdown(
  directory: string,
  fileName: string,
  frontmatter: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, fileName);
  await writeFile(filePath, `---\n${frontmatter}\n---\n\nbody\n`, "utf8");
  return filePath;
}

function docFrontmatter(model: string, thoughtLevel: string): string {
  return [
    "name: Doc",
    "description: 文档编写 Agent",
    `model: ${model}`,
    `thoughtLevel: ${thoughtLevel}`,
  ].join("\n");
}

test("每次新建子 Agent 都重新读取最新 Doc frontmatter，不缓存旧模型", async () => {
  await withTempRoot(async (storageRoot) => {
    const workingDirectory = join(storageRoot, "workspace");
    const agentsDir = join(storageRoot, "agents");
    await writeAgentMarkdown(agentsDir, "doc.md", docFrontmatter("provider/model-a", "low"));

    const first = await loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory });
    const firstDoc = first.profiles.find((profile) => profile.name === "Doc");
    assert.ok(firstDoc, "Doc profile must be discoverable");
    assert.deepEqual(firstDoc.modelSelection, {
      providerId: "provider",
      modelId: "model-a",
      options: { reasoningLevel: "low" },
    });

    // 模拟设置页「应用」：同一文件被改写为另一个 provider/model/档位。
    await writeAgentMarkdown(agentsDir, "doc.md", docFrontmatter("other/model-b", "high"));
    const second = await loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory });
    const secondDoc = second.profiles.find((profile) => profile.name === "Doc");
    assert.ok(secondDoc);
    assert.deepEqual(secondDoc.modelSelection, {
      providerId: "other",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });

    // 先前派生的快照不受影响，且两次读取是相互独立的结果对象。
    assert.deepEqual(firstDoc.modelSelection, {
      providerId: "provider",
      modelId: "model-a",
      options: { reasoningLevel: "low" },
    });
    assert.notEqual(first.profiles, second.profiles);
  });
});

test("缺失的 agents 根目录与缺失的 state 文件是合法默认值", async () => {
  await withTempRoot(async (storageRoot) => {
    const outcome = await loadCurrentACodeAgentProfiles({
      storageRoot,
      workingDirectory: join(storageRoot, "workspace"),
    });
    assert.deepEqual(outcome.profiles, []);
    assert.deepEqual(outcome.builtInModelSelectionOverrides, {});
    assert.deepEqual(outcome.pluginAgentModelSelectionOverrides, {});
    assert.deepEqual(outcome.diagnostics, []);
  });
});

test("读取内置 general-purpose/Explore 覆盖与用户/项目 profile 的完整快照", async () => {
  await withTempRoot(async (storageRoot) => {
    const workingDirectory = join(storageRoot, "workspace");
    await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "doc.md",
      docFrontmatter("provider/model-a", "low"),
    );
    await writeAgentMarkdown(
      join(workingDirectory, ".acode", "agents"),
      "reviewer.md",
      [
        "name: Reviewer",
        "description: 评审 Agent",
        "model: provider/model-c",
        "thoughtLevel: medium",
      ].join("\n"),
    );
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        builtInModelSelectionOverrides: {
          "general-purpose": general,
          Explore: dedicated,
        },
        pluginAgentModelSelectionOverrides: {
          [createPluginAgentStateId("some-plugin@market", "helper")]: general,
        },
        disabledAgentIds: [],
      }),
      "utf8",
    );

    const outcome = await loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory });
    assert.deepEqual(outcome.builtInModelSelectionOverrides, {
      "general-purpose": general,
      Explore: dedicated,
    });
    assert.deepEqual(outcome.pluginAgentModelSelectionOverrides, {
      [createPluginAgentStateId("some-plugin@market", "helper")]: general,
    });
    assert.deepEqual(
      outcome.profiles.map((profile) => `${profile.source}:${profile.name}`).sort(),
      ["project:Reviewer", "user:Doc"],
    );
  });
});

test("被禁用的用户 Agent 不进入快照", async () => {
  await withTempRoot(async (storageRoot) => {
    await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "doc.md",
      docFrontmatter("provider/model-a", "low"),
    );
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        disabledAgentIds: [createAgentStateId({ name: "Doc", scope: "user", source: "user" })],
      }),
      "utf8",
    );

    const outcome = await loadCurrentACodeAgentProfiles({
      storageRoot,
      workingDirectory: join(storageRoot, "workspace"),
    });
    assert.deepEqual(outcome.profiles, []);
  });
});

test("派生边界不执行旧格式迁移：state 与 Markdown 原文保持不变", async () => {
  await withTempRoot(async (storageRoot) => {
    const workingDirectory = join(storageRoot, "workspace");
    const markdownPath = await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "legacy.md",
      ["name: Legacy", "description: 旧格式", "model: builtin:zai/glm-4.6"].join("\n"),
    );
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    const statePath = join(storageRoot, "v2", "agents-state.json");
    const legacyState = JSON.stringify({
      builtInModelOverrides: { "general-purpose": "builtin:zai/glm-4.6" },
      builtInThoughtLevelOverrides: { "general-purpose": "high" },
    });
    await writeFile(statePath, legacyState, "utf8");

    const outcome = await loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory });
    // 旧字段不在正式 reader 解释范围内：refresh 只读当前字段。
    assert.deepEqual(outcome.builtInModelSelectionOverrides, {});
    assert.deepEqual(outcome.pluginAgentModelSelectionOverrides, {});
    const legacyProfile = outcome.profiles.find((profile) => profile.name === "Legacy");
    assert.ok(legacyProfile);
    assert.equal(legacyProfile.modelSelection?.providerId, "builtin:zai");

    // 迁移只在启动装配完成；refresh 必须字节级保留原文。
    assert.equal(await readFile(statePath, "utf8"), legacyState);
    assert.equal(
      await readFile(markdownPath, "utf8"),
      "---\nname: Legacy\ndescription: 旧格式\nmodel: builtin:zai/glm-4.6\n---\n\nbody\n",
    );
  });
});

test("损坏的 agents-state 明确拒绝读取", async () => {
  const cases: Array<{ name: string; content: string }> = [
    { name: "非 JSON", content: "{ not json" },
    { name: "非对象", content: "[1,2,3]" },
    { name: "内置覆盖形状错误", content: JSON.stringify({ builtInModelSelectionOverrides: [] }) },
    {
      name: "内置选择非法",
      content: JSON.stringify({
        builtInModelSelectionOverrides: { "general-purpose": { providerId: "" } },
      }),
    },
    {
      name: "内置选择缺 modelId",
      content: JSON.stringify({
        builtInModelSelectionOverrides: { Explore: { providerId: "p", modelId: "" } },
      }),
    },
    {
      name: "插件覆盖选择非法",
      content: JSON.stringify({
        pluginAgentModelSelectionOverrides: { "plugin:a@b:x": { modelId: "m" } },
      }),
    },
    { name: "禁用列表形状错误", content: JSON.stringify({ disabledAgentIds: 1 }) },
  ];

  for (const item of cases) {
    await withTempRoot(async (storageRoot) => {
      await mkdir(join(storageRoot, "v2"), { recursive: true });
      await writeFile(join(storageRoot, "v2", "agents-state.json"), item.content, "utf8");
      await assert.rejects(
        () =>
          loadCurrentACodeAgentProfiles({
            storageRoot,
            workingDirectory: join(storageRoot, "workspace"),
          }),
        (error: unknown) => {
          assert.ok(error instanceof ACodeAgentConfigError, item.name);
          assert.equal(error.code, "agents_state_malformed", item.name);
          return true;
        },
      );
    });
  }
});

test("禁用列表中的非字符串噪声按既有服务语义过滤", async () => {
  await withTempRoot(async (storageRoot) => {
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({ disabledAgentIds: [1, ""] }),
    );
    const current = await loadCurrentACodeAgentProfiles({
      storageRoot,
      workingDirectory: join(storageRoot, "workspace"),
    });
    assert.deepEqual(current.profiles, []);
  });
});

test("未知内置名与非 plugin: 键按既有 parser 语义忽略，不影响合法覆盖", async () => {
  await withTempRoot(async (storageRoot) => {
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        builtInModelSelectionOverrides: { "future-agent": general, Explore: dedicated },
        pluginAgentModelSelectionOverrides: { "user:doc": general, "plugin:a@b:x": dedicated },
      }),
      "utf8",
    );

    const outcome = await loadCurrentACodeAgentProfiles({
      storageRoot,
      workingDirectory: join(storageRoot, "workspace"),
    });
    assert.deepEqual(outcome.builtInModelSelectionOverrides, { Explore: dedicated });
    assert.deepEqual(outcome.pluginAgentModelSelectionOverrides, {
      "plugin:a@b:x": dedicated,
    });
  });
});

test("普通 Markdown 不阻断 Doc 派生，目标 profile 解析失败明确拒绝", async () => {
  await withTempRoot(async (storageRoot) => {
    const agentDir = join(storageRoot, "agents");
    await writeAgentMarkdown(agentDir, "doc.md", docFrontmatter("provider/model-a", "low"));
    await writeFile(
      join(agentDir, "README.md"),
      "Plain documentation without agent metadata",
      "utf8",
    );
    await writeAgentMarkdown(agentDir, "broken.md", ["description: 缺少 name"].join("\n"));
    const current = await loadCurrentACodeAgentProfiles({
      storageRoot,
      workingDirectory: join(storageRoot, "workspace"),
      agentType: "Doc",
    });
    assert.deepEqual(
      current.profiles.map((profile) => profile.name),
      ["Doc"],
    );
    await assert.rejects(
      () =>
        loadCurrentACodeAgentProfiles({
          storageRoot,
          workingDirectory: join(storageRoot, "workspace"),
          agentType: "broken",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ACodeAgentConfigError);
        assert.equal(error.code, "agent_profile_invalid");
        assert.equal(error.diagnostics.length, 1);
        return true;
      },
    );
  });
});

test("目标 Agent 的显式无效模型不继承父模型", async () => {
  await withTempRoot(async (storageRoot) => {
    await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "doc.md",
      docFrontmatter("invalid", "high"),
    );
    await assert.rejects(
      () =>
        loadCurrentACodeAgentProfiles({
          storageRoot,
          workingDirectory: join(storageRoot, "workspace"),
          agentType: "Doc",
        }),
      (error: unknown) =>
        error instanceof ACodeAgentConfigError && error.code === "agent_profile_invalid",
    );
  });
});

test("agents 根目录不可读时拒绝读取", async () => {
  await withTempRoot(async (storageRoot) => {
    // 该路径是普通文件而非目录：不能当成"没有配置"静默通过。
    await writeFile(join(storageRoot, "agents"), "not a directory", "utf8");
    await assert.rejects(
      () =>
        loadCurrentACodeAgentProfiles({
          storageRoot,
          workingDirectory: join(storageRoot, "workspace"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ACodeAgentConfigError);
        assert.equal(error.code, "agent_root_unreadable");
        return true;
      },
    );
  });
});

test("并行派生各自取得独立快照", async () => {
  await withTempRoot(async (storageRoot) => {
    const workingDirectory = join(storageRoot, "workspace");
    await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "doc.md",
      docFrontmatter("provider/model-a", "low"),
    );
    const [first, second] = await Promise.all([
      loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory }),
      loadCurrentACodeAgentProfiles({ storageRoot, workingDirectory }),
    ]);
    assert.deepEqual(first.profiles, second.profiles);
    assert.notEqual(first.profiles, second.profiles);
    assert.notEqual(first.profiles[0], second.profiles[0]);
  });
});

test("启动读取 loadACodeAgentProfiles 行为不变", async () => {
  await withTempRoot(async (storageRoot) => {
    const workingDirectory = join(storageRoot, "workspace");
    await writeAgentMarkdown(
      join(storageRoot, "agents"),
      "doc.md",
      docFrontmatter("provider/model-a", "low"),
    );
    const outcome = await loadACodeAgentProfiles({ storageRoot, workingDirectory });
    assert.deepEqual(
      outcome.profiles.map((profile) => profile.name),
      ["Doc"],
    );
  });
});

const pluginRootPrefix = join(import.meta.dirname, "..", "..", "agent-teams-plugin");

function pluginFixture(input: {
  rootPath: string;
  agents: string[];
  configuredOptions?: PluginMetadata["configuredOptions"];
  id?: string;
  name?: string;
}): PluginMetadata {
  return {
    id: input.id ?? "agent-teams@acode-plugins-official",
    name: input.name ?? "agent-teams",
    marketplace: "acode-plugins-official",
    enabled: true,
    rootPath: input.rootPath,
    manifestPath: join(input.rootPath, ".acode-plugin", "plugin.json"),
    source: "official",
    dataPath: join(input.rootPath, "data"),
    mcpServerNames: ["plugin:agent-teams:team"],
    declaredMcpServerNames: ["plugin:agent-teams:team"],
    components: [{ kind: "agent", items: input.agents.map((name) => ({ name })) }],
    configuredOptions: input.configuredOptions ?? {},
    commandRootCount: 0,
    hookDetails: [],
    skillCount: 0,
    skillRootCount: 0,
  };
}

const memberFrontmatter = [
  "name: member",
  "description: 团队成员",
  "color: purple",
  "permissionMode: plan",
  "maxTurns: 40",
  "background: true",
  "mcpServers:",
  "  - plugin:agent-teams:team",
  "tools:",
  "  - Read",
  "  - Grep",
].join("\n");

test("插件覆盖优先于 AgentTeams general-purpose 回退，且保留全部其余字段", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(join(rootPath, "agents"), "member.md", memberFrontmatter);
    const plugin = pluginFixture({ rootPath, agents: ["member"] });
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] });
    const baselineMember = baseline.profiles.find(
      (profile) => profile.name === "agent-teams:member",
    );
    assert.ok(baselineMember);
    assert.equal(baselineMember.modelSelection, undefined);

    const applied = applyPluginAgentModelOverrides({
      profiles: baseline.profiles,
      plugins: [plugin],
      builtInModelSelectionOverrides: { "general-purpose": general },
      modelSelectionOverrides: {
        [createPluginAgentStateId(plugin.id, "member")]: dedicated,
      },
    });
    const namespaced = applied.find((profile) => profile.name === "agent-teams:member");
    const alias = applied.find((profile) => profile.name === "member");
    assert.ok(namespaced);
    assert.ok(alias, "唯一裸名别名必须与命名空间 profile 一起改写");
    assert.deepEqual(namespaced.modelSelection, dedicated);
    assert.deepEqual(alias.modelSelection, dedicated);
    // 权限、颜色、工具与 MCP 权限原样保留。
    assert.equal(namespaced.permissionMode, "plan");
    assert.equal(namespaced.color, "purple");
    assert.equal(namespaced.maxTurns, 40);
    assert.equal(namespaced.background, true);
    assert.deepEqual(namespaced.mcpServers, ["plugin:agent-teams:team"]);
    assert.deepEqual(namespaced.tools, ["Read", "Grep"]);
    assert.equal(namespaced.requireExplicitModelSelection, true);
  });
});

test("AgentTeams 成员没有独立覆盖时回退最新 general-purpose 并 fail closed", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(join(rootPath, "agents"), "member.md", memberFrontmatter);
    const plugin = pluginFixture({ rootPath, agents: ["member"] });
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] }).profiles;

    const withGeneral = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      builtInModelSelectionOverrides: { "general-purpose": general },
    });
    const member = withGeneral.find((profile) => profile.name === "agent-teams:member");
    assert.ok(member);
    assert.deepEqual(member.modelSelection, general);
    assert.equal(member.requireExplicitModelSelection, true);

    // 未配置任何子智能体模型：不能误继承队长模型。
    const missing = applyPluginAgentModelOverrides({ profiles: baseline, plugins: [plugin] });
    const missingMember = missing.find((profile) => profile.name === "agent-teams:member");
    assert.ok(missingMember);
    assert.equal(missingMember.modelSelection, undefined);
    assert.equal(missingMember.requireExplicitModelSelection, true);
  });
});

test("inheritCaptainModel 显式开启时成员不再借用 general-purpose 与 fail-closed 标记", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(join(rootPath, "agents"), "member.md", memberFrontmatter);
    const plugin = pluginFixture({
      rootPath,
      agents: ["member"],
      configuredOptions: { inheritCaptainModel: true },
    });
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] }).profiles;

    const inherited = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      builtInModelSelectionOverrides: { "general-purpose": general },
    });
    const member = inherited.find((profile) => profile.name === "agent-teams:member");
    assert.ok(member);
    assert.equal(member.modelSelection, undefined);
    assert.equal(member.requireExplicitModelSelection, undefined);

    // 插件专属覆盖仍优先于继承开关。
    const dedicatedOverride = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      builtInModelSelectionOverrides: { "general-purpose": general },
      modelSelectionOverrides: { [createPluginAgentStateId(plugin.id, "member")]: dedicated },
    });
    const overridden = dedicatedOverride.find((profile) => profile.name === "agent-teams:member");
    assert.ok(overridden);
    assert.deepEqual(overridden.modelSelection, dedicated);
    assert.equal(overridden.requireExplicitModelSelection, undefined);
  });
});

test("插件基线模型在没有覆盖时保持不变，非插件 profile 不被改写", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(
      join(rootPath, "agents"),
      "visual-judge.md",
      [
        "name: visual-judge",
        "description: 视觉评审",
        "model: provider/baseline-model",
        "thoughtLevel: low",
      ].join("\n"),
    );
    const plugin = pluginFixture({
      rootPath,
      agents: ["visual-judge"],
      id: "documents@acode-plugins-official",
      name: "documents",
    });
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] }).profiles;
    const unrelated = {
      name: "Doc",
      description: "用户 Agent",
      source: "user" as const,
      systemPrompt: "",
      modelSelection: general,
    };

    const applied = applyPluginAgentModelOverrides({
      profiles: [...baseline, unrelated],
      plugins: [plugin],
      modelSelectionOverrides: { [createPluginAgentStateId(plugin.id, "visual-judge")]: dedicated },
    });
    const overridden = applied.find((profile) => profile.name === "documents:visual-judge");
    assert.ok(overridden);
    assert.deepEqual(overridden.modelSelection, dedicated);
    assert.deepEqual(applied.at(-1), unrelated);

    const untouched = applyPluginAgentModelOverrides({
      profiles: [...baseline, unrelated],
      plugins: [plugin],
    });
    const baselineProfile = untouched.find((profile) => profile.name === "documents:visual-judge");
    assert.ok(baselineProfile);
    assert.deepEqual(baselineProfile.modelSelection, {
      providerId: "provider",
      modelId: "baseline-model",
      options: { reasoningLevel: "low" },
    });
  });
});

test("同名插件的歧义裸名不生成别名，但命名空间 profile 仍各自套用覆盖", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(join(rootPath, "agents"), "member.md", memberFrontmatter);
    const first = pluginFixture({
      rootPath,
      agents: ["member"],
      id: "agent-teams@acode-plugins-official",
      name: "agent-teams",
    });
    const second = pluginFixture({
      rootPath,
      agents: ["member"],
      id: "other-teams@local",
      name: "other-teams",
    });

    const outcome = loadPluginAgentProfiles({ plugins: [first, second] });
    assert.equal(
      outcome.profiles.filter((profile) => profile.name === "member").length,
      0,
      "歧义裸名不得生成别名",
    );
    assert.ok(outcome.diagnostics.some((item) => item.code === "agent_ambiguous_name"));

    const applied = applyPluginAgentModelOverrides({
      profiles: outcome.profiles,
      plugins: [first, second],
      modelSelectionOverrides: {
        [createPluginAgentStateId(second.id, "member")]: dedicated,
      },
    });
    const other = applied.find((profile) => profile.name === "other-teams:member");
    assert.ok(other);
    assert.deepEqual(other.modelSelection, dedicated);
    const teams = applied.find((profile) => profile.name === "agent-teams:member");
    assert.ok(teams);
    assert.equal(teams.modelSelection, undefined);
  });
});

test("覆盖键按 frontmatter 名而非文件名匹配，别名与命名空间 profile 同步改写", async () => {
  await withTempRoot(async (rootPath) => {
    // 文件名 stem 与 frontmatter name 不一致：覆盖键必须沿用启动装配的 frontmatter 名。
    await writeAgentMarkdown(
      join(rootPath, "agents"),
      "helper-file.md",
      ["name: helper", "description: 辅助 Agent", "color: green"].join("\n"),
    );
    const plugin = pluginFixture({
      rootPath,
      agents: ["helper-file"],
      id: "documents@acode-plugins-official",
      name: "documents",
    });
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] }).profiles;

    const applied = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      modelSelectionOverrides: { [createPluginAgentStateId(plugin.id, "helper")]: dedicated },
    });
    const namespaced = applied.find((profile) => profile.name === "documents:helper");
    const alias = applied.find((profile) => profile.name === "helper");
    assert.ok(namespaced, "命名空间名取 frontmatter name");
    assert.ok(alias, "别名取 frontmatter name");
    assert.deepEqual(namespaced.modelSelection, dedicated);
    assert.deepEqual(alias.modelSelection, dedicated);
    assert.equal(namespaced.color, "green");

    // 用文件 stem 作键不应命中：证明键来源是 frontmatter name。
    const wrongKey = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      modelSelectionOverrides: {
        [createPluginAgentStateId(plugin.id, "helper-file")]: dedicated,
      },
    });
    assert.equal(
      wrongKey.find((profile) => profile.name === "documents:helper")?.modelSelection,
      undefined,
    );
  });
});

test("插件 loader 与 applyPluginAgentModelOverrides 选择优先级一致", async () => {
  await withTempRoot(async (rootPath) => {
    await writeAgentMarkdown(join(rootPath, "agents"), "member.md", memberFrontmatter);
    const plugin = pluginFixture({ rootPath, agents: ["member"] });
    const selection = { "general-purpose": general };
    const overrides = { [createPluginAgentStateId(plugin.id, "member")]: dedicated };

    const direct = loadPluginAgentProfiles({
      plugins: [plugin],
      builtInModelSelectionOverrides: selection,
      modelSelectionOverrides: overrides,
    }).profiles;
    const baseline = loadPluginAgentProfiles({ plugins: [plugin] }).profiles;
    const viaHelper = applyPluginAgentModelOverrides({
      profiles: baseline,
      plugins: [plugin],
      builtInModelSelectionOverrides: selection,
      modelSelectionOverrides: overrides,
    });
    assert.deepEqual(direct, viaHelper);
  });
});

test("内置插件基线目录可用作真实 plugin fixture 的根路径", async () => {
  // 保证测试里的 pluginRootPrefix 常量与仓库内置插件目录保持同源，避免测试只验证合成目录。
  const plugin = pluginFixture({ rootPath: pluginRootPrefix, agents: ["member"] });
  const outcome = loadPluginAgentProfiles({ plugins: [plugin] });
  assert.ok(outcome.profiles.some((profile) => profile.name === "agent-teams:member"));
});
