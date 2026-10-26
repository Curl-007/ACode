# Overnight（K3）完成通知 → 角标 → 点击直达：桌面出口

- 状态：桌面出口已实施（Main 侧 seam + 通知/点击链路）；**触发信号跨包接线为「拟议」**（见 §7）。
- 代码：`packages/desktop/src/main/overnightCompletionNotify.ts`（本项新增）、
  `packages/desktop/src/main/desktopNotifications.ts`（抽出共享呈现核 `presentTaskNotification`）。
- 关联：`apps/acode-cli/specs/overnight-execution.md`（K3 引擎，红线「不接通知渠道，完成通知走既有 UI 通知面」:22-23）、
  `docs/desktop-evolution-analysis-2026-10-26.md` §5.1（本项立项来源）、
  `packages/desktop/specs/task-realtime-bus-mirror.md`（Main 非权威不变量）。
- 测试：`packages/desktop/tests/overnight-completion-notify.test.mjs`。

---

## 1. 立项与裁决：复用既有通知面，不新建平行链路

### 1.1 调查结论（带 file:line 证据）

K3 引擎已完整实施，但其完成事件**当前不跨进程**，桌面侧无从观测：

1. **引擎事件面**：supervisor 在终态 emit `overnight.completed` / `overnight.failed`
   （`apps/acode-cli/packages/core/src/overnight/supervisor.ts:50-51`、`:234`、`:241`、`:269`）。
2. **接线层只落日志**：bootstrap 的 `onEvent` 订阅这些事件，但**只调 `createServiceLogger`**，
   不经任何协议/host 通道外发（`apps/acode-cli/packages/bootstrap/src/app/overnight-controller.ts:274-308`）。
3. **coordinator 是隐藏 fork 子会话**：经 `runtime.forkWorkspaceFromCheckpoint` fork，
   `taskType: "fork"`、`hidden: true`（`overnight-controller.ts:161`、`:172-181`；
   `apps/acode-cli/packages/core/src/overnight/coordinator.ts:36-37`）。
4. **子会话事件走 detached live 路由，但不进 live sessions-index**：子 runtime 的 `eventSink`
   → `notifyExternalChildSessionEvent`（`apps/acode-cli/packages/cli-workflow/src/script-workflow-child-runtime.ts:183-190`）
   → bootstrap `ingestDetachedLiveSession`（`apps/acode-cli/packages/bootstrap/src/acode-protocol/server-operations.ts:2996-3006`）。
   但该子会话**没有 `context.sessions` 记录**（它在 core 内经 `sessionStore.createSession` 落盘，
   未经 bootstrap `registerForkedSession`），故 `getSessionWorkspaceId(childSessionId)` 返回 `null`
   （`apps/acode-cli/packages/bootstrap/src/acode-protocol/v4-bridge.ts:1480-1485`），
   `publishCurrentSummaryToIndex` 直接 no-op（`v4-gateway.ts:1103-1124`）——**live 完成边沿不 fan-out 到 sessions-index**。
5. **既有终态通知路径因此不触发**：`useWorkspaceTerminalTaskNotifications` 只在 sessions-index 的
   **live 终态边沿**（`previous.phase` 非终态 → 终态）发通知（`packages/ui/src/hooks/useTaskNotifications.ts:165-191`、
   `packages/ui/src/lib/taskNotificationOrchestrator.ts:59-78`）。coordinator 不 live fan-out，且冷启动种子
   把它投影成静态 `completedSuccess`（`v4-bridge.ts:1343-1354`）被首帧基线抑制——**此路不通**。
6. **全仓 `packages/` 无 overnight 运行时信号**：对 `packages/**` grep `overnight|morning_report|handoff_ready`
   只命中 slash 帮助文案与 git 注释（`packages/shared/src/acode-slash-command-help.ts`、`git-invocation-env.ts`），
   **无协议事件、无 service 面、无 shared 类型**把 overnight 状态送到桌面 renderer 或 Main。

### 1.2 裁决：复用 `showTaskNotification` 呈现核 + `onTaskNotificationClick` 点击核

