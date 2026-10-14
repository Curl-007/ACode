/**
 * cua-producer A3 native 真机测试（specs/windows-helper-producer.md §11 + §16.2「A3 真机
 * 默认套件纪律」+ §10.11 零真实副作用硬规则的同律延伸；win32 + 工件双守卫，§6.1 同律：
 * 非 Windows 或工件缺失即整文件 skip，ubuntu CI 安全）。
 *
 * **A3 真机默认套件纪律（§16.2，违反即返工）**：本文件在 win32 开发机上随
 * `pnpm --dir apps/acode-cli test` 实跑，只允许两类真实面：
 * - ① 只读观察：listApplications/listWindows/captureUiTree/captureWindow/
 *   list_apps/list_windows/get_app_state——前台应用只读，零注入、零写入、零破坏；
 * - ② 负控制：确认已死 pid、失效/越界 state token、未注册 window token、非法参数——
 *   全部落「确定未派发」域（§10.12）。
 * **绝不**真实调用 set_value/select_text/perform_action/invoke/scroll 的 happy path 到
 * 真实应用（变更类真机实变更 = 人工 C07/C09 验收，机制形态断言全量在 a3-logic fake 面）。
 * poison-detach-rebuild（AC-1 native 侧）只经 captureUiTree 的 deadlineMs 测试专用覆写
 * 触发（uia_tree.cc:966「生产 handler 恒传 undefined」），本文件内至多触发一次。
 *
 * **隐私纪律（§11.1/§11.4/§16.2）**：窗口标题、树文本、元素 name/value、截图字节绝不
 * 打印、不落盘、不进 t.diagnostic（断言即弃）；断言消息与失败信息也不得含这些内容——
 * 一切可能携带用户内容的比较一律用 assert.ok（失败只打印固定消息，不 dump 实值）；
 * deepEqual 只用于键集/魔数/纯数字形状。诊断信息只含计数、pid、token、封闭 code 字面量。
 *
 * 导入纪律（§6.1）：addon 经 createRequire 在守卫后的测试体内加载；Helper 以 fork 子进程
 * 拉起（dist/windows-helper.js 作 entry，不做 dist 深导入）；producer src TS 字面量经
 * importProducerModule（tsx 动态导入，纯逻辑模块、平台无关，顶层导入 ubuntu 安全——
 * a2-native 同先例）；静态顶层 import 只有 node: 内建、node:test/assert、恒在的仓内
 * 角色 B 源文件（packages/acode-cua/broker.js）与 a3-fake 夹具。
 */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// 恒在的仓内角色 B 客户端（静态导入允许——已入库文件，helper-a1/a2-native 同先例）。
import { BrokerError, callBrokerMethod } from "../../../packages/acode-cua/broker.js";
import { importProducerModule } from "./cua-producer-a3-fake.mjs";

// 字面量单一来源（防漂移：直接取 producer src 的封闭表，不在测试内复制表达——a2-native 同律）。
const { WIRE_ERROR_MESSAGES } = await importProducerModule("wire-server");
const { CUA_TARGET_APP_DISPLAY_META_KEY, WIRE_BY_NATIVE_CODE } = await importProducerModule(
  "receipts",
);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerRoot = join(repoRoot, "cua-producer");
const entryPath = join(producerRoot, "dist", "windows-helper.js");
const addonPath = join(producerRoot, "build", "Release", "ax_native.node");

const ADDON_ENV = "ACODE_CUA_HELPER_ADDON";
const AUTHORITY_ENV = "ACODE_CUA_PLUGIN_AUTHORITY";
// canary 环境名（任务纪律：ACODE_CUA_SMOKE_CANARY 类随机值——Helper 不读它，注入只为
// 证明继承 env 里的秘密绝不出现在 wire 响应/IPC/stdout/stderr；authority 是 §3.1 的
// 最坏继承场景，helper-a1 canary 模式同律）。
const CANARY_ENV = "ACODE_CUA_SMOKE_CANARY";
const CONTROL_PROTOCOL = "acode-cua-windows-dev/v1";

// 捕获/树预算（§10.7/§11.4 钉死值；driver-contract.ts 同值，测试侧自持常量防深导入面扩大）。
const CAPTURE_MAX_DIMENSION = 2000;
const CAPTURE_INLINE_BASE64_BUDGET_BYTES = 200 * 1024;
const TREE_BUDGET = Object.freeze({ maxElements: 3000, maxTextBytes: 262144 });
// 确认已死 pid（负控制夹具）：Windows 进程 id 恒为 4 的倍数，99999999 不是——结构上
// 不可能是存活进程（a3-fake DEAD_PID 同值约定）；测试内仍复核 ESRCH 兜底。
const STRUCTURALLY_DEAD_PID = 99999999;
// 未注册 window token（负控制）：本文件的 listWindows 调用总量 ×单机窗口数远小于该值，
// 注册表（代内单调、≤4096 条最旧逐出）不可能铸造到它。
const UNREGISTERED_WINDOW_TOKEN = 12345;

// ── 双重守卫（§6.1 第 2 条同律；a2-native 同形）───────────────────────────────
const skipReason =
  process.platform !== "win32"
    ? "cua-producer A3 native tests require win32 (named pipe + MSVC-built addon)"
    : !existsSync(entryPath) || !existsSync(addonPath)
      ? "cua-producer artifacts missing (dist/windows-helper.js + build/Release/ax_native.node); run `npm install && npm run build` inside cua-producer"
      : false;

/** addon 只在守卫后的测试体内加载（ubuntu 上工件缺失，顶层 require 会炸穿守卫）。 */
function loadAddon() {
  return createRequire(import.meta.url)(addonPath);
}

// 退出收口（spec §19 第 14 条，A3 评审修复 CUA-A3-SHUTDOWN-CRASH）：本文件是唯一在
// 测试进程内直接派发真 UIA 任务的落点（a2-native 只做 typeof 面检查、helper-a1 的 UIA
// 在 fork 出的 Helper 进程内）——全部用例结束后经第二同步导出 uiaWorkerShutdown 协作式
// 停止 UIA MTA worker（置旗 + 广播，parked 线程退出循环并 CoUninitialize），teardown 期
// 不留线程触碰静态 cv/mutex。同步、幂等；置位后本 addon 实例不复活（进程正在退出）。
// typeof 守卫 = 对旧工件的诚实兼容（spawn-即-detach 修复本身已结构性消除退出崩溃）。
after(() => {
  if (skipReason !== false) return;
  const addon = loadAddon();
  if (typeof addon.uiaWorkerShutdown === "function") addon.uiaWorkerShutdown();
});

