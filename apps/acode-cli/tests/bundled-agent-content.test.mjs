import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * C1 内容层验收测试：bundled 官方预置子智能体 Plan / Verify / Review。
 *
 * 覆盖规格 apps/acode-cli/specs/builtin-subagent-catalog.md 的 R2 目录表与
 * R3 写作纪律（验收场景 9 的自动断言部分）：
 * - frontmatter 经 parseAgentProfileFromMarkdown 零 diagnostic，profile 字段逐项钉死（R2）；
 * - description 非空、≤350 字符、含触发句与负边界/能力边界锚点（R3）；
 * - description 与正文无 CJK（prompt-language-policy R1 同款断言）；
 * - 强制尾部小节标题字面量在场（R3 第 6 条）；
 * - Plan 正文含 perspective 输入契约（R3 第 7 条）；
 * - 正文不复述 common notes（R3 第 2 条，特征句缺席断言）；
 * - skills 引用与同包技能 SKILL.md frontmatter name 一致（R1/R3 第 5 条）。
 */

const AGENTS_ROOT = new URL("../packages/bundled-skills/agents/", import.meta.url);
const SKILLS_ROOT = new URL("../packages/bundled-skills/skills/", import.meta.url);

const { parseAgentProfileFromMarkdown } = await import(
  "../packages/core/src/subagent/profile.ts"
);

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

// common notes（core/src/subagent/system-prompt.ts buildSubagentCommonNotes）的特征句：
// 已全量注入每个子代理，profile prompt 复述即稀释两处文本各自所有权（R3 第 2 条）。
const COMMON_NOTE_SIGNATURES = [
  "cwd reset between bash calls",
  "MUST avoid using emojis",
  "Do NOT Write report/summary/findings/analysis .md files",
];

// R2 目录表钉死值。注意：Verify 的 disallowedTools 只列真实注册的编辑类工具
// Edit / Write / ApplyPatch（core/src/tool/provider-visible-order.ts 注册名单）；
// spec R2 表中提到的 NotebookEdit 是已被移除的占位死名，本构建不存在该工具，
// 写入 disallowedTools 反而制造模型可见文本的悬空引用（prompt-corpus-audit F7 判例）。
const EXPECTED = {
  "Plan.md": {
    name: "Plan",
    color: "purple",
    permissionMode: "plan",
    background: false,
    injectAgentsMd: true,
    tools: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch", "TodoWrite"],
    disallowedTools: undefined,
    skills: undefined,
    tailHeading: "### Critical Files for Implementation",
  },
  "Verify.md": {
    name: "Verify",
    color: "green",
    permissionMode: undefined,
    background: true,
    injectAgentsMd: true,
    tools: ["Bash", "Read", "Grep", "Glob", "TodoWrite"],
    disallowedTools: ["Edit", "Write", "ApplyPatch"],
    skills: ["verify"],
    tailHeading: "### Check Results",
  },
  "Review.md": {
    name: "Review",
    color: "yellow",
    permissionMode: "plan",
    background: true,
    injectAgentsMd: true,
    tools: ["Read", "Grep", "Glob", "Bash", "TodoWrite"],
    disallowedTools: undefined,
    skills: ["code-review"],
    tailHeading: "### Verdict",
  },
};

async function loadAgent(fileName) {
  const url = new URL(fileName, AGENTS_ROOT);
  const content = await readFile(url, "utf8");
  const result = parseAgentProfileFromMarkdown({
    content,
    path: fileURLToPath(url),
    source: "built-in",
  });
  assert.equal(
    result.diagnostic,
    undefined,
    `${fileName} 解析出 diagnostic: ${JSON.stringify(result.diagnostic)}`,
  );
  assert.ok(result.profile, `${fileName} 未解析出 profile`);
  return result.profile;
}

async function readSkillName(skillDir) {
  const text = await readFile(new URL(`${skillDir}/SKILL.md`, SKILLS_ROOT), "utf8");
  const match = text.match(/^---\r?\nname:[ \t]*(.+?)\s*$/mu);
  assert.ok(match, `${skillDir}/SKILL.md 缺少 name frontmatter`);
  return match[1];
}

