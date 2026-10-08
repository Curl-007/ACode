/**
 * 传输帧加固验收测试（specs/rpc-frame-hardening.md 规则 5/6）
 *
 * 场景 5: 声明长度超上限的帧头 → 立即断开、不投递消息、不按声明分配、后续字节被忽略；
 *         声明 = 上限的合法帧照常投递（边界不误伤）。
 * 场景 6: 半帧无进展超过空闲超时 → 断开；期间有新字节到达 → 重新计时不断开；
 *         整帧收齐、缓冲清空 → watchdog 不触发。
 * 场景 7: PersistentProtocol 违规 → onSocketClose 信号（与 ACK 超时同路径）；
 *         replaceSocket 重连后复位违规状态，新连接重新受保护。
 * 场景 8: 集成回归——ChannelServer/ChannelClient over SocketProtocol 合法 RPC 照常；
 *         超限声明帧只终结所在连接，进程存活且可继续服务新连接。
 *
 * 遵循仓库测试约定：node:test + assert/strict，仅内存/进程内 fixture，不监听公网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { VSBuffer } from "../src/buffer.js";
import { ChannelClient } from "../src/channelClient.js";
import { ChannelServer } from "../src/channelServer.js";
import { Emitter, Event } from "../src/foundation.js";
import { PersistentProtocol } from "../src/persistent-protocol.js";
import {
  HEADER_SIZE,
  ProtocolMessage,
  ProtocolMessageType,
  SocketProtocol,
  writeProtocolMessage,
  type ISocket,
} from "../src/protocol.js";
import {
  TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS,
  TRANSPORT_FRAME_MAX_PAYLOAD_BYTES,
} from "../src/transport-frame-limits.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 异步捕获 console.warn：违规断开可能发生在定时器回调里，需要跨 await 持续捕获 */
async function captureWarnAsync(run: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return messages;
}

interface TestSocket extends ISocket {
  /** 模拟对端到达的字节（触发 onData） */
  feed(data: VSBuffer | Uint8Array): void;
  readonly endCalls: number;
  readonly written: Uint8Array[];
}

/**
 * 内存 ISocket fixture：不监听任何端口。
 * onWrite 用于把 write 转发给另一个 fixture，模拟全双工管道（集成测试用）。
 */
function createTestSocket(onWrite?: (data: VSBuffer) => void): TestSocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let endCalls = 0;
  const written: Uint8Array[] = [];
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      written.push(buffer.buffer.slice());
      onWrite?.(buffer);
    },
    end() {
      endCalls += 1;
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {},
    feed(data: VSBuffer | Uint8Array) {
      onData.fire(data instanceof VSBuffer ? data : VSBuffer.wrap(data));
    },
    get endCalls() {
      return endCalls;
    },
    written,
  };
}

/** 手工构造 13 字节帧头（type/id/ack/length），用于伪造超限声明 */
function headerOf(type: ProtocolMessageType, id: number, ack: number, length: number): Uint8Array {
  const header = VSBuffer.alloc(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(ack, 5);
  header.writeUInt32BE(length, 9);
  return header.buffer.slice();
}

function regularFrame(payload: Uint8Array | string): VSBuffer {
  const data = typeof payload === "string" ? VSBuffer.fromString(payload) : VSBuffer.wrap(payload);
  return writeProtocolMessage(new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, data));
}

// ============================================================================
// 场景 5: 声明长度超上限 → 断开；= 上限 → 照常
// ============================================================================

