/**
 * cua-producer A2 纯逻辑测试（specs/windows-helper-producer.md §10.11——CI 常驻，
 * ubuntu 必跑）：tsx 深导入 cua-producer/src/**.ts（源文件恒在库、非构建工件，无 §6.1
 * 工件守卫需求；导入纪律先例 = A1 批次对 services TS 的深导入，oQ5 实证），fake driver
 * （§10.3 二分判据接口——真 native 的失败注入不可确定化，故注入面以 driver seam 为准）。
 *
 * 覆盖面：参数验证器全边界（§10.2/§13）、admission（串行/队满/排队超时/旁路，§10.5）、
 * stop 五步时序（§10.6）、§10.4 五条 seam 单测（含 chord 修饰键残留场景与收据 held-空
 * 不变量横扫）、三态收据 happy-path 全覆盖（§10.12——真实副作用在 CI 不可达，fake
 * driver 是成功路径形态断言的唯一落点）、坐标投影算术（§10.9）、keymap 封闭集、
 * paste 剪贴板遗留语义、request_access 形态（§10.9）、broker_info capabilities 一致性
 * （A2-AC-10 两面同源）。
 *
 * 安全纪律：本文件零真实注入/零剪贴板写/零子进程——全部经 fake driver。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEAD_PID,
  NativeAmbiguousError,
  NativeRejectedError,
  TEST_PID,
  countCalls,
  createFakeDriver,
  delay,
  importProducerModule,
  lastCall,
} from "./cua-producer-a2-fake.mjs";

const { createBackendA2, RECEIPT_MESSAGES, CUA_REQUEST_ACCESS_STATUS_META_KEY } =
  await importProducerModule("backend-a2");
const { createInputSession, SessionBusyError, watchdogIntervalMs, createExitConvergence } =
  await importProducerModule("input-session");
const { createFrameRegistry, appOwnerScope } = await importProducerModule("frame-registry");
const { parseKeyChord, PASTE_CHORD_SEQUENCE } = await importProducerModule("keymap");
const { createWireDispatcher, WIRE_ERROR_MESSAGES } =
  await importProducerModule("wire-server");

// ── 公共夹具 ─────────────────────────────────────────────────────────────────

function makeContext(options = {}) {
  const driver = createFakeDriver(options.driver);
  const session = createInputSession(driver, options.session);
  const frames = createFrameRegistry();
  const backend = createBackendA2({ driver, session, frames });
  const dispatcher = createWireDispatcher();
  dispatcher.activate(backend);
  return { driver, session, frames, backend, dispatcher };
}

function wire(dispatcher, method, params) {
  const request = params === undefined ? { method } : { method, params };
  return dispatcher.handleRequestLine(JSON.stringify(request));
}

/** 断言 ok:false 精确形态（封闭字面量 + 码；零插值 = deepEqual 全等）。 */
function assertWireError(response, code, message, label) {
  assert.deepEqual(response, { ok: false, error: { message, code } }, label);
}

/** 断言 ok:true 且收据双载体同键（§10.12：structuredContent + 单文本块 JSON 同键）。 */
function receiptOf(response, label) {
  assert.equal(response.ok, true, `${label ?? "receipt"}: 必须 ok:true`);
  const result = response.result;
  assert.ok(result && Array.isArray(result.content) && result.content.length === 1, `${label}: 单文本块`);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, result.structuredContent, `${label}: 文本块 JSON 与 structuredContent 同键`);
  return result.structuredContent;
}

/** 注册一个 TEST_PID 归属的可动作 frame（identity 投影：raster = bounds = 8×4）。 */
function registerTestFrame(frames, overrides = {}) {
  return frames.register({
    rasterWidth: 8,
    rasterHeight: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 },
    ownerScope: appOwnerScope(TEST_PID),
    ...overrides,
  });
}

const clickParams = (overrides = {}) => ({
  target: { type: "coordinate", x: 4, y: 2 },
  app_ref: { pid: TEST_PID },
  ...overrides,
});

const SEVEN_MUTATING = [
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "key",
  "paste",
  "stop_computer_control",
];

// ── 组 1：参数验证器全边界（§10.2/§13；全部落「派发前」ok:false 安全区）──────

test("参数|left_click：缺必填/未知键/枚举越界/类型不符 → invalid_request 封闭字面量", async () => {
  const { dispatcher, driver } = makeContext();
  const bad = [
    [{}, "缺 target/app_ref"],
    [{ ...clickParams(), evil: 1 }, "未知键拒绝（§10.2 封闭参数集）"],
    [{ ...clickParams(), mouse_button: "fourth" }, "mouse_button 封闭词汇"],
    [{ ...clickParams(), click_count: 0 }, "click_count ∈ {1,2,3}"],
    [{ ...clickParams(), click_count: 4 }, "click_count ∈ {1,2,3}"],
    [{ ...clickParams(), click_count: 1.5 }, "click_count 整数"],
    [{ ...clickParams(), modifiers: ["super"] }, "modifiers 封闭词汇 {ctrl,alt,shift,win}"],
    [{ ...clickParams(), modifiers: "ctrl" }, "modifiers 必须数组"],
    [{ ...clickParams(), strategy: 42 }, "strategy 必须 string（接受并忽略）"],
    [{ ...clickParams(), target: { type: "region", x: 1, y: 1 } }, "target.type 封闭"],
    [{ ...clickParams(), target: { type: "coordinate", x: -1, y: 0 } }, "x 非负整数"],
    [{ ...clickParams(), target: { type: "coordinate", x: 1.5, y: 0 } }, "x 整数"],
    [{ ...clickParams(), target: { type: "coordinate", x: 1, y: 0, evil: true } }, "target 未知键"],
    [{ ...clickParams(), target: { type: "coordinate", x: 1, y: 0, frame_id: 42 } }, "frame_id 必须 string"],
  ];
  for (const [params, label] of bad) {
    const response = await wire(dispatcher, "left_click", params);
    assertWireError(
      response,
      "invalid_request",
      WIRE_ERROR_MESSAGES.invalidParams,
      `left_click ${label}`,
    );
  }
  // 参数校验失败全部发生在派发前：fake driver 零注入调用（§10.12 ok:false 安全区）。
  for (const method of ["moveTo", "mouseDown", "mouseUp", "scrollAt", "drag", "sendText", "pressKeys"]) {
    assert.equal(countCalls(driver, method), 0, `left_click ${method} 零派发`);
  }
});

test("参数|app_ref：A2 只接受 {pid}；name/bundle_id 形态 → 固定字面量；pid 类型不符 → invalid_request", async () => {
  const { dispatcher } = makeContext();
  const requiresPid = [
    [{ name: "notepad" }, "name 形态（能力诚实：A2 不做半套名称解析，§10.9）"],
    [{ bundle_id: "x.y" }, "bundle_id 形态"],
    [{ pid: TEST_PID, bundle_id: "x.y" }, "组合形态（A3 收口）"],
    [{}, "缺 pid"],
  ];
  for (const [appRef, label] of requiresPid) {
    const response = await wire(dispatcher, "left_click", { ...clickParams(), app_ref: appRef });
    assertWireError(
      response,
      "invalid_request",
      WIRE_ERROR_MESSAGES.appRefRequiresPid,
      `app_ref ${label}`,
    );
  }
  const invalid = [
    [{ pid: 0 }, "pid 正整数"],
    [{ pid: -3 }, "pid 正整数"],
    [{ pid: 1.5 }, "pid 整数"],
    [{ pid: "4242" }, "pid 必须 number"],
    [{ pid: TEST_PID, foo: 1 }, "未知键拒绝"],
  ];
  for (const [appRef, label] of invalid) {
    const response = await wire(dispatcher, "left_click", { ...clickParams(), app_ref: appRef });
    assertWireError(response, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, `app_ref ${label}`);
  }
  // window_id 可附、A2 忽略（§10.9）：不得因它拒绝——带 window_id 的合法请求走到
  // frame 解析（无 frame → stale 字面量，而非 invalid_request）。
  const context = makeContext();
  const response = await wire(context.dispatcher, "left_click", {
    ...clickParams(),
    app_ref: { pid: TEST_PID, window_id: 7 },
  });
  assertWireError(
    response,
    "element_unavailable",
    WIRE_ERROR_MESSAGES.staleObservation,
    "window_id 可附、A2 忽略（拒绝面是 frame 缺席而非 app_ref）",
  );
});

