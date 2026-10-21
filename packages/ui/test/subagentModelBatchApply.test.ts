import assert from "node:assert/strict";
import test from "node:test";
import { formatSubagentMarkdownModel, parseSubagentMarkdownSelection } from "@acode/shared";
import type { AgentSummary } from "@acode/shared";
import {
  buildUserAgentBatchConfig,
  createEmptyBatchResult,
  describeBatchResult,
  isBatchApplicableAgent,
  isBatchValueInherit,
  resolveBatchApplyTargets,
  resolveBatchWritePath,
  resolveGroupBatchCheckState,
  resolveGroupBatchSelectable,
} from "../src/settings/SubagentModelBatchApply.js";

function agent(overrides: Partial<AgentSummary> & Pick<AgentSummary, "id" | "name">): AgentSummary {
  return {
    description: "",
    systemPrompt: "prompt",
    enabled: true,
    readOnly: false,
    scope: "user",
    source: "user",
    ...overrides,
  } as AgentSummary;
}

test("batch targets include built-in, plugin and editable user agents", () => {
  const agents = [
    agent({ id: "1", name: "general-purpose", scope: "built-in", source: "built-in" }),
    agent({ id: "2", name: "Explore", scope: "built-in", source: "built-in" }),
    agent({ id: "3", name: "other-built-in", scope: "built-in", source: "built-in" }),
    agent({ id: "4", name: "plugin-agent", scope: "user", source: "plugin" }),
    agent({ id: "5", name: "my-agent", scope: "user", source: "user" }),
    agent({ id: "6", name: "workspace-agent", scope: "workspace", source: "user" }),
    agent({ id: "7", name: "readonly-agent", scope: "user", source: "user", readOnly: true }),
  ];
  const targets = resolveBatchApplyTargets(agents).map((item) => item.name);
  assert.deepEqual(targets, [
    "general-purpose",
    "Explore",
    "plugin-agent",
    "my-agent",
    "workspace-agent",
  ]);
});

test("write path distinguishes override rows from definition-file rows", () => {
  assert.equal(
    resolveBatchWritePath(
      agent({ id: "1", name: "Explore", scope: "built-in", source: "built-in" }),
    ),
    "override",
  );
  assert.equal(
    resolveBatchWritePath(agent({ id: "4", name: "plugin-agent", source: "plugin" })),
    "override",
  );
  assert.equal(resolveBatchWritePath(agent({ id: "5", name: "my-agent" })), "definitionFile");
});

test("group selectable counts only applicable rows and disables when none", () => {
  const onlyReadOnly = [agent({ id: "7", name: "readonly-agent", readOnly: true })];
  assert.equal(resolveGroupBatchSelectable(onlyReadOnly).selectableCount, 0);

  const mixed = [
    agent({ id: "1", name: "Explore", scope: "built-in", source: "built-in" }),
    agent({ id: "6", name: "another", scope: "workspace", source: "user" }),
  ];
  const { selectable, selectableCount } = resolveGroupBatchSelectable(mixed);
  assert.equal(selectableCount, 2);
  assert.equal(selectable[0]?.name, "Explore");
});

test("group check state reports unchecked/checked/indeterminate", () => {
  const group = [
    agent({ id: "1", name: "Explore", scope: "built-in", source: "built-in" }),
    agent({ id: "2", name: "my-agent" }),
  ];
  assert.equal(resolveGroupBatchCheckState(group, new Set()).state, "unchecked");
  assert.equal(resolveGroupBatchCheckState(group, new Set(["1"])).state, "indeterminate");
  assert.equal(resolveGroupBatchCheckState(group, new Set(["1", "2"])).state, "checked");
});

