# Spec：退出看门狗+退出证据链、keep-awake 认领台账、Windows 孤儿进程围堵

> 状态：**已实施**（波次 W1-4）。
> 机制来源：外部桌面应用「关停任务记账 / 电源保持认领 / 子进程围堵验证」工程范式
> （第二轮价值提取研究文档 T2-m3、T2-m2、T2-m5 节，zoode 研究产出）。按边界纪律只
> 搬运机制设计（三名单关停注册表 + 逐 handler 记账 + 看门狗 + 退出证据持久化回读；
> 命名 claim 集合 + 单 blocker 引用计数 + 策略门 + away-ms 计量；spawn 台账 +
> 首 spawn 围堵实测 + 失败退订），实现为 ACode 自有代码；任何外部厂商/产品代号不得
> 进入代码与本 spec。遥测事件出口全部替换为结构化日志（specs/no-telemetry.md 约束）。

## 背景与现状

- 退出路径：`index.ts` 的 `before-quit → prepareAppQuit(kind)` 已有分档超时
  （`appShutdownPolicy.ts`：forceKillDelay/waitTimeout、update-install 只升不降），
  但清理动作硬编码在 `prepareAppQuit` 里，没有可扩展的关停任务注册表，没有逐
  handler 记账，退出是否干净在下次启动完全不可知（无法与登录态丢失等启动异常关联）。
- keep-awake：`index.ts:252-270` 是全局布尔 `keepAwakeWhileRunning` + 单一
  `powerSaveBlocker`。ACode 已有舰队/cron/off-peak 闲时任务（scheduler
  `offpeak-active-count`）与多会话并发，全局布尔无法表达「谁在请求保持唤醒、
  持有多久、用户离开多久」，也无法对 loop/background 类请求设上限。
- Windows 孤儿进程：更新安装路径有实时资源锁扫描 + `taskkill /T /F` 兜底
  （`windowsInstallResourceLocks.ts`），Host 侧有 3.5s 进程树 SIGTERM/SIGKILL 兜底
  （`desktopHostProcess.ts`）。但 main 直接 spawn 的子进程没有统一台账；main 崩溃或
  被强杀时没有任何连坐机制，预热/托管进程可能残留为孤儿（外部工程有 6 小时级孤儿
  事故实证，ACode 侧同类风险真实存在）。

## FFI 能力判决（2026-10-15 实查）

- `packages/desktop/package.json` 无 FFI 依赖；根 `node_modules/koffi@2.15.6` 来自
  `apps/acode-cli/packages/adapters` 的直接依赖与 opentui 的 optionalDependency
  （`node-linker=hoisted` 提升产物），**不属于 desktop 声明依赖树**。
- desktop main 是 tsup ESM bundle，`external` 只含声明依赖；koffi 未声明则会被内联
  破坏其动态 `require(*.node)`，且 electron-builder 不会把未声明依赖打进安装包。
- 结论：desktop 侧**无可用 FFI**，native Job Object（CreateJobObjectW +
  KILL_ON_JOB_CLOSE + AssignProcessToJobObject）本轮不实现，登记为条件触发项
  （见「登记项」）。本轮实现替代形态：diagnostics_channel spawn 台账 + 效果验证层。
- Electron 41.10.7 内置 Node 24.18.0 实测：`diagnostics_channel` 的
  `child_process` 频道可用，publish 载荷为 `{process}` 且 **publish 时 `process.pid`
  尚为 undefined**（pid 在 `spawn` 事件时才可靠），台账与验证必须以
  `child.once("spawn")` 为准。

## 机制与产品规则

### A. 关停任务注册表 + 退出看门狗 + 证据链（shutdownTasks.ts / shutdownEvidence.ts）

拓扑与状态所有权：

