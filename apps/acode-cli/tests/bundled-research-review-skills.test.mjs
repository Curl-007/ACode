import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

/**
 * 内置技能包新增（research-report / code-review）验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/bundled-research-review-skills.md 的 R1–R4
 * 与验收场景 1–5：
 * - 场景 1：目录与 frontmatter（name 与目录一致、description ≤250、when_to_use）；
 * - 场景 2：内容要素逐条定位（research 七项 / review 七项）；
 * - 场景 3：完整性门不连坐（REQUIRED_PATHS 逐字不变）；
 * - 场景 4：技能文件正文无 CJK；
 * - 场景 5：发现链路冒烟（scanSkillFilesUnderRoot 扫到三个技能）。
 */

const { scanSkillFilesUnderRoot } = await import(
  "../packages/adapters/src/skills/scan.ts"
);

const SKILLS_ROOT = new URL("../packages/bundled-skills/skills/", import.meta.url);
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

async function readSkill(relativePath) {
  return readFile(new URL(relativePath, SKILLS_ROOT), "utf8");
}

/** 极简 frontmatter 解析：取 --- 包围块内的 key: "value" / key: value 行。 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "SKILL.md 缺少 frontmatter 块");
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    values[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return values;
}

test("(场景1/R1,R2) 目录结构与 frontmatter：两个技能四个文件", async () => {
  const researchSkill = await readSkill("research-report/SKILL.md");
  const researchFm = parseFrontmatter(researchSkill);
  assert.equal(researchFm.name, "research-report");
  assert.ok(researchFm.description.length > 0);
  assert.ok(
    researchFm.description.length <= 250,
    `research-report description 超 listing 上限：${researchFm.description.length}`,
  );
  assert.ok(researchFm.when_to_use && researchFm.when_to_use.length > 0);
  // 反例写进 when_to_use（R1-1）：
  assert.match(researchFm.when_to_use, /Do not use for a single-fact lookup/);

  const reviewSkill = await readSkill("code-review/SKILL.md");
  const reviewFm = parseFrontmatter(reviewSkill);
  assert.equal(reviewFm.name, "code-review");
  assert.ok(
    reviewFm.description.length <= 250,
    `code-review description 超 listing 上限：${reviewFm.description.length}`,
  );

  // 参考文件在场且被 SKILL.md 显式引用（progressive disclosure，R1）：
  await readSkill("research-report/method.md");
  await readSkill("research-report/report-contract.md");
  assert.ok(researchSkill.includes("`method.md`"));
  assert.ok(researchSkill.includes("`report-contract.md`"));
});

test("(场景2/R1) research-report 内容七要素", async () => {
  const skill = await readSkill("research-report/SKILL.md");
  const method = await readSkill("research-report/method.md");
  const contract = await readSkill("research-report/report-contract.md");
  // 2 交付物硬门（文件确认写入 + 失败不静默改对话交付）：
  assert.match(skill, /confirm the write succeeded/);
  assert.match(skill, /do not silently substitute a chat-only delivery/);
  // 3 证据标准（SKILL 摘要 + method 细则）：
  assert.match(skill, /Perform actual searches; do not answer from memory alone/);
  assert.match(skill, /Never fabricate a source, quotation, publication detail, URL, or access result/);
  assert.match(method, /Prefer primary and authoritative sources/);
  assert.match(method, /explicitly labeled as weak signals/);
  assert.match(method, /untrusted data/);
  // 4 两遍方法 + 停止判据：
  assert.match(method, /Pass 1: broad discovery/);
  assert.match(method, /Pass 2: targeted follow-up/);
  assert.match(method, /Stop test/);
  assert.match(method, /diminishing returns/);
  // 5 反碎片化委派（一个专职 worker，不拆浅代理）：
  assert.match(skill, /one\*\* dedicated research\s+subagent/);
  assert.match(skill, /Do not fragment the first pass across many shallow agents/);
  // 6 返回契约（ledger + 搜索账目）：
  assert.match(contract, /Claim-to-source ledger/i);
  assert.match(contract, /Search account/i);
  assert.match(contract, /fact \/ inference \/ uncertain \/ inaccessible/);
  // 7 失败契约与诚实规则：
  assert.match(skill, /label the limitation, and say which claims it weakens/);
  assert.match(contract, /Do not describe any step as done that was not actually done/);
});

test("(场景2/R2) code-review 内容七要素", async () => {
  const skill = await readSkill("code-review/SKILL.md");
  // 1 只评审不修复：
  assert.match(skill, /\*\*Review only — do not modify code\.\*\*/);
  assert.match(skill, /requires an explicit user request/);
  // 2 评审面对象 + 默认不僵住：
  assert.match(skill, /staged changes, the working tree, a branch against its\s+merge base, or a specific commit/);
  assert.match(skill, /do not stall on the choice/);
  // 3 过程（hunk 周边代码 + 指令文件优先级 + file:line 核实）：
  assert.match(skill, /read the surrounding code/);
  assert.match(skill, /More specific guidance wins on conflict/);
  assert.match(skill, /cite\s+file:line/);
  // 4 六判据 + 宁缺毋滥：
  for (const criterion of [
    /meaningfully impacts correctness, performance, security, or maintainability/,
    /discrete and actionable/,
    /introduced by the change under review/,
    /author would likely fix it once aware/,
    /not rely on unstated assumptions about intent/,
    /identifies the affected behavior clearly/,
  ]) {
    assert.match(skill, criterion);
  }
  assert.match(skill, /Prefer no findings over speculative or low-signal feedback/);
  assert.match(skill, /An empty review/);
  // 5 规则归因（最小行区间引用 + 不编造）：
  assert.match(skill, /smallest supporting line\s+range/);
  assert.match(skill, /Do not fabricate citations/);
  // 6 ::code-comment 只说何时用、不复述语法（语法归 desktop 段）：
  assert.match(skill, /::code-comment/);
  assert.match(skill, /This skill governs when a\s+finding deserves an inline comment, not the directive syntax/);
  assert.ok(!skill.includes("Required attributes")); // desktop 段的语法条款不得被复述
  // 7 不复述 diff、不制造发现：
  assert.match(skill, /Do not restate the diff/);
  assert.match(skill, /Never\s+manufacture findings/);
});

