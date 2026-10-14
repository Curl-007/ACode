/**
 * cua-producer A1 集成 + 单元测试（specs/windows-helper-producer.md §6.2/§6.3）。
 *
 * 双重守卫（§6.1 第 2 条，ubuntu CI 安全）：process.platform === "win32" 且两个工件
 * （cua-producer/dist/windows-helper.js、cua-producer/build/Release/ax_native.node）均存在
 * 才实跑；否则整文件 skip（CI 不构建 producer → 工件必然缺失 → skip，skip 原因可见）。
 *
 * 导入纪律（§6.1 硬规则）：对 cua-producer/dist/** 的一切导入都是守卫判定之后的条件动态
 * await import()；静态顶层 import 只有 node: 内建、node:test/assert 与恒在的仓内角色 B 源
 * 文件（packages/acode-cua/broker.js、index.js——已入库、CI 必在）。根因：node:test 在文件
 * 加载期即解析静态 import，工件缺失的 ubuntu 上静态 dist 导入会在任何 skip 守卫执行前抛
 * ERR_MODULE_NOT_FOUND，击穿守卫、CI 必红。
 *
 * 集成面（§6.2）：真子进程（fork，普通 node——N-API 稳定 ABI 免重编译）+ 真 named pipe +
 * 真角色 B 客户端（callBrokerMethod/probeHelperHealth/createComputerUseRuntime），首次形成
 * wire 两侧契约互证（§6.4）。测试自铸唯一 pipe 名，前缀 acode-cua-a1-test- 与生产前缀
 * acode-cua-broker- 隔离（§6.2）。
 */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 恒在的仓内角色 B 客户端（静态导入允许——已入库文件，与 cua-broker-wire.test.mjs 同先例）。
import {
  BrokerError,
  callBrokerMethod,
  probeHelperHealth,
} from "../../../packages/acode-cua/broker.js";
import { createComputerUseRuntime } from "../../../packages/acode-cua/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const producerRoot = join(repoRoot, "cua-producer");
const entryPath = join(producerRoot, "dist", "windows-helper.js");
const addonPath = join(producerRoot, "build", "Release", "ax_native.node");

// 接口事实常量（宿主 windowsCuaHelperHostSupport.ts / broker-server.js 同值；测试侧自持，
// 避免为取常量而深导入 services TS 源）。
const CONTROL_PROTOCOL = "acode-cua-windows-dev/v1";
const ADDON_ENV = "ACODE_CUA_HELPER_ADDON";
const AUTHORITY_ENV = "ACODE_CUA_PLUGIN_AUTHORITY";

// 14 方法表（wire spec §8.1 词汇/接口事实；§6.2 步骤 4 要求逐一断言、不参数化折叠）。
const FOURTEEN_METHODS = [
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
];

// §4.6/§4.6.1 封闭 wire error 字面量表（断言锚：响应必须是这些字面量，零插值）。
const WIRE_MESSAGES = {
  warming: "Computer Use Helper is starting up.",
  unimplemented: "Computer Use method is not implemented by this producer.",
  methodNotFound: "Unknown Computer Use broker method.",
  invalidRequest: "Invalid Computer Use broker request line.",
  invalidParams: "Invalid Computer Use method parameters.",
  appNotRunning: "Computer Use target app is not running.",
};

// ── 双重守卫（§6.1）───────────────────────────────────────────────────────────
const skipReason =
  process.platform !== "win32"
    ? "cua-producer A1 tests require win32 (named pipe + MSVC-built addon)"
    : !existsSync(entryPath) || !existsSync(addonPath)
      ? "cua-producer artifacts missing (dist/windows-helper.js + build/Release/ax_native.node); run `npm install && npm run build` inside cua-producer"
      : false;

// 守卫判定之后的条件动态导入（§6.1 导入纪律；ubuntu 上永不执行）。
let wireServer = null;
let backendA1 = null;
if (skipReason === false) {
  wireServer = await import(pathToFileURL(join(producerRoot, "dist", "wire-server.js")).href);
  backendA1 = await import(pathToFileURL(join(producerRoot, "dist", "backend-a1.js")).href);
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 测试自铸唯一 pipe 名（§6.2：前缀与生产 acode-cua-broker- 隔离，同机不撞名）。 */
function mintTestPipe() {
  return `\\\\.\\pipe\\acode-cua-a1-test-${randomUUID()}`;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * 按宿主 fork 面拉起真 Helper（§2.1）：argv 白名单 + env 注入 addon 绝对路径 +
 * ELECTRON_RUN_AS_NODE=1；silent 捕获 stdout/stderr（凭据/pipe 名泄漏断言面，§6.2 步骤 7）。
 * execArgv 显式清空：本测试进程经 `node --import tsx --test` 启动，fork 缺省会继承
 * execArgv——tsx 从 producer cwd 解析不到会把 Helper 启动打崩，且宿主 fork 也不带 execArgv。
 */
function startHelper(options) {
  const socketPath = options.socketPath ?? mintTestPipe();
  const argv =
    options.argvOverride ?? ["--socket", socketPath, "--parent-pid", String(options.parentPid ?? process.pid)];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...options.extraEnv };
  if (options.omitAddonEnv) delete env[ADDON_ENV];
  else env[ADDON_ENV] = options.addonEnv ?? addonPath;
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
    spawnError: null,
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
  child.on("message", (message) => helper.ipcMessages.push(message));
  child.on("error", (error) => {
    helper.spawnError = error;
  });
  return helper;
}

/** 轮询等待满足谓词的 IPC 消息（超时以断言失败暴露全部已收消息，诊断可回溯）。 */
async function waitForIpcMessage(helper, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = helper.ipcMessages.find(predicate);
    if (found !== undefined) return found;
    if (helper.spawnError) assert.fail(`helper spawn failed while waiting for ${label}: ${helper.spawnError.name}`);
    if (Date.now() > deadline) {
      assert.fail(
        `timed out after ${timeoutMs}ms waiting for IPC message ${label}; received: ${JSON.stringify(helper.ipcMessages)}; stderr: ${helper.stderr}`,
      );
    }
    await delay(20);
  }
}

