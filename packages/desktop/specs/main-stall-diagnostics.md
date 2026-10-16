# Spec：desktop 主进程卡顿自诊断（stall-sampler）+ 卡顿归因深化层 + 大载荷直投评估

> 状态：**已实施**（波次 2 T2-10 desktop 部分）；**归因深化层（R9-R13）模块已实施、
> 接线待编排**（index.ts / channels.ts / preload / app-shell 归其他所有者，见
> 「接线状态」节与交付报告）。
> 机制来源：外部桌面应用「主进程卡死自诊断」工程范式（波次 2 价值提取研究文档
> T2-10 节，zoode 研究产出）。按边界纪律只搬运机制设计（心跳 SharedArrayBuffer +
> 独立监控执行体 + 主线程 CPU profile 抓取 + 令牌桶限流），实现为 ACode 自有代码；
> 任何外部厂商/产品代号不得进入代码与本 spec。

## 背景与现状

- ACode desktop 的 Electron main 进程此前**没有任何卡顿自诊断**：main 同步阻塞
  （大 JSON 解析、同步 IO、原生调用卡住等）只会表现为窗口失去响应，日志里没有
  任何痕迹，事后无法归因。
- main 已有日志器（`src/main/logger.ts`，文件 + console 双写）与 worker_threads
  先例（`storageScanWorker*`：tsup 独立 entry + `new Worker(new URL(...))`）。
- Electron 41.10.7（本仓钉版），main 进程内 Node ≥ 22 语义可用。

## 可行性判决（真实 Electron 实验，2026-10-15）

`node:inspector/promises` 的 `Session.connectToMainThread()` 只在**同进程
worker_threads** 内可用（utilityProcess/子进程不可用），且在 Electron main 里是否
成立需要实证。实验（本仓 `node_modules/electron/dist/electron.exe` 41.10.7，
隔离 `--user-data-dir`，main 写心跳 + 同步阻塞 2500ms，worker 停跳检测 + 抓取）
结论：

- **档位①（worker_threads + connectToMainThread + Profiler）完全可用**：
  `connectToMainThread()` 成功；主线程被同步 busy-loop 阻塞期间
  `Profiler.enable/setSamplingInterval/start` 全部落定（start 滞后仅 18ms，
  `profileStartedDuringBlock: true`）；2517ms 停跳抓到 1080 个样本，top 帧命中
  阻塞点所在 timer 回调（`listOnTimeout node:internal/timers`；内层热点函数被
  JIT 内联后归因到外层帧，属 V8 采样语义，不影响归因价值）。
- **实验实证的坑（实现必须遵守）**：worker 里 pending 的 inspector promise
  **不保住** worker 事件循环——若在下发最终报告前清掉 poll interval，worker 会以
  code 0 直接退出、丢失报告（首轮实验复现）。因此 poll interval 必须保持 ref'd
  直到 `stall_report` 发出（core 的 `dispose()` 由 worker 在报告落定后调用）。
- **档位②/③（main 开 inspect 端口 / `--inspect` 自连接，worker 走 CDP WebSocket）
  被否决**：打包态常驻 localhost 调试端口 = 本机任意进程可发现并注入 main 的
  RCE 面，与 `specs/electron-hardening.md`、`specs/no-telemetry.md` 的收敛方向
  冲突；且档位①已实证可用，无降级必要。
- **档位④（纯心跳 + 停跳时长，无 profile）作为运行态降级形态保留**：任何时候
  inspector 路线失败（require/connect/enable/start/stop 任一步），worker 不退出，
  降级为只报停跳时长与恢复事实（`captureStatus` 闭集标注原因）。

## 机制与产品规则

### 拓扑与状态所有权（单一所有者）

