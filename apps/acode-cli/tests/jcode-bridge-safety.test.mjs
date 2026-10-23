// jcode-bridge 安全与协议不变量验收（specs/jcode-agent-bridge.md 场景 5/6/7/8/9/10 + R3/R4/R5）。
//
// 覆盖三类硬约束：
//   R4-2 遥测硬关（buildJcodeSpawnSpec 的 env 合并顺序：调用方无法把遥测打开）
//   R4-3 self-dev 防护（cwd 命中 jcode 源码检出即拒 spawn）
//   R4-4 fail-open 自校验（session/load 返回 {} 不判成功）
//   R5   executeCommand 恰好 settle 一次（子进程死亡 / 超时不悬挂）
//   R3   session-map 双向映射的 fail-closed 冲突语义
import assert from "node:assert/strict";
import test from "node:test";

const { buildJcodeSpawnSpec, assertNotJcodeRepo, JcodeSpawnRejectedError, JcodeAcpClient } =
  await import("../packages/cli/src/jcode-bridge/acp-client.ts");
const { detectJcodeRepo, describeSelfdevRejection } =
  await import("../packages/cli/src/jcode-bridge/selfdev-guard.ts");
const { JcodeSessionMap } = await import("../packages/cli/src/jcode-bridge/session-map.ts");
const { JCODE_TELEMETRY_OFF_ENV } = await import("../packages/cli/src/jcode-bridge/constants.ts");

// ---------- R4-2 遥测硬关 ----------

test("R4-2: spawn spec 强制注入遥测关闭 env，且调用方 env 无法覆盖", () => {
  // 恶意/误配：调用方试图把遥测打开。
  const spec = buildJcodeSpawnSpec(
    { cwd: "/tmp/ws", env: { JCODE_NO_TELEMETRY: "0", DO_NOT_TRACK: "0", SOME_OTHER: "x" } },
    { PATH: "/usr/bin", JCODE_NO_TELEMETRY: "0" },
  );
  // 强制关闭项后展开，覆盖调用方与 base env（对齐 agent-command-env-gate R1 的 spread 顺序哲学）。
  assert.equal(spec.env.JCODE_NO_TELEMETRY, "1", "遥测必须被强制关闭，调用方不能覆盖");
  assert.equal(spec.env.DO_NOT_TRACK, "1", "DO_NOT_TRACK 必须被强制置 1");
  // argv 必含 --no-update（关自动更新）。
  assert.ok(spec.args.includes("--no-update"), `argv 应含 --no-update，实得 ${spec.args.join(" ")}`);
  // 非安全相关的调用方 env 保留。
  assert.equal(spec.env.SOME_OTHER, "x");
});