test("场景5: SocketProtocol 声明长度超上限的帧头 → 立即断开、不投递、后续字节忽略", async () => {
  const warns = await captureWarnAsync(async () => {
    const socket = createTestSocket();
    const protocol = new SocketProtocol(socket, { maxFramePayloadBytes: 64 });
    const received: VSBuffer[] = [];
    protocol.onMessage((message) => received.push(message));

    // 只喂 13 字节帧头（声明 65 = cap+1）：校验必须先于任何 body 分配发生
    socket.feed(headerOf(ProtocolMessageType.Regular, 1, 0, 65));
    assert.equal(socket.endCalls, 1, "超限声明必须立即终结连接");
    assert.deepEqual(received, []);

    // 违规后 onData 订阅已摘除：对端后续字节被忽略，不再产生第二次断开
    socket.feed(VSBuffer.alloc(10));
    socket.feed(headerOf(ProtocolMessageType.Regular, 2, 0, 1));
    assert.deepEqual(received, []);
    assert.equal(socket.endCalls, 1, "断开必须幂等");
    protocol.dispose();
  });

  const violations = warns.filter((message) =>
    message.includes("SocketProtocol transport frame violation (declared-payload-too-large)"),
  );
  assert.equal(violations.length, 1);
  // warn 只含声明长度与上限，不含 payload 内容
  assert.match(violations[0], /declared payload length 65 exceeds transport frame limit 64/);
});

test("场景5(边界): 声明长度恰好等于上限的合法帧照常投递，分片到达也完整", () => {
  const socket = createTestSocket();
  const protocol = new SocketProtocol(socket, { maxFramePayloadBytes: 64 });
  const received: VSBuffer[] = [];
  protocol.onMessage((message) => received.push(message));

  // 帧头与 body 分三次到达，走 ChunkStream 拼接路径
  socket.feed(headerOf(ProtocolMessageType.Regular, 1, 0, 64));
  socket.feed(new Uint8Array(40).fill(7));
  socket.feed(new Uint8Array(24).fill(9));

  assert.equal(socket.endCalls, 0, "等于上限的声明不得误杀");
  assert.equal(received.length, 1);
  assert.equal(received[0].byteLength, 64);
  assert.equal(received[0].buffer[0], 7);
  assert.equal(received[0].buffer[63], 9);
  protocol.dispose();
});

test("场景5(默认值): 常量与 spec 一致，默认配置下多 MiB 合法帧照常投递", () => {
  // 阈值契约钉死：改动必须同步 specs/rpc-frame-hardening.md 规则 5/6 的调研依据
  assert.equal(TRANSPORT_FRAME_MAX_PAYLOAD_BYTES, 256 * 1024 * 1024);
  assert.equal(TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS, 30_000);

  const socket = createTestSocket();
  const protocol = new SocketProtocol(socket); // 全默认阈值
  const received: VSBuffer[] = [];
  protocol.onMessage((message) => received.push(message));

  // 5 MiB 帧：大于 repo 内多数合法载荷（v4 物理帧 1 MiB），远小于 256 MiB 上限
  const payload = new Uint8Array(5 * 1024 * 1024).fill(1);
  socket.feed(regularFrame(payload));
  assert.equal(socket.endCalls, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].byteLength, payload.byteLength);
  protocol.dispose();
});

// ============================================================================
// 场景 6: 半帧组装空闲超时
// ============================================================================

test("场景6: SocketProtocol 半帧停滞超过空闲超时 → 断开；有新字节则重新计时", async () => {
  const warns = await captureWarnAsync(async () => {
    const socket = createTestSocket();
    const protocol = new SocketProtocol(socket, { frameAssemblyIdleTimeoutMs: 400 });
    const received: VSBuffer[] = [];
    protocol.onMessage((message) => received.push(message));

    // 声明 100 字节，先滴一半：watchdog 武装
    socket.feed(headerOf(ProtocolMessageType.Regular, 1, 0, 100));
    socket.feed(new Uint8Array(40));
    await sleep(150);
    assert.equal(socket.endCalls, 0, "空闲窗内不应断开");

    // 新字节到达 = 有进展 → 重新计时（idle 语义，慢但持续推进的合法大帧不被误杀）
    socket.feed(new Uint8Array(20));
    await sleep(150);
    assert.equal(socket.endCalls, 0, "新字节到达后应重新计时");

    // 此后停滞：超过空闲超时 → 断开
    await sleep(500);
    assert.equal(socket.endCalls, 1, "半帧无进展超时后必须断开");
    assert.deepEqual(received, [], "停滞半帧不得投递为消息");
    protocol.dispose();
  });

  const timeouts = warns.filter((message) =>
    message.includes("SocketProtocol transport frame violation (assembly-idle-timeout)"),
  );
  assert.equal(timeouts.length, 1);
  // 缓冲字节 = 13 帧头 + 40 + 20 body（半帧整体滞留量）
  assert.match(timeouts[0], /partial frame assembly stalled \(73 buffered bytes\) for 400ms/);
});

