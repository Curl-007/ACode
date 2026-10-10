import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * 编排方案 §5 R2 修复的验收（specs/subagent-policy-floor-inheritance.md 增补 R4，
 * 验收场景 7/8/9）：派发工具（Agent/Task）剔除的单一出处在 tool-policy 强制集，
 * 显式 allowedTools 分支不再有绕过；注册门（端口门）两入口保持完好。
 */

const {
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
} = await import("../packages/core/src/subagent/tool-policy.ts");
const { SUBAGENT_DISPATCH_TOOL_NAMES, isSubagentDispatchToolName } = await import(
  "../packages/core/src/tool/compat.ts"
);

const root = new URL("../", import.meta.url);
// core.autocrlf=true 的机器上工作区是 CRLF；归一为 LF 再做位置敏感断言。
const read = (path) =>
  readFile(new URL(path, root), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

test("(场景7) forced set covers dispatch tools; filter strips them for any caller rules", () => {
  const rules = buildSubagentChildDisallowRules(undefined);
  for (const name of ["Agent", "Task", "EnterPlanMode", "ExitPlanMode"]) {
    assert.ok(rules.includes(name), `强制集缺少 ${name}`);
  }
  // 调用方规则照常叠加，不被强制集吞掉
  assert.ok(buildSubagentChildDisallowRules(["Bash"]).includes("Bash"));

  assert.deepEqual(
    filterSubagentChildToolNames(["Agent", "Task", "Read", "Bash"], undefined),
    ["Read", "Bash"],
  );
  // 显式 allowlist 只含派发工具 → 解析结果为空（R2 洞的正面复现路径已封死）
  assert.deepEqual(filterSubagentChildToolNames(["Agent"], []), []);
  assert.deepEqual(filterSubagentChildToolNames(["Task"], ["Read"]), []);
});

test("(场景7) dispatch roster has a single source shared with the registration gate", () => {
  assert.deepEqual([...SUBAGENT_DISPATCH_TOOL_NAMES], ["Agent", "Task"]);
  assert.equal(isSubagentDispatchToolName("Agent"), true);
  assert.equal(isSubagentDispatchToolName("Task"), true);
  assert.equal(isSubagentDispatchToolName("Read"), false);
  assert.equal(isSubagentDispatchToolName(undefined), false);
});

test("(场景8) both allowlist branches strip via the forced set; no second inline filter", async () => {
  const source = await read("packages/core/src/runtime/methods/subagent.ts");
  const start = source.indexOf("function resolveSubagentToolAllowlist");
  assert.ok(start >= 0, "resolveSubagentToolAllowlist 未找到");
  const end = source.indexOf("function filterMcpToolNamesByParentAllowlist", start);
  assert.ok(end > start);
  const body = source.slice(start, end);

  // 显式分支经 filterSubagentChildToolNames（强制集自动覆盖派发工具）
  assert.ok(
    /filterSubagentChildToolNames\(request\.allowedTools, disallowedRules\)/.test(body),
    "显式 allowedTools 分支未经过强制集过滤",
  );
  // inherits 分支同样经强制集；内联派发剔除已移除（单一出处，防两份机制漂移）
  assert.equal(
    /isSubagentDispatchToolName/.test(body),
    false,
    "resolveSubagentToolAllowlist 内出现第二份派发剔除——强制集是唯一出处",
  );
  assert.equal(
    /from "\.\.\/\.\.\/tool\/compat\.js"/.test(source),
    false,
    "subagent.ts 仍直接依赖 compat 的派发判定（应经 tool-policy 强制集收敛）",
  );
});

test("(场景9) registration gates remain intact in both tool registration entries", async () => {
  const handlers = await read("packages/core/src/tool/handlers/index.ts");
  assert.ok(
    /isSubagentDispatchToolName\(entry\.metadata\.name\) && options\.includeAgent !== true/.test(
      handlers,
    ),
    "handlers/index.ts 的派发工具注册门被弱化",
  );
  for (const path of [
    "packages/core/src/runtime/methods/embedded-search-branch.ts",
    "packages/core/src/runtime/helpers/runtime-tools.ts",
  ]) {
    const source = await read(path);
    assert.ok(
      /includeAgent: Boolean\(runtime\.subagentPort\)/.test(source),
      `${path} 的 includeAgent 端口门被弱化`,
    );
  }
});