**复用，不新建平行链路。** 依据：

- K3 spec 红线明文：「不接通知渠道（完成通知走**既有 UI 通知面**）」（`overnight-execution.md:22-23`）——
  语义上就要求复用，而非另立。
- 既有 `dispatchTaskNotification`（`packages/desktop/src/main/desktopNotifications.ts:83-158`）已具备本出口
  需要的**全部原语**：`Notification.isSupported()` 能力闸（:94）、`isAnyAppWindowFocused()` 焦点闸（:99，
  Main 侧焦点判定，非 renderer `document.hasFocus()`）、缺文案拒绝（:106）、去重（:118）、
  retain 防 GC + 点击聚焦 + `TaskNotificationClick` 路由（:132-150）。新建第二套会复制这些原语、
  制造第二个去重存储与潜在第二个角标计数器——违反 AGENTS.md「避免重复状态和多条写入路径」。
- 点击直达复用既有 renderer `onTaskNotificationClick`（`packages/ui/src/root/useRootPlatformEffects.ts:161-184`）：
  按 taskId 在 `taskListCache` 反查 → 激活 tab + `setActiveTaskId`，零 renderer 改动。

**本项新增的只是「Main 侧 seam + overnight 专属幂等 + Main 侧本地化文案」**，呈现/点击/角标全部复用既有单写者路径。

### 1.3 为什么 seam 落在 Main 侧（而非 renderer）

- 立项来源 §5.1 点名 `desktopCronScheduler.ts`（Main 侧）为先例；cron/off-peak 结果本就走 host→Main
  （`desktopCronScheduler.ts:22-39`、`:57-60`）。
- overnight 的典型场景是 **App 最小化/后台**，此时 renderer 可能被系统节流/挂起，而 **Main 常驻**——
  Main 侧触发更可靠，正是「挂机完成时用户在别处」的诉求。
- Main 持有瞬时完成信号以弹通知**不构成业务状态权威**：与既有 `dispatchTaskNotification` 同性质
  （转发/呈现，不落盘、不裁决），符合 `task-realtime-bus-mirror.md` §1「Main 侧不得新增 task/session 快照落盘」。

---

## 2. 状态所有权

| 状态                                       | 所有者                                                                                  | 生命周期         | 说明                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OvernightManifest / phase / 完成事实       | CLI supervisor（`overnight/supervisor.ts`）                                             | run（进程内）    | 唯一权威；桌面**不复制**                                                                                                                                                                   |
| 完成信号（runId/outcome/taskIds）          | 跨包 seam（§7 拟议）                                                                    | 单次投递         | Main 只消费不裁决                                                                                                                                                                          |
| 「本 runId 是否已通知」幂等集              | `overnightCompletionNotify.ts` 内有界 Set                                               | 进程内，上限淘汰 | 转发去重态，非快照、非权威（类比 `desktopNotifications.ts:8` 的 `recentTaskNotificationTimestamps`、realtime bus 的 `seenEventBuckets`）                                                   |
| 通知文案（title/body）                     | `overnightCompletionNotify.ts` 内 Main 侧本地化表                                       | 静态             | Main 无 renderer i18n 上下文；native 通知文案归 Main，与 `packages/shared/src/desktopMenu.ts` 的 `getDesktopMenuMessage(locale,id)` 同族（不同呈现面：native OS 通知 vs React UI），非重复 |
| 未读角标计数（`unreadAt`/总数）            | **renderer store**（`packages/ui/src/lib/unreadTaskCount.ts:10` `countAllUnreadTasks`） | 会话期           | 单写者；经 `syncWindowUnreadCount` 推给 Main                                                                                                                                               |
| 应用角标（`app.setBadgeCount`，mac/linux） | Main `windowUnreadCountMap` 镜像（`desktopWindowLifecycle.ts:331-364`）                 | 进程内           | **镜像**，非第二计数器；求和自 renderer 推送                                                                                                                                               |

