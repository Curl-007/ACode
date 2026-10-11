// gen-ui（::visualize）与网络观测采集的单元测试。
// 覆盖：引用解析（围栏/智能引号/坏 JSON/上限/非法名）、URL 脱敏、片段 store
// 读写与注册表、观测安装/卸载与记录形状。投影行翻译与 gateway 分块读由
// bootstrap 既有黄金测试族（两 profile 终态一致）与集成层覆盖，这里不重复。

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseVisualizeReferences,
  setActiveVisualizationFragmentStore,
  lookupVisualizationFragment,
} from "../packages/bootstrap/src/acode-protocol-v4/visualization-registry.ts";
import {
  sanitizeObservedUrl,
  installNetworkCaptureObservation,
  uninstallNetworkCaptureObservation,
  isNetworkCaptureObservationActive,
  activeNetworkCaptureId,
  flushNetworkCaptureObservationForTest,
} from "../packages/bootstrap/src/acode-protocol-v4/network-capture-observation.ts";
import { createNodeVisualizationFragmentStore } from "../packages/adapters/src/storage/visualization-fragment-store.ts";
import { ProductProjection } from "../packages/bootstrap/src/acode-protocol-v4/product-projection.ts";
// 与观测模块同一解析产物（@acode/contracts → dist）：ALS 单例必须同源，
// src/dist 混用会得到两个 storage（tests/ 目录解析不了 workspace 包名，直引 dist）。
import { runWithNetworkCapturePhase, recordNetworkCaptureObservation } from "../packages/contracts/dist/network-capture-phase.js";

test("parseVisualizeReferences：基本引用与 wide 模式", () => {
  const text = '前言\n::visualize{"name":"queue-backpressure.html"}\n后记';
  assert.deepEqual(parseVisualizeReferences(text), [{ name: "queue-backpressure.html" }]);
  const wide = parseVisualizeReferences('::visualize{"name":"a-b.html","mode":"wide"}');
  assert.deepEqual(wide, [{ name: "a-b.html", mode: "wide" }]);
  // 非 wide 的 mode 值忽略（只认闭集）。
  const odd = parseVisualizeReferences('::visualize{"name":"a.html","mode":"huge"}');
  assert.deepEqual(odd, [{ name: "a.html" }]);
});

test("parseVisualizeReferences：三冒号与智能引号容错", () => {
  assert.deepEqual(parseVisualizeReferences(':::visualize{"name":"a.html"}'), [{ name: "a.html" }]);
  const smart = parseVisualizeReferences('::visualize{\u201cname\u201d:\u201ca.html\u201d}');
  assert.deepEqual(smart, [{ name: "a.html" }]);
});

test("parseVisualizeReferences：代码围栏内的样例不解析", () => {
  const fenced = [
    "看这个协议样例：",
    "```text",
    '::visualize{"name":"inside-fence.html"}',
    "```",
    '::visualize{"name":"outside.html"}',
  ].join("\n");
  assert.deepEqual(parseVisualizeReferences(fenced), [{ name: "outside.html" }]);
  const tilde = ["~~~", '::visualize{"name":"t.html"}', "~~~"].join("\n");
  assert.deepEqual(parseVisualizeReferences(tilde), []);
});

test("parseVisualizeReferences：坏 JSON 与非法名降级为不产出", () => {
  assert.deepEqual(parseVisualizeReferences("::visualize{name:a.html}"), []);
  assert.deepEqual(parseVisualizeReferences('::visualize{"name":"UPPER.html"}'), []);
  assert.deepEqual(parseVisualizeReferences('::visualize{"name":"../escape.html"}'), []);
  assert.deepEqual(parseVisualizeReferences('::visualize{"name":123}'), []);
  assert.deepEqual(parseVisualizeReferences("::visualize"), []);
});

test("parseVisualizeReferences：每轮至多 8 条", () => {
  const many = Array.from({ length: 12 }, (_, i) => `::visualize{"name":"v${i}.html"}`).join("\n");
  assert.equal(parseVisualizeReferences(many).length, 8);
});

test("sanitizeObservedUrl：剥 userinfo、query 值脱敏、非法 URL 截断", () => {
  const sanitized = sanitizeObservedUrl(
    "https://user:secret@api.example.com/v1/chat?token=abc123&model=glm",
  );
  const url = new URL(sanitized);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.searchParams.get("token"), "<redacted>");
  assert.equal(url.searchParams.get("model"), "<redacted>");
  assert.ok(!sanitized.includes("secret"));
  assert.ok(!sanitized.includes("abc123"));
  assert.equal(sanitizeObservedUrl("not a url".repeat(300)).length, 2048);
});

