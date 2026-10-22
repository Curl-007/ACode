# ACode 1.0.3 深度 Review · Desktop（Main / Host / Renderer / IPC）

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查（架构策略、Host 装配、remote session、preload、taskRealtimeBus、退出屏障与 smoke 测试），未改动代码，未运行 Electron GUI。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/desktop`（约 6.5 万行，262 文件）：Main 进程、window-scoped Local Host、Renderer、IPC、进程树、stdio 通信、远程连接注册表。

---

## 1. 层面整体评估

desktop 层的进程边界执行得**相当严谨**，健康度高。Main 严格停在「窗口 + 原生操作 + 进程调度 + 消息转发」，未见 task/session 业务事实落盘或常驻；所有远程连接都复用窗口既有 Local Host（`windowHostProcessMap.get()`），**未发现违规新建 Desktop Remote Host**。Host 用 `utilityProcess.fork` window-scoped 装配，dispose 有防孤儿硬下限、退出屏障并行收口、`processContainment` spawn 台账 + exit 钩子兜底，进程树/临时目录清理闭环完整。IPC 面 contextIsolation 全开、nodeIntegration 全关、sender→window 绑定普遍。最大关注点集中在一处：`taskRealtimeBus.ts`（1083 行）是 Main 侧唯一的大型有状态协调器，持有 lease + 有界 replay mirror + command routing，处于 AGENTS.md「Main 不承载业务状态」与「relay 做 attachment 调度」的**边界灰区**；以及两条交付链路中 `relay_bridge` 在 desktop 侧从未接线。**未发现 P1 级违规或安全漏洞。**

## 2. 问题清单

**[P2] Main 侧 replay mirror 是最接近「快照」的有状态面，需持续盯防非权威边界** — `packages/desktop/src/main/taskRealtimeBus.ts:1,76,747`
- 描述：头注自陈 "owns lease, stream batching, **replay** and command routing state in one main-process coordinator"。`PendingStreamBatch.replay: TaskStreamMirrorBatchEvent[]` 在 Main 内存缓存流事件批次，供新 Host/observer 补齐（`replayVisibleRunsToHost`）。
- 证据/边界：`rememberReplayBatch` 有双阈值上限（60 批 / 512KB，`STREAM_MIRROR_MAX_*`），超限即 `replayUnavailable=true` 并降级为 `stream_mirror_gap` → snapshot invalidation，让 Host 走权威快照补齐。replay **不落盘、非真源、失配即失效**——判定为「有界转发镜像」，基本合规，但它是 Main 里最大的有状态面。
- 建议：在 spec 明确记录 replay mirror 的非权威语义（仅转发加速，权威快照永远在 Host/CLI）；防止后续改动把 lease/replay 当成事实源扩展。
- 验收：任何新增 Main 侧持久化（落盘 task/session 快照）在 review 中被拒；`streamBatches` 在 terminal event 与 host exit 均 delete（已确认 line 528/552/200）。

**[P2] 两条交付链路在 Main 侧只有一条真正接线，`relay_bridge` 是死枚举** — `packages/desktop/src/main/taskRealtimeBus.ts:167`；`packages/shared/src/task-realtime.ts:78`
- 描述：`TaskRealtimeHostDeliveryKind = "desktop_window" | "relay_bridge"`，但 desktop 全仓 `registerHost` 默认恒为 `desktop_window`，从未有任何调用点设置 `relay_bridge`（grep 全 `packages/desktop/src` 无命中）。
- 证据：手机 `web-remote-replayable` 恢复链路实际走 `packages/acode-server-cli/src/server-core/http.ts:101,239`（与 `desktop-continuous` 在 server-cli/host 侧分流），不经 Main 的 taskRealtimeBus。即 AGENTS.md 要求的「两链路明确区分」在 host/server-cli 侧成立，但 Main 的 `relay_bridge` 分支是未接线的预留。
- 建议：确认这是有意（手机远控刻意不经 Main 实时总线，复用 Host attachment + server-cli 传输）还是遗漏。若有意，删掉 desktop 侧不可达的 `relay_bridge` 默认分支或加注释指向 server-cli 真源，避免「看似支持实则死代码」误导后续维护。
- 验收：代码中 `relay_bridge` 要么有真实接线点，要么注释说明其权威在 server-cli。

**[P3] 主特权窗未显式声明 `sandbox`，依赖 Electron 默认值** — `packages/desktop/src/main/desktopWindowChrome.ts:591-602`
- 描述：主窗 webPreferences 显式设了 `contextIsolation:true` / `nodeIntegration:false`，但没有 `sandbox:true`（对比 webview guest 在 line 667-670 显式 `sandbox=true`）。Electron 41 renderer 默认 sandbox=true，当前不构成漏洞，但 44KB/125 面的 preload 桥运行其下，安全属性不该靠隐式默认。
- 建议：主窗 webPreferences 显式加 `sandbox:true`（除非 preload 用到 sandbox 不兼容的 API，需先验证 `webUtils`/`webFrame` 用法）。
- 验收：主窗 `sandbox` 显式为 true，或注释说明为何必须关闭。

**[P3] 跨 Host 事件去重 LRU 上限固定 1000，高并发 run 下可能重复投递** — `packages/desktop/src/main/taskRealtimeBus.ts:128-129,1067-1077`
- 描述：`seenEventIds`/`seenEventOrder` 全局 LRU（默认 1000），用于 observer 去重。并发可见 run 多时，窗口滑出会导致同一事件被重复投递给 observer。
- 影响：仅 observer 侧重复（非 owner 权威路径），最坏是 UI 重复渲染一条流事件，不致命。
- 建议：上限随可见 run 规模动态化，或按 run 分桶去重而非全局单队列。
- 验收：多 run 并发压测下 observer 无重复流事件。

## 3. 进程边界核对

- **Main 是否承载业务状态？** 否（边界内）。`hostRunningTaskCountMap`（`desktopHostProcess.ts:521`）只是 Host 上报的镜像计数、无会话明细，用途是 keep-awake claim 与退出屏障 `getRunningAgentSessionCount`（`index.ts:1172`）——属进程调度，非业务事实。`desktopRemoteSessions.ts:40` 头注明确「连接/任务事实归 Host」，Main 只留 request/session 端口关联 + 脱敏 descriptor。taskRealtimeBus 的 lease/replay 见 P2，是有界转发调度态，不落盘。
- **有无违规 Remote Host？** 无。remote 连接全程 `windowHostProcessMap.get(webContentsId)` 拿窗口既有 Local Host（`desktopRemoteSessions.ts:134,306,441,679,722,766,798`），`spawnHostProcess` 唯一调用点在 `desktopWindowLifecycle.ts:207`（建窗时），远程路径从不 fork 新 Host。符合「本地 workspace 共享窗口 Host，不另建 Desktop Remote Host」。
- **relay 是否只转发？** 是。手机远控经 server-cli `exposeWebSocket`（`http.ts:239/278`）按 clientMode 分流；Main 侧 `desktopRemoteSessions` 只做端口/attachment 调度与脱敏转发，无任务队列/快照持久化。
- **两条交付链路是否区分清晰？** host/server-cli 侧清晰（`desktop-continuous`=trusted-host-relay 全量 vs `web-remote-replayable`=terminal-client 收窄，`http.ts:101,112,124`；host `index.ts:1343,2326`）。Main 侧仅 `desktop_window` 生效，`relay_bridge` 未接线（见 P2）。

## 4. IPC / 安全面

- **webPreferences 现状**：contextIsolation `true` 全覆盖（主窗、about、update-status、resourceManager、CUA 指示器、webview guest、chromeLocalStorage 等 10+ 处一致）；nodeIntegration `false` 全覆盖；webview guest 额外 `sandbox:true` + `nodeIntegrationInSubFrames:true`（CDP-on-guest pivot 需要）；主窗 `webviewTag:true`（内置浏览器 `<webview>` 渲染所需），update-status 窗 `webviewTag:false`。
- **preload 暴露面**：`src/preload/index.ts` 44KB，单一 `contextBridge.exposeInMainWorld("acode", {...})`，125 个 `ipcRenderer.invoke/send/on`，全部走 `PlatformChannels.*` 命名常量，未见裸 channel 字符串或通配转发。头注说明「集中暴露便于审计 contextBridge 权限边界」——合理。
- **webview attach 加固**（`desktopWindowChrome.ts:655-693`）：`will-attach-webview` 强制覆盖 preload、删 `disablewebsecurity`/`nodeintegration`，`window.open` 经 `setWindowOpenHandler` 统一 deny + 路由，URL 走 `isAllowedEmbeddedBrowserUrl` 白名单。主窗有 `attachMainWindowNavigationGuards` 收敛导航到自身 origin（specs/electron-hardening.md）。
- **不安全 IPC 清单**：未发现未鉴权/跨窗口串线。sender 校验普遍：`databaseStartupRelay.ts:60` `event.sender !== win.webContents` 拒绝；`contentBreadcrumb.ts:154-156` `isTrustedRendererSenderFrame`；browserView/cua/pip IPC 全部 `BrowserWindow.fromWebContents(event.sender)` 绑定回源窗口。唯一改进项是主窗 sandbox 未显式化（P3）。

## 5. 历史问题回归核对

- **ARCH-02 / desktop 未纳管**：`architecture-policy.yaml:165-167` desktop 仍 `managed: false`，与历史一致。受 `maxFileLines:400` 只减不增 ratchet 约束（存量入 baseline，新增超限即 fail）。当前 `browserGuestManager.ts`（4925）、`autoUpdater.ts`（2639）、`index.ts`（2544）、`taskRealtimeBus.ts`（1083）等靠文件级 `eslint-disable max-lines` / `oxlint-disable` 豁免——ratchet 下这些是登记存量，非新增违规。
- **Electron smoke（`e2e-smoke.mjs`，383 行）**：四检查点齐全且逻辑正确——CP1 进程存活 5s、CP2 `DevToolsActivePort`→CDP `/json/version`（含 listening-port probe fallback + `collectCdpDiagnostics` 转储）、CP3 首窗 page target + `acodeLaunchMarks`（T0-T3 计时证据）、CP4 见下。
- **进程树 / 临时目录清理**：`teardown()`（line 207-250）win32 `taskkill /T /F`、posix `process.kill(-pid)` 杀整树 → 15s 轮询 `findElectronProcessesReferencing(tempRoot)` 归零 → record `process-tree-cleanup` → `rmSync` 临时目录 + record `temp-dir-cleanup`。闭环完整。
- **运行时进程收容**：`index.ts:272-280` `installProcessContainment`（diagnostics_channel spawn 台账，早于首个 child_process spawn）+ `installExitHook`（崩溃路径 SIGKILL 台账活子进程）；退出/更新路径 `sweepOrphanedChildProcesses`（`index.ts:1148,2194`）按台账树杀。dispose `effectiveForceKillDelayMs = Math.max(delay, 3500)`（`desktopHostProcess.ts:782`）防 host 先退导致 acode-cli 被 init 接管成孤儿。退出屏障（`index.ts:1097`）cron dispose + remote disposeAll + 每 Host `disposeHostProcessAndWait` **并行**收口（修复了历史串行放大 4.5s/9s 预算的问题）。**未发现僵尸进程/清理缺失。**

## 6. 修复入口建议

先处置 P2 第二项——用一行注释或删分支，澄清 `taskRealtimeBus.ts:167` 的 `relay_bridge` 是有意预留还是死代码（2 分钟）。这直接关系 AGENTS.md「两链路必须明确区分」的 Main 侧证据链是否完整。