```text
register(task{name,fn,beforeInstall?,stopsChildProcesses?})
   │ 三名单：all / beforeInstall 段 / stopsChildProcesses 段（注册时一次分派）
   ▼
runShutdown(kind)（唯一执行者；in-flight 去重；同名任务进程内至多执行一次）
   │ 证据写盘：stage=cleanup-start（completed:false）→ 并行执行 + 逐 handler 计时
   │ 超时（policy.cleanupBudgetMs）→ abort 等待，快照 pending_handlers
   ▼ 证据写盘：stage=final（completed/timed_out/cleanup_ms/slowest/pending_handlers/ts）
看门狗（policy.watchdogDelayMs，unref）：事件循环仍存活 → stage=watchdog，
   标记 watchdog_fired=true 重写证据 → error 结构化日志 → forceExit(0)
   ▼
下次启动 initializeShutdownEvidence()：读回+消费（读后即删）→ stage=boot 打点本次运行
   → 只读查询 getPreviousShutdownEvidence() / previousQuitClean
```

- **R1 三名单语义**：注册任务 `{name, fn, beforeInstall?, stopsChildProcesses?}`。
  `name` 必须匹配 `^[A-Za-z0-9_.-]{1,64}$`，重名拒绝并 warn（记账以 name 为键）。
  `runShutdown("normal")` 执行全部名单；`runShutdown("update-install")` 只执行
  beforeInstall ∪ stopsChildProcesses 段（更新器重启安装前的收敛面），其余任务留给
  随后的 normal 关停（已执行的按 name 跳过，不重复执行）。
- **R2 逐 handler 记账**：所有入选任务并行执行，逐个记 `durationsMs[name]`；handler
  抛错记 warn 但仍计入时长（视为已执行）。总预算 `policy.cleanupBudgetMs` 到期即
  abort 等待：`pending_handlers` = 入选且无时长记录的名字快照；`timed_out=true`。
  abort 不取消 handler 本身（无法安全取消），只停止等待并落证据。
- **R3 看门狗**：证据 final 落盘后 arm `policy.watchdogDelayMs`（unref，不阻止正常
  退出）。若到时进程仍未退出（Electron 关窗/退出流程卡死），把持久化记录改写为
  `watchdog_fired=true, stage="watchdog"`，error 结构化日志后 `forceExit(0)`。
- **R4 持久化证据**：`userData/last-shutdown-evidence.json`，temp+rename 原子写。
  记录闭集字段：`{completed, cleanup_ms, handler_count, slowest_handler, slowest_ms,
timed_out, pending_handlers, watchdog_fired, for_update, quit_app_version,
quit_epoch_ms, ts, stage}`；`stage ∈ {boot, cleanup-start, final, watchdog}`。
  写盘用同步 IO：这是退出路径，异步写在 `app.exit(0)` 竞态下不保证落盘；载荷 <1KB，
  是本仓「异步 IO」纪律的登记例外（仅 shutdownEvidence.ts）。
  - `stage=boot` 打点：启动时先消费上一条记录，再为本次运行写
    `{completed:false, stage:"boot"}`。进程被强杀/崩溃时该记录留存，下次启动即可
    归因「上次退出非干净」，消除「强杀后读到更早一次干净记录」的误归因。
  - `pending_handlers` 每项按 name 正则校验，最多存 100 项；读回时任何字段不合法
    → 整条判 null（fail-closed），warn「ignoring malformed」。
- **R5 previous_quit_clean**：`record ? completed && !timed_out && !watchdog_fired
: null`。只读查询接口 `getPreviousShutdownEvidence()` 供启动异常（登录态丢失、
  数据库恢复等）关联归因；`null` = 无上一条记录（首启或记录损坏）。
- **R6 与现有分档超时融合**：`appShutdownPolicy.ts` 保留 forceKillDelay/waitTimeout
  与 update-install 只升不降语义，新增每档 `cleanupBudgetMs/watchdogDelayMs`：
  STRICT（update-install 与非 Windows normal）= 20s/15s；WINDOWS_NORMAL = 12s/10s
  （覆盖各自 waitTimeoutMs 的 Host 屏障 + 余量）。`prepareAppQuit` 的 Host 进程屏障
  不变；runShutdown 是它旁边的「命名任务」层，接线后可把 flush/persist 类收尾从
  index.ts 硬编码迁进注册表（本轮不改 index.ts，接线需求见实施报告）。