test("batch result summary projects counts, names and first failure message", () => {
  const summary = describeBatchResult({
    succeeded: ["general-purpose", "Explore"],
    failed: [
      { name: "plugin-agent", message: "model unavailable" },
      { name: "plugin-b", message: "write failed" },
    ],
  });
  assert.equal(summary.succeededCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.deepEqual(summary.failedNames, ["plugin-agent", "plugin-b"]);
  assert.equal(summary.firstFailureMessage, "model unavailable");
  assert.equal(describeBatchResult(createEmptyBatchResult()).succeededCount, 0);
});

test("inherit value is a blank model selection, matching the inline inherit semantics", () => {
  assert.equal(isBatchValueInherit({}), true);
  assert.equal(isBatchValueInherit({ modelSelection: undefined }), true);
  assert.equal(isBatchValueInherit({ modelSelection: { providerId: "zai", modelId: "" } }), true);
  assert.equal(
    isBatchValueInherit({ modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" } }),
    false,
  );
});

test("user agent batch config replaces modelSelection and preserves other fields", () => {
  const source = agent({
    id: "5",
    name: "my-agent",
    description: "desc",
    color: "cyan",
    tools: ["Read", "Grep"],
    skills: ["skill-a"],
    permissionMode: "plan",
    background: true,
    injectAgentsMd: false,
    mcpServers: [{ name: "srv", command: "node" }],
    modelSelection: { providerId: "zai", modelId: "GLM-4.7-Flash" },
  });

  const withModel = buildUserAgentBatchConfig(source, {
    modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" },
    thoughtLevel: "high",
    speed: "fast",
  });
  assert.deepEqual(withModel.modelSelection, {
    providerId: "zai",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high", speed: "fast" },
  });
  assert.equal(withModel.name, "my-agent");
  assert.deepEqual(withModel.tools, ["Read", "Grep"]);
  assert.deepEqual(withModel.skills, ["skill-a"]);
  assert.deepEqual(withModel.mcpServers, [{ name: "srv", command: "node" }]);
  assert.equal(withModel.permissionMode, "plan");
  assert.equal(withModel.background, true);
  assert.equal(withModel.injectAgentsMd, false);
  assert.equal(withModel.color, "cyan");
  assert.equal(withModel.description, "desc");

  const inherit = buildUserAgentBatchConfig(source, {});
  assert.equal(inherit.modelSelection, undefined);
  assert.equal(inherit.tools?.length, 2);
  assert.deepEqual(inherit.mcpServers, [{ name: "srv", command: "node" }]);
});

test("user agent batch config passes through declarative batch-2 keys", () => {
  // 声明键批②六键（apps/acode-cli/specs/subagent-declarative-keys.md）：updateAgent 按
  // config 面序列化 frontmatter，批量重写定义文件缺键即磁盘声明丢失，必须逐键透传。
  // maxTurns 不在载荷面（specs/subagent-maxturns-policy.md R1/R2 全链已删）。
  const source = agent({
    id: "5",
    name: "my-agent",
    isolation: "worktree",
    observer: "watcher",
    observerMessage: "hello",
    observeSubagents: true,
    initialPrompt: "boot",
    hooks: { PostToolUse: [{ matcher: "Read" }] },
  });
  const config = buildUserAgentBatchConfig(source, {
    modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" },
  });
  assert.equal(config.isolation, "worktree");
  assert.equal(config.observer, "watcher");
  assert.equal(config.observerMessage, "hello");
  assert.equal(config.observeSubagents, true);
  assert.equal(config.initialPrompt, "boot");
  assert.deepEqual(config.hooks, { PostToolUse: [{ matcher: "Read" }] });

  const untouched = agent({ id: "6", name: "bare" });
  const bare = buildUserAgentBatchConfig(untouched, {});
  assert.equal(bare.isolation, undefined);
  assert.equal(bare.observer, undefined);
  assert.equal(bare.initialPrompt, undefined);
  assert.equal(bare.hooks, undefined);
});

test("model selection round-trips through the markdown model formatter", () => {
  // 生产链路：批量目标值（ModelSelection 结构体）→ formatSubagentMarkdownModel 写盘
  // → parseSubagentMarkdownSelection 回读。custom: provider 必须无损往返，
  // 曾经的缺陷是 picker 编码串被当成 ModelSelection 再二次编码。
  const customSelection = { providerId: "custom:glm", modelId: "glm-4.6" } as const;
  const formatted = formatSubagentMarkdownModel(customSelection);
  const parsed = parseSubagentMarkdownSelection({ model: formatted });
  assert.equal(parsed?.providerId, "custom:glm");
  assert.equal(parsed?.modelId, "glm-4.6");
  // 双重编码形态必须解不出同样的值，防止回归。
  const doubleEncoded = `custom:${encodeURIComponent("custom:glm:glm-4.6")}:${encodeURIComponent("custom:glm:glm-4.6")}`;
  const parsedDouble = parseSubagentMarkdownSelection({ model: doubleEncoded });
  assert.notEqual(parsedDouble?.modelId, "glm-4.6");

  const simpleSelection = { providerId: "zai", modelId: "GLM-5.3-Flash" } as const;
  const simpleFormatted = formatSubagentMarkdownModel(simpleSelection);
  const simpleParsed = parseSubagentMarkdownSelection({ model: simpleFormatted });
  assert.equal(simpleParsed?.providerId, "zai");
  assert.equal(simpleParsed?.modelId, "GLM-5.3-Flash");
});

// speed 维度已随本仓落地：批量值可携带 speed，且必须写进 ModelSelection.options；
// 运行时 speed-missing 会拒绝派发，所以这是功能契约而非可选展示。
test("批量值携带 speed 时写入 ModelSelection，继承默认时不写", () => {
  const source = agent({ id: "9", name: "speed-agent" });
  const withSpeed = buildUserAgentBatchConfig(source, {
    modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" },
    speed: "standard",
  });
  assert.deepEqual(withSpeed.modelSelection?.options, { speed: "standard" });

  const inherit = buildUserAgentBatchConfig(source, { speed: "fast" });
  assert.equal(inherit.modelSelection, undefined);
});

test("markdown frontmatter 同时回读 thoughtLevel 与 speed", () => {
  const parsed = parseSubagentMarkdownSelection({
    model: "zai/GLM-5.3-Flash",
    thoughtLevel: "high",
    speed: "fast",
  });
  assert.deepEqual(parsed, {
    providerId: "zai",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high", speed: "fast" },
  });
});

test("isBatchApplicableAgent is exposed for row-level checkbox gating", () => {
  assert.equal(isBatchApplicableAgent(agent({ id: "1", name: "x" })), true);
  assert.equal(isBatchApplicableAgent(agent({ id: "7", name: "x", readOnly: true })), false);
});
