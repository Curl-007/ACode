// ============================================================
// R13 后端能力剥离与闭集 retry/fail 信号单测
// （specs/tool-search.md R13 / 测试矩阵「单测（core，R13）」行）
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  type ModelToolContract,
} from "@acode/contracts";
import {
  TOOL_SEARCH_STRIP_REASONS,
  TOOL_SEARCH_STRIP_DISPOSITIONS,
  toolSearchStripDisposition,
  ToolSearchCapabilityError,
} from "../src/tool/search/capability.js";
import { buildToolExposure, resolveToolSearchMode } from "../src/tool/search/exposure.js";

function tool(name: string): ModelToolContract {
  return { name, inputSchema: { type: "object" } };
}

test("R13 词表闭集：disposition 穷举映射全部落在 retry|fail 两档内", () => {
  for (const reason of TOOL_SEARCH_STRIP_REASONS) {
    const disposition = toolSearchStripDisposition(reason);
    assert.ok((TOOL_SEARCH_STRIP_DISPOSITIONS as readonly string[]).includes(disposition));
  }
  // 对照上游分档：请求面能力剥离后重建请求可继续 → retry（foundry-capability-strip）；
  // 构建事实/请求面能力下限 → fail（foundry-purpose-request 的目的缺失即败语义）。
  assert.equal(toolSearchStripDisposition("native_protocol_unsupported"), "retry");
  assert.equal(toolSearchStripDisposition("native_not_implemented"), "fail");
  assert.equal(toolSearchStripDisposition("tool_call_unsupported"), "fail");
});

test("R13 显式 native：ToolSearchCapabilityError 携带闭集信号，message 兼容波 1 文案", () => {
  assert.throws(
    () => resolveToolSearchMode("native", { supportsToolCall: true }),
    (error: unknown) => {
      assert.ok(error instanceof ToolSearchCapabilityError);
      // 普通错误链兼容：仍是 Error 实例，沿 turn 错误链上抛行为不变（R1）。
      assert.ok(error instanceof Error);
      assert.deepEqual(error.signal, { disposition: "fail", reason: "native_not_implemented" });
      assert.match(error.message, /not implemented/);
      return true;
    },
  );
});

test("R13 auto 升 native 分支（波 2 才可达）：同为闭集 fail 信号", () => {
  assert.throws(
    () =>
      resolveToolSearchMode("auto", {
        supportsToolCall: true,
        capability: { protocolSupported: true, defaultEnabled: true },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ToolSearchCapabilityError);
      assert.equal(error.signal.reason, "native_not_implemented");
      assert.equal(error.signal.disposition, "fail");
      return true;
    },
  );
});

test("R13 显式 local + 无 tool call：fail/tool_call_unsupported；auto 不抛错走降级", () => {
  assert.throws(
    () => resolveToolSearchMode("local", { supportsToolCall: false }),
    (error: unknown) => {
      assert.ok(error instanceof ToolSearchCapabilityError);
      assert.deepEqual(error.signal, { disposition: "fail", reason: "tool_call_unsupported" });
      assert.match(error.message, /tool calls/);
      return true;
    },
  );
  assert.equal(resolveToolSearchMode("auto", { supportsToolCall: false }), "off");
});

test("R13 降级原因分档：auto 能力降级 → tool_call_unsupported；配置 off → provider_disabled", () => {
  const tools = [
    tool("Read"),
    tool("TodoWrite"),
    tool(TOOL_SEARCH_NAME),
    tool(DEFERRED_TOOL_CALL_NAME),
  ];
  const registry = {
    get: (name: string) => ({ metadata: { name, shouldDefer: name === "TodoWrite" } }) as never,
  };

  const degraded = buildToolExposure({
    facts: { supportsToolCall: false },
    mode: "auto",
    tools,
    registry,
    entries: [],
  });
  assert.equal(degraded.enabled, false);
  // 能力事实档：与用户配置 off（provider_disabled，意图事实）在信号层可辨识。
  assert.equal(degraded.reason, "tool_call_unsupported");
  // R12 fail-open 红线：全量目录照常发送，零行为变化。
  assert.deepEqual(
    degraded.tools.map((t) => t.name),
    tools.map((t) => t.name),
  );

  const configured = buildToolExposure({
    facts: { supportsToolCall: true },
    mode: "off",
    tools,
    registry,
    entries: [],
  });
  assert.equal(configured.enabled, false);
  assert.equal(configured.reason, "provider_disabled");
});