test("场景6(不误伤): 整帧收齐缓冲清空后 watchdog 不触发，连接长期空闲仍存活", async () => {
  const socket = createTestSocket();
  const protocol = new SocketProtocol(socket, { frameAssemblyIdleTimeoutMs: 100 });
  const received: VSBuffer[] = [];
  protocol.onMessage((message) => received.push(message));

  socket.feed(regularFrame("complete"));
  assert.equal(received.length, 1);

  // 远超空闲超时地闲置：缓冲无半帧字节，不得武装定时器、不得断开
  await sleep(300);
  assert.equal(socket.endCalls, 0, "纯空闲连接不受 watchdog 影响");
  protocol.dispose();
});

// ============================================================================
// 场景 7: PersistentProtocol 同构防护 + 重连复位
// ============================================================================

test("场景7: PersistentProtocol 声明超限 → onSocketClose 信号 + 断开，不投递消息", async () => {
  const warns = await captureWarnAsync(async () => {
    const socket = createTestSocket();
    const protocol = new PersistentProtocol(socket, { maxFramePayloadBytes: 64 });
    const received: VSBuffer[] = [];
    let socketCloseSignals = 0;
    protocol.onMessage((message) => received.push(message));
    protocol.onSocketClose(() => {
      socketCloseSignals += 1;
    });

    socket.feed(headerOf(ProtocolMessageType.Regular, 1, 0, 65));
    assert.equal(socket.endCalls, 1);
    assert.equal(socketCloseSignals, 1, "违规断开必须复用 onSocketClose 既有信号");
    assert.deepEqual(received, []);

    socket.feed(VSBuffer.alloc(10));
    assert.deepEqual(received, [], "违规后对端字节必须被忽略");
    assert.equal(socketCloseSignals, 1, "信号只发一次");
    protocol.dispose();
  });

  const violations = warns.filter((message) =>
    message.includes("PersistentProtocol transport frame violation (declared-payload-too-large)"),
  );
  assert.equal(violations.length, 1);
});

test("场景7(超时): PersistentProtocol 半帧停滞超过空闲超时 → onSocketClose + 断开", async () => {
  const warns = await captureWarnAsync(async () => {
    const socket = createTestSocket();
    const protocol = new PersistentProtocol(socket, { frameAssemblyIdleTimeoutMs: 200 });
    let socketCloseSignals = 0;
    protocol.onSocketClose(() => {
      socketCloseSignals += 1;
    });

    socket.feed(headerOf(ProtocolMessageType.Regular, 1, 0, 100));
    socket.feed(new Uint8Array(30));
    await sleep(450);
    assert.equal(socket.endCalls, 1);
    assert.equal(socketCloseSignals, 1);
    protocol.dispose();
  });

  assert.equal(
    warns.filter((message) =>
      message.includes("PersistentProtocol transport frame violation (assembly-idle-timeout)"),
    ).length,
    1,
  );
});

