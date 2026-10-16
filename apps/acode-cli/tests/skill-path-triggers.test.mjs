import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";

/**
 * 技能 paths 触发验收（specs/skill-frontmatter-governance.md R5）：
 * 声明侧归一（adapters：剥尾 /**、花括号预算展开、全 ** 弃权）与
 * 消费侧判定纯函数（core：gitignore 风格子集、逃逸 fail-closed、Windows 归一）。
 */

const { parsePathTriggerDeclarations } =
  await import("../packages/adapters/src/skills/path-triggers.ts");
const { matchesSkillPathTrigger, matchedSkillPathPatterns } =
  await import("../packages/core/src/agent/skill-path-triggers.ts");

function parseDeclarations(entries) {
  const diagnostics = [];
  const patterns = parsePathTriggerDeclarations(entries, {
    skillName: "fixture",
    path: "/skills/fixture/SKILL.md",
    diagnostics,
  });
  return { patterns, diagnostics };
}

// 平台原生绝对路径的工作目录（win32 盘符形 / POSIX 根形）
const CWD = resolve(sep === "\\" ? "C:\\proj" : "/proj");
const OUTSIDE = join(resolve(sep === "\\" ? "C:\\" : "/"), "elsewhere", "x.ts");

test("R5 声明归一：剥尾 /**、空项丢弃、全 ** 视为未声明", () => {
  assert.deepEqual(parseDeclarations(["src/**", "docs/**", "", "  "]).patterns, ["src", "docs"]);
  assert.equal(parseDeclarations(["**"]).patterns, undefined);
  assert.equal(parseDeclarations(["**", "**/**"]).patterns, undefined);
  assert.equal(parseDeclarations([]).patterns, undefined);
});

test("R5 声明归一：花括号展开与预算超限降级（原样保留+warn）", () => {
  assert.deepEqual(parseDeclarations(["src/{a,b}/*.ts"]).patterns, ["src/a/*.ts", "src/b/*.ts"]);
  const huge = `{${Array.from({ length: 600 }, (_, index) => `o${index}`).join(",")}}/x`;
  const { patterns, diagnostics } = parseDeclarations([huge]);
  assert.deepEqual(patterns, [huge]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "skill_frontmatter_value_invalid");
  assert.ok(diagnostics[0].message.includes("expansion budget"));
});

test("R5 判定：锚定/任意深度/目录级联/**跨段/*不跨段/?单字符", () => {
  const match = (patterns, touchedPath) =>
    matchesSkillPathTrigger({ patterns, touchedPath, workingDirectory: CWD });
  // 含 `/` 的模式锚定工作目录根
  assert.ok(match([".demo/specs"], ".demo/specs/foo.md")); // 目录级联
  assert.ok(match([".demo/specs"], ".demo/specs"));
  assert.ok(!match([".demo/specs"], "nested/.demo/specs/foo.md"));
  // 不含 `/` 的模式任意深度按段匹配
  assert.ok(match(["*.md"], "docs/a.md"));
  assert.ok(match(["*.md"], "a.md"));
  assert.ok(!match(["*.md"], "a.txt"));
  // `**/` 匹配零或多段
  assert.ok(match(["src/**/*.test.ts"], "src/c.test.ts"));
  assert.ok(match(["src/**/*.test.ts"], "src/a/b/c.test.ts"));
  assert.ok(!match(["src/**/*.test.ts"], "lib/a.test.ts"));
  // `*` 不跨段
  assert.ok(match(["runs/*/proposed"], "runs/1/proposed/x.md"));
  assert.ok(!match(["runs/*/proposed"], "runs/1/2/proposed/x.md"));
  // `?` 单字符
  assert.ok(match(["a?c.md"], "abc.md"));
  assert.ok(!match(["a?c.md"], "ac.md"));
  // 目录形（尾 /）
  assert.ok(match(["docs/"], "docs/x.md"));
  // 匹配侧花括号冗余兼容
  assert.ok(match(["src/{a,b}.ts"], "src/a.ts"));
});

test("R5 判定：绝对路径归位、逃逸与 .. 上跳 fail-closed 不触发", () => {
  const match = (patterns, touchedPath) =>
    matchesSkillPathTrigger({ patterns, touchedPath, workingDirectory: CWD });
  // 工作目录内的绝对路径 → 相对化后命中
  assert.ok(match(["src/*.ts"], join(CWD, "src", "a.ts")));
  // 工作目录外的绝对路径不触发
  assert.ok(!match(["**/*.ts"], OUTSIDE));
  // `..` 上跳不触发
  assert.ok(!match(["**/*.ts"], "../escape/x.ts"));
  assert.ok(!match(["**/*.ts"], ".."));
  // 空路径不触发
  assert.ok(!match(["**/*.ts"], "   "));
});

test(
  "R5 判定：Windows 反斜杠/混合分隔符/Git Bash 盘符别名归一",
  { skip: process.platform !== "win32" },
  () => {
    const native = join(CWD, "src", "a.ts"); // C:\proj\src\a.ts
    const mixed = `${CWD.split("\\").join("/")}\\src\\a.ts`; // C:/proj\src\a.ts
    const gitBash = "/c/proj/src/a.ts"; // Git Bash 别名形
    for (const touchedPath of [native, mixed, gitBash]) {
      assert.ok(
        matchesSkillPathTrigger({
          patterns: ["src/*.ts"],
          touchedPath,
          workingDirectory: CWD,
        }),
        `应命中：${touchedPath}`,
      );
    }
  },
);

test("R5 判定：matchedSkillPathPatterns 返回命中子集（接线侧技能级归并用）", () => {
  const matched = matchedSkillPathPatterns(
    ["src/*.ts", "docs/**", "src/*.md"],
    join(CWD, "src", "a.ts"),
    CWD,
  );
  assert.deepEqual(matched, ["src/*.ts"]);
  assert.deepEqual(matchedSkillPathPatterns(["src/*.ts"], OUTSIDE, CWD), []);
});
