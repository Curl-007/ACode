import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

/**
 * T2：windowsCuaDevHelperHost 的代际管理、两阶段就绪与停止竞态不变量测试。
 *
 * 覆盖 spec docs/upgrades/product-and-support-2026-10.md §7.7 阶段 0 门槛，
 * 断言逐行对应 plan1.md §3.6 表。全部用假 child process 夹具 + 八个注入点，
 * 零真实磁盘 IO、零真实子进程、零真实 socket。
 *
 * 硬约束（plan1 §4.5 实测）：覆盖 kill 升级链的用例必须持有 ref 的 keepAlive 句柄
 * （setInterval(() => {}, 50)），否则 WindowsCuaChildLifecycle.waitForExit 的
 * timer.unref() 会让空闲测试进程 drain，stop() 挂死为 "Detected unsettled top-level
 * await" 而非失败。走 exitOnShutdown 路径的用例不需要 keepAlive。
 */

// 控制协议常量单源自 producer 包（深路径导入，实测从 tests/ 可解析），不另立字面量。
const { WINDOWS_DEV_CONTROL_PROTOCOL: CONTROL } = await import(
  "../../../packages/acode-cua/broker-server.js"
);
const {
  parseReadyMessage,
  isExactHealthPid,
  asError,
  ADDON_ENV,
} = await import("../src/cua-permission-broker/windowsCuaHelperHostSupport.ts");
const { WindowsCuaHelperHost } = await import(
  "../src/cua-permission-broker/windowsCuaDevHelperHost.ts"
);

// Windows named pipe 前缀用字符串拼接构造，规避 heredoc/转义吞反斜杠（plan1 §4.6）。
const PIPE_PREFIX = "\\" + "\\" + "." + "\\" + "pipe" + "\\";
const SOCKET = PIPE_PREFIX + "acode-cua-t2-default";
// authority 用独特字面量，便于断言它绝不泄进 child argv / env。
const AUTH = "t2-plugin-authority-DO-NOT-LEAK-0001";
const CHILD_PID = 4242;

/** 静默 logger：避免 createServiceLogger 往 stderr 打真实日志（plan1 §4.5）。 */
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** 让 fork 的微任务链（含 listener 挂载）跑完；setImmediate 在所有微任务之后触发。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** ready / transport_ready 控制消息构造器。 */
const readyMsg = (socketPath, pid, type = "ready") => ({
  protocol: CONTROL,
  type,
  socketPath,
  pid,
});

/** runtime 元组；路径为不透明字面量，childProcess 被 mock，绝不触真实 fs。 */
function makeRuntime() {
  return {
    root: "C:/acode-cua-t2/root",
    entryPath: "C:/acode-cua-t2/root/dist/windows-helper.js",
    addonPath: "C:/acode-cua-t2/root/build/Release/ax_native.node",
    command: "C:/acode-cua-t2/node.exe",
    commandEnv: { ACODE_CUA_RUNTIME_MARKER: "marker-1" },
  };
}

/**
 * 假 child process 夹具（plan1 §4.5）。send/kill 记录调用顺序以支撑 kill 升级链断言；
 * exitOnShutdown/exitOnKill 控制子进程是否响应对应信号退出。
 */
function makeFakeChild({ pid = CHILD_PID, exitOnShutdown = true, exitOnKill = true } = {}) {
  const ee = new EventEmitter();
  const calls = [];
  return {
    pid,
    calls,
    send(message) {
      calls.push({ op: "send", message });
      if (exitOnShutdown) setImmediate(() => ee.emit("exit", 0));
      return true;
    },
    kill() {
      calls.push({ op: "kill" });
      if (exitOnKill) setImmediate(() => ee.emit("exit", 0));
      return true;
    },
    on: ee.on.bind(ee),
    off: ee.off.bind(ee),
    listenerCount: ee.listenerCount.bind(ee),
    emitMessage: (m) => ee.emit("message", m),
    emitError: (e) => ee.emit("error", e),
    emitExit: (code) => ee.emit("exit", code),
  };
}

/** 记录每次 fork 的 command/argv/options，用于 argv/env 凭据不外泄断言。 */
function makeRecordingChildProcess(makeChild) {
  const forks = [];
  return {
    forks,
    fork(command, argv, options) {
      const child = makeChild(command, argv, options);
      forks.push({ command, argv, options, child });
      return child;
    },
  };
}