test("片段 store：写入/读取/注册表/同名覆盖/冷重建", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "acode-viz-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createNodeVisualizationFragmentStore({ rootDir });

  const written = await store.writeVisualizationFragment({
    sessionId: "sess-1",
    name: "chart.html",
    content: "<div>hi</div>",
    title: "图表",
  });
  assert.equal(written.bytes, Buffer.byteLength("<div>hi</div>"));
  const meta = store.lookupVisualizationFragment("sess-1", "chart.html");
  assert.ok(meta);
  assert.equal(meta.displayName, "图表");
  assert.equal(meta.sha256.length, 64);

  const bytes = await store.readVisualizationFragment({ sessionId: "sess-1", name: "chart.html" });
  assert.equal(Buffer.from(bytes).toString("utf8"), "<div>hi</div>");

  // 同名覆盖 = 更新（注册表整体替换）。
  await store.writeVisualizationFragment({ sessionId: "sess-1", name: "chart.html", content: "<p>v2</p>" });
  assert.equal(store.lookupVisualizationFragment("sess-1", "chart.html")?.displayName, undefined);

  // 未知 name / 未知会话：读回 undefined，不抛。
  assert.equal(await store.readVisualizationFragment({ sessionId: "sess-1", name: "nope.html" }), undefined);
  assert.equal(store.lookupVisualizationFragment("sess-2", "chart.html"), undefined);

  // 非法 name 绝不进路径。
  await assert.rejects(
    store.writeVisualizationFragment({ sessionId: "sess-1", name: "../evil.html", content: "x" }),
    /Invalid visualization fragment name/,
  );

  // 冷重建：新 store 实例从磁盘回填（displayName 不可恢复）。
  const fresh = createNodeVisualizationFragmentStore({ rootDir });
  assert.equal(fresh.lookupVisualizationFragment("sess-1", "chart.html"), undefined);
  await fresh.rebuildVisualizationFragments("sess-1");
  const rebuilt = fresh.lookupVisualizationFragment("sess-1", "chart.html");
  assert.ok(rebuilt);
  assert.equal(rebuilt.bytes, Buffer.byteLength("<p>v2</p>"));
  assert.equal(rebuilt.displayName, undefined);

  // 重建只收 .html 且名字合法的条目。
  await writeFile(join(rootDir, "sess-1", "visualize", "notes.txt"), "ignore me");
  await fresh.rebuildVisualizationFragments("sess-1");
  assert.equal(fresh.lookupVisualizationFragment("sess-1", "notes.txt"), undefined);
  const entries = await readdir(join(rootDir, "sess-1", "visualize"));
  assert.ok(entries.includes("chart.html"));
});

test("注册表模块级绑定：set/lookup/清空", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "acode-viz-reg-"));
  t.after(() => {
    setActiveVisualizationFragmentStore(null);
    void rm(rootDir, { recursive: true, force: true });
  });
  const store = createNodeVisualizationFragmentStore({ rootDir });
  setActiveVisualizationFragmentStore(store);
  await store.writeVisualizationFragment({ sessionId: "s", name: "a.html", content: "<i/>" });
  assert.ok(lookupVisualizationFragment("s", "a.html"));
  setActiveVisualizationFragmentStore(null);
  assert.equal(lookupVisualizationFragment("s", "a.html"), undefined);
});

test("网络观测：安装/卸载、记录形状、相位归属", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    uninstallNetworkCaptureObservation();
    globalThis.fetch = originalFetch;
  });
  // 安装前放好假 fetch：observedFetch 包装的是安装时刻的 globalThis.fetch。
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  const emitted = [];
  installNetworkCaptureObservation({
    captureId: "cap-1",
    emit: (records) => emitted.push(...records),
  });
  assert.equal(isNetworkCaptureObservationActive(), true);
  assert.equal(activeNetworkCaptureId(), "cap-1");

  await globalThis.fetch("https://api.example.com/v1?token=secret");
  const tagged = await runWithNetworkCapturePhase("webfetch", () =>
    globalThis.fetch("https://example.org/page"),
  );
  assert.ok(tagged);

  flushNetworkCaptureObservationForTest();
  uninstallNetworkCaptureObservation();
  assert.equal(isNetworkCaptureObservationActive(), false);

  assert.equal(emitted.length, 2);
  const [first, second] = emitted;
  assert.equal(first.method, "GET");
  assert.equal(first.status, 200);
  assert.equal(first.phase, "other");
  assert.ok(first.url.includes("token=%3Credacted%3E") || first.url.includes("token=<redacted>"));
  assert.ok(!first.url.includes("secret"));
  assert.equal(second.phase, "webfetch");
  assert.ok(typeof first.startedAt === "number" && first.durationMs >= 0);
});

test("网络观测：adapters 自定义传输补记 sink（绕过 global fetch 的路径）", async (t) => {
  t.after(() => uninstallNetworkCaptureObservation());
  const emitted = [];
  installNetworkCaptureObservation({ captureId: "cap-sink", emit: (records) => emitted.push(...records) });
  // 模拟 adapters 分支点补记：不经 global fetch，经 contracts sink 直入环形缓冲。
  await runWithNetworkCapturePhase("webfetch", async () => {
    recordNetworkCaptureObservation({
      method: "GET",
      url: "https://example.com/?token=supersecret42&user=alice",
      status: 200,
      startedAt: Date.now(),
      durationMs: 12,
    });
  });
  flushNetworkCaptureObservationForTest();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].phase, "webfetch");
  assert.ok(!emitted[0].url.includes("supersecret42"));
  assert.ok(emitted[0].url.includes("token=%3Credacted%3E") || emitted[0].url.includes("token=<redacted>"));
  // 卸载后 sink 缺席：no-op 且不抛。
  uninstallNetworkCaptureObservation();
  recordNetworkCaptureObservation({ method: "GET", url: "https://x.test/", status: 200, startedAt: Date.now(), durationMs: 1 });
  assert.equal(emitted.length, 1);
});

