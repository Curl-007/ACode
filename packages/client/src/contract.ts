/**
 * client 的唯一公开契约（架构治理登记面）。
 *
 * 与包根入口 index.ts（`@acode/client`）符号一致：RemoteServiceAccess 服务代理
 * 门面 + WebSocket / MessagePort / 裸协议三种连接方式。连接建立后的协议帧、
 * pending RPC 与重连语义都由 @acode/rpc 的 ChannelClient/Protocol 实例持有，
 * 本模块不复制第二份连接状态。
 *
 * `./globals`（src/globals.d.ts，window.acode 平台桥类型）是纯 ambient 声明面，
 * 不登记为 publicEntrypoints：checker 的入口解析不落到 .d.ts，且全仓没有源码
 * 文件 import 它（消费方经 tsconfig types 引用）。见 specs/module-boundary.md。
 */
export { RemoteServiceAccess } from "./remoteServiceAccess.js";
export { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
export type { WebSocketConnectionCloseEvent } from "./websocket.js";
export { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";
export type { MessagePortServiceConnection } from "./messageport.js";
