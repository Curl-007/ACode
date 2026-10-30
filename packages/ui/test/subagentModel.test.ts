import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentColor,
  AgentsListResult,
  AgentSummary,
  BuiltInSubagentName,
  ModelSelection,
} from "@acode/shared";
import type { ModelSelectionView } from "@acode/services";
import type { ModelSelectGroup } from "../src/ModelConfigSelect.js";

import {
  AGENT_COLORS,
  BUNDLED_AGENT_PATH_PREFIX,
  COLOR_DOT_CLASS,
  RISKY_TOOLS,
  TOOL_OPTIONS,
  TOOL_OPTION_SET,
  allowsAllTools,
  createSubagentFormInitialState,
  createSubagentFormInitialStateKey,
  getBuiltInSubagentName,
  getKnownTools,
  getPreservedTools,
  isBuiltInAgent,
  isBundledPresetAgent,
  isEditableUserAgent,
  isSubagentModelAvailable,
  isSubagentThoughtLevelAvailable,
  mergeTools,
  projectSettingsSubagents,
  resolveSubagentModelLabel,
  resolveSubagentThoughtOptionState,
  resolvedSubagentThoughtLevel,
  supportsEnabledToggle,
  supportsModelOverride,
  toPersistedModel,
  toSubagentModelSelection,
  toSubagentModelValue,
} from "../src/settings/subagents/agentModel.js";

/**
 * 子智能体设置页 helper 外迁（split-plan settings/SubagentsSection.tsx 批次 1）的决策表单测。
 *
 * 覆盖维度（split-plan 前置测试要求）：
 *  - 能力矩阵（isEditableUserAgent / isBundledPresetAgent / supportsEnabledToggle /
 *    isBuiltInAgent / supportsModelOverride / getBuiltInSubagentName）
 *  - 工具合并去重（getKnownTools / getPreservedTools / mergeTools / allowsAllTools）
 *  - 模型档位可用性（isSubagentModelAvailable / resolveSubagentThoughtOptionState /
 *    isSubagentThoughtLevelAvailable / resolvedSubagentThoughtLevel）
 *  - 表单初值 key 稳定性（createSubagentFormInitialState / createSubagentFormInitialStateKey）
 *  - 常量表完整性（AGENT_COLORS / COLOR_DOT_CLASS / TOOL_OPTIONS / TOOL_OPTION_SET /
 *    RISKY_TOOLS / BUNDLED_AGENT_PATH_PREFIX）
 */

function makeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent:test",
    name: "test",
    description: "",
    systemPrompt: "",
    path: "",
    scope: "user",
    source: "user",
    enabled: true,
    ...overrides,
  };
}

function makeModelGroups(values: string[]): ModelSelectGroup[] {
  return [
    {
      key: "group:test",
      label: "test",
      items: values.map((value) => ({
        key: `item:${value}`,
        value,
        label: value,
      })),
    } as unknown as ModelSelectGroup,
  ];
}

// ---------- 常量表完整性 ----------

test("AGENT_COLORS/COLOR_DOT_CLASS 与 SUBAGENT_COLORS 1:1 对齐", () => {
  assert.equal(AGENT_COLORS.length, 8);
  assert.ok(AGENT_COLORS.includes("yellow"));
  assert.ok(AGENT_COLORS.includes("blue"));
  // 每个色板都必须在 dot 类映射中有条目，否则表单 radiogroup 会渲染空 className。
  for (const color of AGENT_COLORS) {
    assert.ok(COLOR_DOT_CLASS[color], `COLOR_DOT_CLASS missing entry for ${color}`);
  }
});

