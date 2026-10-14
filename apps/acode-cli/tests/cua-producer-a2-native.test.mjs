/**
 * cua-producer A2 native 真机测试（specs/windows-helper-producer.md §10.11——win32 +
 * 工件双守卫，§6.1 同律：非 Windows 或工件缺失即整文件 skip，ubuntu CI 安全）。
 *
 * **默认套件零真实副作用纪律（§10.11 硬规则，逐用例钉死）**：本文件在 win32 开发机上随
 * `pnpm --dir apps/acode-cli test` 实跑，任何用例都不得向开发机留下真实注入、剪贴板覆写
 * 或前台应用可见变更：
 * - 只读投影面（environmentProbe/foregroundPid/cursorPosition/asyncKeyState/
 *   heldInputSnapshot/processExecutablePath）：零副作用；heldInputSnapshot 断言初值为空
 *   （不断言非空——非空须实压，默认套件禁实压）；
 * - moveTo 负控制：确认已死 pid → foreground_lost + cursorPosition 前后一致（校验先于
 *   注入拒绝 = 零注入的系统事实佐证）；
 * - captureDisplay 实捕：只读 WGC 单次屏幕读回；图像字节不落盘、不打印、断言即弃
 *   （屏幕内容是隐私面）；
 * - clipboardWriteText：仅超限拒绝面（8 Mi+1 → 参数校验先于 OpenClipboard，零剪贴板写）；
 *   happy-path 写入不进默认套件（真实覆写开发机剪贴板且不可恢复——producer 无读回导出，
 *   「恢复原文本 = 测试夹具义务」在 ACode 导出面上结构性不可履行，§10.11 裁决）；
 * - held 释放：不实压任何键/鼠（实压 = 真实注入）——held 语义真机面 = --pointer 步骤 4
 *   （人工门禁）；默认套件的顺序/计数/镜像断言全在 a2-logic fake 面；
 * - wire 级 8 handler 形态：仅负控制夹具（死 pid / 前台负控制 / 非法参数 / element 拒绝 /
 *   request_access 只读快照）——全部落「确定未派发」域，零真实注入、零剪贴板写、零破坏。
 *
 * 导入纪律（§6.1）：addon 经 createRequire 在守卫后的测试体内加载；producer src TS 经
 * tsx 动态导入（纯逻辑模块、平台无关，顶层导入 ubuntu 安全）；静态顶层 import 只有
 * node: 内建、node:test/assert 与恒在的仓内角色 B 源文件。
 */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BrokerError,
  callBrokerMethod,
} from "../../../packages/acode-cua/broker.js";
import { createComputerUseRuntime } from "../../../packages/acode-cua/index.js";
import { importProducerModule } from "./cua-producer-a2-fake.mjs";

// 字面量单一来源（防漂移：直接取 producer src 的封闭表，不在测试内复制表达）。
const { WIRE_ERROR_MESSAGES } = await importProducerModule("wire-server");
const { RECEIPT_MESSAGES, CUA_REQUEST_ACCESS_STATUS_META_KEY } =
  await importProducerModule("backend-a2");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerRoot = join(repoRoot, "cua-producer");
const entryPath = join(producerRoot, "dist", "windows-helper.js");
const addonPath = join(producerRoot, "build", "Release", "ax_native.node");

const ADDON_ENV = "ACODE_CUA_HELPER_ADDON";
const VK_F13 = 0x7c;
const CAPTURE_MAX_DIMENSION = 2000;
const CAPTURE_INLINE_BASE64_BUDGET_BYTES = 200 * 1024;

// ── 双重守卫（§6.1 第 2 条同律）───────────────────────────────────────────────
const skipReason =
  process.platform !== "win32"
    ? "cua-producer A2 native tests require win32 (named pipe + MSVC-built addon)"
    : !existsSync(entryPath) || !existsSync(addonPath)
      ? "cua-producer artifacts missing (dist/windows-helper.js + build/Release/ax_native.node); run `npm install && npm run build` inside cua-producer"
      : false;

