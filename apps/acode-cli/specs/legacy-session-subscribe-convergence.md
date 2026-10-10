# Legacy `session/subscribe` 收敛契约

状态：M2 调查完成，迁移被协议语义阻塞（2026-10-09）。

## 当前两条 delivery

`packages/services/src/acode-agent/acodeAgentService.ts` 的
`onDynamicSessionEvent` 仍通过 legacy `session/subscribe` 建立 replay 缺口。该入口返回
`{ sessionId, eventSeq, events, snapshot? }`，并把历史事件按 event sequence 交付给单个
订阅者；live 事件另外从共享 emitter 进入。旧入口没有 unsubscribe RPC，也没有
connection/subscription ownership。

v4 `v4/conversation/subscribe` 的契约不同：请求使用
`topic + {logEpoch, seq} + connectionId + clientMode`，响应严格只有 ACK；首帧或续传帧
在 ACK 之后作为由 subscription owner 管理的 `v4/conversation/frame` notification 发送。
`desktop-continuous` 与 `web-remote-replayable` 共用这条时序，profile 只影响调度和恢复
策略。

## 为什么本批不直接替换

1. legacy `eventSeq` 与 v4 `logEpoch/seq` 属于两个不同的水位域，不能用字段重命名伪造
   连续性。v4 的 base 无法证明 legacy event replay 的缺口已经补齐。
2. legacy `events` 同时承载 `session.event`、`state.updated`、permission/user-input
   旁路和可选 snapshot；v4 frame 是 rows/deltas/state patch，必须经过 projection mapper，
   不能把 row 直接 cast 成 `ACodeSessionEvent`。
3. legacy 订阅没有取消所有权；v4 必须保存 `(topic, connectionId, subscriptionId)`，并在
   断线、进程换代和重订阅时执行 owner/lease 清理。直接复用旧 disposable 会留下 stale
   subscription 或重复投递。

## 已落地的契约守护

`packages/shared/tests/protocol-boundary.test.mjs` 固定了两种 delivery 的边界：

- legacy `desktop-continuous` / `web-remote-replayable` 参数仍按旧 schema 校验；
- v4 desktop / web 参数都必须携带 topic、connectionId 和可信 clientMode；
- v4 subscribe ACK 拒绝 legacy `events` / `eventSeq` 字段，legacy result 也拒绝 v4 ACK。

该测试是双 delivery 的 schema 级回归，防止迁移期间把 ACK、历史 replay 和 live frame
混在同一响应中。

## 下一批安全迁移入口

先新增一个只读 projection adapter：把完整 v4 snapshot/delta 归约成旧
`ACodeAgentServiceEvent`，并为每个 workspace 维护 `(logEpoch, seq)` 到 legacy eventSeq 的
显式映射；adapter 必须同时覆盖桌面 continuous 与远程 replayable，并提供 owner 清理、
进程换代和 stale-run fencing 测试。adapter 与双链路 E2E 通过后，才能删除
`acodeProtocolMethods.sessionSubscribe` 调用。