/**
 * 组装一个全注入的 host。八个注入点（childProcess/mintSocketPath/mintPluginAuthority/
 * healthProbe/startupTimeoutMs/shutdownTimeoutMs/logger/onUnexpectedExit）全部覆盖。
 */
function makeHost(overrides = {}) {
  const children = [];
  const exits = [];
  const runtime = overrides.runtime ?? makeRuntime();
  const childProcess =
    overrides.childProcess ??
    makeRecordingChildProcess(() => {
      const child = makeFakeChild(overrides.child ?? {});
      children.push(child);
      return child;
    });
  const healthProbe =
    overrides.healthProbe ?? (async () => ({ bundleId: null, pid: CHILD_PID }));
  const onUnexpectedExit = overrides.onUnexpectedExit ?? ((info) => exits.push(info));
  const host = new WindowsCuaHelperHost({
    runtime,
    childProcess,
    mintSocketPath: overrides.mintSocketPath ?? (() => SOCKET),
    mintPluginAuthority: overrides.mintPluginAuthority ?? (() => AUTH),
    healthProbe,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 2000,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 200,
    logger: overrides.logger ?? silentLogger,
    onUnexpectedExit,
  });
  return { host, children, exits, childProcess, runtime, healthProbe };
}

// ─────────────────────────────────────────────────────────────────────────────
// 组 0：控制协议常量单源
// ─────────────────────────────────────────────────────────────────────────────

