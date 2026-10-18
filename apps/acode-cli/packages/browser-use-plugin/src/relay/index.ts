/** browser-relay 公开入口：协议类型、多路复用桥、HTTP/WS 服务端、租约管理器。 */
export { ACODE_BROWSER_RELAY_VERSION, RelayBridge, type RelaySocket } from "./bridge.js";
export { RelayLeaseManager, type RelayLease, type RelayLeaseManagerOptions } from "./lease.js";
export {
  DEFAULT_RELAY_GROUP,
  startRelayServer,
  type RelayServer,
  type RelayServerOptions,
  type RelayUnavailableInfo,
} from "./server.js";
export {
  RELAY_PROTOCOL_VERSION,
  type ExtToRelayMessage,
  type RelayRpcRequest,
  type RelayToExtMessage,
  type TabSnapshot,
} from "./protocol.js";
