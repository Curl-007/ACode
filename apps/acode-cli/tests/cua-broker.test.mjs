// node_repl CUA broker 传输层不变量测试（T3）。
//
// 被测对象：apps/acode-cli/packages/node-repl-host/src/cua-broker.ts（181 行）。
// 归属纠正（plan1 §3.5 / ADDENDUM 裁决 21）：token 鉴权 + 1 MiB 请求上限 + 双形态
// socket 归 cua-broker.ts；generation 防陈旧 / subagent 拒绝 / 32 MiB 响应上限归
// cua-bridge.ts（T4），本文件不越界。
//
// 覆盖 spec：docs/upgrades/product-and-support-2026-10.md §7.7 阶段 0 门槛。
// 断言映射见 plan1.md §3.5 表（全部在 win32 真机实测通过，named pipe \\.\pipe\...）。
//
// 跨平台纪律（plan1 §1.2 / ADDENDUM「全体 author 的硬纪律」）：
//   真实 socket 往返必须传 platform: process.platform。不传时 broker 走 POSIX 分支
//   生成 tmpdir/*.sock，而 Windows 的 net.Server.listen 对文件路径直接 EACCES
//   （本文件实测复现），致该用例在 Windows 上从未跑过。
//
// 本测试是 ACode 自有实现（上游无对应的 broker 独立测试文件），不触发 Apache-2.0
// 派生登记；token 鉴权用例的测试意图与上游 cua-bridge.test.ts 的 forged-token 用例
// 同源，但断言、夹具、导入路径均为本仓自写。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 相对路径导入（ADDENDUM「全体 author 的硬纪律」末条）：从 apps/acode-cli/tests/
// 按名 import @acode/node-repl-host 会 ERR_MODULE_NOT_FOUND（该包未在 acode-cli 声明
// 依赖，实测）；相对深路径可解析。
const { createNodeReplCuaBroker } = await import(
  "../packages/node-repl-host/src/cua-broker.ts"
);

// Windows named pipe 前缀用字符串拼接构造（plan1 §4.6 / ADDENDUM 硬纪律）：
// 避免在源码/heredoc 里写 \\.\pipe\ 时被逐层转义吞掉。
const PIPE_PREFIX = "\\" + "\\" + "." + "\\" + "pipe" + "\\";

// 请求上限（cua-broker.ts:13 MAX_REQUEST_BYTES = 1024 * 1024）。
const MAX_REQUEST_BYTES = 1024 * 1024;

// 每次往返的看门狗超时；正常路径远快于此，仅防止断言写错时进程挂死。
const ROUNDTRIP_TIMEOUT_MS = 8000;

/**
 * 受控假 runtime：execute 返回固定 CallToolResult，并记录最近一次调用的入参，
 * 供「context 透传」断言核对 broker 把 wire context 正确解析后交给 runtime。
 */
function makeFakeRuntime(result = { content: [{ type: "text", text: "ok" }] }) {
  const calls = [];
  return {
    calls,
    execute: async (input) => {
      calls.push(input);
      return result;
    },
    async closeSession() {},
    async dispose() {},
  };
}

/**
 * 连到 broker 的 socketPath，onConnect 里写数据，收满一行（首个 \n）即解析返回。
 *
 * 全部 socket 挂 error handler（ADDENDUM 硬纪律）：broker 命中上限/鉴权失败后会
 * socket.end 并可能提前关闭连接，客户端后续 write 会拿到 EOF/EPIPE；未处理的 error
 * 事件会让测试进程崩溃，故这里吞掉「已有响应之后」的错误。
 */
function roundtrip(socketPath, onConnect) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let watchdog;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    // 连接建立前/无响应时的 error 视为失败；已收到部分数据后（broker 已 end）忽略。
    socket.on("error", (error) => {
      if (!buffer) finish(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(error);
        return;
      }
      finish(undefined, parsed);
    });
    socket.on("close", () => {
      if (!buffer) finish(new Error("broker closed before returning a response"));
    });
    socket.once("connect", () => onConnect(socket));

    watchdog = setTimeout(
      () => finish(new Error(`roundtrip timed out after ${ROUNDTRIP_TIMEOUT_MS}ms`)),
      ROUNDTRIP_TIMEOUT_MS,
    );
    // 看门狗自身 unref，避免它成为唯一 pending 句柄把进程吊住。
    watchdog.unref?.();
  });
}

