import type { Event, IDisposable } from "@acode/rpc";
import type { ACodeProtocolMessage } from "@acode/shared";

export type ACodeProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface ACodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface ACodeProtocolTransport extends IDisposable {
  readonly kind: ACodeProtocolTransportKind;
  readonly onMessage: Event<ACodeProtocolMessage>;
  readonly onClose: Event<ACodeProtocolTransportClosedEvent>;
  send(message: ACodeProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
