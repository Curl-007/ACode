# RPC 帧解析加固（rpc-frame-hardening）

## 背景

ChannelServer 对客户端送来的任意帧零容错：`packages/rpc/src/channelServer.ts` 的 message handler 直接消费
`deserialize()` 结果，首字节为 `0x00`（Undefined 类型标记）时 header 为 undefined，`header[0]` 抛 TypeError，
且异常沿 ws message listener 上抛为 uncaughtException 崩掉整个 server 进程——一字节帧即可远程崩溃（默认
loopback 场景等于任意网页可崩）。同时反序列化数组分支的长度取自线上数据且无上限（`serialization.ts`
`readIntVQL` 无界），小帧声明超长数组可造成 CPU/内存 DoS。`Emitter.fire` 不隔离 listener 异常，进一步放大
单帧致崩面。

第二轮加固（2026-10 复核确认）：上述规则只覆盖**帧内**反序列化，传输层分帧本身仍无界——
`protocol.ts` `SocketProtocol.readMessages` 直接信任 `header.readUInt32BE(9)` 声明的 payload 长度
（uint32 可声明至 ~4 GiB），整帧未到齐仅 break 等待；`ChunkStream.acceptChunk` 跨多条底层消息无界累积
且无任何超时；`persistent-protocol.ts` `PersistentProtocol.readMessages` 同构无界（其 `ACK_TIMEOUT`
只覆盖 outgoingUnackMsg 发送侧，被动慢速连接永不超时）。`VSBuffer.alloc` 大分配走堆外内存，远端声明
超大帧并慢速滴字节即可让单连接吃掉 GiB 级 RSS（内存耗尽 DoS）。暴露面：`packages/server/src/http.ts`
与 `packages/acode-server-cli/src/server-core/http.ts` 的 WebSocket RPC、`packages/server/src/stdio.ts`
与 `packages/server/src/remote/*` 的 stdio RPC——ws 层 `maxPayload`（100 MiB 默认）只限制单条 ws 消息，
逻辑帧可横跨多条消息，不构成传输帧上限。

## 产品规则

1. **畸形帧不致命**：`deserialize` 抛错或返回结构不完整的帧一律丢弃并记 `warn`（截断 payload 摘要，不含敏感
   内容），连接保持存活；server 进程不得因任何单帧崩溃。
2. **长度上界按已读字节推导**：数组/集合等变长结构的声明长度必须满足「剩余已读字节 ≥ 每元素最小编码」，超界
   立即抛可识别的 `FrameDecodeError` 并按规则 1 丢弃；不做无界预分配。
3. **listener 异常隔离**：`Emitter.fire` 对单个 listener 的异常 catch 后记 `warn` 并继续通知其余 listener，
   不上抛为 uncaughtException。
4. **与既有语义零冲突**：合法帧的解码结果、事件顺序、RPC 请求/响应协议不变；丢弃只发生在本就非法的帧上。
5. **传输帧声明长度硬上限**：header 声明的单帧 payload 长度不得超过
   `TRANSPORT_FRAME_MAX_PAYLOAD_BYTES`（256 MiB，`protocol.ts` 导出的文档化常量）。超限属于传输层帧
   损坏而非可丢弃的单帧——流式传输上无法安全跳过"永远不会到齐的半帧"再同步字节流——处理方式为：记
   `warn`（只含声明长度与上限，不含 payload 内容）、停止解析、`socket.end()` 终结底层连接；消费方
   （server WS/stdio、remote client）既有的 close 驱动清理路径负责后续收口，不新增事件面。
   **阈值调研依据**（2026-10，repo 内全部经 rpc 传输帧的合法大载荷路径）：
   - `IPluginSyncService` 归档上限 50 MiB（`pluginSyncService.ts` `DEFAULT_MAX_ARCHIVE_BYTES`），
     嵌套 Uint8Array 经 serialization 的 base64+JSON 通道 ≈ **67 MiB**（当前最大合法单帧）；
   - `IFileService.readBinaryPreview` 25 MiB 文件 → base64 ≈ 34 MiB（`fileService.ts`
     `MAX_BINARY_PREVIEW_BYTES`，注释明确"以 base64 跨 RPC 返回"）；`readMediaPreview` 8 MiB → ≈ 11 MiB；
     `readFile` 分段 256 KiB（顶层 Uint8Array 原始字节通道）；
   - `getModelTrajectory` 32 MiB 轨迹尾部文本（`modelTrajectoryFileTail.ts`）；
   - `ISkillSyncService` 归档上限 20 MiB → base64 ≈ 27 MiB（`skillSyncService.ts`）；
   - v4 agent 事件：物理帧 1 MiB / 逻辑帧组装上限 16 MiB（`PROTOCOL_V4_LIMITS`）；附件走 512 KiB 分块
     或路径 staging（`promptAttachmentTransfer` 零拷贝，不经 RPC 搬运字节）；feedback 日志归档落盘后
     只回传 path/size。
   最大合法单帧 ≈ 67 MiB，256 MiB 保留约 3.8 倍 headroom。宁大勿小：错杀合法大帧是功能回归，比防护
   不足更糟；同时 256 MiB ≪ uint32 可声明的 ~4 GiB，且 TCP 顺序性保证半帧在缓冲中的滞留字节
   ≤ 13 + 声明长度，声明上限即把单连接组装内存钉死在 ≤ 256 MiB + 13 B。