test("TOOL_OPTIONS / TOOL_OPTION_SET / RISKY_TOOLS 快照", () => {
  assert.deepEqual(TOOL_OPTIONS, [
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "Edit",
    "Write",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
  ]);
  assert.equal(TOOL_OPTION_SET.size, TOOL_OPTIONS.length);
  assert.ok(TOOL_OPTION_SET.has("Bash"));
  // 危险工具表必须落在 option 集内，不能引用未知工具名（表单行渲染红点用）。
  for (const tool of RISKY_TOOLS) {
    assert.ok(TOOL_OPTION_SET.has(tool), `RISKY_TOOLS contains unknown tool ${tool}`);
  }
  assert.ok(RISKY_TOOLS.has("Bash"));
  assert.ok(RISKY_TOOLS.has("Edit"));
  assert.ok(RISKY_TOOLS.has("Write"));
  assert.equal(BUNDLED_AGENT_PATH_PREFIX, "bundled:");
});

// ---------- projectSettingsSubagents ----------

test("projectSettingsSubagents: 运行时投影里过滤 plugin，与 pluginAgents 拼接", () => {
  const pluginAlias = makeAgent({ name: "p:alias", source: "plugin" });
  const userAgent = makeAgent({ name: "u", source: "user" });
  const pluginFileAgent = makeAgent({ name: "p:file", source: "plugin" });
  const result: AgentsListResult = {
    agents: [pluginAlias, userAgent],
    userAgents: [userAgent],
    pluginAgents: [pluginFileAgent],
    capability: { userScopeAvailable: true },
  };
  const projected = projectSettingsSubagents(result);
  // 必须一文件一条：运行时别名行 (pluginAlias) 被滤掉，留下 user + 插件文件行。
  assert.deepEqual(
    projected.map((agent) => agent.name),
    ["u", "p:file"],
  );
});

// ---------- 能力矩阵：isEditableUserAgent / isBundledPresetAgent ----------

test("isEditableUserAgent: user|workspace scope + user source + 非 readOnly", () => {
  assert.ok(isEditableUserAgent(makeAgent({ scope: "user", source: "user" })));
  assert.ok(isEditableUserAgent(makeAgent({ scope: "workspace", source: "user" })));
  // readOnly 一票否决。
  assert.ok(!isEditableUserAgent(makeAgent({ scope: "user", source: "user", readOnly: true })));
  // 内置 / 插件 scope 不算可编辑 user agent。
  assert.ok(!isEditableUserAgent(makeAgent({ scope: "built-in", source: "built-in" })));
  assert.ok(!isEditableUserAgent(makeAgent({ scope: "user", source: "plugin" })));
});

test("isBundledPresetAgent: path 以 bundled: 开头即预置成员", () => {
  assert.ok(isBundledPresetAgent(makeAgent({ path: "bundled:Plan" })));
  assert.ok(!isBundledPresetAgent(makeAgent({ path: "built-in:general-purpose" })));
  assert.ok(!isBundledPresetAgent(makeAgent({ path: "/usr/agents/foo.md" })));
  assert.ok(!isBundledPresetAgent(makeAgent({ path: "" })));
});

// ---------- 能力矩阵：supportsEnabledToggle / isBuiltInAgent / supportsModelOverride ----------

test("supportsEnabledToggle: bundled 预置 OR user-scope 可编辑 user", () => {
  // bundled 一律可启停（bootstrap + 服务端都尊重 state id）。
  assert.ok(
    supportsEnabledToggle(
      makeAgent({ scope: "built-in", source: "built-in", path: "bundled:Plan" }),
    ),
  );
  // user scope + user source + 非 readOnly。
  assert.ok(supportsEnabledToggle(makeAgent({ scope: "user", source: "user" })));
  // workspace scope 不可启停：会写到 user 级 agents-state.json 但不生效。
  assert.ok(!supportsEnabledToggle(makeAgent({ scope: "workspace", source: "user" })));
  // 核心内置（非 bundled）不可启停。
  assert.ok(
    !supportsEnabledToggle(
      makeAgent({ scope: "built-in", source: "built-in", path: "built-in:general-purpose" }),
    ),
  );
});

test("isBuiltInAgent: scope=built-in 或 source=built-in 即内置", () => {
  assert.ok(isBuiltInAgent(makeAgent({ scope: "built-in", source: "built-in" })));
  assert.ok(isBuiltInAgent(makeAgent({ scope: "user", source: "built-in" })));
  assert.ok(!isBuiltInAgent(makeAgent({ scope: "user", source: "user" })));
});

