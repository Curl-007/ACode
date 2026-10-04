/**
 * first-run-unverified（依赖 Agent 派发在无头下可用，spec §R6）：先研究后派发。
 * 语料 setup：需要先研究再向子代理派发实现的任务；转录必须含研究结论到达后的
 * 至少一次 Agent 派发。fixture 植入「刷新后重复渲染」bug（语料 prompt 点名），
 * 并附一条**失败**测试暴露它——研究面（读码/跑测试）与修复面（派发）都真实存在。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const mode = "yolo";

export async function setup(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "session-list-fixture", private: true, type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2)}\n`,
    "utf-8",
  );
  // 植入 bug：渲染前不清空容器 → 每次 refresh 追加一遍（刷新后重复）。
  writeFileSync(
    join(dir, "src", "session-list.js"),
    `// Renders the session list into a container array (stand-in for DOM children).
export function renderSessionList(container, sessions) {
  for (const session of sessions) {
    container.push({ tag: "li", text: session.title });
  }
  return container;
}

export function refresh(container, sessions) {
  return renderSessionList(container, sessions);
}
`,
    "utf-8",
  );
  // 失败测试：暴露重复渲染（研究阶段的真实信号）。
  writeFileSync(
    join(dir, "tests", "session-list.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { refresh } from "../src/session-list.js";

test("refresh does not duplicate the session list", () => {
  const sessions = [{ title: "a" }, { title: "b" }];
  const container = [];
  refresh(container, sessions);
  refresh(container, sessions);
  assert.equal(container.length, 2, "container must hold each session exactly once after two refreshes");
});
`,
    "utf-8",
  );
  writeFileSync(join(dir, "README.md"), "# session-list fixture\n\n`npm test` runs the suite; one test currently fails.\n", "utf-8");
}
