/**
 * C08 可执行交付物（specs/windows-helper-producer.md §14；计划书 §7.6 C08 补记）——
 * CI 常驻（ubuntu 必跑）：10 个变更类方法各注入一次失败 → 断言不自动重放，逐一独立
 * 断言、不参数化折叠。A2 批次交付 c08-1..7；c08-8..10（set_value/select_text/
 * perform_action）以 skip:"A3" 占位注册——文件结构一次成型，A3 批次解除 skip。
 *
 * 夹具 = 真 socket（mintBrokerSocketPath：win32 named pipe / posix tmpdir sock）挂
 * createWireDispatcher + createBackendA2(fakeDriver)，再经**真角色 B** callBrokerMethod /
 * createComputerUseRuntime().execute 走完整链路乙——ubuntu 上首次形成 delivery-state
 * 两侧互证（win32 真 native 面由 a2-native 与 smoke 覆盖；真 native 的失败注入不可
 * 确定化，故注入面以 driver seam 为准，§10.3 二分接口）。
 *
 * 每 case 两段注入（同一 case 内的两个独立断言组，§14）：
 * 1. 派发后歧义失败（fake 抛 NativeAmbiguousError）→ ok:true ∧ isError ∧ possibly_sent
 *    收据 ∧ execute 原样透传 ∧ 信封 ≠ CUA_NOT_READY 可重试形态（不自动重放的结构性断言）；
 * 2. 派发前确定拒绝（fake 抛 NativeRejectedError 或该方法等价前置失败）→ ok:false ∧
 *    诚实映射码 ∧ 封闭字面量（零插值）∧ 无 result 键 ∧ BrokerError.details.possiblySent
 *    ===false ∧ 失败后零追加派发调用（无重试/补注入）。
 *
 * 纪律：断言消息含方法名；case 间零共享状态（每段独立 socket/dispatcher/backend/driver）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import {
  NativeAmbiguousError,
  NativeRejectedError,
  TEST_PID,
  countCalls,
  createFakeDriver,
  importProducerModule,
} from "./cua-producer-a2-fake.mjs";
import {
  createFakeUiaDriver,
  countUiaCalls,
} from "./cua-producer-a3-fake.mjs";
import {
  BrokerError,
  callBrokerMethod,
  mintBrokerSocketPath,
} from "../../../packages/acode-cua/broker.js";
import { createComputerUseRuntime } from "../../../packages/acode-cua/index.js";

const { createBackendA2, RECEIPT_MESSAGES } = await importProducerModule("backend-a2");
const { createBackendA3, createElementActionSurface } = await importProducerModule("backend-a3");
const { createAppRefResolver } = await importProducerModule("app-ref");
const { createStateRegistry } = await importProducerModule("state-registry");
const { createInputSession } = await importProducerModule("input-session");
const { createFrameRegistry, appOwnerScope } = await importProducerModule("frame-registry");
const { createWireDispatcher, WIRE_ERROR_MESSAGES, serializeResponse, BROKER_INFO_METHOD } =
  await importProducerModule("wire-server");

// wire spec §4.1 的 17 码词汇表（code 合法性断言锚）。
const SEVENTEEN_CODES = new Set([
  "permission_denied", "not_authorized", "launch_failed", "invalid_request",
  "element_unavailable", "not_settable", "not_selectable", "action_unavailable",
  "foreground_required", "controller_busy", "broker_unavailable", "version_mismatch",
  "stale_socket", "timeout", "unimplemented", "method_not_found", "internal",
]);

/** 每段独立的真 socket wire 夹具（字节级行缓冲与 Helper 同构，§17.2）。
 * options.composed=true 时组合 backend-a2+a3（A3 面 case 用；缺省 false = c08-1..7 原形态不动）。 */
