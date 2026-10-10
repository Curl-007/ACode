# rpc module boundary

## Scope

`packages/rpc` 是 VS Code 风格的 IPC/RPC 传输框架：事件基座、字节缓冲、VQL 序列化、
消息协议（Socket/MessagePort/可持久化）、Channel RPC、连接管理、服务自动代理与远程
连接解析。本 spec 登记其纳管为架构模块（managed，ARCH-04 batch 2）：公开契约、状态
所有权、依赖方向与验收场景。纳管批次不改变任何运行时行为与包根公开 API。

## Ownership and invariants

- owner：`rpc-transport`。
- 协议层状态（帧序列、pending request 表、重连/流控窗口、行缓冲）唯一所有者是对应
  Protocol 实例（`SocketProtocol`/`MessagePortProtocol`/`PersistentProtocol`）；
  `ChunkStream` 与帧限流（`TRANSPORT_FRAME_MAX_PAYLOAD_BYTES`）是协议实例内部的
  防御边界，不被上层复制。
- 连接注册与路由表唯一所有者是 `IPCServer`（1:N）/`ChannelServer`（按连接）；
  `ChannelClient` 只持有 getChannel 代理缓存，不另存连接状态。
- `ProxyChannel` 无状态：fromService 在装配时一次性冻结服务公开面（方法与事件表），
  call 路径不再按字符串索引 service（防止 `constructor`/`__proto__` 成为远程入口）；
  toService 按属性访问分派到 call/listen。
- 帧安全零容错：非法帧直接断开并归因（specs/rpc-frame-hardening.md），不静默吞帧。

## Public boundary

- 公开契约是 `src/contract.ts`（治理登记面，逐名转发 index.ts）；`src/index.ts`
  （包根 `@acode/rpc`）是运行时入口。两者都登记为 publicEntrypoints，符号集合必须
  同步修改。其余源文件（foundation/serialization/protocol/channels/ipc/
  proxy-channel/remote/中间件等）是内部实现，跨模块 deep import 会被 architecture
  checker 以 `deep-import` 拒绝。
- 全仓 77 处消费均使用包根 specifier `@acode/rpc`（纳管前扫描确认零 deep import）。
- `examples/` 与 `test/` 在模块根（packages/rpc/src）之外，不参与架构检查。

## Dependency direction

- 允许：无 workspace 依赖（requires: []）。本模块是传输基座，只使用 TypeScript
  标准库（无 node: 内置模块导入，浏览器与 Node 双侧可用）。
- 禁止：rpc 依赖任何业务模块；任何模块反向依赖 rpc 内部文件。
- 层：单层 `app`（`layers: { app: "." }`，harness-sdk 同款形态）——传输实现直接
  持有 socket/MessagePort/timer，声明 domain 层会触发 domain-io。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：rpc 在 managed 语义下
   零违规（max-file-lines 严格、max-contract-lines、max-public-methods、
   forbidCycles、deep-import、disable-count）；纳管前无超限文件、无 lint disable，
   不新增例外，`.architecture-baseline.json` 不动。
2. `node scripts/architecture/architecture-check.mjs context rpc` 展示 owner
   `rpc-transport`、module.ts 与 contract.ts。
3. `pnpm --filter @acode/rpc test` 全绿；包根导出面（index.ts）与纳管前逐名一致。
4. `tsc -b packages/rpc`（根 `pnpm typecheck` 名单内）通过；`contract.example.ts`
   随包工程一起编译（无 IO，仅编译与文档验证）。
