// ACode 原生实现（无上游对应物）：omp 依赖 Bun.serve 内建 websocket；node:http 没有，
// 零新增依赖的前提下自实现本回环受控面所需的最小 RFC6455 服务端子集。
/**
 * 最小 RFC6455 WebSocket 服务端，仅服务 browser-relay 的两条回环 socket（/cdp、/ext）。
 *
 * 覆盖：握手（Sec-WebSocket-Accept）、客户端掩码校验（不掩码即协议错误关闭）、
 * text/binary 帧与分片重组、ping/pong、close 握手、服务端无掩码出站帧、跨 TCP 分段的
 * 接收缓冲、64 MiB 载荷上限（超限 1009 失败关闭，不静默损坏）。不支持压缩扩展
 * （permessage-deflate），握手时不协商。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** 截图经两条 websocket 腿 base64 传输；64 MiB 足够常规视口截图，超限失败关闭。 */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** 头部（最多 14 字节）+ 掩码的保守余量：缓冲超过「上限+余量」即判超限。 */
const WS_HEADER_SLACK_BYTES = 64;
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface RelayWebSocket {
  send(text: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketUpgradeOptions {
  /** 握手完成后、首个字节被处理前同步调用：消费方在此登记路由，保证消息不早于注册到达。 */
  onOpen: (socket: RelayWebSocket) => void;
  /** 文本消息回调。 */
  onMessage: (socket: RelayWebSocket, text: string) => void;
  onClose: (socket: RelayWebSocket) => void;
  onError?: (error: Error) => void;
  maxPayloadBytes?: number;
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  nextOffset: number;
}

function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** 把 node:http 的 upgrade 请求升级为 WebSocket；握手非法时回 400 并返回 null。 */
export function upgradeWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WebSocketUpgradeOptions,
): RelayWebSocket | null {
  const key = request.headers["sec-websocket-key"];
  // 版本必须是 13。扩展（permessage-deflate 等）按 RFC 6455 §9.1 处理：客户端的 offer
  // 不是错误，应答里不回 Sec-WebSocket-Extensions 即视为未协商，客户端不得使用——
  // Node/Chrome 客户端都会带上该 offer。
  if (
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    (request.headers["sec-websocket-version"] ?? "") !== "13"
  ) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.end();
    return null;
  }

  const maxPayload = options.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
  let closed = false;
  // 跨 TCP 分段的接收缓冲；deliver 过的帧视图立即转字符串，残留窗口不保留大块引用。
  let buffer: Buffer = Buffer.alloc(0);
  let fragment: { opcode: number; chunks: Buffer[]; byteLength: number } | null = null;

  const ws: RelayWebSocket = {
    send(text) {
      if (closed) return;
      writeFrame(socket, OPCODE_TEXT, Buffer.from(text, "utf8"));
    },
    ping() {
      if (closed) return;
      writeFrame(socket, OPCODE_PING, Buffer.alloc(0));
    },
    close(code = 1000, _reason = "") {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      writeFrame(socket, OPCODE_CLOSE, body);
      socket.end();
      options.onClose(ws);
    },
  };

  const terminateWithError = (error: Error, code: number, reason: string): void => {
    options.onError?.(error);
    ws.close(code, reason);
  };

  const processBytes = (chunk: Buffer): void => {
    if (closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (buffer.length > maxPayload + WS_HEADER_SLACK_BYTES) {
      ws.close(1009, "payload too large");
      return;
    }
    let offset = 0;
    try {
      for (;;) {
        const frame = decodeFrame(buffer, offset);
        if (!frame) break; // 帧不完整：等待下一个 data 事件续读。
        offset = frame.nextOffset;
        if (frame.payload.length > maxPayload) {
          ws.close(1009, "payload too large");
          return;
        }
        if (handleFrame(frame)) return;
      }
    } catch (error) {
      terminateWithError(error instanceof Error ? error : new Error(String(error)), 1002, "protocol error");
      return;
    }
    buffer = offset === 0 ? buffer : buffer.subarray(offset);
  };

  function handleFrame(frame: DecodedFrame): boolean {
    switch (frame.opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY: {
        if (fragment) {
          ws.close(1002, "unexpected data frame during fragmented message");
          return true;
        }
        if (frame.fin) return deliver(frame.opcode, frame.payload);
        fragment = { opcode: frame.opcode, chunks: [frame.payload], byteLength: frame.payload.length };
        return false;
      }
      case OPCODE_CONTINUATION: {
        if (!fragment) {
          ws.close(1002, "continuation without initial frame");
          return true;
        }
        fragment.chunks.push(frame.payload);
        fragment.byteLength += frame.payload.length;
        if (fragment.byteLength > maxPayload) {
          ws.close(1009, "payload too large");
          return true;
        }
        if (frame.fin) {
          const pending = fragment;
          fragment = null;
          return deliver(pending.opcode, Buffer.concat(pending.chunks));
        }
        return false;
      }
      case OPCODE_PING:
        if (!closed) writeFrame(socket, OPCODE_PONG, frame.payload);
        return false;
      case OPCODE_PONG:
        return false;
      case OPCODE_CLOSE: {
        // close 握手：回显状态码后结束连接。
        closed = true;
        writeFrame(socket, OPCODE_CLOSE, frame.payload.subarray(0, 2));
        socket.end();
        options.onClose(ws);
        return true;
      }
      default:
        ws.close(1002, "unknown opcode");
        return true;
    }
  }

  function deliver(opcode: number, payload: Buffer): boolean {
    if (opcode === OPCODE_BINARY) {
      // relay 协议只有 JSON 文本；binary 是协议错误，失败关闭。
      ws.close(1003, "binary frames unsupported");
      return true;
    }
    options.onMessage(ws, payload.toString("utf8"));
    return false;
  }

  socket.on("data", processBytes);
  socket.on("error", (error: Error) => {
    if (closed) return;
    closed = true;
    options.onError?.(error);
    options.onClose(ws);
  });
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    options.onClose(ws);
  });

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      "\r\n",
  );
  // 注册必须先于任何字节处理：对端可在升级应答后立即管线化首帧。
  options.onOpen(ws);
  // head 是 upgrade 请求之后已到达的首批字节，与 data 流同序。
  if (head.length > 0) processBytes(head);

  return ws;
}