test("supportsModelOverride: 内置目录成员或插件 agent", () => {
  // 核心二内置：name 是 shared BUILT_IN_SUBAGENT_NAMES 成员。
  assert.ok(
    supportsModelOverride(
      makeAgent({ scope: "built-in", source: "built-in", name: "general-purpose" }),
    ),
  );
  // bundled 预置 Plan 同样在名单内。
  assert.ok(
    supportsModelOverride(
      makeAgent({
        scope: "built-in",
        source: "built-in",
        name: "Plan" as BuiltInSubagentName,
        path: "bundled:Plan",
      }),
    ),
  );
  // 插件 agent 支持覆盖。
  assert.ok(supportsModelOverride(makeAgent({ source: "plugin", name: "p:a" })));
  // 自建 user agent 不支持行内覆盖（编辑表单走 updateAgent 完整写）。
  assert.ok(!supportsModelOverride(makeAgent({ scope: "user", source: "user", name: "mine" })));
});

test("getBuiltInSubagentName: 只在内置 + 名单内命中时返回名", () => {
  assert.equal(
    getBuiltInSubagentName(
      makeAgent({ scope: "built-in", source: "built-in", name: "general-purpose" }),
    ),
    "general-purpose",
  );
  // 非内置：null。
  assert.equal(getBuiltInSubagentName(makeAgent({ scope: "user", source: "user" })), null);
  // 内置但 name 不在名单：null（R5/R7 单一事实源是 shared 的 BUILT_IN_SUBAGENT_NAMES）。
  assert.equal(
    getBuiltInSubagentName(
      makeAgent({ scope: "built-in", source: "built-in", name: "unknown-builtin" }),
    ),
    null,
  );
});

// ---------- 工具合并去重：getKnownTools / getPreservedTools / mergeTools / allowsAllTools ----------

test("getKnownTools: 过滤出 TOOL_OPTIONS 内的已知工具", () => {
  assert.deepEqual(getKnownTools(["Read", "Bash", "unknown-tool", "Write"]), [
    "Read",
    "Bash",
    "Write",
  ]);
  assert.deepEqual(getKnownTools(undefined), []);
  assert.deepEqual(getKnownTools([]), []);
});

test("getPreservedTools: 保留未知工具不被 UI 覆盖（round-trip）", () => {
  assert.deepEqual(getPreservedTools(["Read", "custom-mcp", "Bash"]), ["custom-mcp"]);
  assert.deepEqual(getPreservedTools(undefined), []);
});

test("mergeTools: selected+preserved 拼接去重，空结果回落 undefined", () => {
  assert.deepEqual(mergeTools(["Read", "Bash"], ["custom-mcp", "Read"]), [
    "Read",
    "Bash",
    "custom-mcp",
  ]);
  // 空字符串被剔除。
  assert.deepEqual(mergeTools(["Read", ""], []), ["Read"]);
  // 全空 → undefined（语义 = 未显式声明 tools，与 agent 定义文件对齐）。
  assert.equal(mergeTools([], []), undefined);
  assert.equal(mergeTools([], ["  "].filter((tool) => tool.trim().length > 0)), undefined);
});

test("allowsAllTools: 无声明 / 空数组 / 含通配符 都视为全工具", () => {
  assert.ok(allowsAllTools(undefined));
  assert.ok(allowsAllTools([]));
  assert.ok(allowsAllTools(["*"]));
  assert.ok(allowsAllTools(["Read", "*"]));
  assert.ok(!allowsAllTools(["Read"]));
  assert.ok(!allowsAllTools(["Read", "Bash"]));
});

// ---------- 模型持久化：toPersistedModel / toSubagentModelValue / toSubagentModelSelection ----------

test("toPersistedModel: 空白 / inherit 都归一为 undefined", () => {
  assert.equal(toPersistedModel(""), undefined);
  assert.equal(toPersistedModel("   "), undefined);
  assert.equal(toPersistedModel("inherit"), undefined);
  assert.equal(toPersistedModel("custom:zai:glm-4.7"), "custom:zai:glm-4.7");
  assert.equal(toPersistedModel("zai/glm-4.7"), "zai/glm-4.7");
});

