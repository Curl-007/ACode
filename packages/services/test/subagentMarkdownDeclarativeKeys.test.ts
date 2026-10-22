import assert from "node:assert/strict";
import test from "node:test";
import type { SubAgentConfig } from "@acode/shared";
import {
  parseSubagentMarkdown,
  serializeSubagentMarkdown,
} from "../src/subagents/subagentMarkdown.js";

/**
 * 代理声明键批② GUI 往返守护（apps/acode-cli/specs/subagent-declarative-keys.md
 * 接线需求 3）：isolation / observer 三键 / initialPrompt / hooks 四组新键在
 * parse ↔ serialize 往返中不丢、不变形；解析语义对齐 runtime 单点
 * （core/subagent/profile-declarative.ts）——isolation 非空非法值拒整个 profile、
 * observer 孤儿键丢弃、hooks 仅内联 JSON 对象形态。
 */

const BASE_CONFIG: SubAgentConfig = {
  name: "reviewer",
  description: "Reviews changes carefully.",
  systemPrompt: "You review diffs.",
};

function markdown(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\nYou review diffs.\n`;
}

function parse(frontmatter: string) {
  return parseSubagentMarkdown({
    content: markdown(frontmatter),
    path: "/repo/.acode/agents/reviewer.md",
    scope: "workspace",
  });
}

test("parse：四组新键全部提取，多行 initialPrompt 的 \\n 字面量按 description 同约定还原", () => {
  const parsed = parse(
    [
      'name: "reviewer"',
      'description: "Reviews changes carefully."',
      "isolation: worktree",
      "observer: Review",
      'observerMessage: "focus on race conditions"',
      "observeSubagents: false",
      'initialPrompt: "line one\\nline two"',
      'hooks: {"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node .acode/hooks/guard.mjs"}]}]}',
    ].join("\n"),
  );
  assert.equal(parsed.diagnostic, undefined);
  const agent = parsed.agent;
  assert.ok(agent);
  assert.equal(agent.isolation, "worktree");
  assert.equal(agent.observer, "Review");
  assert.equal(agent.observerMessage, "focus on race conditions");
  assert.equal(agent.observeSubagents, false);
  assert.equal(agent.initialPrompt, "line one\nline two");
  assert.ok(agent.hooks && typeof agent.hooks === "object");
  assert.ok(Array.isArray((agent.hooks as { PreToolUse?: unknown }).PreToolUse));
});

test("parse：isolation 非空非法值拒整个 profile（诊断 code 与 runtime 单点一致）", () => {
  const parsed = parse(['name: "reviewer"', 'description: "d"', "isolation: container"].join("\n"));
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_invalid_isolation");
});

test("parse：isolation 裸键/空串视同未声明；hooks 非对象丢弃；observer 孤儿键丢弃", () => {
  const bare = parse(
    [
      'name: "reviewer"',
      'description: "d"',
      "isolation:",
      'observerMessage: "orphan"',
      "observeSubagents: true",
      "hooks: not-an-object",
    ].join("\n"),
  );
  assert.ok(bare.agent);
  assert.equal(bare.agent.isolation, undefined);
  assert.equal(bare.agent.observer, undefined);
  assert.equal(
    bare.agent.observerMessage,
    undefined,
    "无 observer 的 observerMessage 是孤儿键，必须丢弃",
  );
  assert.equal(bare.agent.observeSubagents, undefined);
  assert.equal(bare.agent.hooks, undefined, "非对象 hooks 必须丢弃（runtime 同款 fail-closed）");
  assert.equal(bare.diagnostic, undefined);
});

test("serialize：新键全部写回；hooks 是单行内联 JSON；无 observer 时不生产孤儿键", () => {
  const serialized = serializeSubagentMarkdown({
    ...BASE_CONFIG,
    isolation: "worktree",
    observer: "Review",
    observerMessage: "focus on races",
    observeSubagents: false,
    initialPrompt: "start here\nthen here",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node hooks/stop.mjs" }] }] },
  });
  const lines = serialized.split("\n");
  assert.ok(lines.includes("isolation: worktree"));
  assert.ok(lines.includes('observer: "Review"'));
  assert.ok(lines.includes('observerMessage: "focus on races"'));
  assert.ok(lines.includes("observeSubagents: false"));
  assert.ok(lines.includes('initialPrompt: "start here\\nthen here"'));
  const hooksLine = lines.find((line) => line.startsWith("hooks:"));
  assert.ok(hooksLine, "hooks 键缺失");
  // 单行内联 JSON：整份 frontmatter 里 hooks 只占一行（block 形态会出现缩进子行，
  // 逐行 loose 解析会把它们退化成空数组/丢弃）。
  assert.ok(hooksLine!.startsWith("hooks: {") && hooksLine!.endsWith("}"));
  assert.ok(
    !lines.some(
      (line) => line !== hooksLine && line.trimStart().startsWith("- ") && line.startsWith("  "),
    ),
    "hooks 泄漏成了多行 YAML block 形态",
  );

  const orphanFree = serializeSubagentMarkdown({
    ...BASE_CONFIG,
    observerMessage: "orphan",
    observeSubagents: true,
  });
  assert.ok(!orphanFree.includes("observerMessage"), "GUI 不得生产 runtime 会丢弃的孤儿键");
  assert.ok(!orphanFree.includes("observeSubagents"));
});

test("往返稳定：serialize → parse → serialize 逐字节收敛，四组键值全保真", () => {
  const config: SubAgentConfig = {
    ...BASE_CONFIG,
    isolation: "worktree",
    observer: "Review",
    observerMessage: "watch for deadlocks",
    observeSubagents: true,
    initialPrompt: "multi\nline\nprompt",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }] },
  };
  const first = serializeSubagentMarkdown(config);
  const parsed = parseSubagentMarkdown({
    content: first,
    path: "/repo/.acode/agents/reviewer.md",
    scope: "workspace",
  });
  assert.equal(parsed.diagnostic, undefined);
  const agent = parsed.agent;
  assert.ok(agent);
  assert.equal(agent.isolation, config.isolation);
  assert.equal(agent.observer, config.observer);
  assert.equal(agent.observerMessage, config.observerMessage);
  assert.equal(agent.observeSubagents, config.observeSubagents);
  assert.equal(agent.initialPrompt, config.initialPrompt);
  assert.deepEqual(agent.hooks, config.hooks);

  const second = serializeSubagentMarkdown({
    ...BASE_CONFIG,
    ...(agent.isolation ? { isolation: agent.isolation } : {}),
    ...(agent.observer ? { observer: agent.observer } : {}),
    ...(agent.observerMessage ? { observerMessage: agent.observerMessage } : {}),
    ...(agent.observeSubagents !== undefined ? { observeSubagents: agent.observeSubagents } : {}),
    ...(agent.initialPrompt ? { initialPrompt: agent.initialPrompt } : {}),
    ...(agent.hooks ? { hooks: agent.hooks } : {}),
  });
  assert.equal(second, first, "第二次序列化漂移：往返不收敛");
});

test("存量键零回归：不带新键的旧文件解析/序列化形状不变", () => {
  const parsed = parse(
    [
      'name: "reviewer"',
      'description: "Reviews changes carefully."',
      "background: true",
      "permissionMode: plan",
    ].join("\n"),
  );
  assert.ok(parsed.agent);
  assert.equal(parsed.agent.background, true);
  assert.equal(parsed.agent.permissionMode, "plan");
  assert.equal(parsed.agent.isolation, undefined);
  assert.equal(parsed.agent.observer, undefined);
  assert.equal(parsed.agent.initialPrompt, undefined);
  assert.equal(parsed.agent.hooks, undefined);
  const serialized = serializeSubagentMarkdown(BASE_CONFIG);
  assert.ok(!serialized.includes("isolation"));
  assert.ok(!serialized.includes("observer"));
  assert.ok(!serialized.includes("initialPrompt"));
  assert.ok(!serialized.includes("hooks"));
});

test("speed frontmatter 与 thoughtLevel 一起序列化并可回读", () => {
  const config: SubAgentConfig = {
    ...BASE_CONFIG,
    modelSelection: {
      providerId: "zai",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  };
  const serialized = serializeSubagentMarkdown(config);
  assert.match(serialized, /thoughtLevel: high/u);
  assert.match(serialized, /speed: fast/u);
  const parsed = parseSubagentMarkdown({
    content: serialized,
    path: "/repo/.acode/agents/reviewer.md",
    scope: "workspace",
  });
  assert.deepEqual(parsed.agent?.modelSelection, config.modelSelection);
});