test("网络观测：关闭后 fetch 还原、缓冲清空", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    uninstallNetworkCaptureObservation();
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("x", { status: 204 });
  installNetworkCaptureObservation({ captureId: "cap-3", emit: () => {} });
  const wrapped = globalThis.fetch;
  uninstallNetworkCaptureObservation();
  assert.notEqual(globalThis.fetch, wrapped);
  assert.equal(activeNetworkCaptureId(), null);
});

// ── 投影三收口确定性测试（specs/gen-ui-visualize.md「验证基建」第 1 层）──
// 钉住 2026-10-11 收口点修复：指令按技能契约在最终回复里，而最终回复的收口路径
// 因 runtime 而异（text_end / 新段顶替 / turn 终态），三条路都必须产出 artifactRow。
const PROJ_SID = "sess-proj-close-sites";
let projSeq = 0;
const projEvent = (type, payload) => ({
  id: `ev-${++projSeq}`,
  sessionId: PROJ_SID,
  type,
  timestamp: new Date(),
  traceId: "trace-proj",
  sequenceNumber: projSeq,
  payload,
});

async function projectionWithRegisteredFragment(t) {
  const dir = await mkdtemp(join(tmpdir(), "acode-viz-proj-"));
  t.after(async () => {
    setActiveVisualizationFragmentStore(null);
    await rm(dir, { recursive: true, force: true });
  });
  const store = createNodeVisualizationFragmentStore({ rootDir: dir });
  await store.writeVisualizationFragment({
    sessionId: PROJ_SID,
    name: "x.html",
    content: '<div id="root">hi</div>',
  });
  setActiveVisualizationFragmentStore(store);
  return new ProductProjection(PROJ_SID, "epoch-proj");
}

function openTurnWithDirective(projection) {
  const deltas = [];
  deltas.push(...projection.applyEvent(projEvent("turn_started", { turnId: "turn-1", transcriptMessageId: "user-1" })));
  deltas.push(...projection.applyEvent(projEvent("model_streaming", { kind: "text_start", assistantMessageId: "msg-1" })));
  deltas.push(
    ...projection.applyEvent(
      projEvent("model_streaming", { kind: "text_delta", delta: '正文\n::visualize{"name":"x.html"}', assistantMessageId: "msg-1" }),
    ),
  );
  return deltas;
}

function artifactRefs(deltas) {
  return deltas
    .filter((d) => d.op === "row.appended" && d.row?.kind === "artifact")
    .map((d) => d.row.ref);
}

test("投影收口：text_end 路径产出可视化 artifactRow", async (t) => {
  const projection = await projectionWithRegisteredFragment(t);
  openTurnWithDirective(projection);
  const closed = projection.applyEvent(projEvent("model_streaming", { kind: "text_end", assistantMessageId: "msg-1" }));
  assert.deepEqual(artifactRefs(closed), [`acode-visualization://${PROJ_SID}/x.html`]);
});

test("投影收口：新 text 段顶替旧行路径产出 artifactRow", async (t) => {
  const projection = await projectionWithRegisteredFragment(t);
  openTurnWithDirective(projection);
  const second = projection.applyEvent(projEvent("model_streaming", { kind: "text_start", assistantMessageId: "msg-2" }));
  assert.deepEqual(artifactRefs(second), [`acode-visualization://${PROJ_SID}/x.html`]);
});

test("投影收口：turn 终态 closeStreamingRows 路径产出 artifactRow", async (t) => {
  const projection = await projectionWithRegisteredFragment(t);
  openTurnWithDirective(projection);
  const settled = projection.applyEvent(projEvent("turn_complete", { resultType: "success" }));
  assert.deepEqual(artifactRefs(settled), [`acode-visualization://${PROJ_SID}/x.html`]);
});

test("投影收口：未注册名不产 row（降级可见纪律不变）", async (t) => {
  const projection = await projectionWithRegisteredFragment(t);
  projection.applyEvent(projEvent("turn_started", { turnId: "turn-1", transcriptMessageId: "user-1" }));
  projection.applyEvent(projEvent("model_streaming", { kind: "text_start", assistantMessageId: "msg-1" }));
  const deltas = projection.applyEvent(
    projEvent("model_streaming", { kind: "text_delta", delta: '::visualize{"name":"never-written.html"}', assistantMessageId: "msg-1" }),
  );
  const closed = projection.applyEvent(projEvent("model_streaming", { kind: "text_end", assistantMessageId: "msg-1" }));
  assert.deepEqual(artifactRefs([...deltas, ...closed]), []);
});