test("参数|scroll/drag/type/key/paste/stop/request_access 各自封闭集边界", async () => {
  const { dispatcher } = makeContext();
  const cases = [
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: TEST_PID }, scroll_direction: "sideways", scroll_amount: 1 }, "direction 封闭词汇"],
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: TEST_PID }, scroll_direction: "up", scroll_amount: 0 }, "amount 正数"],
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: TEST_PID }, scroll_direction: "up", scroll_amount: -2 }, "amount 正数"],
    ["scroll", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: TEST_PID }, scroll_direction: "up", scroll_amount: "3" }, "amount number"],
    ["left_click_drag", { from_target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: TEST_PID } }, "缺 to"],
    ["left_click_drag", { from_target: { type: "coordinate", x: 1, y: 1 }, to: { type: "coordinate", x: 2, y: 2 }, app_ref: { pid: TEST_PID }, strategy: "x" }, "drag 无 strategy 键（§13 行 6 封闭集）"],
    ["type", { app_ref: { pid: TEST_PID } }, "缺 text"],
    ["type", { text: 42, app_ref: { pid: TEST_PID } }, "text 必须 string"],
    ["type", { text: "", app_ref: { pid: TEST_PID } }, "空 text 拒绝（无意义 no-op 不得产 action_sent:true 假收据）"],
    ["type", { text: "a".repeat(32_769), app_ref: { pid: TEST_PID } }, "text ≤32,768 code units（§10.2）"],
    ["type", { text: "hi", app_ref: { pid: TEST_PID }, strategy: "win" }, "type 无 strategy 键（§13 行 7 封闭集）"],
    ["key", { text: "hyper+a", app_ref: { pid: TEST_PID } }, "未知键名（封闭词汇，§10.9）"],
    ["key", { text: "", app_ref: { pid: TEST_PID } }, "空 chord"],
    ["key", { text: "f25", app_ref: { pid: TEST_PID } }, "f1-f24 封闭"],
    ["key", { text: "enter", app_ref: { pid: TEST_PID }, hold_seconds: -1 }, "hold_seconds ∈ [0,30]"],
    ["key", { text: "enter", app_ref: { pid: TEST_PID }, hold_seconds: 31 }, "hold_seconds ∈ [0,30]"],
    ["key", { text: "enter", app_ref: { pid: TEST_PID }, hold_seconds: "5" }, "hold_seconds number"],
    ["paste", { text: "x", app_ref: { pid: TEST_PID }, format: "image" }, "format ∈ {text}（A2 只实现文本，诚实拒绝）"],
    ["paste", { text: "a".repeat(8 * 1024 * 1024 + 1), app_ref: { pid: TEST_PID } }, "paste.text ≤8 Mi code units"],
    ["stop_computer_control", { reason: 42 }, "reason string"],
    ["stop_computer_control", { reason: "x".repeat(513) }, "reason ≤512"],
    ["stop_computer_control", { evil: true }, "未知键"],
    ["request_access", { capabilities: "input" }, "capabilities 数组"],
    ["request_access", { capabilities: [1] }, "capabilities string[]"],
  ];
  for (const [method, params, label] of cases) {
    const response = await wire(dispatcher, method, params);
    assertWireError(response, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, `${method} ${label}`);
  }
});

test("参数|element target → A2 诚实拒绝字面量（UIA 面未实现，C09 同律，§10.9）", async () => {
  const { dispatcher, driver } = makeContext();
  const cases = [
    ["left_click", { ...clickParams(), target: { type: "element", index: 3 } }],
    // scroll 的封闭集必填项须齐（direction/amount 校验在 target 之前——两处都是
    // 「派发前 ok:false 安全区」，顺序不影响诚实性）。
    ["scroll", {
      target: { type: "element", index: 3 },
      app_ref: { pid: TEST_PID },
      scroll_direction: "up",
      scroll_amount: 1,
    }],
    ["left_click_drag", {
      from_target: { type: "element", index: 1 },
      to: { type: "coordinate", x: 1, y: 1 },
      app_ref: { pid: TEST_PID },
    }],
  ];
  for (const [method, params] of cases) {
    const response = await wire(dispatcher, method, params);
    assertWireError(
      response,
      "element_unavailable",
      WIRE_ERROR_MESSAGES.elementTargetsRequireUia,
      `${method} element target`,
    );
  }
  assert.equal(countCalls(driver, "moveTo"), 0, "element 拒绝零派发");
});

// ── 组 2：预检门 / app_ref 解析 / frame 解析（派发前 ok:false 域）──────────────

test("预检|非交互桌面/Session 0/DPI 未达标 → permission_denied 固定字面量（§10.9 统一门）", async () => {
  const envs = [
    [{ interactiveDesktop: false, sessionZero: false, dpiAware: true }, "锁屏/非交互桌面"],
    [{ interactiveDesktop: true, sessionZero: true, dpiAware: true }, "Session 0"],
    [{ interactiveDesktop: true, sessionZero: false, dpiAware: false }, "DPI 上下文失败"],
  ];
  for (const [env, label] of envs) {
    const { dispatcher, driver } = makeContext({ driver: { env } });
    const response = await wire(dispatcher, "type", { text: "hi", app_ref: { pid: TEST_PID } });
    assertWireError(
      response,
      "permission_denied",
      WIRE_ERROR_MESSAGES.nonInteractiveDesktop,
      `preflight ${label}`,
    );
    assert.equal(countCalls(driver, "sendText"), 0, `${label}: 零派发（绝不带病派发）`);
  }
});

test("app_ref|pid 死亡/不可读 → 「target app is not running」字面量（含 SDK isAppNotFound 兼容子串）", async () => {
  const { dispatcher, driver } = makeContext();
  const response = await wire(dispatcher, "type", { text: "hi", app_ref: { pid: DEAD_PID } });
  assertWireError(response, "invalid_request", WIRE_ERROR_MESSAGES.appNotRunning, "死 pid");
  assert.ok(
    WIRE_ERROR_MESSAGES.appNotRunning.includes("target app is not running"),
    "SDK isAppNotFound 兼容子串（§4.6.1/§11.3——字面量改动须两侧同审）",
  );
  assert.equal(countCalls(driver, "sendText"), 0, "派发前拒绝");
});

