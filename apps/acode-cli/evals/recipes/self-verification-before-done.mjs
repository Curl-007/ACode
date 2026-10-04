/**
 * verified（试点 2026-10-04 全链路 PASS）：直接实现任务 + 可跑测试命令的仓。
 * 语料 setup：A direct (no subagent) implementation task in a repo with a runnable
 * test/typecheck command.
 * 试点实证的 fixture 形态：零依赖 Node 原生 TS（type-stripping），测试命令必须用
 * glob（`node --test tests/` 目录形式不匹配 .test.ts，spec §R2）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const mode = "yolo";

export async function setup(dir) {
  mkdirSync(join(dir, "src", "utils"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "timeout-fixture", private: true, type: "module", scripts: { test: "node --test tests/*.test.ts" } }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "utils", "time.ts"),
    `export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return \`\${Math.round(ms)}ms\`;
  return \`\${(ms / 1000).toFixed(1)}s\`;
}
`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "tests", "format-duration.test.ts"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "../src/utils/time.ts";

test("formatDuration renders sub-second values in ms", () => {
  assert.equal(formatDuration(250), "250ms");
});

test("formatDuration renders seconds with one decimal", () => {
  assert.equal(formatDuration(2500), "2.5s");
});
`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "README.md"),
    "# timeout-fixture\n\nMinimal time-utility fixture. `npm test` runs the suite (Node built-in test runner, native TS).\n",
    "utf-8",
  );
}