/** addon 只在守卫后的测试体内加载（ubuntu 上工件缺失，顶层 require 会炸穿守卫）。 */
function loadAddon() {
  return createRequire(import.meta.url)(addonPath);
}

function mintTestPipe() {
  return `\\\\.\\pipe\\acode-cua-a2-test-${randomUUID()}`;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 铸一个确认已消失的 pid（负控制夹具；复核 ESRCH 防即刻复用）。 */
async function mintConfirmedDeadPid() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pid = await new Promise((resolvePromise, rejectPromise) => {
      const probe = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      probe.once("error", rejectPromise);
      probe.once("exit", () => resolvePromise(probe.pid));
    });
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return pid;
    }
  }
  throw new Error("could not mint a confirmed-dead pid");
}

/**
 * 铸一个「确认存活且永不成为前台」的 pid（前台负控制夹具）：windowsHide 的长睡进程
 * 无窗口 ⇒ GetForegroundWindow 永不归属它 ⇒ native 前台校验确定性拒绝、零注入。
 */
function spawnHiddenSleeper(ms = 30_000) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], {
    stdio: "ignore",
    windowsHide: true,
  });
  return child;
}

/** 按宿主 fork 面拉起真 Helper（与 helper-a1 夹具同构，§2.1）。 */
function startHelper(socketPath) {
  const argv = ["--socket", socketPath, "--parent-pid", String(process.pid)];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", [ADDON_ENV]: addonPath };
  const child = fork(entryPath, argv, {
    cwd: producerRoot,
    execPath: process.execPath,
    execArgv: [],
    silent: true,
    env,
  });
  const helper = {
    child,
    socketPath,
    stderr: "",
    ipcMessages: [],
    exited: new Promise((resolvePromise) => {
      child.once("exit", (code) => resolvePromise(code));
    }),
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    helper.stderr += chunk;
  });
  // 持久监听累积（竞态安全的等待形态——轮询 race 的悬空 once 监听会吞消息）。
  child.on("message", (message) => helper.ipcMessages.push(message));
  child.on("error", () => {});
  return helper;
}

async function waitForReady(helper, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (helper.ipcMessages.some((message) => message?.type === "ready")) return;
    if (Date.now() > deadline) {
      assert.fail(`helper did not become ready within ${timeoutMs}ms; stderr: ${helper.stderr}`);
    }
    await delay(20);
  }
}

// ── addon 只读面（零副作用）───────────────────────────────────────────────────

test("native|导出面封闭：A2 全导出在场且 typeof 精确（§10.1 + processExecutablePath 回写）", { skip: skipReason }, () => {
  const addon = loadAddon();
  const expectedFunctions = [
    "probe",
    "environmentProbe",
    "foregroundPid",
    "heldInputSnapshot",
    "asyncKeyState",
    "cursorPosition",
    "processExecutablePath",
    "releaseAllHeldInputs",
    "moveTo",
    "scrollAt",
    "drag",
    "mouseDown",
    "mouseUp",
    "sendText",
    "pressKeys",
    "clipboardWriteText",
    "captureDisplay",
    "captureWindow",
  ];
  for (const name of expectedFunctions) {
    assert.equal(typeof addon[name], "function", `${name} 必须是函数导出`);
  }
  assert.equal(typeof addon.cancelOperations, "function", "cancelOperations 唯一新增同步导出");
  assert.equal(typeof addon.addonVersion, "string");
  // 导出面封闭：恰好 20 键（能力面溢出禁止——不导出 clipboardReadText 等，§10.1 注记 4）。
  assert.deepEqual(Object.keys(addon).sort(), [...expectedFunctions, "addonVersion", "cancelOperations"].sort());
});