```text
main 线程（所有者：心跳 + 配置 + 日志上报）
  │  setInterval 250ms：Atomics.add(sab, 0, 1n)   ← 唯一心跳写入方
  │  SharedArrayBuffer(8B, BigInt64Array slot0 = beat seq)
  ▼
worker_thread（所有者：停跳检测状态机 + 令牌桶 + capture 生命周期）
  │  poll 100ms：Atomics.load 比对 seq；停跳 ≥1000ms → 开 episode
  │  connectToMainThread → Profiler.start（阻塞期间可落定）
  │  心跳恢复 → Profiler.stop → 聚合 top 帧 → postMessage(stall_report)
  ▼
main 线程：形状校验（fail-closed 丢弃畸形消息）→ 结构化日志（logger.warn/info）
```

- main 只写心跳、只消费报告；检测状态机与令牌桶只在 worker 一侧，无双写路径。
- worker 常驻一个线程（`resourceLimits.maxOldGenerationSizeMb: 128`），main 侧
  `worker.unref()` + 心跳 timer `unref()`，均不阻止进程退出。

### R1 心跳（开销可忽略）

main 每 `heartbeatIntervalMs=250` 执行一次 `Atomics.add`（O(1)，无分配）；
timer 为唯一心跳写入方。心跳 seq 单调递增，worker 以「seq 是否推进」判活。

### R2 停跳判定

worker 每 `pollIntervalMs=100` 比对 seq；`now - lastChangeAt ≥ stallThresholdMs
(1000)` 即开一个 stall episode。观测停跳时长的粒度上界 = heartbeatInterval +
pollInterval（~350ms），报告中的 `stallMs` 为观测值而非精确阻塞时长。

### R3 profile 抓取（档位①）

- `Profiler.enable + setSamplingInterval(1000µs)` 懒执行 + memoize（首次 capture
  才付成本；失败清空 memo 允许下次重试）。
- 停跳达到阈值且令牌可用 → `Profiler.start`；心跳恢复（或 `maxCaptureMs=30000`
  到期截断）→ `Profiler.stop` → 聚合。
- 聚合：按 sample 命中数排序取 top `maxFrames=8`；过滤 `(idle)`；
  `selfMs = round(hits × samplingIntervalUs / 1000)`；`startLagMs` = 从判定停跳
  到 `Profiler.start` 落定的滞后（诊断「命令是否真的在阻塞期间落地」）。
- `Profiler.start` 在 `maxCaptureMs` 内始终未落定 → `captureStatus: "timeout"`；
  若其事后落定，立即补一次 `Profiler.stop` 防采样器泄漏，结果丢弃。

### R4 令牌桶（防日志/采样风暴）

`maxBurstCaptures=3`，每 `minCaptureIntervalMs=300000`（5 分钟）补 1 枚，封顶
maxBurst。桶空时 episode 照常检测与上报，但 `captureStatus: "rate_limited"`、
无 frames——限流只降 profile，不降停跳事实。

### R5 睡眠/挂起分类（防误报）

OS 睡眠期间 main 与 worker 一起冻结，恢复后会被误判为超长停跳。worker 每 poll
比对墙钟（`Date.now()`）：单步跳变 > `max(4×pollIntervalMs, 2000ms)` 即把当前
episode 标 `sleepSuspected: true`。该 episode 以 **info** 级上报（状态
`main_thread_stalled_sleep_suspected`），真实停跳以 **warn** 级上报
（`main_thread_stalled`）——睡眠不是故障，不配 warn 噪音。

### R6 结构化上报与 `status` 闭集

日志前缀 `[main-stall]`，payload 为单个对象；`status` 键取自闭集（与仓内既有
`status: "failed"/"complete"/...` 等业务值不撞名）：

| status                                | 级别 | 时机                                                    |
| ------------------------------------- | ---- | ------------------------------------------------------- |
| `sampler_started`                     | info | worker ready（含 `mode: profiling / heartbeat_only`）   |
| `sampler_spawn_failed`                | warn | worker 拉起失败（含 error message），采样器不启动       |
| `sampler_protocol_violation`          | warn | 收到畸形 worker 消息，fail-closed 丢弃（不回显载荷）    |
| `sampler_worker_exited`               | warn | worker 意外退出（含 code 与末次 error），**不自动重启** |
| `main_thread_stalled`                 | warn | 真实停跳 episode 恢复                                   |
| `main_thread_stalled_sleep_suspected` | info | 疑似 OS 睡眠造成的停跳                                  |
| `renderer_unresponsive`               | warn | webContents unresponsive 聚合报告（R12，判卡顿）        |
| `renderer_unresponsive_print_call`    | info | unresponsive 归因 print() 假死守卫命中（R12，不判卡顿） |

