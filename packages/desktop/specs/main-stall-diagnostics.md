# Spec：desktop 主进程卡顿自诊断（stall-sampler）+ 大载荷直投评估

> 状态：**已实施**（波次 2 T2-10 desktop 部分）。
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

## 接口与文件

| 文件                               | 职责                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/stallSamplerProtocol.ts` | main↔worker 边界契约：配置默认值、workerData/消息类型、`stall_report` 运行时形状守卫（纯类型+纯函数，无 IO）                             |
| `src/main/stallSamplerCore.ts`     | 检测状态机 + 令牌桶 + capture 生命周期 + profile 聚合，全部依赖注入（`now/wallNow/profiler/post`），假时钟可单测                         |
| `src/main/stallSamplerWorker.ts`   | worker entry（tsup `main/stallSamplerWorker`）：inspector 接线 + `setInterval(poll)`；interval 保持 ref'd 直到报告落定（可行性实验实证） |
| `src/main/stallSampler.ts`         | main 侧：`startMainStallSampler(options) → handle\|null`（SAB、Worker、心跳 timer、消息消费→日志、stop 幂等）；`formatStallFrame` 纯函数 |
| `src/main/index.ts`                | 接线：模块初始化段 start；`prepareAppQuit` stop                                                                                          |
| `scripts/e2e-stall-sampler.mjs`    | 真机验收：真实 Electron + 真实模块 + 人为阻塞 main，断言 warn 报告与 frames（`e2e:stall-sampler`）                                       |

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
2. **真机 e2e**（`npx pnpm --filter @acode/desktop e2e:stall-sampler`）：真实
   Electron main 阻塞 2.5s，断言收到 `main_thread_stalled` warn 且 frames 非空
   （`captureStatus: "ok"`）。
3. **手工验证**：`pnpm dev:desktop` 后在 `src/main/index.ts` whenReady 临时加
   `const t=Date.now(); while(Date.now()-t<3000){}`，观察终端/日志文件出现
   `[main-stall] main thread stalled`（status=main_thread_stalled，frames 指向
   阻塞帧）；撤掉临时代码。或直接跑 e2e 脚本（免改源码）。

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
- 停跳归因增强：episode 关联 `desktopLaunchMarks` / 当前 GC 观测（外部范式还有
  event-loop-stall 台账 + power 事件分类），本波只做 sleepSuspected 单标记。
- worker 崩溃自动恢复（当前裁决：不重启）——若线上出现 worker 反复意外退出，
  再评估带上限的重启策略。
