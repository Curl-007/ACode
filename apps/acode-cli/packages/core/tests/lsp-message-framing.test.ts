// Content-Length 帧编解码单测（omp message-framing 移植面）：往返、跨块、
// 噪声头部 resync、超限头部失败。
import assert from "node:assert/strict";
import test from "node:test";
import { encodeMessageFrame, MessageFramer, MessageFramingError } from "../src/lsp/message-framing.js";

test("encode/decode round-trip handles UTF-8 bodies", () => {
  const message = { jsonrpc: "2.0", method: "textDocument/didOpen", params: { text: "中文内容 emoji 🚀" } };
  const frame = encodeMessageFrame(message);
  const framer = new MessageFramer();
  framer.push(frame);
  const messages = framer.drain();
  assert.deepEqual(messages, [JSON.stringify(message)]);
});

test("chunked delivery reassembles multi-chunk messages", () => {
  const message = { jsonrpc: "2.0", id: 7, result: { items: Array.from({ length: 200 }, (_, i) => `item-${i}`) } };
  const frame = encodeMessageFrame(message);
  const framer = new MessageFramer();
  // 按 7 字节一块喂入，覆盖头部/正文跨块。
  for (let offset = 0; offset < frame.length; offset += 7) {
    framer.push(frame.subarray(offset, Math.min(offset + 7, frame.length)));
  }
  const messages = framer.drain();
  assert.deepEqual(messages, [JSON.stringify(message)]);
});

test("multiple messages in one push drain in order", () => {
  const a = encodeMessageFrame({ jsonrpc: "2.0", id: 1, result: 1 });
  const b = encodeMessageFrame({ jsonrpc: "2.0", id: 2, result: 2 });
  const framer = new MessageFramer();
  framer.push(Buffer.concat([a, b]));
  const messages = framer.drain();
  assert.equal(messages.length, 2);
  assert.equal(JSON.parse(messages[0]!).id, 1);
  assert.equal(JSON.parse(messages[1]!).id, 2);
});

test("non-protocol header noise triggers resync instead of stalling", () => {
  // 自带 \r\n\r\n 终止符的噪声块 = 无 Content-Length 的头部 → resync。
  const noise = "server banner\r\n\r\n";
  const good = encodeMessageFrame({ jsonrpc: "2.0", id: 3, result: null });
  const framer = new MessageFramer();
  framer.push(Buffer.concat([Buffer.from(noise, "latin1"), good]));
  const resynced: string[] = [];
  const messages = framer.drain((headerText) => resynced.push(headerText));
  assert.equal(messages.length, 1, "噪声后仍解析出完整消息");
  assert.equal(JSON.parse(messages[0]!).id, 3);
  assert.equal(resynced.length, 1);
});

test("noisy prefix before Content-Length is tolerated (lenient header search)", () => {
  // 噪声行 + 同块内合法 Content-Length：omp 的宽松 /Content-Length/ 搜索照常解析。
  const noise = "server printing something to stdout\r\n";
  const good = encodeMessageFrame({ jsonrpc: "2.0", id: 3, result: null });
  const framer = new MessageFramer();
  framer.push(Buffer.concat([Buffer.from(noise, "latin1"), good]));
  const resynced: string[] = [];
  const messages = framer.drain((headerText) => resynced.push(headerText));
  assert.equal(messages.length, 1);
  assert.equal(resynced.length, 0);
});

test("oversized header fails with MessageFramingError", () => {
  const junk = "X".repeat(20 * 1024);
  const framer = new MessageFramer();
  framer.push(Buffer.from(`${junk}\r\n\r\n`, "latin1"));
  assert.throws(() => framer.drain(), MessageFramingError);
});
