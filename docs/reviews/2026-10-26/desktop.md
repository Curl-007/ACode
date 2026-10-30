# ACode 1.0.4 深度 Review · desktop 进程边界

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复声称逐条核验；未启动 Electron、未跑 e2e:smoke。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/desktop/**` —— Main/Host/Renderer 进程边界、IPC 安全、stdio、replay mirror、两条交付链路、清理闭环。

---

## 1. 改动面

自上轮基线 `ebe9033b`，`packages/desktop/src/main` 仅 **2 个文件**变更：`desktopWindowChrome.ts`（+9）与 `taskRealtimeBus.ts`（+148/−14），均来自修复提交 `471fe69c`。`desktopRemoteSessions.ts`、`desktopHostProcess.ts`、`index.ts` **未触碰**。其余 desktop 提交为 `electron-builder.config.js`（发布 zip）与文档，无 main 进程表面变更。

## 2. 上轮修复回归核对

| 上轮 finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **[P2] replay mirror 泄漏**：host 非 terminal 退出时 `releaseLeasesForHost` 残留镜像，仅靠 flushBatch 在 terminal 删批 | lease 释放与 host 退出路径无条件 `discardStreamBatch` + 去重桶回收；spec `task-realtime-bus-mirror.md`；6 测 | **HOLDS** | `taskRealtimeBus.ts:420`（releaseLease）、`:442`（releaseLeasesForHost）、`:452-462`（discardStreamBatch 清定时器+删条目）；spec 不变量「Main 侧不得新增 task/session 快照落盘」`task-realtime-bus-mirror.md:34`；bus 内 grep 无任何 fs/persist 调用；测试 `task-realtime-bus-mirror.test.mjs:123-140` 断言非 terminal host 退出后 streamBatches→0 |
| **[P3] 主窗 sandbox 隐式依赖 Electron 默认** | `desktopWindowChrome.ts` 显式 `sandbox:true` | **HOLDS** | `desktopWindowChrome.ts:603`（连同 `contextIsolation:true`、`nodeIntegration:false` 显式化）；依据 `electron-hardening.md:43-73`。全仓仅有的两处 `sandbox:false` 是 e2e 测试脚手架（`scripts/e2e-network-capture-auth.mjs:281` 是故意构造的「攻击者窗口」证明 sender 门控拒绝非 RM origin），非出货窗口 |
| **[P2] relay_bridge 死枚举** | 保留枚举 + 注释指向 server-cli 真源 | **HOLDS（有意预留，已成文）** | `shared/src/task-realtime.ts:78` + `task-realtime-core.ts:101` 仍为 `desktop_window \| relay_bridge`；desktop 侧无赋值/消费（grep 仅注释+spec）；`taskRealtimeBus.ts:195-201` 注释与 spec §2 明确其为预留枚举、真源在 acode-server-cli、禁止未来在 Main 侧接线。desktop 注释与 shared 定义一致 |
| **[P3] 去重全局单队列 LRU(1000)** | 按 task/workspace 分桶 + 256 桶上限 | **HOLDS（有界）** | `seenEventBuckets: Map` `:157`；每桶独立窗口 `:1158`；`MAX_SEEN_EVENT_BUCKETS=256` `:50` + LRU 驱逐 `:1169-1177`。无无界增长路径 |
| **总体：Main 不承载业务状态 / 无违规 Remote Host / IPC 面干净 / 清理闭环** | — | **HOLDS** | 远程会话经 `windowHostProcessMap.get()` 复用窗口 Local Host（`desktopRemoteSessions.ts:134,306,441,679,722,766,798` 共 7 处），该文件零 `spawnHostProcess`；新增 `collectMemoryDiagnostics`（`:400`，含 seenEventBuckets 只读尺寸）仅测试调用，非新 IPC 面；host 消息仍 schema 门控（`handleHostMessage` `:270` → `hostResponseMessageSchema.safeParse`） |

## 3. 本轮新发现

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | 单个 `releaseLease` 永不回收 **workspace 级**去重桶（语句顺序缺陷） | `taskRealtimeBus.ts:421-422` | `releaseLease` 在 `:421` 先调 `discardSeenEventBucketForTask(...)`，`:422` 才 `this.leases.delete(key)`。该 helper（`:1180-1195`）内 taskId 桶总是删除，但 workspace 桶只在「无任何 lease 使用该 workspaceKey」时删——检查时被释放的 lease 仍在 map 里，`stillUsed` 恒 true → workspace 桶保留。对照：terminal 路径（`:481-484`）与 host 退出路径（循环内先 `:443` delete、循环后 `:447` 统一回收）都是先删 lease，能正确回收。影响有界且良性：workspace 桶只存无 taskId 事件（如 `workspace_task_list_invalidated`）的 eventId，多保留不影响去重正确性（eventId 唯一），256 桶 LRU 最终驱逐；但与 spec 明文意图相悖（`task-realtime-bus-mirror.md:113`「workspace 桶只在该 workspace 再无 lease 时才回收」）。无测试覆盖单释放路径的 workspace 桶回收（terminal 测试 `.test.mjs:217` 只用 taskId 级事件）。**主审已亲验源码行号与执行顺序** | CONFIRMED |

无其他新问题：无新增 IPC handler、webPreferences 无回归（sandbox 反而收紧）、stdio/host 消息处理未变、Main 未新增业务状态。

## 4. 两条交付链路语义分离

**清晰且已成文。** `desktop-continuous`（可信 host 中继、全量流）与 `web-remote-replayable`（终端客户端、收窄面）的分叉在 **host/server-cli** 层，不在 Main——手机远控恢复路径有意绕开 Main 的 `taskRealtimeBus`，复用窗口既有 Host attachment + server-cli 传输。Main 的 bus 只注册 `desktop_window`；`relay_bridge` 是未接线但已成文的预留枚举（spec §2 禁止未来维护者在 Main 侧接线）。镜像批投递进一步区分 owner（`relay_owner`）与 observer 用途（`:786`），oversized 批降级路径（`:597-619`）保 owner seq 连续性、observer 转权威快照——continuous 与 replayable 的区分在 bus 内部同样被尊重。

## 5. 层面健康度

**优**（全仓最佳进程边界层）。Main 仍零 task/session 业务状态、无违规 Desktop Remote Host、IPC 面干净（schema 门控 host 消息、sender 绑定窗口、诊断仅测试用）、清理闭环完整且被 1.0.4 修复**加强**——非 terminal host 退出的真实镜像泄漏已闭合，去重结构已有界。仅 1 个新 P3（workspace 桶回收顺序），有界且不影响正确性。无 P1/P2。