- **R7 日志纪律**：结构化负载禁用保留闭集键 `status`（LogContext 约定，闭集为
  started/waiting/completed/failed/cancelled）；自定义状态一律用 `outcome`/专有键。
  watchdog 触发 = error 级 `{event:"shutdown_watchdog_fired", outcome:"forced_exit",
timeout_ms, kind, pending_handlers}`。

### B. keep-awake 认领台账（keepAwakeClaims.ts）

```text
acquire(kind∈{turn,background_task,loop}, sessionId)  ← 会话运行面（唯一 claim 写入方）
release / releaseSession(sessionId, terminalState)     ← 终结态闭集释放
setMasterSwitch(keepAwakeWhileRunning)                 ← 设置通道（index.ts）
powerMonitor on-ac/on-battery ──┐
60s 采样 tick（unref）──────────┼→ reconcile()（唯一 blocker 写路径）
acquire/release/expire ─────────┘        │
                          claims.size>0 且无压制原因 → 单一 powerSaveBlocker
```

- **R8 命名 claim 集合**：key = `kind:sessionId`；kind 闭集
  `{turn, background_task, loop}`，非法 kind 抛错（编程错误）。claim 只是台账记录，
  blocker 由 reconcile 单点起停（单一所有者，无双写路径）。
- **R9 策略门**（全部实时重估，任一变化触发 reconcile）：
  1. 总开关 = 现有 `keepAwakeWhileRunning` 设置（语义不变：关=不 applied）；
  2. 电池策略 = `powerMonitor.on("on-ac"/"on-battery")` 事件即时 reconcile；默认
     允许电池下 applied（与现有全局布尔行为一致，不引入行为回退），门接口
     `getBatteryPolicy()` 预留收紧点；
  3. loop/background_task claim 连续持有 ≥ 2h 自动过期（warn `outcome:"capped"`），
     turn claim 不过期、只随终结态释放。
- **R10 终结态闭集**：`{close, error, stopped, paused, archived, deleted}` 之一到达
  时释放该会话全部 claim；未知状态不释放并 warn（防止把中间态误当终结态）。
- **R11 away-ms 计量**：claims 非空期间每 60s（unref）读
  `powerMonitor.getSystemIdleTime()`，`idleMs` clamp 到每个 claim 的持有窗口
  （`min(idleMs, now - claim.since)`）逐 claim 取 max；释放日志带 `held_ms` 与
  `max_away_ms`（用户离开但任务仍在跑的量化证据）。
- **R12 压制显式化**：总开关/电池门压制时 claim 照记（台账完整），reconcile 不起
  blocker，并 info「recorded but not applied: <原因>」；解除压制时自动 applied
  （claims 仍在）。
- **R13 日志键**：`{event:"keep_awake_blocker_started"|"keep_awake_blocker_stopped"|
"keep_awake_claim_acquired"|"keep_awake_claim_released"|"keep_awake_claim_expired",
outcome, claim_kind, session_id(截断 64), claims, held_ms, max_away_ms}`；
  不用 `status` 键。
- **接线**：`installKeepAwakeClaims(deps)` 替换 index.ts:252-270 的布尔逻辑；
  deps 注入 logger/powerSaveBlocker/powerMonitor/getMasterSwitch，保持 index.ts
  为唯一 Electron 接触点（本轮不改 index.ts，接线需求见实施报告）。

### C. Windows 孤儿进程围堵（processContainment.ts + processContainmentCore.ts，台账形态）

- **R14 形态判决与 outcome 闭集**：`not_windows`（非 win32 直接跳过）/ `disabled`
  （`ACODE_PROCESS_CONTAINMENT=0`）/ `no_capability`（显式要求 job 形态
  ——`ACODE_PROCESS_CONTAINMENT_JOB=1`——但无 native 能力注入，降级台账并 warn）/
  `joined`（注入了 job 能力且成功，本轮不出现，为条件触发项预留）/ `tracked`
  （台账形态生效，本轮默认）/ `failed`（订阅/加入异常）。outcome 进安装日志
  `{event:"process_containment_installed", outcome}`。