深化层新增日志事件（非 `status` 闭集成员，用独立前缀）：面包屑/print 上报的
sender 校验失败以 `[renderer-diag]` 前缀 warn（`event: "breadcrumb_sender_rejected"
/ "print_call_sender_rejected"`，不回显帧 URL——日志纪律不落用户可达地址）。

`stall_report` 载荷：`{ stallMs, sleepSuspected, captureStatus, startLagMs,
sampleCount, frames }`；`captureStatus` 闭集：`ok | rate_limited | unavailable |
error | timeout`。frames 在 main 侧格式化为字符串数组并做钳制（函数名仅允许
JS 标识符形状，否则 `(clamped)`；URL 仅保留 `node:*` 原样 / `file:*` 取 basename /
其余归一为 `(external)`）——profile 帧可能含用户目录路径，不落全路径（日志纪律：
不写入凭据与真实用户数据）。畸形 worker 消息一律丢弃并 warn（fail-closed）。

### R7 生命周期与开关

- **启动**：`src/main/index.ts` 模块初始化段（`app.whenReady()` 之前）即启动——
  启动阶段恰是 main 同步重活高峰，必须覆盖。开发态与打包态**都生效**（心跳 +
  一个 idle worker 线程的开销可忽略；dev 态卡顿同样值得诊断）。
- **停止**：`prepareAppQuit` 与其他 main 侧资源同批 dispose（清心跳 timer +
  `worker.terminate()`，幂等）。
- **kill switch**：`ACODE_MAIN_STALL_SAMPLER=0` 完全禁用（返回 null handle）。
  不接远端灰度（no-telemetry 边界：诊断纯本地，不外发任何数据）。
- worker 意外退出只记 `sampler_worker_exited`，**不重启**：诊断设施 fail-open，
  不得演化为重启循环；下次进程启动自然恢复。

### R8 降级形态（档位④恒可用）

require/connect/enable/start/stop 任一失败：worker 留在 `heartbeat_only` 模式，
停跳检测、睡眠分类、时长上报、令牌桶全部照常，仅无 frames。心跳 + 停跳检测 +
结构化上报 + 令牌桶是**无条件交付面**；profile 抓取是尽力面。

## 归因深化层（R9-R13）

R1-R8 回答「main 卡了、卡在哪些帧」；深化层回答「卡的时候整机与应用在什么状态、
哪条同步 IPC 段最重、renderer 当时呈现什么内容面、unresponsive 是不是 print() 假
死」。深化层全部是 main 侧纯模块（依赖注入、无顶层 electron import，与
`desktopWebContentsGuard.ts` 同款纪律：裁决收敛在纯函数里，事件接线只消费结果）。

### R9 同步 IPC worst-offender（`ipcSyncTiming.ts`）

- 动机：profile 帧只能指认「哪个函数」，指认不了「哪条 IPC 通道的同步段」。
  包装器只测 handler 的**同步段**——async handler 从调用到返回 promise 的同步前缀，
  sync handler 的整个函数体；await 之后的异步耗时不计入（那不是 main 线程阻塞）。
- worst-offender 保留最大值：`syncMs >= 0` 且**严格大于**当前值才替换（并列先到者
  保留）；NaN/负值忽略（时钟异常不污染归因）。
- **采样即清零**：main 收到 `stall_report` 时消费 `{label, syncMs}` 附进日志并重置
  ——归因窗口 = 相邻两次 stall report 之间，避免旧 offender 反复顶包。
