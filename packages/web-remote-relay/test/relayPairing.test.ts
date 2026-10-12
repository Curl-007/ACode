import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";

import {
  WEB_REMOTE_CONTROL_MAX_BINARY_FRAME_BYTES,
  buildWebRemoteControlProofMessage,
  webRemoteControlTerminalInboundMessageSchema,
} from "@acode/shared";
import { attachWebRemoteRelayToHttpServer, createWebRemoteRelayServer } from "../src/index.js";

// relay 的端到端验证：真起一个 HTTP+WS 服务，用两个真实 WebSocket 客户端分别扮演
// 桌面（device）与手机（terminal），走完整的
//   注册 → 鉴权 → 配对 → attach → 二进制双向透传
// 流程。
//
// 这里刻意不复用桌面侧 transport 类：那会变成「用实现测实现」。用协议字面量重写一遍
// 客户端，才能验证「协议本身是否自洽」——这正是 relay 唯一的对外契约。

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacProof(
  passHash: string,
  nonce: string,
  role: "device" | "terminal",
  sid: string,
): string {
  // 用 node:crypto 直算，不走产品代码的 calculateWebRemoteControlProof。
  return createHmac("sha256", passHash)
    .update(buildWebRemoteControlProofMessage({ nonce, role, deviceSid: sid }))
    .digest("base64url");
}

interface RelayHarness {
  wsUrl: string;
  close(): Promise<void>;
}