test("native|只读投影面真实性：environmentProbe/foregroundPid/cursorPosition/asyncKeyState/heldInputSnapshot（零副作用）", { skip: skipReason }, async () => {
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  for (const key of ["interactiveDesktop", "sessionZero", "dpiAware"]) {
    assert.equal(typeof environment[key], "boolean", `environmentProbe.${key} 布尔`);
  }
  const foreground = await addon.foregroundPid();
  assert.ok(
    foreground.pid === null || (Number.isInteger(foreground.pid) && foreground.pid > 0),
    "foregroundPid: pid null 或正整数",
  );
  const cursor = await addon.cursorPosition();
  assert.ok(Number.isFinite(cursor.x) && Number.isFinite(cursor.y), "cursorPosition 有限数值");
  const f13 = await addon.asyncKeyState(VK_F13);
  assert.equal(f13.down, false, "f13（标准键盘无此物理键）系统级键态 = up");
  // held 初值为空（不断言非空——非空须实压，默认套件禁实压，§10.11 用例表）。
  const held = await addon.heldInputSnapshot();
  assert.deepEqual(held, { buttons: [], keys: [] }, "heldInputSnapshot 初值为空");
});

/**
 * 光标零移动取证（§10.4「cursorPosition 前后一致 = 零注入的系统事实佐证」的门禁稳定性
 * 缓解，2026-10-14 评审修复）：光标全等断言暴露于操作者物理鼠标移动的瞬态——负控制路径
 * 结构上不触指针（校验先于注入拒绝），但断言窗口内的任何真实鼠标活动都会让全等假红。
 * 判据本身不变（spec 钉死「前后一致」，不删断言、不加容差），改为**在静止窗口内取证**：
 * 有界重采样——每次尝试先确认光标静止（两次采样相等），再执行 action，再全等复核；
 * 不等 ⇒ 瞬态（物理移动）⇒ 重试；系统性注入会让**每一次**静止窗口尝试都失败（下方
 * assert.fail 带完整事实炸出）。默认套件仍零真实注入；操作者持续剧烈移动鼠标的极端
 * 场景下取证窗口耗尽 = 诚实失败（spec §18 第 15 条登记：门禁运行以桌面大体静止为前提，
 * 与 --pointer 的「操作者在场」语境同律）。
 */
async function withCursorZeroMovementProof(action, { attempts = 12, quietMs = 25 } = {}) {
  const addon = loadAddon();
  let lastDelta = null;
  let quietWindows = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await addon.cursorPosition();
    await delay(quietMs);
    const settled = await addon.cursorPosition();
    if (settled.x !== before.x || settled.y !== before.y) continue; // 桌面未静止，重采样
    quietWindows += 1;
    await action(settled);
    const after = await addon.cursorPosition();
    lastDelta = Math.max(Math.abs(after.x - settled.x), Math.abs(after.y - settled.y));
    if (lastDelta === 0) return { attempts: attempt + 1, quietWindows };
    // 静止窗口内不等：可能是 action 期间落入的物理移动（瞬态）→ 重试；
    // 连续耗尽全部尝试 = 系统性位移（下方断言失败，事实全量进消息）。
  }
  assert.fail(
    `cursor moved across negative control in all ${attempts} attempts (${quietWindows} quiet windows, last delta ${lastDelta}px)——桌面静止时仍复现即「零注入」判据被破坏（非物理移动瞬态）`,
  );
}

test("native|moveTo 负控制：确认已死 pid → foreground_lost ∧ cursorPosition 前后一致（零注入，§10.4 规则 1）", { skip: skipReason }, async () => {
  const addon = loadAddon();
  const deadPid = await mintConfirmedDeadPid();
  let caught = null;
  // 静止窗口取证（withCursorZeroMovementProof 注释：全等判据不变，物理鼠标移动瞬态有界重采样）。
  await withCursorZeroMovementProof(async (origin) => {
    caught = null;
    try {
      await addon.moveTo(origin.x + 40, origin.y + 40, { expectedForegroundPid: deadPid });
    } catch (error) {
      caught = error;
    }
  });
  assert.ok(caught, "死 pid 必须拒绝（无法证明前台 → fail-closed）");
  assert.equal(caught.code, "foreground_lost", "类型化 code（§10.3 封闭集）");
  assert.equal(caught.dispatchStarted, false, "零注入 ⇒ dispatchStarted=false（二分判据事实）");
});