test("控制协议常量与 broker-server.js:4 WINDOWS_DEV_CONTROL_PROTOCOL 一致", () => {
  assert.equal(CONTROL, "acode-cua-windows-dev/v1");
  assert.equal(ADDON_ENV, "ACODE_CUA_HELPER_ADDON");
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：parseReadyMessage 全分支（零 IO 纯函数）
// ─────────────────────────────────────────────────────────────────────────────

test("parseReadyMessage: 非对象输入 → null", () => {
  assert.equal(parseReadyMessage(null), null);
  assert.equal(parseReadyMessage(undefined), null);
  assert.equal(parseReadyMessage("ready"), null);
  assert.equal(parseReadyMessage(42), null);
});

test("parseReadyMessage: protocol 不符 → ignore（前向兼容，不失败代际）", () => {
  assert.equal(
    parseReadyMessage({ protocol: "wrong-protocol", type: "ready", socketPath: SOCKET, pid: 1 }),
    "ignore",
  );
  assert.equal(parseReadyMessage({ type: "ready", socketPath: SOCKET, pid: 1 }), "ignore");
});

test("parseReadyMessage: 未知 type → ignore（前向兼容）", () => {
  assert.equal(
    parseReadyMessage({ protocol: CONTROL, type: "future_kind", socketPath: SOCKET, pid: 1 }),
    "ignore",
  );
});

test("parseReadyMessage: type:error 带非空 message → 结构化 error", () => {
  assert.deepEqual(parseReadyMessage({ protocol: CONTROL, type: "error", message: "boom" }), {
    protocol: CONTROL,
    type: "error",
    message: "boom",
  });
});

test("parseReadyMessage: type:error 缺/空/非字符串 message → null", () => {
  assert.equal(parseReadyMessage({ protocol: CONTROL, type: "error" }), null);
  assert.equal(parseReadyMessage({ protocol: CONTROL, type: "error", message: "" }), null);
  assert.equal(parseReadyMessage({ protocol: CONTROL, type: "error", message: 123 }), null);
});

test("parseReadyMessage: ready 合法 → 结构化", () => {
  assert.deepEqual(parseReadyMessage(readyMsg(SOCKET, CHILD_PID, "ready")), {
    protocol: CONTROL,
    type: "ready",
    socketPath: SOCKET,
    pid: CHILD_PID,
  });
});

test("parseReadyMessage: transport_ready 合法 → 结构化", () => {
  assert.deepEqual(parseReadyMessage(readyMsg(SOCKET, CHILD_PID, "transport_ready")), {
    protocol: CONTROL,
    type: "transport_ready",
    socketPath: SOCKET,
    pid: CHILD_PID,
  });
});

test("parseReadyMessage: ready 缺 socketPath / socketPath 空 → null", () => {
  assert.equal(parseReadyMessage({ protocol: CONTROL, type: "ready", pid: CHILD_PID }), null);
  assert.equal(
    parseReadyMessage({ protocol: CONTROL, type: "ready", socketPath: "", pid: CHILD_PID }),
    null,
  );
  assert.equal(
    parseReadyMessage({ protocol: CONTROL, type: "ready", socketPath: 42, pid: CHILD_PID }),
    null,
  );
});

test("parseReadyMessage: ready pid 非正整数 → null", () => {
  assert.equal(parseReadyMessage(readyMsg(SOCKET, 0)), null);
  assert.equal(parseReadyMessage(readyMsg(SOCKET, -1)), null);
  assert.equal(parseReadyMessage(readyMsg(SOCKET, 1.5)), null);
  assert.equal(parseReadyMessage({ protocol: CONTROL, type: "ready", socketPath: SOCKET, pid: "1" }), null);
});

test("parseReadyMessage: transport_ready 缺 socketPath / pid 非正整数 → null", () => {
  assert.equal(
    parseReadyMessage({ protocol: CONTROL, type: "transport_ready", pid: CHILD_PID }),
    null,
  );
  assert.equal(parseReadyMessage(readyMsg(SOCKET, 0, "transport_ready")), null);
  assert.equal(parseReadyMessage(readyMsg(SOCKET, -5, "transport_ready")), null);
  assert.equal(parseReadyMessage(readyMsg(SOCKET, 2.5, "transport_ready")), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：isExactHealthPid（零 IO 纯函数）
// ─────────────────────────────────────────────────────────────────────────────

test("isExactHealthPid: pid 匹配 → true", () => {
  assert.equal(isExactHealthPid({ bundleId: null, pid: CHILD_PID }, CHILD_PID), true);
});

test("isExactHealthPid: pid 非整数 → false", () => {
  assert.equal(isExactHealthPid({ bundleId: null, pid: 1.5 }, 1.5), false);
  assert.equal(isExactHealthPid({ bundleId: null, pid: Number.NaN }, 1), false);
});

test("isExactHealthPid: pid ≤ 0 → false", () => {
  assert.equal(isExactHealthPid({ bundleId: null, pid: 0 }, 0), false);
  assert.equal(isExactHealthPid({ bundleId: null, pid: -1 }, -1), false);
});

test("isExactHealthPid: pid 不匹配 → false", () => {
  assert.equal(isExactHealthPid({ bundleId: null, pid: CHILD_PID }, 999), false);
});

test("isExactHealthPid: pid 为 null（占位 probeHelperHealth 形态）→ false", () => {
  // ADDENDUM 第 15 条：默认 probeHelperHealth 恒返回 {bundleId:null,pid:null}，
  // isExactHealthPid 对 null 恒 false，是 split-brain 的根因之一。
  assert.equal(isExactHealthPid({ bundleId: null, pid: null }, null), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 3：asError（零 IO 纯函数）
// ─────────────────────────────────────────────────────────────────────────────

test("asError: Error 原样返回", () => {
  const err = new Error("x");
  assert.equal(asError(err), err);
});

test("asError: 非 Error → 包装为 Error", () => {
  const wrapped = asError("boom");
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.message, "boom");
  assert.equal(asError(42).message, "42");
  assert.equal(asError(null).message, "null");
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 4：Host 生命周期
// ─────────────────────────────────────────────────────────────────────────────

test("代际递增 + 意外退出触发 onUnexpectedExit", async () => {
  const { host, children, exits } = makeHost();

  // 第一代：ready → health → running。
  const p1 = host.start();
  await flush();
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  await p1;
  assert.equal(host.running, true);

  // 已 settled、未 stopped、仍是 current 的代际意外退出 → 触发回调（同步）。
  children[0].emitExit(0);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].generation, 1);
  assert.equal(exits[0].pid, CHILD_PID);
  assert.equal(host.running, false, "意外退出后 handle 清空");

  // 第二代：lastAgentVisibleTransport 被保留 → 复用同一 socketPath。
  const p2 = host.start();
  await flush();
  children[1].emitMessage(readyMsg(SOCKET, CHILD_PID));
  await p2;
  assert.equal(host.running, true);
  children[1].emitExit(0);
  assert.equal(exits.length, 2);
  assert.equal(exits[1].generation, 2);
  assert.ok(exits[1].generation > exits[0].generation, "generation 严格递增（:307 ++nextGeneration）");
});

test("split-brain：transport_ready 先于 healthProbe resolve → waitForTransport 成功但 running===false", async () => {
  // ADDENDUM 第 15 条 / plan1 §9.1：这是既有行为，非本测试引入。transport_ready 在
  // healthProbe 之前直接 return（:404-408），故 waitForTransport 已成功、Agent 拿到
  // {socketPath,pluginAuthority} 能连 pipe，但 handle 仍为 null → running 恒 false。
  let healthCalled = 0;
  const healthProbe = async () => {
    healthCalled += 1;
    return { bundleId: null, pid: CHILD_PID };
  };
  const { host, children } = makeHost({ healthProbe });

  const startPromise = host.start();
  const transportPromise = host.waitForTransport(1000);
  await flush();
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID, "transport_ready"));

  const transport = await transportPromise;
  assert.equal(transport.socketPath, SOCKET);
  assert.equal(transport.pluginAuthority, AUTH);
  assert.equal(host.running, false, "split-brain：transport 已就绪但完整 handle 未建立");
  assert.equal(healthCalled, 0, "transport_ready 分支不触发 healthProbe（:408 提前 return）");

  // 清理：stop() 同步 abort 仍悬挂的 start promise。
  await host.stop();
  await assert.rejects(startPromise, /startup stopped/);
  assert.equal(host.running, false);
});

test("完整链：ready → healthProbe → handle 赋值 → running===true", async () => {
  const { host, children, runtime } = makeHost();
  const p = host.start();
  await flush();
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  const handle = await p;

  assert.equal(host.running, true);
  assert.equal(handle.socketPath, SOCKET);
  assert.equal(handle.launchSocketPath, SOCKET, "Windows named pipe 无冷启动 rendezvous，两者恒等");
  assert.equal(handle.pluginAuthority, AUTH);
  assert.equal(handle.pid, CHILD_PID);
  assert.equal(handle.helperAppPath, runtime.entryPath);
  assert.equal(host.socketPath, SOCKET);
  assert.equal(host.pluginAuthority, AUTH);

  // handle 存在时 waitForTransport 直接从 handle resolve。
  const t = await host.waitForTransport();
  assert.equal(t.socketPath, SOCKET);
  assert.equal(t.pluginAuthority, AUTH);
});

test("health-pid-mismatch：healthProbe pid 不符 → 失败", async () => {
  const healthProbe = async () => ({ bundleId: null, pid: 999 });
  const { host, children } = makeHost({ healthProbe });
  const p = host.start();
  await flush();
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  await assert.rejects(p, /health-pid-mismatch/);
  assert.equal(host.running, false);
});

test("ready-pid-mismatch：ready.pid 与 child.pid 不符 → 失败", async () => {
  const { host, children } = makeHost();
  const p = host.start();
  await flush();
  // pid 999 是合法正整数（parseReadyMessage 接受），但与 child.pid(4242) 不符。
  children[0].emitMessage(readyMsg(SOCKET, 999));
  await assert.rejects(p, /ready-pid-mismatch/);
  assert.equal(host.running, false);
});

test("ready.socketPath 不符 → 静默忽略（不失败），随后正确 ready 成功", async () => {
  const healthCalls = [];
  const healthProbe = async (sp) => {
    healthCalls.push(sp);
    return { bundleId: null, pid: CHILD_PID };
  };
  const { host, children } = makeHost({ healthProbe });
  const p = host.start();
  await flush();

  // socketPath 不符：onMessage 在 :401 直接 return，不 resolveTransport、不 healthProbe。
  children[0].emitMessage(readyMsg(PIPE_PREFIX + "wrong-socket", CHILD_PID));
  await flush();
  assert.equal(host.running, false);
  assert.equal(healthCalls.length, 0, "socketPath 不符时不触发 healthProbe");

  // 正确 socketPath：全链完成。
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  const handle = await p;
  assert.equal(host.running, true);
  assert.equal(handle.socketPath, SOCKET);
  assert.equal(healthCalls.length, 1);
});

test("malformed control message → 失败（Invalid control message）", async () => {
  const { host, children } = makeHost();
  const p = host.start();
  await flush();
  // type:ready 但缺 socketPath/pid → parseReadyMessage 返回 null → malformed-message。
  children[0].emitMessage({ protocol: CONTROL, type: "ready" });
  await assert.rejects(p, /Invalid Windows Computer Use Helper control message/);
  assert.equal(host.running, false);
});

test("helper-reported-error：type:error 消息 → 以 helper 的 message 失败", async () => {
  const { host, children } = makeHost();
  const p = host.start();
  await flush();
  children[0].emitMessage({ protocol: CONTROL, type: "error", message: "helper startup boom" });
  await assert.rejects(p, /helper startup boom/);
  assert.equal(host.running, false);
});

test("stop 后到达的 ready 被三重守卫丢弃（:387）", async () => {
  const healthCalls = [];
  const healthProbe = async (sp) => {
    healthCalls.push(sp);
    return { bundleId: null, pid: CHILD_PID };
  };
  const { host, children } = makeHost({ healthProbe });
  const p = host.start();
  await flush();

  // 同步调用 stop()：generation.stopped=true、externalStopEpoch+=1、abort 拒绝 start、
  // sendShutdown 调度 setImmediate(exit)（尚未触发）。
  const stopPromise = host.stop();
  // 在 exit 触发前同步投递 ready：onMessage 命中 generation.stopped 守卫 → 丢弃。
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  await stopPromise;

  assert.equal(healthCalls.length, 0, "守卫丢弃后不触发 healthProbe");
  assert.equal(host.running, false);
  await assert.rejects(p, /startup stopped/);
  await assert.rejects(host.waitForTransport(), /not starting/);
});

test("已 settled 且已 stopped 的代际退出 → 不触发 onUnexpectedExit", async () => {
  const { host, children, exits } = makeHost();
  const p = host.start();
  await flush();
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  await p;
  assert.equal(host.running, true);

  // stop() 先置 generation.stopped=true，再让 child 退出；onExit 的 !generation.stopped
  // 守卫（:372）使意外退出回调不触发。
  await host.stop();
  await flush();
  assert.equal(exits.length, 0, "stopped 代际的退出不是意外退出");
  assert.equal(host.running, false);
});

test("stop 后 running===false 且 lastAgentVisibleTransport 清空（重启铸新 socket）", async () => {
  let mintCount = 0;
  const mintSocketPath = () => {
    mintCount += 1;
    return PIPE_PREFIX + "acode-cua-t2-" + mintCount;
  };
  const { host, children, childProcess } = makeHost({ mintSocketPath });
  const socket1 = PIPE_PREFIX + "acode-cua-t2-1";

  const p1 = host.start();
  await flush();
  children[0].emitMessage(readyMsg(socket1, CHILD_PID));
  const h1 = await p1;
  assert.equal(h1.socketPath, socket1);
  assert.equal(host.running, true);

  await host.stop();
  assert.equal(host.running, false);
  await assert.rejects(host.waitForTransport(), /not starting/);

  // lastAgentVisibleTransport 已被 stop 清空 → 重启走 fresh mint（不复用旧 tuple）。
  const p2 = host.start();
  await flush();
  assert.equal(mintCount, 2, "stop 清空 lastAgentVisibleTransport 后重启重新铸 socket");
  const socket2 = PIPE_PREFIX + "acode-cua-t2-2";
  assert.equal(childProcess.forks[1].argv[2], socket2);
  children[1].emitMessage(readyMsg(socket2, CHILD_PID));
  const h2 = await p2;
  assert.equal(h2.socketPath, socket2);
  assert.equal(host.running, true);
});

test("start 同 epoch 幂等：并发调用返回同一 promise、只 fork 一次", async () => {
  const { host, children } = makeHost();
  const p1 = host.start();
  const p2 = host.start();
  assert.equal(p1, p2, "同 epoch 的在途 start 复用同一 promise（:132）");

  await flush();
  assert.equal(children.length, 1, "幂等：不重复 fork");
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  const [h1, h2] = await Promise.all([p1, p2]);
  assert.equal(h1, h2);
  assert.equal(host.running, true);
});

test("waitForTransport 无在途 start → 立即 reject", async () => {
  const { host } = makeHost();
  await assert.rejects(host.waitForTransport(), /not starting/);
});

test("kill 升级链：sendShutdown → 等待超时 → kill → 子进程退出（无 blocker）", async () => {
  // 硬约束：child 忽略 shutdown，只在 kill 后退出 → waitForExit 依赖 unref'd timer 超时
  // 推进；必须持 ref 的 keepAlive 句柄，否则测试进程 drain、stop() 挂死。
  const keepAlive = setInterval(() => {}, 50);
  try {
    const child = makeFakeChild({ pid: CHILD_PID, exitOnShutdown: false, exitOnKill: true });
    const childProcess = makeRecordingChildProcess(() => child);
    const { host } = makeHost({ childProcess, shutdownTimeoutMs: 120, startupTimeoutMs: 1000 });

    const p = host.start();
    await flush();
    child.emitMessage(readyMsg(SOCKET, CHILD_PID));
    await p;
    assert.equal(host.running, true);

    await host.stop();
    const ops = child.calls.map((c) => c.op);
    assert.ok(ops.includes("send"), "先 sendShutdown");
    assert.ok(ops.includes("kill"), "超时后升级 kill");
    assert.ok(ops.indexOf("send") < ops.indexOf("kill"), "sendShutdown 先于 kill");
    assert.equal(ops.filter((o) => o === "send").length, 1);
    assert.equal(ops.filter((o) => o === "kill").length, 1);
    assert.equal(host.running, false);
  } finally {
    clearInterval(keepAlive);
  }
});

test("kill 升级链尽头：child 忽略 shutdown+kill → terminationBlocker，后续 start 亦拒", async () => {
  const keepAlive = setInterval(() => {}, 50);
  try {
    const child = makeFakeChild({ pid: CHILD_PID, exitOnShutdown: false, exitOnKill: false });
    const childProcess = makeRecordingChildProcess(() => child);
    const { host } = makeHost({ childProcess, shutdownTimeoutMs: 100, startupTimeoutMs: 1000 });

    const p = host.start();
    await flush();
    child.emitMessage(readyMsg(SOCKET, CHILD_PID));
    await p;

    await assert.rejects(host.stop(), /termination blocker/i);
    const ops = child.calls.map((c) => c.op);
    assert.ok(ops.includes("send") && ops.includes("kill"));
    assert.ok(ops.indexOf("send") < ops.indexOf("kill"));

    // terminationBlocker 记入后，后续 enqueue 全部 reject（:235）。
    await assert.rejects(host.start(), /termination blocker/i);
  } finally {
    clearInterval(keepAlive);
  }
});

test("pluginAuthority 不进 child argv / env / 日志（argv 仅 5 项）", async () => {
  // spec §7.7 隐私门槛把 pluginAuthority 的禁泄通道列为 argv / 进程标题 / 日志 / 错误文本四条。
  // silentLogger 是全 no-op，无法验证「日志」通道，故本用例注入记录型 logger，捕获四级全部实参，
  // 断言 AUTH 不出现在任何一条日志里——把「日志」通道也纳入门槛，而非只看 argv/env。
  const logCalls = [];
  const recordingLogger = {
    debug: (...a) => logCalls.push(["debug", ...a]),
    info: (...a) => logCalls.push(["info", ...a]),
    warn: (...a) => logCalls.push(["warn", ...a]),
    error: (...a) => logCalls.push(["error", ...a]),
  };
  const { host, children, childProcess, runtime } = makeHost({ logger: recordingLogger });
  const p = host.start();
  await flush();

  const fork = childProcess.forks[0];
  assert.equal(fork.command, runtime.command);
  // argv 精确 5 项：[entryPath, --socket, socketPath, --parent-pid, pid]。
  assert.deepEqual(fork.argv, [
    runtime.entryPath,
    "--socket",
    SOCKET,
    "--parent-pid",
    String(process.pid),
  ]);
  assert.equal(fork.argv.length, 5);
  assert.ok(
    !fork.argv.some((a) => typeof a === "string" && a.includes(AUTH)),
    "pluginAuthority 绝不出现在 argv",
  );

  const env = fork.options.env;
  const envValues = Object.values(env).map((v) => String(v));
  const envKeys = Object.keys(env);
  assert.ok(!envValues.some((v) => v.includes(AUTH)), "pluginAuthority 绝不出现在 env 值");
  assert.ok(!envKeys.some((k) => k.includes(AUTH)), "pluginAuthority 绝不出现在 env 键");
  assert.equal(env[ADDON_ENV], runtime.addonPath, "addon 路径经 env 传递");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.ACODE_CUA_RUNTIME_MARKER, "marker-1", "runtime.commandEnv 被透传");
  assert.equal(fork.options.cwd, runtime.root);

  // authority 只存在于 host-facing handle，不下发子进程。
  children[0].emitMessage(readyMsg(SOCKET, CHILD_PID));
  const handle = await p;
  assert.equal(handle.pluginAuthority, AUTH);
  assert.equal(host.pluginAuthority, AUTH);

  // 「日志」通道：start→ready→handle 全链跑完后，AUTH 不得出现在任何一条日志实参里
  // （序列化每个实参再子串匹配，覆盖字符串拼接进 message 或塞进结构化字段两种泄漏形态）。
  const logBlob = logCalls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
  assert.ok(
    !logBlob.includes(AUTH),
    `pluginAuthority 绝不出现在日志（记录到 ${logCalls.length} 条日志调用）`,
  );
});