- label 白名单 `^[a-z_]{1,40}$`：非法 label 在**注册时抛错**（TypeError），绝不静默
  降级——静默会让归因面变成死数据而无人察觉。`deriveIpcSyncLabel(channel)` 提供
  channel → label 的收敛派生（剥 `acode:` 前缀、小写、非 `[a-z]` 折叠为 `_`、截断
  40），供批量接线一行套用。
- `Symbol.dispose` 计时器 `createSyncSegmentTimer(label)`：`using` / `await using`
  标注任意同步段（菜单回调、深链处理等非 IPC 重活同样可归因）。dispose 时才记账，
  与包装器共用同一 worst-offender 存储。
- 开销：每次调用一对 `performance.now()` + 一次比较，无锁、无热路径分配。

### R10 presence 快照（`presenceSnapshot.ts`）

- 六事件总线（事件名 → 内部名闭集）：powerMonitor `suspend`/`lock-screen`(lock)/
  `unlock-screen`(unlock)/`resume`/`user-did-become-active`(session) + app
  `browser-window-focus`(focus)。tracker 是 presence 状态的**唯一所有者**，事件只能
  经 `handleEvent(name)` 进入；`subscribe(listener)` 供其他 main 模块复用，接线侧
  不得另建第二份记录路径。
- 每个事件记墙钟时刻；lock 额外维护 `lockedAt` 标志。
- **锁屏判定自愈**：unlock 事件可能丢失（Linux 显示管理器不发、跨睡眠锁屏等）。
  查询 locked 时若 `lockedAt` 已置且 `now - getSystemIdleTime()×1000 > lockedAt +
2000ms`（系统空闲时长证明加锁之后有过用户活动）⇒ 判 stale lock，清除标志。
  最终 `locked = getSystemIdleState(1s) === "locked" || lockedAt 仍置`。
  lock 事件丢失无法自愈（没有反向证据源），如实记录为局限。
- 快照字段（日志键，snake_case，任务契约名）：`seconds_since_resume` /
  `seconds_since_unlock` / `idle_seconds` / `locked` / `on_battery`；对应事件从未
  发生 ⇒ 该字段 null；任一 getter 抛错 ⇒ 整个快照全 null（快照失败不得反杀调用方）。
- 与 R5 睡眠分类**对齐不重复**：`sleepSuspected` 是 worker 侧墙钟跳变启发式（事件源
  缺失时的兜底）；presence 提供 OS 事件源佐证（`seconds_since_resume` 很小 ⇒ 睡眠
  疑似成立）。两者并列进日志供交叉核对，不互相替代、不在两处写同一状态。

### R11 renderer 内容状态面包屑（`contentBreadcrumb.ts` + ui `contentStateBreadcrumb`）

- ui 侧周期上报（默认 5s，payload 极小）**分桶**内容状态；main 按 webContentsId 缓存
  最新一条，unresponsive/stall 归因时带出。桶化理由：精确值既是噪声（每条消息都
  diff）又是隐私面（内容规模细节）；日志只落桶名。
- wire 契约（snake_case，闭集，**spec 是唯一事实源**；ui 与 desktop main 各自持有
  副本，上移 shared 属接线需求）：
  - `route_kind`：`chat | settings | browser | other`（ui 侧归一：非成员 → other）
  - `transcript_msgs_bucket`：`zero`(0) `| small`(1-10) `| medium`(11-50) `| large`
    (51-200) `| huge`(>200)
  - `composer_blocks_bucket`：`zero`(0) `| few`(1-3) `| many`(>3)
  - `rows_held_bucket`：`zero`(0) `| small`(1-50) `| medium`(51-500) `| large`(>500)
- main 侧校验 **fail-closed**：任一字段缺失/类型错/闭集外 ⇒ 整条丢弃（部分采纳会让
  「字段缺失」与「值为零桶」不可区分）。
- `content_stamp_age_ms` 由 main 计算 = `now - receivedAtMs`：renderer 卡死/忙时
  上报停摆，age 拉大即是佐证；周期重发（即使无变化）保证 age 只反映「上报器停摆」
  而非「内容没变」。
