/**
 * rpc-frame-hardening 验收测试（specs/rpc-frame-hardening.md）
 *
 * 场景 1: 一字节 0x00 帧送达 ChannelServer：连接存活、记 warn、server 不崩，后续合法 RPC 正常。
 * 场景 2: 声明长度超界的压缩数组小帧：抛 FrameDecodeError、被丢弃、不发生大分配。
 * 场景 3: 抛异常的 listener 不影响其余 listener，进程不崩，记 warn。
 * 场景 4: 回归——合法帧 roundtrip、call / 事件链路语义不变。
 *
 * 遵循仓库测试约定：node:test + assert/strict，仅内存/进程内 fixture，不监听公网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { VSBuffer } from "../src/buffer.js";
import { ChannelClient } from "../src/channelClient.js";
import { ChannelServer } from "../src/channelServer.js";
import { Event, Emitter } from "../src/foundation.js";
import { createQueuePair } from "../src/protocol.js";
import {
  BufferReader,
  BufferWriter,
  FrameDecodeError,
  deserialize,
  serialize,
} from "../src/serialization.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 同步捕获 console.warn 输出，避免测试期间的 warn 污染输出流 */
function captureWarn(run: () => void): string[] {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return messages;
}

/** 异步版本：warn 可能来自 setTimeout 投递的帧，需要跨 await 持续捕获 */
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

/** 计数 read 调用的 reader，用于证明超界数组在进入元素迭代前即被拒绝 */
class ReadCountingReader extends BufferReader {
  readCount = 0;

  override read(bytes: number): VSBuffer {
    this.readCount++;
    return super.read(bytes);
  }
}

/** VQL(2^30) = [0x80, 0x80, 0x80, 0x80, 0x04]，见 serialization.ts 的 7bit 分组编码 */
const VQL_1G = Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x04);

function frameOf(...parts: Uint8Array[]): VSBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return VSBuffer.wrap(bytes);
}

/** 构造 client + server 的内存传输对（createQueuePair：一端 send 即另一端 onMessage） */
function createRpcPair() {
  const [clientProtocol, serverProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "ctx");
  const client = new ChannelClient(clientProtocol);
  return { clientProtocol, server, client };
}

// ============================================================================
// 场景 1: 一字节 0x00 帧 —— 连接存活、记 warn、不崩
// ============================================================================

test("场景1: 一字节 0x00 帧被 ChannelServer 丢弃，连接存活且后续合法 RPC 正常", async () => {
  const warns = await captureWarnAsync(async () => {
    const { clientProtocol, server, client } = createRpcPair();
    server.registerChannel("echo", {
      call: async (_ctx, _command, arg) => `echo:${String(arg)}`,
      listen: () => Event.None,
    });

    // 修复前：header 解为 undefined，header[0] 抛 TypeError 沿事件链上抛为
    // uncaughtException，单帧即可崩掉 server；现在必须被 catch 并丢弃。
    clientProtocol.send(VSBuffer.wrap(new Uint8Array([0x00])));
    await tick();

    // 连接存活：同一连接上的合法 RPC 仍然正常
    assert.equal(await client.getChannel("echo").call<string>("ping", 41), "echo:41");
    // 再来一次，证明丢弃是一次性的、连接状态未被破坏
    assert.equal(await client.getChannel("echo").call<string>("ping", 42), "echo:42");

    server.dispose();
    client.dispose();
  });

  const dropped = warns.filter((message) => message.includes("ChannelServer dropped"));
  assert.equal(dropped.length, 1, `应恰好丢弃一帧，实际 warn: ${JSON.stringify(warns)}`);
  // 0x00 帧的 header 解为 undefined 后，body 读取在 decode 入口即被拒：
  // 走 FrameDecodeError 的 catch 分支（畸形帧唯一 catch 点）
  assert.match(dropped[0], /ChannelServer dropped malformed frame \(FrameDecodeError/);
  // 截断十六进制摘要应包含 0x00 帧的 "00"
  assert.match(dropped[0], /payload\[0:16\]=<00>/);
});

test("场景1(补充): 可解码但 header 非数组的帧同样被丢弃且连接存活", async () => {
  const warns = await captureWarnAsync(async () => {
    const { clientProtocol, server, client } = createRpcPair();
    server.registerChannel("echo", {
      call: async (_ctx, _command, arg) => `echo:${String(arg)}`,
      listen: () => Event.None,
    });

    // header 解为字符串 "hi"（非 [RequestType, ...] 数组）：结构不完整，按规则 1 丢弃
    const writer = new BufferWriter();
    serialize(writer, "hi");
    serialize(writer, undefined);
    clientProtocol.send(writer.buffer);
    await tick();

    assert.equal(await client.getChannel("echo").call<string>("ping", 1), "echo:1");

    server.dispose();
    client.dispose();
  });

  const dropped = warns.filter((message) => message.includes("ChannelServer dropped"));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /non-array header \(string\)/);
});

