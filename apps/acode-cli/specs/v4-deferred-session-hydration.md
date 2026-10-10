# v4 deferred 会话的水合与序列基线

状态：已实施（2026-10-11，「任务对话被吞」0.0.7 自动更新后事故修复）。
守护测试：`apps/acode-cli/tests/v4-deferred-live-session-repro.test.mjs`（网关级回归）、
`apps/acode-cli/tests/subagent-list-live-session.test.mjs`（listSessionSubagents 语义）。

## 事实与规则

- 桌面新建任务采用 deferred 持久化：渲染端先 `session/create`（persistence=deferred，仅内存
  record），订阅 conversation topic，首条 sendText 才把 session shell 写入 `SessionStore`
  （`runtime-session-persistence-owner.md`）。**「live 但未持久化」是每个新任务的必经状态，
  不是异常态。**
- v4 hydrate（`ConversationV4Gateway.performHydration` → host `loadPersistedEvents`）的契约：
  - 已持久化会话：返回持久事件 + `sourceEventSeq`（内存 eventStore 水位）；
  - live 但未持久化的会话：**必须**返回内存事件 + 内存水位，`synthesized=false`；
  - 真正失败（存储损坏等）才允许 reject。
- `loadPersistedEvents` 一旦 reject，gateway 的 catch 会退回
  `{events:[], synthesized:false, sourceEventSeq:0}` 并**重置** `rawSequenceStates`。
  runtime 事件从 raw seq ≥3 开始（seq 1-2 是 v4 sink 不转发的 runtime 内部事件）时，
  `normalizeRuntimeEventSequence` 的连续 drain 永远等不到缺失的低序号，**所有后续 live
  事件永久滞留 `pendingByRawSeq`**——conversation 与 sessions-index（fanOutToIndex 位于
  ingestNormalizedEvent 内）双通道同时静默失声。
- `listSessionSubagents` 被 hydrate 复用为子代理种子读取。**live record 存在而持久行缺失时
  必须返回空列表**（warn 留痕），不得抛 `Session not found`；只有既无 live record 也无
  持久行（task index 残留无效 ID）才保留错误。会话「存在性」的事实源是
  `context.sessions ∪ SessionStore`，持久层单侧缺失不是 not-found。

## 事故链（2026-10-11 04:52，实证于 ~/.acode 日志与 db）

新建任务 → 订阅 → hydrate 走 `listSessionSubagents` 抛 "Session not found" → 序列基线清零
→ 首轮 turn 事件全部滞留 → 会话 pane 全空（被吞）+ 任务索引零增量（侧栏内存态、重启即失）。
同一机制在 0.0.6 已潜在（zoode 会话 04:17 同样报错但低序号恰好补齐），0.0.7 事件前缀变长
后成为确定性故障。

## 验收

1. live+deferred 会话：订阅后从 raw seq 3 开始灌事件，conversation delta 帧正常投递。
2. 同场景下 sessions-index 订阅者收到 `session.upserted`（fanOutToIndex 恢复）。
3. `listSessionSubagents`：有 live record 无持久行 → 返回空结果不抛错（warn 留痕）；
   两边都没有 → 仍抛 `Session not found`（保留无效 ID 诊断）。
4. 已持久化会话 resume 形态（sourceEventSeq 水位正确）行为不变。