- 上报通道：专用 send-only 通道（模块内暂以常量 `"acode:content-breadcrumb"` +
  TODO 注释实现；channels.ts 归 W1-5，上移属接线需求）。sender 必须过 R12 的
  受信帧校验。webContents 销毁时清缓存。

### R12 unresponsive 聚合报告 + print() 假死守卫（`unresponsiveReport.ts`、

`printCallGuard.ts`、`rendererFrameTrust.ts`）

- webContents `unresponsive` 事件 ⇒ **一条**聚合结构化日志，不外发遥测
  （no-telemetry 边界），也不自动 kill/reload（杀 renderer 是产品行为，本波只做
  诊断；守卫只影响归因与日志级别）。
- 聚合字段：`surface`（闭集分类）+ `mainRssBytes`（main 进程 RSS）+ 窗口可见性
  （visible/minimized/focused，取不到 ⇒ null）+ presence 快照（R10）+ 最近 stall
  归因（R13 保留：`RECENT_STALL_WINDOW_MS=60s` 内最近一次 stall report，含
  worst-offender label）+ 内容桶（R11）+ `print_call` 归因。
- `surface` 闭集：`app_main | app_login | update_status | about | cua_indicator |
embedded_browser | unknown`。窗口类型 hint 由接线方提供（main 自己知道哪个 wc 是
  哪类窗口），URL 只用于 login 细分；hint 缺失/不认识 ⇒ `unknown` 兜底，不猜测。
- **print() 假死守卫**：`window.print()` 的原生对话框会同步阻塞 renderer 主线程，
  Chromium 随后判 unresponsive——这是预期行为不是故障。renderer 在执行
  `window.print()` 前/后经 IPC 上报 `printing=true/false`；main 侧：
  - **sender 校验**（`isTrustedRendererSenderFrame`，面包屑通道共用）：`senderFrame`
    存在、是主帧（`parent === null`）、URL 可解析、且属应用自身面——打包态 `file:`
    或 dev 态 `http(s)://localhost|127.0.0.1|[::1]`（与 `desktopWebContentsGuard`
    对「应用自身页面」的既有判定一致）。嵌入浏览器 guest 的远程 origin 与一切子帧
    一律拒绝。校验不过 ⇒ 上报忽略（不改守卫状态）。
  - `print_call` 归因闭集：`none | in_progress | too_old | window_focused |
switch_off`。
  - unresponsive 且 print 进行中且**窗口未聚焦**且守卫启用 ⇒ `in_progress`：不判
    卡顿，日志降为 info、status 换 `renderer_unresponsive_print_call`（原生打印
    对话框会抢走窗口焦点，未聚焦与「用户在打印对话框里」自洽）。
  - 窗口仍聚焦 ⇒ `window_focused`：打印对话框必然夺焦，聚焦说明阻塞另有原因，照常
    判卡顿（warn）。
  - print 状态年龄 ≥ `PRINT_CALL_MAX_TRUSTED_AGE_MS=600_000`（10min）⇒ `too_old`：
    「print 结束」上报可能丢失，不能让它永久护身。
  - 守卫开关关闭 ⇒ `switch_off`（照常判卡顿）。
  - 主帧导航（`did-start-navigation`/`did-navigate`）或 webContents 销毁 ⇒ 清该 wc
    的 print 状态（打印对话框不可能跨导航存活）。
  - print 状态按 webContentsId 记账（多窗口各自独立），非全局单槽。

### R13 stall_report 日志扩展（向后兼容）

- worker 消息面（`MainStallReport`、`stallSamplerProtocol.ts` 守卫）**不变**——扩展
  只发生在 main 侧日志 payload 与 handle 保留面，worker 协议零改动。
- `startMainStallSampler` 新增可选 `enrichStallReport()` 回调（依赖注入；
  stallSampler.ts 保持不 import electron）。收到 `stall_report` 时调用，附加键：
  `ipcSyncWorst`（R9 消费即清零的 `{label, syncMs}` 或 null）与 `presence`（R10
  快照或 null）。**未提供回调时日志 payload 与扩展前逐键一致**（既有 22 用例守护）。
