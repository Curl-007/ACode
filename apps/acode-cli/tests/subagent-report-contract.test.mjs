import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * W1 验收测试：子代理汇报契约与工作纪律。
 *
 * 覆盖规格 apps/acode-cli/specs/subagent-report-contract.md 的 R1–R4 与验收场景 1–4：
 * - 场景 1：common notes 的汇报契约（结构 + 验证/意图区分 + good/bad 示例），既有条目逐字保留；
 * - 场景 2：general-purpose 的五条工作纪律，既有内容逐字保留；
 * - 场景 3：explore 空结果诚实条款（两个变体），只读红线与命令白名单逐字不变（W4 钉住）；
 * - 场景 4：三个构建函数输出无 CJK（prompt-language-policy R1 同款断言）。
 */

const { buildSubagentCommonNotes } = await import(
  "../packages/core/src/subagent/system-prompt.ts"
);
const { buildGeneralPurposeSystemPrompt } = await import(
  "../packages/core/src/subagent/general-purpose.ts"
);
const { buildExploreAgentPrompt } = await import("../packages/core/src/subagent/explore.ts");

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

test("(场景1/R1) common notes 含汇报契约：结构、验证/意图区分、good/bad 示例", () => {
  const notes = buildSubagentCommonNotes();
  // 契约三要素：
  assert.match(notes, /Structure your final response for the parent agent/);
  assert.match(notes, /one sentence the parent can relay to the user as-is/);
  assert.match(notes, /Describe what you verified, not what you intended/);
  assert.match(notes, /if you did not run the tests, say so/);
  // good/bad 对照示例各一行（示例是契约的一部分，R1 第 3 点）：
  assert.match(notes, /^\s+Good: "Added the null check in src\/auth\/validate\.ts:42/m);
  assert.match(notes, /Bad: "I looked at the files and made the changes we discussed\."/);
  // 既有条目逐字保留（新增是追加 bullet，不改写旧条）：
  assert.ok(notes.includes("cwd reset between bash calls"));
  assert.ok(notes.includes("share file paths (always absolute, never relative)"));
  assert.ok(notes.includes("MUST avoid using emojis"));
  assert.ok(notes.includes("Do not use a colon before tool calls"));
  assert.ok(notes.includes("Do NOT Write report/summary/findings/analysis .md files"));
});

test("(场景2/R2) general-purpose 含五条工作纪律，既有内容逐字保留", () => {
  const prompt = buildGeneralPurposeSystemPrompt();
  assert.ok(prompt.includes("Working discipline:"));
  // 1 scope 纪律：
  assert.match(prompt, /Do not fix unrelated problems you notice along the way/);
  assert.match(prompt, /report them as follow-up suggestions instead/);
  // 2 验证后完成：
  assert.match(prompt, /Before reporting a code change as done, verify it/);
  assert.match(prompt, /If you could not verify, say so explicitly/);
  // 3 git 卫生（含禁令字面量）：
  assert.match(prompt, /never `git add \.` or `git add -A`/);
  assert.match(prompt, /report the commit hash/);
  // 4 被拒协议（「一次」语义 + 禁绕路）：
  assert.match(prompt, /report the exact action, the reason, and what approval would unblock it \u2014 once/);
  assert.match(prompt, /Do not retry the same denied action or route around the denial/);
  // 5 resume 语义：
  assert.match(prompt, /You may be resumed later with a brief follow-up/);
  assert.match(prompt, /terse instructions are intentional, not ambiguous/);
  // 既有内容逐字保留：
  assert.ok(prompt.startsWith("You are an agent for ACode CLI."));
  assert.ok(prompt.includes("Complete the task fully\u2014don't gold-plate"));
  assert.ok(prompt.includes("NEVER create files unless they're absolutely necessary"));
  assert.ok(prompt.includes("NEVER proactively create documentation files"));
});

test("(场景3/R3) explore 空结果诚实条款在两个变体都在场", () => {
  for (const options of [{}, { embeddedSearchEnabled: true }]) {
    const prompt = buildExploreAgentPrompt(options);
    assert.match(prompt, /If you find nothing, say so plainly and list what you searched/);
    assert.match(prompt, /never fill gaps from memory or invent plausible paths or symbols/);
  }
});

test("(场景3/W4) explore 只读红线与 POSIX 命令白名单逐字不变", () => {
  const direct = buildExploreAgentPrompt({});
  const embedded = buildExploreAgentPrompt({ embeddedSearchEnabled: true });
  // 只读红线段：
  for (const prompt of [direct, embedded]) {
    assert.ok(prompt.includes("=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ==="));
    assert.ok(prompt.includes("You do NOT have access to file editing tools"));
    assert.ok(
      prompt.includes(
        "- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
      ),
    );
  }
  // 命令白名单按 embeddedSearchEnabled 分叉（W4 结论：全平台 POSIX 方言，无 PowerShell 变体）：
  assert.ok(
    direct.includes(
      "- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)",
    ),
  );
  assert.ok(
    embedded.includes(
      "- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)",
    ),
  );
  // 钉住「不引入 PowerShell 清单」：出现 PowerShell 措辞即回归 W4 决定。
  assert.ok(!direct.toLowerCase().includes("powershell"));
  assert.ok(!embedded.toLowerCase().includes("powershell"));
});

test("(场景4/R4) 三个构建函数输出无 CJK（模型面恒英文）", () => {
  for (const text of [
    buildSubagentCommonNotes(),
    buildGeneralPurposeSystemPrompt(),
    buildExploreAgentPrompt({}),
    buildExploreAgentPrompt({ embeddedSearchEnabled: true }),
  ]) {
    assert.ok(!CJK_PATTERN.test(text));
  }
});
