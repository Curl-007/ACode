import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renderer typecheck keeps bridge and CSS ambient declarations wired", async () => {
  const ambient = await readFile(new URL("src/renderer/src/ambient.d.ts", root), "utf8");
  const css = await readFile(new URL("src/renderer/src/css.d.ts", root), "utf8");
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", root), "utf8");
  const release = await readFile(new URL("../../.github/workflows/release.yml", root), "utf8");

  assert.match(ambient, /@acode\/client\/globals/u);
  assert.match(css, /declare module "@acode\/ui\/styles\.css"/u);
  assert.match(ci, /tsc -p packages\/desktop\/tsconfig\.renderer\.json --noEmit/u);
  assert.match(release, /tsc -p packages\/desktop\/tsconfig\.renderer\.json --noEmit/u);
});