- 归因保留：handle 新增 `getLastStallAttribution()`——保留最近一次 stall_report 的
  精简归因（stallMs/sleepSuspected/captureStatus/ipcSyncWorst/接收墙钟时刻），供
  R12 聚合读取。保留挂在 handle（每次 start 一份），不引入全局可变状态；
  `sleepSuspected` 的 episode 同样保留（睡眠恢复后的 unresponsive 需要它排除误报）。

## 接线状态（深化层模块已实施，接线待编排）

深化层不改动 `src/main/index.ts`、`tsup.config.ts`、`packages/shared/src/channels.ts`、
preload 与 ui app-shell（均非本波所有权）。待接线清单（细节见交付报告）：

1. index.ts：实例化 presenceTracker 并 `attach({powerMonitor, app})`；
   `startMainStallSampler({ logger, enrichStallReport })` 组合 presence + IPC
   worst-offender；窗口 webContents 挂 `unresponsive` / 导航 / destroyed 监听接
   `createUnresponsiveReporter(...)`；注册两条 send-only IPC 通道。
2. 70 处 `ipcMain.handle`（12 个文件）批量套用 `wrapIpcHandle(deriveIpcSyncLabel(ch), h)`。
3. channels.ts（W1-5）：新增 `acode:content-breadcrumb`、`acode:print-call` 常量；
   preload bridge 暴露对应 send 面。
4. ui app-shell：挂载 `useContentStateBreadcrumbReporter`（sample 接 tab/session
   store，send 接 preload 面）；`window.print()` 调用点（未来引入时）套
   `runWithPrintCallReporting`。

## 接口与文件