**不变量**：本项**不新增任何角标计数器**。数值角标严格走 renderer 单写者 → `syncWindowUnreadCount` →
Main 镜像求和 → `syncApplicationUnreadBadge`。Main 侧 overnight 模块只弹通知与路由点击，不碰计数。

---

## 3. 事件顺序（通知 → 角标 → 点击直达）

```text
CLI supervisor: emit overnight.completed/failed        [权威事实，进程内]
   └─(§7 拟议跨包 seam：host→Main 投递 OvernightCompletionSignal)─▶
Main: handleOvernightCompletionNotification(signal, targetWindow, logger, getLocale)
   1. runId 幂等闸：notifiedOvernightRuns 已含 runId → return false（一个 run 至多一条，永不重发）
   2. 解析 Main 侧本地化文案（outcome × morningReportReady → title/body）
   3. 构造 TaskNotificationPayload{ taskId = parentTaskId, status, title, body }
   4. presentTaskNotification（与 IPC 路径同一核）：
        a. Notification.isSupported() == false → warn + return false（降级 no-op，不抛错）
        b. isAnyAppWindowFocused() == true     → return false（焦点时不打扰；用户在 App 内自会看到）
        c. 空 title/body                        → warn + return false（守既有纪律）
        d. 3s status:taskId 去重（既有通用防抖，runId 闸之外的二级保护）
        e. new Notification + retain（防点击前被 GC）
        f. click → focus 窗口 + webContents.send(TaskNotificationClick, parentTaskId)
        g. show + TaskNotificationSound
   5. 记 runId 入幂等集
                                            │
   （点击）TaskNotificationClick(parentTaskId) ─▶ renderer onTaskNotificationClick
                                                  （useRootPlatformEffects.ts:161-184）
                                                  → taskListCache 反查 parentTaskId
                                                  → activateTabByPath + setActiveTaskId（直达发起 /overnight 的会话）

角标（独立、既有单写者路径，本项不改）：
   coordinator/parent 任务在 renderer 标 unreadAt → countAllUnreadTasks → syncWindowUnreadCount
   → Main windowUnreadCountMap 镜像 → syncApplicationUnreadBadge（mac/linux setBadgeCount）
```

**点击目标裁决**：路由到 **parentTaskId**（发起 `/overnight` 的可见会话），而非 coordinatorTaskId。
理由：coordinator 是 fork 子会话，**live 期不在** `taskListCache`（§1.1 证据 4/5——无 `context.sessions`
记录故不 live fan-out），`onTaskNotificationClick` 反查会落「task not found」而导航失败；parentTaskId
必然在列表中，复用既有 handler 零改动即可直达发起会话（用户由此进入任务卡/晨报上下文）。

> **调查副产物（如实登记，非本项修复范围）**：coordinator 以 `taskType: "fork"` 落盘
> （`overnight-controller.ts:180`），而 `"fork"` ∈ `TASK_LIST_SESSION_TYPES`
> （`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/task-list-session-membership.ts:10-14`）；
> fork 请求携带的 `hidden: true`（`core/src/overnight/coordinator.ts:37`）**未被 bootstrap fork 绑定消费**
> （`overnight-controller.ts:155-206` 只读 `request.targetMessageId`，从不读 `request.hidden`）。
> 后果：coordinator **live 期**因无 record 不进 live sessions-index（不触发既有终态通知，§1.1 证据 4/5 成立），
> 但 **CLI 重启后**会被冷启动种子（`v4-bridge.ts:1334-1354`，`taskTypes: TASK_LIST_SESSION_TYPES`）投影进
> sessions-index，以「Fork of X」条目出现在侧栏列表——即 K3 spec「隐藏 coordinator」的语义在**重启后并未成立**。
> 这是 K3 引擎侧（bootstrap/core）的既存缺陷，非本桌面出口引入；本项点击目标选 parentTaskId 恰好绕开该不确定性。
> 修复归属 `apps/acode-cli/packages/bootstrap/**`（他包所有，本项不改），登记为跨包发现项（§7.6）。

---

## 4. 去重与幂等

