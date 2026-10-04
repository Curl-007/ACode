import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * prompt-cache miss-cause 归因诊断的验收测试
 *（apps/acode-cli/specs/prompt-cache-diagnostics.md）。
 * 两部分：
 * 1) 归因纯逻辑单测——直接驱动 recordMainTurnCacheHitUsage（Path A 唯一判定点），
 *    钉住闭集、优先级、命中不计数、pending 消费语义、快照拷贝；
 * 2) 跨包镜像源码不变量——CLI 生产侧与 shared 三处 strict 镜像 + services 中继
 *    必须同批加宽（v4 客户端整帧校验，漏一处 = SUBSCRIPTION_CONTENT_REJECTED），
 *    外加 no-telemetry 负向断言（R6：诊断零网络出口）。
 */

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const { recordMainTurnCacheHitUsage, CACHE_TTL_SUSPECT_MS } = await import(
  "../packages/core/src/runtime/methods/turn-model-step-usage.ts"
);

function createFakeRuntime(overrides = {}) {
  return {
    mainTurnCacheHitAggregate: {
      requestCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    },
    cacheMissCauseCounts: {},
    pendingCacheMissCause: undefined,
    lastRequestModelId: undefined,
    lastAssistantCompletedAtMs: undefined,
    ...overrides,
  };
}

const MISS_USAGE = Object.freeze({ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 100 });
const HIT_USAGE = Object.freeze({ inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0 });

test("miss + 显式 pending cause：计入该因、pending 消费即清、快照随载荷下发", () => {
  const runtime = createFakeRuntime({ pendingCacheMissCause: "compaction" });
  const result = recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  assert.equal(runtime.cacheMissCauseCounts.compaction, 1);
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.deepEqual(result.missCauses, { compaction: 1 });
});

test("优先级：显式事件 > model_changed > idle_ttl_suspected > unknown", () => {
  // 显式胜出（即使同时换了模型且长期闲置）
  const explicit = createFakeRuntime({
    pendingCacheMissCause: "context_refresh",
    lastRequestModelId: "model-a",
    lastAssistantCompletedAtMs: Date.now() - CACHE_TTL_SUSPECT_MS * 2,
  });
  recordMainTurnCacheHitUsage(explicit, MISS_USAGE, "model-b");
  assert.deepEqual(Object.keys(explicit.cacheMissCauseCounts), ["context_refresh"]);

  // 无显式 + 换模型 → model_changed（且首请求 lastRequestModelId 缺席不误判换模）
  const switched = createFakeRuntime({ lastRequestModelId: "model-a" });
  recordMainTurnCacheHitUsage(switched, MISS_USAGE, "model-b");
  assert.deepEqual(Object.keys(switched.cacheMissCauseCounts), ["model_changed"]);
  assert.equal(switched.lastRequestModelId, "model-b");

  const first = createFakeRuntime();
  recordMainTurnCacheHitUsage(first, MISS_USAGE, "model-a");
  assert.deepEqual(Object.keys(first.cacheMissCauseCounts), ["unknown"]);

  // 无显式 + 同模型 + 超窗闲置 → idle_ttl_suspected（推断值）
  const idle = createFakeRuntime({
    lastRequestModelId: "model-a",
    lastAssistantCompletedAtMs: Date.now() - CACHE_TTL_SUSPECT_MS - 1_000,
  });
  recordMainTurnCacheHitUsage(idle, MISS_USAGE, "model-a");
  assert.deepEqual(Object.keys(idle.cacheMissCauseCounts), ["idle_ttl_suspected"]);
});

test("命中不计数且同样消费 pending（陈旧 pending 不得归因给后续无关 miss）", () => {
  const runtime = createFakeRuntime({ pendingCacheMissCause: "compaction" });
  const hit = recordMainTurnCacheHitUsage(runtime, HIT_USAGE, "model-a");
  assert.deepEqual(runtime.cacheMissCauseCounts, {});
  assert.equal(runtime.pendingCacheMissCause, undefined);
  assert.equal(hit.missCauses, undefined);
  // 之后的 miss 不再被已消费的 compaction 污染
  const miss = recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  assert.deepEqual(Object.keys(miss.missCauses), ["unknown"]);
});

test("计数只增且快照是拷贝（改返回值不影响 runtime 事实源）", () => {
  const runtime = createFakeRuntime();
  runtime.pendingCacheMissCause = "conversation_rewind";
  recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  const second = recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  second.missCauses.conversation_rewind = 999;
  assert.equal(runtime.cacheMissCauseCounts.conversation_rewind, 1);
  assert.equal(runtime.cacheMissCauseCounts.unknown, 1);
});