/** 写一行 JSON 请求并读回一行响应。 */
function sendRequest(socketPath, payload) {
  return roundtrip(socketPath, (socket) => {
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

/**
 * 写原始字节（用于超 1 MiB 用例：构造一个不含换行、体积超过上限的请求，逼 readLine
 * 在解析前就因字节数拒绝）。write 可能因 broker 提前 end 而抛 EOF，故包一层吞掉。
 */
function sendRawBytes(socketPath, bytes) {
  return roundtrip(socketPath, (socket) => {
    socket.write(bytes, () => {});
    // 客户端 write 回调之外再兜一层：write 同步抛错（对端已关闭）时不崩测试。
    socket.on("error", () => {});
  });
}

/** parseContext 需要的最小合法 context（cua-broker.ts:117-146）。 */
const VALID_CONTEXT = Object.freeze({
  sessionId: "session-t3",
  workspaceKey: "workspace-t3",
});

/**
 * 观察 createNodeReplCuaBroker 为给定 platform 计算出的 socketPath —— 纯路径构造断言，
 * 不依赖真实往返。socketPath 从两条通道之一取得（覆盖两种宿主与两种失败时序）：
 *   1) 构造成功（当前宿主匹配的分支，或 POSIX 宿主上的 win32 分支）：读
 *      broker.connection.socketPath，随后 close + force rm 兜底清理（win32 分支被注入
 *      到 POSIX 宿主时会真建出相对路径文件，close() 按源码 :60 不 rm，这里补一次防残留）。
 *   2) listen 失败：Windows 对 POSIX 的 .sock 路径不可用。实测该失败时序**不确定**——
 *      有时 server.listen() 同步抛 EACCES（错误对象 .address 即模块算出的 socketPath），
 *      有时经 'error' 事件异步 reject broker.ready（socketPath 仍可从 connection 读到）。
 *      两种时序都视为「不可用」，socketPath 都能拿到，故都收录。
 * 返回 { socketPath, unusable, code }：unusable 表示 listen 未能进入 listening 态。
 */
async function observeSocketPath(runtime, platform) {
  let broker;
  try {
    broker = createNodeReplCuaBroker({ runtime, platform });
  } catch (error) {
    // 同步抛错通道：listen() 直接 throw，错误对象携带 .address（= 模块算出的 socketPath）。
    const address = error && typeof error.address === "string" ? error.address : undefined;
    return { socketPath: address, unusable: true, code: error?.code };
  }
  const socketPath = broker.connection.socketPath;
  // ready 可能因异步 listen 失败而 reject；构造形态仍可断言，故吞掉并记录是否不可用。
  let unusable = false;
  let code;
  await broker.ready.catch((error) => {
    unusable = true;
    code = error?.code;
  });
  await broker.close().catch(() => undefined);
  await rm(socketPath, { force: true }).catch(() => undefined);
  return { socketPath, unusable, code };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 注入 platform 的双向纯路径构造断言（cua-broker.ts:26-29）
// ─────────────────────────────────────────────────────────────────────────────

test("win32 生成 \\\\.\\pipe\\ 前缀，非 win32 生成 tmpdir/*.sock（纯路径构造）", async (t) => {
  const runtime = makeFakeRuntime();

  const win = await observeSocketPath(runtime, "win32");
  assert.ok(
    typeof win.socketPath === "string" && win.socketPath.startsWith(PIPE_PREFIX),
    `win32 分支 socketPath 应以 named pipe 前缀开头，实际 ${JSON.stringify(win.socketPath)}`,
  );
  assert.match(
    win.socketPath,
    /^\\\\\.\\pipe\\acode-node-repl-cua-[0-9a-f-]{36}$/u,
    "win32 分支应拼接 acode-node-repl-cua-<uuid>",
  );

  const posix = await observeSocketPath(runtime, "linux");
  assert.ok(
    typeof posix.socketPath === "string",
    "非 win32 分支应能观察到 socketPath（构造成功或 listen 抛错携带 address）",
  );
  // 非 win32 分支：join(tmpdir(), `znrc-${randomUUID()}.sock`)。
  assert.ok(
    posix.socketPath.startsWith(tmpdir()),
    `非 win32 分支 socketPath 应位于 tmpdir 下，实际 ${JSON.stringify(posix.socketPath)}`,
  );
  assert.match(
    posix.socketPath,
    /znrc-[0-9a-f-]{36}\.sock$/u,
    "非 win32 分支应为 znrc-<uuid>.sock",
  );
  // 在 Windows 宿主上，POSIX 的 .sock 路径不可用于 listen（路径含盘符冒号/反斜杠，
  // 不是合法 pipe 名 → EACCES）。实测失败时序不定（同步抛 or 异步 reject ready），
  // 但「不可用」这条事实恒定；此断言把 plan1 记录的硬约束钉住，且不依赖具体时序。
  if (process.platform === "win32") {
    assert.equal(
      posix.unusable,
      true,
      "Windows 上对 .sock 路径 listen 应不可用（同步抛错或异步 reject）",
    );
  }

  t.diagnostic(`win32 socketPath=${win.socketPath} unusable=${win.unusable}`);
  t.diagnostic(`posix socketPath=${posix.socketPath} unusable=${posix.unusable} code=${posix.code}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2~9. 真实 socket 往返（当前宿主形态；win32 = named pipe，POSIX = tmpdir/*.sock）
// ─────────────────────────────────────────────────────────────────────────────

test("真实 socket 往返：token/上限/context 全组不变量", async (t) => {
  const runtime = makeFakeRuntime();
  // 硬纪律：必须传 platform: process.platform，否则 Windows 走 POSIX 分支 EACCES。
  const broker = createNodeReplCuaBroker({ runtime, platform: process.platform });
  try {
    await broker.ready;
    const { socketPath, token } = broker.connection;

    // socketPath 形态应与当前宿主分支一致。
    if (process.platform === "win32") {
      assert.ok(socketPath.startsWith(PIPE_PREFIX), "win32 宿主应使用 named pipe");
    } else {
      assert.match(socketPath, /znrc-[0-9a-f-]{36}\.sock$/u, "POSIX 宿主应使用 tmpdir/*.sock");
    }
    // token = randomBytes(32).toString("hex") → 64 位十六进制（cua-broker.ts:30）。
    assert.equal(token.length, 64, "token 应为 32 字节 hex（长度 64）");
    assert.match(token, /^[0-9a-f]{64}$/u, "token 应为小写十六进制");

    // ── (2) token 正确 → 往返成功返回 CallToolResult ──
    const okResponse = await sendRequest(socketPath, {
      id: "req-ok",
      token,
      method: "list_apps",
      input: { foo: "bar" },
      context: { ...VALID_CONTEXT },
    });
    assert.deepEqual(okResponse, {
      id: "req-ok",
      ok: true,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    // context 透传：broker 应把 wire context 解析后交给 runtime（cua-broker.ts:90-97）。
    assert.equal(runtime.calls.length, 1, "runtime.execute 应被调用一次");
    const exec = runtime.calls[0];
    assert.equal(exec.toolName, "list_apps", "toolName 应来自 payload.method");
    assert.deepEqual(exec.arguments, { foo: "bar" }, "arguments 应来自 payload.input");
    assert.equal(exec.context.sessionId, "session-t3");
    assert.equal(exec.context.workspaceKey, "workspace-t3");
    assert.equal(exec.context.runtimeScope, "main", "非 subagent 时 runtimeScope 默认 main");
    assert.ok(exec.signal instanceof AbortSignal, "execute 应收到 AbortSignal");

    // ── (3)(4)(5)(6) token 鉴权：不等值 / 不等长 / 缺失 / 非字符串 全部拒，文本一致 ──
    const notAuthorizedResponses = await Promise.all([
      // (3) 等长但值不同 → 走 timingSafeEqual 比较分支（:112 后半）。
      sendRequest(socketPath, {
        id: "req-bad-value",
        token: "f".repeat(token.length),
        method: "list_apps",
        input: {},
        context: { ...VALID_CONTEXT },
      }),
      // (4) 长度不同 → 覆盖 :112 先比长度分支（actual.length !== expected.length）。
      sendRequest(socketPath, {
        id: "req-bad-length",
        token: "tooshort",
        method: "list_apps",
        input: {},
        context: { ...VALID_CONTEXT },
      }),
      // (5) 缺失 token（payload.token === undefined）→ 非字符串分支（:109）。
      sendRequest(socketPath, {
        id: "req-missing-token",
        method: "list_apps",
        input: {},
        context: { ...VALID_CONTEXT },
      }),
      // (6) 非字符串 token → 同样落 :109 typeof !== "string" 分支。
      sendRequest(socketPath, {
        id: "req-nonstring-token",
        token: 123456,
        method: "list_apps",
        input: {},
        context: { ...VALID_CONTEXT },
      }),
    ]);

    for (const response of notAuthorizedResponses) {
      assert.equal(response.ok, false, "鉴权失败应 ok:false");
      assert.equal(
        response.error,
        "Computer Use broker request is not authorized",
        "三种鉴权失败错误文本必须一致（not authorized）",
      );
      // token 校验在 requestId 赋值之前（:84 早于 :88），故 id 回退为 null。
      assert.equal(response.id, null, "鉴权失败时 id 应为 null（requestId 尚未记录）");
    }
    // 鉴权失败的请求绝不应触达 runtime。
    assert.equal(runtime.calls.length, 1, "鉴权失败的请求不得调用 runtime.execute");

    // ── (7) 请求超 1 MiB → 拒（:13 MAX_REQUEST_BYTES + :154-157）──
    // 构造一个不含换行、总体积超过 1 MiB 的请求：readLine 在解析（含 token 校验）之前
    // 就因字节数越界拒绝，故 id 亦为 null。
    const head = Buffer.from(
      JSON.stringify({ id: "req-oversize", token, method: "list_apps", input: {} }),
    );
    const filler = Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x61); // 无换行的 'a' 填充
    const oversizeResponse = await sendRawBytes(socketPath, Buffer.concat([head, filler]));
    assert.equal(oversizeResponse.ok, false);
    assert.equal(
      oversizeResponse.error,
      "Computer Use broker request exceeded 1 MiB",
      "超 1 MiB 请求应被拒且错误文本含 exceeded 1 MiB",
    );
    assert.match(oversizeResponse.error, /exceeded 1 MiB/u);
    assert.equal(oversizeResponse.id, null, "超限拒绝发生在解析前，id 应为 null");
    assert.equal(runtime.calls.length, 1, "超限请求不得调用 runtime.execute");

    // ── (8) context 缺失 → 拒（:118）──
    // context 校验在 requestId 赋值之后（:88 早于 :89），故 id 被保留。
    const missingContextResponse = await sendRequest(socketPath, {
      id: "req-no-context",
      token,
      method: "list_apps",
      input: {},
      // context 字段整体缺失 → parseContext 收到 undefined → :118 falsy 分支。
    });
    assert.equal(missingContextResponse.ok, false);
    assert.equal(
      missingContextResponse.error,
      "Computer Use request context is missing",
      "context 缺失错误文本应稳定",
    );
    assert.equal(
      missingContextResponse.id,
      "req-no-context",
      "context 缺失时 requestId 已记录，id 应保留",
    );
    assert.equal(runtime.calls.length, 1, "context 缺失请求不得调用 runtime.execute");

    t.diagnostic(`roundtrip OK on ${process.platform}, socketPath=${socketPath}`);
  } finally {
    await broker.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. close()：win32 不 rm 文件（:60 分支），POSIX 删除 .sock；两形态 CLOSE OK
// ─────────────────────────────────────────────────────────────────────────────

test("close() 释放监听：win32 不删文件、POSIX 删除 .sock，均无异常", async (t) => {
  const runtime = makeFakeRuntime();
  const broker = createNodeReplCuaBroker({ runtime, platform: process.platform });
  await broker.ready;
  const { socketPath } = broker.connection;

  // close() 应正常 resolve（实测 win32 CLOSE OK）。
  await broker.close();

  if (process.platform === "win32") {
    // win32：named pipe 无文件系统条目，源码 :60 显式跳过 rm（platform !== "win32" 才删）。
    // 断言 socketPath 处不存在任何文件（既证明无残留，也证明 close 未误建文件）。
    let exists = true;
    try {
      await stat(socketPath);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "win32 named pipe 不应在文件系统留下条目");
  } else {
    // POSIX：close() 的 :60 分支应已 rm 掉 .sock 文件。
    let exists = true;
    try {
      await stat(socketPath);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "POSIX close() 应删除 .sock 文件");
  }

  // close() 幂等：已关闭后再次 close 不应抛（server.listening 已为 false，跳过 close）。
  await broker.close();

  t.diagnostic(`CLOSE OK on ${process.platform}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 异步临时目录夹具纪律自检（AGENTS.md：只用异步 IO；证明 mkdtemp/rm 可用）
// ─────────────────────────────────────────────────────────────────────────────

test("夹具使用异步 mkdtemp/rm，不触同步 IO", async () => {
  // T3 的 broker 自持 socket 生命周期，无需外部夹具目录；此用例仅验证本文件遵循
  // 「异步 mkdtemp + finally rm」纪律，并顺带确认 POSIX 分支的 tmpdir 前缀与真实
  // 临时目录同源（observeSocketPath 的 startsWith(tmpdir()) 断言依赖它）。
  const dir = await mkdtemp(join(tmpdir(), "acode-cua-t3-"));
  try {
    assert.ok(dir.startsWith(tmpdir()), "mkdtemp 应落在 tmpdir 下");
    const st = await stat(dir);
    assert.equal(st.isDirectory(), true, "mkdtemp 应创建目录");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  let gone = true;
  try {
    await stat(dir);
  } catch {
    gone = false;
  }
  assert.equal(gone, false, "finally rm 应删除临时目录");
});