test("toSubagentModelValue: selection → picker 编码串；空 selection → inherit", () => {
  const selection: ModelSelection = { providerId: "zai", modelId: "glm-4.7" };
  assert.equal(toSubagentModelValue(selection), "custom:zai:glm-4.7");
  assert.equal(toSubagentModelValue(undefined), "inherit");
});

test("toSubagentModelSelection: picker 编码 → ModelSelection 结构；档位透传", () => {
  assert.equal(toSubagentModelSelection(undefined), undefined);
  assert.equal(toSubagentModelSelection(""), undefined);
  assert.equal(toSubagentModelSelection("inherit"), undefined);
  // 仅模型。
  assert.deepEqual(toSubagentModelSelection("custom:zai:glm-4.7"), {
    providerId: "zai",
    modelId: "glm-4.7",
  });
  // 带 reasoningLevel。
  assert.deepEqual(toSubagentModelSelection("custom:zai:glm-4.7", "high"), {
    providerId: "zai",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high" },
  });
  // 带 speed。
  assert.deepEqual(toSubagentModelSelection("custom:zai:glm-4.7", undefined, "fast"), {
    providerId: "zai",
    modelId: "glm-4.7",
    options: { speed: "fast" },
  });
  // 同带两个。
  assert.deepEqual(toSubagentModelSelection("custom:zai:glm-4.7", "high", "fast"), {
    providerId: "zai",
    modelId: "glm-4.7",
    options: { reasoningLevel: "high", speed: "fast" },
  });
  // 空白档位字段被 trim 掉不落 options 键。
  assert.deepEqual(toSubagentModelSelection("custom:zai:glm-4.7", "  ", ""), {
    providerId: "zai",
    modelId: "glm-4.7",
  });
});

// ---------- resolveSubagentThoughtOptionState ----------

function makeView(options?: { reasoningValues?: string[] }): ModelSelectionView {
  return {
    providers: [
      {
        providerId: "zai",
        models: [
          {
            modelId: "glm-4.7",
            config: {
              optionSpecs: {
                reasoningLevel: options?.reasoningValues
                  ? { values: options.reasoningValues }
                  : undefined,
              },
            },
          },
        ],
      },
    ],
  } as unknown as ModelSelectionView;
}

test("resolveSubagentThoughtOptionState: 无模型/模型失效 → not-applicable", () => {
  assert.deepEqual(
    resolveSubagentThoughtOptionState({
      model: "",
      modelAvailable: true,
      modelSelectionView: makeView(),
      modelSelectionLoading: false,
    }),
    { kind: "not-applicable" },
  );
  assert.deepEqual(
    resolveSubagentThoughtOptionState({
      model: "custom:zai:glm-4.7",
      modelAvailable: false,
      modelSelectionView: makeView(),
      modelSelectionLoading: false,
    }),
    { kind: "not-applicable" },
  );
});

test("resolveSubagentThoughtOptionState: registry 无 reasoning spec → unsupported", () => {
  const state = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: makeView(),
    modelSelectionLoading: false,
  });
  assert.equal(state.kind, "unsupported");
});

test("resolveSubagentThoughtOptionState: 有 spec → supported + option 带 currentValue", () => {
  const state = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: makeView({ reasoningValues: ["low", "high"] }),
    modelSelectionLoading: false,
    thoughtLevel: "high",
  });
  assert.equal(state.kind, "supported");
  if (state.kind === "supported") {
    assert.equal(state.option.type, "select");
    assert.equal(state.option.currentValue, "high");
    assert.deepEqual(
      state.option.options?.map((option) => option.value),
      ["low", "high"],
    );
  }
});

test("resolveSubagentThoughtOptionState: 无 view 且加载中 → unknown/loading", () => {
  const state = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: null,
    modelSelectionLoading: true,
  });
  assert.deepEqual(state, { kind: "unknown", status: "loading" });
});