for (const [fileName, expected] of Object.entries(EXPECTED)) {
  test(`${fileName}: frontmatter 零 diagnostic 且 profile 字段与 R2 目录表逐项一致`, async () => {
    const profile = await loadAgent(fileName);
    assert.equal(profile.name, expected.name);
    assert.equal(profile.source, "built-in");
    assert.equal(profile.color, expected.color);
    assert.equal(profile.permissionMode, expected.permissionMode);
    assert.equal(profile.background, expected.background);
    assert.equal(profile.injectAgentsMd, expected.injectAgentsMd);
    assert.deepEqual([...profile.tools], expected.tools);
    assert.deepEqual(
      profile.disallowedTools ? [...profile.disallowedTools] : undefined,
      expected.disallowedTools,
    );
    assert.deepEqual(
      profile.skills ? [...profile.skills] : undefined,
      expected.skills,
    );
    // v1 预置不钉模型档位，继承父模型（R5）。
    assert.equal(profile.modelSelection, undefined);
    assert.equal(profile.mcpServers, undefined);
    assert.equal(profile.memory, undefined);
  });

  test(`${fileName}: description 非空、≤350 字符、三要素锚点在场（R3）`, async () => {
    const profile = await loadAgent(fileName);
    assert.ok(profile.description.trim().length > 0, "description 为空");
    assert.ok(
      profile.description.length <= 350,
      `description 超长: ${profile.description.length} 字符`,
    );
    // 触发句（"Use when …"）与负边界/能力边界句（Cannot/Never/Not a 之一）。
    assert.match(profile.description, /Use when\b/u);
    assert.match(profile.description, /Cannot|Never|Not a|Does not/u);
  });

  test(`${fileName}: description 与正文无 CJK（prompt-language-policy R1）`, async () => {
    const profile = await loadAgent(fileName);
    assert.ok(!CJK_PATTERN.test(profile.description), "description 含 CJK 字符");
    assert.ok(!CJK_PATTERN.test(profile.systemPrompt), "正文含 CJK 字符");
  });

  test(`${fileName}: 强制尾部小节标题字面量在场（R3 第 6 条）`, async () => {
    const profile = await loadAgent(fileName);
    const headingLine = new RegExp(`^${expected.tailHeading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu");
    assert.match(profile.systemPrompt, headingLine);
  });

  test(`${fileName}: 正文不复述 common notes 特征句（R3 第 2 条）`, async () => {
    const profile = await loadAgent(fileName);
    for (const signature of COMMON_NOTE_SIGNATURES) {
      assert.ok(
        !profile.systemPrompt.includes(signature),
        `正文复述 common notes 特征句: ${signature}`,
      );
    }
  });
}

test("Plan.md: perspective 输入契约在场（R3 第 7 条）", async () => {
  const profile = await loadAgent("Plan.md");
  // 契约三要素：可选视角入参、带视角时开头声明并全程贯彻、不带时均衡权衡。
  assert.match(profile.systemPrompt, /optional perspective/iu);
  assert.match(profile.systemPrompt, /declare it in the opening line/iu);
  assert.match(profile.systemPrompt, /carry it through every design decision/iu);
  assert.match(profile.systemPrompt, /When no perspective is given, weigh the options in a balanced way/u);
});

test("Verify.md: skills 引用与同包 verify 技能 frontmatter name 一致", async () => {
  const profile = await loadAgent("Verify.md");
  const skillName = await readSkillName("verify");
  assert.equal(skillName, "verify");
  assert.deepEqual([...profile.skills], [skillName]);
});

test("Review.md: skills 引用与同包 code-review 技能 frontmatter name 一致", async () => {
  const profile = await loadAgent("Review.md");
  const skillName = await readSkillName("code-review");
  assert.equal(skillName, "code-review");
  assert.deepEqual([...profile.skills], [skillName]);
});