async function waitForReady(helper, timeoutMs = 15_000) {
  return waitForIpcMessage(helper, (message) => message?.type === "ready", timeoutMs, "ready");
}

async function waitForExit(helper, timeoutMs) {
  const outcome = await Promise.race([helper.exited, delay(timeoutMs).then(() => null)]);
  if (outcome === null) {
    helper.child.kill();
    assert.fail(`helper did not exit within ${timeoutMs}ms`);
  }
  return outcome;
}

/**
 * 原始单连接单请求往返（wire spec §1.2 的测试侧同构实现）：写入 payload，读到第一个 \n。
 * 恒 resolve { text, errorCode }：text = 完整响应行（无则为 null——「拆连接且无响应行」的
 * 断言载体）；errorCode = 首个 socket 错误码（如 ENOENT/ECONNRESET）。
 */
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
        // 超大 payload 写入期间被服务端拆连接：error 事件路径接管。
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

/** 铸一个确认已消失的 pid（§6.2 步骤 9d）：短命进程退出后取 pid，并复核 ESRCH（防即刻复用）。 */
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
 * 分段写入的原始往返（§17.2 测试夹具）：payload 以 Buffer 在 splitAt 字节处切成两次
 * 独立 socket 写入（间隔 gapMs 保证服务端收到两个独立 chunk）——用于构造「多字节字符
 * 跨 chunk 劈裂」与「1 MiB cap 按 wire 原始字节判定」样本。返回形态同 rawRequest。
 */
