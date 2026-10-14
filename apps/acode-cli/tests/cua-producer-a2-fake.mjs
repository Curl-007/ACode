/**
 * A2 共享测试夹具：可编程 fake driver（specs/windows-helper-producer.md §10.3 二分判据
 * 接口 + §10.11 测试落点）。非 *.test.mjs——不进 runner glob，仅供 cua-producer-a2-logic
 * 与 cua-producer-c08 两个 CI 常驻测试导入。
 *
 * fake driver 直接抛 NativeRejectedError / NativeAmbiguousError 注入失败（§10.3：
 * 「fake driver 直接抛对应类注入失败」——真 driver 由 native code 决定归类，两者同接口）。
 * 默认行为模拟 native held 注册表与取消旗标语义（drag/sendText/pressKeys 的 canceled
 * 结果字段、releaseAllHeldInputs 幂等清空、cancelOperations 同步置旗），支撑 §10.4 五条
 * seam 单测与 §10.6 stop 五步时序断言（events 日志 = 顺序断言载体）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerSrc = join(repoRoot, "cua-producer", "src");

/** 深导入 producer src TS（tsx 常驻可解析；源文件恒在库，无工件守卫需求，§14）。 */
export async function importProducerModule(name) {
  return import(pathToFileURL(join(producerSrc, `${name}.ts`)).href);
}

export const { NativeRejectedError, NativeAmbiguousError } = await importProducerModule(
  "driver-contract",
);

/** 测试用目标 pid（fake 存活进程；与真实进程无涉）。 */
export const TEST_PID = 4242;
/** 测试用已死 pid（app_ref 解析失败面）。 */
export const DEAD_PID = 99999999;

export const FAKE_EXE_PATH = "C:\\fake\\target-app.exe";

export function createFakeCaptureResult(overrides = {}) {
  return {
    image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encoding: "png",
    width: 8,
    height: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 },
    scaled: false,
    budgetFit: true,
    topologyFingerprint: "0,0,8,4;",
    ...overrides,
  };
}

/**
 * 可编程 fake driver。
 * options：
 * - presence: capabilityPresence 覆写；
 * - env: environmentProbe 结果（可经 driver.state.env 动态改）；
 * - alivePids: processExecutablePath 存活集合（默认 {TEST_PID}）；
 * - foregroundPid: foregroundPid 结果；
 * - behaviors: {方法名: async (args, state) => 结果}——覆写默认行为（失败注入点）。
 * 暴露面：driver.state = {calls, events, held:Set, cancelFlag, behaviors, env, ...}。
 */
