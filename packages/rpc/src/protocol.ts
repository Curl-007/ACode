/**
 * Layer 2: 传输协议抽象
 *
 * IMessagePassingProtocol 是整个 IPC 框架的"腰部"——
 * 它上面是 Channel RPC 层（完全传输无关），
 * 它下面是各种具体传输实现（Electron/MessagePort/Socket/ChildProcess）。
 *
 * 只要实现 send() 和 onMessage，就能接入整个 RPC 框架。
 */

import { VSBuffer } from "./buffer.js";
import { ChunkStream } from "./chunk-stream.js";
import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import {
  TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS,
  TRANSPORT_FRAME_MAX_PAYLOAD_BYTES,
  TransportFrameError,
  unrefTimer,
} from "./transport-frame-limits.js";

// ============================================================================
// 核心传输接口
// ============================================================================

/**
 * IMessagePassingProtocol —— 整个框架的核心抽象
 *
 * 这就是 VS Code 通信能力的秘密：上层代码只看到 send/onMessage，
 * 不管底层是 Electron IPC、MessagePort、WebSocket 还是 TCP Socket。
 */
export interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  drain?(): Promise<void>;
}

/**
 * 连接级只读流控观察面。
 *
 * transport 负责维护未确认字节与状态边沿；业务层只能订阅，不能伪造 ACK 或直接改水位。
 */
export interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  readonly onSaturated: Event<void>;
  readonly onDrained: Event<void>;
}

export type MessagePortFlowState = "saturated" | "drained";

export interface MessagePortFlowControl {
  __acodeRpcControl: "connection-flow-v1";
  state: MessagePortFlowState;
}

export type MessagePortPayload = Uint8Array | MessagePortFlowControl;

function isMessagePortFlowControl(value: unknown): value is MessagePortFlowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.__acodeRpcControl === "connection-flow-v1" &&
    (record.state === "saturated" || record.state === "drained")
  );
}

// ============================================================================
// Socket 接口（用于 TCP/WebSocket 等流式传输）
// ============================================================================

/**
 * ISocket 抽象了底层的网络 socket。
 * 在 Node.js 环境是 net.Socket，在浏览器环境是 WebSocket。
 */
export interface ISocket extends IDisposable {
  onData: Event<VSBuffer>;
  onClose: Event<void>;
  onEnd: Event<void>;
  write(buffer: VSBuffer): void;
  end(): void;
  drain(): Promise<void>;
}

// ============================================================================
// Protocol —— 在 ISocket 上实现 IMessagePassingProtocol
// ============================================================================

/**
 * 消息帧格式 (13 bytes header):
 *
 * ┌─────────┬──────────┬──────────┬──────────────┐
 * │ type(1) │  id(4)   │  ack(4)  │  length(4)   │
 * └─────────┴──────────┴──────────┴──────────────┘
 *
 * type:   消息类型（Regular, Ack, KeepAlive 等）
 * id:     消息序号
 * ack:    确认号（告诉对方"我已收到你的消息到第 ack 号"）
 * length: payload 长度
 */
export enum ProtocolMessageType {
  None = 0,
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

export const HEADER_SIZE = 13; // 1 + 4 + 4 + 4

export class ProtocolMessage {
  constructor(
    public readonly type: ProtocolMessageType,
    public readonly id: number,
    public readonly ack: number,
    public readonly data: VSBuffer,
  ) {}