test("frame|坐标 target：无 frame/未知 frame_id/owner 不符/拓扑换代 → stale 字面量（§10.9）", async () => {
  // 无任何 frame（A2 运行期常态——观察面属 A3）：隐式绑定 fail-closed。
  {
    const { dispatcher } = makeContext();
    const response = await wire(dispatcher, "left_click", clickParams());
    assertWireError(
      response,
      "element_unavailable",
      WIRE_ERROR_MESSAGES.staleObservation,
      "无 frame → no actionable frame 语义",
    );
  }
  // 未知 frame_id。
  {
    const { dispatcher, frames } = makeContext();
    registerTestFrame(frames);
    const response = await wire(dispatcher, "left_click", clickParams({ target: { type: "coordinate", x: 1, y: 1, frame_id: "fr-0-999" } }));
    assertWireError(response, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "未知 frame_id");
  }
  // owner 不符（frame_dispatch_identity_mismatch 同律 fail-closed）。
  {
    const { dispatcher, frames } = makeContext();
    const frame = registerTestFrame(frames, { ownerScope: appOwnerScope(DEAD_PID) });
    const response = await wire(dispatcher, "left_click", clickParams({ target: { type: "coordinate", x: 1, y: 1, frame_id: frame.frameId } }));
    assertWireError(response, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "owner 不符");
  }
  // 拓扑换代：旧世代 frame 一律 stale（§10.7）。
  {
    const { dispatcher, frames } = makeContext();
    const frame = registerTestFrame(frames, { topologyFingerprint: "0,0,8,4;" });
    frames.observeTopology("0,0,8,4;1920,0,3840,1080;");  // 增删显示器/改分辨率
    const response = await wire(dispatcher, "left_click", clickParams({ target: { type: "coordinate", x: 1, y: 1, frame_id: frame.frameId } }));
    assertWireError(response, "element_unavailable", WIRE_ERROR_MESSAGES.staleObservation, "拓扑换代");
  }
});

// ── 组 3：坐标投影算术（§10.9 producer 自持；纯线性 + 舍入 + clamp）────────────

test("投影|identity/缩放帧/副屏负 bounds/舍入/clamp（单测覆盖，§10.9）", () => {
  const frames = createFrameRegistry();
  // identity：raster = bounds。
  const identity = frames.register({
    rasterWidth: 100, rasterHeight: 50,
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    ownerScope: "app:1",
  });
  assert.deepEqual(frames.projectCoordinates(identity, 10, 20), { x: 10, y: 20 }, "identity");
  // 缩放帧：model 栅格 1000×500 → 物理 2000×1000（2 倍）。
  const scaled = frames.register({
    rasterWidth: 1000, rasterHeight: 500,
    bounds: { x: 0, y: 0, width: 2000, height: 1000 },
    ownerScope: "app:1",
  });
  assert.deepEqual(frames.projectCoordinates(scaled, 500, 250), { x: 1000, y: 500 }, "缩放帧 2x");
  // 副屏负 bounds：全链一致虚拟桌面空间（§10.7 副屏负坐标合法）。
  const secondary = frames.register({
    rasterWidth: 1920, rasterHeight: 1080,
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    ownerScope: "app:1",
  });
  assert.deepEqual(frames.projectCoordinates(secondary, 100, 100), { x: -1820, y: 100 }, "副屏负 bounds");
  // 非整数舍入：四舍五入到物理像素。
  const fractional = frames.register({
    rasterWidth: 7, rasterHeight: 7,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    ownerScope: "app:1",
  });
  // 3 × (10/7) = 4.2857… → 4
  assert.deepEqual(frames.projectCoordinates(fractional, 3, 3), { x: 4, y: 4 }, "四舍五入");
  // 越界 clamp 到 bounds 内并如实保留。
  assert.deepEqual(frames.projectCoordinates(identity, 500, 500), { x: 99, y: 49 }, "clamp 到 bounds 内");
});

test("投影|wire 级：left_click 以登记 frame 投影后的物理坐标派发", async () => {
  const { dispatcher, driver, frames } = makeContext();
  frames.register({
    rasterWidth: 100, rasterHeight: 50,
    bounds: { x: 1000, y: 200, width: 2000, height: 1000 },
    ownerScope: appOwnerScope(TEST_PID),
  });
  const response = await wire(dispatcher, "left_click", clickParams({ target: { type: "coordinate", x: 50, y: 25 } }));
  assert.equal(response.ok, true, "隐式绑定最近一次可动作 frame");
  const moveTo = lastCall(driver, "moveTo");
  // x_phys = 1000 + 50×(2000/100) = 2000；y_phys = 200 + 25×(1000/50) = 700。
  assert.deepEqual(moveTo.args.slice(0, 2), [2000, 700], "投影算术");
  assert.deepEqual(moveTo.args[2], { expectedForegroundPid: TEST_PID }, "expectedForegroundPid 下传（§10.1 注记 1）");
});

// ── 组 4：三态收据 happy-path 全覆盖（§10.12；fake driver 是成功路径形态断言唯一落点）──

test("收据|accepted：七个变更类成功路径全部携带 delivery-state 收据（禁空成功）", async () => {
  const { dispatcher, frames } = makeContext();
  registerTestFrame(frames);
  const invocations = [
    ["left_click", clickParams()],
    ["scroll", { target: { type: "coordinate", x: 4, y: 2 }, app_ref: { pid: TEST_PID }, scroll_direction: "up", scroll_amount: 2 }],
    ["left_click_drag", { from_target: { type: "coordinate", x: 1, y: 1 }, to: { type: "coordinate", x: 6, y: 3 }, app_ref: { pid: TEST_PID } }],
    ["type", { text: "hello 世界", app_ref: { pid: TEST_PID } }],
    ["key", { text: "ctrl+a", app_ref: { pid: TEST_PID } }],
    ["paste", { text: "clip 内容", app_ref: { pid: TEST_PID } }],
    ["stop_computer_control", {}],
  ];
  for (const [method, params] of invocations) {
    const response = await wire(dispatcher, method, params);
    const receipt = receiptOf(response, `${method} accepted`);
    assert.equal(receipt.action_sent, true, `${method}: action_sent=true（变更类成功必须携带）`);
    assert.equal(receipt.dispatch_status, "accepted", `${method}: dispatch_status=accepted`);
    assert.equal(response.result.isError, undefined, `${method}: 成功收据非 isError`);
  }
});

test("收据|accepted 方法专属事实：type injected/total、drag injected_points+message、paste clipboard_modified+message、stop message", async () => {
  const { dispatcher, frames } = makeContext();
  registerTestFrame(frames);
  const typeReceipt = receiptOf(await wire(dispatcher, "type", { text: "abc", app_ref: { pid: TEST_PID } }), "type");
  assert.equal(typeReceipt.injected, 3);
  assert.equal(typeReceipt.total, 3);
  const dragReceipt = receiptOf(
    await wire(dispatcher, "left_click_drag", {
      from_target: { type: "coordinate", x: 1, y: 1 },
      to: { type: "coordinate", x: 6, y: 3 },
      app_ref: { pid: TEST_PID },
    }),
    "drag",
  );
  assert.equal(dragReceipt.injected_points, 16, "injectedPoints 事实进 structuredContent");
  assert.equal(dragReceipt.message, RECEIPT_MESSAGES.dragCompleted, "message 固定字面量分支");
  const pasteReceipt = receiptOf(await wire(dispatcher, "paste", { text: "x", app_ref: { pid: TEST_PID } }), "paste");
  assert.equal(pasteReceipt.clipboard_modified, true, "剪贴板遗留 = 登记的产品副作用（§10.9）");
  assert.equal(pasteReceipt.message, RECEIPT_MESSAGES.pasteCompletedClipboardModified);
  const stopReceipt = receiptOf(await wire(dispatcher, "stop_computer_control", {}), "stop");
  assert.equal(stopReceipt.message, RECEIPT_MESSAGES.stopped, "§10.6 ⑤ 固定字面量");
});

