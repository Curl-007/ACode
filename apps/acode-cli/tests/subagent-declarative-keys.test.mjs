import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 子代理声明式 frontmatter 键验收（specs/subagent-declarative-keys.md R1/R4/R6/R8）：
 * - R8 既有键钉住：model inherit 语义、tools 替换式 + disallowedTools 双写防御、
 *   permissionMode project 剥离、maxTurns 残留键与未知键同等待遇（maxturns spec R3）；
 * - R1 新键解析：isolation 闭集（非法值拒绝整 profile）、observer 三键归并与孤儿键
 *   诊断、hooks 内联 JSON + project 源剥离 + 畸形丢弃、initialPrompt；
 * - R4 resolveMainSessionInitialPrompt 接口；
 * - R6 filesystem 语义段（子代理环境段变体）。
 */

const { parseAgentProfileFromMarkdown } = await import(
  "../packages/core/src/subagent/profile.ts"
);
const { resolveMainSessionInitialPrompt } = await import(
  "../packages/core/src/subagent/profile-declarative.ts"
);
const { filterSubagentChildToolNames } = await import(
  "../packages/core/src/subagent/tool-policy.ts"
);
const { buildSubagentEnvironmentContext } = await import(
  "../packages/core/src/subagent/system-prompt.ts"
);

function parse(frontmatter, options = {}) {
  const content = `---\n${frontmatter}\n---\n\nBody prompt.\n`;
  return parseAgentProfileFromMarkdown({
    content,
    source: options.source ?? "user",
    ...(options.path ? { path: options.path } : {}),
  });
}

const BASE = "name: probe\ndescription: test agent";

// ── R8 既有键语义钉住 ─────────────────────────────────────────────

test("(R8) model: inherit 别名 → modelSelection 缺席（继承父模型）", () => {
  for (const alias of ["inherit", "main"]) {
    const { profile } = parse(`${BASE}\nmodel: ${alias}`);
    assert.equal(profile.modelSelection, undefined, `model: ${alias} 应解析为继承`);
  }
});

test("(R8) 显式 provider/model → modelSelection 在场（override > profile > 父继承的 profile 位）", () => {
  const { profile } = parse(`${BASE}\nmodel: test-provider/test-model`);
  assert.deepEqual(profile.modelSelection, {
    providerId: "test-provider",
    modelId: "test-model",
  });
});

test("(R8) tools 替换式 + disallowedTools 双写防御保持（刻意差异 1：tools 在场不忽略）", () => {
  const { profile } = parse(`${BASE}\ntools: Read, Edit\ndisallowedTools: Edit`);
  assert.deepEqual(profile.tools, ["Read", "Edit"]);
  assert.deepEqual(profile.disallowedTools, ["Edit"]);
  // 叠加过滤：disallowedTools 在 tools 在场时仍然生效（Verify 双写防御的判据面）。
  const filtered = filterSubagentChildToolNames(profile.tools, profile.disallowedTools);
  assert.ok(filtered.includes("Read"));
  assert.ok(!filtered.includes("Edit"), "disallowedTools 必须压过 tools 白名单（更严方向）");
});

test("(R8) permissionMode：user 源保留，project 源剥离（仓库输入不得提权）", () => {
  assert.equal(parse(`${BASE}\npermissionMode: plan`).profile.permissionMode, "plan");
  assert.equal(
    parse(`${BASE}\npermissionMode: plan`, { source: "project" }).profile.permissionMode,
    undefined,
  );
});

test("(R8/maxturns spec R3) maxTurns 残留键：不产 diagnostic、不上 profile（与未知键同等待遇）", () => {
  const { diagnostic, profile } = parse(`${BASE}\nmaxTurns: 5`);
  assert.equal(diagnostic, undefined);
  assert.equal(profile.maxTurns, undefined);
});

// ── R1/R2 isolation ─────────────────────────────────────────────

test("(R2) isolation: worktree 合法值上 profile", () => {
  const { diagnostic, profile } = parse(`${BASE}\nisolation: worktree`);
  assert.equal(diagnostic, undefined);
  assert.equal(profile.isolation, "worktree");
});

test("(R2/R1) isolation 非法值 → 整个 profile 拒绝（fail-closed，绝不静默共享 cwd）", () => {
  const { diagnostic, profile } = parse(`${BASE}\nisolation: container`, {
    path: "/agents/iso.md",
  });
  assert.equal(profile, undefined, "非法 isolation 必须拒绝装配");
  assert.equal(diagnostic?.code, "agent_invalid_isolation");
  assert.ok(diagnostic?.message.includes("container"), "诊断需带上收到的非法值");
  assert.ok(diagnostic?.message.includes("/agents/iso.md"), "诊断需带文件路径");
});

test("(R1) isolation 裸键（空值）视同未声明，不产诊断", () => {
  const { diagnostic, profile } = parse(`${BASE}\nisolation:`);
  assert.equal(diagnostic, undefined);
  assert.equal(profile.isolation, undefined);
});

// ── R1/R3 observer 三键 ──────────────────────────────────────────