/** 测试自铸唯一 pipe 名（前缀 acode-cua-a3-test- 与生产/a1/a2 测试隔离，§6.2 同律）。 */
function mintTestPipe() {
  return `\\\\.\\pipe\\acode-cua-a3-test-${randomUUID()}`;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 铸一个确认已消失的 pid（负控制夹具；复核 ESRCH 防即刻复用——a2-native 同形）。 */
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
 * 统一 preflight 门的事实核对（uia_tree.cc/capture.cc 同款判据：interactiveDesktop ∧
 * ¬sessionZero ∧ dpiAware）：非交互桌面（锁屏/Session 0）上 UIA/捕获面诚实不可用——
 * 整段 t.skip 而非失败（a2-native captureDisplay 用例同律）。
 */
async function requireInteractiveDesktop(t, addon, label) {
  const environment = await addon.environmentProbe();
  if (!environment.interactiveDesktop || environment.sessionZero || !environment.dpiAware) {
    t.skip(`${label}: 非交互桌面（锁屏/Session 0/非 DPI-aware）——UIA/捕获面诚实不可用，非失败`);
    return false;
  }
  return true;
}

/** Z 序最顶可见窗口（listWindows(null)[0]——EnumWindows 顺序 = Z 序，window_registry.cc）。 */
async function topZWindow(addon) {
  const { windows } = await addon.listWindows(null);
  return windows.length > 0 ? windows[0] : null;
}

/** 按宿主 fork 面拉起真 Helper（helper-a1 夹具同构，§2.1；execArgv 显式清空防 tsx 继承）。 */
function startHelper(options) {
  const socketPath = options.socketPath ?? mintTestPipe();
  const argv = ["--socket", socketPath, "--parent-pid", String(process.pid)];
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    [ADDON_ENV]: addonPath,
    ...options.extraEnv,
  };
  const child = fork(entryPath, argv, {
    cwd: producerRoot,
    execPath: process.execPath,
    execArgv: [],
    silent: true,
    env,
  });
  const helper = {
    child,
    argv,
    socketPath,
    ipcMessages: [],
    stdout: "",
    stderr: "",
    exited: new Promise((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    }),
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    helper.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    helper.stderr += chunk;
  });
  // 持久监听累积（竞态安全的等待形态——helper-a1 同律）。
  child.on("message", (message) => helper.ipcMessages.push(message));
  child.on("error", () => {});
  return helper;
}

async function waitForReady(helper, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (helper.ipcMessages.some((message) => message?.type === "ready")) return;
    if (Date.now() > deadline) {
      // stderr 是 §3.2 红线面（结构性无用户内容），超时诊断可回溯（helper-a1 同律）。
      assert.fail(`helper did not become ready within ${timeoutMs}ms; stderr: ${helper.stderr}`);
    }
    await delay(20);
  }
}

