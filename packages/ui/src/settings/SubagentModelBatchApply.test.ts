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
  isSubagentSpeedInvalid,
  resolveBatchApplyTargets,
  resolveBatchWritePath,
  resolveGroupBatchCheckState,
  resolveGroupBatchSelectable,
  resolveSubagentSpeedOptionState,
} from "./SubagentModelBatchApply.js";

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
    maxTurns: 8,
    background: true,
    injectAgentsMd: false,
    mcpServers: [{ name: "srv", command: "node" }],
    modelSelection: { providerId: "zai", modelId: "GLM-4.7-Flash" },
  });

  const withModel = buildUserAgentBatchConfig(source, {
    modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" },
    thoughtLevel: "high",
  });
  assert.deepEqual(withModel.modelSelection, {
    providerId: "zai",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high" },
  });
  assert.equal(withModel.name, "my-agent");
  assert.deepEqual(withModel.tools, ["Read", "Grep"]);
  assert.deepEqual(withModel.skills, ["skill-a"]);
  assert.deepEqual(withModel.mcpServers, [{ name: "srv", command: "node" }]);
  assert.equal(withModel.permissionMode, "plan");
  assert.equal(withModel.maxTurns, 8);
  assert.equal(withModel.background, true);
  assert.equal(withModel.injectAgentsMd, false);
  assert.equal(withModel.color, "cyan");
  assert.equal(withModel.description, "desc");

  const inherit = buildUserAgentBatchConfig(source, {});
  assert.equal(inherit.modelSelection, undefined);
  assert.equal(inherit.tools?.length, 2);
  assert.deepEqual(inherit.mcpServers, [{ name: "srv", command: "node" }]);
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

test("speed round-trips through the markdown frontmatter", () => {
  // 带 speed spec 的模型运行时必选 speed（registry speed-missing）；定义文件
  // 曾只写 model/thoughtLevel，speed 在写盘时被静默丢弃导致派发失败。
  const parsed = parseSubagentMarkdownSelection({
    model: "zai/GLM-5.3-Flash",
    thoughtLevel: "high",
    speed: "fast",
  });
  assert.deepEqual(parsed?.options, { reasoningLevel: "high", speed: "fast" });

  // 旧文件没有 speed 字段时仍按原语义解析（不强制、不报错）。
  const legacy = parseSubagentMarkdownSelection({
    model: "zai/GLM-5.3-Flash",
    thoughtLevel: "high",
  });
  assert.deepEqual(legacy?.options, { reasoningLevel: "high" });

  // 只有 speed 无档位也合法（speed spec 与 reasoning spec 相互独立）。
  const speedOnly = parseSubagentMarkdownSelection({
    model: "zai/GLM-5.3-Flash",
    speed: "fast",
  });
  assert.deepEqual(speedOnly?.options, { speed: "fast" });
});

test("batch value carries speed into the user agent definition config", () => {
  const source = agent({ id: "5", name: "my-agent", description: "d", systemPrompt: "p" });
  const config = buildUserAgentBatchConfig(source, {
    modelSelection: { providerId: "zai", modelId: "GLM-5.3-Flash" },
    thoughtLevel: "high",
    speed: "fast",
  });
  assert.deepEqual(config.modelSelection, {
    providerId: "zai",
    modelId: "GLM-5.3-Flash",
    options: { reasoningLevel: "high", speed: "fast" },
  });
});

test("speed option state resolves from the registry view", () => {
  const view = {
    providers: [
      {
        providerId: "zai",
        models: [
          {
            modelId: "with-speed",
            config: { optionSpecs: { speed: { values: ["standard", "fast"] } } },
          },
          { modelId: "no-speed", config: { optionSpecs: {} } },
        ],
      },
    ],
  };
  assert.deepEqual(
    resolveSubagentSpeedOptionState({
      modelSelectionView: view,
      modelSelection: { providerId: "zai", modelId: "with-speed" },
      modelSelectionLoading: false,
    }),
    { kind: "supported", values: ["standard", "fast"] },
  );
  assert.deepEqual(
    resolveSubagentSpeedOptionState({
      modelSelectionView: view,
      modelSelection: { providerId: "zai", modelId: "no-speed" },
      modelSelectionLoading: false,
    }),
    { kind: "not-applicable" },
  );
  assert.deepEqual(
    resolveSubagentSpeedOptionState({
      modelSelectionView: view,
      modelSelection: undefined,
      modelSelectionLoading: false,
    }),
    { kind: "not-applicable" },
  );
});

test("unknown registry state does not misclassify speed as unsupported", () => {
  assert.deepEqual(
    resolveSubagentSpeedOptionState({
      modelSelection: { providerId: "zai", modelId: "model" },
      modelSelectionLoading: true,
    }),
    { kind: "unknown", status: "loading" },
  );
  assert.deepEqual(
    resolveSubagentSpeedOptionState({
      modelSelection: { providerId: "zai", modelId: "model" },
      modelSelectionLoading: false,
    }),
    { kind: "unknown", status: "unavailable" },
  );
});

test("speed validation blocks missing or unsupported values only for supported models", () => {
  assert.equal(
    isSubagentSpeedInvalid({ kind: "supported", values: ["standard", "fast"] }, undefined),
    true,
  );
  assert.equal(
    isSubagentSpeedInvalid({ kind: "supported", values: ["standard", "fast"] }, "other"),
    true,
  );
  assert.equal(
    isSubagentSpeedInvalid({ kind: "supported", values: ["standard", "fast"] }, "fast"),
    false,
  );
  assert.equal(isSubagentSpeedInvalid({ kind: "not-applicable" }, undefined), false);
  assert.equal(isSubagentSpeedInvalid({ kind: "unknown", status: "loading" }, undefined), false);
});

test("isBatchApplicableAgent is exposed for row-level checkbox gating", () => {
  assert.equal(isBatchApplicableAgent(agent({ id: "1", name: "x" })), true);
  assert.equal(isBatchApplicableAgent(agent({ id: "7", name: "x", readOnly: true })), false);
});
