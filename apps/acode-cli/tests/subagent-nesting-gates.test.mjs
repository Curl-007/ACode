import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 编排方案 Phase 4 第一批验收（apps/acode-cli/specs/subagent-nesting-budget.md
 * 场景 1-6）：fail-closed 硬封、R1 天花板锚根（depth≤1 逐字节回归 + depth≥2 封堵
 * 提权链）、R2 严苛度序、R3 谱系单点派生、第五道门同源、闸门唯一出口。
 * 场景 7/8（预算三闸、§6.1/§6.3）属第二批，落地时补。
 */

const {
  TREE_BUDGET_ADMISSION_LANDED,
  moreRestrictiveMode,
  resolveChildSubagentsEnabled,
  resolveEffectiveSubagentMaxDepth,
} = await import("../packages/core/src/subagent/nesting-policy.ts");
const { resolveSubagentPermissionMode } = await import(
  "../packages/core/src/runtime/methods/subagent.ts"
);
const {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} = await import("../packages/core/src/subagent/tool-policy.ts");

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

test("(场景1/6) 生效 maxDepth = min(装配值, caps.maxDepth)，缺省仍 1；第二批已翻开总闸", async () => {
  // 第二批（tree-budget 三闸 + §6.1/§6.2/§6.3）落地后 TREE_BUDGET_ADMISSION_LANDED=true：
  // 配置值开始生效，但被 caps.maxDepth 夹住；缺省（maxDepth 缺席）仍是 1 = 原现状。
  assert.equal(TREE_BUDGET_ADMISSION_LANDED, true);
  const { TREE_BUDGET_CAPS } = await import("../packages/core/src/subagent/tree-budget.ts");
  assert.equal(resolveEffectiveSubagentMaxDepth(undefined), 1);
  assert.equal(resolveEffectiveSubagentMaxDepth(0), 1);
  assert.equal(resolveEffectiveSubagentMaxDepth(-3), 1);
  assert.equal(resolveEffectiveSubagentMaxDepth(2.7), 2);
  assert.equal(
    resolveEffectiveSubagentMaxDepth(TREE_BUDGET_CAPS.maxDepth + 10),
    TREE_BUDGET_CAPS.maxDepth,
  );
  // 缺省配置下 child 派发使能恒 false（= 原 enabled:false 写死，默认行为逐字节不变）
  assert.equal(resolveChildSubagentsEnabled({ childDepth: 1, configuredMaxDepth: undefined }), false);
  // 显式配置 + 闸门落地后才存在放开路径，且被 caps 夹住
  assert.equal(resolveChildSubagentsEnabled({ childDepth: 1, configuredMaxDepth: 2 }), true);
  assert.equal(
    resolveChildSubagentsEnabled({ childDepth: TREE_BUDGET_CAPS.maxDepth, configuredMaxDepth: 99 }),
    false,
  );
});

test("(场景1) 三参旧签名逐字节回归：depth≤1 语义与修复前一致", () => {
  assert.equal(resolveSubagentPermissionMode("build", undefined, true), "yolo");
  assert.equal(resolveSubagentPermissionMode("build", undefined, false), "build");
  assert.equal(resolveSubagentPermissionMode("build", "yolo", false), "build");
  assert.equal(resolveSubagentPermissionMode("edit", "bypassPermissions", false), "edit");
  assert.equal(resolveSubagentPermissionMode("build", "yolo", true), "build");
  assert.equal(resolveSubagentPermissionMode("build", "auto", false), "auto");
  assert.equal(resolveSubagentPermissionMode("build", "plan", false), "plan");
  assert.equal(resolveSubagentPermissionMode("yolo", undefined, false), "yolo");
  // 显式 depth:1 锚参与三参缺省同义
  assert.equal(
    resolveSubagentPermissionMode("build", undefined, true, { depth: 1, rootMode: "edit" }),
    "yolo",
  );
});

test("(场景2) R1 封堵：depth≥2 天花板锚根，Explore 不再缺省 yolo", () => {
  // 审计 B1 的提权链：根 build → Explore 子 yolo → 孙代理 undefined 分支
  assert.equal(
    resolveSubagentPermissionMode("yolo", undefined, false, { depth: 2, rootMode: "build" }),
    "build",
    "孙代理经 yolo 父继承突破根 build 天花板",
  );
  // depth≥2 的 Explore 不再享受只读豁免缺省
  assert.equal(
    resolveSubagentPermissionMode("yolo", undefined, true, { depth: 2, rootMode: "build" }),
    "build",
  );
  // 显式 yolo/bypass 同样被锚根夹住
  assert.equal(
    resolveSubagentPermissionMode("build", "yolo", false, { depth: 2, rootMode: "edit" }),
    "edit",
  );
  assert.equal(
    resolveSubagentPermissionMode("build", "bypassPermissions", false, { depth: 3, rootMode: "build" }),
    "build",
  );
  // auto/plan 覆盖照旧直通（只会更严）
  assert.equal(resolveSubagentPermissionMode("build", "auto", false, { depth: 2, rootMode: "build" }), "auto");
  assert.equal(resolveSubagentPermissionMode("build", "plan", false, { depth: 2, rootMode: "build" }), "plan");
});

