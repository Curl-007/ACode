# rpc

`contract.ts` 是本模块的治理登记契约面，逐名转发 `index.ts`（包根 `@acode/rpc`）的
公开符号；两者同时登记为 publicEntrypoints，符号集合必须保持一致（单一事实来源是
`index.ts`，修改公开面时两处同步）。消费方拿到的是分层传输栈：基础设施
（`Event`/`Emitter`/`DisposableStore`/`VSBuffer`/`CancellationToken`）、序列化
（`serialize`/`deserialize` + `BufferReader`/`BufferWriter`）、传输协议
（`SocketProtocol`/`MessagePortProtocol`/`PersistentProtocol` + 帧限流常量与
`TransportFrameError`）、Channel RPC（`ChannelServer`/`ChannelClient`/
`getDelayedChannel`）、连接管理（`IPCServer`/`IPCClient`/`StaticRouter`）、服务代理
（`ProxyChannel`/`RpcArgumentError`）、日志与网络遥测中间件，以及 Remote 远程连接面
（`RemoteAuthorityResolverService`/`RemoteSocketFactoryService`/`RemoteAgentConnection`）。

owner 是 `rpc-transport`。状态所有权：协议层状态（帧序列、pending request 表、
重连/流控窗口）唯一所有者是对应 Protocol 实例（`SocketProtocol`/`MessagePortProtocol`/
`PersistentProtocol`）；连接注册与路由表唯一所有者是 `IPCServer`/`ChannelServer`；
`ProxyChannel` 是无状态的双向转换（fromService 装配时冻结公开面，toService 按属性
访问分派），不另存第二份服务状态。

依赖方向：本模块零 workspace 依赖（requires: []），是全部跨进程/跨窗口通信的传输
基座；任何模块不得反向依赖本模块内部文件（foundation/protocol/channels 等 deep
import 会被架构检查拒绝）。安全红线：`ChannelServer` 对客户端送来的任意帧零容错
（见 specs/rpc-frame-hardening.md），`ProxyChannel.fromService` 的公开面只在装配时
解析一次，杜绝 `constructor`/`__proto__` 成为远程入口。
