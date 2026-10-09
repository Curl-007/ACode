# client

`contract.ts` 是本模块的治理登记契约面，与 `index.ts`（包根 `@acode/client`）符号
一致；两者同时登记为 publicEntrypoints。消费方拿到的是：`RemoteServiceAccess`
（把 `ChannelClient` 自动展开为类型安全的服务代理门面，实现 services 的
`IServiceAccessor`）、三种连接方式（`connectViaMessagePort` /
`createMessagePortServiceConnection`：Desktop renderer 主链路；`connectViaWebSocket`
/ `connectViaProtocol`：Web 远程与裸协议链路）以及对应的连接事件类型。

owner 是 `remote-client-bridge`。状态所有权：连接层状态（协议帧序列、pending
request 表）唯一所有者是 @acode/rpc 的 `ChannelClient` 与其 Protocol 实例；
`RemoteServiceAccess` 只是按 getter 惰性生成的代理门面，不缓存业务数据、不保存
第二份连接状态；`MessagePortServiceConnection.dispose` 是幂等的一次性释放边界
（同时释放 ChannelClient 与底层 port，防止旧 attachment 的挂起 RPC 无法 settle）。

依赖方向：requires [rpc, services, shared]——传输与代理机制来自 `@acode/rpc`，
服务接口类型（`IServiceAccessor` 与各 `I*Service`）来自 `@acode/services`，
`window.acode` 平台桥类型（globals.d.ts）引用 `@acode/shared` 协议投影。任何模块
不得反向依赖本模块内部文件（remoteServiceAccess/websocket/messageport/
rendererLoggingEnv deep import 会被架构检查拒绝）。

`./globals`（globals.d.ts）是 ambient 类型导出（`window.acode`），不登记为
publicEntrypoints：checker 的入口解析不落到 .d.ts，且全仓无源码文件 import 它。
