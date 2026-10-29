// U11 clientMode 接线链的 CLI/bootstrap 落点钉住（spec:
// apps/acode-cli/specs/tool-media-attachment-ref.md R10.2a）。
//
// 断言分两类（仓库既有惯例，见 tool-search-settings-chain.test.mjs）：
//   - shouldEmitToolMediaRefs 是纯函数，行为直测（门矩阵已在 tool-media-ref-production.test.mjs
//     覆盖 R10.1/R10.2，此处只补「clientMode 从 runtimeConfig 到 context 后门开」的接线闭环）；
//   - bootstrap 物化链（handler → v4-bridge runtimeFlags 侧通道 → server-operations createRecord
//     runtimeConfig）与 runtime-tools 的总闸翻转是模块私有/装配接线，源码断言钉住每一跳还在不在，
//     并特别钉住 clientMode **不进** appRuntimePreferences 进程缓存（每连接属性，防跨会话泄漏）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const { shouldEmitToolMediaRefs } =
  await import("../packages/core/src/tool/executor/tool-media-limits.ts");

// ── 纯函数：门矩阵闭环（clientMode 是每会话判据）──

test("门闭环：总闸 ON + desktop-continuous + store 在场 ⇒ 产 ref", () => {
  assert.equal(
    shouldEmitToolMediaRefs({ enabled: true, clientMode: "desktop-continuous", hasArtifactStore: true }),
    true,
  );
});

test("门闭环：总闸 ON 但 web-remote-replayable / clientMode 缺席 ⇒ 不产 ref（inline）", () => {
  assert.equal(
    shouldEmitToolMediaRefs({ enabled: true, clientMode: "web-remote-replayable", hasArtifactStore: true }),
    false,
  );
  assert.equal(shouldEmitToolMediaRefs({ enabled: true, hasArtifactStore: true }), false);
});

// ── 源码断言：bootstrap 物化链每一跳 ──

test("handler：session-mgmt 把 payload.clientMode 传给 host.createSessionRecord", async () => {
  const sessionMgmt = await read(
    "packages/bootstrap/src/acode-protocol-v4/commands/handlers/session-mgmt.ts",
  );
  assert.match(sessionMgmt, /clientMode: payload\.clientMode,/, "handler 透传 payload.clientMode");
});

test("types：createSessionRecord 参数类型含 clientMode?", async () => {
  const types = await read("packages/bootstrap/src/acode-protocol-v4/commands/types.ts");
  assert.match(types, /clientMode\?: CommandPayloadMap\["createSession"\]\["clientMode"\];/);
});

test("v4-bridge：clientMode 经 runtimeFlags 侧通道下传，且不进 appRuntimePreferences", async () => {
  const v4Bridge = await read("packages/bootstrap/src/acode-protocol-v4/v4-binder.ts");
  assert.match(
    v4Bridge,
    /\}, \{ scriptWorkflowEnabled, toolSearchMode, clientMode \}\);/,
    "clientMode 走第三个参数 runtimeFlags 侧通道（legacy strict params 不收新键）",
  );
  // 关键安全断言：clientMode **不得**被写进进程级兜底缓存（每连接属性，缓存会跨会话泄漏）。
  assert.ok(
    !v4Bridge.includes("appRuntimePreferences.clientMode"),
    "clientMode 绝不进 appRuntimePreferences（与 toolSearchMode 的关键差异，防 desktop 值泄漏给 web 会话）",
  );
});

test("server-operations：三处 runtimeFlags 签名含 clientMode，createRecord 写进 runtimeConfig", async () => {
  const serverOperations = await read("packages/bootstrap/src/acode-protocol-v4/server-operations.ts");
  // 四处 runtimeFlags 内联类型（createSessionRecordForV4 / createSessionWithProjection /
  // materializeSessionRecord / createRecord）都必须含 clientMode。
  const flagSig =
    /runtimeFlags\?: \{ scriptWorkflowEnabled\?: boolean; toolSearchMode\?: ToolSearchAppMode; clientMode\?: ACodeDeliveryKind \}/g;
  const sigCount = [...serverOperations.matchAll(flagSig)].length;
  assert.equal(sigCount, 4, "四处 runtimeFlags 签名都含 clientMode");
  assert.match(
    serverOperations,
    /\.\.\.\(runtimeFlags\?\.clientMode === undefined \? \{\} : \{ clientMode: runtimeFlags\.clientMode \}\)/,
    "createRecord 条件写入 runtimeConfig.clientMode（缺席=不写=fail-closed inline）",
  );
  // clientMode 的折叠只读侧通道，不回退 appRuntimePreferences（与 toolSearchMode 的 ?? 缓存不同）。
  assert.ok(
    !serverOperations.includes("appRuntimePreferences.clientMode"),
    "server-operations 不读 appRuntimePreferences.clientMode（每连接属性，无进程缓存）",
  );
});

test("runtime-config：...options.runtimeConfig 透传 clientMode（无需显式解构）", async () => {
  const runtimeConfig = await read("packages/bootstrap/src/app/runtime-config.ts");
  assert.match(
    runtimeConfig,
    /const runtimeConfig: AgentRuntimeConfig = \{\s*\n\s*\.\.\.options\.runtimeConfig,/,
    "runtimeConfig 以 ...options.runtimeConfig 起手，clientMode 自动透传",
  );
});

test("runtime-tools：nodeReplMediaRefs 总闸显式 ON（R10.1）", async () => {
  const runtimeTools = await read("packages/core/src/runtime/helpers/runtime-tools.ts");
  assert.match(runtimeTools, /nodeReplMediaRefs: true,/, "R10.1 产品 rollout 总闸已 ON");
  // clientMode 判据仍读 runtime.config.clientMode（不新增第二来源）。
  assert.match(
    runtimeTools,
    /clientMode: runtime\.config\.clientMode,/,
    "ToolExecutorDeps.clientMode 仍单源自 runtime.config.clientMode（R10.2 每会话门）",
  );
});