test("收据|possibly_sent：Ambiguous 注入 → ok:true isError + 收据键精确（铁律 1：派发后禁 ok:false）", async () => {
  const { dispatcher, frames } = makeContext({
    driver: {
      behaviors: {
        mouseDown: () => {
          throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown");
        },
      },
    },
  });
  registerTestFrame(frames);
  const response = await wire(dispatcher, "left_click", clickParams());
  assert.equal(response.ok, true, "派发后失败禁止 ok:false（§10.12 铁律 1）");
  assert.equal(response.result.isError, true);
  const receipt = receiptOf(response, "possibly_sent");
  assert.equal(receipt.dispatch_status, "possibly_sent");
  assert.equal(receipt.action_sent, true);
  assert.equal(receipt.reason, "native-dispatch-outcome-unknown");
  assert.equal(receipt.message, RECEIPT_MESSAGES.possiblySent);
  const SEVENTEEN = ["permission_denied","not_authorized","launch_failed","invalid_request","element_unavailable","not_settable","not_selectable","action_unavailable","foreground_required","controller_busy","broker_unavailable","version_mismatch","stale_socket","timeout","unimplemented","method_not_found","internal"];
  assert.ok(SEVENTEEN.includes(receipt.code), `code ∈ 17 码词汇表（实际 ${receipt.code}）`);
});

test("收据|interrupted：canceled 结果 → accepted+action_sent:true+controller_busy+固定字面量（§10.6）", async () => {
  // type：sendText 返回 canceled:true。
  {
    const { dispatcher } = makeContext({
      driver: { behaviors: { sendText: async (text) => ({ injected: 2, total: text.length, canceled: true }) } },
    });
    const receipt = receiptOf(await wire(dispatcher, "type", { text: "abcdef", app_ref: { pid: TEST_PID } }), "type interrupted");
    assert.equal(receipt.dispatch_status, "accepted");
    assert.equal(receipt.action_sent, true);
    assert.equal(receipt.code, "controller_busy");
    assert.equal(receipt.message, RECEIPT_MESSAGES.interruptedByStop);
    assert.equal(receipt.injected, 2, "部分事实如实进收据");
    assert.equal(receipt.total, 6);
  }
  // drag：canceled:true + injectedPoints。
  {
    const { dispatcher, frames } = makeContext({
      driver: { behaviors: { drag: async () => ({ injectedPoints: 5, canceled: true }) } },
    });
    registerTestFrame(frames);
    const receipt = receiptOf(
      await wire(dispatcher, "left_click_drag", {
        from_target: { type: "coordinate", x: 1, y: 1 },
        to: { type: "coordinate", x: 6, y: 3 },
        app_ref: { pid: TEST_PID },
      }),
      "drag interrupted",
    );
    assert.equal(receipt.code, "controller_busy");
    assert.equal(receipt.message, RECEIPT_MESSAGES.interruptedByStop);
    assert.equal(receipt.injected_points, 5);
  }
  // key hold：pressKeys canceled:true。
  {
    const { dispatcher } = makeContext({
      driver: { behaviors: { pressKeys: async () => ({ canceled: true }) } },
    });
    const receipt = receiptOf(
      await wire(dispatcher, "key", { text: "f13", app_ref: { pid: TEST_PID }, hold_seconds: 5 }),
      "key interrupted",
    );
    assert.equal(receipt.dispatch_status, "accepted");
    assert.equal(receipt.action_sent, true);
    assert.equal(receipt.message, RECEIPT_MESSAGES.interruptedByStop);
  }
  // type 部分注入（injected<total ∧ !canceled）→ interrupted code internal（§10.12 行 3）。
  {
    const { dispatcher } = makeContext({
      driver: { behaviors: { sendText: async (text) => ({ injected: 3, total: text.length, canceled: false }) } },
    });
    const receipt = receiptOf(await wire(dispatcher, "type", { text: "abcdef", app_ref: { pid: TEST_PID } }), "type partial");
    assert.equal(receipt.code, "internal");
    assert.equal(receipt.message, RECEIPT_MESSAGES.textPartiallyInjected);
    assert.equal(receipt.action_sent, true);
  }
});

test("收据|只读方法不携带 delivery-state 键（铁律 3：缺席即语义，不画蛇添足）", async () => {
  const { dispatcher } = makeContext();
  const response = await wire(dispatcher, "request_access", {});
  assert.equal(response.ok, true);
  const result = response.result;
  for (const key of ["action_sent", "dispatch_status"]) {
    assert.equal(key in result.structuredContent, false, `request_access 不得携带 ${key}`);
    assert.ok(!result.content[0].text.includes(key), `文本块同样不得携带 ${key}`);
  }
});

// ── 组 5：§10.4 seam 单测（五条纪律的可注入面）────────────────────────────────

test("seam|foreground_lost → ok:false foreground_required ∧ 失败后零追加注入调用（规则 4）", async () => {
  const { dispatcher, frames, driver } = makeContext({
    driver: {
      behaviors: {
        moveTo: () => {
          throw new NativeRejectedError("foreground_lost");
        },
      },
    },
  });
  registerTestFrame(frames);
  const response = await wire(dispatcher, "left_click", clickParams());
  assertWireError(
    response,
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    "foreground_lost → foreground_required（未注入，确定）",
  );
  // 校验失败绝不重试补注入：注入原语零追加（moveTo 只调用过一次且失败）。
  assert.equal(countCalls(driver, "moveTo"), 1, "moveTo 无重试");
  assert.equal(countCalls(driver, "mouseDown"), 0, "mouseDown 零调用");
  assert.equal(countCalls(driver, "mouseUp"), 0, "mouseUp 零调用");
});

test("seam|chord 修饰键残留场景（规则 5）：主体 Rejected → cleanup 释放先于收据、业务 up 段零续注入", async () => {
  const { dispatcher, frames, driver, session } = makeContext({
    driver: {
      behaviors: {
        mouseDown: () => {
          throw new NativeRejectedError("foreground_lost");
        },
      },
    },
  });
  registerTestFrame(frames);
  const response = await wire(dispatcher, "left_click", clickParams({ modifiers: ["ctrl", "shift"] }));
  assertWireError(response, "foreground_required", WIRE_ERROR_MESSAGES.foregroundRequired, "主体失败");
  const events = driver.state.events;
  // ① 修饰 down 已注入（pressKeys 一次），主体 mouseDown 失败；
  assert.equal(countCalls(driver, "pressKeys"), 1, "只有修饰 down 段——up 业务段零续注入（规则 4）");
  // ② cleanup 释放发生（releaseAllHeldInputs）且是失败后的第一个收口动作；
  const mouseDownIndex = events.indexOf("mouseDown");
  const releaseIndex = events.indexOf("releaseAllHeldInputs");
  assert.ok(releaseIndex > mouseDownIndex, "cleanup 释放在主体失败之后、收据产出之前（顺序断言）");
  // ③ held 镜像与 fake native held 在收据时点为空（可测不变量，规则 5）。
  assert.equal(session.heldMirrorSize, 0, "held 镜像空");
  assert.equal(driver.state.held.size, 0, "fake native held 注册表空");
});

