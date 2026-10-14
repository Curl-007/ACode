/**
 * 真机烟测共享库（specs/windows-helper-producer.md §15；A3 实现批次自 smoke-real.mjs
 * 拆出——oxlint max-lines 400 治理纪律，「拆模块而非加豁免」，§19 第 15 条）。
 *
 * 本文件承载与输出纪律无关的共享机械件：常量、断言原语（失败一律抛
 * SmokeAssertionError，由层级函数/入口统一转固定结果码）、host 面深导入、A3 三层
 * 共享段（目标应用级联 / wire 截图断言 / 观察断言）。输出纪律（emit/自证泄漏扫描）
 * 留在入口 smoke-real.mjs——那里是 §15.3 stdout/stderr 契约的单一落点。
 */
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const producerRoot = resolve(here, "..");
export const repoRoot = resolve(producerRoot, "..");
export const entryPath = join(producerRoot, "dist", "windows-helper.js");
export const defaultAddonPath = join(producerRoot, "build", "Release", "ax_native.node");
export { existsSync };

// §15.2 --capture 断言常量（§10.7 预算阶梯钉死取值；与 producer driver-contract 同值）。
export const CAPTURE_MAX_DIMENSION = 2000;
export const CAPTURE_INLINE_BASE64_BUDGET_BYTES = 200 * 1024;
// §10.6/§10.12 收据固定字面量（断言锚：wire 面必须逐字供给）。
export const STOPPED_MESSAGE = "Computer Use control stopped; held inputs released.";
export const INTERRUPTED_MESSAGE = "Computer Use action was interrupted by stop_computer_control.";
export const VK_F13 = 0x7c;

// wire 段超时预算：UIA 观察类 native 预算 8s（§11.1），get_app_state 可叠树观察 +
// 窗口截图——超时给足余量，避免正常慢观察被误报为失败。
export const WIRE_OBSERVE_TIMEOUT_MS = 15_000;
export const WIRE_APP_STATE_TIMEOUT_MS = 20_000;
/** §11.4/§15.2 树文本元素行格式（采样行断言用；行内容绝不打印）。 */
export const TREE_ELEMENT_LINE = /^\s*\[[0-9]+\]/;

export class SmokeAssertionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SmokeAssertionError";
    this.reason = reason;  // 固定结果码（绝不插值动态内容）
  }
}

export function assertTrue(condition, reason) {
  if (!condition) throw new SmokeAssertionError(reason);
}

export function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ── host 面（深导入 workspace TS：烟测是仓库侧 dev 工具，§15.1 允许）──────────

export async function importHostSurface() {
  const servicesDir = join(repoRoot, "packages", "services", "src", "cua-permission-broker");
  const runtimeModule = await import(
    pathToFileURL(join(servicesDir, "windowsCuaDevRuntime.ts")).href
  );
  const hostModule = await import(pathToFileURL(join(servicesDir, "windowsCuaDevHelperHost.ts")).href);
  const brokerModule = await import(pathToFileURL(join(repoRoot, "packages", "acode-cua", "broker.js")).href);
  return { ...runtimeModule, ...hostModule, ...brokerModule };
}

export function createCapturingLogger(sink) {
  // 捕获型 logger（ServiceLogger 形状）：host 日志可能含 socketPath——只进内存扫描面，
  // 绝不进本脚本 stdout/stderr。首参 traceId 是 ServiceLogger 签名事实，本脚本不消费。
  const capture = (level) => (_traceId, ...args) => {
    sink.push({ level, args });
  };
  return {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
}

export function probePipeRefused(socketPath) {
  return new Promise((resolvePromise) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolvePromise(false);
    }, 3000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(error?.code === "ENOENT");
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(false);  // 还能连上 = 未拒连
    });
  });
}

/** host.stop() 尽力收口（清理失败不改变层级结论——host 内部有终止链兜底；不新增 stderr 码）。 */
export async function stopHostQuietly(host) {
  try {
    await host.stop();
  } catch {
    // 有意为空：见上。
  }
}

// ── A3 共享段（--capture/--uia/--host 三处复用，单一实现）────────────────────

/** wire 结果健全性：ok:true 信封已由 callBrokerMethod 保证；isError 不得为真（只读观察类）。 */
export function assertWireResultOk(result, reason) {
  assertTrue(result !== null && typeof result === "object" && result.isError !== true, reason);
}

