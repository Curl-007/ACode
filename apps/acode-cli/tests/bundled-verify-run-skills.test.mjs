import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 批次三验收测试：内置 verify 与 run 技能。
 *
 * 覆盖规格 apps/acode-cli/specs/bundled-verify-run-skills.md 验收场景 1–5、7
 * （场景 6 的发现链路由 bundled-research-review-skills.test.mjs 的五技能断言承载，
 * 场景 5 的完整性门断言在两份测试里同向重复，防其中一份被删）：
 * - 场景 1：目录与 frontmatter（name/description ≤250/触发语义）；
 * - 场景 2：verify 内容要素（三硬纪律/diff-claim/表面表七行/非表面条款/handle/
 *   计划读回/四态判定/证据到达读者/端到端）；
 * - 场景 3：run 内容要素（交互定义/项目技能三分支/回退表六形态/驱动动作/沉淀建议）；
 * - 场景 4：条件句纪律（浏览器/桌面自动化不硬指向）；
 * - 场景 5：完整性门不连坐；
 * - 场景 7：正文无 CJK。
 */

const SKILLS_ROOT = new URL("../packages/bundled-skills/skills/", import.meta.url);
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

async function readSkill(relativePath) {
  return readFile(new URL(relativePath, SKILLS_ROOT), "utf8");
}

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

test("(场景1) frontmatter：name 与目录一致，description ≤250 且含触发语义", async () => {
  const verifyFm = parseFrontmatter(await readSkill("verify/SKILL.md"));
  assert.equal(verifyFm.name, "verify");
  assert.ok(verifyFm.description.length <= 250, `verify description ${verifyFm.description.length}`);
  assert.match(verifyFm.description, /end-to-end/);
  assert.match(verifyFm.description, /not tests or typecheck/);
  assert.match(verifyFm.description, /no runtime surface/);

  const runFm = parseFrontmatter(await readSkill("run/SKILL.md"));
  assert.equal(runFm.name, "run");
  assert.ok(runFm.description.length <= 250, `run description ${runFm.description.length}`);
  assert.match(runFm.description, /run, start, or screenshot the app/);
  assert.match(runFm.description, /project run skill/);
});