- **R15 spawn 台账**：订阅 `diagnostics_channel` `child_process` 频道；每条消息
  `child.once("spawn")` 后记 `{pid, parentPid, command(净化摘要), spawnedAt,
exitedAt, exitCode}`；`exit` 事件回填退出信息。command 摘要 = spawnfile basename +
  前 3 个参数，逐段白名单字符净化、总长 ≤200（不写入凭据/完整命令行）。台账容量
  256：先淘汰已退出最旧项，全是活项再淘汰最旧活项并 warn。
- **R16 效果验证层（本体价值的第二段）**：首个 spawn 到达时实测围堵是否覆盖：
  台账形态验证「台账已收录该 pid」；job 形态（预留）验证 `isProcessInJob(pid)`。
  验证通过 → info 一次并退订验证器；不通过 → **error 级点名「围堵生效晚于首
  spawn」**（`{event:"process_containment_verification", outcome:"missed_first_spawn"|"
covered"|"check_failed"}`）；检查异常累计 3 次 → 放弃并退订（warn）。
- **R17 退出/崩溃清理强化**（对照现有 taskkill 兜底）：
  - 优雅退出：`sweepOrphanedChildProcesses(reason)` 对台账中仍存活的项做树杀
    （win32：`taskkill /PID x /T /F`，detached+unref 不阻塞退出）；跳过 taskkill/kill
    自身（防止围堵工具杀自己）。与 `runWindowsUpdateProcessCleanup` 的实时资源锁
    扫描互补：那边按「仍持有随包资源句柄」扫，这边按「main 亲手 spawn 且未退出」杀，
    不依赖 PID 登记时序。
  - 崩溃路径：`process.on("exit")` 同步钩子对活项 `process.kill(pid,"SIGKILL")`
    （仅直接子进程，无树语义——树级连坐是 native Job Object 的能力，见登记项）。
- **R18 边界**：台账只覆盖 main 进程内 `node:child_process` 的 spawn；Host
  （utilityProcess）内的 agent 进程树仍由 Host 3.5s 屏障与更新期资源锁扫描负责，
  两层不互相替代。非 Windows 平台返回 inert 控制器（outcome=not_windows），
  POSIX 依赖既有 SIGTERM/SIGKILL 屏障与进程组语义。

## 登记项（条件触发）

- **native Job Object 围堵**（R14 `joined` 形态的完整实现）：触发条件 = 仓库决策引入
  FFI 依赖（如 koffi）进 `packages/desktop/package.json` + tsup `external` +
  electron-builder 打包链路三者齐备。届时实现 `CreateJobObjectW` +
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject`，main 启动早期
  join，之后每个子进程 spawn 即被 OS 连坐；`processContainment.ts` 已预留
  `deps.jobObject {join, isProcessInJob}` 注入点与 outcome=joined 语义，验证层
  （R16）无需改动即可实测 job 覆盖。在此之前 `ACODE_PROCESS_CONTAINMENT_JOB=1`
  只会得到 `no_capability` + 台账降级。

## 验收场景（对应 tests/）

1. shutdown-evidence.test.mjs：三名单分派与 name 校验/重名拒绝；runShutdown 逐
   handler 记账（成功/抛错都计时）；超时 abort → `timed_out=true` +
   `pending_handlers` 名单；update-install 段选择 + normal 二次运行跳过已执行；
   证据文件原子写/读回消费/畸形记录 fail-closed；previousQuitClean 三态；
   watchdog 触发 → `watchdog_fired=true` + stage=watchdog + forceExit；policy 新档
   位字段与 update-install 只升不降回归。
2. keep-awake-claims.test.mjs：单 blocker 引用计数（多 claim 一次 start、最后一个
   release 才 stop）；总开关关 → recorded but not applied + 开启后自动 applied；
   on-battery/on-ac 实时重估；loop/background 2h 过期（假时钟）、turn 不过期；
   终结态闭集释放与未知状态拒绝；away-ms clamp 到 claim 持有窗口。
3. process-containment.test.mjs：非 win32 → inert（注入 platform 跨平台可跑）；
   台账记录/退出回填/容量淘汰/command 净化；首 spawn 验证 covered/missed/3 次
   异常退订；sweep 跳过 taskkill 自身、只杀活项；真实 `node -e` spawn 集成验证
   频道载荷形状（pid 在 spawn 事件才可用）。
