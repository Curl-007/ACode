/**
 * A3 逻辑面测试（specs/windows-helper-producer.md §16.2；CI 常驻，ubuntu 必跑）——
 * 全部经 fake driver（a2-fake + a3-fake），零真实副作用、零子进程。
 *
 * 覆盖：树文本渲染（§11.4）、state 注册表 LRU/覆盖释放（§11.5）、app_ref 全形态与
 * 唯一候选纪律（§11.3/AC-5）、六工具 wire 形态（§11.2/AC-2）、预算截断一致性（AC-3）、
 * 索引稳定性（AC-4）、element 指针路径（§11.2）、_meta targetApp 契约（AC-7，深导入
 * contracts schema）、broker_info capabilities 全量 ⟺（§13 不变量②/AC-10）、观察类
 * admission 与错误映射、uia-driver 毒化监督（AC-1 JS 面）、统一 preflight 门。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEAD_PID,
  FAKE_EXE_PATH,
  TEST_PID,
  countCalls,
  createFakeCaptureResult,
  createFakeDriver,
} from "./cua-producer-a2-fake.mjs";
import {
  NativeRejectedError,
  OTHER_EXE_PATH,
  OTHER_PID,
  PACKAGED_AUMID,
  countUiaCalls,
  createFakeUiaDriver,
  fakeElements,
  importProducerModule,
  lastUiaCall,
} from "./cua-producer-a3-fake.mjs";

const { createBackendA2 } = await importProducerModule("backend-a2");
const { createBackendA3, createElementActionSurface } = await importProducerModule("backend-a3");
const { createAppRefResolver } = await importProducerModule("app-ref");
const { createStateRegistry } = await importProducerModule("state-registry");
const { createInputSession } = await importProducerModule("input-session");
const { createFrameRegistry, appOwnerScope } = await importProducerModule("frame-registry");
const { createWireDispatcher, WIRE_ERROR_MESSAGES, WIRE_METHOD_NAMES, BROKER_INFO_METHOD } =
  await importProducerModule("wire-server");
const { RECEIPT_MESSAGES, CUA_TARGET_APP_DISPLAY_META_KEY } =
  await importProducerModule("receipts");
const { renderTreeText, identityToken, exeBasename, elementLine } =
  await importProducerModule("tree-text");
const { createUiaDriver, UIA_EXPORTS } = await importProducerModule("uia-driver");
const { TREE_MAX_ELEMENTS, TREE_MAX_TEXT_BYTES } = await importProducerModule("driver-contract");

// contracts 深导入（AC-7：_meta 形状过宿主 strict schema；先例 = a2 批次对 services TS
// 的守卫后深导入，oQ5 实证）。
const here = dirname(fileURLToPath(import.meta.url));
const contractsMeta = await import(
  pathToFileURL(
    join(resolve(here, "..", "..", ".."), "apps", "acode-cli", "packages", "contracts", "src", "tools", "tool-result-metadata.ts"),
  ).href
);

// ── 公共夹具 ─────────────────────────────────────────────────────────────────

function makeContext(options = {}) {
  const driver = createFakeDriver({
    ...options.driver,
    behaviors: {
      // A3 起 captureWindow 是真实现（A2 fake 缺省是诚实桩语义）；a3 组合面缺省成功。
      captureWindow: async () => createFakeCaptureResult(),
      ...options.driver?.behaviors,
    },
  });
  const uia = createFakeUiaDriver(options.uia);
  const session = createInputSession(driver, options.session);
  const frames = createFrameRegistry();
  const states = createStateRegistry({
    generation: 7,
    release: (token) => {
      void uia.releaseState(token);
    },
    ...options.states,
  });
  const resolveAppRef = createAppRefResolver({ driver, uia });
  const elements = uia.presence
    ? createElementActionSurface({ uia, states })
    : undefined;
  const a2 = createBackendA2({
    driver,
    session,
    frames,
    ...(elements ? { elements } : {}),
    ...(uia.presence ? { resolveAppRef } : {}),
    uiaPresence: uia.presence,
  });
  const a3 = createBackendA3({
    driver,
    uia,
    session,
    frames,
    states,
    resolveAppRef,
    a2BrokerInfo: a2[BROKER_INFO_METHOD],
  });
  const backend = { ...a2, ...a3 };
  const dispatcher = createWireDispatcher();
  dispatcher.activate(backend);
  return { driver, uia, session, frames, states, backend, dispatcher, a2, a3 };
}

function wire(dispatcher, method, params) {
  const request = params === undefined ? { method } : { method, params };
  return dispatcher.handleRequestLine(JSON.stringify(request));
}

function assertWireError(response, code, message, label) {
  assert.deepEqual(response, { ok: false, error: { message, code } }, label);
}

function receiptOf(response, label) {
  assert.equal(response.ok, true, `${label ?? "receipt"}: 必须 ok:true`);
  const result = response.result;
  const textBlock = result.content.find((block) => block.type === "text");
  assert.ok(textBlock, `${label}: 必须有文本块`);
  const parsed = JSON.parse(textBlock.text);
  assert.deepEqual(parsed, result.structuredContent, `${label}: 文本块 JSON 与 structuredContent 同键`);
  return result.structuredContent;
}

const pidRef = { pid: TEST_PID };

// ── 组 1：树文本渲染（§11.4，纯函数）─────────────────────────────────────────

test("树文本|行格式 = 缩进×2 + [index] role name[ = value][ (patterns)]（§11.4 钉死格式）", () => {
  const line = elementLine({
    index: 5, depth: 2, role: "edit", name: "Document",
    value: "hello", valueLength: 5,
    bounds: null, patterns: ["editable", "focusable"],
  });
  assert.equal(line, "    [5] edit Document = hello (editable, focusable)");
  const bare = elementLine({ index: 0, depth: 0, role: "window", name: "Root", value: null, valueLength: 0, bounds: null, patterns: [] });
  assert.equal(bare, "[0] window Root");
});

test("树文本|value 单行化 + 200 code units 截断加省略号（§11.4 隐私+预算）", () => {
  const long = `${"x".repeat(250)}`;
  const line = elementLine({ index: 1, depth: 0, role: "edit", name: "n", value: `a\r\nb${long}`, valueLength: 253, bounds: null, patterns: [] });
  assert.ok(!line.includes("\r") && !line.includes("\n"), "换行/回车 → 空格（单行化）");
  assert.ok(line.includes(`${"x".repeat(198)}…`) || line.includes("…"), "截断加 …");
  const valuePart = line.split(" = ")[1];
  assert.ok(valuePart.length <= 201, "value ≤200 code units + 省略号");
});

test("树文本|头部两行 + identity-token 净化 + 截断注记固定形态（§11.4）", () => {
  const text = renderTreeText({
    header: {
      aumid: PACKAGED_AUMID, exePath: FAKE_EXE_PATH, pid: TEST_PID,
      displayName: null, windowId: 42, windowTitle: "Some Title",
    },
    elements: fakeElements(2),
    truncated: true,
    totalElements: 5000,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], `app: ${PACKAGED_AUMID.replace(/[^A-Za-z0-9.-]/g, "-")} pid=${TEST_PID} "target-app.exe"`);
  assert.equal(lines[1], 'window: [42] "Some Title"');
  assert.match(lines[2], /^\[0\] /);
  assert.equal(lines[lines.length - 1], "[tree truncated: showing first 2 of 5000 elements]");
  // 无 AUMID → exe basename 净化 token；identityToken 净化仅展示（权威在 structuredContent）。
  assert.equal(identityToken(null, "C:\\fake\\target-app.exe"), "target-app.exe");
  assert.equal(identityToken(null, "C:\\fake\\my app!.exe"), "my-app-.exe");
  assert.equal(exeBasename("C:\\a\\b\\c.exe"), "c.exe");
});

// ── 组 2：state 注册表（§11.5）───────────────────────────────────────────────

test("state 注册表|覆盖释放旧冻结域 + scope LRU ≤16 + scope 数 ≤8（§11.5 内存有界）", () => {
  const released = [];
  const states = createStateRegistry({ generation: 3, release: (token) => released.push(token) });
  const first = states.register({ pid: TEST_PID, nativeStateToken: 11, windowId: 1, elementCount: 2, treeShownToModel: false });
  assert.equal(first.stateId, "st-3-1");
  states.register({ pid: TEST_PID, nativeStateToken: 12, windowId: 1, elementCount: 2, treeShownToModel: true });
  assert.deepEqual(released, [11], "新观察覆盖 → 旧冻结域立即释放（跨观察索引兼容被结构性排除）");
  assert.equal(states.latestForPid(TEST_PID).nativeStateToken, 12);
  // scope 内 16 上限：再注册 15 次（共 17）→ 最旧 2 条元数据被逐出（不再释放——覆盖时已释放）。
  for (let i = 13; i <= 28; i += 1) {
    states.register({ pid: TEST_PID, nativeStateToken: i, windowId: 1, elementCount: 1, treeShownToModel: false });
  }
  assert.ok(states.size <= 16, `scope 内 ≤16（实际 ${states.size}）`);
  // scope 数 8 上限：第 9 个 scope 挤掉最旧 scope 并释放其最新冻结域。
  const before = released.length;
  for (let pid = 100; pid <= 108; pid += 1) {
    states.register({ pid, nativeStateToken: 1000 + pid, windowId: 1, elementCount: 1, treeShownToModel: false });
  }
  assert.ok(states.scopeCount <= 8, `scope ≤8（实际 ${states.scopeCount}）`);
  assert.ok(released.length > before, "scope 逐出释放其最新冻结域");
  assert.equal(states.latestForPid(TEST_PID), undefined, "被逐出 scope 不可解析（→ element_unavailable）");
});

// ── 组 3：app_ref 全形态（AC-5，§11.3）───────────────────────────────────────

test("app_ref|pid-only 存活解析 + 死亡 → not running 字面量（含 SDK isAppNotFound 兼容子串）", async () => {
  const { dispatcher } = makeContext();
  const ok = await wire(dispatcher, "list_windows", { app_ref: pidRef });
  assert.equal(ok.ok, true);
  const dead = await wire(dispatcher, "list_windows", { app_ref: { pid: DEAD_PID } });
  assertWireError(dead, "invalid_request", WIRE_ERROR_MESSAGES.appNotRunning, "pid 死亡");
  assert.ok(WIRE_ERROR_MESSAGES.appNotRunning.includes("target app is not running"), "SDK 兼容子串（两侧同审纪律）");
});

test("app_ref|name 形态：basename 大小写不敏感命中；0 候选 not running；≥2 候选 pass-a-pid（绝不猜 active/第一个）", async () => {
  const { dispatcher } = makeContext({
    uia: {
      apps: [
        { pid: TEST_PID, exePath: FAKE_EXE_PATH, aumid: null, displayName: null, windowCount: 1, active: false },
        { pid: OTHER_PID, exePath: OTHER_EXE_PATH, aumid: null, displayName: null, windowCount: 1, active: true },
        { pid: 6000, exePath: "C:\\fake\\TARGET-APP.exe", aumid: null, displayName: null, windowCount: 1, active: false },
      ],
    },
  });
  const unique = await wire(dispatcher, "list_windows", { app_ref: { name: "other-app.exe" } });
  assert.equal(unique.ok, true, "basename 大小写不敏感唯一命中");
  const zero = await wire(dispatcher, "list_windows", { app_ref: { name: "no-such-app" } });
  assertWireError(zero, "invalid_request", WIRE_ERROR_MESSAGES.appNotRunning, "0 候选");
  const dup = await wire(dispatcher, "list_windows", { app_ref: { name: "target-app.exe" } });
  assertWireError(dup, "invalid_request", WIRE_ERROR_MESSAGES.appRefMultiple, "≥2 候选 → pass a pid，绝不猜 active");
});

test("app_ref|bundle_id 形态：AUMID 精确匹配优先；canonical exe 路径大小写不敏感 + 分隔符归一", async () => {
  const { dispatcher } = makeContext();
  const byAumid = await wire(dispatcher, "list_windows", { app_ref: { bundle_id: PACKAGED_AUMID } });
  assert.equal(byAumid.ok, true, "AUMID 精确命中");
  const byPath = await wire(dispatcher, "list_windows", { app_ref: { bundle_id: "c:/fake/target-app.exe" } });
  assert.equal(byPath.ok, true, "exe 全路径匹配（大小写不敏感 + / 归一为 \\，NTFS 语义）");
});

test("app_ref|组合形态：一致合并展示字段；冲突 → pass-a-pid 字面量（绝不择一）", async () => {
  const { dispatcher } = makeContext({ driver: { alivePids: new Set([TEST_PID, OTHER_PID]) } });
  const consistent = await wire(dispatcher, "get_app_state", {
    app_ref: { pid: OTHER_PID, bundle_id: PACKAGED_AUMID },
  });
  assert.equal(consistent.ok, true, "pid 与 bundle_id 解析一致");
  assert.equal(consistent.result.structuredContent.app.bundle_id, PACKAGED_AUMID, "合并枚举面的 aumid 展示字段");
  const conflict = await wire(dispatcher, "list_windows", {
    app_ref: { pid: TEST_PID, bundle_id: PACKAGED_AUMID },
  });
  assertWireError(conflict, "invalid_request", WIRE_ERROR_MESSAGES.appRefMultiple, "冲突 → invalid_request");
});

test("app_ref|结构校验：未知键/空对象/类型不符 → invalid_request 封闭字面量", async () => {
  const { dispatcher } = makeContext();
  for (const bad of [{}, { evil: 1 }, { pid: 0 }, { pid: "4242" }, { name: "" }, { pid: TEST_PID, evil: true }]) {
    const response = await wire(dispatcher, "list_windows", { app_ref: bad });
    assertWireError(response, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, `结构拒绝 ${JSON.stringify(bad)}`);
  }
});

// ── 组 4：六工具 wire 形态（AC-2）────────────────────────────────────────────

test("list_apps|字段齐套 snake_case + pid 升序 + 只读零 delivery-state 键 + params 封闭集 {}", async () => {
  const { dispatcher } = makeContext();
  const response = await wire(dispatcher, "list_apps", {});
  assert.equal(response.ok, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.deepEqual(payload, response.result.structuredContent, "双载体同构");
  const pids = payload.apps.map((app) => app.pid);
  assert.deepEqual(pids, [...pids].sort((a, b) => a - b), "pid 升序（确定性）");
  for (const app of payload.apps) {
    assert.deepEqual(Object.keys(app).sort(), ["active", "bundle_id", "exe_path", "name", "pid", "window_count"]);
  }
  assert.equal("action_sent" in response.result.structuredContent, false, "只读铁律 3：零 delivery-state 键");
  assert.equal("dispatch_status" in response.result.structuredContent, false);
  assertWireError(await wire(dispatcher, "list_apps", { evil: 1 }), "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "params 封闭集 {}");
});

test("get_app_state|四必备字段恒在 + 树文本行格式 + snapshot_mode full + _meta 键（appStateOf 消费面）", async () => {
  const { dispatcher } = makeContext();
  const response = await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  assert.equal(response.ok, true);
  const sc = response.result.structuredContent;
  for (const key of ["state_id", "app", "window", "elements"]) {
    assert.ok(key in sc, `appStateOf 必备字段 ${key} 恒在（缺失 → SDK STRUCTURED_STATE_UNAVAILABLE）`);
  }
  assert.equal(sc.snapshot_mode, "full");
  assert.equal(sc.app.pid, TEST_PID);
  assert.equal(sc.app.name, "target-app.exe", "name = exe basename（displayName null 时）");
  assert.equal(sc.truncated, false);
  const treeTextBlock = response.result.content[0];
  assert.equal(treeTextBlock.type, "text");
  assert.equal(sc.text, treeTextBlock.text, "structuredContent.text 与首文本块同文");
  const elementLines = treeTextBlock.text.split("\n").filter((line) => /^\s*\[[0-9]+\]/.test(line));
  assert.equal(elementLines.length, sc.elements.length, "文本可见行 ⇔ elements 数组同集合");
  assert.ok(Object.keys(response.result._meta ?? {}).includes(CUA_TARGET_APP_DISPLAY_META_KEY), "_meta targetApp 键");
});

test("get_app_state|window 为 null → noObservableWindow 专属字面量（与 not running 分开，§11.2）", async () => {
  const { dispatcher } = makeContext({ uia: { tree: { elements: [], truncated: false, totalElements: 0, window: null } } });
  const response = await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(response, "element_unavailable", WIRE_ERROR_MESSAGES.noObservableWindow, "进程存活但无可观察窗口");
});

test("get_app_state|C09 红线：elements:[] 只在真实 0 元素成功时出现；native 失败绝不读成空树", async () => {
  // 真实 0 元素成功：ok:true + elements:[]（truncated=false）。
  const empty = makeContext({ uia: { tree: { elements: [], truncated: false, totalElements: 0, window: { windowId: 9, title: "T", bounds: { x: 0, y: 0, width: 10, height: 10 } } } } });
  const emptyResponse = await wire(empty.dispatcher, "get_app_state", { app_ref: pidRef });
  assert.equal(emptyResponse.ok, true);
  assert.deepEqual(emptyResponse.result.structuredContent.elements, [], "诚实空树（遍历成功且 0 可及元素）");
  // native 失败（超时）：error 面（timeout），结构上不存在「失败读成空树」路径。
  const failing = makeContext({
    uia: { behaviors: { captureUiTree: async () => { throw new NativeRejectedError("uia_timeout"); } } },
  });
  const failResponse = await wire(failing.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(failResponse, "timeout", WIRE_ERROR_MESSAGES.operationTimeout, "失败 = error 面（重试安全）");
  assert.equal("result" in failResponse, false, "失败响应无 result 键——绝无空树成功形态");
});

test("get_app_state|截图成功：image 块 + frame_id 登记；失败降级为告知块不拖垮树（§11.2）", async () => {
  const okCtx = makeContext();
  const shot = await wire(okCtx.dispatcher, "get_app_state", { app_ref: pidRef, include_screenshot: true });
  assert.equal(shot.ok, true);
  const imageBlock = shot.result.content.find((block) => block.type === "image");
  assert.ok(imageBlock, "image 块在场");
  assert.ok(["image/png", "image/jpeg"].includes(imageBlock.mimeType));
  assert.ok(typeof shot.result.structuredContent.frame_id === "string" && shot.result.structuredContent.frame_id.length > 0, "frame_id 恒登记并回报");
  assert.ok(okCtx.frames.latestForScope(appOwnerScope(TEST_PID)), "frame 注册表登记（坐标 target 自此可解析）");
  // 截图失败（最小化）：树照常 + [screenshot unavailable: capture_minimized] + non_actionable_reason。
  const degraded = makeContext({
    driver: { behaviors: { captureWindow: async () => { throw new NativeRejectedError("capture_minimized"); } } },
  });
  const response = await wire(degraded.dispatcher, "get_app_state", { app_ref: pidRef, include_screenshot: true });
  assert.equal(response.ok, true, "截图失败不拖垮树");
  const notice = response.result.content.find((block) => block.type === "text" && block.text.startsWith("[screenshot unavailable:"));
  assert.equal(notice.text, "[screenshot unavailable: capture_minimized]", "固定原因码（封闭词汇，零用户内容）");
  assert.equal(response.result.structuredContent.non_actionable_reason, "capture_minimized");
  assert.equal(response.result.content[0].type, "text", "树文本块仍在首位");
});

test("get_app_state|window_id 失效 → element_unavailable，绝不回退最前窗口（§11.2 fail-closed）", async () => {
  const { dispatcher, uia } = makeContext({
    uia: { behaviors: { captureUiTree: async (target) => {
      if (target.windowId === 999) throw new NativeRejectedError("stale");
      return { stateToken: 1, window: { windowId: 1, title: "T", bounds: { x: 0, y: 0, width: 1, height: 1 } }, elements: [], truncated: false, totalElements: 0 };
    } } },
  });
  const response = await wire(dispatcher, "get_app_state", { app_ref: { pid: TEST_PID, window_id: 999 } });
  assertWireError(response, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "失效 token → stale 字面量");
  assert.equal(countUiaCalls(uia, "captureUiTree"), 1, "绝无第二次「回退最前窗口」调用");
});

// ── 组 5：截断一致性（AC-3）──────────────────────────────────────────────────

test("截断|注记固定形态 + elements 与文本行同集合 + 越界 index 不可解析（§11.4 不变量）", async () => {
  const elements = fakeElements(TREE_MAX_ELEMENTS);
  const { dispatcher } = makeContext({
    uia: { tree: { elements, truncated: true, totalElements: 5000, window: { windowId: 1, title: "T", bounds: { x: 0, y: 0, width: 10, height: 10 } } } },
  });
  const response = await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const sc = response.result.structuredContent;
  assert.equal(sc.truncated, true);
  assert.equal(sc.elements.length, TREE_MAX_ELEMENTS);
  const text = sc.text;
  assert.ok(text.endsWith(`[tree truncated: showing first ${TREE_MAX_ELEMENTS} of 5000 elements]`), "末行固定注记（M 如实）");
  const visible = text.split("\n").filter((line) => /^\s*\[[0-9]+\]/.test(line));
  assert.equal(visible.length, sc.elements.length, "文本可见 index ⇔ elements 同集合");
  // 截断内 index 可解析；截断外 index（数值存在于「总量」但不在冻结域）→ element_unavailable。
  const insideOk = await wire(dispatcher, "perform_action", { target: { type: "element", index: TREE_MAX_ELEMENTS - 1 }, app_ref: pidRef, action: "focus" });
  assert.equal(insideOk.ok, true, "截断内 index 可动作");
  const outside = await wire(dispatcher, "perform_action", { target: { type: "element", index: TREE_MAX_ELEMENTS }, app_ref: pidRef, action: "focus" });
  assertWireError(outside, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "截断外 index 模型引用不到");
  assert.ok(TREE_MAX_TEXT_BYTES === 256 * 1024, "预算常量与 §11.4 钉死值一致");
});

// ── 组 6：索引稳定性（AC-4）──────────────────────────────────────────────────

test("索引稳定性|新观察覆盖 → 动作用最新 token + 旧冻结域释放（跨观察索引兼容被结构性排除）", async () => {
  const { dispatcher, uia } = makeContext();
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const firstToken = uia.state.nextStateToken;  // fake 在 captureUiTree 后停在该 token
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const secondToken = uia.state.nextStateToken;
  assert.notEqual(firstToken, secondToken, "state token 单调不复用");
  await wire(dispatcher, "perform_action", { target: { type: "element", index: 0 }, app_ref: pidRef, action: "focus" });
  const used = lastUiaCall(uia, "elementPerformAction");
  assert.equal(used.args[0], secondToken, "动作按「该 app scope 最新一次观察」解析（§11.4）");
  assert.ok(uia.state.released.includes(firstToken), "覆盖时旧冻结域已通知释放");
  // 无观察的 scope（存活但从未 get_app_state）：element target → stale 字面量
  //（fail-closed，绝无隐式观察）。
  const fresh = makeContext();
  const unobserved = await wire(fresh.dispatcher, "set_value", { target: { type: "element", index: 0 }, app_ref: pidRef, value: "x" });
  assertWireError(unobserved, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "未观察 scope");
});

// ── 组 7：变更类三工具（set_value/select_text/perform_action）────────────────

test("set_value|happy accepted 两键 + _meta；读回不符 → isError internal 收据（写已发生，禁 ok:false）", async () => {
  const { dispatcher } = makeContext();
  const observation = await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  assert.equal(observation.ok, true);
  const ok = await wire(dispatcher, "set_value", { target: { type: "element", index: 1 }, app_ref: pidRef, value: "new" });
  const receipt = receiptOf(ok, "set_value accepted");
  assert.deepEqual(
    Object.keys(receipt).filter((k) => k !== "action_sent" && k !== "dispatch_status"),
    [],
    "成功收据最小形态恰两键（§10.12.1）",
  );
  assert.ok(ok.result._meta[CUA_TARGET_APP_DISPLAY_META_KEY], "app-scoped 动作收据附 _meta（§11.6）");
  // 读回验证不符：verified=false → isError + code internal + action_sent:true + 专属字面量。
  const mismatchCtx = makeContext({ uia: { behaviors: { elementSetValue: async () => ({ verified: false }) } } });
  await wire(mismatchCtx.dispatcher, "get_app_state", { app_ref: pidRef });
  const bad = await wire(mismatchCtx.dispatcher, "set_value", { target: { type: "element", index: 1 }, app_ref: pidRef, value: "v" });
  const badReceipt = receiptOf(bad, "set_value mismatch");
  assert.equal(bad.result.isError, true);
  assert.equal(badReceipt.dispatch_status, "accepted");
  assert.equal(badReceipt.action_sent, true);
  assert.equal(badReceipt.code, "internal");
  assert.equal(badReceipt.message, RECEIPT_MESSAGES.setValueReadbackMismatch, "读回不符专属字面量（零插值）");
});

test("set_value|参数面：坐标 target/超 8Mi/未知键 → invalid_request；not_settable → 同码 ok:false", async () => {
  const { dispatcher } = makeContext();
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(dispatcher, "set_value", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: pidRef, value: "v" }),
    "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "set_value 无坐标语义（§11.2）",
  );
  assertWireError(
    await wire(dispatcher, "set_value", { target: { type: "element", index: 1 }, app_ref: pidRef, value: "x".repeat(8 * 1024 * 1024 + 1) }),
    "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "value ≤8Mi",
  );
  assertWireError(
    await wire(dispatcher, "set_value", { target: { type: "element", index: 1 }, app_ref: pidRef, value: "v", evil: 1 }),
    "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "未知键拒绝",
  );
  const notSettable = makeContext({ uia: { behaviors: { elementSetValue: async () => { throw new NativeRejectedError("not_settable"); } } } });
  await wire(notSettable.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(notSettable.dispatcher, "set_value", { target: { type: "element", index: 1 }, app_ref: pidRef, value: "v" }),
    "not_settable", WIRE_ERROR_MESSAGES.elementNotSettable, "ValuePattern 缺失 → not_settable 封闭字面量",
  );
});

test("select_text|text_range 契约：[start,length] 整数、length 缺省 0、负数/非整数拒绝、native range-invalid → invalid_request", async () => {
  const { dispatcher, uia } = makeContext();
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const ok = await wire(dispatcher, "select_text", { target: { type: "element", index: 1 }, app_ref: pidRef, text_range: [2, 5] });
  assert.equal(ok.ok, true);
  assert.deepEqual(lastUiaCall(uia, "elementSelectText").args.slice(2), [2, 5]);
  const collapsed = await wire(dispatcher, "select_text", { target: { type: "element", index: 1 }, app_ref: pidRef, text_range: [3] });
  assert.equal(collapsed.ok, true);
  assert.deepEqual(lastUiaCall(uia, "elementSelectText").args.slice(2), [3, 0], "length 缺省 0 = 光标折叠");
  for (const bad of [[-1, 2], [1.5, 2], [1, -2], "12", [], [1, 2, 3]]) {
    assertWireError(
      await wire(dispatcher, "select_text", { target: { type: "element", index: 1 }, app_ref: pidRef, text_range: bad }),
      "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, `range 拒绝 ${JSON.stringify(bad)}`,
    );
  }
  const rangeInvalid = makeContext({ uia: { behaviors: { elementSelectText: async () => ({ outcome: "range-invalid" }) } } });
  await wire(rangeInvalid.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(rangeInvalid.dispatcher, "select_text", { target: { type: "element", index: 1 }, app_ref: pidRef, text_range: [999, 1] }),
    "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "start 越界 = 确定性参数错、未派发（§11.2）",
  );
});

test("perform_action|封闭词汇 {invoke,toggle,expand,collapse,select,focus}；词汇外拒绝；action_unavailable 同码", async () => {
  const { dispatcher, uia } = makeContext();
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  for (const action of ["invoke", "toggle", "expand", "collapse", "select", "focus"]) {
    const response = await wire(dispatcher, "perform_action", { target: { type: "element", index: 0 }, app_ref: pidRef, action });
    assert.equal(response.ok, true, `${action} 受理`);
    assert.equal(lastUiaCall(uia, "elementPerformAction").args[2], action);
  }
  assertWireError(
    await wire(dispatcher, "perform_action", { target: { type: "element", index: 0 }, app_ref: pidRef, action: "scroll" }),
    "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "滚动语义一律走 scroll 工具（§11.2）",
  );
  const unavailable = makeContext({ uia: { behaviors: { elementPerformAction: async () => { throw new NativeRejectedError("action_unavailable"); } } } });
  await wire(unavailable.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(unavailable.dispatcher, "perform_action", { target: { type: "element", index: 0 }, app_ref: pidRef, action: "invoke" }),
    "action_unavailable", WIRE_ERROR_MESSAGES.elementActionNotAdvertised, "元素未广告该动作（do not guess one 同律）",
  );
});

// ── 组 8：指针三工具的 element 路径（§11.2）─────────────────────────────────

test("left_click(element)|语义等价 → InvokePattern 优先（后台安全零物理注入）+ pattern-dispatched 字面量", async () => {
  const { dispatcher, driver, uia } = makeContext();
  await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const response = await wire(dispatcher, "left_click", { target: { type: "element", index: 0 }, app_ref: pidRef });
  const receipt = receiptOf(response, "element invoke");
  assert.equal(receipt.message, RECEIPT_MESSAGES.elementPatternDispatched, "收据如实标注路径（固定字面量分支）");
  assert.equal(countUiaCalls(uia, "elementInvoke"), 1);
  assert.equal(countCalls(driver, "moveTo"), 0, "pattern 路径零物理注入");
  assert.equal(countCalls(driver, "mouseDown"), 0);
});

test("left_click(element)|非语义等价（右键/多击/修饰键）与 invoke 缺席 → clickable point 物理点击 + point-dispatched", async () => {
  // 右键：不经 invoke，直接 point 路径（前台校验全程适用——moveTo 收到 expectedForegroundPid）。
  const right = makeContext();
  await wire(right.dispatcher, "get_app_state", { app_ref: pidRef });
  const rightResponse = await wire(right.dispatcher, "left_click", {
    target: { type: "element", index: 0 }, app_ref: pidRef, mouse_button: "right",
  });
  assert.equal(receiptOf(rightResponse, "right click").message, RECEIPT_MESSAGES.elementPointDispatched);
  assert.equal(countUiaCalls(right.uia, "elementInvoke"), 0, "非语义等价不试 invoke（toggle ≠ click 语义，不猜）");
  assert.equal(countCalls(right.driver, "mouseDown"), 1);
  assert.deepEqual(lastCall(right.driver, "mouseDown").args[1], { expectedForegroundPid: TEST_PID }, "前台校验适用");
  // invoke 缺席（invoked:false）→ point 兜底。
  const fallback = makeContext({ uia: { behaviors: { elementInvoke: async () => ({ invoked: false }) } } });
  await wire(fallback.dispatcher, "get_app_state", { app_ref: pidRef });
  const fallbackResponse = await wire(fallback.dispatcher, "left_click", { target: { type: "element", index: 0 }, app_ref: pidRef });
  assert.equal(receiptOf(fallbackResponse, "fallback").message, RECEIPT_MESSAGES.elementPointDispatched);
  assert.equal(countCalls(fallback.driver, "moveTo"), 1);
  // 两者皆不可（point null）→ action_unavailable（元素无法表达该点击）。
  const none = makeContext({
    uia: { behaviors: { elementInvoke: async () => ({ invoked: false }), elementClickablePoint: async () => null } },
  });
  await wire(none.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(none.dispatcher, "left_click", { target: { type: "element", index: 0 }, app_ref: pidRef }),
    "action_unavailable", WIRE_ERROR_MESSAGES.elementActionNotAdvertised, "③ 两者皆不可",
  );
});

function lastCall(driver, method) {
  const calls = driver.state.calls.filter((call) => call.method === method);
  return calls.length === 0 ? undefined : calls[calls.length - 1];
}

test("scroll(element)|ScrollPattern 在 → 后台滚动；缺席 → point + 物理 scrollAt；drag 两端 point（任一 null → action_unavailable）", async () => {
  const patterned = makeContext();
  await wire(patterned.dispatcher, "get_app_state", { app_ref: pidRef });
  const scrolled = await wire(patterned.dispatcher, "scroll", {
    target: { type: "element", index: 0 }, app_ref: pidRef, scroll_direction: "down", scroll_amount: 1,
  });
  assert.equal(receiptOf(scrolled, "scroll pattern").message, RECEIPT_MESSAGES.elementPatternDispatched);
  assert.equal(countCalls(patterned.driver, "scrollAt"), 0, "pattern 路径零物理注入");
  // deltaY 符号：down = -360（wire up/right 为正，§10.2）
  assert.deepEqual(lastUiaCall(patterned.uia, "elementScroll").args.slice(2), [0, -360]);
  const physical = makeContext({ uia: { behaviors: { elementScroll: async () => ({ scrolled: false }) } } });
  await wire(physical.dispatcher, "get_app_state", { app_ref: pidRef });
  const physicalResponse = await wire(physical.dispatcher, "scroll", {
    target: { type: "element", index: 0 }, app_ref: pidRef, scroll_direction: "up", scroll_amount: 1,
  });
  assert.equal(receiptOf(physicalResponse, "scroll point").message, RECEIPT_MESSAGES.elementPointDispatched);
  assert.equal(countCalls(physical.driver, "scrollAt"), 1);
  // drag：双 element → 两端 clickable point + native drag；任一端 null → action_unavailable。
  const drag = makeContext();
  await wire(drag.dispatcher, "get_app_state", { app_ref: pidRef });
  const dragged = await wire(drag.dispatcher, "left_click_drag", {
    from_target: { type: "element", index: 0 }, to: { type: "element", index: 1 }, app_ref: pidRef,
  });
  assert.equal(receiptOf(dragged, "drag").message, RECEIPT_MESSAGES.elementPointDispatched);
  assert.equal(countCalls(drag.driver, "drag"), 1);
  const dragNull = makeContext({
    uia: { behaviors: { elementClickablePoint: async (token, index) => (index === 1 ? null : { x: 5, y: 5 }) } },
  });
  await wire(dragNull.dispatcher, "get_app_state", { app_ref: pidRef });
  assertWireError(
    await wire(dragNull.dispatcher, "left_click_drag", {
      from_target: { type: "element", index: 0 }, to: { type: "element", index: 1 }, app_ref: pidRef,
    }),
    "action_unavailable", WIRE_ERROR_MESSAGES.elementActionNotAdvertised, "任一端无 clickable point",
  );
  assert.equal(countCalls(dragNull.driver, "drag"), 0, "零派发");
});

// ── 组 9：_meta targetApp 契约（AC-7）───────────────────────────────────────

test("_meta|targetApp 形状过宿主 contracts strict schema；identity 只来自已验证解析（毒样本不回填）", async () => {
  const { dispatcher } = makeContext();
  const response = await wire(dispatcher, "get_app_state", { app_ref: pidRef });
  const meta = response.result._meta[CUA_TARGET_APP_DISPLAY_META_KEY];
  contractsMeta.cuaTargetAppDisplaySchema.parse(meta);  // strict schema：形状漂移即抛
  assert.deepEqual(meta.iconLocators[0], { kind: "windows-executable-path", value: FAKE_EXE_PATH });
  // packaged（aumid 在场）→ 第二 locator；displayName 缺席时键不出现（optional）。
  const packaged = makeContext();
  const packagedResponse = await wire(packaged.dispatcher, "get_app_state", { app_ref: { bundle_id: PACKAGED_AUMID } });
  const packagedMeta = packagedResponse.result._meta[CUA_TARGET_APP_DISPLAY_META_KEY];
  contractsMeta.cuaTargetAppDisplaySchema.parse(packagedMeta);
  assert.deepEqual(packagedMeta.iconLocators[1], { kind: "windows-aumid", value: PACKAGED_AUMID });
  // 毒样本：模型输入的 name 原文绝不回填展示身份（解析失败 → 错误面零插值）。
  const poison = await wire(packaged.dispatcher, "list_windows", { app_ref: { name: "EVIL<script>alert(1)</script>" } });
  assertWireError(poison, "invalid_request", WIRE_ERROR_MESSAGES.appNotRunning, "毒 name 0 候选");
  assert.ok(!JSON.stringify(poison).includes("EVIL"), "模型输入原文绝不出现在任何响应面（§11.6 权威边界）");
  // 变更类收据同样附 _meta（§11.6「一切带已解析 app_ref 的动作收据」）。
  const click = await wire(dispatcher, "left_click", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: pidRef });
  // 坐标 target 无 frame → element_unavailable（frame 未登记）；先观察再点。
  if (!click.ok) {
    const ctx2 = makeContext();
    await wire(ctx2.dispatcher, "get_app_state", { app_ref: pidRef, include_screenshot: true });
    const click2 = await wire(ctx2.dispatcher, "left_click", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: pidRef });
    assert.ok(click2.result._meta[CUA_TARGET_APP_DISPLAY_META_KEY], "坐标动作收据也附 _meta");
  } else {
    assert.ok(click.result._meta[CUA_TARGET_APP_DISPLAY_META_KEY], "动作收据附 _meta");
  }
});

// ── 组 10：capabilities 一致性 + 14/14 齐套（AC-10，§13 不变量②）────────────

test("broker_info|capabilities.uia=true ⟺ 6 UIA handler 注册；presence=false ⟺ 全 unimplemented（两面同源收口）", async () => {
  const full = makeContext();
  const info = await wire(full.dispatcher, BROKER_INFO_METHOD);
  assert.equal(info.ok, true);
  assert.deepEqual(info.result.capabilities, { input: true, capture: true, clipboard: true, uia: true });
  for (const method of ["list_apps", "list_windows", "get_app_state", "set_value", "select_text", "perform_action"]) {
    const probe = await wire(full.dispatcher, method, {});
    const code = probe.ok ? null : probe.error.code;
    assert.notEqual(code, "unimplemented", `${method}: uia=true ⟺ handler 已注册（全量 ⟺ 自 A3 收口）`);
  }
  // presence=false：backend-a3 空记录 + capabilities.uia=false + 6 方法 unimplemented。
  const absent = makeContext({ uia: { presence: false } });
  const absentInfo = await wire(absent.dispatcher, BROKER_INFO_METHOD);
  assert.equal(absentInfo.result.capabilities.uia, false);
  for (const method of ["list_apps", "list_windows", "get_app_state", "set_value", "select_text", "perform_action"]) {
    assertWireError(await wire(absent.dispatcher, method, {}), "unimplemented", WIRE_ERROR_MESSAGES.unimplemented, `${method}: presence=false ⟺ unimplemented（C09 显式不可用）`);
  }
  // A2-alone 面（历史语义）：broker_info 无 uia 键。
  const a2Only = await wire(absent.dispatcher, BROKER_INFO_METHOD);
  assert.ok(a2Only.ok);
});

test("14/14 齐套|组合 backend 对 14 方法逐一「真实受理」（每方法独立断言，不折叠——A3-AC-10 反转）", async () => {
  const { dispatcher } = makeContext();
  assert.equal(WIRE_METHOD_NAMES.length, 14);
  // 每方法一组能到达 handler 的最小参数（受理 ≠ 成功：参数/前置拒绝都证明「已注册」）。
  const probes = [
    ["list_apps", {}],
    ["list_windows", {}],
    ["get_app_state", { app_ref: pidRef }],
    ["left_click", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: pidRef }],
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: pidRef, scroll_direction: "up", scroll_amount: 1 }],
    ["left_click_drag", { from_target: { type: "coordinate", x: 1, y: 1 }, to: { type: "coordinate", x: 2, y: 2 }, app_ref: pidRef }],
    ["type", { text: "t", app_ref: pidRef }],
    ["set_value", { target: { type: "element", index: 0 }, app_ref: pidRef, value: "v" }],
    ["select_text", { target: { type: "element", index: 0 }, app_ref: pidRef, text_range: [0, 1] }],
    ["key", { text: "enter", app_ref: pidRef }],
    ["perform_action", { target: { type: "element", index: 0 }, app_ref: pidRef, action: "focus" }],
    ["paste", { text: "t", app_ref: pidRef }],
    ["request_access", {}],
    ["stop_computer_control", {}],
  ];
  assert.equal(probes.length, 14, "14 方法一个都不能少");
  for (const [method, params] of probes) {
    const response = await wire(dispatcher, method, params);
    const code = response.ok ? null : response.error.code;
    assert.notEqual(code, "unimplemented", `${method}: A3 后 unimplemented 面收口为零`);
  }
});

// ── 组 11：观察类 admission / 错误映射 / preflight ──────────────────────────

test("观察类|入 admission 串行（队满 → controller_busy）；uia_timeout → timeout；canceled → controller_busy", async () => {
  const { dispatcher, session } = makeContext();
  // 队满：8 个悬挂的入队项占满深度 → list_apps 立即 busy（确定未派发域）。
  const blockers = [];
  for (let i = 0; i < 8; i += 1) {
    blockers.push(session.submit(`blocker-${i}`, () => new Promise(() => {})).catch(() => {}));
  }
  assertWireError(await wire(dispatcher, "list_apps", {}), "controller_busy", WIRE_ERROR_MESSAGES.controllerBusy, "队满 → busy（观察类同受 admission 治理，§10.5）");
  void blockers;
  // 错误映射。
  const timeout = makeContext({ uia: { behaviors: { listApplications: async () => { throw new NativeRejectedError("uia_timeout"); } } } });
  assertWireError(await wire(timeout.dispatcher, "list_apps", {}), "timeout", WIRE_ERROR_MESSAGES.operationTimeout, "只读 uia_timeout → ok:false timeout（重试安全，§11.1 分流）");
  const canceled = makeContext({ uia: { behaviors: { listApplications: async () => { throw new NativeRejectedError("canceled"); } } } });
  assertWireError(await wire(canceled.dispatcher, "list_apps", {}), "controller_busy", WIRE_ERROR_MESSAGES.controllerBusy, "canceled → controller_busy");
});

test("preflight|非交互桌面 → 六工具统一 permission_denied（§10.9「UIA 读走同一门」）", async () => {
  const locked = makeContext({ driver: { env: { interactiveDesktop: false, sessionZero: false, dpiAware: true } } });
  for (const [method, params] of [
    ["list_apps", {}],
    ["list_windows", {}],
    ["get_app_state", { app_ref: pidRef }],
  ]) {
    assertWireError(await wire(locked.dispatcher, method, params), "permission_denied", WIRE_ERROR_MESSAGES.nonInteractiveDesktop, `${method}: 锁屏整体诚实拒绝`);
  }
});

test("request_access|accessibility 判据 A3 起叠加 UIA 可用（§10.9）：uiaPresence=false → denied", async () => {
  const absent = makeContext({ uia: { presence: false } });
  const response = await wire(absent.dispatcher, "request_access", {});
  assert.equal(response.ok, true);
  const status = JSON.parse(response.result.content[0].text);
  assert.equal(status.accessibility, "denied", "preflight 过但 UIA 缺席 → denied（能力诚实）");
  assert.equal(status.platform, "win32");
  const full = makeContext();
  const fullStatus = JSON.parse((await wire(full.dispatcher, "request_access", {})).result.content[0].text);
  assert.equal(fullStatus.accessibility, "granted");
});

// ── 组 12：uia-driver 毒化监督（AC-1 JS 面，§11.1）──────────────────────────

test("uia-driver|uia_timeout 后读 workerStats：poisoned ≥3 → onPoisonExhausted 恰一次；<3 不触发", async () => {
  const makeAddon = (poisoned) => {
    const addon = { poisonCalls: 0 };
    for (const name of UIA_EXPORTS) {
      addon[name] = async () => {
        if (name === "uiaWorkerStats") return { poisoned, generation: 2 };
        addon.poisonCalls += 1;
        const error = new Error("uia_timeout");
        error.code = "uia_timeout";
        throw error;
      };
    }
    return addon;
  };
  let exhausted = 0;
  const below = createUiaDriver(makeAddon(2), { onPoisonExhausted: () => { exhausted += 1; } });
  await below.listApplications().catch(() => {});
  assert.equal(exhausted, 0, "poisoned=2 <3 不触发");
  const at = createUiaDriver(makeAddon(3), { onPoisonExhausted: () => { exhausted += 1; } });
  await at.listApplications().catch(() => {});
  await at.listApplications().catch(() => {});
  assert.equal(exhausted, 1, "poisoned=3 → 恰一次（幂等：第二次调用不重复触发）");
  // presence=false（导出缺席）：不注册面 = capabilities 同源事实。
  const absent = createUiaDriver({});
  assert.equal(absent.presence, false);
});

test("uia-driver|变更类 uia_timeout → Ambiguous（possibly_sent 域）；只读 → Rejected（§11.1 分流）", async () => {
  const makeAddon = () => {
    const addon = {};
    for (const name of UIA_EXPORTS) {
      addon[name] = async () => {
        if (name === "uiaWorkerStats") return { poisoned: 0, generation: 1 };
        const error = new Error("uia_timeout");
        error.code = "uia_timeout";
        throw error;
      };
    }
    return addon;
  };
  const driver = createUiaDriver(makeAddon());
  await driver.listApplications().catch((error) => {
    assert.equal(error.name, "NativeRejectedError", "只读 timeout → Rejected（ok:false timeout 安全区）");
  });
  await driver.elementSetValue(1, 0, "x").catch((error) => {
    assert.equal(error.name, "NativeAmbiguousError", "变更类 timeout → Ambiguous（possibly_sent，禁 ok:false）");
    assert.equal(error.reason, "native-timeout");
  });
});
