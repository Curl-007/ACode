# client module boundary

## Scope

`packages/client` 是 Renderer/Web 侧的远程服务访问桥：把 @acode/rpc 的 Channel
连接自动展开为类型安全的服务代理门面（`RemoteServiceAccess`），并提供
MessagePort（Desktop renderer 主链路）与 WebSocket（Web 远程链路）两种连接方式。
本 spec 登记其纳管为架构模块（managed，ARCH-04 batch 2）：公开契约、状态所有权、
依赖方向与验收场景。纳管批次不改变任何运行时行为与包根公开 API。

## Ownership and invariants

- owner：`remote-client-bridge`。
- 连接层状态（协议帧序列、pending request 表、初始化握手）唯一所有者是
  @acode/rpc 的 `ChannelClient` + Protocol 实例（`MessagePortProtocol`/
  `SocketProtocol`）；client 不复制第二份连接状态。
- `RemoteServiceAccess` 是纯代理门面：构造时按服务 getter 一次性生成
  `ProxyChannel.toService` 代理，不缓存业务数据。
- `MessagePortServiceConnection.dispose` 是幂等的一次性释放边界：scoped remote
  session 换代时必须同时释放 ChannelClient 与底层 port，否则旧 attachment 上的
  挂起 RPC 无法 settle，并继续占用上层去重状态（messageport.ts 注释即此约束）。
- WebSocket 链路对称暴露幂等释放边界：`RemoteServiceAccess.dispose()`（可选注入
  transport）与 `connectViaWebSocket`/`connectViaProtocol` 返回的门面 `dispose()`，
  按 desktop `serverRemoteConnection` 的 `client.dispose() → protocol.dispose() →
  socket.dispose()` 顺序收口，释放 ChannelClient + SocketProtocol + 底层 WebSocket。
  消费方（web 重连换代丢弃孤儿连接时）经此 `dispose()` 释放已打开的活 socket，
  而非静默丢弃（否则泄漏 WebSocket + ChannelClient）。`dispose()` 幂等，重复调用只生效一次。
- renderer 生产构建下连接调试日志静默（rendererLoggingEnv），避免窗口启动与
  重连路径的同步 console 成本。

## Public boundary

- 公开契约是 `src/contract.ts`（治理登记面）；`src/index.ts`（包根
  `@acode/client`）与其符号一致，两者都登记为 publicEntrypoints。其余源文件是
  内部实现，跨模块 deep import 会被 architecture checker 以 `deep-import` 拒绝。
- `./globals` 导出（`src/globals.d.ts`，353 行 ambient `window.acode` 类型）**不
  登记为 publicEntrypoints**：checker 的入口存在性/匹配解析不落到 .d.ts，且全仓
  没有源码文件以 `@acode/client/globals` specifier import 它（消费方经 tsconfig
  types 引用）。它是 client → shared 的唯一依赖边来源（顶层 `import type`）。
- 全仓消费方（desktop host/renderer、server remote、web main）均使用包根
  specifier `@acode/client`（纳管前扫描确认零 deep import）。

## Dependency direction

- 允许：`@acode/rpc`（传输与代理机制）、`@acode/services`（服务接口类型）、
  `@acode/shared`（globals.d.ts 的协议投影类型）——requires: [rpc, services,
  shared]，与 module.ts 清单一致。
- 禁止：client 依赖 desktop/ui/web 等消费方模块；任何模块反向依赖 client 内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——连接实现直接持有 MessagePort/
  WebSocket，声明 domain 层会触发 domain-io。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：client 在 managed
   语义下零违规（无超限文件、无 lint disable、forbidCycles、deep-import）；
   不新增例外，`.architecture-baseline.json` 不动。
2. `node scripts/architecture/architecture-check.mjs context client` 展示 owner
   `remote-client-bridge`、module.ts 与 contract.ts。
3. 包根导出面（index.ts）与治理契约（contract.ts）逐名一致；client 有独立 test 脚本
   （`node --import tsx --test`，与 web/services 同范式，无需预构建、无 jsdom），
   覆盖 WebSocket/MessagePort 连接门面的幂等 `dispose()`（关闭底层传输 + ChannelClient）、
   `connectViaWebSocket` 就绪前失败的 reject 路径，以及 `RemoteServiceAccess` 代理展开——
   传输/远程访问面是纯逻辑，用注入的假 transport/socket 直接驱动，无需 live server。
4. `tsc -b packages/client`（根 `pnpm typecheck` 名单内）通过；
   `contract.example.ts` 随包工程一起编译（无 IO，仅编译与文档验证）。
5. `pnpm --filter @acode/client test`（`tests/**/*.test.ts`）通过；测试文件与被测源文件
   （src/remoteServiceAccess.ts、src/websocket.ts、src/messageport.ts）均在 client 模块根内，
   不产生新的跨模块 deep-import 边。
