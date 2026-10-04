/**
 * experimental（spec §R6：关键开放问题 = `-p` 进程主 turn 结束后是否存活至后台任务
 * 通知；进程早退时 runner 在报告记 background-orphan，本身即产品行为发现）。
 * 语料 setup：后台子代理做代码修改并报告成功；转录须含完成通知与父代理随后 turn。
 * fixture 植入 pagination off-by-one（语料 prompt 点名）+ 失败测试。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const mode = "yolo";
export const experimental = true;

export async function setup(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "pagination-fixture", private: true, type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2)}\n`,
    "utf-8",
  );
  // 植入 off-by-one：slice 上界少取一个元素。
  writeFileSync(
    join(dir, "src", "pagination.js"),
    `export function paginate(items, start, count) {
  return items.slice(start, start + count - 1);
}
`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "tests", "pagination.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "../src/pagination.js";

test("paginate returns exactly count items", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(items, 1, 3), [2, 3, 4]);
});
`,
    "utf-8",
  );
  writeFileSync(join(dir, "README.md"), "# pagination fixture\n\n`npm test` runs the suite; the paginate test currently fails.\n", "utf-8");
}
