import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

// 2026-10-09：renderer 的类型检查从 ci.yml / release.yml 的内联 tsc 命令收敛进统一门禁
// scripts/typecheck-gate.mjs（根 `pnpm typecheck`，见 docs/specs/cli-validation-gates.md
// 第 3-6 条）。守护点随之从「workflow 文本里有那条命令」改为「门禁清单里真的有 renderer
// 阶段，且两个 workflow 都调用同一个门禁」：字符串断言既会在入口收敛时假红，也拦不住
// 清单里悄悄少掉一个阶段。
const { TYPECHECK_STAGES } = await import(new URL("../../scripts/typecheck-gate.mjs", root));

test("renderer typecheck keeps bridge and CSS ambient declarations wired", async () => {
  const ambient = await readFile(new URL("src/renderer/src/ambient.d.ts", root), "utf8");
  const css = await readFile(new URL("src/renderer/src/css.d.ts", root), "utf8");
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", root), "utf8");
  const release = await readFile(new URL("../../.github/workflows/release.yml", root), "utf8");

  assert.match(ambient, /@acode\/client\/globals/u);
  assert.match(css, /declare module "@acode\/ui\/styles\.css"/u);

  const renderer = TYPECHECK_STAGES.find((stage) => stage.id === "desktop-renderer");
  assert.ok(renderer, "统一类型门禁必须包含 desktop-renderer 阶段");
  assert.ok(
    renderer.args.includes("packages/desktop/tsconfig.renderer.json"),
    `desktop-renderer 必须检查 renderer 工程，实际：${renderer.args.join(" ")}`,
  );
  assert.ok(renderer.args.includes("--noEmit"), "renderer 阶段只做类型检查，不得产出文件");

  for (const [name, text] of [
    ["ci.yml", ci],
    ["release.yml", release],
  ]) {
    assert.match(text, /^\s*run: pnpm typecheck\s*$/mu, `${name} 必须调用统一类型门禁`);
    assert.ok(!text.includes("tsconfig.renderer.json"), `${name} 不应再内联 renderer 命令形成旁路`);
  }
});