  get byteLength(): number {
    return HEADER_SIZE + this.data.byteLength;
  }
}

export function writeProtocolMessage(msg: ProtocolMessage): VSBuffer {
  const result = VSBuffer.alloc(HEADER_SIZE + msg.data.byteLength);
  result.writeUInt8(msg.type, 0);
  result.writeUInt32BE(msg.id, 1);
  result.writeUInt32BE(msg.ack, 5);
  result.writeUInt32BE(msg.data.byteLength, 9);
  result.set(msg.data, HEADER_SIZE);
  return result;
}

/**
 * SocketProtocol 可调参数。
 *
 * 缺省值即传输层加固常量；选项存在的意义是让测试注入小阈值验证行为，
 * 生产调用方（server WS / stdio / remote client）不传，统一受默认上限保护。
 */
export interface SocketProtocolOptions {
  /** 单帧声明 payload 长度硬上限；默认 TRANSPORT_FRAME_MAX_PAYLOAD_BYTES。 */
  maxFramePayloadBytes?: number;
  /** 半帧组装空闲超时（ms）；默认 TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS。 */
  frameAssemblyIdleTimeoutMs?: number;
}

/**
 * 基础 Protocol: 在 ISocket 上加消息帧，实现 IMessagePassingProtocol。
 * 只做消息分帧，不做 ACK/重连（那是 PersistentProtocol 的事）。
 */
export class SocketProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly chunkStream = new ChunkStream();
  private readonly disposables = new DisposableStore();

  private readonly maxFramePayloadBytes: number;
  private readonly frameAssemblyIdleTimeoutMs: number;
  /** 半帧组装空闲 watchdog；仅在缓冲存在未完成帧字节时武装（spec 规则 6）。 */
  private assemblyIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 传输层违规标志：置位后停止解析、忽略后续字节，断开只做一次。 */
  private transportFailed = false;

  constructor(
    private socket: ISocket,
    options: SocketProtocolOptions = {},
  ) {
    this.maxFramePayloadBytes = options.maxFramePayloadBytes ?? TRANSPORT_FRAME_MAX_PAYLOAD_BYTES;
    this.frameAssemblyIdleTimeoutMs =
      options.frameAssemblyIdleTimeoutMs ?? TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS;
    this.disposables.add(
      socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        this.readMessages();
        this.rearmAssemblyIdleTimer();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    this.writeMessage(new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, buffer));
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const type = header.readUInt8(0) as ProtocolMessageType;
      const _id = header.readUInt32BE(1);
      const _ack = header.readUInt32BE(5);
      const length = header.readUInt32BE(9);

      // 修复依据（specs/rpc-frame-hardening.md 规则 5）：声明长度此前无上限
      // （uint32 可声明 ~4 GiB），恶意对端声明超大帧并慢速滴字节即可让接收缓冲
      // 无界累积、吃光堆外内存。流式传输上无法安全跳过永远不会到齐的半帧再同步
      // 字节流，因此超限立即终结连接。检查在 body 到达之前基于 header 完成，
      // 不会按恶意声明长度做任何分配。
      if (length > this.maxFramePayloadBytes) {
        this.failTransport(
          new TransportFrameError(
            "declared-payload-too-large",
            `declared payload length ${length} exceeds transport frame limit ${this.maxFramePayloadBytes}`,
          ),
        );
        return;
      }

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // 不能在 body 未到齐时提前消费 header，否则下一段数据拼上来后
        // 已经找不到这帧的长度信息，调用方就会一直等待一个永远不会完成的 Promise。
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      if (length === 0) {
        if (type === ProtocolMessageType.Regular) {
          this._onMessage.fire(VSBuffer.alloc(0));
        }
        continue;
      }

      const body = this.chunkStream.read(length);
      if (!body) {
        throw new Error("SocketProtocol 读取到完整帧长度后 body 不应为空");
      }

      if (type === ProtocolMessageType.Regular) {
        this._onMessage.fire(body);
      }
    }
  }

  /**
   * 半帧组装空闲 watchdog（specs/rpc-frame-hardening.md 规则 6）：
   * 仅在接收缓冲存在未完成帧字节时武装；每次 onData（即每个到达的字节批）都会
   * 走到这里重新计时，因此"慢但持续推进"的合法大帧不会被误杀，停滞的半帧到期断开。
   * 缓冲清空（整帧收齐）后不再武装，纯空闲连接不受影响。
   */
  private rearmAssemblyIdleTimer(): void {
    if (this.transportFailed) {
      return;
    }
    this.clearAssemblyIdleTimer();
    if (this.chunkStream.byteLength === 0) {
      return;
    }
    this.assemblyIdleTimer = setTimeout(() => {
      this.assemblyIdleTimer = null;
      this.failTransport(
        new TransportFrameError(
          "assembly-idle-timeout",
          `partial frame assembly stalled (${this.chunkStream.byteLength} buffered bytes) for ${this.frameAssemblyIdleTimeoutMs}ms`,
        ),
      );
    }, this.frameAssemblyIdleTimeoutMs);
    unrefTimer(this.assemblyIdleTimer);
  }

  private clearAssemblyIdleTimer(): void {
    if (this.assemblyIdleTimer !== null) {
      clearTimeout(this.assemblyIdleTimer);
      this.assemblyIdleTimer = null;
    }
  }

  /**
   * 传输层帧违规收口：记 warn（只含声明长度/超时值，不含 payload 内容）、停止解析、
   * 终结底层连接。消费方（server WS/stdio、remote client）都有 close 驱动的既有清理
   * 路径（socket.onClose / ws close / stream close），断开即复用这些路径，不新增事件面。
   */
  private failTransport(error: TransportFrameError): void {
    if (this.transportFailed) {
      return;
    }
    this.transportFailed = true;
    this.clearAssemblyIdleTimer();
    console.warn(
      `[rpc] SocketProtocol transport frame violation (${error.reason}): ${error.message}; closing connection`,
    );
    // 先 dispose（摘除 onData 订阅，违规对端的后续字节被忽略），再 end 通知对端关闭。
    this.dispose();
    this.socket.end();
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    this.clearAssemblyIdleTimer();
    this.disposables.dispose();
    this._onMessage.dispose();
  }
}

