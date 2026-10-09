/**
 * rpc 的唯一公开契约（架构治理登记面）。
 *
 * 本文件逐名转发包根入口 index.ts 的公开面（单一事实来源仍是 index.ts，
 * 二者必须同步修改）；协议帧编解码、序列化缓冲、pending 请求表、连接路由
 * 等实现细节都在模块内部文件，跨模块 deep import 会被架构检查拒绝。
 *
 * 消费方式：跨模块一律 import 包根 `@acode/rpc`（运行时入口 index.ts）或
 * 本契约面；两者登记为 publicEntrypoints，符号集合一致。
 */

// Layer 0: 基础设施（事件/生命周期/取消/字节缓冲）
export {
  type IDisposable,
  toDisposable,
  DisposableStore,
  Event,
  Emitter,
  Relay,
  EventMultiplexer,
  type CancellationToken,
  CancellationTokenSource,
  VSBuffer,
} from "./index.js";

// Layer 1: 序列化（VQL + 类型标签）
export {
  type IReader,
  type IWriter,
  BufferReader,
  BufferWriter,
  serialize,
  deserialize,
} from "./index.js";

// Layer 2: 传输协议（帧限流、Socket/MessagePort 协议、可持久化协议）
export {
  ChunkStream,
  TRANSPORT_FRAME_MAX_PAYLOAD_BYTES,
  TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS,
  TransportFrameError,
  type TransportFrameViolationReason,
  type IMessagePassingProtocol,
  type ConnectionFlowControl,
  type MessagePortFlowControl,
  type MessagePortFlowState,
  type MessagePortPayload,
  type ISocket,
  SocketProtocol,
  type SocketProtocolOptions,
  ProtocolMessageType,
  ProtocolMessage,
  HEADER_SIZE,
  MessagePortProtocol,
  type MessagePortLike,
  createQueuePair,
  PersistentProtocol,
  type PersistentProtocolOptions,
} from "./index.js";

// Layer 3: Channel RPC（call/listen 抽象与服务端/客户端实现）
export {
  type IChannel,
  type IServerChannel,
  type IChannelServer,
  type IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./index.js";

// Layer 4: 连接管理（1:N 服务端 / 1:1 双向客户端 / 静态路由）
export {
  type ClientConnectionEvent,
  type Client,
  type IConnectionHub,
  type IClientRouter,
  IPCServer,
  IPCClient,
  StaticRouter,
} from "./index.js";

// Layer 5: 服务代理（service ↔ channel 自动互转）与参数守卫
export { ProxyChannel, RpcArgumentError, type RpcArgumentValidator } from "./index.js";

// 日志中间件 —— 装饰 ChannelServer/ChannelClient，统一记录 RPC 调用
export { type RPCLogger, LoggingChannelServer, LoggingChannelClient } from "./index.js";

// 网络遥测中间件 —— 观测传输种类与网络事件（sink 由宿主注入）
export {
  type NetworkTransportKind,
  type NetworkObservation,
  type NetworkTelemetrySink,
  setNetworkTelemetrySink,
  emitNetworkTelemetryObservation,
  NetworkTelemetryChannelServer,
  NetworkTelemetryChannelClient,
} from "./index.js";

// Layer 6: Remote 远程连接（authority 解析、socket 工厂、远程 agent 连接）
export {
  RemoteConnectionType,
  WebSocketRemoteConnection,
  ManagedRemoteConnection,
  type RemoteConnection,
  type ResolvedAuthority,
  type IRemoteAuthorityResolver,
  RemoteAuthorityResolverService,
  type ISocketFactory,
  RemoteSocketFactoryService,
  type IURITransformer,
  type SimpleURI,
  createURITransformer,
  RemoteAgentConnection,
  type RemoteConnectionState,
} from "./index.js";