export function createFakeDriver(options = {}) {
  const state = {
    calls: [],       // {method, args} 全量调用日志（计数断言）
    events: [],      // 方法名顺序日志（时序断言）
    held: new Set(), // native held 注册表模拟（"mouse:left" / "vk:17"）
    cancelFlag: false,
    env: options.env ?? { interactiveDesktop: true, sessionZero: false, dpiAware: true },
    alivePids: options.alivePids ?? new Set([TEST_PID]),
    foregroundPid: options.foregroundPid ?? null,
    cursor: { x: 100, y: 100 },
    behaviors: { ...options.behaviors },
    releasedTotal: 0,
  };

  const defaults = {
    environmentProbe: async () => ({ ...state.env }),
    foregroundPid: async () => ({ pid: state.foregroundPid }),
    heldInputSnapshot: async () => ({
      buttons: [...state.held].filter((t) => t.startsWith("mouse:")).map((t) => t.slice(6)),
      keys: [...state.held].filter((t) => t.startsWith("vk:")).map((t) => Number(t.slice(3))),
    }),
    asyncKeyState: async () => ({ down: false }),
    cursorPosition: async () => ({ ...state.cursor }),
    processExecutablePath: async (pid) => ({
      path: state.alivePids.has(pid) ? FAKE_EXE_PATH : null,
    }),
    moveTo: async () => undefined,
    scrollAt: async () => undefined,
    drag: async () => {
      // 模拟按住：down → 插值 → up（取消旗检查）。
      state.held.add("mouse:left");
      const canceled = state.cancelFlag;
      state.held.delete("mouse:left");
      return { injectedPoints: canceled ? 3 : 16, canceled };
    },
    mouseDown: async (button) => {
      state.held.add(`mouse:${button}`);
    },
    mouseUp: async (button) => {
      state.held.delete(`mouse:${button}`);
    },
    sendText: async (text) => {
      const total = text.length;
      if (state.cancelFlag) return { injected: 0, total, canceled: true };
      return { injected: total, total, canceled: false };
    },
    pressKeys: async (keys, opts) => {
      const mine = [];
      for (const entry of keys) {
        if (state.cancelFlag) {
          for (const vk of mine.reverse()) state.held.delete(`vk:${vk}`);
          return { canceled: true };
        }
        if (!entry.up) {
          state.held.add(`vk:${entry.vk}`);
          mine.push(entry.vk);
        } else {
          // hold 等待发生在 down 段与 up 段之间（native pressKeys 同型语义）。
          const holdMs = opts?.holdMs ?? 0;
          if (holdMs > 0) {
            const deadline = Date.now() + holdMs;
            while (Date.now() < deadline) {
              if (state.cancelFlag) {
                for (const vk of mine.reverse()) state.held.delete(`vk:${vk}`);
                return { canceled: true };
              }
              await new Promise((r) => setTimeout(r, 10));
            }
          }
          state.held.delete(`vk:${entry.vk}`);
          const index = mine.lastIndexOf(entry.vk);
          if (index !== -1) mine.splice(index, 1);
        }
      }
      return { canceled: false };
    },
    releaseAllHeldInputs: async () => {
      const released = state.held.size;
      state.held.clear();
      state.releasedTotal += released;
      return { released };
    },
    clipboardWriteText: async () => undefined,
    captureDisplay: async () => createFakeCaptureResult(),
    captureWindow: async () => {
      throw new NativeRejectedError("target_changed");  // A2 桩语义（capture.cc 同型）
    },
  };

  const invoke = (method) => (...args) => {
    state.calls.push({ method, args });
    state.events.push(method);
    const behavior = state.behaviors[method];
    const impl = behavior ?? defaults[method];
    if (!impl) return Promise.reject(new Error(`fake driver: unknown method ${method}`));
    return Promise.resolve().then(() => impl(...args, state));
  };

  const driver = {
    capabilityPresence: Object.freeze(
      options.presence ?? { input: true, capture: true, clipboard: true },
    ),
    environmentProbe: invoke("environmentProbe"),
    foregroundPid: invoke("foregroundPid"),
    heldInputSnapshot: invoke("heldInputSnapshot"),
    asyncKeyState: invoke("asyncKeyState"),
    cursorPosition: invoke("cursorPosition"),
    processExecutablePath: invoke("processExecutablePath"),
    moveTo: invoke("moveTo"),
    scrollAt: invoke("scrollAt"),
    drag: invoke("drag"),
    mouseDown: invoke("mouseDown"),
    mouseUp: invoke("mouseUp"),
    sendText: invoke("sendText"),
    pressKeys: invoke("pressKeys"),
    releaseAllHeldInputs: invoke("releaseAllHeldInputs"),
    clipboardWriteText: invoke("clipboardWriteText"),
    captureDisplay: invoke("captureDisplay"),
    captureWindow: invoke("captureWindow"),
    state,
  };
  // cancelOperations 同步（§10.1 唯一新增同步导出）；同样进 calls 日志（计数断言面）。
  driver.cancelOperations = () => {
    state.calls.push({ method: "cancelOperations", args: [] });
    state.events.push("cancelOperations");
    state.cancelFlag = true;
  };
  return driver;
}

export function countCalls(driver, method) {
  return driver.state.calls.filter((call) => call.method === method).length;
}

export function lastCall(driver, method) {
  const calls = driver.state.calls.filter((call) => call.method === method);
  return calls.length === 0 ? undefined : calls[calls.length - 1];
}

export function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