test("(场景3/R3) 完整性门不连坐：REQUIRED_PATHS 仍只含 dynamic-workflows 三文件", async () => {
  const source = await readFile(
    new URL("../packages/bootstrap/src/app/bundled-skills.ts", import.meta.url),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("BUNDLED_SKILL_PACK_REQUIRED_PATHS"),
    source.indexOf("] as const;"),
  );
  assert.ok(block.includes("DYNAMIC_WORKFLOW_SKILL_NAME"));
  assert.ok(!block.includes("research-report"), "新技能不得进 workflow 耦合门");
  assert.ok(!block.includes("code-review"), "新技能不得进 workflow 耦合门");
});

test("(场景4/R4) 技能文件正文无 CJK", async () => {
  for (const path of [
    "research-report/SKILL.md",
    "research-report/method.md",
    "research-report/report-contract.md",
    "code-review/SKILL.md",
  ]) {
    const text = await readSkill(path);
    assert.ok(!CJK_PATTERN.test(text), `${path} 含 CJK`);
  }
});

test("(场景5/R3) 发现链路冒烟：bundled skills 目录扫出三个技能", async () => {
  const rootPath = SKILLS_ROOT.pathname.replace(/^\//, "");
  const files = await scanSkillFilesUnderRoot(join(rootPath));
  const names = files.map((file) => file.split(/[\\/]/).at(-2)).sort();
  assert.deepEqual(names, ["code-review", "dynamic-workflows", "research-report"]);
});