// ============================================================================
// QueueProtocol —— 内存中的协议对，用于测试
// ============================================================================

/**
 * 创建一对通过内存队列连接的 protocol，
 * 一端 send 的消息会出现在另一端的 onMessage。
 * 非常适合单元测试，不需要真正的网络连接。
 */
export function createQueuePair(): [IMessagePassingProtocol, IMessagePassingProtocol] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();

  const protocolA: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // A 发送的消息 → B 收到
      setTimeout(() => emitterB.fire(buffer), 0);
    },
    onMessage: emitterA.event,
  };

  const protocolB: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // B 发送的消息 → A 收到
      setTimeout(() => emitterA.fire(buffer), 0);
    },
    onMessage: emitterB.event,
  };

  return [protocolA, protocolB];
}

// ============================================================================
// MessagePort Protocol —— 用于 Web Worker / Electron sandbox
// ============================================================================

/**
 * MessagePort 接口的最小声明，
 * 使得这个 Protocol 可以同时在浏览器和 Electron 中使用。
 */
export interface MessagePortLike {
  addEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  postMessage(message: MessagePortPayload): void;
  start(): void;
  close(): void;
}

/**
 * 在 MessagePort 上实现 IMessagePassingProtocol。
 * 这是最简单的传输实现——不需要分帧，因为 MessagePort 本身就是消息边界的。
 */
export class MessagePortProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;
  private readonly _onFlowState = new Emitter<MessagePortFlowState>();
  readonly onFlowState = this._onFlowState.event;

  private readonly handler: (e: { data: MessagePortPayload }) => void;

  constructor(private port: MessagePortLike) {
    this.handler = (e: { data: MessagePortPayload }) => {
      if (isMessagePortFlowControl(e.data)) {
        this._onFlowState.fire(e.data.state);
        return;
      }
      // MessagePort control object 不能进入 Channel deserialize；未知对象和伪造
      // connection-flow-v1 一律丢弃，只有真实 Uint8Array 才是 RPC binary。
      if (e.data instanceof Uint8Array) this._onMessage.fire(VSBuffer.wrap(e.data));
    };
    this.port.addEventListener("message", this.handler);
    this.port.start();
  }

  send(buffer: VSBuffer): void {
    this.port.postMessage(buffer.buffer);
  }

  sendFlowState(state: MessagePortFlowState): void {
    this.port.postMessage({ __acodeRpcControl: "connection-flow-v1", state });
  }

  disconnect(): void {
    this.port.removeEventListener("message", this.handler);
    this.port.close();
    this._onMessage.dispose();
    this._onFlowState.dispose();
  }
}
