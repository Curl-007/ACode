// hook additionalContext 注入通道防滥用硬化守护
// （specs/hook-additional-context-hardening.md）：单条 8KB 截断、单次派发 8 条上限、
// 来源 hook 名标注（formatter 层渲染，additionalContexts 内容本体不因标注改变）、
// sources 索引对齐不变式、无来源输出与旧版逐字节一致（零回归）。
import assert from "node:assert/strict";
import { test } from "node:test";

const { InMemoryHookRunner } = await import("../packages/core/src/hooks/runner.ts");
const {
  HOOK_ADDITIONAL_CONTEXT_MAX_CHARS,
  HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN,
  mergeHookRunResult,
} = await import("../packages/core/src/hooks/output.ts");
const {
  concatHookContextSources,
  formatHookAdditionalContexts,
} = await import("../packages/core/src/tool/executor/hook-flow.ts");

function baseInput(hookEventName = "PostToolUse") {
  return {
    cwd: "/work",
    hookEventName,
    mode: "build",
    sessionId: "sess_hardening",
    timestamp: new Date().toISOString(),
    toolCallId: "call_1",
    toolName: "Bash",
    traceId: "trace_hardening",
    turnId: "turn_hardening",
  };
}

function contextHook(name, output) {
  return {
    callback: async () => output,
    descriptor: {
      clientVisible: true,
      commandDisplay: name,
      executionMode: "foreground",
      executionType: "process",
      sourceKind: "workspace",
      timeoutMs: 1000,
    },
    event: "PostToolUse",
    source: name,
  };
}

async function runWith(hooks) {
  const runner = new InMemoryHookRunner({ hooks });
  return runner.run(baseInput());
}

test("单条长度上限：>8KB 头部截断并带 ...[truncated] 标记，截断后总长恰为上限", async () => {
  const long = "x".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 2000);
  const result = await runWith([
    contextHook("noisy", { hookSpecificOutput: { additionalContext: long, hookEventName: "PostToolUse" } }),
  ]);
  assert.equal(result.additionalContexts.length, 1);
  const entry = result.additionalContexts[0];
  assert.equal(entry.length, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS);
  assert.ok(entry.endsWith("...[truncated]"));
  assert.ok(entry.startsWith("xxxx"));
});

test("短文本零变化：不截断、内容本体不带标注（标注只在 formatter 层）", async () => {
  const result = await runWith([
    contextHook("tidy", { hookSpecificOutput: { additionalContext: "short-ctx", hookEventName: "PostToolUse" } }),
  ]);
  assert.deepEqual(result.additionalContexts, ["short-ctx"]);
  assert.deepEqual(result.additionalContextSources, ["tidy"]);
});

test("顶层 additionalContext / additional_context 两个字段同样被硬化", async () => {
  const long = "y".repeat(HOOK_ADDITIONAL_CONTEXT_MAX_CHARS + 10);
  const result = await runWith([
    contextHook("top-level", { additionalContext: long, additional_context: "legacy-snake" }),
  ]);
  assert.equal(result.additionalContexts.length, 2);
  assert.equal(result.additionalContexts[0].length, HOOK_ADDITIONAL_CONTEXT_MAX_CHARS);
  assert.equal(result.additionalContexts[1], "legacy-snake");
  assert.deepEqual(result.additionalContextSources, ["top-level", "top-level"]);
});

test("每次派发次数上限：9 个 hook 各产 1 条 → 只保留先到先得的 8 条", async () => {
  const hooks = Array.from({ length: 9 }, (_, index) =>
    contextHook(`h${index}`, { additionalContext: `ctx-${index}` }),
  );
  const result = await runWith(hooks);
  assert.equal(result.additionalContexts.length, HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN);
  assert.deepEqual(
    result.additionalContexts,
    Array.from({ length: 8 }, (_, index) => `ctx-${index}`),
  );
  assert.equal(result.additionalContextSources?.length, HOOK_ADDITIONAL_CONTEXTS_MAX_PER_RUN);
  assert.equal(result.additionalContextSources?.[7], "h7");
});

test("来源名消毒：换行折叠为单行、超 80 字符截断（防伪造多行标签）", async () => {
  const evilName = `evil\nhook${"n".repeat(120)}`;
  const result = await runWith([contextHook(evilName, { additionalContext: "ctx" })]);
  const source = result.additionalContextSources?.[0];
  assert.ok(source !== undefined);
  assert.ok(!source.includes("\n"));
  assert.ok(source.length <= 81); // 80 字符 + 省略号
  assert.ok(source.startsWith("evil hook"));
});

test("formatter：有来源渲染 #N (hook: 名)，无来源与旧版逐字节一致", () => {
  assert.equal(
    formatHookAdditionalContexts(["ctx-a", "ctx-b"], ["hookA", undefined]),
    "[Hook additional context]\n#1 (hook: hookA)\nctx-a\n#2\nctx-b",
  );
  // 零回归基线：无 sources 参数输出与存量实现完全一致
  assert.equal(
    formatHookAdditionalContexts(["ctx-a", "ctx-b"]),
    "[Hook additional context]\n#1\nctx-a\n#2\nctx-b",
  );
  // 全 undefined 的 sources 与缺席等价（字节一致）
  assert.equal(
    formatHookAdditionalContexts(["ctx-a"], [undefined]),
    formatHookAdditionalContexts(["ctx-a"]),
  );
});

test("concatHookContextSources：全无源 → undefined；混合 → undefined 占位对齐", () => {
  assert.equal(
    concatHookContextSources([
      { contexts: ["a"] },
      { contexts: ["b", "c"] },
    ]),
    undefined,
  );
  assert.deepEqual(
    concatHookContextSources([
      { contexts: ["a", "b"], sources: ["h1", "h1"] },
      { contexts: ["c"] },
    ]),
    ["h1", "h1", undefined],
  );
  assert.deepEqual(
    concatHookContextSources([
      { contexts: ["c"] },
      { contexts: ["d"], sources: ["h2"] },
    ]),
    [undefined, "h2"],
  );
});

test("mergeHookRunResult：有源/无源混合合并保持索引对齐；无源合并零回归", () => {
  const target = { additionalContexts: ["plain"] };
  mergeHookRunResult(target, { additionalContexts: ["labeled"], additionalContextSources: ["h"] });
  assert.deepEqual(target.additionalContexts, ["plain", "labeled"]);
  assert.deepEqual(target.additionalContextSources, [undefined, "h"]);

  // 纯无源合并（存量链）不产生 sources 字段——插件中间件守护测试的深比较不受影响
  const legacy = { additionalContexts: [] };
  mergeHookRunResult(legacy, { additionalContexts: ["legacy-ctx"] });
  assert.deepEqual(legacy, { additionalContexts: ["legacy-ctx"] });
  assert.equal("additionalContextSources" in legacy, false);
});

test("mergeHookRunResult：目标已满 8 条时后续合并被丢弃（上限在合并点收口）", () => {
  const target = {
    additionalContexts: Array.from({ length: 8 }, (_, index) => `t${index}`),
  };
  mergeHookRunResult(target, { additionalContexts: ["overflow"], additionalContextSources: ["h"] });
  assert.equal(target.additionalContexts.length, 8);
  assert.ok(!target.additionalContexts.includes("overflow"));
});