async function startWireFixture(behaviors, options = {}) {
  const driver = createFakeDriver({ behaviors });
  const session = createInputSession(driver);
  const frames = createFrameRegistry();
  frames.register({
    rasterWidth: 8,
    rasterHeight: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 },
    ownerScope: appOwnerScope(TEST_PID),
  });
  let backend = createBackendA2({ driver, session, frames });
  let uia = null;
  if (options.composed) {
    uia = createFakeUiaDriver({ behaviors: options.uiaBehaviors });
    const states = createStateRegistry({
      generation: 7,
      release: (token) => {
        void uia.releaseState(token);
      },
    });
    const resolveAppRef = createAppRefResolver({ driver, uia });
    const elements = createElementActionSurface({ uia, states });
    const a2 = createBackendA2({ driver, session, frames, elements, resolveAppRef, uiaPresence: true });
    const a3 = createBackendA3({
      driver, uia, session, frames, states, resolveAppRef,
      a2BrokerInfo: a2[BROKER_INFO_METHOD],
    });
    backend = { ...a2, ...a3 };
  }
  const dispatcher = createWireDispatcher();
  dispatcher.activate(backend);

  const socketPath = mintBrokerSocketPath();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let responded = false;
    socket.on("data", (chunk) => {
      if (responded) {
        socket.destroy();
        return;
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      responded = true;
      const line = buffer.subarray(0, newline).toString("utf8");
      dispatcher.handleRequestLine(line).then(
        (response) => {
          try {
            socket.write(serializeResponse(response));
            socket.end();
          } catch {
            socket.destroy();
          }
        },
        () => socket.destroy(),
      );
    });
  });
  server.on("error", () => {});
  await new Promise((resolveListen, rejectListen) => {
    server.once("listening", resolveListen);
    server.once("error", rejectListen);
    server.listen(socketPath);
  });
  return {
    socketPath,
    driver,
    uia,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

/** 原始 wire 往返（断言响应对象形态：ok:false 无 result 键等）。 */
async function assertOkFalseShape(socketPath, method, params, label) {
  const { connect } = await import("node:net");
  const text = await new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error(`${label}: raw round trip timed out`));
    }, 8000);
    socket.once("connect", () => socket.write(`${JSON.stringify({ method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(buffer.subarray(0, newline).toString("utf8"));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  const response = JSON.parse(text);
  assert.equal(response.ok, false, `${label}: 必须 ok:false`);
  assert.equal("result" in response, false, `${label}: 失败响应无 result 键（§14）`);
  return response.error;
}

/**
 * 段 1 断言组：派发后歧义失败 → possibly_sent 收据 + execute 原样透传 +
 * 不自动重放的结构性断言（§14 每 case 两段之一；断言消息含方法名）。
 */
async function assertAmbiguousSegment(method, params, behaviors, expectedExtra = {}, options = {}) {
  const fixture = await startWireFixture(behaviors, options);
  try {
    if (options.setup) await options.setup(fixture);
    // wire 级：ok:true ∧ isError ∧ possibly_sent 收据。
    const result = await callBrokerMethod({
      socketPath: fixture.socketPath,
      method,
      params,
      timeoutMs: 8000,
    });
    assert.equal(result.isError, true, `${method}: 歧义失败必须是 isError 收据（绝不 ok:false，铁律 1）`);
    const receipt = result.structuredContent;
    assert.equal(receipt.dispatch_status, "possibly_sent", `${method}: dispatch_status`);
    assert.equal(receipt.action_sent, true, `${method}: action_sent=true（SDK retry=reobserve）`);
    assert.ok(SEVENTEEN_CODES.has(receipt.code), `${method}: code ∈ 17 码词汇表（实际 ${receipt.code}）`);
    assert.ok(
      ["native-dispatch-outcome-unknown", "native-timeout"].includes(receipt.reason),
      `${method}: reason ∈ 封闭集（实际 ${receipt.reason}）`,
    );
    assert.equal(receipt.message, RECEIPT_MESSAGES.possiblySent, `${method}: message 固定字面量`);
    // 文本块与 structuredContent 同键（§10.12）。
    assert.deepEqual(JSON.parse(result.content[0].text), receipt, `${method}: 双载体同键`);
    for (const [key, value] of Object.entries(expectedExtra)) {
      assert.deepEqual(receipt[key], value, `${method}: 收据附加事实 ${key}`);
    }
    // execute 级：信封原样透传（角色 B 不改写成功结果，index.js:97-99）。
    const runtime = createComputerUseRuntime({ brokerSocketPath: fixture.socketPath });
    const envelope = await runtime.execute({ toolName: method, arguments: params });
    assert.equal(envelope.isError, true, `${method}: execute 透传 isError`);
    assert.deepEqual(
      envelope.structuredContent,
      receipt,
      `${method}: execute 信封原样透传（含 possibly_sent 键）`,
    );
    // 不自动重放的结构性断言：信封 ≠ CUA_NOT_READY 可重试形态。
    const payload = JSON.parse(envelope.content[0].text);
    assert.equal(payload.kind, undefined, `${method}: 绝不是 CUA_NOT_READY 信封`);
    assert.equal(payload.retryable, undefined, `${method}: 绝不携带 retryable:true 重试语义`);
  } finally {
    await fixture.close();
  }
}

/**
 * 段 2 断言组：派发前确定拒绝 → ok:false ∧ 诚实映射码 ∧ 封闭字面量（零插值）∧
 * 无 result 键 ∧ possiblySent=false ∧ 失败后零追加派发调用（§14）。
 */
async function assertRejectedSegment(method, params, behaviors, expectedCode, expectedMessage, countChecks, options = {}) {
  const fixture = await startWireFixture(behaviors, options);
  try {
    if (options.setup) await options.setup(fixture);
    // wire 级形态：ok:false、无 result 键、码与字面量精确。
    const error = await assertOkFalseShape(fixture.socketPath, method, params, method);
    assert.equal(error.code, expectedCode, `${method}: 诚实映射码`);
    assert.equal(error.message, expectedMessage, `${method}: §4.6.1 封闭字面量（零插值 = 全等）`);
    // 角色 B 级：BrokerError ∧ details.possiblySent === false（应用层 ok:false 不置歧义）。
    let caught = null;
    try {
      await callBrokerMethod({ socketPath: fixture.socketPath, method, params, timeoutMs: 8000 });
    } catch (callError) {
      caught = callError;
    }
    assert.ok(caught instanceof BrokerError, `${method}: 必须抛 BrokerError`);
    assert.equal(caught.code, expectedCode, `${method}: BrokerError.code 透传`);
    assert.equal(caught.details?.possiblySent, false, `${method}: 确定拒绝不得污染成歧义（§5.4）`);
    // execute 级：isError 信封携带 code（SDK 映射面）。计数断言以「单次调用增量」为口径
    // ——本段共触发三次 handler（raw/callBrokerMethod/execute），增量才证明
    // 「Rejected 失败后零追加派发调用（无重试/补注入）」而非累计噪声。
    const baseline = {};
    for (const injectionMethod of Object.keys(countChecks)) {
      baseline[injectionMethod] = countCalls(fixture.driver, injectionMethod);
    }
    const uiaBaseline = {};
    for (const injectionMethod of Object.keys(options.uiaCountChecks ?? {})) {
      uiaBaseline[injectionMethod] = countUiaCalls(fixture.uia, injectionMethod);
    }
    const runtime = createComputerUseRuntime({ brokerSocketPath: fixture.socketPath });
    const envelope = await runtime.execute({ toolName: method, arguments: params });
    assert.equal(envelope.isError, true, `${method}: execute isError 信封`);
    assert.equal(JSON.parse(envelope.content[0].text).code, expectedCode, `${method}: 信封 code`);
    for (const [injectionMethod, expectedCount] of Object.entries(countChecks)) {
      assert.equal(
        countCalls(fixture.driver, injectionMethod) - baseline[injectionMethod],
        expectedCount,
        `${method}: ${injectionMethod} 单次调用增量（Rejected 失败后零追加动作）`,
      );
    }
    for (const [injectionMethod, expectedCount] of Object.entries(options.uiaCountChecks ?? {})) {
      assert.equal(
        countUiaCalls(fixture.uia, injectionMethod) - uiaBaseline[injectionMethod],
        expectedCount,
        `${method}: ${injectionMethod}（uia 面）单次调用增量（Rejected 失败后零追加动作）`,
      );
    }
  } finally {
    await fixture.close();
  }
}

// ── 各方法的合法参数（到达派发面的最短路径；frame 已在夹具注册）─────────────────

const clickParams = { target: { type: "coordinate", x: 4, y: 2 }, app_ref: { pid: TEST_PID } };
const scrollParams = {
  target: { type: "coordinate", x: 4, y: 2 },
  app_ref: { pid: TEST_PID },
  scroll_direction: "up",
  scroll_amount: 1,
};
const dragParams = {
  from_target: { type: "coordinate", x: 1, y: 1 },
  to: { type: "coordinate", x: 6, y: 3 },
  app_ref: { pid: TEST_PID },
};
const typeParams = { text: "hello", app_ref: { pid: TEST_PID } };
const keyParams = { text: "ctrl+a", app_ref: { pid: TEST_PID } };
const pasteParams = { text: "hello", app_ref: { pid: TEST_PID } };
const stopParams = {};

const ambiguous = (code = "internal_native") => () => {
  throw new NativeAmbiguousError(code, "native-dispatch-outcome-unknown");
};
const rejected = (code) => () => {
  throw new NativeRejectedError(code);
};

// ── c08-1..7（A2 交付；每 case 一个独立 test()，禁止折叠，§14）─────────────────

test("c08-1|left_click：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment("left_click", clickParams, { mouseDown: ambiguous() });
  await assertRejectedSegment(
    "left_click",
    clickParams,
    { moveTo: rejected("foreground_lost") },
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    { moveTo: 1, mouseDown: 0, mouseUp: 0 },
  );
});

test("c08-2|scroll：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment("scroll", scrollParams, { scrollAt: ambiguous("injection_rejected") });
  await assertRejectedSegment(
    "scroll",
    scrollParams,
    { scrollAt: rejected("foreground_lost") },
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    { scrollAt: 1, moveTo: 0 },
  );
});

test("c08-3|left_click_drag：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment("left_click_drag", dragParams, { drag: ambiguous("injection_rejected") });
  await assertRejectedSegment(
    "left_click_drag",
    dragParams,
    { drag: rejected("foreground_lost") },
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    { drag: 1, moveTo: 0 },
  );
});

test("c08-4|type：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment("type", typeParams, { sendText: ambiguous("injection_rejected") });
  await assertRejectedSegment(
    "type",
    typeParams,
    { sendText: rejected("foreground_lost") },
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    { sendText: 1 },
  );
});

test("c08-5|key：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment("key", keyParams, { pressKeys: ambiguous() });
  await assertRejectedSegment(
    "key",
    keyParams,
    { pressKeys: rejected("foreground_lost") },
    "foreground_required",
    WIRE_ERROR_MESSAGES.foregroundRequired,
    { pressKeys: 1 },
  );
});

test("c08-6|paste：失败注入 → 不自动重放（两段断言组；Rejected 段 = 剪贴板前置失败）", async () => {
  // Ambiguous 注入在 Ctrl+V（剪贴板已写入）→ possibly_sent + clipboard_modified 事实。
  await assertAmbiguousSegment("paste", pasteParams, { pressKeys: ambiguous() }, {
    clipboard_modified: true,
  });
  // Rejected 段 = 该方法等价前置失败：clipboard_busy（剪贴板未写入 = 确定未派发）。
  await assertRejectedSegment(
    "paste",
    pasteParams,
    { clipboardWriteText: rejected("clipboard_busy") },
    "controller_busy",
    WIRE_ERROR_MESSAGES.clipboardBusy,
    { clipboardWriteText: 1, pressKeys: 0 },
  );
});

test("c08-7|stop_computer_control：失败注入 → 不自动重放（注入点特殊，§14 纪律）", async () => {
  // Ambiguous 段注入在 releaseAllHeldInputs（释放不可证 → possibly_sent）。
  await assertAmbiguousSegment("stop_computer_control", stopParams, {
    releaseAllHeldInputs: ambiguous(),
  });
  // Rejected 段注入在 cancelOperations 前的参数面（→ ok:false 合法域）：未知键拒绝，
  // 且 cancelOperations/releaseAllHeldInputs 零调用（stop 编排未启动）。
  await assertRejectedSegment(
    "stop_computer_control",
    { evil: true },
    {},
    "invalid_request",
    WIRE_ERROR_MESSAGES.invalidParams,
    { cancelOperations: 0, releaseAllHeldInputs: 0 },
  );
});

// ── c08-8..10（A3 交付：组合 backend + fake uia driver；先观察建立冻结域，再注入失败。
// 两段模板与 c08-1..7 完全同构——Ambiguous 段验 possibly_sent 收据 + execute 透传 +
// 不自动重放结构断言；Rejected 段验 ok:false 封闭字面量 + possiblySent=false + 零追加派发）──

const setValueParams = { target: { type: "element", index: 1 }, app_ref: { pid: TEST_PID }, value: "v" };
const selectTextParams = { target: { type: "element", index: 1 }, app_ref: { pid: TEST_PID }, text_range: [0, 2] };
const performParams = { target: { type: "element", index: 0 }, app_ref: { pid: TEST_PID }, action: "invoke" };

/** 前置观察（每段夹具独立执行）：建立该 scope 的冻结域，element target 才可解析。 */
const observeFirst = async (fixture) => {
  const observed = await callBrokerMethod({
    socketPath: fixture.socketPath,
    method: "get_app_state",
    params: { app_ref: { pid: TEST_PID } },
    timeoutMs: 8000,
  });
  assert.equal(observed.isError, undefined, "前置观察必须成功（冻结域建立）");
};

const a3Options = (uiaBehaviors) => ({
  composed: true,
  uiaBehaviors,
  setup: observeFirst,
});

const ambiguousUia = (code = "internal_native", reason = "native-dispatch-outcome-unknown") => () => {
  throw new NativeAmbiguousError(code, reason);
};
const rejectedUia = (code) => () => {
  throw new NativeRejectedError(code);
};

test("c08-8|set_value：失败注入 → 不自动重放（两段断言组）", async () => {
  // Ambiguous 段：uia_timeout（变更类 pattern 调用超时 = SetValue 可能已生效，§11.1 分流）。
  await assertAmbiguousSegment(
    "set_value",
    setValueParams,
    {},
    {},
    a3Options({ elementSetValue: ambiguousUia("uia_timeout", "native-timeout") }),
  );
  // Rejected 段：stale（活性复验失败 = 确定未派发）。
  await assertRejectedSegment(
    "set_value",
    setValueParams,
    {},
    "element_unavailable",
    WIRE_ERROR_MESSAGES.staleObservation,
    {},
    { ...a3Options({ elementSetValue: rejectedUia("stale") }), uiaCountChecks: { elementSetValue: 1 } },
  );
});

test("c08-9|select_text：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment(
    "select_text",
    selectTextParams,
    {},
    {},
    a3Options({ elementSelectText: ambiguousUia("uia_timeout", "native-timeout") }),
  );
  await assertRejectedSegment(
    "select_text",
    selectTextParams,
    {},
    "not_selectable",
    WIRE_ERROR_MESSAGES.elementNotSelectable,
    {},
    { ...a3Options({ elementSelectText: rejectedUia("not_selectable") }), uiaCountChecks: { elementSelectText: 1 } },
  );
});

test("c08-10|perform_action：失败注入 → 不自动重放（两段断言组）", async () => {
  await assertAmbiguousSegment(
    "perform_action",
    performParams,
    {},
    {},
    a3Options({ elementPerformAction: ambiguousUia() }),
  );
  await assertRejectedSegment(
    "perform_action",
    performParams,
    {},
    "action_unavailable",
    WIRE_ERROR_MESSAGES.elementActionNotAdvertised,
    {},
    { ...a3Options({ elementPerformAction: rejectedUia("action_unavailable") }), uiaCountChecks: { elementPerformAction: 1 } },
  );
});
