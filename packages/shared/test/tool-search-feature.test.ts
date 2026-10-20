import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOL_SEARCH_APP_MODE,
  TOOL_SEARCH_APP_MODES,
  normalizeToolSearchAppMode,
} from "../src/tool-search-feature.js";
import { commandPayloadSchemas } from "../src/acode-protocol-v4/command.js";

// 行为规格见 apps/acode-cli/specs/tool-search.md R1/R3/R11；形态对照
// script-workflow-feature.test.ts（同款本机产品开关的 shared 层测试计划）。

test("取值域是三值（auto/local/off），缺省档是 off（零行为变化红线，与 dwf/script 的 fail-open 方向相反）", () => {
  assert.deepEqual([...TOOL_SEARCH_APP_MODES], ["auto", "local", "off"]);
  assert.equal(DEFAULT_TOOL_SEARCH_APP_MODE, "off");
});

test("归一化：闭集内原样返回、容忍空白，native/非法/形状错误归 undefined（调用方落缺省档）", () => {
  for (const mode of TOOL_SEARCH_APP_MODES) {
    assert.equal(normalizeToolSearchAppMode(mode), mode);
  }
  assert.equal(normalizeToolSearchAppMode("  local  "), "local");
  // native 是 CLI --toolsearch-mode 独有的第四档，刻意不在 App 三值域内：
  // 设置面归一化必须拒绝，防止 native 经设置链渗进 Host 物化。
  assert.equal(normalizeToolSearchAppMode("native"), undefined);
  assert.equal(normalizeToolSearchAppMode("Off"), undefined, "大小写敏感，与 script 同款裁决");
  assert.equal(normalizeToolSearchAppMode("bogus"), undefined);
  assert.equal(normalizeToolSearchAppMode(42), undefined);
  assert.equal(normalizeToolSearchAppMode(null), undefined);
  assert.equal(normalizeToolSearchAppMode(undefined), undefined);
});

test("v4 createSession：三档合法值通过且保留，native/非法值拒绝", () => {
  for (const mode of TOOL_SEARCH_APP_MODES) {
    const result = commandPayloadSchemas.createSession.safeParse({
      workspaceId: "ws",
      toolSearchMode: mode,
    });
    assert.equal(result.success, true, `${mode} 应通过 createSession 校验`);
    if (!result.success) continue;
    assert.equal(result.data.toolSearchMode, mode);
  }
  for (const bogus of ["native", "bogus", 42, null]) {
    assert.equal(
      commandPayloadSchemas.createSession.safeParse({ workspaceId: "ws", toolSearchMode: bogus })
        .success,
      false,
      `${String(bogus)} 必须被 createSession 拒绝（native 不经 Host 设置链）`,
    );
  }
});

test("v4 createSession：字段可缺席，缺席时不写默认值（缺席 = off 的 wire 语义）", () => {
  const result = commandPayloadSchemas.createSession.safeParse({ workspaceId: "ws" });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    "toolSearchMode" in result.data,
    false,
    "optional 字段缺席不得被 zod 补默认值——旧 Host/legacy 面靠缺席表达 off",
  );
});
