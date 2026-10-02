import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * W7 验收测试：内建输出风格注册表与按名选择。
 *
 * 覆盖规格 apps/acode-cli/specs/built-in-output-styles.md 的 R1–R4 与验收场景 1–4：
 * - 场景 1：注册表形态（两个风格、name 小写唯一、prompt ≤800 字符、无 CJK、keepCodingInstructions）；
 * - 场景 2：解析语义（按名大小写不敏感 / 未知名 undefined / 对象透传 / undefined 透传）；
 * - 场景 3：patch 入口行为（源码级钉住解析单点 + warn + 清除语义保留）；
 * - 场景 4：三处 updateConfig 声明同源 RuntimeConfigUpdatePatch。
 */

const {
  BUILT_IN_OUTPUT_STYLES,
  resolveOutputStyleSelection,
  isBuiltInOutputStyleName,
} = await import("../packages/core/src/context/output-styles.ts");

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

test("(场景1/R1) 注册表形态：explanatory + concise，文本约束齐备", () => {
  assert.equal(BUILT_IN_OUTPUT_STYLES.length, 2);
  const names = BUILT_IN_OUTPUT_STYLES.map((style) => style.name);
  assert.deepEqual(names, ["explanatory", "concise"]);
  assert.equal(new Set(names).size, names.length);
  for (const style of BUILT_IN_OUTPUT_STYLES) {
    assert.equal(style.name, style.name.toLowerCase());
    assert.ok(style.prompt.length > 0);
    assert.ok(style.prompt.length <= 800, `${style.name} prompt 超过 800 字符上限`);
    assert.equal(style.keepCodingInstructions, true);
    assert.ok(!CJK_PATTERN.test(style.prompt), `${style.name} prompt 含 CJK`);
  }
  // 风格定位抽查（教学式：洞察连到一般模式；精简式：承重信息不许省）：
  assert.ok(BUILT_IN_OUTPUT_STYLES[0].prompt.includes("educational insight"));
  assert.ok(BUILT_IN_OUTPUT_STYLES[1].prompt.includes("load-bearing information"));
});

test("(场景2/R2) 解析语义：按名（大小写不敏感）/ 未知名 / 对象透传 / undefined", () => {
  const concise = BUILT_IN_OUTPUT_STYLES[1];
  const resolved = resolveOutputStyleSelection("concise");
  assert.ok(resolved);
  assert.equal(resolved.name, concise.name);
  assert.equal(resolved.prompt, concise.prompt);
  assert.equal(resolved.keepCodingInstructions, true);

  assert.deepEqual(resolveOutputStyleSelection("Concise"), resolved);
  assert.deepEqual(resolveOutputStyleSelection("  CONCISE  "), resolved);
  assert.equal(isBuiltInOutputStyleName("explanatory"), true);
  assert.equal(isBuiltInOutputStyleName("learning"), false);

  assert.equal(resolveOutputStyleSelection("no-such-style"), undefined);
  assert.equal(resolveOutputStyleSelection(undefined), undefined);

  const custom = { name: "custom", prompt: "Do X." };
  assert.equal(resolveOutputStyleSelection(custom), custom); // 同一对象引用透传
});

test("(场景3/R3) patch 入口：解析单点 + 未知名 warn 不改写 + 清除语义保留（源码级）", async () => {
  const source = await readFile(
    new URL("../packages/core/src/runtime/methods/config.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("resolveOutputStyleSelection(patch.outputStyle)"));
  assert.ok(source.includes('"outputStyle" in patch')); // 显式 undefined = 清除的既有判定不动
  assert.ok(source.includes("Unknown built-in output style name"));
  // 未命中路径：warn 分支内不得赋值 config.outputStyle（赋值只出现在 else 分支）。
  const branch = source.slice(
    source.indexOf('if ("outputStyle" in patch)'),
    source.indexOf("export function initializeSessionShellEnvironmentIfNeeded"),
  );
  assert.ok(branch.includes("this.logger?.warn"));
  const warnArm = branch.slice(branch.indexOf("this.logger?.warn"), branch.indexOf("} else {"));
  assert.ok(!warnArm.includes("this.config.outputStyle ="));
});

test("(场景4/R3) 三处 updateConfig 声明同源 RuntimeConfigUpdatePatch", async () => {
  const files = [
    ["../packages/core/src/runtime/methods/config.ts", "patch: RuntimeConfigUpdatePatch"],
    ["../packages/core/src/runtime/internal-methods.ts", "updateConfig(patch: RuntimeConfigUpdatePatch)"],
    ["../packages/core/src/runtime/agent-runtime.ts", "updateConfig(patch: RuntimeConfigUpdatePatch)"],
  ];
  for (const [path, needle] of files) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.ok(source.includes(needle), `${path} 缺少 "${needle}"`);
    // 旧的内联 Pick 组合不得回来（防再分叉）：
    assert.ok(
      !source.includes('Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">'),
      `${path} 仍存在内联 Pick 声明`,
    );
  }
  // 命名类型定义在 runtime/types.ts，outputStyle 收对象或字符串：
  const types = await readFile(
    new URL("../packages/core/src/runtime/types.ts", import.meta.url),
    "utf8",
  );
  assert.ok(types.includes("export type RuntimeConfigUpdatePatch"));
  assert.ok(types.includes("outputStyle?: OutputStylePromptConfig | string"));
});
