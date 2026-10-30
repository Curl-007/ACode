import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  toDisposable,
  type IDisposable,
  type IMessagePassingProtocol,
  type ISocket,
} from "@acode/rpc";
import { RemoteServiceAccess, type DisposableServiceAccessor } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<DisposableServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      // socket 作为底层传输交给 connectViaProtocol，使门面 dispose() 能一路收口到 ws.close()。
      resolve(connectViaProtocol(new SocketProtocol(socket), socket));
    });
  });
}

/**
 * 在既有协议上装配 ChannelClient + 服务门面，并绑定幂等释放边界。
 *
 * `extraTransport`（WebSocket 链路传底层 ISocket）与 protocol 一起构成 client 之下的传输栈；
 * 门面 `dispose()` 按 desktop `serverRemoteConnection.beginDisposal` 的顺序收口：
 * client.dispose()（reject 挂起 RPC，fail-closed）→ protocol.dispose?.()（摘 onMessage 订阅、清帧组装
 * watchdog）→ extraTransport.dispose()（关闭底层 WebSocket/port）。幂等性由 RemoteServiceAccess 守卫。
 */
export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  extraTransport?: IDisposable,
): DisposableServiceAccessor {
  const client = new ChannelClient(protocol);
  const transport = toDisposable(() => {
    client.dispose();
    // IMessagePassingProtocol 未强制 dispose；SocketProtocol 有，裸协议可缺省。
    (protocol as Partial<IDisposable>).dispose?.();
    extraTransport?.dispose();
  });
  return new RemoteServiceAccess(client, transport);
}
