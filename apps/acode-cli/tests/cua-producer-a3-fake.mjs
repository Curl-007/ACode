/**
 * A3 共享测试夹具：可编程 fake UIA driver（specs/windows-helper-producer.md §11/§16.2；
 * §10.11 a2-fake 同律）。非 *.test.mjs——不进 runner glob，仅供 cua-producer-a3-logic
 * 与 cua-producer-c08 两个 CI 常驻测试导入。
 *
 * fake uia driver 直接抛 NativeRejectedError / NativeAmbiguousError 注入失败（§10.3
 * 二分接口）；默认行为模拟 native 的 token 语义（stateToken 单调、windowId 单调、
 * releaseState 记录），支撑 §11.4/§11.5 的索引稳定性与注册表断言（events/calls 日志 =
 * 顺序与计数断言载体）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerSrc = join(repoRoot, "cua-producer", "src");

/** 深导入 producer src TS（tsx 常驻可解析；源文件恒在库，§14）。 */
export async function importProducerModule(name) {
  return import(pathToFileURL(join(producerSrc, `${name}.ts`)).href);
}

export const { NativeRejectedError, NativeAmbiguousError } = await importProducerModule(
  "driver-contract",
);

/** 测试用目标 pid / 已死 pid（与 a2-fake 同值——两夹具可在同一 backend 组合里共存）。 */
export const TEST_PID = 4242;
export const DEAD_PID = 99999999;
export const OTHER_PID = 5150;
export const FAKE_EXE_PATH = "C:\\fake\\target-app.exe";
export const OTHER_EXE_PATH = "C:\\fake\\other-app.exe";
export const PACKAGED_AUMID = "com.fake.packaged_8wekyb3d8bbwe!App";

/** 缺省 apps 集合（list_apps/解析器的素材面；确定性：pid 升序由 backend 排）。 */
export function defaultApps() {
  return [
    {
      pid: TEST_PID,
      exePath: FAKE_EXE_PATH,
      aumid: null,
      displayName: null,
      windowCount: 2,
      active: true,
    },
    {
      pid: OTHER_PID,
      exePath: OTHER_EXE_PATH,
      aumid: PACKAGED_AUMID,
      displayName: null,
      windowCount: 1,
      active: false,
    },
  ];
}

export function defaultWindows() {
  return [
    {
      windowId: 1,
      title: "Fake Target Window",
      pid: TEST_PID,
      exePath: FAKE_EXE_PATH,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      minimized: false,
    },
    {
      windowId: 2,
      title: "Fake Other Window",
      pid: OTHER_PID,
      exePath: OTHER_EXE_PATH,
      bounds: { x: 100, y: 100, width: 400, height: 300 },
      minimized: false,
    },
  ];
}

/** N 个元素的确定性 fake 树（截断/预算测试用；role/name 全 ASCII，无用户内容语义）。 */
export function fakeElements(count, offsetIndex = 0) {
  const elements = [];
  for (let i = 0; i < count; i += 1) {
    elements.push({
      index: offsetIndex + i,
      depth: i % 4,
      role: i % 3 === 0 ? "button" : i % 3 === 1 ? "edit" : "pane",
      name: `element-${offsetIndex + i}`,
      value: i % 3 === 1 ? `value-${offsetIndex + i}` : null,
      valueLength: i % 3 === 1 ? `value-${offsetIndex + i}`.length : 0,
      bounds: { x: i, y: i * 2, width: 10, height: 8 },
      patterns: i % 3 === 0 ? ["invokable", "focusable"] : i % 3 === 1 ? ["editable"] : [],
    });
  }
  return elements;
}

/**
 * 可编程 fake UIA driver。
 * options：
 * - presence: 导出在场性覆写（capabilities 一致性矩阵用）；
 * - apps/windows: 观察素材；
 * - tree: captureUiTree 结果模板（{elements, truncated, totalElements, window}）；
 * - behaviors: {方法名: async (args, state) => 结果}——覆写默认行为（失败注入点）。
 * 暴露面：driver.state = {calls, events, tokensIssued, released, poisoned, behaviors, ...}。
 */
export function createFakeUiaDriver(options = {}) {
  const state = {
    calls: [],
    events: [],
    released: [],
    nextStateToken: 100,
    nextPoisoned: 0,
    apps: options.apps ?? defaultApps(),
    windows: options.windows ?? defaultWindows(),
    tree: options.tree ?? {
      elements: fakeElements(5),
      truncated: false,
      totalElements: 5,
      window: { windowId: 1, title: "Fake Target Window", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    },
    behaviors: { ...options.behaviors },
  };

  const defaults = {
    listApplications: async () => state.apps.map((app) => ({ ...app })),
    listWindows: async (pid) =>
      state.windows.filter((w) => pid === null || pid === undefined || w.pid === pid),
    captureUiTree: async () => {
      state.nextStateToken += 1;
      const tree = state.tree;
      return {
        stateToken: state.nextStateToken,
        window: tree.window === undefined ? null : tree.window,
        elements: tree.elements.map((element) => ({ ...element })),
        truncated: tree.truncated === true,
        totalElements: tree.totalElements ?? tree.elements.length,
      };
    },
    releaseState: async (token) => {
      state.released.push(token);
    },
    workerStats: async () => ({ poisoned: state.nextPoisoned, generation: 1 }),
    elementSetValue: async () => ({ verified: true }),
    elementSelectText: async () => ({ outcome: "selected" }),
    elementPerformAction: async () => undefined,
    elementInvoke: async () => ({ invoked: true }),
    elementClickablePoint: async () => ({ x: 10, y: 10 }),
    elementScroll: async () => ({ scrolled: true }),
  };

  const invoke = (method) => (...args) => {
    state.calls.push({ method, args });
    state.events.push(method);
    const behavior = state.behaviors[method];
    const impl = behavior ?? defaults[method];
    if (!impl) return Promise.reject(new Error(`fake uia driver: unknown method ${method}`));
    return Promise.resolve().then(() => impl(...args, state));
  };

  return {
    presence: options.presence ?? true,
    shutdownWorker: () => {
      state.calls.push({ method: "shutdownWorker", args: [] });
      state.events.push("shutdownWorker");
    },
    listApplications: invoke("listApplications"),
    listWindows: invoke("listWindows"),
    captureUiTree: invoke("captureUiTree"),
    releaseState: invoke("releaseState"),
    workerStats: invoke("workerStats"),
    elementSetValue: invoke("elementSetValue"),
    elementSelectText: invoke("elementSelectText"),
    elementPerformAction: invoke("elementPerformAction"),
    elementInvoke: invoke("elementInvoke"),
    elementClickablePoint: invoke("elementClickablePoint"),
    elementScroll: invoke("elementScroll"),
    state,
  };
}

export function countUiaCalls(driver, method) {
  return driver.state.calls.filter((call) => call.method === method).length;
}

export function lastUiaCall(driver, method) {
  const calls = driver.state.calls.filter((call) => call.method === method);
  return calls.length === 0 ? undefined : calls[calls.length - 1];
}