test("(R3) observer 三键归并为一个声明对象；observeSubagents 显式 false 保留", () => {
  const { diagnostic, profile } = parse(
    `${BASE}\nobserver: note-taker\nobserverMessage: watch for scope creep\nobserveSubagents: false`,
  );
  assert.equal(diagnostic, undefined);
  assert.deepEqual(profile.observer, {
    agentType: "note-taker",
    message: "watch for scope creep",
    observeSubagents: false,
  });
});

test("(R3) observeSubagents 缺省不写死（消费面按缺省 true 语义）；显式 true 保留", () => {
  assert.equal(parse(`${BASE}\nobserver: watcher`).profile.observer.observeSubagents, undefined);
  assert.equal(
    parse(`${BASE}\nobserver: watcher\nobserveSubagents: true`).profile.observer.observeSubagents,
    true,
  );
});

test("(R1) observer 孤儿键 → 键丢弃 + agent_observer_declaration_incomplete，profile 照常加载", () => {
  const { diagnostic, profile } = parse(`${BASE}\nobserverMessage: dangling note`);
  assert.ok(profile, "孤儿键不是致命错误");
  assert.equal(profile.observer, undefined);
  assert.equal(diagnostic?.code, "agent_observer_declaration_incomplete");
});

// ── R1/R5 hooks ─────────────────────────────────────────────────

test("(R5) hooks 内联 JSON 对象上 profile（原始声明，注册面归 hooks 所有权）", () => {
  const { diagnostic, profile } = parse(
    `${BASE}\nhooks: {"PreToolUse": [{"hooks": [{"type": "command", "command": "echo hi"}]}]}`,
  );
  assert.equal(diagnostic, undefined);
  assert.ok(profile.hooks?.PreToolUse, "hooks 原始声明必须完整保留");
});

test("(R1) hooks 畸形（YAML 列表形态）→ 丢弃 + agent_invalid_hooks（fail-closed 不带病注册）", () => {
  const { diagnostic, profile } = parse(`${BASE}\nhooks:\n  - PreToolUse`);
  assert.ok(profile);
  assert.equal(profile.hooks, undefined);
  assert.equal(diagnostic?.code, "agent_invalid_hooks");
});

test("(R1) project 源剥离 hooks（仓库输入不得注册命令执行面），user 源保留", () => {
  const hooksLine = 'hooks: {"Stop": []}';
  const project = parse(`${BASE}\n${hooksLine}`, { source: "project" });
  assert.equal(project.profile.hooks, undefined);
  assert.equal(project.diagnostic, undefined, "剥离是静默的（与 permissionMode 同款判据）");
  const user = parse(`${BASE}\n${hooksLine}`, { source: "user" });
  assert.deepEqual(user.profile.hooks, { Stop: [] });
});

// ── R4 initialPrompt ─────────────────────────────────────────────

test("(R4) initialPrompt 原样保留；resolveMainSessionInitialPrompt 对空白返回 undefined", () => {
  const { profile } = parse(`${BASE}\ninitialPrompt: Start by reading AGENTS.md`);
  assert.equal(profile.initialPrompt, "Start by reading AGENTS.md");
  assert.equal(resolveMainSessionInitialPrompt(profile), "Start by reading AGENTS.md");
  assert.equal(resolveMainSessionInitialPrompt({ initialPrompt: "   " }), undefined);
  assert.equal(resolveMainSessionInitialPrompt({}), undefined);
});

// ── R6 filesystem 语义段（子代理环境段变体）────────────────────────

const ENV_INFO = {
  cwd: "/home/demo/repo",
  platform: "linux",
  shell: "bash",
  osVersion: "Linux 6.1.0 x64",
  nodeVersion: "v22.0.0",
};

test("(R6) 子代理环境段含 filesystem 语义三要素，<env> 事实块不动", () => {
  const content = buildSubagentEnvironmentContext({ agentPrompt: "", envInfo: ENV_INFO });
  // ① 真实文件夹语义（无备份、删除不可撤销）：
  assert.match(content, /real folder on the user's computer/i);
  assert.match(content, /no backup copy/i);
  assert.match(content, /deletions cannot be undone/i);
  // ② outputs 语义（报告即最终回复，harness 落盘，不自建报告文件）：
  assert.match(content, /final response is your report/i);
  assert.match(content, /output files/i);
  // ③ Self-Modification 语义（配置是真实文件，改写即改写未来行为）：
  assert.match(content, /self-modification/i);
  assert.match(content, /workspace \.acode folder/i);
  // 事实块既有行保持：
  assert.ok(content.includes("Working directory: /home/demo/repo"));
  assert.ok(content.indexOf("</env>") < content.indexOf("Filesystem semantics:"));
});

test("(R6) scratch 缺席零渲染语义不变（R5.3-b 回归面）", () => {
  const content = buildSubagentEnvironmentContext({ agentPrompt: "", envInfo: ENV_INFO });
  assert.ok(!content.includes("Scratch directory"));
  const withScratch = buildSubagentEnvironmentContext({
    agentPrompt: "",
    envInfo: ENV_INFO,
    scratchDir: "/tmp/scratch",
  });
  assert.ok(withScratch.includes("Scratch directory (temporary files): /tmp/scratch"));
  assert.ok(withScratch.indexOf("Scratch directory") < withScratch.indexOf("</env>"));
});