test("seam|chord 修饰键残留场景（Ambiguous 变体）：possibly_sent 收据 + cleanup 释放先于收据", async () => {
  const { dispatcher, frames, driver, session } = makeContext({
    driver: {
      behaviors: {
        mouseDown: () => {
          throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown");
        },
      },
    },
  });
  registerTestFrame(frames);
  const response = await wire(dispatcher, "left_click", clickParams({ modifiers: ["ctrl"] }));
  const receipt = receiptOf(response, "chord ambiguous");
  assert.equal(receipt.dispatch_status, "possibly_sent");
  assert.equal(countCalls(driver, "releaseAllHeldInputs"), 1, "cleanup 释放发生");
  assert.equal(countCalls(driver, "pressKeys"), 1, "修饰 up 业务段零续注入");
  assert.equal(session.heldMirrorSize, 0);
  assert.equal(driver.state.held.size, 0);
});

test("seam|收据不变量横扫（规则 5）：三态收据产出时点 held 恒空——逐方法断言，不折叠", async () => {
  const frameSetup = (context) => registerTestFrame(context.frames);
  const check = async (method, params, driverOptions, setupFrames = true) => {
    const context = makeContext({ driver: driverOptions });
    if (setupFrames) frameSetup(context);
    const response = await wire(context.dispatcher, method, params);
    const receipt = receiptOf(response, `${method} sweep`);
    assert.ok(
      ["accepted", "possibly_sent"].includes(receipt.dispatch_status),
      `${method}: dispatch_status ∈ {accepted, possibly_sent}（实际 ${receipt.dispatch_status}）`,
    );
    assert.equal(context.session.heldMirrorSize, 0, `${method}: 收据时点 held 镜像恒空`);
    assert.equal(context.driver.state.held.size, 0, `${method}: 收据时点 native held 恒空`);
    return receipt;
  };
  const dragParams = {
    from_target: { type: "coordinate", x: 1, y: 1 },
    to: { type: "coordinate", x: 6, y: 3 },
    app_ref: { pid: TEST_PID },
    modifiers: ["shift"],
  };
  // accepted（带修饰键包裹的成功路径也要收口为空）。
  await check("left_click", clickParams({ modifiers: ["ctrl"] }), {});
  await check("scroll", { target: { type: "coordinate", x: 4, y: 2 }, app_ref: { pid: TEST_PID }, scroll_direction: "down", scroll_amount: 1 }, {});
  await check("left_click_drag", dragParams, {});
  await check("type", { text: "abc", app_ref: { pid: TEST_PID } }, {});
  await check("key", { text: "ctrl+shift+a", app_ref: { pid: TEST_PID } }, {});
  await check("paste", { text: "abc", app_ref: { pid: TEST_PID } }, {});
  await check("stop_computer_control", {}, {});
  // possibly_sent（注入原语 Ambiguous）。
  await check("left_click", clickParams({ modifiers: ["ctrl"] }), { behaviors: { mouseUp: () => { throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown"); } } });
  await check("scroll", { target: { type: "coordinate", x: 4, y: 2 }, app_ref: { pid: TEST_PID }, scroll_direction: "down", scroll_amount: 1 }, { behaviors: { scrollAt: () => { throw new NativeAmbiguousError("injection_rejected", "native-dispatch-outcome-unknown"); } } });
  await check("left_click_drag", dragParams, { behaviors: { drag: () => { throw new NativeAmbiguousError("injection_rejected", "native-dispatch-outcome-unknown"); } } });
  await check("type", { text: "abc", app_ref: { pid: TEST_PID } }, { behaviors: { sendText: () => { throw new NativeAmbiguousError("injection_rejected", "native-dispatch-outcome-unknown"); } } });
  await check("key", { text: "ctrl+shift+a", app_ref: { pid: TEST_PID } }, { behaviors: { pressKeys: () => { throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown"); } } });
  await check("paste", { text: "abc", app_ref: { pid: TEST_PID } }, { behaviors: { pressKeys: () => { throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown"); } } });
  await check("stop_computer_control", {}, { behaviors: { releaseAllHeldInputs: () => { throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown"); } } });
  // interrupted（canceled 结果通道）。
  await check("left_click_drag", dragParams, { behaviors: { drag: async () => ({ injectedPoints: 2, canceled: true }) } });
  await check("type", { text: "abc", app_ref: { pid: TEST_PID } }, { behaviors: { sendText: async (text) => ({ injected: 1, total: text.length, canceled: true }) } });
  await check("key", { text: "f13", app_ref: { pid: TEST_PID }, hold_seconds: 1 }, { behaviors: { pressKeys: async () => ({ canceled: true }) } });
});

test("seam|held 生命周期（规则 3 退出路径）：createExitConvergence 统一收口——cancel 先于 release、幂等、预算封顶", async () => {
  const events = [];
  let releaseSettled = false;
  const convergence = createExitConvergence({
    cancel: () => events.push("cancel"),
    release: async () => {
      events.push("release:start");
      await delay(20);
      releaseSettled = true;
      events.push("release:end");
      return { released: 2 };
    },
    budgetMs: 300,
  });
  await convergence.converge();
  assert.deepEqual(events, ["cancel", "release:start", "release:end"], "cancel 先于 release（顺序断言）");
  assert.equal(releaseSettled, true);
  // 幂等：重复 converge（模拟 beginShutdown 与 scheduleFailure 双路径都经统一收口点）
  // 不再执行释放——计数不增长。
  events.length = 0;
  await convergence.converge();
  await convergence.converge();
  assert.deepEqual(events, [], "幂等：释放只执行一次");
  // 预算封顶：release 悬挂 → converge 仍在 ≤budget 内 resolve（超时兜底后仍退出）。
  const slow = createExitConvergence({
    cancel: () => {},
    release: () => new Promise(() => {}),  // 永不 settle
    budgetMs: 60,
  });
  const startedAt = Date.now();
  await slow.converge();
  assert.ok(Date.now() - startedAt < 500, "悬挂 release 被预算封顶（≤300ms 契约的测试缩放）");
  // A3 poison 自终结分支的桩：任何调用方（第三退出路径）经同一 converge 都被覆盖。
  const poisonPathCalls = [];
  const poisonConvergence = createExitConvergence({
    cancel: () => poisonPathCalls.push("cancel"),
    release: async () => {
      poisonPathCalls.push("release");
      return { released: 0 };
    },
  });
  await poisonConvergence.converge();  // 模拟 A3 poisoned≥3 自终结调用同一收口
  assert.deepEqual(poisonPathCalls, ["cancel", "release"], "A3 poison 桩路径同样经统一收口");
});

test("seam|watchdog 自适应（§10.8）：held 空 2000ms / 非空 250ms；镜像迁移触发回调", () => {
  assert.equal(watchdogIntervalMs(false), 2000);
  assert.equal(watchdogIntervalMs(true), 250);
  const driver = createFakeDriver();
  let changes = 0;
  const session = createInputSession(driver, { onHeldChange: () => { changes += 1; } });
  assert.equal(session.hasHeldInput(), false);
  session.noteHeld("mouse:left");
  assert.equal(session.hasHeldInput(), true, "镜像非空 → held");
  assert.equal(changes, 1, "0→非空 迁移触发回调");
  session.noteReleased("mouse:left");
  assert.equal(session.hasHeldInput(), false);
  assert.equal(changes, 2, "非空→0 迁移触发回调");
});

// ── 组 6：admission（§10.5）──────────────────────────────────────────────────

test("admission|串行：并发两请求不重叠（并发=1）", async () => {
  let active = 0;
  let maxActive = 0;
  const { dispatcher, frames } = makeContext({
    driver: {
      behaviors: {
        moveTo: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(30);
          active -= 1;
        },
      },
    },
  });
  registerTestFrame(frames);
  await Promise.all([
    wire(dispatcher, "left_click", clickParams()),
    wire(dispatcher, "left_click", clickParams()),
  ]);
  assert.equal(maxActive, 1, "SendInput 序列交错会互相污染——admission 必须串行");
});

test("admission|队满 → controller_busy（未入队 = 确定未派发）", async () => {
  const { dispatcher, frames } = makeContext({
    driver: { behaviors: { moveTo: () => delay(50) } },
  });
  registerTestFrame(frames);
  const inflight = [];
  // 1 个在途 + 8 个排队 = 深度上限 8；第 10 个入队即满。
  for (let i = 0; i < 9; i += 1) {
    inflight.push(wire(dispatcher, "left_click", clickParams()));
  }
  await delay(20);
  const overflow = await wire(dispatcher, "left_click", clickParams());
  assertWireError(
    overflow,
    "controller_busy",
    WIRE_ERROR_MESSAGES.controllerBusy,
    "队满 → ok:false controller_busy",
  );
  await Promise.all(inflight);
});

test("admission|排队超时 → controller_busy（确定 not_sent，先于角色 B 10s 超时）", async () => {
  const { dispatcher, frames } = makeContext({
    driver: { behaviors: { moveTo: () => delay(150) } },
    session: { queueTimeoutMs: 40 },
  });
  registerTestFrame(frames);
  const first = wire(dispatcher, "left_click", clickParams());
  await delay(10);
  const second = await wire(dispatcher, "left_click", clickParams());
  assertWireError(second, "controller_busy", WIRE_ERROR_MESSAGES.controllerBusy, "排队 >queueTimeoutMs 放弃");
  await first;
});

test("admission|旁路：broker_info/request_access/stop 不被长操作阻塞（§10.5）", async () => {
  const { dispatcher, frames } = makeContext({
    driver: { behaviors: { drag: () => delay(300) } },
  });
  registerTestFrame(frames);
  const longDrag = wire(dispatcher, "left_click_drag", {
    from_target: { type: "coordinate", x: 1, y: 1 },
    to: { type: "coordinate", x: 6, y: 3 },
    app_ref: { pid: TEST_PID },
  });
  await delay(30);  // drag 在途
  const infoStarted = Date.now();
  const info = await wire(dispatcher, "broker_info");
  assert.equal(info.ok, true);
  assert.ok(Date.now() - infoStarted < 200, "broker_info 旁路：health 300ms ping 预算不得被长观察饿死");
  const accessStarted = Date.now();
  const access = await wire(dispatcher, "request_access", {});
  assert.equal(access.ok, true);
  assert.ok(Date.now() - accessStarted < 200, "request_access 旁路");
  // stop 旁路 = 不入队（它要等的只有在途 settle 本身——§10.6 步骤 ②，不是排队序）。
  const stopStarted = Date.now();
  const stop = await wire(dispatcher, "stop_computer_control", {});
  assert.equal(stop.ok, true);
  assert.ok(Date.now() - stopStarted < 500, "stop 旁路（排队即自废）：只等在途 settle，不排整队");
  await longDrag;
});

// ── 组 7：stop 五步时序（§10.6 钉死，测试按序断言）────────────────────────────

test("stop|五步时序：cancel 先于一切 → 在途以 interrupted 收口 → release → 队列清空各得 controller_busy", async () => {
  const { dispatcher, frames, driver, session } = makeContext({
    driver: {
      behaviors: {
        // 慢速 drag：10ms 粒度检查取消旗（native 同型语义），取消 → canceled:true。
        drag: async (fromX, fromY, toX, toY, opts, state) => {
          state.held.add("mouse:left");
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            if (state.cancelFlag) {
              state.held.delete("mouse:left");
              return { injectedPoints: 4, canceled: true };
            }
            await delay(10);
          }
          state.held.delete("mouse:left");
          return { injectedPoints: 16, canceled: false };
        },
      },
    },
  });
  registerTestFrame(frames);
  const dragParams = {
    from_target: { type: "coordinate", x: 1, y: 1 },
    to: { type: "coordinate", x: 6, y: 3 },
    app_ref: { pid: TEST_PID },
  };
  const inFlightDrag = wire(dispatcher, "left_click_drag", dragParams);
  await delay(30);
  const queued = wire(dispatcher, "type", { text: "queued", app_ref: { pid: TEST_PID } });
  const stopResponse = await wire(dispatcher, "stop_computer_control", { reason: "model asked" });
  // ⑤ stop 自身收据。
  const stopReceipt = receiptOf(stopResponse, "stop");
  assert.equal(stopReceipt.message, RECEIPT_MESSAGES.stopped);
  assert.equal(stopReceipt.action_sent, true);
  // reason 接受即丢弃（§10.2）：不回显、不进收据。
  assert.ok(!JSON.stringify(stopReceipt).includes("model asked"), "reason 绝不回显（隐私面）");
  // ② 在途 drag 以 interrupted 收据收口。
  const dragReceipt = receiptOf(await inFlightDrag, "in-flight drag");
  assert.equal(dragReceipt.dispatch_status, "accepted");
  assert.equal(dragReceipt.action_sent, true);
  assert.equal(dragReceipt.code, "controller_busy");
  assert.equal(dragReceipt.message, RECEIPT_MESSAGES.interruptedByStop);
  // ④ 被清的排队请求 → ok:false controller_busy（排队未派发 = 确定 not_sent）。
  assertWireError(await queued, "controller_busy", WIRE_ERROR_MESSAGES.controllerBusy, "被 stop 清空的排队请求");
  // ①③ 顺序：cancelOperations 先于一切；release 在在途 settle 之后执行。
  const events = driver.state.events;
  const cancelIndex = events.indexOf("cancelOperations");
  const releaseIndex = events.indexOf("releaseAllHeldInputs");
  assert.ok(cancelIndex !== -1 && releaseIndex !== -1, "cancel 与 release 都执行");
  assert.ok(cancelIndex < releaseIndex, "① cancelOperations 先于 ③ releaseAllHeldInputs");
  assert.equal(session.heldMirrorSize, 0, "stop 后镜像清空");
  assert.equal(driver.state.held.size, 0, "stop 后 fake native held 清空");
  // stop 非会话闩锁：stop 后的新动作正常受理。
  const after = await wire(dispatcher, "type", { text: "after-stop", app_ref: { pid: TEST_PID } });
  const afterReceipt = receiptOf(after, "after stop");
  assert.equal(afterReceipt.dispatch_status, "accepted", "stop 后的新动作正常受理（§10.6）");
});

test("stop|自身失败：release Ambiguous → possibly_sent 收据；release Rejected → ok:false internal", async () => {
  {
    const { dispatcher } = makeContext({
      driver: {
        behaviors: {
          releaseAllHeldInputs: () => {
            throw new NativeAmbiguousError("internal_native", "native-dispatch-outcome-unknown");
          },
        },
      },
    });
    const receipt = receiptOf(await wire(dispatcher, "stop_computer_control", {}), "stop ambiguous");
    assert.equal(receipt.dispatch_status, "possibly_sent", "释放不可证 → 保守方向（§10.6）");
    assert.equal(receipt.action_sent, true);
  }
  {
    const { dispatcher } = makeContext({
      driver: {
        behaviors: {
          releaseAllHeldInputs: () => {
            throw new NativeRejectedError("internal_native");
          },
        },
      },
    });
    const response = await wire(dispatcher, "stop_computer_control", {});
    assertWireError(response, "internal", WIRE_ERROR_MESSAGES.internal, "release 确定失败（派发前）→ ok:false internal");
  }
});

// ── 组 8：paste 剪贴板语义（§10.9）───────────────────────────────────────────

test("paste|剪贴板写入失败 → ok:false（busy→controller_busy / denied→permission_denied）∧ Ctrl+V 零调用", async () => {
  for (const [code, wireCode, message] of [
    ["clipboard_busy", "controller_busy", WIRE_ERROR_MESSAGES.clipboardBusy],
    ["clipboard_denied", "permission_denied", WIRE_ERROR_MESSAGES.clipboardDenied],
  ]) {
    const { dispatcher, driver } = makeContext({
      driver: {
        behaviors: {
          clipboardWriteText: () => {
            throw new NativeRejectedError(code);
          },
        },
      },
    });
    const response = await wire(dispatcher, "paste", { text: "x", app_ref: { pid: TEST_PID } });
    assertWireError(response, wireCode, message, `paste ${code}`);
    assert.equal(countCalls(driver, "pressKeys"), 0, `${code}: Ctrl+V 零调用（剪贴板未写入 = 确定未派发）`);
  }
});

test("paste|剪贴板已写入但 Ctrl+V 未注入即失败 → accepted+action_sent:true 收据（绝不是 not_sent，§10.9）", async () => {
  const { dispatcher, driver, session } = makeContext({
    driver: {
      behaviors: {
        pressKeys: () => {
          throw new NativeRejectedError("foreground_lost");
        },
      },
    },
  });
  const response = await wire(dispatcher, "paste", { text: "x", app_ref: { pid: TEST_PID } });
  assert.equal(response.ok, true, "剪贴板副作用已发生 → 禁止 ok:false");
  assert.equal(response.result.isError, true);
  const receipt = receiptOf(response, "paste clipboard-modified");
  assert.equal(receipt.dispatch_status, "accepted");
  assert.equal(receipt.action_sent, true);
  assert.equal(receipt.code, "internal", "§10.12 行 3 码词汇 {controller_busy, internal}");
  assert.equal(receipt.message, RECEIPT_MESSAGES.clipboardModifiedPasteIncomplete, "message 固定字面量如实标注 clipboard-modified");
  assert.equal(receipt.clipboard_modified, true);
  assert.equal(countCalls(driver, "clipboardWriteText"), 1, "剪贴板确实已写入");
  assert.equal(session.heldMirrorSize, 0);
});

// ── 组 9：request_access / broker_info capabilities（§10.9/A2-AC-10）─────────

test("request_access|快照形态 + _meta 状态块 + 非交互桌面诚实报告（结果永不失败，除参数面）", async () => {
  {
    const { dispatcher } = makeContext();
    const response = await wire(dispatcher, "request_access", {});
    assert.equal(response.ok, true);
    const status = receiptOf(response, "request_access");
    assert.deepEqual(status, {
      ready: true,
      platform: "win32",
      accessibility: "granted",
      screen_recording: "granted",
    }, "预检过 + 导出在场 → granted/granted（'stale' Windows 永不产出）");
    const meta = response.result._meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY];
    assert.ok(meta, "_meta 状态块必须在（键 = request-access-contract.js:1 同值）");
    assert.deepEqual(meta, {
      schemaVersion: 1,
      platform: "win32",
      grantOwner: process.execPath,
      accessibility: "granted",
      screenRecording: "granted",
    }, "§12.2 形态（camelCase；grantOwner = Helper canonical exe）");
  }
  {
    // 非交互桌面 → ok:true + ready:false + denied/denied（只读快照诚实报告不可用 ≠ 方法失败）。
    const { dispatcher } = makeContext({
      driver: { env: { interactiveDesktop: false, sessionZero: false, dpiAware: true } },
    });
    const response = await wire(dispatcher, "request_access", {});
    assert.equal(response.ok, true, "非交互桌面不是 request_access 的失败");
    const status = receiptOf(response, "request_access denied");
    assert.deepEqual(status, {
      ready: false,
      platform: "win32",
      accessibility: "denied",
      screen_recording: "denied",
    });
  }
  {
    // capture 导出缺席 → screen_recording "unknown"（A2 前过渡态语义）。
    const { dispatcher } = makeContext({
      driver: { presence: { input: true, capture: false, clipboard: true } },
    });
    const status = receiptOf(await wire(dispatcher, "request_access", {}), "request_access unknown");
    assert.equal(status.screen_recording, "unknown");
    assert.equal(status.ready, true);
  }
  {
    // capabilities 参数：未知 capability 名忽略（接受、不拒绝、形状不变）。
    const { dispatcher } = makeContext();
    const status = receiptOf(
      await wire(dispatcher, "request_access", { capabilities: ["totally_unknown", "screen_recording"] }),
      "request_access capabilities",
    );
    assert.deepEqual(Object.keys(status).sort(), ["accessibility", "platform", "ready", "screen_recording"], "四键形状钉死（过滤面 A2 = no-op，spec 回写登记）");
  }
});

test("broker_info|capabilities 一致性（A2-AC-10）：capability=true ⟺ handler 注册；presence=false ⟺ unimplemented", async () => {
  // 全在场：capabilities 全 true ∧ 8 方法注册（≠unimplemented）∧ 6 UIA 方法保持 unimplemented。
  {
    const { dispatcher, frames } = makeContext();
    registerTestFrame(frames);
    const info = await wire(dispatcher, "broker_info");
    assert.equal(info.ok, true);
    assert.deepEqual(info.result.capabilities, { input: true, capture: true, clipboard: true });
    assert.equal(info.result.pid, process.pid);
    assert.equal(info.result.bundle_id, process.execPath, "A1 最小诚实面保持（health 门 load-bearing）");
    for (const method of SEVEN_MUTATING) {
      const response = await wire(dispatcher, method, method === "stop_computer_control" ? {} : undefined);
      // 无参调用会得到 invalid_request（缺必填）——关键断言是「不是 unimplemented」。
      const code = response.ok ? undefined : response.error.code;
      assert.notEqual(code, "unimplemented", `${method}: capability=true ⟺ handler 已注册`);
    }
    for (const method of ["list_apps", "list_windows", "get_app_state", "set_value", "select_text", "perform_action"]) {
      const response = await wire(dispatcher, method, {});
      assertWireError(response, "unimplemented", WIRE_ERROR_MESSAGES.unimplemented, `${method}: A3 面保持 unimplemented（C09）`);
    }
  }
  // input 缺席：capabilities.input=false ∧ 输入类方法 unimplemented（两面同源）。
  {
    const { dispatcher } = makeContext({
      driver: { presence: { input: false, capture: true, clipboard: true } },
    });
    const info = await wire(dispatcher, "broker_info");
    assert.deepEqual(info.result.capabilities, { input: false, capture: true, clipboard: true });
    for (const method of ["left_click", "scroll", "left_click_drag", "type", "key", "stop_computer_control"]) {
      assertWireError(
        await wire(dispatcher, method, {}),
        "unimplemented",
        WIRE_ERROR_MESSAGES.unimplemented,
        `${method}: presence=false ⟺ unimplemented`,
      );
    }
    // paste 需要 input+clipboard 双面 → 同样 unimplemented。
    assertWireError(await wire(dispatcher, "paste", {}), "unimplemented", WIRE_ERROR_MESSAGES.unimplemented, "paste 依赖 input");
    // request_access 保持注册（它是能力报告面本身）。
    assert.equal((await wire(dispatcher, "request_access", {})).ok, true);
  }
  // clipboard 缺席：paste unimplemented ∧ clipboard=false；input 面不受影响。
  {
    const { dispatcher } = makeContext({
      driver: { presence: { input: true, capture: true, clipboard: false } },
    });
    const info = await wire(dispatcher, "broker_info");
    assert.equal(info.result.capabilities.clipboard, false);
    assertWireError(await wire(dispatcher, "paste", {}), "unimplemented", WIRE_ERROR_MESSAGES.unimplemented, "paste ⟺ clipboard");
    assert.notEqual((await wire(dispatcher, "type", {})).error?.code, "unimplemented", "type 不受 clipboard 影响");
  }
  // preflight 失败：capabilities 全 false（现算不缓存）但 handler 仍注册 → permission_denied
  // （注册 = presence 静态事实；capability = presence ∧ preflight 动态事实，§10.9）。
  {
    const { dispatcher } = makeContext({
      driver: { env: { interactiveDesktop: false, sessionZero: false, dpiAware: true } },
    });
    const info = await wire(dispatcher, "broker_info");
    assert.deepEqual(info.result.capabilities, { input: false, capture: false, clipboard: false });
    assert.equal(info.result.pid, process.pid, "preflight 失败不影响 health 面");
  }
});

// ── 组 10：keymap 封闭集（§10.9）─────────────────────────────────────────────

test("keymap|封闭词汇全量解析 + 未知键名 undefined + 序列形态（downs→ups 逆序）", () => {
  // 封闭集全量：a-z、0-9、f1-f24、命名键、方向键、标点、修饰键。
  const vocab = [
    ..."abcdefghijklmnopqrstuvwxyz".split(""),
    ..."0123456789".split(""),
    ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
    "esc", "tab", "space", "enter", "backspace", "delete", "insert", "home", "end",
    "pageup", "pagedown", "up", "down", "left", "right",
    "ctrl", "alt", "shift", "win",
    "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
  ];
  for (const key of vocab) {
    const sequence = parseKeyChord(key);
    assert.ok(Array.isArray(sequence) && sequence.length === 2, `${key}: 裸键 = down+up`);
    assert.deepEqual(sequence[0], { vk: sequence[0].vk, up: false }, `${key}: down 先`);
    assert.deepEqual(sequence[1], { vk: sequence[0].vk, up: true }, `${key}: up 后（同 VK）`);
    assert.ok(Number.isInteger(sequence[0].vk) && sequence[0].vk > 0 && sequence[0].vk <= 0xff, `${key}: VK 合法`);
  }
  // chord 形态。
  const ctrlShiftA = parseKeyChord("ctrl+shift+a");
  assert.deepEqual(ctrlShiftA, [
    { vk: 0x11, up: false }, { vk: 0x10, up: false }, { vk: 0x41, up: false },
    { vk: 0x41, up: true }, { vk: 0x10, up: true }, { vk: 0x11, up: true },
  ], "修饰 down → 主键 down → 主键 up → 修饰 up（逆序）");
  assert.equal(parseKeyChord("f13")[0].vk, 0x7c, "f13 = VK_F13（--pointer 烟测无害键）");
  assert.equal(parseKeyChord("CTRL+A")[0].vk, 0x11, "大小写不敏感（归一小写后查封闭表）");
  // 未知/畸形 → undefined（wire 层 invalid_request，绝不猜 VK）。
  for (const bad of ["hyper+a", "f25", "", "  ", "ctrl+", "+a", "a++b", "ctrl+ctrl+a", 42, null, "中文", "CTRL+alt+del+x"]) {
    assert.equal(parseKeyChord(bad), undefined, `${String(bad)}: 拒绝`);
  }
  // paste 固定序列 = ctrl+v。
  assert.deepEqual(PASTE_CHORD_SEQUENCE, parseKeyChord("ctrl+v"), "PASTE_CHORD_SEQUENCE = ctrl+v");
});

// ── 组 11：wire-server A2 扩充面 ─────────────────────────────────────────────

test("wire-server|防御分支：handler 抛非类型化异常 → internal 封闭字面量、异常文本零插值（§3.2/§4.6.1）", async () => {
  // WireRequestFailure 通道（typed 失败 → 自带字面量）已由全部参数/预检/app_ref 用例
  // 覆盖（assertWireError 精确 deepEqual 即零插值证明）；本用例钉防御分支：
  // 非类型化异常（如 driver 环境探针内部炸）→ message 恒 internal 字面量。
  const { dispatcher } = makeContext({
    driver: {
      behaviors: {
        environmentProbe: () => {
          throw new Error("secret internal details must not leak");
        },
      },
    },
  });
  const response = await wire(dispatcher, "request_access", {});
  assertWireError(response, "internal", WIRE_ERROR_MESSAGES.internal, "防御分支：零插值");
  assert.ok(!JSON.stringify(response).includes("secret"), "异常 message 绝不进 wire（§3.2）");
});

test("iron-law|READY 期任何 handler 不产 broker_unavailable（铁律 2：仅限 WARMING）", async () => {
  const { dispatcher, frames } = makeContext();
  registerTestFrame(frames);
  const probes = [
    ["left_click", clickParams({ app_ref: { pid: DEAD_PID } })],
    ["type", { text: "x".repeat(40_000), app_ref: { pid: TEST_PID } }],
    ["key", { text: "nope", app_ref: { pid: TEST_PID } }],
    ["paste", { text: "x", app_ref: { pid: TEST_PID }, format: "rtf" }],
    ["stop_computer_control", { reason: 1 }],
    ["request_access", { capabilities: {} }],
    ["broker_info", {}],
  ];
  for (const [method, params] of probes) {
    const response = await wire(dispatcher, method, params);
    if (!response.ok) {
      assert.notEqual(response.error.code, "broker_unavailable", `${method}: READY 后结构性禁产`);
    }
  }
});

test("session|SessionBusyError 三形态（queue-full/queue-timeout/stopped）都是确定性拒绝", async () => {
  const driver = createFakeDriver();
  // 形态一/二：队满 + 排队超时（短超时夹具）。
  const session = createInputSession(driver, { maxQueueDepth: 1, queueTimeoutMs: 30 });
  const slow = session.submit("drag", () => delay(120));
  const queued = session.submit("drag", () => delay(1));
  const overflow = session.submit("drag", () => delay(1));
  await assert.rejects(overflow, (error) => error instanceof SessionBusyError && error.reason === "queue-full");
  await assert.rejects(queued, (error) => error instanceof SessionBusyError && error.reason === "queue-timeout");
  await slow;
  // 形态三：stopped——stop 清空的排队项。用独立 session（宽超时），排除 queue-timeout
  // 先行触发的竞态：本形态断言的是「stop 清空」这条路径本身。
  const session2 = createInputSession(driver, { queueTimeoutMs: 5_000 });
  const blocker = session2.submit("drag", () => delay(60));
  await delay(10);
  const queuedStop = session2.submit("drag", () => delay(1));
  const stopOutcome = session2.stop();
  await assert.rejects(queuedStop, (error) => error instanceof SessionBusyError && error.reason === "stopped");
  await stopOutcome;
  await blocker;  // 在途项以正常结果收口（cancel 旗对 fake delay 无效——真实 native 才有取消环）
});