- **一个 run 至多一条通知**：`notifiedOvernightRuns: Set<runId>`，命中即 `return false`。
  这是比既有 3s 时间窗**更强**的幂等——overnight 完成是「每 run 一次」事件，即使两次投递相隔 >3s
  也不得重发。集合有界（`MAX_NOTIFIED_OVERNIGHT_RUNS`，超限按插入序淘汰最旧），防无界增长。
- **既有 3s status:taskId 去重**（`presentTaskNotification` 内）作为二级防抖保留，不改其语义。
- **已出卡不重复打扰**：焦点闸（§5）保证用户在 App 内（已能看到任务卡/晨报）时不弹系统通知；
  runId 幂等保证同一完成不因 host 重投/多窗口而多发。
- **非权威**：幂等集只答「这个 runId 我通知过没有」，不存 phase/manifest/快照，不落盘，进程退出即消失
  ——与 `task-realtime-bus-mirror.md` §1 不变量一致。

---

## 5. 焦点 / 最小化 / 隐藏到托盘 的行为

| 窗口状态                            | 行为                                                                   | 依据                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 任一 App 窗口聚焦                   | **不弹**（`return false`）                                             | `isAnyAppWindowFocused()`（`desktopNotifications.ts:11-15`、`:99`）；用户在 App 内自会看到任务卡 |
| 最小化                              | 弹通知；点击 `restore()` + `focus()`                                   | `focusTaskNotificationWindow`（`desktopNotifications.ts:63-81`）                                 |
| 隐藏到托盘（Windows close-to-tray） | 弹通知；点击 `show()` + `focus()`                                      | 同上（`!isVisible() → show()`）                                                                  |
| macOS 隐藏/Dock                     | 弹通知；点击 `dock.show()`+`app.show()`+`app.focus({steal})`+`focus()` | 同上（darwin 分支，既有注释说明顺序原因）                                                        |

焦点判定在 **Main 侧**（`BrowserWindow.getAllWindows().some(isFocused)`），非 renderer `document.hasFocus()`——
与既有 `dispatchTaskNotification` 同纪律（renderer 可能挂起，Main 判定更可靠）。

---

## 6. 跨平台差异与降级

- **能力闸**：`Notification.isSupported()` 为假（如部分 Linux 无 notification daemon）→ warn + `return false`，
  **不抛错、不崩溃**（守既有 `desktopNotifications.ts:94-97` 纪律）。这是「通知不可用」的降级 no-op 路径。
- **数值角标**：`app.setBadgeCount` 仅 mac/linux 生效（`unreadBadge.ts:21-23` `supportsAppUnreadBadge`）；
  Windows 无 dock badge。Windows 的「托盘角标」需 `Tray.setOverlayIcon`（原生 overlay 图标生成），
  属**拟议**（§7）——需离屏绘制数字图标，headless 不可验证，本项不实现，避免引入未验证的原生图像代码。
- **文案本地化**：Main 侧表覆盖 `zh-CN`/`en-US`（`Locale` 全集，`packages/shared/src/protocol.ts:82`）；
  locale 取自 Main `currentApplicationLocale`（`index.ts:350`，与 tray/menu 同源）。
- **声音**：复用既有 `TaskNotificationSound`（renderer 侧播放），跨平台一致。

---

## 7. 拟议（跨包，未由本项实施——报主审裁决）

**触发信号缺口**：overnight 完成事件当前止于 CLI 进程内日志（§1.1 证据 2），无任何通道把它送到 Main。
本项已建成 Main 侧 seam（`handleOvernightCompletionNotification`）并以注入假信号完整测试，但**真实接线需跨包改动**，
按任务红线「需要改他包就停下报精确 diff，不自行改」，登记如下（未实施）：

1. **shared 协议**（`packages/shared/src/**`，他包所有）：新增 host→main 消息类型
   `OvernightCompletionNotify`，载荷 `{ runId, coordinatorTaskId, parentTaskId, outcome: "completed"|"failed"|"cancelled", morningReportReady: boolean }`
   （进 `HostMessageTypes` + `hostIncomingMessageSchema`）。