| 文件                                                 | 职责                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/stallSamplerProtocol.ts`                   | main↔worker 边界契约：配置默认值、workerData/消息类型、`stall_report` 运行时形状守卫（纯类型+纯函数，无 IO）                                                                                               |
| `src/main/stallSamplerCore.ts`                       | 检测状态机 + 令牌桶 + capture 生命周期 + profile 聚合，全部依赖注入（`now/wallNow/profiler/post`），假时钟可单测                                                                                           |
| `src/main/stallSamplerWorker.ts`                     | worker entry（tsup `main/stallSamplerWorker`）：inspector 接线 + `setInterval(poll)`；interval 保持 ref'd 直到报告落定（可行性实验实证）                                                                   |
| `src/main/stallSampler.ts`                           | main 侧：`startMainStallSampler(options) → handle\|null`（SAB、Worker、心跳 timer、消息消费→日志、stop 幂等、`enrichStallReport` 附加键、`getLastStallAttribution()` 归因保留）；`formatStallFrame` 纯函数 |
| `src/main/ipcSyncTiming.ts`                          | R9：同步 IPC worst-offender（label 白名单、`wrapIpcHandle`、`deriveIpcSyncLabel`、`Symbol.dispose` 计时器、消费即清零），纯 Node                                                                           |
| `src/main/presenceSnapshot.ts`                       | R10：六事件 presence tracker（唯一所有者、锁屏自愈、可空快照、subscribe 总线），依赖注入无 electron import                                                                                                 |
| `src/main/contentBreadcrumb.ts`                      | R11：面包屑 wire 校验（fail-closed 闭集）+ 按 webContentsId 的最新快照缓存 + IPC 注册助手                                                                                                                  |
| `src/main/printCallGuard.ts`                         | R12：print() 假死守卫状态机（per-wc 记账、`print_call` 归因闭集、10min 信任上限）                                                                                                                          |
| `src/main/rendererFrameTrust.ts`                     | R12：受信 renderer 主帧校验（`senderFrame` 主帧 + 应用自身 origin），面包屑/print 通道共用                                                                                                                 |
| `src/main/unresponsiveReport.ts`                     | R12：unresponsive 聚合报告（surface 分类、RSS、可见性、presence、最近 stall 归因、内容桶、print_call）→ 一条结构化日志                                                                                     |
| `packages/ui/src/lib/contentStateBreadcrumb.ts`      | R11 ui 侧：分桶纯函数 + wire payload 构造 + 周期上报器核心 + print 上报包裹助手                                                                                                                            |
| `packages/ui/src/hooks/useContentStateBreadcrumb.ts` | R11 ui 侧：上报器 React hook（挂载/卸载生命周期，transport 注入）                                                                                                                                          |
| `src/main/index.ts`                                  | 接线：模块初始化段 start；`prepareAppQuit` stop（深化层接线待编排，见「接线状态」）                                                                                                                        |
| `scripts/e2e-stall-sampler.mjs`                      | 真机验收：真实 Electron + 真实模块 + 人为阻塞 main，断言 warn 报告与 frames（`e2e:stall-sampler`）                                                                                                         |

- worker 解析路径与 `storageScanWorkerClient` 同款：
  `new URL("./stallSamplerWorker.js", import.meta.url)`，可注入 `workerUrl` 供测试。
- `stallSampler.ts` / `stallSamplerCore.ts` / `stallSamplerProtocol.ts` 不 import
  `electron`（保持纯 Node，可被 esbuild 打包进 e2e、可被单测直接驱动）。

## 验收场景

1. **单测**（`tests/main-stall-diagnostics.test.mjs`）：假时钟下——心跳推进无
   报告；停跳 ≥ 阈值后恢复 → 恰一条 `stall_report`（stallMs/frames/startLagMs
   形状正确）；令牌桶耗尽 → `rate_limited` 且不再 start profiler；补桶按
   最小间隔；墙钟跳变 → `sleepSuspected`；`Profiler.start` 未决时恢复 → 报告在
   start 落定后发出且 interval 不被提前清（worker 生命周期坑的回归）；聚合过滤
   `(idle)`、排序、selfMs 折算；帧钳制与 URL 归一；消息守卫拒绝畸形载荷。
2. **深化层单测**：
   - `tests/ipc-sync-timing.test.mjs`：同步段计时（async handler 只计同步前缀）、
     worst-offender 严格大于替换、NaN/负值忽略、消费即清零、label 白名单拒绝注册
     （抛错）、`deriveIpcSyncLabel` 派生与截断、`Symbol.dispose` 计时器（`using`）。
   - `tests/presence-snapshot.test.mjs`：六事件记账、快照字段与 null 语义、锁屏
     自愈（stale lock 清除）、getter 抛错全 null、subscribe 总线、快照进 stall 日志。
   - `tests/content-breadcrumb.test.mjs`：wire 校验 fail-closed（缺字段/闭集外/类型
     错整条拒绝）、per-wc 最新快照、stamp age 计算、销毁清理、sender 校验拒绝。
   - `tests/unresponsive-report.test.mjs`：聚合 payload 形状（surface/RSS/可见性/
     presence/最近 stall 归因含 worst label/内容桶）、60s 归因窗口、print 守卫
     归因闭集全分支（none/in_progress/too_old/window_focused/switch_off）、
     sender 校验（子帧/远程 origin/坏 URL 拒绝）、导航清 print 状态、日志级别与
     status 分流。
   - `tests/main-stall-diagnostics.test.mjs` 增量：`enrichStallReport` 附加键、
     无回调时 payload 向后兼容（逐键一致）、`getLastStallAttribution()` 保留面。
   - ui：`packages/ui/test/contentStateBreadcrumb.test.ts`——分桶边界（0/1/10/11/
     50/51/200/201、0/3/4、0/50/51/500/501）、route kind 归一、payload 形状、
     变化检测、上报器 start/stop 与 send 抛错隔离。
3. **真机 e2e**（`npx pnpm --filter @acode/desktop e2e:stall-sampler`）：真实
   Electron main 阻塞 2.5s，断言收到 `main_thread_stalled` warn 且 frames 非空
   （`captureStatus: "ok"`）。
4. **手工验证**：`pnpm dev:desktop` 后在 `src/main/index.ts` whenReady 临时加
   `const t=Date.now(); while(Date.now()-t<3000){}`，观察终端/日志文件出现
   `[main-stall] main thread stalled`（status=main_thread_stalled，frames 指向
   阻塞帧）；撤掉临时代码。或直接跑 e2e 脚本（免改源码）。深化层接线落地后：
   DevTools console 跑 `window.print()` 期间触发 unresponsive，日志应为 info 级
   `renderer_unresponsive_print_call`。

## 大载荷直投评估（登记，本波不实施）

外部范式：重活 worker 把大 transcript 经 MessagePort（portId+portGen 代数）直投
renderer，绕过主进程消息循环。对照 ACode desktop 现状盘点：

| 载荷流                                           | 现状                                                                                                                                                                                                           | 直投价值                                           | 改造成本/风险                                                                                                                                                                                                 | 裁决                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| renderer↔Host RPC（会话事件、task 流）           | **已经是 port 直投**：`desktopHostProcess.ts` 用 `MessageChannelMain` 把 port2 交给 Host utilityProcess、port1 交给 `win.webContents.postMessage`（ServicePort/ScopedServicePort），业务消息不经 main 消息循环 | 已达成                                             | —                                                                                                                                                                                                             | 无需动作               |
| agent stdio 转发                                 | agent 由 Host 进程（utilityProcess）持有，stdio 字节从不经过 main                                                                                                                                              | 不适用                                             | —                                                                                                                                                                                                             | 无需动作               |
| TaskRealtimeBus stream mirror（跨窗口/远控镜像） | main 是 owner：coalesce、chunk（≤512KB/批）、replay（≤60 批/512KB）、lease/owner 路由全在 `taskRealtimeBus.ts`                                                                                                 | 唯一真正的大载荷经 main 面；host↔host 直投可省一跳 | **高**：main 必须保留 lease/watermark/replay/stale-run 语义（AGENTS.md：不得仅按单一路径删除边界判断），直投后端口代数、host 退出回收、双 delivery kind（desktop-continuous / web-remote-replayable）都要重排 | 登记为后续候选，不实施 |
| BroadcastHub relay                               | main 转发 host→host 小控制消息 + claim 台账                                                                                                                                                                    | 载荷小，直投收益低                                 | N×N port 网状管理 vs 现有单 hub；claim 语义需重排                                                                                                                                                             | 不实施                 |
| storageScan / acodeDataSize                      | 已在 worker_threads，进度节流后才回 main                                                                                                                                                                       | 已达成                                             | —                                                                                                                                                                                                             | 无需动作               |

结论：ACode 的主 RPC 面与外部范式**已经同构**（port 直投），不存在「极便宜且纯
desktop 内部」的顺手改造点；唯一大载荷残留面（stream mirror）与 owner/lease
边界强耦合，登记为独立后续项。

## 遗留项

- stream mirror host↔host 直投（上表）——单独立项，需同时验证两种 delivery 语义。
- 停跳归因增强：episode 关联 `desktopLaunchMarks` / 当前 GC 观测仍未做（R9-R13
  已覆盖 IPC 归因、power 事件、内容面包屑与 unresponsive 聚合；launchMarks 关联
  与 GC 台账留待后续）。
- worker 崩溃自动恢复（当前裁决：不重启）——若线上出现 worker 反复意外退出，
  再评估带上限的重启策略。
- 深化层接线落地（见「接线状态」）：index.ts / channels.ts / preload / ui
  app-shell 四处接线由编排者分派；接线前深化层模块处于「已实施未挂载」状态，
  对运行时零影响。
- 面包屑 wire 契约上移 `packages/shared`（当前 ui 与 desktop main 各持副本，spec
  为唯一事实源）；channels.ts 常量落位后一并收敛。
- unresponsive 后的产品动作（kill/reload 决策）与 print 守卫的 deadline 补杀
  timer：只有存在 kill 路径时才需要，本波诊断-only 裁决下不实现。
- lock 事件丢失（locked 假阴性）无反向证据源，不自愈；unlock 丢失（假阳性）由
  R10 空闲时长自愈覆盖。
