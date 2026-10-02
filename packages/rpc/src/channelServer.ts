import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

/**
 * 截断 payload 的十六进制摘要：只取前 16 byte，足够定位畸形帧的形态，
 * 又不会把大段业务内容写进日志（spec 规则 1：不含敏感内容）。
 */
function payloadHexDigest(message: VSBuffer): string {
  const limit = Math.min(message.byteLength, 16);
  const parts: string[] = [];
  for (let i = 0; i < limit; i++) {
    parts.push(message.buffer[i].toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    const reader = new BufferReader(message);

    // 修复依据（specs/rpc-frame-hardening.md 规则 1）：此前 message handler 对
    // deserialize 结果零防护——一字节 0x00 帧即让 header 为 undefined、header[0]
    // 抛 TypeError，异常沿 ws message listener 上抛为 uncaughtException，单帧
    // 即可远程崩溃 server 进程。这里是畸形帧的唯一 catch 点：丢弃该帧并记 warn
    // （截断十六进制摘要，不含敏感内容），连接保持存活，不重抛。
    let header: any;
    let body: any;
    try {
      header = deserialize(reader);
      body = deserialize(reader);
    } catch (error) {
      console.warn(
        `[rpc] ChannelServer dropped malformed frame (${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }) payload[0:16]=<${payloadHexDigest(message)}>`,
      );
      return;
    }

    if (!Array.isArray(header)) {
      // 合法 header 必须是 [RequestType, id, channelName, methodName] 形状的数组；
      // 非 array（如单字节 0x00 帧解出的 undefined）同样按规则 1 丢弃并保持连接。
      console.warn(
        `[rpc] ChannelServer dropped frame with non-array header (${typeof header}) payload[0:16]=<${payloadHexDigest(message)}>`,
      );
      return;
    }

    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const disposable = channel.listen(
      this.ctx,
      request.name,
      request.arg,
    )((data) => {
      this.sendResponse({
        id: request.id,
        data,
        type: ResponseType.EventFire,
      });
    });
    this.activeRequests.set(request.id, disposable);
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}