2. **bootstrap 接线**（`apps/acode-cli/packages/bootstrap/src/app/overnight-controller.ts:274-308`，他包所有）：
   在 `onEvent` 的 `overnight.completed`/`overnight.failed` 分支，除既有日志外，经 host 的 realtime/控制通道
   向 Main 投递上述信号（需 host 暴露一个 emit 口；agent→host 边界在 `packages/desktop/src/host/**`，本包所有，
   但 agent 侧发射点在 bootstrap，非本包）。
3. **host→Main 路由**（`packages/desktop/src/host/**` + `packages/desktop/src/main/index.ts`，本包所有）：
   host 收到 agent 信号 → `postMessage` 给 Main → Main 解析出 targetWindow（跑该 host 的窗口）→
   调 `handleOvernightCompletionNotification`。**本段属本包，待 §7.1/§7.2 的协议与发射点就位后即可接，无需再动他包。**
4. **（可选）Windows 托盘 overlay 角标**：`desktopTray.ts` 增 `setOverlayIcon`，读既有 `windowUnreadCountMap`
   求和（**不新建计数器**）；需离屏数字图标生成，单独排期。
5. **（可选）点击直跳晨报卡片**：需 coordinator 可导航或晨报 markdown 有 UI 落点（跨 renderer/services），单独排期。
6. **K3 既存缺陷（非本项引入，登记待裁决）**：coordinator 的 `hidden: true` 未被 fork 绑定消费，
   重启后以「Fork of X」漏进侧栏列表（§3 调查副产物）。修复点在 `apps/acode-cli/packages/bootstrap/src/app/overnight-controller.ts`
   的 `forkCoordinatorTask`（需让 fork 落盘为非 task-list 类型或消费 hidden 标记）——他包所有，本项不改，报主审裁决。

> 在 §7.1–§7.3 落地前，本项的 Main 侧 seam 是**已建成、已测试、但无真实生产者**的出口末端
> （类比 `task-realtime-bus-mirror.md` 对 `relay_bridge`「死值/预留」的诚实登记）。不得声称端到端已通。

---

## 8. 验收场景（编号；测试见 `overnight-completion-notify.test.mjs`）

1. **焦点抑制**：任一窗口聚焦时投递完成信号 → **不弹**通知（`Notification` 构造 0 次）。
2. **非焦点弹出**：无窗口聚焦时投递 → 弹 1 条通知，title/body 为对应 outcome 的本地化文案。
3. **runId 幂等**：同一 runId 连投两次（间隔 > 3s 通用去重窗）→ 仅弹 1 条；不同 runId → 各弹 1 条。
4. **点击直达**：触发 notification `click` → 目标窗口 `focus()` 被调，且 `webContents.send(TaskNotificationClick, parentTaskId)`
   携**正确 parentTaskId**（非 coordinatorTaskId）。
5. **能力降级**：`Notification.isSupported()` 为假 → `return false`，不抛错、不弹、不记幂等（允许后续平台恢复时重试）。
6. **缺文案守卫**：本地化表缺项致空 title/body → `return false`（守既有纪律，不弹空通知）。
7. **locale 解析**：`getLocale()` 返回 `en-US`/`zh-CN` → 文案取对应语言（Main 侧表双locale在场）。
8. **单写者角标不回归**：`unreadBadge.ts` 的 `sumWindowUnreadCounts`/`syncAppUnreadBadge` 对同一窗口
   0→1→0 的计数表现为「增一次、归零回收」，且多窗口求和不重复计同一窗口——钉住本项**未**引入第二计数器。
9. **IPC 既有路径不回归**：重构抽出 `presentTaskNotification` 后，`dispatchTaskNotification` 的
   焦点闸/缺文案拒绝/去重/点击路由行为逐条不变（同文件测试覆盖）。
10. **负向验证**：临时拆除焦点闸（令 `isAnyAppWindowFocused` 恒 false）→ 场景 1 转红；恢复后转绿（证明守卫真实生效）。