test("(场景2) verify 内容要素逐条可定位", async () => {
  const skill = await readSkill("verify/SKILL.md");
  // 定义：
  assert.match(skill, /Verification is runtime observation/);
  // 三硬纪律：
  assert.match(skill, /Don't run the test suite\. Don't typecheck\./);
  assert.match(skill, /Don't import-and-call\./);
  assert.match(skill, /Evidence is a captured observation/);
  // 与 behavior.dynamic 自验证段的边界消歧（实现期自检 ≠ verify 证据）：
  assert.match(skill, /they are just not evidence for this skill's verdict/);
  // diff 与 claim：
  assert.match(skill, /The diff is ground truth\. Any description of it is a claim\./);
  assert.match(skill, /that disagreement is itself a finding/);
  // 表面表七行：
  for (const row of [
    "| CLI / TUI | terminal |",
    "| Server / API | socket |",
    "| Web GUI | pixels |",
    "| Desktop / Electron GUI | window |",
    "| Library / SDK | package boundary |",
    "| Prompt / skill / AGENTS.md | the agent |",
    "| CI workflow | the CI run |",
  ]) {
    assert.ok(skill.includes(row), `表面表缺行：${row}`);
  }
  // 内部函数非表面 + SKIP 一行制 + 测试是作者证据：
  assert.match(skill, /An internal function is not a surface\./);
  assert.match(skill, /SKIP — no runtime surface: \(reason\)/);
  assert.match(skill, /Tests inside the diff are the author's evidence, not a surface\./);
  // handle：两级技能根 + monorepo 包级探测 + 15 分钟限时 + 沉淀条款 + 带错路才修：
  assert.match(skill, /`\.agents\/skills\/` and `\.acode\/skills\/`/);
  assert.match(skill, /each package\/app directory the diff touches/);
  assert.match(skill, /Timebox it to roughly 15 minutes/);
  assert.match(skill, /persist what you learned/i);
  assert.match(skill, /edit it only when it steered you wrong/);
  // 计划读回：
  assert.match(skill, /Read your plan back before executing it\./);
  assert.match(skill, /you have planned a CI rerun, not a verification/);
  // 四态判定 + 无部分通过 + 存疑 FAIL + 含糊输出 FAIL 附原始捕获：
  for (const verdict of ["**PASS**", "**FAIL**", "**BLOCKED**", "**SKIP**"]) {
    assert.ok(skill.includes(verdict), `缺少判定 ${verdict}`);
  }
  assert.match(skill, /No partial pass\./);
  assert.match(skill, /When in doubt, FAIL/);
  assert.match(skill, /Ambiguous output is\s*\nFAIL with the raw capture attached|Ambiguous output is FAIL with the raw capture attached/);
  // 证据到达读者 + 观察即信号：
  assert.match(skill, /Evidence has to reach the reader\./);
  assert.match(skill, /your observations are the signal/i);
  assert.match(skill, /if the author were\s*\n\s*sitting next to me|if the author were sitting next to me/);
  // 端到端真实界面：
  assert.match(skill, /End-to-end, through the real interface\./);
  assert.match(skill, /seams are where bugs hide/i);
});

test("(场景3) run 内容要素逐条可定位", async () => {
  const skill = await readSkill("run/SKILL.md");
  // 交互定义：
  assert.match(skill, /Running means launching the actual app and interacting with it\./);
  assert.match(skill, /Not the test\s+suite/);
  // 项目技能优先三分支：
  assert.match(skill, /follow it verbatim/i);
  assert.match(skill, /ask the user which unit to run/);
  assert.match(skill, /matched skill is stale/i);
  assert.match(skill, /Do not silently\s+work around it/);
  // AGENTS.md 与 scripts 先读：
  assert.match(skill, /read AGENTS\.md and the package\.json `scripts` block before improvising/i);
  // 回退表六形态：
  for (const row of [
    "| CLI tool |",
    "| Web server / API |",
    "| TUI / interactive terminal |",
    "| Electron / desktop GUI |",
    "| Browser-driven web app |",
    "| Library / SDK |",
  ]) {
    assert.ok(skill.includes(row), `回退表缺行：${row}`);
  }
  // 驱动而非仅启动 + 看截图/空白帧：
  assert.match(skill, /Drive it, don't just launch it/);
  assert.match(skill, /that is typechecking with extra steps/i);
  assert.match(skill, /\*\*and look at the screenshot\*\*/i);
  assert.match(skill, /A blank frame is a failure to launch/i);
  // 沉淀建议（含「复述 AGENTS.md 的技能是噪声」反向条款）：
  assert.match(skill, /Capture the recipe when it cost extra/);
  assert.match(skill, /a skill that restates\s*\nAGENTS\.md is noise|a skill that restates AGENTS\.md is noise/i);
});

test("(场景4/R5) 条件句纪律：自动化能力存在性不硬指向", async () => {
  const verify = await readSkill("verify/SKILL.md");
  const run = await readSkill("run/SKILL.md");
  assert.match(verify, /when one is available|when available|if none is available/);
  assert.match(verify, /marked as degraded/);
  assert.match(run, /when one is available|when available|when one is installed/i);
  // 不得硬指向具体第三方工具为唯一路径（存在性词必须与自动化行同句出现）：
  assert.ok(!verify.includes("must use Playwright"));
  assert.ok(!run.includes("must use Playwright"));
  assert.ok(!verify.includes("must use tmux"));
});

test("(场景5/R3) 完整性门不连坐：REQUIRED_PATHS 仍只含 dynamic-workflows", async () => {
  const source = await readFile(
    new URL("../packages/bootstrap/src/app/bundled-skills.ts", import.meta.url),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("BUNDLED_SKILL_PACK_REQUIRED_PATHS"),
    source.indexOf("] as const;"),
  );
  assert.ok(block.includes("DYNAMIC_WORKFLOW_SKILL_NAME"));
  for (const name of ["research-report", "code-review", "verify", "run"]) {
    assert.ok(!block.includes(name), `${name} 不得进 workflow 耦合门`);
  }
});

test("(场景7/R5) 两技能正文无 CJK", async () => {
  for (const path of ["verify/SKILL.md", "run/SKILL.md"]) {
    const text = await readSkill(path);
    assert.ok(!CJK_PATTERN.test(text), `${path} 含 CJK`);
  }
});
