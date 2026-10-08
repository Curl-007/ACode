import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 覆盖 specs/workflow-child-entry-rendering.md 的验收场景 1/2/3。
 *
 * 背景（本 bug 的原始形态）：字节码 loader 以 `" ".repeat(sourceLength)` 作为 vm.Script 的
 * 源文本（scripts/desktop-agent-bytecode-runtime.cjs:61），V8 的 Function.prototype.toString()
 * 从脚本源文本取值，该形态下返回等长纯空格；旧 renderChildEntry 依赖运行期 childMain.toString()，
 * 字节码形态渲染出 `const main = <空格>;`，动态工作流与 snippet 全部 SyntaxError 致死
 * （v0.0.4 生产复现）。现在入口只内嵌构建期物化常量 CHILD_MAIN_TEXT
 * （apps/acode-cli/scripts/generate-child-main.mjs 为唯一写入者），本测试钉住该行为与漂移守护。
 */

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(TESTS_DIR, "..");

const { childMain, renderChildEntry } = await import(
  "../packages/dynamic-workflow-runtime/src/child-source.ts"
);
const { CHILD_MAIN_TEXT } = await import(
  "../packages/dynamic-workflow-runtime/src/generated/child-main-text.ts"
);

const MINIMAL_PAYLOAD = { lowered: "return 1;" };

function runGenerateScript(args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--import", "tsx", join("scripts", "generate-child-main.mjs"), ...args],
      { cwd: APP_ROOT, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

/** 入口是 ESM，语法有效性用 `node --check <file.mjs>` 判定（vm.Script 不编译 ESM）。 */
async function assertEntryCompiles(rendered) {
  const dir = await mkdtemp(join(tmpdir(), "acode-dwf-entry-"));
  const file = join(dir, "entry.mjs");
  try {
    await writeFile(file, rendered, "utf8");
    const result = await new Promise((resolvePromise) => {
      execFile(
        process.execPath,
        ["--check", file],
        { encoding: "utf8", windowsHide: true },
        (error, stdout, stderr) =>
          resolvePromise({ ok: !error, detail: `${stderr ?? ""}${stdout ?? ""}` }),
      );
    });
    assert.ok(result.ok, `入口文件 node --check 失败：${result.detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("场景1：toString 被污染为空格时入口渲染仍可用（字节码形态回归）", async () => {
  const original = Object.getOwnPropertyDescriptor(childMain, "toString");
  // 模拟字节码形态：函数 toString() 返回等长纯空格（旧实现在此渲染出损坏入口）。
  childMain.toString = () => " ".repeat(CHILD_MAIN_TEXT.length);
  try {
    const rendered = renderChildEntry(MINIMAL_PAYLOAD, { runId: "bytecode-regression" });
    assert.ok(rendered.includes("function childMain"), "入口必须包含真实的 childMain 源文本");
    assert.ok(!/= {100,};/.test(rendered), "入口不得出现长空格段（旧 bug 形态）");
    await assertEntryCompiles(rendered);
  } finally {
    if (original) Object.defineProperty(childMain, "toString", original);
    else delete childMain.toString;
  }
});

test("场景2：物化常量与 childMain 当前源文本一致，--check 退出码 0（漂移守护）", async () => {
  assert.equal(CHILD_MAIN_TEXT, childMain.toString());
  const result = await runGenerateScript(["--check"]);
  assert.equal(result.code, 0, `--check 应通过：${result.stdout}${result.stderr}`);
});

test("场景3：入口结构完整（payload JSON、start 导出、BOOTSTRAP 标记）", async () => {
  const rendered = renderChildEntry({ lowered: "return 1;", args: { foo: "bar" } }, { runId: "structure" });
  assert.ok(rendered.includes('"foo":"bar"'), "payload JSON 应内联为字面量");
  assert.ok(rendered.includes("export const start = (deps) =>"), "start 导出应存在");
  assert.ok(rendered.includes("__execute"), "BOOTSTRAP 逻辑应内嵌在 main 源文本中");
  assert.ok(rendered.includes("workflow-sandbox"), "vm context 命名标记应存在");
  await assertEntryCompiles(rendered);
});