test("native|processExecutablePath：自身 pid → execPath 全等；确认已死 pid → path null（§10.9 app_ref 校验面）", { skip: skipReason }, async () => {
  const addon = loadAddon();
  const self = await addon.processExecutablePath(process.pid);
  assert.equal(self.path, process.execPath, "canonical exe 全路径（QueryFullProcessImageName）");
  const deadPid = await mintConfirmedDeadPid();
  const dead = await addon.processExecutablePath(deadPid);
  assert.equal(dead.path, null, "死亡/不可读 → null → wire「target app is not running」");
});

test("native|captureDisplay 实捕：魔数/尺寸/base64 预算/bounds/budgetFit/scaled 一致性（只读；图像字节不落盘不打印，断言即弃）", { skip: skipReason }, async (t) => {
  const addon = loadAddon();
  const environment = await addon.environmentProbe();
  if (!environment.interactiveDesktop || environment.sessionZero) {
    t.skip("非交互桌面（锁屏/Session 0）：捕获面诚实不可用，非失败");
    return;
  }
  const capture = await addon.captureDisplay(
    { monitorIndex: 0 },
    { maxDimension: CAPTURE_MAX_DIMENSION, inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES },
  );
  const bytes = capture.image;
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, "image 字节非空");
  if (capture.encoding === "png") {
    assert.deepEqual(
      [bytes[0], bytes[1], bytes[2], bytes[3]],
      [0x89, 0x50, 0x4e, 0x47],
      "PNG 魔数与 encoding 一致",
    );
  } else {
    assert.equal(capture.encoding, "jpeg", "encoding 封闭 {png,jpeg}");
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xff, 0xd8, 0xff], "JPEG SOI 与 encoding 一致");
  }
  assert.ok(capture.width > 0 && capture.width <= CAPTURE_MAX_DIMENSION, "width ≤2000 且 >0");
  assert.ok(capture.height > 0 && capture.height <= CAPTURE_MAX_DIMENSION, "height ≤2000 且 >0");
  const base64Bytes = Math.ceil(bytes.length / 3) * 4;
  assert.ok(
    base64Bytes <= CAPTURE_INLINE_BASE64_BUDGET_BYTES,
    `base64 折算 ${base64Bytes} ≤ 200 KiB（宿主通用归一化恒等放行的结构性前提，§10.7）`,
  );
  assert.ok(capture.bounds.width > 0 && capture.bounds.height > 0, "bounds 宽高 >0");
  assert.equal(capture.budgetFit, true, "budgetFit");
  // scaled 与尺寸事实一致（§15.2 --capture 同判据）。
  if (capture.scaled) {
    assert.ok(
      capture.width < capture.bounds.width || capture.height < capture.bounds.height,
      "scaled=true ⇒ 栅格严格小于 bounds",
    );
  } else {
    assert.equal(capture.width, capture.bounds.width, "scaled=false ⇒ 栅格 = bounds");
    assert.equal(capture.height, capture.bounds.height);
  }
  // 屏幕内容是隐私面：字节只在本断言作用域内存在，绝不落盘/打印（结构上无输出路径）。
});

test("native|clipboardWriteText 仅超限拒绝面：8 Mi+1 code units → 参数校验先于 OpenClipboard（零剪贴板写；happy-path 归人工 C07）", { skip: skipReason }, async () => {
  const addon = loadAddon();
  const oversized = "a".repeat(8 * 1024 * 1024 + 1);
  let caught = null;
  try {
    await addon.clipboardWriteText(oversized);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "超限必须拒绝");
  // 参数校验类拒绝 = 无类型化 code（不是 clipboard_busy/denied 的派发面失败）——
  // 结构证明校验先于 OpenClipboard，零剪贴板接触（§10.11 用例表）。
  assert.equal(caught.code, undefined, "拒绝发生在参数校验层（无 native 类型化 code）");
});