test("(场景3) R2 严苛度序：auto < plan < edit < build < yolo，缺席 fail-closed", () => {
  assert.equal(moreRestrictiveMode("build", "yolo"), "build");
  assert.equal(moreRestrictiveMode("yolo", "build"), "build");
  assert.equal(moreRestrictiveMode("plan", "auto"), "auto");
  assert.equal(moreRestrictiveMode("auto", "plan"), "auto");
  assert.equal(moreRestrictiveMode("build", "edit"), "edit");
  assert.equal(moreRestrictiveMode("yolo", "plan"), "plan");
  assert.equal(moreRestrictiveMode(undefined, "build"), "build");
  assert.equal(moreRestrictiveMode("build", undefined), "build");
  assert.equal(moreRestrictiveMode(undefined, undefined), "auto");
});

test("(场景4/R3) allowDispatch 与 enabled 闸门同源：未获派发许可一律剔除派发工具", () => {
  // 缺省（今天的全部 child）：Agent/Task 剔除，R2 修复语义不变
  const strict = buildSubagentChildDisallowRules(undefined);
  assert.ok(strict.includes("Agent") && strict.includes("Task"));
  assert.deepEqual(filterSubagentChildToolNames(["Agent", "Task", "Read"], undefined), ["Read"]);
  // allowDispatch=true（预算闸落地后 childDepth < maxDepth 的 child）：保留派发工具，
  // plan 工具仍强制剔除
  const permissive = buildSubagentChildDisallowRules(undefined, { allowDispatch: true });
  assert.equal(permissive.includes("Agent"), false);
  assert.equal(permissive.includes("Task"), false);
  assert.ok(permissive.includes("EnterPlanMode") && permissive.includes("ExitPlanMode"));
  assert.deepEqual(
    filterSubagentChildToolNames(["Agent", "Read"], undefined, { allowDispatch: true }),
    ["Agent", "Read"],
  );
  // 调用方 disallowed 仍叠加生效
  assert.deepEqual(
    filterSubagentChildToolNames(["Agent", "Read"], ["Agent"], { allowDispatch: true }),
    ["Read"],
  );
});

test("(场景4/5/6) 源码不变量：谱系父自填单点、第五道门同源、闸门唯一出口", async () => {
  const subagent = await read("packages/core/src/runtime/methods/subagent.ts");
  // R3 机械保证：depth 由父闭包自算，child config 三事实字段父自填
  assert.ok(
    /const childDepth = \(this\.config\.subagentDepth \?\? 0\) \+ 1;/.test(subagent),
    "childDepth 不是父闭包自算",
  );
  assert.ok(/subagentDepth: childDepth,/.test(subagent));
  assert.ok(/rootSessionId: this\.config\.rootSessionId \?\? this\.sessionId,/.test(subagent));
  assert.ok(/rootMode,/.test(subagent));
  // enabled 单点派生（原 enabled:false 写死已删）
  assert.ok(/enabled: childSubagentsEnabled,/.test(subagent));
  assert.equal(/enabled: false,/.test(subagent), false, "child config 仍有 enabled:false 写死");
  // allowlist 与 enabled 同源
  assert.ok(/\{ allowDispatch: childSubagentsEnabled \}/.test(subagent));
  // 锚参进权限裁决
  assert.ok(/\{ depth: childDepth, rootMode \}/.test(subagent));

  // 第五道门回归：两注册入口 includeAgent 判定同源（tool-allowlist 两入口同规则纪律）
  for (const path of [
    "packages/core/src/runtime/helpers/runtime-tools.ts",
    "packages/core/src/runtime/methods/embedded-search-branch.ts",
  ]) {
    const source = await read(path);
    assert.ok(
      /includeAgent: Boolean\(runtime\.subagentPort\)/.test(source),
      `${path} 的 includeAgent 门不同源`,
    );
  }

  // 闸门唯一出口：core 运行时代码里 subagents?.maxDepth 只被 nesting-policy 出口消费
  // （child config 透传 + resolveChildSubagentsEnabled 入参），不存在第二处 enabled 判定
  const maxDepthReads = subagent.match(/subagents\?\.maxDepth/g) ?? [];
  assert.equal(maxDepthReads.length, 2, "subagent.ts 对 maxDepth 的读取应恰为：闸门入参 + 透传");
  const runner = await read("packages/core/src/subagent/runner.ts");
  assert.equal(/maxDepth/.test(runner), false, "runner 出现 maxDepth 判定（闸门必须单点）");
});
