import assert from "node:assert/strict";
import { test } from "node:test";

// specs/fs-hotpath-mechanisms.md R3：整块 Levenshtein 模糊层——分级阈值先严后宽、
// 唯一候选才替换、多候选拒绝并把候选计数回报给模型；replaceAll 跳过；既有
// 8 策略路径零回归。

const { findEditMatch } = await import("../packages/core/src/tool/edit-matchers.ts");

test("fuzzy block: single slightly-perturbed block is matched with file text", () => {
  const content = [
    "function greet(name) {",
    "  console.log('hi ' + name);",
    "  return 0;",
    "}",
  ].join("\n");
  // 模型笔误：多打了一个空格 + 拼错一个词；前 8 策略都不会命中。
  const search = [
    "function greet(namee) {",
    "  console.log('hi '  + name);",
    "  return 0;",
    "}",
  ].join("\n");

  const match = findEditMatch({ content, search, replaceAll: false });
  assert.equal(match.status, "matched");
  assert.equal(match.strategy, "fuzzy_block");
  assert.equal(match.actualString, content, "actualString 必须取文件真实文本");
});

test("fuzzy block: multiple equally-similar candidates are rejected with candidate count", () => {
  const blockA = ["alpha one", "beta two", "gamma three"].join("\n");
  const blockB = ["alpha onX", "beta twYo", "gamma threZ"].join("\n");
  const content = `${blockA}\nmid\n${blockB}\n`;
  const search = ["alpha onQ", "beta twW", "gamma thrE"].join("\n");

  const match = findEditMatch({ content, search, replaceAll: false });
  assert.equal(match.status, "ambiguous", "多候选必须拒绝替换");
  assert.equal(match.strategy, "fuzzy_block");
  assert.equal(match.candidateCount, 2, "候选计数必须回报给模型");
});

test("fuzzy block: tiered thresholds relax strict-first when no strict candidate exists", () => {
  const content = ["value aabbccdd", "keep this line", "value eeffgghh"].join("\n");
  // 与任一块的相似度都在 0.92~0.95 之间：0.95 档无候选 → 0.92 档命中。
  const search = ["value aabbccddX", "keep this line", "value eeffgghh"].join("\n");
  const match = findEditMatch({ content, search, replaceAll: false });
  assert.equal(match.status, "matched");
  assert.equal(match.strategy, "fuzzy_block");

  // 低于最宽档（0.8）：完全无关的块不得命中。
  const unrelated = findEditMatch({
    content,
    search: ["completely different words here", "nothing alike at all", "totally other stuff"].join("\n"),
    replaceAll: false,
  });
  assert.equal(unrelated.status, "not_found");
});

test("fuzzy block: stricter tier disambiguates when the closest candidate dominates", () => {
  const near = ["fetch(url)", "  return data;", "});"].join("\n");
  const far = ["fetch(urlX)", "  return dataXX;", "});Y"].join("\n");
  const content = `${near}\nseparator\n${far}\n`;
  // 两块都能过 0.92，但只有 near 能过 0.95：先严档位直接唯一裁决。
  const search = ["fetch(url)", "  return data;", "});"].join("\n").replace("fetch(url)", "fetch(urL)");
  const match = findEditMatch({ content, search, replaceAll: false });
  assert.equal(match.status, "matched");
  assert.equal(match.actualString, near);
});

test("fuzzy block: replaceAll skips the broad fuzzy layer", () => {
  const content = ["one two", "three four"].join("\n");
  const search = ["one twoo", "three fourr"].join("\n");
  const match = findEditMatch({ content, search, replaceAll: true });
  assert.equal(match.status, "not_found", "replaceAll 一律不进模糊层");
});

test("fuzzy block: existing strategy order and results stay intact", () => {
  // exact 命中优先于模糊层。
  const exactContent = "const value = 1;";
  const exact = findEditMatch({ content: exactContent, search: "const value = 1;", replaceAll: false });
  assert.equal(exact.status, "matched");
  assert.equal(exact.strategy, "exact");

  // quote_normalized 仍在模糊层之前命中。
  const curly = findEditMatch({
    content: "it\u2019s fine",
    search: "it's fine",
    replaceAll: false,
  });
  assert.equal(curly.status, "matched");
  assert.equal(curly.strategy, "quote_normalized");

  // line_trimmed 在模糊层之前命中。
  const trimmed = findEditMatch({ content: "  hello  \n  world ", search: "hello\nworld", replaceAll: false });
  assert.equal(trimmed.status, "matched");
  assert.equal(trimmed.strategy, "line_trimmed");

  // not_found 错误字符串契约：edit handler 对 not_found 的措辞依赖该结构。
  assert.deepEqual(
    findEditMatch({ content: "abc", search: "zzz", replaceAll: false }),
    { status: "not_found" },
  );
});
