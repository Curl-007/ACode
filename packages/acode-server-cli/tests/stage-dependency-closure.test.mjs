import test from "node:test";
import assert from "node:assert/strict";

const { collectBareModuleSpecifiers, isTargetSpecificPackage } =
  await import("../src/packaging/stageDependencyClosure.ts");

test("collectBareModuleSpecifiers collects import/from/require/import() bare specifiers", () => {
  const source = [
    'import { EventEmitter } from "node:events";',
    'import chalk from "chalk";',
    'import { x } from "@scope/pkg/sub/path";',
    'const koffi = require("koffi");',
    'const p = await import("playwright-core");',
    'export { y } from "re-exported";',
  ].join("\n");
  const names = collectBareModuleSpecifiers(source);
  assert.deepEqual([...names].sort(), [
    "@scope/pkg",
    "chalk",
    "koffi",
    "playwright-core",
    "re-exported",
  ]);
});

test("collectBareModuleSpecifiers filters relative, absolute, node:, and builtin specifiers", () => {
  const source = [
    'import { a } from "./relative.js";',
    'import { b } from "../up.js";',
    'import { c } from "/absolute/path.js";',
    'import { d } from "node:fs/promises";',
    'import { e } from "fs";',
    'import { f } from "path";',
    'require("node:os");',
  ].join("\n");
  assert.deepEqual([...collectBareModuleSpecifiers(source)], []);
});

test("collectBareModuleSpecifiers normalizes scoped packages to two segments", () => {
  const names = collectBareModuleSpecifiers(
    'import { z } from "@mbears/opentui-core-linux-x64/x";',
  );
  assert.deepEqual([...names], ["@mbears/opentui-core-linux-x64"]);
});

test("isTargetSpecificPackage keeps only the matching opentui core variant", () => {
  assert.equal(isTargetSpecificPackage("koffi", "linux-x64"), true);
  assert.equal(isTargetSpecificPackage("@mbears/opentui-core-linux-x64", "linux-x64"), true);
  assert.equal(isTargetSpecificPackage("@mbears/opentui-core-darwin-arm64", "linux-x64"), false);
  assert.equal(isTargetSpecificPackage("@mbears/opentui-core", "linux-x64"), true);
});
