/**
 * first-run-unverified（依赖 Agent + SendMessage 在无头下可用，spec §R6）：
 * continue-vs-fresh 判据。语料 setup：子代理完成实现后，任务要求 (a) 同文件跟进
 * （应 SendMessage 续同一线程）与 (b) 变更验证（应 fresh 派发新眼睛）；转录必须
 * 呈现两个派发决策。fixture 植入「signup 表单缺输入验证」+ 失败测试。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const mode = "yolo";

export async function setup(dir) {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "signup-fixture", private: true, type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2)}\n`,
    "utf-8",
  );
  // 植入缺口：validateSignup 不做任何验证（语料 prompt 要求补输入验证）。
  writeFileSync(
    join(dir, "src", "signup.js"),
    `export function validateSignup(input) {
  return { ok: true, values: input };
}
`,
    "utf-8",
  );
  // 失败测试：钉住期望的验证语义（email 必填、密码最短 8 位）。
  writeFileSync(
    join(dir, "tests", "signup.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { validateSignup } from "../src/signup.js";

test("rejects a missing email", () => {
  const result = validateSignup({ email: "", password: "longenough1" });
  assert.equal(result.ok, false);
});

test("rejects a password shorter than 8 chars", () => {
  const result = validateSignup({ email: "a@b.co", password: "short" });
  assert.equal(result.ok, false);
});
`,
    "utf-8",
  );
  writeFileSync(join(dir, "README.md"), "# signup fixture\n\n`npm test` runs the suite; validation tests currently fail.\n", "utf-8");
}