test("resolveSubagentThoughtOptionState: 无 view 且未加载 → unsupported", () => {
  const state = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: null,
    modelSelectionLoading: false,
  });
  assert.equal(state.kind, "unsupported");
});

// ---------- isSubagentThoughtLevelAvailable / resolvedSubagentThoughtLevel ----------

test("isSubagentThoughtLevelAvailable: 空档位恒可用；state 为 unknown/not-applicable 也放行", () => {
  assert.ok(
    isSubagentThoughtLevelAvailable({ kind: "not-applicable" }, undefined),
  );
  assert.ok(
    isSubagentThoughtLevelAvailable({ kind: "unknown", status: "loading" }, "high"),
  );
  assert.ok(
    isSubagentThoughtLevelAvailable({ kind: "not-applicable" }, "high"),
  );
  assert.ok(!isSubagentThoughtLevelAvailable({ kind: "unsupported" }, "high"));
});

test("isSubagentThoughtLevelAvailable: supported 按 option 表查在册", () => {
  const state = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: makeView({ reasoningValues: ["low", "high"] }),
    modelSelectionLoading: false,
  });
  assert.ok(isSubagentThoughtLevelAvailable(state, "low"));
  assert.ok(isSubagentThoughtLevelAvailable(state, "high"));
  assert.ok(!isSubagentThoughtLevelAvailable(state, "extreme"));
  // 空档位（未选择）恒可用。
  assert.ok(isSubagentThoughtLevelAvailable(state, undefined));
  assert.ok(isSubagentThoughtLevelAvailable(state, "  "));
});

test("resolvedSubagentThoughtLevel: supported 且有 currentValue → 透出；其他形态 → undefined", () => {
  const supported = resolveSubagentThoughtOptionState({
    model: "custom:zai:glm-4.7",
    modelAvailable: true,
    modelSelectionView: makeView({ reasoningValues: ["low", "high"] }),
    modelSelectionLoading: false,
    thoughtLevel: "high",
  });
  assert.equal(resolvedSubagentThoughtLevel(supported), "high");
  assert.equal(resolvedSubagentThoughtLevel({ kind: "unsupported" }), undefined);
  assert.equal(resolvedSubagentThoughtLevel({ kind: "not-applicable" }), undefined);
  assert.equal(
    resolvedSubagentThoughtLevel({ kind: "unknown", status: "loading" }),
    undefined,
  );
});

// ---------- isSubagentModelAvailable ----------

test("isSubagentModelAvailable: 空白 / inherit / 加载中 → true；在册 value → true；失效 value → false", () => {
  const groups = makeModelGroups(["custom:zai:glm-4.7", "custom:anthropic:claude-opus-5"]);
  assert.ok(isSubagentModelAvailable(groups, undefined));
  assert.ok(isSubagentModelAvailable(groups, ""));
  assert.ok(isSubagentModelAvailable(groups, "inherit"));
  // 加载中无法证伪 → 放行（保留原意图，等待 ready 再判）。
  assert.ok(isSubagentModelAvailable(groups, "custom:zai:gone", true));
  // 在册 → true。
  assert.ok(isSubagentModelAvailable(groups, "custom:zai:glm-4.7"));
  // 失效 → false。
  assert.ok(!isSubagentModelAvailable(groups, "custom:zai:gone"));
  // 空 groups 时只有空白/inherit/加载中可用。
  assert.ok(!isSubagentModelAvailable([], "custom:zai:glm-4.7"));
});

// ---------- createSubagentFormInitialState / createSubagentFormInitialStateKey ----------

test("createSubagentFormInitialState: 无 initial 走默认值（inherit model + 全工具 + 默认色）", () => {
  const initial = createSubagentFormInitialState(undefined);
  assert.equal(initial.name, "");
  assert.equal(initial.description, "");
  assert.equal(initial.color, "yellow");
  assert.equal(initial.model, "inherit");
  assert.equal(initial.thoughtLevel, undefined);
  assert.equal(initial.speed, undefined);
  assert.equal(initial.injectAgentsMd, true);
  assert.equal(initial.inheritAllTools, true);
  assert.deepEqual(initial.selectedTools, []);
  assert.deepEqual(initial.preservedTools, []);
  assert.equal(initial.systemPrompt, "");
});