/** 原始单连接单请求往返（helper-a1 rawRequest 同构；wire 响应原文的 canary 扫描载体）。 */
function rawRequest(socketPath, payload, { timeoutMs = 8000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = "";
    let errorCode = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const newline = buffer.indexOf("\n");
      resolvePromise({ text: newline === -1 ? null : buffer.slice(0, newline), errorCode });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPromise(new Error(`raw request to pipe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      try {
        socket.write(payload);
      } catch {
        // 写入期间被服务端拆连接：error 事件路径接管。
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) finish();
    });
    socket.on("error", (error) => {
      errorCode = errorCode ?? error?.code ?? "error";
      finish();
    });
    socket.on("close", finish);
  });
}

/** Promise 双态收口（负控制夹具：{result} | {error}，不外抛）。 */
function settle(promise) {
  return promise.then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
}

/** 断言 rejected 错误的类型化事实（code + dispatchStarted；消息只含封闭字面量，零内容）。 */
function assertNativeRejection(outcome, code, dispatchStarted, label) {
  assert.ok(outcome.error, `${label}: 必须拒绝（实际成功返回）`);
  assert.equal(outcome.error?.code, code, `${label}: 类型化 code（§10.3 封闭集）`);
  assert.equal(
    outcome.error?.dispatchStarted,
    dispatchStarted,
    `${label}: dispatchStarted 二分判据事实（§10.3）`,
  );
  assert.equal(outcome.result, undefined, `${label}: 拒绝路径不得携带结果`);
}

// ── ① 只读观察面（§16.2 A3 真机纪律：前台应用只读；标题/树文本/名字断言即弃）──────

test("native|观察面真实性：listApplications 字段形状/pid 升序 + listWindows(null) token 唯一/形状（§11.2 只读）", { skip: skipReason }, async (t) => {
  const CASE = "观察面真实性";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;

  // ── listApplications：{apps:[...]}，pid 去重升序（native std::sort 确定性）──
  const listed = await addon.listApplications();
  assert.deepEqual(
    Object.keys(listed).sort(),
    ["apps"],
    `${CASE}: listApplications 结果恰 {apps}（导出面形状封闭）`,
  );
  const { apps } = listed;
  assert.ok(Array.isArray(apps), `${CASE}: apps 是数组`);
  assert.ok(
    apps.length >= 1,
    `${CASE}: 交互桌面上 app 集合 ≥1（含 shell——Progman/WorkerW 也是可观察目标，§11.2）`,
  );
  for (let i = 0; i < apps.length; i += 1) {
    const app = apps[i];
    assert.deepEqual(
      Object.keys(app).sort(),
      ["active", "aumid", "displayName", "exePath", "pid", "windowCount"],
      `${CASE}: apps[${i}] 键集封闭（§11.2 native 事实面）`,
    );
    assert.ok(
      Number.isInteger(app.pid) && app.pid > 0,
      `${CASE}: apps[${i}].pid 正整数`,
    );
    assert.equal(typeof app.exePath, "string", `${CASE}: apps[${i}].exePath string（不可读进程 = 空串诚实事实）`);
    assert.ok(
      app.aumid === null || typeof app.aumid === "string",
      `${CASE}: apps[${i}].aumid string|null`,
    );
    assert.equal(app.displayName, null, `${CASE}: apps[${i}].displayName 恒 null（A3 v1 不猜本地化名，oQ11）`);
    assert.ok(
      Number.isInteger(app.windowCount) && app.windowCount >= 1,
      `${CASE}: apps[${i}].windowCount ≥1（app 集合 = 有 ≥1 可见顶层窗口的进程）`,
    );
    assert.equal(typeof app.active, "boolean", `${CASE}: apps[${i}].active boolean`);
    if (i > 0) {
      assert.ok(
        apps[i - 1].pid < app.pid,
        `${CASE}: apps 按 pid 严格升序（确定性，§11.2）`,
      );
    }
  }

  // ── listWindows(null)：全量枚举，Z 序（EnumWindows 顶先）──
  const enumerated = await addon.listWindows(null);
  assert.deepEqual(
    Object.keys(enumerated).sort(),
    ["windows"],
    `${CASE}: listWindows 结果恰 {windows}`,
  );
  const { windows } = enumerated;
  assert.ok(Array.isArray(windows) && windows.length >= 1, `${CASE}: 交互桌面上窗口 ≥1`);
  const seenWindowIds = new Set();
  for (let i = 0; i < windows.length; i += 1) {
    const entry = windows[i];
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["bounds", "exePath", "minimized", "pid", "title", "windowId"],
      `${CASE}: windows[${i}] 键集封闭`,
    );
    assert.ok(
      Number.isInteger(entry.windowId) && entry.windowId > 0,
      `${CASE}: windows[${i}].windowId 正整数（不透明 token，§11.5）`,
    );
    assert.ok(
      !seenWindowIds.has(entry.windowId),
      `${CASE}: windows[${i}].windowId 唯一（代内单调、不复用）`,
    );
    seenWindowIds.add(entry.windowId);
    // title 是用户内容：只断言类型，内容绝不进消息/诊断（隐私纪律）。
    assert.equal(typeof entry.title, "string", `${CASE}: windows[${i}].title string（内容不断言、不打印）`);
    assert.ok(Number.isInteger(entry.pid) && entry.pid > 0, `${CASE}: windows[${i}].pid 正整数`);
    assert.equal(typeof entry.exePath, "string", `${CASE}: windows[${i}].exePath string`);
    assert.deepEqual(
      Object.keys(entry.bounds).sort(),
      ["height", "width", "x", "y"],
      `${CASE}: windows[${i}].bounds 键集`,
    );
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(
        Number.isFinite(entry.bounds[key]),
        `${CASE}: windows[${i}].bounds.${key} 有限数值`,
      );
    }
    assert.equal(typeof entry.minimized, "boolean", `${CASE}: windows[${i}].minimized boolean`);
  }
  // 诊断只含计数（隐私纪律：标题/路径绝不进诊断）。
  t.diagnostic(`${CASE}: apps=${apps.length} windows=${windows.length}（内容不落诊断）`);
});

test("native|captureUiTree Z 顶窗口只读观察：形状/索引连续/冻结域 token 单调 + 二次观察不同 stateToken（§11.2/§11.4）", { skip: skipReason }, async (t) => {
  const CASE = "captureUiTree 只读观察";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;
  const top = await topZWindow(addon);
  assert.ok(top, `${CASE}: 交互桌面上必有 Z 顶可见窗口`);

  const first = await addon.captureUiTree({ pid: top.pid }, TREE_BUDGET);
  assert.deepEqual(
    Object.keys(first).sort(),
    ["elements", "stateToken", "totalElements", "truncated", "window"],
    `${CASE}: 结果键集封闭（uia_tree.cc BuildResult）`,
  );
  if (first.window === null) {
    // 诚实 noWindow 形态（Z 顶窗口在枚举与观察之间消失——真机瞬态）：成功形状 +
    // window:null + 零冻结域提交（stateToken 0），后续断言按任务纪律跳过并记录。
    assert.deepEqual(first.elements, [], `${CASE}: noWindow 形态 elements 恒空`);
    assert.equal(first.totalElements, 0, `${CASE}: noWindow 形态 totalElements 恒 0`);
    assert.equal(first.truncated, false, `${CASE}: noWindow 形态 truncated 恒 false`);
    assert.equal(first.stateToken, 0, `${CASE}: noWindow 不提交冻结域（stateToken 0）`);
    t.skip(`${CASE}: Z 顶窗口观察窗口期内消失 → 诚实 noWindow 形态（window:null），后续断言跳过（真机瞬态，非断言放宽）`);
    return;
  }
  assert.deepEqual(
    Object.keys(first.window).sort(),
    ["bounds", "title", "windowId"],
    `${CASE}: window 键集封闭`,
  );
  assert.ok(
    Number.isInteger(first.window.windowId) && first.window.windowId > 0,
    `${CASE}: window.windowId 正整数 token`,
  );
  assert.equal(typeof first.window.title, "string", `${CASE}: window.title string（内容不断言、不打印）`);
  for (const key of ["x", "y", "width", "height"]) {
    assert.ok(Number.isFinite(first.window.bounds[key]), `${CASE}: window.bounds.${key} 有限数值`);
  }
  assert.ok(
    Number.isInteger(first.stateToken) && first.stateToken > 0,
    `${CASE}: stateToken > 0（冻结域已提交，§11.5）`,
  );
  assert.equal(typeof first.truncated, "boolean", `${CASE}: truncated boolean`);
  assert.ok(
    Number.isInteger(first.totalElements) && first.totalElements >= first.elements.length,
    `${CASE}: totalElements ≥ 采集数（M 如实报告总量，§11.4）`,
  );
  if (!first.truncated) {
    assert.equal(
      first.totalElements,
      first.elements.length,
      `${CASE}: 未截断 ⇒ 计数 = 采集数（预算感知遍历不变量）`,
    );
  }
  assert.ok(Array.isArray(first.elements), `${CASE}: elements 是数组`);
  for (let i = 0; i < first.elements.length; i += 1) {
    const element = first.elements[i];
    assert.deepEqual(
      Object.keys(element).sort(),
      ["bounds", "depth", "index", "name", "patterns", "role", "value", "valueLength"],
      `${CASE}: elements[${i}] 键集封闭`,
    );
    assert.equal(element.index, i, `${CASE}: elements[${i}].index 从 0 连续（document order，§11.4 索引稳定性）`);
    assert.ok(
      Number.isInteger(element.depth) && element.depth >= 0,
      `${CASE}: elements[${i}].depth ≥0 整数`,
    );
    assert.ok(
      typeof element.role === "string" && element.role.length > 0,
      `${CASE}: elements[${i}].role 非空 string（稳定英文名，绝不本地化）`,
    );
    // name/value 是用户内容：只断言类型（内容绝不进消息/诊断）。
    assert.equal(typeof element.name, "string", `${CASE}: elements[${i}].name string（内容不断言）`);
    assert.ok(
      element.value === null || typeof element.value === "string",
      `${CASE}: elements[${i}].value string|null`,
    );
    assert.ok(
      Number.isInteger(element.valueLength) && element.valueLength >= 0,
      `${CASE}: elements[${i}].valueLength ≥0 整数`,
    );
    assert.ok(Array.isArray(element.patterns), `${CASE}: elements[${i}].patterns 数组`);
    for (const pattern of element.patterns) {
      assert.ok(
        typeof pattern === "string" && pattern.length > 0,
        `${CASE}: elements[${i}].patterns 项非空 string（只广告真实存在的动作）`,
      );
    }
    assert.ok(
      element.bounds === null ||
        (typeof element.bounds === "object" &&
          ["x", "y", "width", "height"].every((key) => Number.isFinite(element.bounds[key]))),
      `${CASE}: elements[${i}].bounds null 或数值矩形`,
    );
  }

  // 第二次观察 → 不同 stateToken（每次观察是独立冻结域，§11.4/§11.5）。
  const second = await addon.captureUiTree({ pid: top.pid }, TREE_BUDGET);
  assert.ok(
    Number.isInteger(second.stateToken) && second.stateToken > 0,
    `${CASE}: 二次观察 stateToken > 0`,
  );
  assert.notEqual(
    second.stateToken,
    first.stateToken,
    `${CASE}: 二次观察 stateToken 不同（token 代内不复用）`,
  );
  // 只读观察的冻结域用完即释（good citizen；LRU/代际清零兜底之外的主动释放）。
  await addon.releaseStateToken(first.stateToken);
  await addon.releaseStateToken(second.stateToken);
  t.diagnostic(
    `${CASE}: elements=${first.elements.length} totalElements=${first.totalElements} truncated=${first.truncated}（树内容不落诊断）`,
  );
});

// ── ② 负控制（§16.2 纪律：全部落「确定未派发」域，零真实副作用）─────────────────

test("native|负控制：越界 index/已释放 token → stale；死 pid → 诚实 noWindow；未注册 window token → target_changed（零派发域）", { skip: skipReason }, async (t) => {
  const CASE = "负控制";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;

  // 夹具：Z 顶窗口的活冻结域（越界/释放负控制需要合法 stateToken）。
  const top = await topZWindow(addon);
  assert.ok(top, `${CASE}: 交互桌面上必有 Z 顶可见窗口`);
  const captured = await addon.captureUiTree({ pid: top.pid }, TREE_BUDGET);
  if (captured.window === null) {
    t.skip(`${CASE}: Z 顶窗口观察窗口期内消失（诚实 noWindow）→ 活 token 夹具不可得，负控制跳过（真机瞬态，非断言放宽）`);
    return;
  }
  const stateToken = captured.stateToken;

  // ① 越界 index（999999 ≥ 任何预算内采集数 ≤3000）→ stale（LookupFrozenElement
  //    fail-closed，绝不触碰 COM；只读负控制 = 零派发）。
  const outOfRange = await settle(addon.elementClickablePoint(stateToken, 999999));
  assertNativeRejection(
    outOfRange,
    "stale",
    false,
    `${CASE}: elementClickablePoint 越界 index`,
  );

  // ② 释放后的 token → stale（冻结域已除名；COM 引用已 Release——再用即 fail-closed）。
  await addon.releaseStateToken(stateToken);
  const released = await settle(addon.elementClickablePoint(stateToken, 0));
  assertNativeRejection(
    released,
    "stale",
    false,
    `${CASE}: elementClickablePoint 已释放 token`,
  );

  // ③ 确认已死 pid → 成功形状且 window===null（进程不存在 → 0 可见窗口 → 诚实
  //    noWindow 形态，uia_tree.cc「0 窗口也是成功观察的一种诚实结果」；绝不抛错、
  //    绝不空树冒充——window:null 与 elements:[] 的语义区分是 C09 红线的一部分）。
  let deadPidAlive = false;
  try {
    process.kill(STRUCTURALLY_DEAD_PID, 0);
    deadPidAlive = true; // 无错 = 进程存在（4 倍数之外的 pid 结构上不应到此）
  } catch (error) {
    deadPidAlive = error.code !== "ESRCH"; // EPERM 等 = 存在但不可操作
  }
  if (deadPidAlive) {
    t.diagnostic(`${CASE}: pid ${STRUCTURALLY_DEAD_PID} 意外存活——死 pid 负控制跳过（诚实记录）`);
  } else {
    const deadOutcome = await settle(
      addon.captureUiTree({ pid: STRUCTURALLY_DEAD_PID }, TREE_BUDGET),
    );
    assert.ok(
      deadOutcome.error === undefined,
      `${CASE}: 死 pid captureUiTree 必须成功形状（实际拒绝 code=${deadOutcome.error?.code}）——进程不存在是观察事实不是错误`,
    );
    assert.equal(deadOutcome.result?.window, null, `${CASE}: 死 pid → window===null（诚实 noWindow）`);
    assert.deepEqual(deadOutcome.result?.elements, [], `${CASE}: 死 pid → elements 恒空`);
    assert.equal(deadOutcome.result?.totalElements, 0, `${CASE}: 死 pid → totalElements 0`);
    assert.equal(deadOutcome.result?.stateToken, 0, `${CASE}: 死 pid → 零冻结域提交（stateToken 0）`);
  }

  // ④ 未注册 window token → target_changed（token 不可解析 =「observation state is
  //    stale」语义，§11.5；绝不拿裸数值当 HWND 猜测身份）。
  const unknownWindow = await settle(
    addon.captureWindow(UNREGISTERED_WINDOW_TOKEN, {
      maxDimension: CAPTURE_MAX_DIMENSION,
      inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES,
    }),
  );
  assertNativeRejection(
    unknownWindow,
    "target_changed",
    false,
    `${CASE}: captureWindow 未注册 token`,
  );
});

test("native|captureWindow 真实路径（只读 WGC 窗口读回）：魔数/尺寸/base64 预算/bounds/budgetFit/scaled（图像字节不落盘不打印，断言即弃）", { skip: skipReason }, async (t) => {
  const CASE = "captureWindow 实捕";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;
  const budget = {
    maxDimension: CAPTURE_MAX_DIMENSION,
    inlineBase64BudgetBytes: CAPTURE_INLINE_BASE64_BUDGET_BYTES,
  };
  // 真机瞬态策略（任务纪律第 4 条）：目标窗口在捕获中关闭/最小化/换主 → target_changed/
  // capture_minimized/capture_failed——重取 Z 序列表重试一次；仍失败则诚实 skip（不算
  // 断言放宽：捕获面 fail-closed 语义本身已在负控制用例钉死）。
  const transientCodes = new Set(["target_changed", "capture_minimized", "capture_failed"]);
  const pickTarget = async () => {
    const { windows } = await addon.listWindows(null);
    return windows.find((entry) => !entry.minimized) ?? null;
  };
  let capture = null;
  let lastTransientCode = null;
  for (let attempt = 0; attempt < 2 && capture === null; attempt += 1) {
    const target = await pickTarget();
    if (!target) {
      t.skip(`${CASE}: 全部可见窗口最小化——窗口捕获面诚实不可用（真机状态，非失败）`);
      return;
    }
    const outcome = await settle(addon.captureWindow(target.windowId, budget));
    if (outcome.error === undefined) {
      capture = outcome.result;
      break;
    }
    if (!transientCodes.has(outcome.error.code)) {
      // 非瞬态 code（budget_exceeded/internal_native/...）→ 诚实失败信号，不重试不放宽。
      assert.fail(`${CASE}: 捕获拒绝 code=${outcome.error.code}（非真机瞬态域，须排查）`);
    }
    lastTransientCode = outcome.error.code;
    t.diagnostic(`${CASE}: 第 ${attempt + 1} 次捕获 code=${lastTransientCode}（真机瞬态，重取目标重试）`);
  }
  if (capture === null) {
    t.skip(`${CASE}: 两次捕获均 code=${lastTransientCode}（目标窗口捕获中变化/关闭——真机瞬态，按纪律第 4 条诚实 skip，非断言放宽）`);
    return;
  }

  assert.deepEqual(
    Object.keys(capture).sort(),
    ["bounds", "budgetFit", "encoding", "height", "image", "scaled", "topologyFingerprint", "width"],
    `${CASE}: 结果键集封闭（capture.cc CaptureWindowWorker）`,
  );
  const bytes = capture.image;
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0, `${CASE}: image 字节非空`);
  if (capture.encoding === "png") {
    assert.deepEqual(
      [bytes[0], bytes[1], bytes[2], bytes[3]],
      [0x89, 0x50, 0x4e, 0x47],
      `${CASE}: PNG 魔数与 encoding 一致`,
    );
  } else {
    assert.equal(capture.encoding, "jpeg", `${CASE}: encoding 封闭 {png,jpeg}`);
    assert.deepEqual(
      [bytes[0], bytes[1], bytes[2]],
      [0xff, 0xd8, 0xff],
      `${CASE}: JPEG SOI 与 encoding 一致`,
    );
  }
  assert.ok(
    Number.isInteger(capture.width) && capture.width > 0 && capture.width <= CAPTURE_MAX_DIMENSION,
    `${CASE}: width ∈ (0,${CAPTURE_MAX_DIMENSION}]`,
  );
  assert.ok(
    Number.isInteger(capture.height) && capture.height > 0 && capture.height <= CAPTURE_MAX_DIMENSION,
    `${CASE}: height ∈ (0,${CAPTURE_MAX_DIMENSION}]`,
  );
  const base64Bytes = Math.ceil(bytes.length / 3) * 4;
  assert.ok(
    base64Bytes <= CAPTURE_INLINE_BASE64_BUDGET_BYTES,
    `${CASE}: base64 折算 ${base64Bytes} ≤ 200 KiB（§10.7 预算阶梯）`,
  );
  assert.equal(capture.budgetFit, true, `${CASE}: budgetFit 恒 true（超预算 = budget_exceeded 类型化失败）`);
  assert.ok(
    capture.bounds.width > 0 && capture.bounds.height > 0,
    `${CASE}: bounds 宽高 >0`,
  );
  assert.equal(typeof capture.topologyFingerprint, "string", `${CASE}: topologyFingerprint string（§10.7 拓扑指纹）`);
  // scaled 与尺寸事实一致（a2-native captureDisplay 同判据）。
  if (capture.scaled) {
    assert.ok(
      capture.width < capture.bounds.width || capture.height < capture.bounds.height,
      `${CASE}: scaled=true ⇒ 栅格严格小于 bounds`,
    );
  } else {
    assert.equal(capture.width, capture.bounds.width, `${CASE}: scaled=false ⇒ 栅格 = bounds`);
    assert.equal(capture.height, capture.bounds.height, `${CASE}: scaled=false ⇒ 栅格 = bounds（高）`);
  }
  // 截图字节是隐私面：只在本断言作用域内存在，绝不落盘/打印（结构上无输出路径）。
  t.diagnostic(`${CASE}: ${capture.width}x${capture.height} ${capture.encoding} ${bytes.length}B（字节不落诊断）`);
});

test("native|poison-detach-rebuild 真机段（AC-1 native 侧）：deadlineMs=1 覆写 → uia_timeout + poisoned/generation 增长 + 替代 worker 服务后续调用（§11.1；本文件内毒化至多触发一次）", { skip: skipReason }, async (t) => {
  const CASE = "poison-detach-rebuild";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;

  // ── 选靶：listApplications 前 4 个 app 正常观察，取 totalElements 最大者（控制耗时；
  //    树越大，deadlineMs=1 越确定落入「首个 50ms 等待片未完成」→ 毒化路径）。──
  const { apps } = await addon.listApplications();
  const candidates = apps.slice(0, 4);
  const rejectedCodes = [];
  let best = null; // {pid, totalElements}
  for (const app of candidates) {
    const outcome = await settle(addon.captureUiTree({ pid: app.pid }, TREE_BUDGET));
    if (outcome.error !== undefined) {
      rejectedCodes.push(outcome.error.code); // 封闭字面量，可安全进诊断
      continue;
    }
    if (outcome.result.window !== null && (best === null || outcome.result.totalElements > best.totalElements)) {
      best = { pid: app.pid, totalElements: outcome.result.totalElements };
    }
  }
  t.diagnostic(
    `${CASE}: 扫描候选=${candidates.length} 拒绝码=[${rejectedCodes.join(",")}] 最大树规模 totalElements=${best?.totalElements ?? "无"}（树内容不落诊断）`,
  );
  if (best === null) {
    t.skip(`${CASE}: 4 个候选 app 观察全部拒绝或 noWindow（拒绝码=[${rejectedCodes.join(",")}]）——毒化段无靶，诚实跳过`);
    return;
  }

  // 毒化前基线（扫描期的意外 uia_timeout 也会毒化——相对增量断言对基线取值不敏感，
  // 但基线让 poisoned/generation 的事实可归因）。
  const mid = await addon.uiaWorkerStats();
  assert.deepEqual(
    Object.keys(mid).sort(),
    ["generation", "poisoned"],
    `${CASE}: uiaWorkerStats 键集封闭`,
  );
  assert.ok(
    Number.isInteger(mid.poisoned) && mid.poisoned >= 0 && Number.isInteger(mid.generation) && mid.generation >= 0,
    `${CASE}: 基线 stats 非负整数`,
  );

  // ── 毒化触发：deadlineMs=1 是测试专用覆写（生产 handler 恒传 undefined → 8s 缺省，
  //    uia_tree.cc:966）；这是本文件唯一、至多一次的毒化触发点。──
  const poisoned = await settle(addon.captureUiTree({ pid: best.pid }, TREE_BUDGET, 1));
  if (poisoned.error === undefined) {
    // 任务在首个 50ms 等待片内完成（机器极快或树极小）——未超时即未毒化。诚实记录，
    // 不硬凑毒化断言（任务纪律第 5 条）；本次成功观察的冻结域顺手释放。
    if (Number.isInteger(poisoned.result.stateToken) && poisoned.result.stateToken > 0) {
      await addon.releaseStateToken(poisoned.result.stateToken);
    }
    t.diagnostic(
      `${CASE}: 毒化路径本机未触发——deadlineMs=1 的观察在首个 50ms 等待片内完成（机器极快或树极小），后续毒化断言按纪律跳过（不硬凑）`,
    );
    return;
  }
  assertNativeRejection(poisoned, "uia_timeout", false, `${CASE}: deadlineMs=1 覆写`);

  // ── 替代 worker 服务后续调用（§11.1 rebuild 面）：毒化后的下一个 UIA 任务必须成功。
  //    断言顺序校准（实现事实，非放宽）：generation 在**下一次任务入队**时才自增
  //    （uia_worker.cc EnsureWorkerLocked 懒重建），故「generation ≥2」必须在后续
  //    listApplications 之后读取——任务清单的两项事实（poisoned≥1 ∧ generation≥2 ∧
  //    替代 worker 服务）全部原样断言，仅读取顺序按实现语义排列。
  const after = await addon.listApplications();
  assert.ok(
    Array.isArray(after.apps) && after.apps.length >= 1,
    `${CASE}: 毒化后 listApplications 成功（替代 worker 服务后续调用）`,
  );
  const stats = await addon.uiaWorkerStats();
  assert.ok(
    stats.poisoned >= mid.poisoned + 1,
    `${CASE}: poisoned 相对增量 ≥1（本次 deadline 毒化事实；基线=${mid.poisoned} 现值=${stats.poisoned}）`,
  );
  assert.ok(stats.poisoned >= 1, `${CASE}: poisoned ≥1（绝对下限，任务清单判据）`);
  assert.ok(
    stats.generation >= mid.generation + 1,
    `${CASE}: generation 相对增量 ≥1（detach 后重建事实；基线=${mid.generation} 现值=${stats.generation}）`,
  );
  assert.ok(stats.generation >= 2, `${CASE}: generation ≥2（绝对下限，任务清单判据）`);
  t.diagnostic(
    `${CASE}: 毒化已触发一次（poisoned ${mid.poisoned}→${stats.poisoned}, generation ${mid.generation}→${stats.generation}）——本文件内至多一次`,
  );
});

// ── wire 段（真 fork Helper + 真 named pipe + 真角色 B；§16.2 纪律：只读 + 负控制）────

test("wire|A3 六工具真实受理形状：broker_info capabilities.uia + list_apps/list_windows/get_app_state×2 只读面 + 负控制零插值字面量 + canary 不泄漏（真 fork+真 pipe+真角色 B）", { skip: skipReason }, async (t) => {
  const CASE = "wire A3 形状";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;

  const canarySmoke = `canary-${randomBytes(12).toString("hex")}`;
  const canaryAuthority = `canary-${randomBytes(12).toString("hex")}`;
  const canaries = [canarySmoke, canaryAuthority];
  const socketPath = mintTestPipe();
  const helper = startHelper({
    socketPath,
    extraEnv: { [CANARY_ENV]: canarySmoke, [AUTHORITY_ENV]: canaryAuthority },
  });
  // wire 响应canary 扫描载体（callBrokerMethod 结果全量收集；扫描在内存内，绝不打印）。
  const wireResults = [];
  try {
    await waitForReady(helper);

    // ── broker_info（原始 wire 文本 + capabilities.uia，A3-AC-10 能力两面同源）──
    const infoRound = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
    assert.ok(infoRound.text, `${CASE}: READY 期 broker_info 必须应答`);
    const info = JSON.parse(infoRound.text);
    assert.equal(info.ok, true, `${CASE}: broker_info ok:true`);
    assert.equal(info.result.pid, helper.child.pid, `${CASE}: broker_info pid = child.pid（health 门）`);
    assert.equal(
      info.result.capabilities?.uia,
      true,
      `${CASE}: capabilities.uia===true（UIA 导出在场 ∧ preflight 通过，§10.9 两面同源）`,
    );
    for (const text of [infoRound.text]) {
      for (const canary of canaries) {
        assert.ok(!text.includes(canary), `${CASE}: canary 绝不出现在 wire 响应文本（§3.2）`);
      }
      assert.ok(!text.includes(socketPath), `${CASE}: pipe 名绝不进 wire 响应（§2.7）`);
    }

    // ── list_apps({})：ok:true + apps 数组（真机枚举；内容不打印）──
    const appsResult = await callBrokerMethod({ socketPath, method: "list_apps", params: {}, timeoutMs: 15_000 });
    wireResults.push(appsResult);
    assert.equal(appsResult.isError, undefined, `${CASE}: list_apps 成功非 isError`);
    const apps = appsResult.structuredContent?.apps;
    assert.ok(Array.isArray(apps) && apps.length >= 1, `${CASE}: list_apps → apps 数组 ≥1（真机枚举）`);
    assert.ok(
      appsResult.content[0].text === JSON.stringify(appsResult.structuredContent),
      `${CASE}: list_apps 文本块与 structuredContent 同键（双载体同构，assert.ok 防内容 dump）`,
    );
    for (let i = 0; i < apps.length; i += 1) {
      assert.deepEqual(
        Object.keys(apps[i]).sort(),
        ["active", "bundle_id", "exe_path", "name", "pid", "window_count"],
        `${CASE}: list_apps.apps[${i}] 键集封闭（§11.2 wire 投影）`,
      );
      assert.ok(Number.isInteger(apps[i].pid) && apps[i].pid > 0, `${CASE}: list_apps.apps[${i}].pid 正整数`);
      assert.ok(
        apps[i].bundle_id === null || typeof apps[i].bundle_id === "string",
        `${CASE}: list_apps.apps[${i}].bundle_id string|null（AUMID）`,
      );
      assert.equal(typeof apps[i].name, "string", `${CASE}: list_apps.apps[${i}].name string（内容不断言）`);
      assert.equal(typeof apps[i].exe_path, "string", `${CASE}: list_apps.apps[${i}].exe_path string`);
      assert.equal(typeof apps[i].active, "boolean", `${CASE}: list_apps.apps[${i}].active boolean`);
      assert.ok(
        Number.isInteger(apps[i].window_count) && apps[i].window_count >= 1,
        `${CASE}: list_apps.apps[${i}].window_count ≥1`,
      );
      if (i > 0) {
        assert.ok(apps[i - 1].pid < apps[i].pid, `${CASE}: list_apps pid 升序（确定性）`);
      }
    }
    // 只读铁律 3（§10.12）：零 delivery-state 键（缺席即语义）。
    for (const key of ["action_sent", "dispatch_status"]) {
      assert.equal(key in appsResult.structuredContent, false, `${CASE}: list_apps 不携带 ${key}（只读铁律 3）`);
    }

    // ── list_windows({})：全量枚举 + Z 顶窗口 pid（get_app_state 的 app_ref 素材）──
    const windowsResult = await callBrokerMethod({ socketPath, method: "list_windows", params: {}, timeoutMs: 15_000 });
    wireResults.push(windowsResult);
    const windows = windowsResult.structuredContent?.windows;
    assert.ok(Array.isArray(windows) && windows.length >= 1, `${CASE}: list_windows → windows 数组 ≥1`);
    assert.ok(
      windowsResult.content[0].text === JSON.stringify(windowsResult.structuredContent),
      `${CASE}: list_windows 双载体同构（assert.ok 防内容 dump）`,
    );
    const seenIds = new Set();
    for (let i = 0; i < windows.length; i += 1) {
      const entry = windows[i];
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["app", "bounds", "minimized", "title", "window_id"],
        `${CASE}: list_windows.windows[${i}] 键集封闭`,
      );
      assert.ok(
        Number.isInteger(entry.window_id) && entry.window_id > 0 && !seenIds.has(entry.window_id),
        `${CASE}: list_windows.windows[${i}].window_id 唯一正整数 token`,
      );
      seenIds.add(entry.window_id);
      assert.equal(typeof entry.title, "string", `${CASE}: list_windows.windows[${i}].title string（内容不断言）`);
      assert.deepEqual(
        Object.keys(entry.app).sort(),
        ["exe_path", "name", "pid"],
        `${CASE}: list_windows.windows[${i}].app 键集封闭`,
      );
      assert.ok(Number.isInteger(entry.app.pid) && entry.app.pid > 0, `${CASE}: list_windows.windows[${i}].app.pid 正整数`);
      assert.equal(typeof entry.minimized, "boolean", `${CASE}: list_windows.windows[${i}].minimized boolean`);
    }
    for (const key of ["action_sent", "dispatch_status"]) {
      assert.equal(key in windowsResult.structuredContent, false, `${CASE}: list_windows 不携带 ${key}`);
    }
    let zTopPid = windows[0].app.pid;

    // ── get_app_state({app_ref:{pid: Z 顶 pid}}) ×2：appStateOf 四必备字段恒在 +
    //    两次 state_id 不同 + app.pid 匹配 + 零 delivery-state 键（§11.2）。
    //    真机瞬态（Z 顶应用在两次调用之间退出/关窗）→ 重取 Z 顶重试一次；仍失败 = 诚实红。──
    const observeState = async (pid) => {
      const observed = await callBrokerMethod({
        socketPath,
        method: "get_app_state",
        params: { app_ref: { pid } },
        timeoutMs: 20_000,
      });
      wireResults.push(observed); // canary 扫描全量覆盖（含重试中途成功的响应）
      return observed;
    };
    let states = null;
    for (let attempt = 0; attempt < 2 && states === null; attempt += 1) {
      try {
        states = [await observeState(zTopPid), await observeState(zTopPid)];
      } catch (error) {
        if (!(error instanceof BrokerError) || attempt === 1) throw error;
        t.diagnostic(`${CASE}: get_app_state 第 1 次尝试 code=${error.code}（真机瞬态候选：Z 顶应用变化）→ 重取 Z 顶重试`);
        const refreshed = await callBrokerMethod({ socketPath, method: "list_windows", params: {}, timeoutMs: 15_000 });
        const refreshedWindows = refreshed.structuredContent?.windows;
        assert.ok(
          Array.isArray(refreshedWindows) && refreshedWindows.length >= 1,
          `${CASE}: 重试前 list_windows 仍有窗口`,
        );
        zTopPid = refreshedWindows[0].app.pid;
      }
    }
    assert.ok(states !== null, `${CASE}: get_app_state ×2 必须成功（重试后）`);
    for (const [slot, result] of states.entries()) {
      const label = `${CASE}: get_app_state#${slot + 1}`;
      assert.equal(result.isError, undefined, `${label}: 成功非 isError`);
      const sc = result.structuredContent;
      // appStateOf 四必备字段恒在（缺失 → SDK 结构性失败，§11.2）。
      for (const key of ["state_id", "app", "window", "elements"]) {
        assert.ok(key in sc, `${label}: 必备字段 ${key} 恒在`);
      }
      assert.ok(
        typeof sc.state_id === "string" && /^st-\d+-\d+$/.test(sc.state_id),
        `${label}: state_id 不透明串 st-<generation>-<counter>（§11.5）`,
      );
      assert.equal(sc.app.pid, zTopPid, `${label}: app.pid 与 app_ref 解析结果匹配`);
      assert.deepEqual(
        Object.keys(sc.app).sort(),
        ["bundle_id", "exe_path", "name", "pid"],
        `${label}: app 键集封闭`,
      );
      assert.deepEqual(
        Object.keys(sc.window).sort(),
        ["bounds", "title", "window_id"],
        `${label}: window 键集封闭`,
      );
      assert.ok(
        Number.isInteger(sc.window.window_id) && sc.window.window_id > 0,
        `${label}: window.window_id 正整数 token`,
      );
      assert.equal(typeof sc.window.title, "string", `${label}: window.title string（内容不断言）`);
      assert.ok(Array.isArray(sc.elements), `${label}: elements 数组`);
      assert.equal(sc.snapshot_mode, "full", `${label}: A3 v1 恒 full 快照（§11.2）`);
      assert.equal(typeof sc.truncated, "boolean", `${label}: truncated boolean`);
      // 树文本块 = content[0]，与 structuredContent.text 同文（树文本绝不打印——ok 防 dump）。
      assert.equal(result.content[0].type, "text", `${label}: 首块 = 树文本块`);
      assert.ok(
        result.content[0].text === sc.text,
        `${label}: 树文本块与 structuredContent.text 同文（内容不打印）`,
      );
      assert.equal(result.content.length, 1, `${label}: 未请求截图 → 恰 1 个文本块`);
      for (let i = 0; i < sc.elements.length; i += 1) {
        const element = sc.elements[i];
        assert.equal(element.index, i, `${label}: elements[${i}].index 连续（文本可见 index ⇔ 注册表可解析）`);
        assert.ok(
          typeof element.role === "string" && element.role.length > 0,
          `${label}: elements[${i}].role 非空 string`,
        );
        assert.equal(typeof element.name, "string", `${label}: elements[${i}].name string（内容不断言）`);
        assert.ok(Array.isArray(element.patterns), `${label}: elements[${i}].patterns 数组`);
        if ("value" in element) {
          assert.equal(typeof element.value, "string", `${label}: elements[${i}].value string（条件键）`);
        }
      }
      // 只读铁律 3：零 delivery-state 键。
      for (const key of ["action_sent", "dispatch_status"]) {
        assert.equal(key in sc, false, `${label}: 不携带 ${key}（只读铁律 3）`);
      }
      // _meta targetApp 展示投影（§11.6；形状深断言在 a3-logic，此处只钉键在场 + schemaVersion）。
      const meta = result._meta?.[CUA_TARGET_APP_DISPLAY_META_KEY];
      assert.ok(meta, `${label}: _meta targetApp 键在场（键 = contracts 常量同值）`);
      assert.equal(meta.schemaVersion, 1, `${label}: _meta schemaVersion=1`);
    }
    assert.notEqual(
      states[0].structuredContent.state_id,
      states[1].structuredContent.state_id,
      `${CASE}: 两次观察 state_id 不同（代内唯一、不复用）`,
    );

    // ── 负控制（全部「确定未派发」域；expectError 形状 = a2-native 同律）──
    const expectError = async (method, params, code, message, label) => {
      let caught = null;
      try {
        await callBrokerMethod({ socketPath, method, params, timeoutMs: 10_000 });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BrokerError, `${label}: 必须抛 BrokerError（实际成功返回）`);
      assert.equal(caught?.code, code, `${label}: code`);
      assert.equal(caught?.message, message, `${label}: 封闭字面量零插值`);
      assert.equal(
        caught?.details?.possiblySent,
        false,
        `${label}: 确定未派发（ok:false 不置歧义，§10.12）`,
      );
    };
    const deadPid = await mintConfirmedDeadPid();
    // ① set_value 坐标 target → invalid_request（set_value 无坐标语义，§11.2；参数校验
    //    先于 app_ref 解析/派发——死 pid 双保险，结构上零派发）。
    await expectError(
      "set_value",
      { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: deadPid }, value: "x" },
      "invalid_request",
      WIRE_ERROR_MESSAGES.invalidParams,
      `${CASE}: set_value 坐标 target`,
    );
    // ② perform_action 越界 index → element_unavailable（resolveStateToken 先于任何
    //    pattern 调用抛 stale——999999 ≥ 预算上限 3000，结构性越界，零派发）。
    await expectError(
      "perform_action",
      { target: { type: "element", index: 999999 }, app_ref: { pid: zTopPid }, action: "invoke" },
      "element_unavailable",
      WIRE_ERROR_MESSAGES.staleObservation,
      `${CASE}: perform_action 越界 index`,
    );
    // ③ list_windows 未运行 name → invalid_request + 零插值全等字面量（§11.3 唯一候选
    //    纪律 0 候选分支；含 SDK isAppNotFound 兼容子串——字面量改动须两侧同审）。
    await expectError(
      "list_windows",
      { app_ref: { name: "definitely-not-running-xyz" } },
      "invalid_request",
      WIRE_ERROR_MESSAGES.appNotRunning,
      `${CASE}: list_windows 未运行 name`,
    );
    {
      // 零插值「恰为」的硬钉（防 WIRE_ERROR_MESSAGES 单源自身漂移）：字面量逐字全等。
      let caught = null;
      try {
        await callBrokerMethod({
          socketPath,
          method: "list_windows",
          params: { app_ref: { name: "definitely-not-running-xyz" } },
          timeoutMs: 10_000,
        });
      } catch (error) {
        caught = error;
      }
      assert.equal(
        caught?.message,
        "Computer Use target app is not running.",
        `${CASE}: list_windows 未运行 name message 恰为固定字面量（零插值全等）`,
      );
    }

    // ── canary 全表面扫描（wire 响应/IPC/stdout/stderr；扫描在内存内，失败消息零内容）──
    for (const result of wireResults) {
      const serialized = JSON.stringify(result);
      for (const canary of canaries) {
        assert.ok(!serialized.includes(canary), `${CASE}: canary 绝不出现在 wire 响应（§3.2）`);
      }
      assert.ok(!serialized.includes(socketPath), `${CASE}: pipe 名绝不进 wire 响应`);
    }
    for (const message of helper.ipcMessages) {
      const serialized = JSON.stringify(message);
      for (const canary of canaries) {
        assert.ok(!serialized.includes(canary), `${CASE}: canary 绝不出现在 IPC 消息（§3.1）`);
      }
    }
    assert.equal(helper.stdout, "", `${CASE}: Helper 永不写 stdout（§2.7）`);
    for (const canary of canaries) {
      assert.ok(!helper.stderr.includes(canary), `${CASE}: canary 绝不出现在 stderr（§3.2）`);
    }
    assert.ok(!helper.stderr.includes(socketPath), `${CASE}: pipe 名绝不出现在 stderr（§2.7）`);

    // ── 优雅 shutdown（§2.7 exit 0；§19 第 14 条 CUA-A3-SHUTDOWN-CRASH 的真机回归面）：
    //    本用例已对 Helper 做过真实 UIA 派发（list_apps/get_app_state）——用过 UIA 的代际
    //    经 IPC shutdown 必须走统一退出收口（cancelOperations + releaseAllHeldInputs +
    //    uiaWorkerShutdown）后 exit 0，绝不 0xC0000409 fail-fast 覆盖退出码（宿主会把
    //    关停误判为崩溃代）。时限判据与 helper-a1 同（宿主 shutdownTimeoutMs=1s 地板）。──
    const shutdownAt = Date.now();
    helper.child.send({ protocol: CONTROL_PROTOCOL, type: "shutdown" });
    const exitInfo = await Promise.race([helper.exited, delay(3000).then(() => null)]);
    assert.ok(exitInfo, `${CASE}: IPC shutdown 后 Helper 必须在 3s 内退出（否则 kill 兜底）`);
    assert.equal(exitInfo.code, 0, `${CASE}: 真实 UIA 派发后优雅 shutdown 必须 exit 0（§2.7/§19 第 14 条）`);
    assert.ok(Date.now() - shutdownAt < 1000, `${CASE}: shutdown 退出 <1s（§2.4 宿主 shutdownTimeoutMs 地板，helper-a1 同判据）`);
  } finally {
    helper.child.kill(); // 优雅 shutdown 已落地时为 no-op（兜底路径）
    await helper.exited.catch(() => {});
  }
});

