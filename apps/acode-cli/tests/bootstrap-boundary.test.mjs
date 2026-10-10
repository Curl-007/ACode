import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// specs/bootstrap-app-boundary.md 守护测试：bootstrap 包边界冻结。
// 2026-10-05 深度审查确认：跨包引用 bootstrap 全部走包名公共导出（"."、"./v4-replay"），
// 其他包里出现的 "bootstrap/src/..." 字样全部是注释引用——边界当下是干净的。
// 本测试把「干净」变成「强制」：任何新的深导入（@acode/bootstrap/<内部路径> 或
// 相对路径直达 bootstrap/src）直接红，防止 bootstrap 的 66k 行内部结构被跨包耦合固化，
// 阻塞后续 workflow 应用层独立成包。

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = `${cliRoot}packages`;

// 声明的公共导出子路径（package.json exports）；其余子路径一律视为深导入。
const ALLOWED_SUBPATHS = new Set(["@acode/bootstrap/v4-replay"]);

const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = `${dir}/${entry.name}`;
      return entry.isDirectory()
        ? collectSources(full)
        : /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
          ? [full]
          : [];
    }),
  );
  return nested.flat();
}

test("跨包不得深导入 bootstrap 内部（公共导出面：'.' 与 './v4-replay'）", async () => {
  const offenders = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "bootstrap") continue;
    const srcDir = `${packagesDir}/${entry.name}/src`;
    let files;
    try {
      files = await collectSources(srcDir);
    } catch {
      continue; // 无 src 目录的包跳过
    }
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(SPECIFIER_PATTERN)) {
        const spec = match[1];
        if (spec.startsWith("@acode/bootstrap/") && !ALLOWED_SUBPATHS.has(spec)) {
          offenders.push(`${file.replace(cliRoot, "")} → ${spec}`);
        }
        if (/^\.\.[^"']*\/bootstrap\/src\//.test(spec)) {
          offenders.push(`${file.replace(cliRoot, "")} → ${spec}（相对路径直达 bootstrap 源码）`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `发现 bootstrap 深导入（边界见 specs/bootstrap-app-boundary.md）:\n${offenders.join("\n")}`,
  );
});

// ── W1-R3：workflow 引擎族物理拆包守护（specs/cli-workflow-package-boundary.md 验收 4）──
//
// 两条规则：
// 1. 引擎族文件（dynamic-workflow-* / workflow-* / script-workflow-*，五个装配接缝除外）
//    不得回流 bootstrap/src/app——它们只能住在 @acode/cli-workflow。
// 2. 任何包不得深导入 @acode/cli-workflow/<内部路径>（公开面只有 "." 与 "./contract"），
//    也不得以相对路径直达 cli-workflow/src。

/** 留在 bootstrap 的装配接缝（W0/W1-R3 边界）；其余引擎族前缀文件一律视为违规。 */
const CLI_WORKFLOW_SEAM_FILES = new Set([
  "workflow-wiring.ts",
  "workflow-app-facade.ts",
  "workflow-facade.ts",
  "workflow-methods.ts",
  "script-workflow-methods.ts",
]);

const ENGINE_FAMILY_PATTERN = /^(dynamic-workflow-|workflow-|script-workflow-)/;

test("引擎族文件不再存在于 bootstrap/src/app（W1-R3：只能在 @acode/cli-workflow）", async () => {
  const files = await readdir(`${packagesDir}/bootstrap/src/app`);
  const offenders = files.filter(
    (name) => ENGINE_FAMILY_PATTERN.test(name) && !CLI_WORKFLOW_SEAM_FILES.has(name),
  );
  assert.deepEqual(
    offenders,
    [],
    `引擎族文件必须住在 @acode/cli-workflow（边界见 specs/cli-workflow-package-boundary.md）:\n${offenders.join("\n")}`,
  );
  // 五个接缝必须仍在 bootstrap（它们是 ACodeApp 表面与引擎之间的适配层）。
  for (const seam of CLI_WORKFLOW_SEAM_FILES) {
    assert.ok(files.includes(seam), `装配接缝缺失: bootstrap/src/app/${seam}`);
  }
});

/** @acode/cli-workflow 的公开导出面（package.json exports）；其余子路径一律视为深导入。 */
const CLI_WORKFLOW_ALLOWED_SUBPATHS = new Set(["@acode/cli-workflow/contract"]);

/** 单个说明符判定：抽出为纯函数，供扫描与自检 fixture 共用。 */
function isCliWorkflowDeepImport(spec) {
  return (
    (spec.startsWith("@acode/cli-workflow/") && !CLI_WORKFLOW_ALLOWED_SUBPATHS.has(spec)) ||
    /^\.\.[^"']*\/cli-workflow\/src\//.test(spec)
  );
}

/** 对一组 [文件, 源码] 跑深导入扫描；扫描与自检共用同一实现。 */
function findCliWorkflowDeepImports(sources) {
  const offenders = [];
  for (const [file, source] of sources) {
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      if (isCliWorkflowDeepImport(match[1])) {
        offenders.push(`${file} → ${match[1]}`);
      }
    }
  }
  return offenders;
}

test("跨包不得深导入 @acode/cli-workflow 内部（公开面：'.' 与 './contract'）", async () => {
  const sources = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "cli-workflow") continue;
    const srcDir = `${packagesDir}/${entry.name}/src`;
    let files;
    try {
      files = await collectSources(srcDir);
    } catch {
      continue; // 无 src 目录的包跳过
    }
    for (const file of files) {
      sources.push([file.replace(cliRoot, ""), await readFile(file, "utf8")]);
    }
  }
  const offenders = findCliWorkflowDeepImports(sources);
  assert.deepEqual(
    offenders,
    [],
    `发现 @acode/cli-workflow 深导入（边界见 specs/cli-workflow-package-boundary.md）:\n${offenders.join("\n")}`,
  );
});

test("守护自检：人为深导入 fixture 必须被识别（规则非空转）", () => {
  const fixture = [
    [
      "fixture/deep-import.ts",
      [
        `import { ScriptWorkflowRuntime } from "@acode/cli-workflow/src/script-workflow-runtime.js";`,
        `const driver = await import("@acode/cli-workflow/dist/workflow-driver.js");`,
        `import { executeWorldRead } from "../../cli-workflow/src/workflow-world-read.js";`,
      ].join("\n"),
    ],
    [
      "fixture/allowed.ts",
      [
        `import { ScriptWorkflowRuntime } from "@acode/cli-workflow/contract";`,
        `import { createWorkflowWiring } from "@acode/cli-workflow";`,
      ].join("\n"),
    ],
  ];
  const offenders = findCliWorkflowDeepImports(fixture);
  // 三条深导入（包名 src / 包名 dist / 相对路径直达 src）全部命中；合法入口零命中。
  assert.equal(offenders.length, 3, `自检 fixture 应命中 3 条深导入: ${JSON.stringify(offenders)}`);
  assert.ok(offenders.every((line) => line.startsWith("fixture/deep-import.ts")));
  assert.ok(isCliWorkflowDeepImport("@acode/cli-workflow/src/host-types.js"));
  assert.ok(!isCliWorkflowDeepImport("@acode/cli-workflow/contract"));
  assert.ok(!isCliWorkflowDeepImport("@acode/contracts"));
});