test("createSubagentFormInitialState: 有 initial 透传 + 工具按 known/preserved 分桶", () => {
  const agent = makeAgent({
    name: "agent-x",
    description: "desc",
    color: "blue" as AgentColor,
    systemPrompt: "do x",
    injectAgentsMd: false,
    tools: ["Read", "custom-mcp", "Bash"],
    modelSelection: {
      providerId: "zai",
      modelId: "glm-4.7",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  });
  const initial = createSubagentFormInitialState(agent);
  assert.equal(initial.name, "agent-x");
  assert.equal(initial.color, "blue");
  assert.equal(initial.model, "custom:zai:glm-4.7");
  assert.equal(initial.thoughtLevel, "high");
  assert.equal(initial.speed, "fast");
  assert.equal(initial.injectAgentsMd, false);
  assert.equal(initial.inheritAllTools, false);
  assert.deepEqual(initial.selectedTools, ["Read", "Bash"]);
  assert.deepEqual(initial.preservedTools, ["custom-mcp"]);
});

test("createSubagentFormInitialState: tools 为空数组 → inheritAllTools=true", () => {
  const agent = makeAgent({ tools: [] });
  assert.equal(createSubagentFormInitialState(agent).inheritAllTools, true);
});

test("createSubagentFormInitialStateKey: 同 initial 稳定，改任意字段 key 变化", () => {
  const agent = makeAgent({
    name: "a",
    description: "d",
    systemPrompt: "s",
    color: "blue",
    tools: ["Read"],
  });
  const key1 = createSubagentFormInitialStateKey(agent);
  const key2 = createSubagentFormInitialStateKey(agent);
  assert.equal(key1, key2);
  // 改 description → key 必须变（表单按 key 变化回灌字段）。
  const modified = { ...agent, description: "d2" };
  assert.notEqual(createSubagentFormInitialStateKey(modified), key1);
  // 改 id → key 变。
  const differentId = { ...agent, id: "agent:different" };
  assert.notEqual(createSubagentFormInitialStateKey(differentId), key1);
  // 无 initial 的 key 与有 initial 的 key 不同。
  assert.notEqual(createSubagentFormInitialStateKey(undefined), key1);
});

test("createSubagentFormInitialStateKey: 序列化包含 id 字段（initial 缺失 id 时为 null）", () => {
  const parsed = JSON.parse(createSubagentFormInitialStateKey(undefined)) as { id: unknown };
  assert.equal(parsed.id, null);
});

// ---------- resolveSubagentModelLabel ----------

test("resolveSubagentModelLabel: inherit / 空白 → inheritLabel；在册 → 显示名；不在册 → 原 value", () => {
  const groups = makeModelGroups(["custom:zai:glm-4.7"]);
  assert.equal(
    resolveSubagentModelLabel({ inheritLabel: "继承默认", modelGroups: groups, model: "inherit" }),
    "继承默认",
  );
  assert.equal(
    resolveSubagentModelLabel({ inheritLabel: "继承默认", modelGroups: groups, model: "" }),
    "继承默认",
  );
  assert.equal(
    resolveSubagentModelLabel({ inheritLabel: "继承默认", modelGroups: groups, model: undefined }),
    "继承默认",
  );
  // 不在册但 custom:* 可解码：取 decode 出的 modelName（resolveModelDisplayName 兜底语义），
  // 让用户看到「模型短名」而不是带 provider 前缀的整串。
  assert.equal(
    resolveSubagentModelLabel({
      inheritLabel: "继承默认",
      modelGroups: groups,
      model: "custom:zai:removed",
    }),
    "removed",
  );
  // 完全无法 decode 的裸值（registry 与 decode 都落空）→ 原样返回 value，保留失效配置身份。
  assert.equal(
    resolveSubagentModelLabel({
      inheritLabel: "继承默认",
      modelGroups: groups,
      model: "plain-unknown",
    }),
    "plain-unknown",
  );
});