test("R4-2: 遥测关闭 env 常量本身正确（防手误改错值）", () => {
  assert.deepEqual(JCODE_TELEMETRY_OFF_ENV, { JCODE_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" });
});

// ---------- R4-3 self-dev 防护 ----------

function fakeProbe(files) {
  // files: { "Cargo.toml": "content", ".git": null(存在标记) }
  return {
    exists: (p) => {
      const base = p.split(/[\\/]/).pop();
      return base in files;
    },
    readTextOrNull: (p) => {
      const base = p.split(/[\\/]/).pop();
      return files[base] ?? null;
    },
    join: (dir, child) => `${dir}/${child}`,
  };
}

test("R4-3: cwd 是 jcode 源码检出（Cargo.toml + .git + name=jcode）→ 判为 repo", () => {
  const probe = fakeProbe({ "Cargo.toml": '[package]\nname = "jcode"\nversion = "0.99.1"', ".git": null });
  const verdict = detectJcodeRepo("/home/u/jcode", probe);
  assert.equal(verdict.isJcodeRepo, true);
  assert.ok(verdict.matchedMarkers.length >= 3);
});

test("R4-3: 普通 Rust 项目（Cargo.toml 但 name 非 jcode）→ 不误拒", () => {
  const probe = fakeProbe({ "Cargo.toml": '[package]\nname = "my-app"', ".git": null });
  assert.equal(detectJcodeRepo("/home/u/my-app", probe).isJcodeRepo, false);
});

test("R4-3: 无 Cargo.toml 的普通工作区 → 不误拒", () => {
  const probe = fakeProbe({ "package.json": "{}" });
  assert.equal(detectJcodeRepo("/home/u/project", probe).isJcodeRepo, false);
});

test("R4-3: assertNotJcodeRepo 命中时抛 JcodeSpawnRejectedError + 稳定 reasonCode", () => {
  const probe = fakeProbe({ "Cargo.toml": 'name = "jcode"', ".git": null });
  assert.throws(
    () => assertNotJcodeRepo("/home/u/jcode", probe),
    (err) => {
      assert.ok(err instanceof JcodeSpawnRejectedError);
      assert.equal(err.reasonCode, "fault.jcode.selfdevCwdRejected");
      assert.ok(err.message.includes("self-dev"), "错误信息应说明 self-dev 风险");
      return true;
    },
  );
});

test("R4-3: describeSelfdevRejection 文案含 cwd 与命中特征", () => {
  const msg = describeSelfdevRejection("/x/jcode", ["Cargo.toml", ".git"]);
  assert.ok(msg.includes("/x/jcode"));
  assert.ok(msg.includes("Cargo.toml"));
});

// ---------- R3 session-map fail-closed ----------

test("R3: session-map 双向映射一致", () => {
  const map = new JcodeSessionMap();
  map.bind("v4-1", "jcode-1", "/ws", 100);
  assert.equal(map.toJcode("v4-1"), "jcode-1");
  assert.equal(map.toV4("jcode-1"), "v4-1");
  assert.equal(map.has("v4-1"), true);
  assert.equal(map.size, 1);
});

test("R3: 幂等重复登记（同 v4 + 同 jcode）返回既有 binding，不报错", () => {
  const map = new JcodeSessionMap();
  const first = map.bind("v4-1", "jcode-1", "/ws", 100);
  const second = map.bind("v4-1", "jcode-1", "/ws", 200);
  assert.equal(first, second, "幂等：返回同一 binding");
  assert.equal(map.size, 1);
});

test("R3: 同一 v4 会话绑不同 jcode 会话 → 抛错（fail-closed，不静默覆盖）", () => {
  const map = new JcodeSessionMap();
  map.bind("v4-1", "jcode-1", "/ws", 100);
  assert.throws(() => map.bind("v4-1", "jcode-2", "/ws", 200), /already bound/);
});

test("R3: 同一 jcode 会话被两个 v4 会话登记 → 抛错", () => {
  const map = new JcodeSessionMap();
  map.bind("v4-1", "jcode-1", "/ws", 100);
  assert.throws(() => map.bind("v4-2", "jcode-1", "/ws", 200), /already bound/);
});

test("R3: unbind 幂等（重复 close 不报错，对齐 spike §4.3 cancel 幂等）", () => {
  const map = new JcodeSessionMap();
  map.bind("v4-1", "jcode-1", "/ws", 100);
  assert.ok(map.unbind("v4-1"));
  assert.equal(map.unbind("v4-1"), undefined, "第二次 unbind 返回 undefined 而非抛错");
  assert.equal(map.has("v4-1"), false);
});

// ---------- R5 executeCommand / client 恰好 settle 一次 ----------

/** 内存 AcpTransport：可脚本化入站帧、记录出站行。 */
function memoryTransport() {
  const outbox = [];
  let pushLine;
  const lineQueue = [];
  const waiters = [];
  let ended = false;
  const transport = {
    writeLine: (line) => outbox.push(line),
    lines: () => ({
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (lineQueue.length > 0) yield lineQueue.shift();
          if (ended) return;
          await new Promise((r) => waiters.push(r));
        }
      },
    }),
    close: () => {
      ended = true;
      for (const w of waiters.splice(0)) w();
    },
  };
  pushLine = (obj) => {
    lineQueue.push(typeof obj === "string" ? obj : JSON.stringify(obj));
    for (const w of waiters.splice(0)) w();
  };
  return { transport, outbox, pushLine, end: () => transport.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("R5: 子进程死亡 → 所有在飞请求 reject（不悬挂，settle 一次）", async () => {
  const { transport, end } = memoryTransport();
  let resolveExited;
  const exited = new Promise((r) => (resolveExited = r));
  const client = new JcodeAcpClient({ transport, exited, requestTimeoutMs: 5000 });
  client.startReadLoop();

  const inflight = client.request("session/new", { cwd: "/ws" });
  let rejected = false;
  inflight.catch(() => (rejected = true));
  await sleep(10);
  assert.equal(client.pendingCount, 1, "请求应在飞");

  // 模拟子进程退出。
  resolveExited({ code: null, signal: "SIGKILL" });
  end();
  await sleep(20);
  assert.equal(rejected, true, "子进程死亡后在飞请求必须 reject");
  assert.equal(client.pendingCount, 0, "无悬挂请求");
  client.dispose();
});

test("R5: 请求超时 → reject（不悬挂）", async () => {
  const { transport } = memoryTransport();
  const client = new JcodeAcpClient({ transport, requestTimeoutMs: 30 });
  client.startReadLoop();
  const started = Date.now();
  await assert.rejects(client.request("ping", {}), /timed out/);
  assert.ok(Date.now() - started >= 25, "应在超时后才 reject");
  assert.equal(client.pendingCount, 0);
  client.dispose();
});

test("R5: dispose 后新请求立即 reject（不在死连接上悬挂）", async () => {
  const { transport } = memoryTransport();
  const client = new JcodeAcpClient({ transport });
  client.dispose();
  await assert.rejects(client.request("ping", {}), /closed/);
});

test("R2: 请求/响应按 id 关联；通知分发给 handler", async () => {
  const { transport, outbox, pushLine } = memoryTransport();
  const client = new JcodeAcpClient({ transport, requestTimeoutMs: 2000 });
  const notifications = [];
  client.onNotification((n) => notifications.push(n));
  client.startReadLoop();

  const reqPromise = client.request("initialize", { protocolVersion: 1 });
  await sleep(10);
  // 出站帧是合法 JSON-RPC 请求，id=1。
  const sent = JSON.parse(outbox[0]);
  assert.equal(sent.method, "initialize");
  assert.equal(sent.id, 1);
  // 回一个通知 + 一个响应（乱序）。
  pushLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update" } } });
  pushLine({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "jcode" } } });
  const result = await reqPromise;
  assert.equal(result.agentInfo.name, "jcode");
  assert.equal(notifications.length, 1, "通知应分发给 handler");
  assert.equal(notifications[0].method, "session/update");
  client.dispose();
});

test("R5: 畸形/非 JSON stdout 行被丢弃，不断链（后续请求仍工作）", async () => {
  const { transport, pushLine } = memoryTransport();
  const client = new JcodeAcpClient({ transport, requestTimeoutMs: 2000 });
  client.startReadLoop();
  // jcode 启动提示等非协议文本。
  pushLine("Starting server...");
  pushLine("{not json");
  const reqPromise = client.request("ping", {});
  await sleep(10);
  pushLine({ jsonrpc: "2.0", id: 1, result: { pong: true } });
  const result = await reqPromise;
  assert.deepEqual(result, { pong: true });
  client.dispose();
});

test("R4-4: ACP 错误响应 reject 且保留 code/message（不吞原因）", async () => {
  const { transport, pushLine } = memoryTransport();
  const client = new JcodeAcpClient({ transport, requestTimeoutMs: 2000 });
  client.startReadLoop();
  const reqPromise = client.request("session/load", { sessionId: "bogus" });
  await sleep(10);
  pushLine({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "unknown session" } });
  await assert.rejects(reqPromise, (err) => {
    assert.equal(err.code, -32602);
    assert.ok(err.message.includes("unknown session"));
    return true;
  });
  client.dispose();
});
