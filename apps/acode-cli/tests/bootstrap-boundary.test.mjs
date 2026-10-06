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
