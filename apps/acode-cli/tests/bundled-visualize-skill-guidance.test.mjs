import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * visualize 技能创作指导增补包验收（specs/gen-ui-visualize.md
 * 「创作指导增补包」验收场景 8/9）。
 *
 * - 场景 8：references 四文件 + design-tokens.md 在场；SKILL.md 索引节逐一指到
 *   （索引缺席 = 模型永远不会 Read 该文件，指导成死重）；
 * - 场景 9：SKILL.md 与全部 references 正文无 CJK（bundled 技能内容纪律，
 *   bundled-research-review-skills.test.mjs 同款）；
 * - 关键条款在场性抽查：预算硬限/自我拆穿/交付诚实/a11y 底线（SKILL.md），
 *   两条失败规则+宽度公式+viewBox 计算+WRONG/RIGHT 反例+动词路由+ERD/环状
 *   硬路由（diagram.md），色彩最后定+Not 列+单 y 轴+保留语义色（chart.md），
 *   faux-viewport+无 fullscreen 表面+死 API 披露（mockup.md），
 *   acodeViz 状态+reduce-motion 边界披露（interactive.md），
 *   @generated 头（design-tokens.md）。
 */

const SKILL_ROOT = new URL("../packages/bundled-skills/skills/visualize/", import.meta.url);
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const REFERENCE_FILES = [
  "references/diagram.md",
  "references/chart.md",
  "references/mockup.md",
  "references/interactive.md",
  "references/design-tokens.md",
];

async function readSkillFile(relativePath) {
  return readFile(new URL(relativePath, SKILL_ROOT), "utf8");
}

const skillText = await readSkillFile("SKILL.md");
const referenceTexts = new Map();
for (const file of REFERENCE_FILES) {
  referenceTexts.set(file, await readSkillFile(file));
}

test("(场景8) references 文件在场且 SKILL.md 索引逐一指到", () => {
  for (const file of REFERENCE_FILES) {
    assert.ok(referenceTexts.get(file).length > 0, `${file} 为空`);
    assert.ok(skillText.includes(file), `SKILL.md 索引缺少 ${file}`);
  }
  // 索引节还须教「静默装载」——read_me 式模块分级在 ACode 的等价纪律。
  assert.match(skillText, /never narrated/i);
});

test("(场景9) SKILL.md 与全部 references 正文无 CJK", () => {
  assert.ok(!CJK_PATTERN.test(skillText), "SKILL.md 含 CJK");
  for (const [file, text] of referenceTexts) {
    assert.ok(!CJK_PATTERN.test(text), `${file} 含 CJK`);
  }
});

test("SKILL.md 增补节：预算硬限/自我拆穿/交付诚实/a11y 底线关键条款在场", () => {
  assert.match(skillText, /at most 5 words/i);
  assert.match(skillText, /at most 2 ramps/i);
  assert.match(skillText, /at most 4 full-width boxes/i);
  // 超限三出路：缩、折行、拆图。
  assert.match(skillText, /shrink the boxes \(≤110px\), wrap to two rows/i);
  assert.match(skillText, /split into an overview visual plus a detail visual/i);
  // 自我拆穿条款。
  assert.match(skillText, /click to learn more/i);
  assert.match(skillText, /actually be sparse/i);
  // 交付诚实：N 张图 = N 次调用 + 图间承接正文。
  assert.match(skillText, /promises N visuals, make N/i);
  assert.match(skillText, /connecting\s+prose/i);
  // a11y 底线四件套。
  assert.match(skillText, /sr-only|visually hidden one-sentence summary/i);
  assert.match(skillText, /role="img"/);
  assert.match(skillText, /aria-label/);
  assert.match(skillText, /Never encode meaning in color alone/i);
  // sandbox 死 API 一句话披露 + 指向 references。
  assert.match(skillText, /sandbox="allow-scripts"/);
  assert.match(skillText, /no fullscreen surface/i);
});

test("diagram.md：两条失败规则+尺寸公式+viewBox 计算+反例对+意图路由", () => {
  const text = referenceTexts.get("references/diagram.md");
  assert.match(text, /Intersection-check every connector/i);
  assert.match(text, /max\(title_chars × 8, subtitle_chars × 7\) \+ 24/);
  assert.match(text, /CJK characters render about twice as\s+wide/i);
  assert.match(text, /Compute the viewBox, never guess it/i);
  assert.match(text, /max_y \+ 20/);
  assert.match(text, /\*\*WRONG\*\*/);
  assert.match(text, /\*\*RIGHT\*\*/);
  assert.match(text, /dominant-baseline="central"/);
  assert.match(text, /Route on the verb, not the noun/i);
  assert.match(text, /Reference diagrams/i);
  assert.match(text, /Intuition diagrams/i);
  assert.match(text, /erDiagram/);
  assert.match(text, /Never a ring/i);
  assert.match(text, /Cartesian/i);
});

test("chart.md：色彩最后定六步+Not 列+单 y 轴+保留语义色+canvas a11y", () => {
  const text = referenceTexts.get("references/chart.md");
  assert.match(text, /Color is assigned last/i);
  assert.notEqual((text.match(/^\d+\.\s/gm) ?? []).length, 0);
  assert.match(text, /\| Not\s*\|/);
  assert.match(text, /A bar chart with one bar/i);
  assert.match(text, /More colors/i);
  assert.match(text, /One y-axis/i);
  assert.match(text, /Color follows the entity, never its rank/i);
  assert.match(text, /info, success, warning, error/i);
  assert.match(text, /darkest shade of that same color family/i);
  assert.match(text, /role="img"/);
  assert.match(text, /fallback text between the tags/i);
  assert.match(text, /never rely on color alone/i);
});

test("mockup.md：faux-viewport+无 fullscreen+死 API 披露+校验义务", () => {
  const text = referenceTexts.get("references/mockup.md");
  assert.match(text, /faux viewport/i);
  assert.match(text, /position: fixed/i);
  assert.match(text, /no fullscreen surface/i);
  assert.match(text, /requestFullscreen/i);
  assert.match(text, /expanded-layout toggle/i);
  assert.match(text, /innerHTML/i);
  assert.match(text, /localStorage.*IndexedDB|IndexedDB.*localStorage/is);
  assert.match(text, /form-action 'none'/);
  assert.match(text, /validate before they advance/i);
  assert.match(text, /design-tokens\.md/);
});

test("interactive.md：acodeViz 状态+控件预算+装载顺序+reduce-motion 边界披露", () => {
  const text = referenceTexts.get("references/interactive.md");
  assert.match(text, /acodeViz\.getWidgetState/);
  assert.match(text, /setWidgetState/);
  assert.match(text, /visibly change the graphic in the same frame/i);
  assert.match(text, /must appear \*\*before\*\* any inline\s+script/i);
  assert.match(text, /height reporter/i);
  assert.match(text, /prefers-reduced-motion: reduce/);
  assert.match(text, /does \*\*not\*\* cross into the sandboxed iframe/i);
  assert.match(text, /Never a ring|never a ring/i);
});

test("design-tokens.md：@generated 头指向生成脚本与 DESIGN.md", () => {
  const text = referenceTexts.get("references/design-tokens.md");
  assert.match(text, /^<!-- @generated by apps\/acode-cli\/scripts\/generate-visualize-design-tokens\.mjs from DESIGN\.md/);
  assert.match(text, /Do not edit by hand/);
});
