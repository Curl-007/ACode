# taskRealtimeBus：Main 侧 replay 镜像的非权威语义与去重分桶

- 状态：已实施（2026-10-22，`docs/reviews/2026-10-22/desktop.md` finding #1/#2/#4 落地件）。
- 代码：`packages/desktop/src/main/taskRealtimeBus.ts`（Main 侧协调器）。
- 关联：`packages/desktop/src/host/taskRealtimeBridge.ts`（Host 侧对端 + 自有 eventId 去重）、
  `packages/shared/src/task-realtime.ts` / `task-realtime-core.ts`（wire 类型与 schema，权威定义）。
- 测试：`packages/desktop/tests/task-realtime-bus-mirror.test.mjs`。

本 spec 是 Main 侧 task realtime 转发态的**前置事实与规则来源**。taskRealtimeBus 是 Main 里最大的
有状态面（lease + 有界 replay 镜像 + command routing）。AGENTS.md 要求「Main 不承载 task/session
业务状态」「relay 只做鉴权/转发/attachment 调度」「desktop-continuous 与 web-remote-replayable 两链路
必须明确区分」——本文把这三条在 Main 侧钉成可查证据。

---

## 1. replay 镜像的非权威语义（finding #2，P2）

### 事实与所有者

`PendingStreamBatch.replay: TaskStreamMirrorBatchEvent[]` 在 Main 内存缓存最近的流事件批次，供新注册
的 Host/observer（`registerHost` / `updateHostWorkspaceKeys`）补齐尚未看到的流片段。它是**转发加速
镜像，不是事实源**：

- **权威快照永远在 Host/CLI。** 镜像只减少 observer 首帧等待，不承担「谁是最新状态」的裁决。
- **镜像有界。** `rememberReplayBatch` 施加双阈值：批次数 `STREAM_MIRROR_MAX_REPLAY_BATCHES`（60）与
  总字节 `STREAM_MIRROR_MAX_REPLAY_BYTES`（512KB），任一超限即 `shift()` 丢弃最旧批。
- **超限即失效并降级。** `replayVisibleRunsToHost` 检测到 `replayUnavailable`、`replay` 为空、或
  `replay[0].fromSeq !== 1`（因丢弃最旧批产生缺口）时，发 `stream_mirror_gap` → snapshot invalidation，
  让 observer 回到 Host/CLI 的权威快照补齐，而不是用残缺镜像渲染。
- **不落盘。** 镜像只活在 Main 进程内存；进程退出即消失，无任何持久化。

### 不变量（review 验收项）

1. **Main 侧不得新增 task/session 快照落盘。** 任何把 lease/replay 当成事实源、向磁盘或常驻存储扩展
   的改动，在 review 中被拒。taskRealtimeBus 只持有内存转发态。
2. **`streamBatches` 在 run 结束的所有路径都被清理**，防内存泄漏：
   - terminal event（`task_complete` / `task_error`）：`flushBatch` 在 `event.terminal` 分支删批。
   - oversized batch 降级：`deliverOversizedStreamBatchFallback` 在 `event.terminal` 分支删批。
   - lease 释放（`releaseLease`）：**无条件** `discardStreamBatch`（清定时器 + 删 Map 条目）。
   - host 退出（`releaseLeasesForHost`，经 `unregisterHost` :200 路径）：**无条件** `discardStreamBatch`。
     此前只依赖 flushBatch 在 terminal 时删批；host 异常退出（非 terminal、或已无 pendingOps 早退）
     会让 replay 镜像残留泄漏——现改为无条件回收。

### 事件顺序（所有者与清理时机）

```text
Host(CLI) 权威事实 ──publish/stream_op──▶ Main taskRealtimeBus（内存转发态，非真源）
                                              │
                    ┌─────────────────────────┼──────────────────────────┐
                    ▼                         ▼                          ▼
              lease（归属裁决）        streamBatches.replay（有界镜像）   command routing
                    │                         │                          │
     terminal / release / hostExit ───────────┴──────────────────────────┘
                    │                         │
                    ▼                         ▼
            leases.delete            discardStreamBatch（无条件）
                                     + discardSeenEventBucket*（finding #4）
                    │
                    ▼（observer 补齐失败时）
        stream_mirror_gap → snapshot invalidation → observer 回 Host/CLI 权威快照
```