function rawRequestSplit(socketPath, payload, splitAt, { gapMs = 60, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let errorCode = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const newline = buffer.indexOf(0x0a);
      resolvePromise({
        text: newline === -1 ? null : buffer.subarray(0, newline).toString("utf8"),
        errorCode,
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPromise(new Error(`split raw request to pipe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      socket.on("data", (chunk) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        if (buffer.indexOf(0x0a) !== -1) finish();
      });
      socket.on("error", (error) => {
        errorCode = errorCode ?? error?.code ?? "error";
        finish();
      });
      socket.on("close", finish);
      try {
        socket.write(payload.subarray(0, splitAt));
      } catch {
        return; // 超大 payload 首段写入即被拆：error/close 路径接管。
      }
      setTimeout(() => {
        try {
          socket.write(payload.subarray(splitAt));
        } catch {
          // 第二段写入期间被服务端拆连接（超限样本的预期形态）：error 路径接管。
        }
      }, gapMs);
    });
  });
}

/**
 * parseReadyMessage 逐字段对齐（windowsCuaHelperHostSupport.ts:205-231 的测试侧复刻；
 * 行号 2026-10-14 A2 批次按当前检出校准——旧注释引 :202-228/:207/:216-217/:218-220 已漂移，
 * 现值：protocol 判定 :210、socketPath 非空串 :219-220、pid 正整数 :221-222；
 * 回显/pid 全等校验在 windowsCuaDevHelperHost.ts:401/:402-403）。
 */
function assertReadyMessageShape(message, type, socketPath, pid) {
  assert.equal(message.protocol, CONTROL_PROTOCOL, "protocol 必须匹配（support :210）");
  assert.equal(message.type, type);
  assert.equal(typeof message.socketPath, "string");
  assert.ok(message.socketPath.length > 0, "socketPath 非空串（support :219-220）");
  assert.equal(message.socketPath, socketPath, "socketPath 必须是传入值逐字回显（host :401）");
  assert.ok(Number.isInteger(message.pid) && message.pid > 0, "pid 正整数（support :221-222）");
  assert.equal(message.pid, pid, "pid 必须与 fork 出的 child.pid 全等（host :402-403）");
}

// ── 集成断言面（§6.2，真子进程 + 真 named pipe + 真角色 B 客户端）─────────────

test("集成|两阶段 ready 时序 + argv 白名单 + 凭据 canary 不泄漏 + 干净 shutdown（§6.2 步骤 1/3/7/8）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  // canary 模拟最坏继承场景（§3.1 防御纵深：真实宿主不给 Helper 注入 authority）。
  const canary = `canary-${randomBytes(12).toString("hex")}`;
  const helper = startHelper({ socketPath, extraEnv: { [AUTHORITY_ENV]: canary } });
  try {
    // 步骤 3：fork 参数恒等于白名单 [entry, --socket, pipe, --parent-pid, pid]（无凭据、无多余项）。
    assert.deepEqual(helper.argv, ["--socket", socketPath, "--parent-pid", String(process.pid)]);
    assert.ok(!helper.argv.some((value) => value.includes(canary)), "canary 绝不出现在 child argv（§3.2）");

    // 步骤 1：transport_ready 先于 ready，两条逐字段过 parseReadyMessage 判据。
    const transport = await waitForIpcMessage(
      helper,
      (message) => message?.type === "transport_ready",
      15_000,
      "transport_ready",
    );
    const ready = await waitForReady(helper);
    assert.ok(
      helper.ipcMessages.indexOf(transport) < helper.ipcMessages.indexOf(ready),
      "transport_ready 必须先于 ready（§2.2 顺序契约）",
    );
    assertReadyMessageShape(transport, "transport_ready", socketPath, helper.child.pid);
    assertReadyMessageShape(ready, "ready", socketPath, helper.child.pid);
    // 各恰好发送一次（宿主对同代重复 ready 无完整幂等保护，§2.2）。
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "transport_ready").length, 1);
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "ready").length, 1);

    // 步骤 7（wire 面）：原始连接捕获 broker_info 与一个工具方法的精确响应行，canary 不泄漏。
    // A2 增量（§10.9）：broker_info 携带 capabilities 子集（additive）；pid/bundle_id 的
    // A1 最小诚实面保持（health 门 load-bearing）。工具方法样本改用 list_apps（A3 面，
    // 保持 unimplemented——left_click 等 8 方法自 A2 起真实受理，见专用测试）。
    const infoRound = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
    assert.ok(infoRound.text, "READY 期 broker_info 必须应答");
    const info = JSON.parse(infoRound.text);
    assert.equal(info.ok, true);
    assert.equal(info.result.pid, helper.child.pid, "pid = child.pid（isExactHealthPid 面）");
    assert.equal(info.result.bundle_id, process.execPath, "bundle_id = canonical exe（wire spec §6.2 规则 2）");
    assert.ok(info.result.capabilities && typeof info.result.capabilities === "object", "A2 capabilities 增量在场");
    const toolRound = await rawRequest(socketPath, `${JSON.stringify({ method: "list_apps", params: {} })}\n`);
    assert.ok(toolRound.text);
    assert.deepEqual(JSON.parse(toolRound.text), {
      ok: false,
      error: { message: WIRE_MESSAGES.unimplemented, code: "unimplemented" },
    });
    for (const text of [infoRound.text, toolRound.text]) {
      assert.ok(!text.includes(canary), "canary 绝不出现在 wire 响应文本（§6.2 步骤 7）");
      assert.ok(!text.includes(socketPath), "pipe 名绝不进 wire 响应");
    }

    // 步骤 7（IPC 面）：canary 不出现在任何 IPC 消息。
    for (const message of helper.ipcMessages) {
      assert.ok(!JSON.stringify(message).includes(canary), "canary 绝不出现在 IPC 消息（§3.1）");
    }

    // 步骤 8：IPC shutdown → exit 0 且 <1000ms（宿主 shutdownTimeoutMs 地板）。
    const shutdownAt = Date.now();
    helper.child.send({ protocol: CONTROL_PROTOCOL, type: "shutdown" });
    const exitInfo = await waitForExit(helper, 5_000);
    assert.equal(exitInfo.code, 0, "shutdown 必须 exit 0（§2.7）");
    assert.ok(Date.now() - shutdownAt < 1000, "shutdown 退出必须在 1s 内（§2.4/宿主 :37）");

    // 步骤 7（stdio 面）：stdout 恒空（§2.7 stdout 纪律）；stdout/stderr 不含 canary 与 pipe 名。
    assert.equal(helper.stdout, "", "Helper 永不写 stdout（§2.7）");
    assert.ok(!helper.stderr.includes(canary), "canary 绝不出现在 stderr（§3.2）");
    assert.ok(!helper.stderr.includes(socketPath), "pipe 名绝不出现在 stderr（§2.7 stderr 纪律）");

    // 步骤 8：退出后对 pipe 的新连接被拒（win32 named pipe 不存在 → ENOENT）。
    const afterExit = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
    assert.equal(afterExit.text, null);
    assert.equal(afterExit.errorCode, "ENOENT", "退出后 pipe 必须拒连（AC-9）");
  } finally {
    helper.child.kill();
  }
});

test("集成|健康握手成立 + 6 UIA 方法逐一 unimplemented + 8 个 A2 方法诚实受理（§6.2 步骤 2/4；AC-5/AC-6；A2 批次修订）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper({ socketPath });
  try {
    await waitForReady(helper);

    // 步骤 2：真角色 B 客户端 probeHelperHealth → {bundleId: execPath, pid: child.pid}。
    // 链路乙无 token（wire spec §2.3 已裁决）；「token 握手」的 ACode 现行等价物 =
    // ready 时序 + broker_info 健康握手 + 凭据 canary 不泄漏（producer spec §8 oQ2）。
    const health = await probeHelperHealth(socketPath, { timeoutMs: 5000 });
    assert.equal(health.pid, helper.child.pid, "isExactHealthPid 语义成立（health 门只校 pid）");
    assert.equal(health.bundleId, process.execPath, "bundle_id = canonical exe 绝对路径（wire spec §6.2 规则 2）");

    // A3 面 6 方法逐一（不参数化折叠）→ BrokerError code "unimplemented"（→SDK
    // ACTION_UNAVAILABLE、retry never；C09：显式不可用、零假成功）。
    const a3Methods = ["list_apps", "list_windows", "get_app_state", "set_value", "select_text", "perform_action"];
    assert.equal(a3Methods.length, 6, "A2 切片后仍 unimplemented 的恰是 6 个 UIA 方法（§10.0）");
    for (const method of a3Methods) {
      let caught = null;
      try {
        await callBrokerMethod({ socketPath, method, params: {}, timeoutMs: 8000 });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BrokerError, `${method}: 必须抛 BrokerError，绝不返回空成功（C09 红线）`);
      assert.equal(caught.code, "unimplemented", `${method}: code 必须是 unimplemented`);
      assert.equal(caught.message, WIRE_MESSAGES.unimplemented, `${method}: 封闭字面量、零插值（§4.6）`);
      // Helper 明确回信（应用层 ok:false）≠ 传输层歧义：possiblySent 必须 false（§5.4）。
      assert.equal(caught.details?.possiblySent, false, `${method}: 应用层拒绝不得置 possiblySent`);
    }

    // A2 面 8 方法逐一：空参调用必须「诚实受理」——绝不再是 unimplemented。6 个变更/
    // 校验面方法以 invalid_request 固定字面量拒绝空参（派发前确定拒绝，零真实注入——
    // 默认套件安全）；stop/request_access 空参合法 → ok 结果（stop 空态 no-op 释放）。
    const invalidParamMethods = ["left_click", "scroll", "left_click_drag", "type", "key", "paste"];
    for (const method of invalidParamMethods) {
      let caught = null;
      try {
        await callBrokerMethod({ socketPath, method, params: {}, timeoutMs: 8000 });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof BrokerError, `${method}: 空参必须拒绝`);
      assert.equal(caught.code, "invalid_request", `${method}: A2 已注册 → 参数面拒绝而非 unimplemented`);
      assert.equal(caught.details?.possiblySent, false, `${method}: 参数校验失败 = 确定未派发`);
    }
    const stopResult = await callBrokerMethod({ socketPath, method: "stop_computer_control", params: {}, timeoutMs: 8000 });
    assert.equal(stopResult.structuredContent?.dispatch_status, "accepted", "stop 空态 no-op → accepted 收据");
    const accessResult = await callBrokerMethod({ socketPath, method: "request_access", params: {}, timeoutMs: 8000 });
    assert.equal(JSON.parse(accessResult.content[0].text).platform, "win32", "request_access 只读快照受理");

    // 步骤 4：经 execute（角色 B runtime）取 A3 面 + A2 参数拒绝面各一，断言 isError 单文本块信封。
    const runtime = createComputerUseRuntime({ brokerSocketPath: socketPath });
    for (const [toolName, expectedCode] of [["left_click", "invalid_request"], ["list_apps", "unimplemented"]]) {
      const result = await runtime.execute({ toolName, arguments: {} });
      assert.equal(result.isError, true, `${toolName}: execute 必须返回 isError 信封`);
      assert.ok(Array.isArray(result.content) && result.content.length === 1, `${toolName}: 单文本块`);
      assert.equal(result.content[0].type, "text");
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.code, expectedCode, `${toolName}: 信封内 code（SDK brokerErrorCodeOf 挖掘点）`);
      assert.equal(payload.error?.code, expectedCode);
    }
  } finally {
    helper.child.kill();
  }
});

test("集成|协议违规面：method_not_found / invalid_request 欠响应 / >1MiB 拆连接无响应（§6.2 步骤 5；AC-7）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper({ socketPath });
  try {
    await waitForReady(helper);

    // 未知方法（格式合法但 ∉14 表且 ≠ broker_info）→ method_not_found（§4.6）。
    let caught = null;
    try {
      await callBrokerMethod({ socketPath, method: "open_application", timeoutMs: 8000 });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof BrokerError);
    assert.equal(caught.code, "method_not_found");
    assert.equal(caught.message, WIRE_MESSAGES.methodNotFound);

    // 垃圾行（非 JSON）→ 仍欠一行 invalid_request 响应，不得静默关连接（wire spec §9.1）。
    const garbage = await rawRequest(socketPath, "this-is-not-json\n");
    assert.ok(garbage.text, "解析失败仍欠一行响应（§4.6）");
    assert.deepEqual(JSON.parse(garbage.text), {
      ok: false,
      error: { message: WIRE_MESSAGES.invalidRequest, code: "invalid_request" },
    });

    // >1 MiB 请求 → 行缓冲超限、连接被拆且无响应行（§2.6：与客户端 1 MiB 上限对称）。
    const oversized = `{"method":"type","params":"${"a".repeat(1024 * 1024 + 64)}"}\n`;
    const torn = await rawRequest(socketPath, oversized, { timeoutMs: 15_000 });
    assert.equal(torn.text, null, "超限请求不得得到响应行");

    // 拆连接后 server 必须仍健康（每连接独立处理，§2.6 无并发限流但也不得被单连接拖垮）。
    const after = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
    assert.ok(after.text, "超限拆连接后 server 必须继续服务");
    assert.equal(JSON.parse(after.text).ok, true);
  } finally {
    helper.child.kill();
  }
});

test("集成|addon 诚实面：probe napiVersion=9 防漂移锚 + addonVersion=package.json version + 导出面封闭（§6.2 步骤 6；AC-12；A2 导出面）", { skip: skipReason }, () => {
  const addon = createRequire(import.meta.url)(addonPath);
  // NAPI_VERSION 防漂移锚（§4.4/§5.2.1）：编译期宏值必须 =9。漂移事实证：includes 接线
  // 缺失时 Node 25 头文件基线给 8，本断言即抓出该形态。
  assert.deepEqual(addon.probe(), { ok: true, napiVersion: 9 });
  assert.equal(typeof addon.addonVersion, "string");
  assert.ok(addon.addonVersion.length > 0, "addonVersion 非空串");
  const pkg = JSON.parse(readFileSync(join(producerRoot, "package.json"), "utf8"));
  assert.equal(addon.addonVersion, pkg.version, "addonVersion = package.json version 的编译期嵌入（§4.1）");
  // A2 导出面封闭（§10.1 + processExecutablePath 回写）：恰好 20 键——能力面溢出禁止
  // （不导出 clipboardReadText 等无工具面支撑的原语，§10.1 注记 4；细粒度 typeof 断言
  // 在 cua-producer-a2-native.test.mjs）。
  assert.deepEqual(Object.keys(addon).sort(), [
    "addonVersion", "asyncKeyState", "cancelOperations", "captureDisplay", "captureWindow",
    "clipboardWriteText", "cursorPosition", "drag", "environmentProbe", "foregroundPid",
    "heldInputSnapshot", "mouseDown", "mouseUp", "moveTo", "pressKeys", "probe",
    "processExecutablePath", "releaseAllHeldInputs", "scrollAt", "sendText",
  ]);
});

test("集成|AC-3：构建齐套后 ACODE_CUA_DEV_ROOT 指向 producer 的 dev 解析成功（§5.5，宿主真解析器）", { skip: skipReason }, async () => {
  // 动态深导入宿主解析器（守卫判定后；深导入先例：acp-host-adapter.test.mjs:38）。
  // C02 的另一半（仅 build:js、缺 addon → missing-native-addon）需要工件缺失态，与守卫
  // 冲突，属本机手工命令验收（AC-3「本机手工命令」，§5.5）；12 类失败码已由
  // packages/services/tests/windowsCuaDevRuntimeResolution.test.mjs 夹具覆盖（§6.4）。
  const runtimeModule = await import(
    pathToFileURL(
      join(repoRoot, "packages", "services", "src", "cua-permission-broker", "windowsCuaDevRuntime.ts"),
    ).href
  );
  const runtime = await runtimeModule.resolveWindowsCuaRuntime({
    platform: "win32",
    env: { ACODE_CUA_DEV_ROOT: producerRoot },
  });
  assert.equal(runtime.root, resolve(producerRoot));
  assert.equal(runtime.entryPath, entryPath, "entry 解析 = 契约路径 dist/windows-helper.js");
  assert.equal(runtime.addonPath, addonPath, "addon 解析 = 契约路径 build/Release/ax_native.node");
  assert.equal(runtime.command, process.execPath);
  assert.deepEqual(runtime.commandEnv, { ELECTRON_RUN_AS_NODE: "1" });
});

test("负样本|缺 addon env → native-addon-env-missing + exit 2，STARTING 期失败不发 transport_ready（§6.2 步骤 9；AC-11）", { skip: skipReason }, async () => {
  const helper = startHelper({ socketPath: mintTestPipe(), omitAddonEnv: true });
  try {
    const error = await waitForIpcMessage(helper, (message) => message?.type === "error", 15_000, "error");
    assert.equal(error.protocol, CONTROL_PROTOCOL);
    assert.equal(error.message, "native-addon-env-missing", "封闭字面量（§2.7）");
    const exitInfo = await waitForExit(helper, 5_000);
    assert.equal(exitInfo.code, 2, "addon env 缺失 = C12 语义 exit 2（§2.7）");
    // env 校验属 STARTING（bind 前，§2.4）：不得出现 transport_ready，也绝不降级续跑。
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "transport_ready").length, 0);
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "ready").length, 0);
  } finally {
    helper.child.kill();
  }
});

test("负样本|addon 路径不存在 → transport_ready 后 native-addon-load-failed + exit 2（WARMING 期加载，§2.4/§6.2 步骤 9）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper({
    socketPath,
    addonEnv: join(producerRoot, "build", "Release", "definitely-missing-ax.node"),
  });
  try {
    const transport = await waitForIpcMessage(
      helper,
      (message) => message?.type === "transport_ready",
      15_000,
      "transport_ready",
    );
    assert.equal(transport.socketPath, socketPath);
    const error = await waitForIpcMessage(helper, (message) => message?.type === "error", 15_000, "error");
    assert.equal(error.message, "native-addon-load-failed", "路径不存在 → 稳定字面量（§2.7/§3.4）");
    const exitInfo = await waitForExit(helper, 5_000);
    assert.equal(exitInfo.code, 2);
    // 加载在 WARMING 期（transport_ready 之后、ready 之前，§2.4 alt 分支）。
    assert.ok(helper.ipcMessages.indexOf(transport) < helper.ipcMessages.indexOf(error));
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "ready").length, 0, "加载失败绝不发 ready");
    assert.ok(!helper.stderr.includes(socketPath), "stderr 纪律：不含 pipe 名（§2.7）");
  } finally {
    helper.child.kill();
  }
});

test("负样本|addon env 指向非 .node 文件 → native-addon-load-failed + exit 2（可 require ≠ 诚实 addon，§4.1 形状校验）", { skip: skipReason }, async () => {
  const helper = startHelper({
    socketPath: mintTestPipe(),
    // package.json 可被 require（JSON 解析成功）但形状校验必须拒绝——「成功加载」不等于
    // 「诚实导出面」，绝不带病进入 READY（能力真实性，§4.6）。
    addonEnv: join(producerRoot, "package.json"),
  });
  try {
    const error = await waitForIpcMessage(helper, (message) => message?.type === "error", 15_000, "error");
    assert.equal(error.message, "native-addon-load-failed");
    const exitInfo = await waitForExit(helper, 5_000);
    assert.equal(exitInfo.code, 2);
    assert.equal(helper.ipcMessages.filter((message) => message?.type === "ready").length, 0);
  } finally {
    helper.child.kill();
  }
});

test("负样本|argv 白名单：缺 --socket / 未知 flag → invalid-helper-arguments + exit 1（§2.1/§6.2 步骤 9）", { skip: skipReason }, async () => {
  const cases = [
    { label: "缺 --socket", argvOverride: ["--parent-pid", String(process.pid)] },
    { label: "未知 flag", argvOverride: ["--socket", mintTestPipe(), "--parent-pid", String(process.pid), "--evil", "x"] },
  ];
  for (const scenario of cases) {
    const helper = startHelper({ argvOverride: scenario.argvOverride });
    try {
      const error = await waitForIpcMessage(helper, (message) => message?.type === "error", 15_000, "error");
      assert.equal(error.message, "invalid-helper-arguments", scenario.label);
      const exitInfo = await waitForExit(helper, 5_000);
      assert.equal(exitInfo.code, 1, scenario.label);
    } finally {
      helper.child.kill();
    }
  }
});

test("负样本|--socket 非 \\\\.\\pipe\\ 前缀 → invalid-helper-arguments + exit 1（§2.1 前缀校验 fail-closed）", { skip: skipReason }, async () => {
  const helper = startHelper({
    argvOverride: ["--socket", join(tmpdir(), "acode-cua-a1-not-a-pipe.sock"), "--parent-pid", String(process.pid)],
  });
  try {
    const error = await waitForIpcMessage(helper, (message) => message?.type === "error", 15_000, "error");
    assert.equal(error.message, "invalid-helper-arguments", "任意文件系统路径不得交给 net.listen（§2.1）");
    const exitInfo = await waitForExit(helper, 5_000);
    assert.equal(exitInfo.code, 1);
  } finally {
    helper.child.kill();
  }
});

test("负样本|非 fork 启动（无 IPC 通道）→ stderr missing-ipc-channel + exit 1 + pipe 从未 bind（§2.7/§17.3 补测试缺口）", { skip: skipReason }, async () => {
  // §17.3：A1 负样本未覆盖「非 fork 启动」路径——spawn（stdio pipe、无 IPC 通道）复现。
  // 字面量单一来源 = control-protocol.ts 的 MISSING_IPC_CHANNEL_MESSAGE（双写已按 §17.3
  // 裁决消除；防回归的静态断言在 cua-producer-contract.test.mjs）。
  const socketPath = mintTestPipe();
  const child = spawn(
    process.execPath,
    [entryPath, "--socket", socketPath, "--parent-pid", String(process.pid)],
    {
      cwd: producerRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [ADDON_ENV]: addonPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exitCode = await new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
  assert.equal(exitCode, 1, "无 IPC → exit 1（§2.7 封闭表第 4 行）");
  assert.match(stderr, /missing-ipc-channel/, "stderr 稳定字面量（无法发 IPC，stderr 同名）");
  assert.equal(stdout, "", "stdout 纪律不变（§2.7）");
  assert.ok(!stderr.includes(socketPath), "stderr 不含 pipe 名（§2.7 纪律）");
  // STARTING 期最早失败：pipe 从未 bind（新连接 ENOENT）。
  const afterExit = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
  assert.equal(afterExit.text, null);
  assert.equal(afterExit.errorCode, "ENOENT", "失败早于 listen——pipe 从未存在");
});

test("UTF-8|多字节字符跨 chunk 劈裂的请求行无损解析 + 1 MiB cap 按 wire 原始字节判定（§17.2/A2-AC-7）", { skip: skipReason }, async () => {
  const socketPath = mintTestPipe();
  const helper = startHelper({ socketPath });
  const deadPid = await mintConfirmedDeadPid();
  try {
    await waitForReady(helper);

    // 判据设计（零插值纪律下的无损性证明）：wire 响应绝不回显参数内容，故用「长度敏感」
    // 载荷区分无损/损坏——type.text 恰为 32,768 code units（§10.2 上限内）且含劈裂点
    // 多字节字符：字节级缓冲无损 ⇒ 通过参数校验 ⇒ 走到 app_ref 解析 ⇒ 死 pid 得
    // 「target app is not running」；旧逐-chunk 解码损坏 ⇒ 每个残缺字节变 U+FFFD ⇒
    // 长度超 32,768 ⇒ 「Invalid Computer Use method parameters.」。两个字面量可区分。
    const typeRequest = (text) =>
      Buffer.from(`${JSON.stringify({ method: "type", params: { text, app_ref: { pid: deadPid } } })}\n`, "utf8");

    // 三字节序列（中 = E4 B8 AD）劈裂：text 恰 32,768 units，切点落在 中 的第 1 字节后。
    {
      const text = `${"a".repeat(32_767)}中`;
      assert.equal(text.length, 32_768, "样本前提：恰在上限");
      const payload = typeRequest(text);
      const charOffset = payload.indexOf(Buffer.from("中", "utf8"));
      assert.ok(charOffset > 0);
      const round = await rawRequestSplit(socketPath, payload, charOffset + 1);
      assert.ok(round.text, "劈裂请求仍欠一行响应");
      assert.deepEqual(
        JSON.parse(round.text),
        { ok: false, error: { message: WIRE_MESSAGES.appNotRunning, code: "invalid_request" } },
        "三字节劈裂无损：走到 app_ref 解析（损坏形态会是 invalidParams 超限制）",
      );
    }

    // 四字节序列（😀 = F0 9F 98 80，UTF-16 代理对 = 2 code units）劈裂：切点落在第 2 字节后。
    {
      const text = `${"a".repeat(32_766)}😀`;
      assert.equal(text.length, 32_768, "样本前提：恰在上限（emoji 占 2 units）");
      const payload = typeRequest(text);
      const charOffset = payload.indexOf(Buffer.from("😀", "utf8"));
      assert.ok(charOffset > 0);
      const round = await rawRequestSplit(socketPath, payload, charOffset + 2);
      assert.ok(round.text, "劈裂请求仍欠一行响应");
      assert.deepEqual(
        JSON.parse(round.text),
        { ok: false, error: { message: WIRE_MESSAGES.appNotRunning, code: "invalid_request" } },
        "四字节劈裂无损（代理对完整性，§10.9 同律）",
      );
    }

    // cap + 多字节混合：原始 wire 字节数恰 = 1 MiB（含 \n）→ 不拆、有响应（按原始字节
    // 判定；对损坏重编码字符串量长的旧实现会漂移判定）。text 超限 → invalidParams，
    // 关键是「得到响应行」本身（未超限拆连接）。
    {
      const head = '{"method":"type","params":{"text":"中中';
      const tail = `","app_ref":{"pid":${deadPid}}}}\n`;
      const fillerLength = 1024 * 1024 - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
      const payload = Buffer.from(`${head}${"a".repeat(fillerLength)}${tail}`, "utf8");
      assert.equal(payload.length, 1024 * 1024, "样本前提：原始 wire 字节恰 = 1 MiB");
      const splitAt = Buffer.byteLength('{"method":"type","params":{"text":"中', "utf8") + 1;
      const round = await rawRequestSplit(socketPath, payload, splitAt, { timeoutMs: 20_000 });
      assert.ok(round.text, "恰 1 MiB（含多字节劈裂）不得拆连接——cap 按原始字节判定");
      assert.deepEqual(
        JSON.parse(round.text),
        { ok: false, error: { message: WIRE_MESSAGES.invalidParams, code: "invalid_request" } },
        "text 超限 → 参数面拒绝（响应行存在即 cap 判定正确）",
      );
    }

    // 恰 1 MiB + 1 字节 → 超限拆连接、无响应行（边界另一侧；多字节劈裂不改变判定）。
    {
      const head = '{"method":"type","params":{"text":"中中';
      const tail = `","app_ref":{"pid":${deadPid}}}}\n`;
      const fillerLength = 1024 * 1024 + 1 - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
      const payload = Buffer.from(`${head}${"a".repeat(fillerLength)}${tail}`, "utf8");
      assert.equal(payload.length, 1024 * 1024 + 1, "样本前提：原始 wire 字节 = 1 MiB + 1");
      const splitAt = Buffer.byteLength('{"method":"type","params":{"text":"中', "utf8") + 1;
      const round = await rawRequestSplit(socketPath, payload, splitAt, { timeoutMs: 20_000 });
      assert.equal(round.text, null, "超限（按 wire 原始字节）→ 拆连接且无响应行（§2.6）");
      // 拆连接后 server 仍健康（每连接独立处理）。
      const after = await rawRequest(socketPath, `${JSON.stringify({ method: "broker_info" })}\n`);
      assert.ok(after.text, "超限拆连接后 server 必须继续服务");
    }
  } finally {
    helper.child.kill();
  }
});

test("负样本|parent-pid 消失 → watchdog ≤6s 清理自退 exit 0 + stderr 字面量（§2.8/§6.2 步骤 9；AC-9）", { skip: skipReason }, async () => {
  const deadPid = await mintConfirmedDeadPid();
  const socketPath = mintTestPipe();
  const helper = startHelper({ socketPath, parentPid: deadPid });
  try {
    // 先完整就绪（证明不是启动失败），再由 watchdog（2000ms 探活）检出父进程消失。
    await waitForReady(helper);
    const startedAt = Date.now();
    const exitInfo = await waitForExit(helper, 6_000);
    assert.equal(exitInfo.code, 0, "watchdog 路径 = STOPPING 同路径清理，exit 0（§2.8）");
    assert.ok(Date.now() - startedAt <= 6_000, "≤6s 内清理自退（AC-9）");
    assert.match(helper.stderr, /parent-process-gone/, "stderr 稳定字面量（§2.8）");
    assert.ok(!helper.stderr.includes(socketPath), "stderr 纪律：不含 pipe 名（§2.7）");
  } finally {
    helper.child.kill();
  }
});

// ── 单元断言面（§6.3，确定性覆盖状态机，不抢时序；动态导入的 dist 模块）───────

test("单元|WARMING 全门：14 方法/broker_info/未知方法一律 broker_unavailable；垃圾行仍欠 invalid_request（§2.5/§6.3）", { skip: skipReason }, async () => {
  const dispatcher = wireServer.createWireDispatcher();
  assert.equal(dispatcher.state, "warming");
  // §2.5 ACode 自定收紧：broker_info 也纳入 warming 门（ready 代表完整 health probe 成功）。
  for (const method of [...FOURTEEN_METHODS, "broker_info", "totally_unknown_method"]) {
    const response = await dispatcher.handleRequestLine(JSON.stringify({ method, params: {} }));
    assert.deepEqual(
      response,
      { ok: false, error: { message: WIRE_MESSAGES.warming, code: "broker_unavailable" } },
      `WARMING 期 ${method} 必须 broker_unavailable`,
    );
  }
  // 解析门先于状态门：垃圾行不是「请求」（§2.5 枚举对象是方法名），任何状态都欠一行
  // invalid_request（wire spec §9.1 响应义务）。
  const garbage = await dispatcher.handleRequestLine("][]not-json");
  assert.deepEqual(garbage, {
    ok: false,
    error: { message: WIRE_MESSAGES.invalidRequest, code: "invalid_request" },
  });
});

test("单元|READY 派发面：14 方法 unimplemented / broker_info 最小诚实面 / 未知方法 method_not_found（§4.6/§6.3）", { skip: skipReason }, async () => {
  const dispatcher = wireServer.createWireDispatcher();
  dispatcher.activate(backendA1.createBackendA1());
  assert.equal(dispatcher.state, "ready");
  // A1 backend 对 14 方法零注册：unimplemented 由 dispatch 层统一产出（§4.6）。
  for (const method of FOURTEEN_METHODS) {
    const response = await dispatcher.handleRequestLine(JSON.stringify({ method }));
    assert.deepEqual(response, {
      ok: false,
      error: { message: WIRE_MESSAGES.unimplemented, code: "unimplemented" },
    });
  }
  // broker_info 最小诚实面 = {pid, bundle_id}（§4.6；richer 字段延后至阶段 5 裁决）。
  const info = await dispatcher.handleRequestLine(JSON.stringify({ method: "broker_info" }));
  assert.deepEqual(info, { ok: true, result: { pid: process.pid, bundle_id: process.execPath } });
  const unknown = await dispatcher.handleRequestLine(JSON.stringify({ method: "open_application" }));
  assert.deepEqual(unknown, {
    ok: false,
    error: { message: WIRE_MESSAGES.methodNotFound, code: "method_not_found" },
  });
});

test("单元|warming→ready 单向性：READY 后不得回退（§2.4/§6.3）", { skip: skipReason }, async () => {
  const dispatcher = wireServer.createWireDispatcher();
  const first = backendA1.createBackendA1();
  dispatcher.activate(first);
  // 重复 activate（换一个空 backend）必须 no-op：状态不回退、backend 不被替换。
  dispatcher.activate({});
  assert.equal(dispatcher.state, "ready");
  const info = await dispatcher.handleRequestLine(JSON.stringify({ method: "broker_info" }));
  assert.equal(info.ok, true, "重复 activate 不得把已注入 backend 换掉（单向）");
  // 结构上不存在任何回退 API（§2.4「状态只前进不回退」）。
  assert.equal(typeof dispatcher.markWarming, "undefined");
  assert.equal(typeof dispatcher.deactivate, "undefined");
});

test("单元|parseRequestLine 判据边界（wire spec §9.1 / producer spec §4.6）", { skip: skipReason }, () => {
  const parse = wireServer.parseRequestLine;
  assert.equal(parse("not json at all"), undefined, "非法 JSON");
  assert.equal(parse("[1,2,3]"), undefined, "数组非对象");
  assert.equal(parse("null"), undefined, "null 非对象");
  assert.equal(parse('"a string"'), undefined, "标量非对象");
  assert.equal(parse('{"params":{}}'), undefined, "缺 method");
  assert.equal(parse('{"method":123}'), undefined, "method 非字符串");
  assert.equal(parse('{"method":"type","id":123}'), undefined, "id 须 string|null");
  assert.deepEqual(parse('{"method":"broker_info","id":null}'), { method: "broker_info", id: null }, "id:null 合法");
  assert.deepEqual(
    parse('{"method":"type","params":{"text":"x"}}'),
    { method: "type", params: { text: "x" } },
    "params 透传不校验（校验属 handler，A1 无 handler）",
  );
  assert.deepEqual(parse('{"method":"key"}'), { method: "key" }, "最小合法请求");
});

test("单元|serializeResponse：单行、\\n 结尾、成功/失败两形态字段精确（wire spec §1.3/§3.1 同构）", { skip: skipReason }, () => {
  const okLine = wireServer.serializeResponse(wireServer.okResponse({ a: 1 }));
  assert.equal(okLine, '{"ok":true,"result":{"a":1}}\n');
  const errorWithCode = wireServer.serializeResponse(wireServer.errorResponse("m", "unimplemented"));
  assert.equal(errorWithCode, '{"ok":false,"error":{"message":"m","code":"unimplemented"}}\n');
  // error.code 仅在有码时出现（§3.1 的展开语义，producer 内原创实现）。
  const errorNoCode = wireServer.serializeResponse(wireServer.errorResponse("m"));
  assert.equal(errorNoCode, '{"ok":false,"error":{"message":"m"}}\n');
  for (const line of [okLine, errorWithCode, errorNoCode]) {
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1, "响应必须单行（不得内嵌换行）");
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), line.startsWith('{"ok":true') ? ["ok", "result"] : ["error", "ok"]);
  }
});