// ============================================================================
// 场景 2: 超界长度小帧 —— FrameDecodeError、丢弃、无大分配
// ============================================================================

test("场景2: 声明 2^30 元素的数组小帧抛 FrameDecodeError 且不进入元素迭代", () => {
  // [Array 标签][VQL(2^30)][2 个残留字节]：声明长度远超「剩余字节 × 每元素 1 byte」上界
  const frame = frameOf(Uint8Array.of(0x04), VQL_1G, Uint8Array.of(0x00, 0x00));
  const reader = new ReadCountingReader(frame);

  assert.throws(
    () => deserialize(reader),
    (error: unknown) => {
      assert.ok(error instanceof FrameDecodeError);
      assert.match(error.message, /array length 1073741824 exceeds 2 remaining bytes/);
      return true;
    },
  );

  // 上界校验必须先于循环发生：只应读取类型标签 + VQL 字节（共 6 次 read），
  // 若进入 2^30 次元素迭代，readCount 会爆炸且测试早已超时/OOM。
  assert.ok(reader.readCount < 16, `不应进入元素迭代，实际 read 次数 ${reader.readCount}`);
});

test("场景2(链路): 超界数组帧被 ChannelServer 丢弃，进程不崩且后续合法 RPC 正常", async () => {
  const warns = await captureWarnAsync(async () => {
    const { clientProtocol, server, client } = createRpcPair();
    server.registerChannel("echo", {
      call: async (_ctx, _command, arg) => `echo:${String(arg)}`,
      listen: () => Event.None,
    });

    clientProtocol.send(frameOf(Uint8Array.of(0x04), VQL_1G, Uint8Array.of(0x00, 0x00)));
    await tick();

    assert.equal(await client.getChannel("echo").call<string>("ping", 7), "echo:7");

    server.dispose();
    client.dispose();
  });

  const dropped = warns.filter((message) => message.includes("ChannelServer dropped"));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /FrameDecodeError/);
});

test("decode 入口: 未知类型标签与空输入抛 FrameDecodeError 而非返回 undefined", () => {
  // 未知标签（非 0..6）
  assert.throws(
    () => deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.of(0x7f)))),
    FrameDecodeError,
  );
  // 空输入：readUInt8 返回 undefined，修复前会静默返回 undefined 半结构结果
  assert.throws(() => deserialize(new BufferReader(VSBuffer.alloc(0))), FrameDecodeError);
});

