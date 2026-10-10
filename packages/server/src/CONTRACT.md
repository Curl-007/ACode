# server

`@acode/server` 是远程服务器端与 Harness API 翻译桥。owner 是 `remote-server`。
权威公开面是 `packages/server/package.json` 的 exports：包根（`createHttpServer`）、
`./stdio`（`createStdioServer`/`wrapStdio`）、`./harness`（Harness API 翻译桥）、
`./harness-inprocess`（ACP 宿主同进程装配）与 `./remote`（backend/连接/部署面）。

`"./remote/*.js"` 是通配子路径导出：架构检查只能做精确路径匹配
（`publicEntrypointMatches`），无法表达通配。因此被跨模块消费的 remote 文件
（`remote/index.ts`、`remote/posixShell.ts`、`remote/remoteConnectionProgressContext.ts`、
`remote/wsl-backend.ts`、`remote/wsl-detect.ts`）在 architecture-policy.yaml 的
publicEntrypoints 逐一显式登记——通配面在治理侧是「欠声明」的：新的跨模块
deep import 会失败并迫使回到策略显式补登，这是有意的 ratchet。

`contract.ts` 是治理用精选视图，不替代上述包入口。状态所有权：services 的
`ServiceCollection` 是服务实例唯一所有者（`harness-inprocess.ts` 只持懒工厂与
dispose 句柄，不另存业务状态）；remote backend 实例只持连接作用域资源，
断开事件经 `onDidDisconnect` 单向上报。

依赖方向：`client`（RemoteServiceAccess 通道定义）、`rpc`（Emitter/SocketProtocol/
ChannelServer）、`services`（ServiceCollection 装配）、`shared`（协议/schema
唯一事实源）；层为单层 `app`（直接持有 socket、PTY、子进程与文件 IO，声明
domain 层会触发 domain-io）。任何模块不得 deep import 未登记的内部文件。
