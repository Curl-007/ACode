import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSummary } from "@acode/shared";
import { buildSubagentSaveConfig } from "../src/settings/subagentFormSaveConfig.js";

// WI2-D 微收尾③：子智能体编辑面板 GUI 往返保键断言
// （apps/acode-cli/specs/subagent-declarative-keys.md 接线需求 3）。
// 表单不呈现声明键批②六键，但保存构造路径必须从 AgentSummary 快照透传，
// 否则一次「编辑并保存」就会把磁盘 frontmatter 里的声明静默抹掉。

function makeSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "user:workspace:reviewer",
    name: "reviewer",
    description: "reviews changes",
    systemPrompt: "You review code.",
    path: "/tmp/ws/.acode/agents/reviewer.md",
    scope: "workspace",
    source: "user",
    enabled: true,
    ...overrides,
  };
}

const FORM_BASE = {
  name: "reviewer",
  description: "reviews changes (edited)",
  systemPrompt: "You review code carefully.",
  color: "green" as const,
  injectAgentsMd: false,
};

test("六键在 AgentSummary → SubAgentConfig 构造中逐一保留", () => {
  const initial = makeSummary({
    isolation: "worktree",
    observer: "Review",
    observerMessage: "watch for scope creep",
    observeSubagents: true,
    initialPrompt: "start from the diff",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
  });
  const config = buildSubagentSaveConfig({ initial, ...FORM_BASE });
  assert.equal(config.isolation, "worktree");
  assert.equal(config.observer, "Review");
  assert.equal(config.observerMessage, "watch for scope creep");
  assert.equal(config.observeSubagents, true);
  assert.equal(config.initialPrompt, "start from the diff");
  // hooks 是结构化对象：必须同引用/同形状透传，不做归并或校验（语义单点在 CLI）。
  assert.deepEqual(config.hooks, { PreToolUse: [{ matcher: "Bash", hooks: [] }] });
});

test("部分声明键：缺席键保持 undefined，在场键不被邻居污染", () => {
  const initial = makeSummary({ isolation: "worktree", observeSubagents: false });
  const config = buildSubagentSaveConfig({ initial, ...FORM_BASE });
  assert.equal(config.isolation, "worktree");
  assert.equal(config.observeSubagents, false);
  assert.equal(config.observer, undefined);
  assert.equal(config.observerMessage, undefined);
  assert.equal(config.initialPrompt, undefined);
  assert.equal(config.hooks, undefined);
});

test("既有透传键（disallowedTools/skills/permissionMode/background/mcpServers）不回退", () => {
  const mcpServers = [{ name: "srv", url: "https://example.invalid/mcp" }];
  const initial = makeSummary({
    disallowedTools: ["WebFetch"],
    skills: ["code-review"],
    permissionMode: "plan",
    background: true,
    mcpServers,
  });
  const config = buildSubagentSaveConfig({ initial, ...FORM_BASE });
  assert.deepEqual(config.disallowedTools, ["WebFetch"]);
  assert.deepEqual(config.skills, ["code-review"]);
  assert.equal(config.permissionMode, "plan");
  assert.equal(config.background, true);
  assert.equal(config.mcpServers, mcpServers);
});

test("新建表单（无 initial）不凭空造键；表单值与条件语义原样", () => {
  const modelSelection = { providerId: "glm", modelId: "m1" } as const;
  const config = buildSubagentSaveConfig({
    ...FORM_BASE,
    modelSelection,
    tools: ["Read", "Grep"],
  });
  assert.equal(config.name, "reviewer");
  assert.equal(config.description, "reviews changes (edited)");
  assert.equal(config.systemPrompt, "You review code carefully.");
  assert.equal(config.color, "green");
  assert.equal(config.injectAgentsMd, false);
  assert.deepEqual(config.modelSelection, modelSelection);
  assert.deepEqual(config.tools, ["Read", "Grep"]);
  for (const key of [
    "isolation",
    "observer",
    "observerMessage",
    "observeSubagents",
    "initialPrompt",
    "hooks",
  ] as const) {
    assert.equal(config[key], undefined, `新建表单不应产生 ${key}`);
  }
  // inherit 模型不写 modelSelection 键（沿用既有条件展开语义）。
  const inherit = buildSubagentSaveConfig({ ...FORM_BASE });
  assert.equal("modelSelection" in inherit, false);
  assert.equal(inherit.tools, undefined);
});