/** 从 buffer 的 offset 解出一帧；数据不足返回 null（等待更多字节），非法长度抛错。 */
function decodeFrame(buffer: Buffer, offset: number): DecodedFrame | null {
  if (buffer.length - offset < 2) return null;
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  // RFC6455：客户端帧必须带掩码；服务端帧不带。无掩码的客户端帧按协议错误关闭。
  if (!masked) throw new Error("unmasked client frame");
  let length = second & 0x7f;
  let headerLength = 2;
  if (length === 126) {
    if (buffer.length - offset < 4) return null;
    length = buffer.readUInt16BE(offset + 2);
    headerLength = 4;
  } else if (length === 127) {
    if (buffer.length - offset < 10) return null;
    const big = buffer.readBigUInt64BE(offset + 2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame length exceeds safe integer");
    length = Number(big);
    headerLength = 10;
  }
  const maskStart = offset + headerLength;
  const payloadStart = maskStart + 4;
  if (buffer.length - offset < headerLength + 4 + length) return null;
  const mask = buffer.subarray(maskStart, maskStart + 4);
  const maskedPayload = buffer.subarray(payloadStart, payloadStart + length);
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) payload[i] = maskedPayload[i] ^ mask[i & 3];
  return { fin, opcode, payload, nextOffset: payloadStart + length };
}

function writeFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode; // 服务端帧 FIN=1；本实现不发出分片。
  let headerLength = 2;
  if (payload.length < 126) {
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    headerLength = 4;
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    headerLength = 10;
  }
  socket.write(header.subarray(0, headerLength));
  socket.write(payload);
}
