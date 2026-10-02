# RPC 帧解析加固（rpc-frame-hardening）

## 背景

ChannelServer 对客户端送来的任意帧零容错：`packages/rpc/src/channelServer.ts` 的 message handler 直接消费
`deserialize()` 结果，首字节为 `0x00`（Undefined 类型标记）时 header 为 undefined，`header[0]` 抛 TypeError，
且异常沿 ws message listener 上抛为 uncaughtException 崩掉整个 server 进程——一字节帧即可远程崩溃（默认
loopback 场景等于任意网页可崩）。同时反序列化数组分支的长度取自线上数据且无上限（`serialization.ts`
`readIntVQL` 无界），小帧声明超长数组可造成 CPU/内存 DoS。`Emitter.fire` 不隔离 listener 异常，进一步放大
单帧致崩面。

## 产品规则

1. **畸形帧不致命**：`deserialize` 抛错或返回结构不完整的帧一律丢弃并记 `warn`（截断 payload 摘要，不含敏感
   内容），连接保持存活；server 进程不得因任何单帧崩溃。
2. **长度上界按已读字节推导**：数组/集合等变长结构的声明长度必须满足「剩余已读字节 ≥ 每元素最小编码」，超界
   立即抛可识别的 `FrameDecodeError` 并按规则 1 丢弃；不做无界预分配。
3. **listener 异常隔离**：`Emitter.fire` 对单个 listener 的异常 catch 后记 `warn` 并继续通知其余 listener，
   不上抛为 uncaughtException。
4. **与既有语义零冲突**：合法帧的解码结果、事件顺序、RPC 请求/响应协议不变；丢弃只发生在本就非法的帧上。

## 状态所有者

- 帧合法性判定唯一所有者：`packages/rpc/src/serialization.ts` 的 decode 路径（新增 `FrameDecodeError` 导出）。
- 丢弃与日志决策唯一所有者：`packages/rpc/src/channelServer.ts` 的 message handler（唯一 catch 点）。
- listener 隔离唯一所有者：`packages/rpc/src/foundation.ts` 的 `Emitter.fire`。

## 验收场景

1. 一字节 `0x00` 帧发送到 ChannelServer：连接存活、记 warn、server 进程不崩；后续合法 RPC 正常。
2. 声明长度超界的压缩数组小帧（如声明 2^30 元素、实读几十字节）：抛 `FrameDecodeError`，帧被丢弃，进程不崩、
   不发生大数组分配。
3. 抛异常的 listener 注册到某事件后 fire：其余 listener 仍被调用，进程不崩，记 warn。
4. 回归：既有 rpc 单测与合法帧路径全部通过。

测试遵循仓库既有风格：仅内存/进程内 fixture，不监听公网。