6. **半帧组装空闲超时**：接收缓冲中存在未完成帧的字节时启动
   `TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS`（30 s，对齐 v4 `logicalFrameAssemblyTimeoutMs`）空闲
   计时，每有新字节到达即重新计时（idle 语义而非绝对截止）；到期仍无进展按规则 5 处理（warn + 断开）。
   **语义与适用范围**：
   - idle 语义保证"慢但持续到达"的合法大帧（如 67 MiB 归档在慢速 WAN 上）不被误杀——只要对端仍在
     推进字节就不超时；绝对截止（v4 的 firstSeenAt 语义）会错杀慢链路大帧，故不采用。慢速滴灌攻击
     者要占住 X 字节内存必须真实发出 X 字节，且滞留量已被规则 5 钉死在 cap 内。
   - 统一适用于 `SocketProtocol` 与 `PersistentProtocol`（socket/stdio 流式传输）。stdio 本地传输
     （desktop ↔ server 子进程）发送端以单次 write 写整帧，帧中间停滞 ≥ 30 s 只可能是对端进程挂死，
     断开是正确行为；watchdog 仅在缓冲存在半帧时武装，纯空闲连接不受影响；Node 定时器基于单调时钟，
     系统休眠恢复不会误触发。
   - `MessagePortProtocol` 天然消息边界、不经 ChunkStream 组装，`createQueuePair` 为内存测试对——两者
     不适用也无需超时。
   - `PersistentProtocol` 的违规断开复用 `onSocketClose` 信号（与 ACK 超时同一路径），消费方
     （`RemoteAgentConnection`）既有重连逻辑不变；`replaceSocket` 重置违规标志与 watchdog，重连后的
     新会话重新受规则 5/6 保护。

## 状态所有者

- 帧合法性判定唯一所有者：`packages/rpc/src/serialization.ts` 的 decode 路径（新增 `FrameDecodeError` 导出）。
- 丢弃与日志决策唯一所有者：`packages/rpc/src/channelServer.ts` 的 message handler（唯一 catch 点）。
- listener 隔离唯一所有者：`packages/rpc/src/foundation.ts` 的 `Emitter.fire`。
- 传输帧合法性（声明长度上限、半帧空闲 watchdog、违规断开）唯一所有者：
  `packages/rpc/src/protocol.ts` 的 `SocketProtocol.readMessages`/`failTransport` 与
  `packages/rpc/src/persistent-protocol.ts` 的 `PersistentProtocol.readMessages`/`failTransport`；
  阈值常量（`TRANSPORT_FRAME_MAX_PAYLOAD_BYTES`、`TRANSPORT_FRAME_ASSEMBLY_IDLE_TIMEOUT_MS`）与
  `TransportFrameError` 在 `packages/rpc/src/transport-frame-limits.ts` 定义并从包入口导出，
  两个读帧点共用，不允许另起第二套阈值。
  `ChunkStream`（`packages/rpc/src/chunk-stream.ts`）保持纯字节缓冲职责，不感知帧语义。

## 验收场景

1. 一字节 `0x00` 帧发送到 ChannelServer：连接存活、记 warn、server 进程不崩；后续合法 RPC 正常。
2. 声明长度超界的压缩数组小帧（如声明 2^30 元素、实读几十字节）：抛 `FrameDecodeError`，帧被丢弃，进程不崩、
   不发生大数组分配。
3. 抛异常的 listener 注册到某事件后 fire：其余 listener 仍被调用，进程不崩，记 warn。
4. 回归：既有 rpc 单测与合法帧路径全部通过。
5. 声明长度 = 上限 + 1 的帧头（13 字节，无需任何 body）到达 `SocketProtocol` / `PersistentProtocol`：
   立即 warn + `socket.end()`，不 fire `onMessage`，不按声明长度分配内存，后续字节被忽略；
   `PersistentProtocol` 侧发出 `onSocketClose` 信号。声明长度 = 上限的合法帧照常投递（边界不误伤）。
6. 半帧（header + 部分 body）无新字节到达超过空闲超时：warn + 断开；期间每有新字节到达即重新计时不断开；
   整帧收齐、缓冲清空后 watchdog 不触发，空闲连接不受影响。
7. `PersistentProtocol` 违规断开后经 `replaceSocket` 重连：合法帧照常投递，新连接重新执行规则 5/6。
8. 集成回归：合法 RPC（ChannelServer/ChannelClient over SocketProtocol）照常；超限声明帧只终结所在连接，
   server 进程存活。

测试遵循仓库既有风格：仅内存/进程内 fixture，不监听公网。