---

## 2. 两条交付链路在 Main 侧的区分（finding #1，P2）

### 事实

`TaskRealtimeHostDeliveryKind = "desktop_window" | "relay_bridge"`（`packages/shared/src/task-realtime.ts:78`）
是 shared 定义的枚举，**权威在 shared，不在本包**。

### 规则（Main 侧只实现 desktop_window）

- desktop 全仓 `registerHost` 的 `deliveryKind` 恒为 `desktop_window`（`registerHost` 的 `?? "desktop_window"`
  默认值 + 无调用点传 `relay_bridge`，rg 全仓复核命中 0 个 `relay_bridge` 赋值点）。
- Main 侧 `deliveryKind` **仅作诊断/日志字段**（`registerHost` 的 info 日志、`getHostDeliveryKindForTest`），
  全 desktop 无 `deliveryKind === "relay_bridge"` 的分支消费点。
- 手机的 `web-remote-replayable` 恢复链路的真源在 **acode-server-cli**（`server-core/http.ts`，与
  `desktop-continuous` 在 server-cli/host 侧按 clientMode 分流），**刻意不经 Main 的 taskRealtimeBus**，
  复用窗口既有 Host attachment + server-cli 传输（AGENTS.md「不为手机另起 Agent/Local Host/远程会话」）。

### 结论

`relay_bridge` 在 Main 侧是**有意预留的枚举值**，不是未接线的缺陷：两链路的区分在 host/server-cli 侧成立，
Main 侧只承载 `desktop_window` 这一条实时总线。后续维护不得把 `relay_bridge` 当作 Main 侧待补的分支去「接线」——
手机远控的权威不在这里。若真要改动 shared 的枚举定义，归 shared 包所有权，本包不动。

---

## 3. 跨 Host 事件去重：按 task/workspace 分桶（finding #4，P3）

### 现状与根因

去重此前用**全局单队列 LRU**（`seenEventIds` + `seenEventOrder`，固定上限 1000）。并发可见 run 多时，
一个高频 run 的事件会把另一个 run 的 eventId 挤出滑窗，导致后者的重复事件（跨 Host relay 重投）再次被
判定为「没见过」而重复投递给 observer。影响面仅 observer 侧（非 owner 权威路径），最坏是 UI 重复渲染一条
流事件，不致命，但在高并发多 run 下确实发生。

### 修法：分桶

- 每个 task（有 `taskId`）或 workspace（无 `taskId` 的事件，如 `workspace_task_list_invalidated`）持有
  **独立的有界去重窗口**（`seenEventBuckets: Map<bucketKey, { ids, order }>`，桶内上限仍为 `seenEventLimit`）。
  桶间互不挤占，因此高并发多 run 下 observer 不再重复投递。
- 桶 key：`"seen::" + (taskId || workspaceKey)`，前缀避免与其它 Map 的 key 空间冲突。

### 不变量：run 终止时回收桶（防泄漏）

- terminal event：`handleStreamOpPublish` 在 terminal 分支 `discardSeenEventBucketForTask`。
- lease 释放：`releaseLease` 调 `discardSeenEventBucketForTask`。
- host 退出：`releaseLeasesForHost` 调 `discardSeenEventBucketsForHost`（遍历该 host 名下所有已释放 lease）。
- 兜底：`evictSeenEventBucketsIfNeeded` 在新建桶时检查，桶数超过 `MAX_SEEN_EVENT_BUCKETS`（256）按
  Map 插入序淘汰最旧桶，防止生命周期钩子未覆盖的历史 run 让桶数无界增长。
- `discardSeenEventBucketForTask` 删 taskId 桶；workspace 桶只在**该 workspace 再无 lease** 时才删，避免误删
  同 workspace 其它 run 仍需的桶。

### 验收场景

见测试文件：terminal event 删 streamBatch、lease 释放删 streamBatch、host 退出删 streamBatch、
超过 60 批后 `replay` 被截断且新 observer 收到 `stream_mirror_gap`、多 run 并发下 observer 无重复流事件、
run 终止后其去重桶被回收。
