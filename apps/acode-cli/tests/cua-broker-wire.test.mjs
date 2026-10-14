/**
 * 链路乙（host RPC 客户端）wire 协议测试——角色 B 增量 1（broker.js）。
 *
 * 覆盖 specs/broker-wire-protocol.md 钉死的 host 侧纯 JS 契约：14 方法表 / 只读-变更划分、
 * mintBrokerSocketPath 的 win32 named-pipe 分支、callBrokerMethod 的单连接单请求往返与
 * fail-closed 错误语义、probeHelperHealth 的 broker_info 探测（失败必须 throw，绝不返回空值）。
 *
 * Helper 服务端三件套（dispatchRequest/handleRequestLine/parseRequestLine）仍 fail-closed，
 * 属角色 A，本文件不测（见 module-boundary.md 不变量 1 栏②）。
 *
 * 落 apps/acode-cli/tests/ 因 packages/acode-cua 无 test 脚本（managed 模块，塞进去会被当
 * 生产源码严格检查且跑不到）；深路径 import broker.js（按名 import 从此位置不可解析）。
 * 真实 socket 夹具：win32 走 named pipe、posix 走 tmpdir/*.sock，均本地可 bind。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import {
  BrokerError,
  CuaHelperError,
  callBrokerMethod,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  probeHelperHealth,
} from "../../../packages/acode-cua/broker.js";

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：链路乙 broker 服务端（模拟角色 A 的 Helper broker 端）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 起一个真实 net server 监听一个 minted socket path，按 onRequest(request) 决定响应。
 * onRequest 返回：{ respond: <对象> } 写一行响应后 end；{ hold: true } 只连不响应（测超时）；
 * { raw: <string> } 写裸字节（测非法 JSON）；{ rawChunks: <Buffer[]> } 分段写裸字节
 * （§17.2 多字节跨 chunk 劈裂样本，段间 20ms 间隔保证独立 chunk）；
 * { closeImmediately: true } 连上就关（测提前关闭）。
 * server 与每个 socket 都挂 error handler——client 命中上限/超时后 destroy 会让 server 侧
 * write 抛 EPIPE，未处理会崩测试进程（phase-0 T4 实测教训）。
 */
