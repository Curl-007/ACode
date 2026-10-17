// 派生边界刷新回调的组合测试（specs/agent-teams-derived-config.md 场景 6）：
// `createLiveSubagentProfilesLoader` 是纯组合函数，不读磁盘——磁盘读取由注入的
// `loadCurrentProfiles` 承担。这里用手写快照验证三件事实：每次调用都重新读取、
// 拼接顺序与启动装配一致、插件覆盖从**无覆盖基线**重算（覆盖被删除后不会残留
// 启动时烘焙进去的旧模型）。
// 移植自 dev/from-acode-2026-10 的 bootstrap/src/app/subagent-live-profiles.test.ts
// （8712257），按本仓测试惯例转为 tests/*.test.mjs；loader 导入路径改指拆分后的
// app/subagent-live-profiles-loader.ts（spec R8）。

import assert from "node:assert/strict";
import test from "node:test";
import { createPluginAgentStateId } from "../../../packages/shared/src/subagents-types.ts";
import { createLiveSubagentProfilesLoader } from "../packages/bootstrap/src/app/subagent-live-profiles-loader.ts";

const pluginId = "agent-teams@acode-plugins-official";
const memberPath = "/plugins/agent-teams/agents/member.md";

/** 插件元数据只用于身份归属（命名空间前缀 + 插件根目录），不触发任何文件读取。 */
const plugin = {
  id: pluginId,
  name: "agent-teams",
  marketplace: "acode-plugins-official",
  enabled: true,
  rootPath: "/plugins/agent-teams",
  manifestPath: "/plugins/agent-teams/.acode-plugin/plugin.json",
  source: "official",
  dataPath: "/plugins/agent-teams/data",
  mcpServerNames: ["plugin:agent-teams:team"],
  declaredMcpServerNames: ["plugin:agent-teams:team"],
  components: [{ kind: "agent", items: [{ name: "member" }] }],
  configuredOptions: {},
  commandRootCount: 0,
  hookDetails: [],
  skillCount: 0,
  skillRootCount: 0,
};

// 启动装配里 `loadPluginAgentProfiles` 产出的无覆盖基线：命名空间副本 + 唯一裸名别名。
const pristinePluginProfiles = [
  {
    name: "agent-teams:member",
    description: "团队成员",
    path: memberPath,
    source: "user",
    systemPrompt: "",
  },
  {
    name: "member",
    description: "团队成员",
    path: memberPath,
    source: "user",
    systemPrompt: "",
  },
];

const callerProfile = {
  name: "Caller",
  description: "调用方显式注入",
  source: "user",
  systemPrompt: "",
};
const diskProfile = {
  name: "Doc",
  description: "磁盘 Agent",
  source: "user",
  systemPrompt: "",
};
const general = {
  providerId: "provider",
  modelId: "general-model",
  options: { reasoningLevel: "medium" },
};
const dedicated = {
  providerId: "provider",
  modelId: "team-model",
  options: { reasoningLevel: "high" },
};
const callerGeneral = {
  providerId: "provider",
  modelId: "caller-general-model",
};

test("每次派生都重新读取，且按调用方 → 磁盘 → 插件顺序拼接", async () => {
  let loadCount = 0;
  const loader = createLiveSubagentProfilesLoader({
    callerProfiles: [callerProfile],
    loadCurrentProfiles: async () => {
      loadCount += 1;
      return {
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
        profiles: [diskProfile],
      };
    },
    pluginProfiles: pristinePluginProfiles,
    plugins: [plugin],
  });

  const first = await loader("Doc");
  const second = await loader("Doc");
  assert.equal(loadCount, 2, "每次调用都必须重新读取最新配置");
  assert.deepEqual(
    first.profiles.map((profile) => profile.name),
    ["Caller", "Doc", "agent-teams:member", "member"],
  );
  assert.notEqual(first.profiles, second.profiles);
});

test("已打开会话新建同名用户 Agent 后不再被插件裸名别名遮蔽", async () => {
  const ownMember = { ...diskProfile, name: "member", modelSelection: dedicated };
  const loader = createLiveSubagentProfilesLoader({
    loadCurrentProfiles: async () => ({
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      profiles: [ownMember],
    }),
    pluginProfiles: pristinePluginProfiles,
    plugins: [plugin],
  });
  const current = await loader("Doc");
  const member = current.profiles.find((profile) => profile.name === "member");
  assert.equal(member, ownMember);
  assert.equal(current.profiles.filter((profile) => profile.name === "member").length, 1);
  assert.ok(current.profiles.some((profile) => profile.name === "agent-teams:member"));
});

test("插件覆盖从无覆盖基线重算：覆盖被删除后不残留旧模型", async () => {
  let overrides = {
    [createPluginAgentStateId(pluginId, "member")]: dedicated,
  };
  const loader = createLiveSubagentProfilesLoader({
    loadCurrentProfiles: async () => ({
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: overrides,
      profiles: [],
    }),
    pluginProfiles: pristinePluginProfiles,
    plugins: [plugin],
  });

  const applied = await loader("Doc");
  const namespaced = applied.profiles.find((profile) => profile.name === "agent-teams:member");
  const alias = applied.profiles.find((profile) => profile.name === "member");
  assert.deepEqual(namespaced?.modelSelection, dedicated);
  assert.deepEqual(alias?.modelSelection, dedicated, "别名副本必须与命名空间副本一起改写");

  // 设置页删除覆盖：基线没有烘焙过任何模型，因此这里必须回到「无 modelSelection」。
  overrides = {};
  const removed = await loader("Doc");
  assert.equal(
    removed.profiles.find((profile) => profile.name === "agent-teams:member")?.modelSelection,
    undefined,
  );
  assert.equal(
    removed.profiles.find((profile) => profile.name === "member")?.modelSelection,
    undefined,
  );
});

test("内置覆盖：调用方显式覆盖压过磁盘，插件回退仍取磁盘 general-purpose", async () => {
  const loader = createLiveSubagentProfilesLoader({
    callerBuiltInModelSelectionOverrides: { "general-purpose": callerGeneral },
    loadCurrentProfiles: async () => ({
      builtInModelSelectionOverrides: { "general-purpose": general },
      pluginAgentModelSelectionOverrides: {},
      profiles: [],
    }),
    pluginProfiles: pristinePluginProfiles,
    plugins: [plugin],
  });

  const result = await loader("Doc");
  // 与 resolveAppRuntimeConfig 的 `{ ...磁盘, ...调用方 }` 优先级一致。
  assert.deepEqual(result.builtInModelSelectionOverrides, {
    "general-purpose": callerGeneral,
  });
  // AgentTeams 成员无独立覆盖且不能继承队长模型：借用**磁盘** general-purpose 并 fail closed，
  // 与启动装配传给插件 loader 的覆盖来源相同。
  const member = result.profiles.find((profile) => profile.name === "agent-teams:member");
  assert.deepEqual(member?.modelSelection, general);
  assert.equal(member?.requireExplicitModelSelection, true);
});