test("native|captureWindow（A2 桩）：任何 token → target_changed（窗口注册表属 A3，诚实 fail-closed）", { skip: skipReason }, async () => {
  const addon = loadAddon();
  let caught = null;
  try {
    await addon.captureWindow(12345, {
      maxDimension: CAPTURE_MAX_DIMENSION,
      inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "A2 无窗口注册表 ⇒ 任何 token 不可解析");
  assert.equal(caught.code, "target_changed", "wire → element_unavailable stale 字面量");
});

// ── wire 级 8 handler 形态（真 fork + 真 pipe + 真角色 B；仅负控制夹具）─────────

test("wire|broker_info capabilities + request_access 快照 + stop 收据（真 fork + 真 pipe + 真角色 B）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper(socketPath);
  try {
    await waitForReady(helper);
    // broker_info：A2 capabilities 增量（additive；A1 最小诚实面保持）。
    const info = await callBrokerMethod({ socketPath, method: "broker_info", timeoutMs: 5000 });
    assert.equal(info.pid, helper.child.pid, "health 门 load-bearing 字段");
    assert.equal(info.bundle_id, process.execPath);
    assert.ok(info.capabilities && typeof info.capabilities === "object", "capabilities 子集在场");
    for (const key of ["input", "capture", "clipboard"]) {
      assert.equal(typeof info.capabilities[key], "boolean", `capabilities.${key} 布尔（导出在场 ∧ 预检，每请求现算）`);
    }
    // request_access：只读预检快照 + _meta 状态块（§10.9/§12.2 形态）。
    const access = await callBrokerMethod({ socketPath, method: "request_access", params: {}, timeoutMs: 5000 });
    const status = JSON.parse(access.content[0].text);
    assert.deepEqual(status, access.structuredContent, "文本块与 structuredContent 同键");
    assert.equal(status.platform, "win32");
    assert.equal(typeof status.ready, "boolean");
    assert.ok(["granted", "denied"].includes(status.accessibility), "'stale' Windows 永不产出（§12.2）");
    assert.ok(["granted", "denied", "unknown"].includes(status.screen_recording));
    const meta = access._meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY];
    assert.ok(meta, "_meta 状态块在场（键 = request-access-contract.js:1 同值）");
    assert.deepEqual(meta, {
      schemaVersion: 1,
      platform: "win32",
      grantOwner: process.execPath,
      accessibility: status.accessibility,
      screenRecording: status.screen_recording,
    }, "§12.2 形态");
    // stop_computer_control（空态 no-op）：accepted 收据 + §10.6 固定字面量——安全：
    // 无 held 可释放、无在途可取消（默认套件零破坏）。
    const stop = await callBrokerMethod({ socketPath, method: "stop_computer_control", params: {}, timeoutMs: 5000 });
    assert.equal(stop.isError, undefined, "stop 成功收据非 isError");
    assert.equal(stop.structuredContent.dispatch_status, "accepted");
    assert.equal(stop.structuredContent.action_sent, true);
    assert.equal(stop.structuredContent.message, RECEIPT_MESSAGES.stopped, "§10.6 ⑤ 固定字面量");
    // 只读方法不携带 delivery-state 键（铁律 3）。
    for (const key of ["action_sent", "dispatch_status"]) {
      assert.equal(key in access.structuredContent, false, `request_access 不携带 ${key}`);
    }
  } finally {
    helper.child.kill();
    await helper.exited.catch(() => {});
  }
});