async function startBrokerFixture(onRequest) {
  const socketPath = mintBrokerSocketPath();
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        request = undefined;
      }
      const decision = onRequest(request);
      if (decision.hold) return; // 不响应，让 client 超时
      if (decision.closeImmediately) {
        socket.destroy();
        return;
      }
      if (Array.isArray(decision.rawChunks)) {
        // 分段写入：制造「多字节 UTF-8 字符跨 chunk 劈裂」的传输形态（§17.2）。
        let index = 0;
        const writeNext = () => {
          if (index >= decision.rawChunks.length) {
            socket.end();
            return;
          }
          const part = decision.rawChunks[index];
          index += 1;
          socket.write(part, () => setTimeout(writeNext, 20));
        };
        writeNext();
        return;
      }
      if (typeof decision.raw === "string") {
        socket.write(decision.raw);
        socket.end();
        return;
      }
      socket.write(`${JSON.stringify(decision.respond)}\n`);
      socket.end();
    });
  });
  server.on("error", () => {});
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(socketPath);
  });
  return {
    socketPath,
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：方法表谓词（纯，无 socket）——wire spec §8.1/§8.2
// ─────────────────────────────────────────────────────────────────────────────

test("isBrokerMethod：14 个工具名全部为真", () => {
  const names = [
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
  for (const n of names) assert.equal(isBrokerMethod(n), true, `${n} 应是 broker 方法`);
  assert.equal(names.length, 14, "方法表恰 14 个（上游 COMPUTER_METHOD_NAMES）");
});

test("isBrokerMethod：非方法名 / 非字符串一律 false", () => {
  assert.equal(isBrokerMethod("open_application"), false, "open_application 已于上游 2026-09-16 删除");
  assert.equal(isBrokerMethod("broker_info"), false, "broker_info 是带外 health 方法，不在 14 工具表内");
  assert.equal(isBrokerMethod(""), false);
  assert.equal(isBrokerMethod(undefined), false);
  assert.equal(isBrokerMethod(null), false);
  assert.equal(isBrokerMethod(123), false);
  assert.equal(isBrokerMethod({}), false);
});

test("isReadOnlyBrokerMethod：只读 = 14 − 10 变更 = 4 个", () => {
  // 只读 4 个：list_apps / list_windows / get_app_state / request_access
  for (const ro of ["list_apps", "list_windows", "get_app_state", "request_access"]) {
    assert.equal(isReadOnlyBrokerMethod(ro), true, `${ro} 应只读`);
  }
  // 变更 10 个：possibly_sent 判定据此「绝不重放」（wire spec §5.2）
  const mutating = [
    "left_click",
    "scroll",
    "left_click_drag",
    "type",
    "set_value",
    "select_text",
    "key",
    "perform_action",
    "paste",
    "stop_computer_control",
  ];
  for (const m of mutating) assert.equal(isReadOnlyBrokerMethod(m), false, `${m} 是变更类，非只读`);
  assert.equal(mutating.length, 10, "变更类恰 10 个（上游 MUTATING_METHODS）");
});

test("isReadOnlyBrokerMethod：非 broker 方法一律 false（不是 broker 方法就谈不上只读）", () => {
  assert.equal(isReadOnlyBrokerMethod("nope"), false);
  assert.equal(isReadOnlyBrokerMethod(undefined), false);
  assert.equal(isReadOnlyBrokerMethod(42), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：mintBrokerSocketPath 平台分支（纯）——wire spec §1.1
// ─────────────────────────────────────────────────────────────────────────────

test("mintBrokerSocketPath：win32 产 named pipe 前缀、无 .sock、忽略 dir", (t) => {
  if (process.platform !== "win32") {
    t.skip(`当前宿主 ${process.platform}，win32 分支不触发；posix 分支由下一条覆盖`);
    return;
  }
  const p = mintBrokerSocketPath();
  // 用 char code 判定前缀，规避 shell/模板对反斜杠的转义歧义（phase-0 实测教训）。
  // \\.\pipe\ = 92,92,46,92,112,105,112,101,92
  const prefixCodes = Array.from(p.slice(0, 9), (c) => c.charCodeAt(0));
  assert.deepEqual(prefixCodes, [92, 92, 46, 92, 112, 105, 112, 101, 92], "前缀须是 \\\\.\\pipe\\");
  assert.ok(p.includes("acode-cua-broker-"), "含链路乙前缀 acode-cua-broker-（与链路甲 acode-node-repl-cua- 不撞）");
  assert.ok(!p.includes(".sock"), "win32 named pipe 不带 .sock 后缀");
  assert.ok(!mintBrokerSocketPath({ dir: "C:/ignored" }).includes("ignored"), "win32 分支忽略 options.dir");
});

test("mintBrokerSocketPath：每次调用产不同随机段（uuid）", () => {
  const a = mintBrokerSocketPath();
  const b = mintBrokerSocketPath();
  assert.notEqual(a, b, "两次 mint 必须不同（单例复用是调用方 WindowsCuaHelperHost 的职责，不在本函数）");
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 3：callBrokerMethod 入参校验（无需真实 server）——wire spec §1.2
// ─────────────────────────────────────────────────────────────────────────────

test("callBrokerMethod：缺 socketPath / method → BrokerError code invalid_request", async () => {
  await assert.rejects(
    callBrokerMethod({ method: "list_apps" }),
    (e) => e instanceof BrokerError && e.code === "invalid_request",
  );
  await assert.rejects(
    callBrokerMethod({ socketPath: mintBrokerSocketPath() }),
    (e) => e instanceof BrokerError && e.code === "invalid_request",
  );
  await assert.rejects(
    callBrokerMethod({ socketPath: "", method: "list_apps" }),
    (e) => e instanceof BrokerError && e.code === "invalid_request",
  );
});

test("callBrokerMethod：连接被拒（无 server 监听）→ BrokerError code broker_unavailable，不静默返回", async () => {
  const dead = mintBrokerSocketPath(); // 从未 listen
  await assert.rejects(
    callBrokerMethod({ socketPath: dead, method: "list_apps", timeoutMs: 2000 }),
    (e) => e instanceof BrokerError && e.code === "broker_unavailable",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 4：callBrokerMethod wire 往返（真实 socket 夹具）——wire spec §1/§3/§4
// ─────────────────────────────────────────────────────────────────────────────

test("callBrokerMethod：ok:true 响应 → 返回 result（解包，非整个响应）", async () => {
  const result = { content: [{ type: "text", text: "hi" }] };
  const fx = await startBrokerFixture((req) => {
    assert.equal(req.method, "get_app_state", "server 收到的 method 应是请求的 method");
    assert.equal(typeof req.id, "string", "请求带 randomUUID id（信息性）");
    return { respond: { ok: true, result } };
  });
  try {
    const got = await callBrokerMethod({ socketPath: fx.socketPath, method: "get_app_state", params: { x: 1 } });
    assert.deepEqual(got, result, "返回 response.result 本身");
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：params 透传到 server（含 undefined 时不带 params 键）", async () => {
  let seenWithParams;
  let seenWithout;
  const fx = await startBrokerFixture((req) => {
    if ("params" in req) seenWithParams = req.params;
    else seenWithout = true;
    return { respond: { ok: true, result: null } };
  });
  try {
    await callBrokerMethod({ socketPath: fx.socketPath, method: "type", params: { text: "abc" } });
    assert.deepEqual(seenWithParams, { text: "abc" });
    await callBrokerMethod({ socketPath: fx.socketPath, method: "list_apps" });
    assert.equal(seenWithout, true, "未传 params 时请求不含 params 键");
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：ok:false → 抛 BrokerError 并透传 error.code（§4.2/§4.3 绝不返回 result）", async () => {
  const fx = await startBrokerFixture(() => ({
    respond: { ok: false, error: { message: "permission denied by user", code: "permission_denied" } },
  }));
  try {
    await assert.rejects(
      callBrokerMethod({ socketPath: fx.socketPath, method: "left_click" }),
      (e) => {
        assert.ok(e instanceof BrokerError, "错误类型是 BrokerError");
        assert.equal(e.code, "permission_denied", "透传 broker code（不做 SDK 映射——映射在 SDK 侧）");
        assert.equal(e.message, "permission denied by user");
        return true;
      },
    );
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：ok:false 但 error 无 code → 归 internal（不静默成功）", async () => {
  const fx = await startBrokerFixture(() => ({ respond: { ok: false, error: { message: "boom" } } }));
  try {
    await assert.rejects(
      callBrokerMethod({ socketPath: fx.socketPath, method: "get_app_state" }),
      (e) => e instanceof BrokerError && e.code === "internal",
    );
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：非法 JSON 响应行 → BrokerError code internal，不抛底层 parse 文本", async () => {
  const fx = await startBrokerFixture(() => ({ raw: "not-json-at-all\n" }));
  try {
    await assert.rejects(
      callBrokerMethod({ socketPath: fx.socketPath, method: "list_apps" }),
      (e) => {
        assert.ok(e instanceof BrokerError);
        assert.equal(e.code, "internal");
        assert.doesNotMatch(e.message, /SyntaxError|JSON/u, "不泄露底层 parse 错误文本");
        return true;
      },
    );
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：响应前连接关闭 → BrokerError code broker_unavailable（fail-closed，不返回半个响应）", async () => {
  const fx = await startBrokerFixture(() => ({ closeImmediately: true }));
  try {
    await assert.rejects(
      callBrokerMethod({ socketPath: fx.socketPath, method: "list_apps" }),
      (e) => e instanceof BrokerError && e.code === "broker_unavailable",
    );
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：超时（server hold 不响应）→ BrokerError code timeout", async () => {
  const fx = await startBrokerFixture(() => ({ hold: true }));
  try {
    await assert.rejects(
      callBrokerMethod({ socketPath: fx.socketPath, method: "get_app_state", timeoutMs: 150 }),
      (e) => e instanceof BrokerError && e.code === "timeout",
    );
  } finally {
    await fx.close();
  }
});

test("callBrokerMethod：多字节 UTF-8 字符跨 chunk 劈裂（三字节 CJK + 四字节 emoji）→ 字节级缓冲无损解析（producer spec §17.2 / A2-AC-7）", async () => {
  // 缺陷背景（§17.2）：旧实现 `buffer += chunk.toString("utf8")` 逐 chunk 解码累积——
  // 多字节字符跨 chunk 劈裂时产生不可逆 U+FFFD 替换符（响应行含树文本/中文自 A3 起
  // 是常态）。修复 = Buffer 累积 + 字节域切行 + 完整行一次性解码。
  const text = "中文树文本🀄😀 mixed ascii end";
  const payload = { ok: true, result: { content: [{ type: "text", text }] } };
  const line = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  // 三字节序列（中 = E4 B8 AD）与四字节序列（😀 = F0 9F 98 80）各取内部劈裂点，
  // 四字节覆盖多个内部偏移（§17.2 测试要求：三字节/四字节各至少一个劈裂样本）。
  const cjkOffset = line.indexOf(Buffer.from("中", "utf8"));
  const emojiOffset = line.indexOf(Buffer.from("😀", "utf8"));
  assert.ok(cjkOffset > 0 && emojiOffset > cjkOffset, "样本前提：两种序列都在响应行内");
  const splitPoints = [cjkOffset + 1, emojiOffset + 1, emojiOffset + 2, emojiOffset + 3];
  for (const splitAt of splitPoints) {
    const fx = await startBrokerFixture(() => ({
      rawChunks: [line.subarray(0, splitAt), line.subarray(splitAt)],
    }));
    try {
      const got = await callBrokerMethod({ socketPath: fx.socketPath, method: "get_app_state", timeoutMs: 5000 });
      assert.deepEqual(got, payload.result, `split@${splitAt}: 解析结果与原文逐字段相等`);
      assert.equal(got.content[0].text, text, `split@${splitAt}: 字符串内容逐字节相等（无损）`);
      assert.ok(!got.content[0].text.includes("\uFFFD"), `split@${splitAt}: 绝无 U+FFFD 替换符`);
    } finally {
      await fx.close();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 5：probeHelperHealth（真实 socket 夹具）——wire spec §6
// ─────────────────────────────────────────────────────────────────────────────

test("probeHelperHealth：broker_info 返回 {bundle_id,pid} → 投影为 {bundleId,pid}", async () => {
  const fx = await startBrokerFixture((req) => {
    assert.equal(req.method, "broker_info", "探测发带外 broker_info 方法");
    return { respond: { ok: true, result: { bundle_id: "dev.acode.cua-helper", pid: 4242, version: "1.0" } } };
  });
  try {
    const health = await probeHelperHealth(fx.socketPath, { timeoutMs: 2000, perTryTimeoutMs: 500 });
    assert.deepEqual(health, { bundleId: "dev.acode.cua-helper", pid: 4242 });
  } finally {
    await fx.close();
  }
});

test("probeHelperHealth：Windows 无 bundle_id（只 pid）→ bundleId=null 但成功（不是 health 失败，§6.2）", async () => {
  const fx = await startBrokerFixture(() => ({ respond: { ok: true, result: { pid: 777 } } }));
  try {
    const health = await probeHelperHealth(fx.socketPath, { timeoutMs: 2000, perTryTimeoutMs: 500 });
    assert.deepEqual(health, { bundleId: null, pid: 777 });
  } finally {
    await fx.close();
  }
});

test("probeHelperHealth：探测轮询——首次无 pid、二次就绪 → 返回就绪结果（poll 语义）", async () => {
  let attempt = 0;
  const fx = await startBrokerFixture(() => {
    attempt += 1;
    if (attempt < 2) return { respond: { ok: true, result: { pid: null } } }; // 未就绪：无正 pid
    return { respond: { ok: true, result: { pid: 5150 } } };
  });
  try {
    const health = await probeHelperHealth(fx.socketPath, {
      timeoutMs: 3000,
      perTryTimeoutMs: 500,
      pollIntervalMs: 20,
    });
    assert.deepEqual(health, { bundleId: null, pid: 5150 });
    assert.ok(attempt >= 2, `应至少轮询 2 次，实际 ${attempt}`);
  } finally {
    await fx.close();
  }
});

test("probeHelperHealth：连接被拒 → throw（§6.4 绝不返回 {bundleId:null,pid:null} 空值）", async () => {
  const dead = mintBrokerSocketPath();
  await assert.rejects(
    probeHelperHealth(dead, { timeoutMs: 400, perTryTimeoutMs: 150, pollIntervalMs: 50 }),
    (e) => {
      assert.ok(e instanceof Error, "抛错而非返回空值");
      assert.ok(
        !(e && typeof e === "object" && "bundleId" in e && "pid" in e),
        "失败绝不返回 {bundleId,pid} 形态的假成功",
      );
      return true;
    },
  );
});

test("probeHelperHealth：始终无正 pid 直到预算耗尽 → throw timeout/helper_unavailable，不返回空值", async () => {
  const fx = await startBrokerFixture(() => ({ respond: { ok: true, result: { pid: null } } }));
  try {
    await assert.rejects(
      probeHelperHealth(fx.socketPath, { timeoutMs: 300, perTryTimeoutMs: 100, pollIntervalMs: 30 }),
      (e) => e instanceof CuaHelperError || e instanceof BrokerError,
    );
  } finally {
    await fx.close();
  }
});

test("probeHelperHealth：broker_info ok:false → throw（透传 helper 侧错误码）", async () => {
  const fx = await startBrokerFixture(() => ({
    respond: { ok: false, error: { message: "helper still loading native", code: "helper_unavailable" } },
  }));
  try {
    await assert.rejects(
      probeHelperHealth(fx.socketPath, { timeoutMs: 300, perTryTimeoutMs: 100, pollIntervalMs: 30 }),
      (e) => e instanceof CuaHelperError && e.code === "helper_unavailable",
    );
  } finally {
    await fx.close();
  }
});

test("probeHelperHealth：缺 socketPath → CuaHelperError helper_unavailable", async () => {
  await assert.rejects(
    probeHelperHealth(""),
    (e) => e instanceof CuaHelperError && e.code === "helper_unavailable",
  );
});