test("场景7(重连): 合法帧照常投递；replaceSocket 复位违规状态且新连接重新受保护", async () => {
  await captureWarnAsync(async () => {
    const socketA = createTestSocket();
    const protocol = new PersistentProtocol(socketA);
    const received: string[] = [];
    protocol.onMessage((message) => received.push(message.toString()));

    // 合法帧照常投递（回归）
    socketA.feed(regularFrame("legit"));
    assert.deepEqual(received, ["legit"]);

    // 旧连接因违规终结（默认上限 256MiB，仅 13 字节帧头即被拒，无大分配）
    socketA.feed(headerOf(ProtocolMessageType.Regular, 2, 0, TRANSPORT_FRAME_MAX_PAYLOAD_BYTES + 1));
    assert.equal(socketA.endCalls, 1);

    // 模拟 RemoteAgentConnection 重连：replaceSocket 后新会话必须恢复正常收发
    const socketB = createTestSocket();
    protocol.replaceSocket(socketB);
    socketB.feed(regularFrame("after-reconnect"));
    assert.deepEqual(received, ["legit", "after-reconnect"], "重连后合法帧必须照常投递");

    // 新连接重新受声明上限保护
    socketB.feed(
      headerOf(ProtocolMessageType.Regular, 3, 0, TRANSPORT_FRAME_MAX_PAYLOAD_BYTES + 1),
    );
    assert.equal(socketB.endCalls, 1, "重连后的新连接必须重新执行声明上限");
    protocol.dispose();
  });
});

// ============================================================================
// 场景 8: 集成回归 —— ChannelServer over SocketProtocol
// ============================================================================

test("场景8: 合法 RPC 照常；超限声明帧只终结所在连接，进程存活可继续服务新连接", async () => {
  const warns = await captureWarnAsync(async () => {
    // 全双工内存管道：client 侧 write → server 侧 onData，反之亦然
    const clientSocket = createTestSocket((data) => serverSocket.feed(data));
    const serverSocket = createTestSocket((data) => clientSocket.feed(data));

    const clientProtocol = new SocketProtocol(clientSocket);
    const client = new ChannelClient(clientProtocol);
    const serverProtocol = new SocketProtocol(serverSocket);
    const server = new ChannelServer(serverProtocol, "test");
    server.registerChannel("echo", {
      // IServerChannel.call<T> 要求返回 Promise<T>（泛型由调用方实例化），
      // 测试 handler 用 Promise<any> 满足签名。
      call: async (_ctx, _command, arg): Promise<any> => `echo:${String(arg)}`,
      listen: () => Event.None,
    });

    // 合法 RPC roundtrip（走真实分帧路径）
    assert.equal(await client.getChannel("echo").call<string>("ping", 41), "echo:41");

    // 攻击帧：server 侧收到超限声明的 13 字节帧头 → 该连接被终结
    serverSocket.feed(
      headerOf(ProtocolMessageType.Regular, 99, 0, TRANSPORT_FRAME_MAX_PAYLOAD_BYTES + 1),
    );
    assert.equal(serverSocket.endCalls, 1);

    server.dispose();
    client.dispose();
    clientProtocol.dispose();
    serverProtocol.dispose();

    // 进程存活：全新连接上的 RPC 照常（等价于 server 继续服务其它客户端）
    const clientSocket2 = createTestSocket((data) => serverSocket2.feed(data));
    const serverSocket2 = createTestSocket((data) => clientSocket2.feed(data));
    const clientProtocol2 = new SocketProtocol(clientSocket2);
    const client2 = new ChannelClient(clientProtocol2);
    const serverProtocol2 = new SocketProtocol(serverSocket2);
    const server2 = new ChannelServer(serverProtocol2, "test2");
    server2.registerChannel("echo", {
      call: async (_ctx, _command, arg): Promise<any> => `echo:${String(arg)}`,
      listen: () => Event.None,
    });
    assert.equal(await client2.getChannel("echo").call<string>("ping", 42), "echo:42");

    server2.dispose();
    client2.dispose();
    clientProtocol2.dispose();
    serverProtocol2.dispose();
  });

  assert.equal(
    warns.filter((message) => message.includes("declared-payload-too-large")).length,
    1,
  );
});