async function startRelay(): Promise<RelayHarness> {
  const relay = createWebRemoteRelayServer();
  const server: Server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  attachWebRemoteRelayToHttpServer(server, relay);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    async close() {
      relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 收集入站控制消息，并暴露一个「等到某个 type」的等待器。 */
function createMessageInbox(socket: WebSocket) {
  const control: Array<Record<string, unknown>> = [];
  const binary: Uint8Array[] = [];
  const waiters: Array<{
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  const binaryWaiters: Array<(frame: Uint8Array) => void> = [];

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const frame = new Uint8Array(data);
      const waiter = binaryWaiters.shift();
      if (waiter) waiter(frame);
      else binary.push(frame);
      return;
    }
    const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    control.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (waiter.match(parsed)) {
        waiters.splice(i, 1);
        waiter.resolve(parsed);
      }
    }
  });

  return {
    control,
    waitFor(match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const existing = control.find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待控制消息超时")), 5_000);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    waitForBinary(): Promise<Uint8Array> {
      const existing = binary.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待二进制帧超时")), 5_000);
        binaryWaiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    send(payload: Record<string, unknown>): void {
      socket.send(JSON.stringify(payload));
    },
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("relay 完成注册、鉴权、配对与二进制双向透传", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo"; // 与官方测试向量同一把 key，便于对照
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);

    // 1) 设备注册
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-1",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const ack = await device.waitFor((m) => m.type === "device_register_ack");
    const deviceSid = String(ack.device_sid);
    assert.ok(deviceSid.length > 0, "relay 必须分配 device_sid");

    // 2) 设备鉴权
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceChallenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(deviceChallenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    const deviceAck = await device.waitFor((m) => m.type === "auth_ack");
    assert.equal(deviceAck.pair_status, "waiting", "设备鉴权后应处于等待手机状态");

    // 3) 手机加入 + 鉴权
    const terminalSocket = await openSocket(harness.wsUrl);
    const terminal = createMessageInbox(terminalSocket);
    terminal.send({
      type: "terminal_join",
      device_sid: deviceSid,
      pass_hash: passHash,
      client_ts: Date.now(),
    });
    const terminalChallenge = await terminal.waitFor((m) => m.type === "auth_challenge");
    terminal.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(terminalChallenge.nonce), "terminal", deviceSid),
      client_ts: Date.now(),
    });
    const terminalAck = await terminal.waitFor((m) => m.type === "auth_ack");
    assert.equal(terminalAck.pair_status, "matched", "手机鉴权后应配对成功");

    // 设备侧必须收到 matched 推送——桌面靠它把状态从 running 切到 active。
    const deviceMatched = await device.waitFor(
      (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
    );
    assert.equal(deviceMatched.pair_status, "matched");

    // 4) attach 协商：手机请求 → relay 转给设备 → 设备 ready → relay 转给手机
    terminal.send({ type: "attach_request", device_sid: deviceSid, client_ts: Date.now() });
    await device.waitFor((m) => m.type === "attach_request");
    device.send({ type: "attach_ready", device_sid: deviceSid, client_ts: Date.now() });
    await terminal.waitFor((m) => m.type === "attach_ready");

    // 5) 二进制双向透传（不透明字节）
    const hostToPhone = new Uint8Array([1, 2, 3, 250]);
    deviceSocket.send(hostToPhone, { binary: true });
    const receivedByPhone = await terminal.waitForBinary();
    assert.deepEqual(Array.from(receivedByPhone), Array.from(hostToPhone));

    const phoneToHost = new Uint8Array([9, 8, 7]);
    terminalSocket.send(phoneToHost, { binary: true });
    const receivedByHost = await device.waitForBinary();
    assert.deepEqual(Array.from(receivedByHost), Array.from(phoneToHost));

    terminalSocket.close();
    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("attach 就绪前不转发二进制帧", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo";
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-2",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const challenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(challenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    await device.waitFor((m) => m.type === "auth_ack");

    const terminalSocket = await openSocket(harness.wsUrl);
    const terminal = createMessageInbox(terminalSocket);
    terminal.send({
      type: "terminal_join",
      device_sid: deviceSid,
      pass_hash: passHash,
      client_ts: Date.now(),
    });
    const terminalChallenge = await terminal.waitFor((m) => m.type === "auth_challenge");
    terminal.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(terminalChallenge.nonce), "terminal", deviceSid),
      client_ts: Date.now(),
    });
    await terminal.waitFor((m) => m.type === "auth_ack");

    // 还没 attach：设备发的字节不能被投给手机，否则手机上的 RPC 会先于 Initialize 收到数据。
    deviceSocket.send(new Uint8Array([1]), { binary: true });
    const result = await Promise.race([
      terminal.waitForBinary().then(() => "delivered" as const),
      new Promise<"dropped">((resolve) => setTimeout(() => resolve("dropped"), 300)),
    ]);
    assert.equal(result, "dropped", "attach 就绪前不应转发二进制帧");

    terminalSocket.close();
    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("错误的 passHash 会被拒绝", async () => {
  const harness = await startRelay();
  try {
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-3",
      pass_hash: "dGVzdF9oYXNo",
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );

    const terminalSocket = await openSocket(harness.wsUrl);
    const terminal = createMessageInbox(terminalSocket);
    terminal.send({
      type: "terminal_join",
      device_sid: deviceSid,
      pass_hash: "d3JvbmdfaGFzaA", // 与二维码不符
      client_ts: Date.now(),
    });
    const error = await terminal.waitFor((m) => m.type === "error");
    assert.equal(error.code, "AUTH_FAILED");

    terminalSocket.close();
    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("未知 deviceSid 的手机会被拒绝（二维码已失效）", async () => {
  const harness = await startRelay();
  try {
    const terminalSocket = await openSocket(harness.wsUrl);
    const terminal = createMessageInbox(terminalSocket);
    terminal.send({
      type: "terminal_join",
      device_sid: "00000000-0000-0000-0000-000000000000",
      pass_hash: "dGVzdF9oYXNo",
      client_ts: Date.now(),
    });
    const error = await terminal.waitFor((m) => m.type === "error");
    assert.equal(error.code, "AUTH_FAILED");
    terminalSocket.close();
  } finally {
    await harness.close();
  }
});

test("同一配对只允许一个手机页：第二个手机加入会踢掉第一个", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo";
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-4",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const challenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(challenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    await device.waitFor((m) => m.type === "auth_ack");

    const joinAndAuth = async () => {
      const socket = await openSocket(harness.wsUrl);
      const inbox = createMessageInbox(socket);
      inbox.send({
        type: "terminal_join",
        device_sid: deviceSid,
        pass_hash: passHash,
        client_ts: Date.now(),
      });
      const c = await inbox.waitFor((m) => m.type === "auth_challenge");
      inbox.send({
        type: "auth_response",
        device_sid: deviceSid,
        proof: hmacProof(passHash, String(c.nonce), "terminal", deviceSid),
        client_ts: Date.now(),
      });
      await inbox.waitFor((m) => m.type === "auth_ack");
      return { socket, inbox };
    };

    const first = await joinAndAuth();
    const second = await joinAndAuth();
    const kicked = await first.inbox.waitFor((m) => m.type === "error");
    assert.equal(kicked.code, "KICKED", "第一个手机页应被踢出");

    first.socket.close();
    second.socket.close();
    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("二进制帧超过上限会被断开", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo";
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-5",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const challenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(challenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    await device.waitFor((m) => m.type === "auth_ack");

    const closed = new Promise<number>((resolve) => {
      deviceSocket.once("close", (code: number) => resolve(code));
    });
    deviceSocket.send(new Uint8Array(WEB_REMOTE_CONTROL_MAX_BINARY_FRAME_BYTES + 1), {
      binary: true,
    });
    const code = await closed;
    assert.equal(code, 4008, "超限帧应触发 4008 关闭码");
  } finally {
    await harness.close();
  }
});

test("手机断开后设备回到 waiting，可以重新配对", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo";
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-6",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const challenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(challenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    await device.waitFor((m) => m.type === "auth_ack");

    const terminalSocket = await openSocket(harness.wsUrl);
    const terminal = createMessageInbox(terminalSocket);
    terminal.send({
      type: "terminal_join",
      device_sid: deviceSid,
      pass_hash: passHash,
      client_ts: Date.now(),
    });
    const c = await terminal.waitFor((m) => m.type === "auth_challenge");
    terminal.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(c.nonce), "terminal", deviceSid),
      client_ts: Date.now(),
    });
    await terminal.waitFor((m) => m.type === "auth_ack");
    await device.waitFor((m) => m.type === "pair_status_ack" && m.pair_status === "matched");

    terminalSocket.close();
    const backToWaiting = await device.waitFor(
      (m) => m.type === "pair_status_ack" && m.pair_status === "waiting",
    );
    assert.equal(backToWaiting.pair_status, "waiting");

    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("心跳 pair_status_query 得到 pair_status_ack", async () => {
  const harness = await startRelay();
  try {
    const passHash = "dGVzdF9oYXNo";
    const deviceSocket = await openSocket(harness.wsUrl);
    const device = createMessageInbox(deviceSocket);
    device.send({
      type: "device_register_init",
      device_mid: "device-mid-7",
      pass_hash: passHash,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const deviceSid = String(
      (await device.waitFor((m) => m.type === "device_register_ack")).device_sid,
    );
    device.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: { platform: "win32", version: "3.14.3", name: "desktop" },
      client_ts: Date.now(),
    });
    const challenge = await device.waitFor((m) => m.type === "auth_challenge");
    device.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: hmacProof(passHash, String(challenge.nonce), "device", deviceSid),
      client_ts: Date.now(),
    });
    await device.waitFor((m) => m.type === "auth_ack");

    const before = device.control.filter((m) => m.type === "pair_status_ack").length;
    device.send({ type: "pair_status_query", device_sid: deviceSid, client_ts: Date.now() });
    await device.waitFor(
      () => device.control.filter((x) => x.type === "pair_status_ack").length > before,
    );
    deviceSocket.close();
  } finally {
    await harness.close();
  }
});

test("终端入站 schema 能识别合法控制帧、拒绝畸形帧", () => {
  assert.equal(
    webRemoteControlTerminalInboundMessageSchema.safeParse({
      type: "auth_ack",
      pair_status: "matched",
    }).success,
    true,
  );
  assert.equal(
    webRemoteControlTerminalInboundMessageSchema.safeParse({
      type: "auth_ack",
      pair_status: "weird",
    }).success,
    false,
  );
  assert.equal(
    webRemoteControlTerminalInboundMessageSchema.safeParse({ type: "unknown_frame" }).success,
    false,
  );
});

test("base64url 与桌面侧 node 实现一致（proof 编码不会因填充符不匹配）", () => {
  const password = "abcdefghijklmnopqrstuvwx";
  const nodeStyle = createHash("sha256").update(password).digest("base64");
  // 桌面侧 passHash 用标准 base64（含 + / =），手机侧只做比对、不重新编码，
  // 这里固定住这个事实：任何一侧改动编码都会让配对静默失败。
  assert.match(nodeStyle, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(toBase64Url(Buffer.from(nodeStyle, "utf8")).includes("="), false);
});