test("wire|负控制夹具全扫：死 pid/前台负控制/非法参数/element 拒绝/无 frame stale/permission_status/UIA unimplemented（零真实注入）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper(socketPath);
  const deadPid = await mintConfirmedDeadPid();
  const sleeper = spawnHiddenSleeper();
  try {
    await waitForReady(helper);
    const call = (method, params) =>
      callBrokerMethod({ socketPath, method, params, timeoutMs: 8000 }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    const expectError = async (method, params, code, message, label) => {
      const outcome = await call(method, params);
      assert.ok(outcome.error instanceof BrokerError, `${label}: 必须抛 BrokerError`);
      assert.equal(outcome.error.code, code, `${label}: code`);
      assert.equal(outcome.error.message, message, `${label}: 封闭字面量零插值`);
      assert.equal(outcome.error.details?.possiblySent, false, `${label}: 确定未派发（ok:false 不置歧义）`);
    };

    // ① app_ref = 确认已死 pid → 「target app is not running」（派发前拒绝）。
    await expectError(
      "type",
      { text: "hello", app_ref: { pid: deadPid } },
      "invalid_request",
      WIRE_ERROR_MESSAGES.appNotRunning,
      "type 死 pid",
    );

    // ② 前台负控制：确认存活但永不为前台的隐藏进程 → foreground_required、零注入。
    //    零注入的系统事实佐证 = 光标零移动（type 路径结构上不触指针——sendText 仅键盘、
    //    native 前台校验先于注入拒绝；光标全等取证走静止窗口有界重采样，
    //    withCursorZeroMovementProof 注释：物理鼠标移动瞬态不得假红门禁）。
    await withCursorZeroMovementProof(async () => {
      await expectError(
        "type",
        { text: "hello", app_ref: { pid: sleeper.pid } },
        "foreground_required",
        WIRE_ERROR_MESSAGES.foregroundRequired,
        "type 前台负控制（隐藏存活进程）",
      );
    });
    // execute 信封：isError 单文本块 + code（角色 B 供给面，SDK 映射由其自有测试锁定）。
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    const envelope = await runtime.execute({
      toolName: "type",
      arguments: { text: "hello", app_ref: { pid: sleeper.pid } },
    });
    assert.equal(envelope.isError, true, "execute isError 信封");
    assert.equal(JSON.parse(envelope.content[0].text).code, "foreground_required");

    // ③ 非法参数/未知键 → invalid_request 固定字面量。
    await expectError("type", { text: "a".repeat(32_769), app_ref: { pid: sleeper.pid } }, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "type 超限");
    await expectError("key", { text: "hyper+x", app_ref: { pid: sleeper.pid } }, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "key 未知键名");
    await expectError("left_click", { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: sleeper.pid }, evil: true }, "invalid_request", WIRE_ERROR_MESSAGES.invalidParams, "left_click 未知键");

    // ④ element target → A2 诚实拒绝字面量（UIA 面未实现，C09 同律）。
    await expectError(
      "left_click",
      { target: { type: "element", index: 2 }, app_ref: { pid: sleeper.pid } },
      "element_unavailable",
      WIRE_ERROR_MESSAGES.elementTargetsRequireUia,
      "element target",
    );

    // ⑤ 坐标 target 无任何 frame → stale 字面量（A2 无观察面 = 运行期常态，§10.0）。
    await expectError(
      "left_click",
      { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: sleeper.pid } },
      "element_unavailable",
      WIRE_ERROR_MESSAGES.staleObservation,
      "坐标 target 无 frame",
    );

    // ⑥ permission_status 不注册（§9.1：darwin-only 控制面，Windows 收到即
    //    method_not_found 是正确行为，实现者不得「顺手」注册）。
    await expectError("permission_status", {}, "method_not_found", WIRE_ERROR_MESSAGES.methodNotFound, "permission_status");

    // ⑦ 6 个 UIA 方法保持 unimplemented（A3 面，C09：显式不可用、零假成功）。
    for (const method of ["list_apps", "list_windows", "get_app_state", "set_value", "select_text", "perform_action"]) {
      await expectError(method, {}, "unimplemented", WIRE_ERROR_MESSAGES.unimplemented, `${method}（A3 面）`);
    }
  } finally {
    sleeper.kill();
    helper.child.kill();
    await helper.exited.catch(() => {});
  }
});