/** bounds 数值判据（x/y 可为负——副屏；width/height 有限数值）。 */
export function isNumericRect(rect) {
  return (
    rect !== null &&
    typeof rect === "object" &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/**
 * 目标应用 pid 级联（A3 实现批次裁决，spec §19 第 4 条；三层单一共享实现）。
 * 只读观察纪律（§15.2）：全程不 spawn 目标应用、不变更、不抢焦点。
 * ① wire list_apps 的 active:true 条目；
 * ② 无 active 时（真机存在 MouseWithoutBordersHelper 类隐形前台窗口霸占
 *    GetForegroundWindow 的环境事实 → active 可全 false），取 addon.foregroundPid()
 *    若在 apps 集合中；
 * ③ 仍无则取 list_windows（无 app_ref = 全量，Z 序最顶可见窗口居首）首条的 app.pid；
 * ④ list_windows 也为空（无任何可见窗口）→ pid=null，由调用方以固定码
 *    no-foreground-app + exit 2 收口（前置不满足，非失败——§15.2/§15.3）。
 */
export async function resolveTargetApp({ callBrokerMethod, socketPath, addon }) {
  const appsResult = await callBrokerMethod({
    socketPath,
    method: "list_apps",
    params: {},
    timeoutMs: WIRE_OBSERVE_TIMEOUT_MS,
  });
  assertWireResultOk(appsResult, "wire-list-apps-failed");
  const apps = appsResult.structuredContent?.apps;
  assertTrue(Array.isArray(apps), "wire-list-apps-shape");
  const active = apps.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      entry.active === true &&
      Number.isInteger(entry.pid) &&
      entry.pid > 0,
  );
  if (active) return { pid: active.pid, apps, source: "active" };
  const foreground = await addon.foregroundPid();
  const foregroundPid =
    Number.isInteger(foreground?.pid) && foreground.pid > 0 ? foreground.pid : null;
  if (foregroundPid !== null && apps.some((entry) => entry !== null && entry?.pid === foregroundPid)) {
    return { pid: foregroundPid, apps, source: "foreground" };
  }
  const windowsResult = await callBrokerMethod({
    socketPath,
    method: "list_windows",
    params: {},
    timeoutMs: WIRE_OBSERVE_TIMEOUT_MS,
  });
  assertWireResultOk(windowsResult, "wire-list-windows-failed");
  const windows = windowsResult.structuredContent?.windows;
  assertTrue(Array.isArray(windows), "wire-list-windows-shape");
  const top = windows[0];
  if (top !== undefined) {
    // 首条存在但 app.pid 非法 = 实现违约（诚实炸出，不落 ④ 的「无窗口」语义）。
    assertTrue(
      top !== null && typeof top === "object" && Number.isInteger(top.app?.pid) && top.app.pid > 0,
      "wire-list-windows-shape",
    );
    return { pid: top.app.pid, apps, source: "top_window" };
  }
  return { pid: null, apps, source: "none" };
}

/** list_apps 条目字段齐套（§15.2：pid/name/bundle_id/exe_path/active/window_count 键在场 + 类型合法）。 */
export function assertAppEntryShape(entry, reason) {
  assertTrue(entry !== null && typeof entry === "object", reason);
  assertTrue(Number.isInteger(entry.pid) && entry.pid > 0, reason);
  assertTrue(typeof entry.name === "string", reason);
  assertTrue(
    "bundle_id" in entry && (entry.bundle_id === null || typeof entry.bundle_id === "string"),
    reason,
  );
  assertTrue(typeof entry.exe_path === "string", reason);
  assertTrue(typeof entry.active === "boolean", reason);
  assertTrue(Number.isInteger(entry.window_count) && entry.window_count >= 0, reason);
}

/** list_windows 条目字段类型合法（window_id 正整数、bounds 数值、title string；内容绝不打印）。 */
export function assertWindowEntryShape(entry, reason) {
  assertTrue(entry !== null && typeof entry === "object", reason);
  assertTrue(Number.isInteger(entry.window_id) && entry.window_id > 0, reason);
  assertTrue(typeof entry.title === "string", reason);
  assertTrue(isNumericRect(entry.bounds), reason);
}

/** wire get_app_state 统一入口（app_ref pid-only；include_screenshot 布尔）。 */
export function callGetAppState(callBrokerMethod, socketPath, pid, includeScreenshot) {
  return callBrokerMethod({
    socketPath,
    method: "get_app_state",
    params: { app_ref: { pid }, include_screenshot: includeScreenshot },
    timeoutMs: WIRE_APP_STATE_TIMEOUT_MS,
  });
}

/**
 * A3 wire 截图段共享断言（--capture A3 扩展与 --host 步骤 4 同判据，§15.2）：
 * image 块存在 ∧ mimeType ∈ {image/png,image/jpeg} ∧ base64 长度折算 ≤200 KiB ∧
 * structuredContent.frame_id 非空（frame 登记发生）。截图失败降级形态
 * （[screenshot unavailable: …] 告知块 + non_actionable_reason）= 段失败——本两层的
 * 语义就是截图必须成功；reason 直接取 §10.3 封闭 native 词汇的固定码（零用户内容，
 * 可安全进 emit 的 reason= 字段）。base64/图像字节绝不打印。
 */
export function assertWireScreenshot(result) {
  assertWireResultOk(result, "wire-app-state-failed");
  const structured = result.structuredContent;
  const degradedReason = structured?.non_actionable_reason;
  if (typeof degradedReason === "string" && degradedReason.length > 0) {
    throw new SmokeAssertionError(degradedReason);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const image = content.find(
    (block) => block !== null && typeof block === "object" && block.type === "image",
  );
  assertTrue(image !== undefined, "wire-screenshot-image-missing");
  assertTrue(
    image.mimeType === "image/png" || image.mimeType === "image/jpeg",
    "wire-screenshot-mime",
  );
  assertTrue(typeof image.data === "string" && image.data.length > 0, "wire-screenshot-data");
  // wire 面 image 块 data 已是 base64 文本——长度即折算字节数（与 A2 段同口径）。
  assertTrue(
    image.data.length <= CAPTURE_INLINE_BASE64_BUDGET_BYTES,
    "wire-screenshot-base64-budget",
  );
  assertTrue(
    typeof structured?.frame_id === "string" && structured.frame_id.length > 0,
    "wire-screenshot-frame-id",
  );
  return { mimeType: image.mimeType, base64Bytes: image.data.length };
}

/**
 * --uia 的单次 get_app_state（无截图）观察 + §15.2 断言面。suffix = 调用点封闭枚举
 * {obs1,obs2}（确定性字面量，非动态内容——用于区分失败落点）。树文本/标题/元素名
 * 只进内存断言，绝不打印。
 */
export async function observeAppState(callBrokerMethod, socketPath, pid, suffix) {
  const result = await callGetAppState(callBrokerMethod, socketPath, pid, false);
  assertWireResultOk(result, `uia-app-state-failed-${suffix}`);
  const structured = result.structuredContent;
  // 四必备字段恒在（§11.2/§15.2：state_id/app/window/elements）。
  assertTrue(
    structured !== null &&
      typeof structured === "object" &&
      "state_id" in structured &&
      "app" in structured &&
      "window" in structured &&
      Array.isArray(structured.elements),
    `uia-structured-shape-${suffix}`,
  );
  const stateId = structured.state_id;
  assertTrue(typeof stateId === "string" && stateId.length > 0, `uia-state-id-missing-${suffix}`);
  assertTrue(structured.app?.pid === pid, `uia-app-pid-mismatch-${suffix}`);
  // window 字段类型合法（title 内容绝不打印）。
  assertTrue(
    structured.window !== null &&
      typeof structured.window === "object" &&
      Number.isInteger(structured.window.window_id) &&
      structured.window.window_id > 0 &&
      typeof structured.window.title === "string" &&
      isNumericRect(structured.window.bounds),
    `uia-window-shape-${suffix}`,
  );
  // C09 诚实空树判据（§11.2/§15.2）：elements 非空 ∨（空 ∧ truncated===false）。
  const elements = structured.elements;
  assertTrue(
    elements.length > 0 || structured.truncated === false,
    `uia-empty-tree-inconsistent-${suffix}`,
  );
  // 树文本采样行：首个匹配 ^\s*\[[0-9]+\] 的行做正则断言（仅 elements 非空时必备）。
  if (elements.length > 0) {
    const text = structured.text;
    assertTrue(typeof text === "string" && text.length > 0, `uia-tree-text-shape-${suffix}`);
    const sampled = text.split("\n").find((line) => TREE_ELEMENT_LINE.test(line));
    assertTrue(
      typeof sampled === "string" && TREE_ELEMENT_LINE.test(sampled),
      `uia-tree-line-format-${suffix}`,
    );
  }
  return { stateId, elementCount: elements.length };
}