test("变长分支: 字节型声明长度超界抛 FrameDecodeError 而非返回截断半结构", () => {
  // String 声明 2^30 字节、实际只剩 1 字节：修复前 BufferReader.slice 会静默截断
  const stringFrame = frameOf(Uint8Array.of(0x01), VQL_1G, Uint8Array.of(0x68));
  assert.throws(
    () => deserialize(new BufferReader(stringFrame)),
    (error: unknown) => error instanceof FrameDecodeError && /string length/.test(error.message),
  );

  // Object 分支同理
  const objectFrame = frameOf(Uint8Array.of(0x05), VQL_1G, Uint8Array.of(0x7b));
  assert.throws(
    () => deserialize(new BufferReader(objectFrame)),
    (error: unknown) => error instanceof FrameDecodeError && /object length/.test(error.message),
  );

  // Buffer / VSBuffer 分支
  const bufferFrame = frameOf(Uint8Array.of(0x02), VQL_1G, Uint8Array.of(0xff));
  assert.throws(() => deserialize(new BufferReader(bufferFrame)), FrameDecodeError);
});

// ============================================================================
// 场景 3: listener 异常隔离
// ============================================================================

test("场景3: 抛错 listener 被 catch 并记 warn，其余 listener 仍按序收到事件", () => {
  const emitter = new Emitter<number>();
  const calls: string[] = [];
  emitter.event(() => {
    calls.push("boom");
    throw new Error("listener failed");
  });
  emitter.event((event) => calls.push(`ok:${event}`));

  const warns = captureWarn(() => {
    assert.doesNotThrow(() => emitter.fire(7));
  });

  assert.deepEqual(calls, ["boom", "ok:7"]);
  assert.equal(warns.filter((message) => message.includes("Emitter listener threw")).length, 1);

  // 后续 fire 不受影响，抛错 listener 不被移除（保持既有订阅语义）
  captureWarn(() => emitter.fire(8));
  assert.deepEqual(calls, ["boom", "ok:7", "boom", "ok:8"]);
});

// ============================================================================
// 场景 4: 回归 —— 合法帧解码与链路语义不变
// ============================================================================

test("回归: 合法值的 serialize/deserialize roundtrip 不变", () => {
  const cases: unknown[] = [
    undefined,
    "hello",
    "",
    0,
    42,
    -7,
    [1, "two", undefined, null],
    VSBuffer.fromString("bin"),
    new Uint8Array([9, 8]),
    { a: 1, nested: { buf: new Uint8Array([1, 2, 3]) } },
  ];

  for (const value of cases) {
    const writer = new BufferWriter();
    serialize(writer, value);
    const decoded = deserialize(new BufferReader(writer.buffer));
    assert.deepStrictEqual(decoded, value);
  }
});

test("回归: 恰好等于上界的紧凑数组仍可解码（边界不误伤合法帧）", () => {
  // [Array, 2][Int 0][Int 1]：声明 2 个元素、剩余恰好 2 字节（每元素最小编码 1 byte）
  const frame = frameOf(
    Uint8Array.of(0x04, 0x02),
    Uint8Array.of(0x06, 0x00),
    Uint8Array.of(0x06, 0x01),
  );
  assert.deepStrictEqual(deserialize(new BufferReader(frame)), [0, 1]);
});

test("回归: client/server 合法 call 与事件链路语义不变", async () => {
  const { server, client } = createRpcPair();
  const emitter = new Emitter<string>();
  const order: string[] = [];

  server.registerChannel("service", {
    call: async (_ctx, command, arg) => `${command}:${String(arg)}`,
    listen: (_ctx, name) => (name === "changed" ? emitter.event : Event.None),
  });

  // Promise 链路
  assert.equal(await client.getChannel("service").call<string>("add", 3), "add:3");

  // 事件链路：远端订阅 + 本地订阅共存，fire 顺序为插入顺序
  const received: string[] = [];
  const subscription = client.getChannel("service").listen<string>("changed")((event) => {
    received.push(event);
  });
  await tick(); // 等 EventListen 帧送达并完成服务端注册
  emitter.event(() => order.push("local"));
  emitter.fire("a");
  await tick();
  await tick(); // 等 EventFire 响应帧回到 client

  assert.deepStrictEqual(received, ["a"]);
  assert.deepStrictEqual(order, ["local"]);

  subscription.dispose();
  server.dispose();
  client.dispose();
});
