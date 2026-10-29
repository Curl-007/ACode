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
const { initializeRuntimeCacheDiagnostics, getRuntimeCacheDiagnosticsPort } = await import(
  "../packages/core/src/runtime/runtime-cache-diagnostics.ts"
);

function createFakeRuntime(overrides = {}) {
  // R1-01 B1：cache 诊断 6 字段已收敛到 RuntimeCacheDiagnosticsOwner——桩也必须经
  // initializeRuntimeCacheDiagnostics 安装只读 getter，写面改经 port。这里先 initialize
  // 再以端口回放 overrides（构造期字段默认与迁移前一致：空聚合/空计数/undefined pending 等）。
  const runtime = {};
  initializeRuntimeCacheDiagnostics(runtime);
  const {
    mainTurnCacheHitAggregate,
    cacheMissCauseCounts,
    pendingCacheMissCause,
    lastRequestModelId,
    lastAssistantCompletedAtMs,
    ...rest
  } = overrides;
  const port = getRuntimeCacheDiagnosticsPort(runtime);
  if (mainTurnCacheHitAggregate) port.resetMainTurnCacheHitAggregate(mainTurnCacheHitAggregate);
  // lastRequestModelId 只能随 recordMainTurnUsage 写入；回放后清掉累计，保持与迁移前
  // 「直接赋值 lastRequestModelId」语义一致（不留 requestCount/cacheMissCauseCounts 痕迹）。
  if (lastRequestModelId !== undefined) {
    port.recordMainTurnUsage({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
      isMiss: false,
      modelId: lastRequestModelId,
    });
    port.resetMainTurnCacheHitAggregate({
      requestCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    });
  }
  if (cacheMissCauseCounts && Object.keys(cacheMissCauseCounts).length > 0) {
    // 逐因回放计数（保持「写面只经 port」不变量）；回放后重置聚合避免污染断言。
    for (const [cause, count] of Object.entries(cacheMissCauseCounts)) {
      for (let i = 0; i < count; i++) {
        port.recordMainTurnUsage({
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          isMiss: true,
          cause,
        });
      }
    }
    port.resetMainTurnCacheHitAggregate(
      mainTurnCacheHitAggregate ?? {
        requestCount: 0,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
      },
    );
  }
  if (lastAssistantCompletedAtMs !== undefined) {
    port.restoreLastAssistantCompletedAtMs(lastAssistantCompletedAtMs);
  }
  // pending 最后回放：避免被上面 recordMainTurnUsage 的「消费即清」抹掉。
  if (pendingCacheMissCause !== undefined) port.setPendingCacheMissCause(pendingCacheMissCause);
  void rest;
  return runtime;
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
  // R1-01 B1：写面只经 port。
  getRuntimeCacheDiagnosticsPort(runtime).setPendingCacheMissCause("conversation_rewind");
  recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  const second = recordMainTurnCacheHitUsage(runtime, MISS_USAGE, "model-a");
  second.missCauses.conversation_rewind = 999;
  assert.equal(runtime.cacheMissCauseCounts.conversation_rewind, 1);
  assert.equal(runtime.cacheMissCauseCounts.unknown, 1);
});

test("闭集纪律：产出的每个因名都在 contracts 因集常量里", () => {
  // 锚点随 2026-10-28 拆分迁移：session.events.ts 已降级为纯桶（导出面逐名不变），
  // 因集闭集常量的权威叶是 session-event-model.ts（「因集唯一家」注释所在地）。
  const contractsSource = read("../packages/contracts/src/events/session-event-model.ts");
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
    // R1-01 B1：写面只经 port（undefined 等价于不设置）。
    if (pending !== undefined) {
      getRuntimeCacheDiagnosticsPort(runtime).setPendingCacheMissCause(pending);
    }
    recordMainTurnCacheHitUsage(runtime, MISS_USAGE, pending ? "model-a" : "model-b");
  }
  for (const cause of Object.keys(runtime.cacheMissCauseCounts)) {
    assert.ok(causes.includes(cause), `产出因 ${cause} 不在闭集内`);
  }
});

test("R4 同批加宽守护：shared 三处 strict 镜像 + services 中继挑取缺一不可", () => {
  // M4a：legacy-types.ts 已整删，acodeSessionContextCacheUsageSchema 随承重面收编进
  // 中立 session-runtime-types 叶（strict 镜像形态逐字未变）。
  const runtimeTypes = read("../../../packages/shared/src/acode-session-runtime-types.ts");
  const runtimeSchema = runtimeTypes.slice(
    runtimeTypes.indexOf("export const acodeSessionContextCacheUsageSchema"),
    runtimeTypes.indexOf(
      ".strict();",
      runtimeTypes.indexOf("export const acodeSessionContextCacheUsageSchema"),
    ),
  );
  assert.ok(runtimeSchema.includes("missCauses"), "v3/v4 客户端校验镜像必须含 missCauses");

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
  // R1-01 B1：写面已收敛到 RuntimeCacheDiagnosticsOwner 端口——守护字符串同步换成端口调用，
  // 不变量本身（事件点写 pending / 重建复位计数与聚合）不变。
  const rewind = read("../packages/core/src/runtime/methods/rewind-message.ts");
  assert.ok(rewind.includes('cachePort.setPendingCacheMissCause("conversation_rewind")'));
  assert.ok(rewind.includes("cachePort.resetCacheMissCauseCounts()"), "rewind 重建必须复位计数");
  assert.ok(rewind.includes("cachePort.resetMainTurnCacheHitAggregate("), "rewind 重建必须重建聚合");
  const resume = read("../packages/core/src/runtime/methods/resume.ts");
  assert.ok(resume.includes("cachePort.resetCacheMissCauseCounts()"), "冷启动重建必须复位计数");
  assert.ok(resume.includes("cachePort.resetMainTurnCacheHitAggregate("), "冷启动重建必须重建聚合");
  assert.ok(resume.includes("cachePort.clearPendingCacheMissCause()"), "冷启动重建必须清 pending");
  const controlOnly = read("../packages/core/src/runtime/methods/control-only-turn.ts");
  assert.ok(controlOnly.includes('.setPendingCacheMissCause("control_only_turn")'));
  const compact = read("../packages/core/src/runtime/methods/compact-active.ts");
  assert.ok(compact.includes('.setPendingCacheMissCause("compaction")'));
  const micro = read("../packages/core/src/runtime/methods/microcompact.ts");
  assert.ok(micro.includes('.setPendingCacheMissCause("compaction")'));
  const refresh = read("../packages/core/src/runtime/methods/context-refresh.ts");
  assert.ok(refresh.includes('.setPendingCacheMissCause("context_refresh")'));
});

test("R6 no-telemetry：归因与 debug 旁路零网络出口（负向断言）", () => {
  for (const rel of [
    "../packages/core/src/runtime/methods/turn-model-step-usage.ts",
    "../packages/bootstrap/src/acode-protocol-v4/session-debug.ts",
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