test("wire|get_app_state include_screenshot：image 块 + frame_id 恒登记（只读捕获；截图字节不打印不落盘；降级瞬态重试一次后诚实 skip，§11.2）", { skip: skipReason }, async (t) => {
  const CASE = "wire 截图";
  const addon = loadAddon();
  if (!(await requireInteractiveDesktop(t, addon, CASE))) return;
  const socketPath = mintTestPipe();
  const helper = startHelper({ socketPath });
  try {
    await waitForReady(helper);
    const windowsResult = await callBrokerMethod({ socketPath, method: "list_windows", params: {}, timeoutMs: 15_000 });
    const windows = windowsResult.structuredContent?.windows;
    assert.ok(Array.isArray(windows) && windows.length >= 1, `${CASE}: list_windows 有窗口`);
    let zTopPid = windows[0].app.pid;

    // 真机瞬态策略：截图捕获失败不拖垮树（§11.2 降级形态 = 告知块 + non_actionable_reason）
    // ——降级/目标应用变化时重取 Z 顶重试一次；仍无 image 块则诚实 skip（捕获面 fail-closed
    // 语义已在 native 负控制用例钉死，此处不放宽任何成功形状断言）。
    let shot = null;
    let lastReason = null;
    for (let attempt = 0; attempt < 2 && shot === null; attempt += 1) {
      let result;
      try {
        result = await callBrokerMethod({
          socketPath,
          method: "get_app_state",
          params: { app_ref: { pid: zTopPid }, include_screenshot: true },
          timeoutMs: 25_000,
        });
      } catch (error) {
        if (!(error instanceof BrokerError) || attempt === 1) throw error;
        lastReason = `wire-error:${error.code}`;
        t.diagnostic(`${CASE}: 第 1 次尝试 BrokerError code=${error.code}（真机瞬态候选）→ 重取 Z 顶重试`);
        const refreshed = await callBrokerMethod({ socketPath, method: "list_windows", params: {}, timeoutMs: 15_000 });
        zTopPid = refreshed.structuredContent.windows[0].app.pid;
        continue;
      }
      const imageBlock = result.content.find((block) => block.type === "image");
      if (imageBlock) {
        shot = { result, imageBlock };
        break;
      }
      // 降级形态本身也是契约（§11.2）：告知性文本块 + non_actionable_reason ∈ 封闭 native 词汇。
      const sc = result.structuredContent;
      for (const key of ["state_id", "app", "window", "elements"]) {
        assert.ok(key in sc, `${CASE}: 截图降级不拖垮树——必备字段 ${key} 恒在`);
      }
      const notice = result.content.find(
        (block) => block.type === "text" && block.text.startsWith("[screenshot unavailable:"),
      );
      assert.ok(notice, `${CASE}: 降级必附告知性文本块（[screenshot unavailable: <固定原因码>]）`);
      assert.ok(
        typeof sc.non_actionable_reason === "string" && sc.non_actionable_reason in WIRE_BY_NATIVE_CODE,
        `${CASE}: non_actionable_reason ∈ 封闭 native 词汇（实际=${sc.non_actionable_reason}）`,
      );
      lastReason = sc.non_actionable_reason;
      if (attempt === 0) {
        t.diagnostic(`${CASE}: 截图降级 reason=${lastReason}（封闭字面量）→ 重取 Z 顶重试一次`);
        const refreshed = await callBrokerMethod({ socketPath, method: "list_windows", params: {}, timeoutMs: 15_000 });
        zTopPid = refreshed.structuredContent.windows[0].app.pid;
      }
    }
    if (shot === null) {
      t.skip(`${CASE}: 两次尝试截图均降级/瞬态失败（reason=${lastReason} 封闭字面量）——真机瞬态按纪律第 4/5 条诚实 skip，树面断言已在主 wire 用例覆盖，非断言放宽`);
      return;
    }

    const { result, imageBlock } = shot;
    assert.equal(result.isError, undefined, `${CASE}: 成功非 isError`);
    assert.ok(
      imageBlock.mimeType === "image/png" || imageBlock.mimeType === "image/jpeg",
      `${CASE}: mimeType ∈ {image/png,image/jpeg}（§11.2 image 块）`,
    );
    assert.equal(typeof imageBlock.data, "string", `${CASE}: data base64 string`);
    assert.ok(imageBlock.data.length > 0, `${CASE}: data 非空`);
    assert.ok(
      imageBlock.data.length <= CAPTURE_INLINE_BASE64_BUDGET_BYTES,
      `${CASE}: base64 折算 ${imageBlock.data.length} ≤ 200 KiB（inline 预算）`,
    );
    // 魔数与 mimeType 一致（解码字节只在断言作用域内存在——绝不打印/落盘）。
    const decoded = Buffer.from(imageBlock.data, "base64");
    assert.ok(decoded.length > 0, `${CASE}: base64 可解码且非空`);
    if (imageBlock.mimeType === "image/png") {
      assert.deepEqual(
        [decoded[0], decoded[1], decoded[2], decoded[3]],
        [0x89, 0x50, 0x4e, 0x47],
        `${CASE}: PNG 魔数与 mimeType 一致`,
      );
    } else {
      assert.deepEqual(
        [decoded[0], decoded[1], decoded[2]],
        [0xff, 0xd8, 0xff],
        `${CASE}: JPEG SOI 与 mimeType 一致`,
      );
    }
    const sc = result.structuredContent;
    assert.ok(
      typeof sc.frame_id === "string" && /^fr-\d+-\d+$/.test(sc.frame_id),
      `${CASE}: frame_id 恒登记并回报（fr-<epoch>-<counter>，SDK frameIdOf 挖掘点）`,
    );
    for (const key of ["state_id", "app", "window", "elements"]) {
      assert.ok(key in sc, `${CASE}: 四必备字段恒在（截图在场不改变树面契约）`);
    }
    for (const key of ["action_sent", "dispatch_status"]) {
      assert.equal(key in sc, false, `${CASE}: get_app_state 不携带 ${key}（只读铁律 3）`);
    }
    assert.ok(!("non_actionable_reason" in sc), `${CASE}: 截图成功 → 无降级告知位`);
    t.diagnostic(`${CASE}: image ${decoded.length}B ${imageBlock.mimeType}（截图字节不落诊断）`);
  } finally {
    helper.child.kill();
    await helper.exited.catch(() => {});
  }
});