test("闭集纪律：产出的每个因名都在 contracts 因集常量里", () => {
  const contractsSource = read("../packages/contracts/src/events/session.events.ts");
  const block = contractsSource.match(/PROMPT_CACHE_MISS_CAUSES = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "contracts 必须导出 PROMPT_CACHE_MISS_CAUSES 闭集常量");
  const causes = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(causes, [
    "conversation_rewind",
    "control_only_turn",
    "compaction",
    "context_refresh",
    "model_changed",
    "idle_ttl_suspected",
    "unknown",
  ]);
  const runtime = createFakeRuntime({
    lastAssistantCompletedAtMs: Date.now() - CACHE_TTL_SUSPECT_MS * 10,
  });
  for (const pending of [undefined, "conversation_rewind", "control_only_turn", "compaction"]) {
    runtime.pendingCacheMissCause = pending;
    recordMainTurnCacheHitUsage(runtime, MISS_USAGE, pending ? "model-a" : "model-b");
  }
  for (const cause of Object.keys(runtime.cacheMissCauseCounts)) {
    assert.ok(causes.includes(cause), `产出因 ${cause} 不在闭集内`);
  }
});

test("R4 同批加宽守护：shared 三处 strict 镜像 + services 中继挑取缺一不可", () => {
  const legacy = read("../../../packages/shared/src/acode-protocol-legacy-types.ts");
  const legacySchema = legacy.slice(
    legacy.indexOf("export const acodeSessionContextCacheUsageSchema"),
    legacy.indexOf(".strict();", legacy.indexOf("export const acodeSessionContextCacheUsageSchema")),
  );
  assert.ok(legacySchema.includes("missCauses"), "v3/v4 客户端校验镜像必须含 missCauses");

  const taskTypes = read("../../../packages/shared/src/acode-task-types-core.ts");
  const cacheUsage = taskTypes.slice(
    taskTypes.indexOf("export interface ACodeContextCacheUsage"),
    taskTypes.indexOf("export interface ACodeTaskTokenUsageDelta"),
  );
  assert.ok(cacheUsage.includes("missCauses?: Record<string, number>"), "共享类型必须含 missCauses");

  const sessionDebug = read("../../../packages/shared/src/session-debug.ts");
  assert.ok(
    sessionDebug.includes("missCauses: z.record(z.string(), count).optional()"),
    "session-debug 快照镜像必须含 missCauses",
  );

  const adapter = read("../../../packages/services/src/acode-agent/acodeTaskServiceAdapter.ts");
  assert.ok(
    adapter.includes("missCauseCountsFromUnknown(aggregate.missCauses)") &&
      adapter.includes("...(missCauses ? { missCauses } : {})"),
    "services 显式挑取中继必须透传 missCauses（否则 v3 链路静默丢弃）",
  );
});

test("R1/R3 事件点与重建复位守护", () => {
  const rewind = read("../packages/core/src/runtime/methods/rewind-message.ts");
  assert.ok(rewind.includes('this.pendingCacheMissCause = "conversation_rewind"'));
  assert.ok(rewind.includes("this.cacheMissCauseCounts = {};"), "rewind 重建必须复位计数");
  const resume = read("../packages/core/src/runtime/methods/resume.ts");
  assert.ok(resume.includes("this.cacheMissCauseCounts = {};"), "冷启动重建必须复位计数");
  const controlOnly = read("../packages/core/src/runtime/methods/control-only-turn.ts");
  assert.ok(controlOnly.includes('this.pendingCacheMissCause = "control_only_turn"'));
  const compact = read("../packages/core/src/runtime/methods/compact-active.ts");
  assert.ok(compact.includes('this.pendingCacheMissCause = "compaction"'));
  const micro = read("../packages/core/src/runtime/methods/microcompact.ts");
  assert.ok(micro.includes('this.pendingCacheMissCause = "compaction"'));
  const refresh = read("../packages/core/src/runtime/methods/context-refresh.ts");
  assert.ok(refresh.includes('runtime.pendingCacheMissCause = "context_refresh"'));
});

test("R6 no-telemetry：归因与 debug 旁路零网络出口（负向断言）", () => {
  for (const rel of [
    "../packages/core/src/runtime/methods/turn-model-step-usage.ts",
    "../packages/bootstrap/src/acode-protocol/session-debug.ts",
  ]) {
    const source = read(rel);
    assert.ok(!source.includes("fetch("), `${rel} 不得出现 fetch`);
    assert.ok(!/from "node:(http|https|net|dgram)"/.test(source), `${rel} 不得引入网络模块`);
    assert.ok(!source.includes("XMLHttpRequest"), `${rel} 不得出现 XHR`);
  }
});

test("R5 UI 落点：DeveloperToolsPane 消费 missCauses 且双语键齐全", () => {
  const pane = read("../../../packages/ui/src/DeveloperToolsPane.tsx");
  assert.ok(pane.includes("debugState.cache?.missCauses"), "面板必须消费 missCauses");
  assert.ok(pane.includes("idleTtlSuspected"), "闲置 TTL 因必须有「疑似」标注键");
  for (const locale of ["en-US", "zh-CN"]) {
    const source = read(`../../../packages/ui/src/i18n/locales/${locale}.ts`);
    assert.ok(
      source.includes('"tokenDebug.summary.missCauses"') &&
        source.includes('"tokenDebug.missCause.idleTtlSuspected"'),
      `${locale} 缺 miss-cause i18n 键`,
    );
  }
});
