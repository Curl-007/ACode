# CliGovernor——内存压力会话治理（资源维度）

WI-E4（价值提取第三轮 A3 机制移植）：给舰队/预热体系补上资源维度治理——会话
计数 cap、spawn 分类（user 永不阻塞 / warm 让路）、内存压力下 LRU 空闲受害者
**暂停而非杀**（governor_evict 可恢复）、压力源抽象（可注入接口 + 缺省轮询
实现）、per-level 限速与 repeat 抑制。只搬机制，不搬厂商面：事件名 ACode 化
（`governor_*`），无上游产品代号进入代码。

蓝本证据：`index.chunk-CnuqahbP.js:10701-10899`（governor 状态机）、`:52799-52820`
（会话表/warm 生命周期接线）、`index.chunk-CHpJbW9_.js:124700-124770,295129`
（free-ratio 平台读取：linux `/proc/meminfo` MemAvailable、Electron
`process.getSystemMemoryInfo()`）。行号以 2026-10 检出为准。

## 背景（盘点结论，决定适配形态）

- **进程面现状**：ACode 舰队会话是**同进程 child runtime**（session-fleet.md），
  与蓝本 CCD「每会话一个 warm CLI 进程」不同——空闲舰队会话的常驻足迹小，
  真正的预热大足迹在 **desktop 侧 warm agent 进程**（启动边界固定预热最多 3 个
  workspace 的 agent，`startupWorkspace.ts` STARTUP_AGENT_WARMUP_LIMIT）。因此
  治理分两个消费面：CLI 进程内 governor（cap + spawn 分类 + 压力清扫）与
  desktop 预热带同阈值让路钩子，**不跨进程转发压力信号**（非目标 #3）。
- **暂停面现状**：`agent/pause-gate.ts` 是**进程级**冻结闸门（所有 loop 一起
  park），语义上不是 per-session 暂停，governor 不复用它治理单个受害者。ACode
  舰队的可恢复收口 = `SubagentPort.stopTask(agentId)`：任务进终态 stopped，
  舰队记录、会话 JSONL、runtime-task 条目全保留，`SendToSession` 是恢复既有
  child 的通道（runner.ts sendMessage 注释）。对比归档（archive.ts R6：remove
  条目 = 结构性关闭恢复面）——governor_evict 绝不 remove/归档。
- **空闲判定现状**：`FleetSessionRecord.lastActivityAt`（registry.ts）+
  `isFleetSessionRunning`（archive.ts：runtime-task 条目存在且非终态）。

## 模块组织

- `core/src/runtime/memory-pressure.ts`：cap 公式、压力源接口、阈值判定、
  缺省轮询源（R1/R5）。
- `core/src/runtime/cli-governor-types.ts`：端口/事件闭集/槽位契约类型。
- `core/src/runtime/cli-governor.ts`：CliGovernor 状态机（R2/R3/R6/R7），
  re-export 类型面，消费方导入面不变。
- `core/src/fleet/governor.ts`：舰队组合面（单例、驱逐端口懒接、LRU peek、
  cap 物化）；`fleet/session-launch.ts` 在 launch 编排取 user 槽位。
- desktop：`startupWorkspace.ts`（让路过滤 + 压力采样）+
  `desktopWindowLifecycle.ts`（spawnLocalHost 消费过滤结果）。
- 文件拆分动机：max-file-lines 400 行纪律（architecture:check）。

## R1 会话计数 cap

```
cap = max(6, floor(totalMemoryBytes / 3GiB))
```

- **RAM 读取平台裁决**：CLI 侧统一 `node:os.totalmem()`（三平台一致语义：
  物理内存总量）；desktop 侧让路钩子不重算 cap（只按 free-ratio 阈值让路）。
- cap 在 governor 构造期计算一次（蓝本同款：模块加载期常量）；测试经注入
  `totalMemoryBytes` 覆盖。
- 计数口径：`effective = countActive + inFlight`。`countActive` = 舰队 registry
  非归档记录数（「在册会话」，对齐蓝本 sessionTable 计数）；`inFlight` = 已
  acquire 未登记（launch 进行中）的槽位数。登记完成或 launch 失败即 release
  （幂等，双调用只减一次）。

## R2 spawn 分类表（acquireSlot）

`acquireSlot(reason)` 在互斥段内裁决（蓝本 mutex.runExclusive 同款；串行化
at-cap 判定与 evict 决策）：

| reason | effective ≥ cap 时行为 | 事件 |
| --- | --- | --- |
| `user` | **放行**（永不阻塞）：照常占用槽位 | `governor_soft_cap_exceeded`（记因：cap/effective/count_active/in_flight/had_evictable） |
| `warm` | effective **=== cap** 且存在可驱逐受害者（R3 idle guard 通过）且驱逐端口在位 → 驱逐受害者后放行；否则 **yield**（不 spawn，返回 `{ yielded: true }`，不占 inFlight） | 驱逐路径 `governor_would_evict`（evicted=true）；yield 路径 `governor_yielded` |

- effective **> cap** 时 warm 一律 yield（蓝本同款：只在恰好 at-cap 驱逐，
  超限不叠加驱逐）。
- 只要 peek 到受害者（无论是否真驱逐）都发 `governor_would_evict`（evicted
  字段区分），保持蓝本可观测语义。
- **ACode 映射裁决**：`user` = 舰队工具面显式发起（StartSession /
  HandOffToSession 新建，源头是用户请求的启动）；`warm` = 预热/备用池 spawn
  （desktop 启动预热链，及未来 CLI warm pool）。launchFleetSession 固定以
  `user` 取槽。
- yield 的 warm spawn 由调用方自行择机重试（governor 不排队、不记债——
  蓝本同款无等待队列语义）。

## R3 LRU 受害者与 idle guard

- `peekLruIdleVictim(reason)`：舰队非归档记录中 `lastActivityAt` 最旧者，
  返回 `{ sessionId, idleSeconds }`；无记录返回 null。
- **idle guard**：`idleSeconds * 1000 >= minVictimIdleMs`（缺省 60s）才够格
  被驱逐（蓝本 passesIdleGuard 同款）。
- **受害者资格平台裁决**（蓝本 !isRunning/!isStopping/无 cron 等谓词的 ACode
  收敛）：非归档 + **runtime-task 条目终态或缺席**（`isFleetSessionRunning`
  为 false）。在跑（非终态）的会话绝不被驱逐——60s idle guard 保护 park 中
  的 run，终态判定保护活跃 loop，双保险。
- 压力清扫循环防重入：驱逐是异步收口，peek 连续两次返回同一 sessionId 即
  break（蓝本 lastEvicted 守卫同款）；清扫数量以 demand 为上限。

## R4 pause-not-kill 语义与恢复路径

- **governor_evict = 可恢复暂停**：对受害者调 `stopTask(agentId)`（best-effort
  异步；终态任务天然 no-op），随后发 `governor_evict` 事件（sessionId、
  trigger=warm_spawn|pressure、idleSeconds）。
- **结构性保证**：驱逐路径绝不触碰 `registry.remove` / archive / runtime-task
  条目 remove——舰队记录、所有权、会话 JSONL、SendToSession/HandOffToSession
  恢复面全部原样保留。恢复 = 下一次消息投递重新起 run（既有语义，零新面）。
- **驱逐端口缺席时 fail-safe**：`evictionOn() = false`——只发
  `governor_would_evict`（evicted=false）记日志，不执行任何收口（蓝本
  `!!cfg.evictVictim` 同款）。端口由 fleet launch 面懒接（首个携带
  subagentPort 的 launch ctx 完成 attach），不要求 host 装配序。
- **同进程足迹诚实声明**（蓝本偏差根源）：ACode 空闲舰队会话常驻足迹小，
  evict 的直接内存收益有限；资源治理的主要收益在 R2 的 warm 让路（desktop
  侧少 spawn 完整 agent 进程）与 cap 对并发在册会话的约束。governor_evict
  事件同时是宿主投影面（未来 UI 可显示「因内存压力被暂停」）。

## R5 压力源接口（可注入）

```ts
type MemoryPressureLevel = "warning" | "critical";
interface MemoryPressureSource {
  /** level=null 表示压力解除（normal）。返回退订函数。 */
  subscribe(listener: (level: MemoryPressureLevel | null) => void): () => void;
}
```

- **core 只消费接口**；`governor.start(source?)` 订阅注入源，缺省用
  `createPollingMemoryPressureSource()`。
- **缺省轮询源**：`getFreeMemoryRatio()`（缺省 `os.freemem()/os.totalmem()`，
  可注入）每 `pollIntervalMs`（缺省 10s）采样：ratio < 2% → critical、
  < 5% → warning、否则 null；定时器 unref（不阻塞进程退出）；读取抛错 →
  视为压力解除 + 只记一次 warn（蓝本 memoryReadFailureLogged 同款）。
- **desktop 侧源裁决**：Electron main `process.getSystemMemoryInfo()`，
  ratio = min(free/total, swapFree/swapTotal)（蓝本 Qxn 等价，swap 参与是
  防「内存够但 swap 枯竭」误判）。Electron 无公开 native 内存压力事件 API
  （macOS dispatch MEMORYPRESSURE 需原生模块）——**裁决不引原生模块**，
  native 事件经接口留作未来注入位。
- **蓝本偏差**：蓝本 start() 在 darwin 跳过轮询（依赖 native 事件），但其
  接线传 `start(void 0)`——darwin 实际无压力信号（蓝本缺陷）。移植裁决：
  缺省轮询源**全平台**生效，darwin 不再豁免。

## R6 限速与 repeat 抑制

- **per-level 60s 限速**：`lastSweepAt[level]` 各自独立；60s 内同 level 的
  压力信号直接忽略（不 sweep、不发事件）。不同 level 互不限速。
- **repeat 抑制**（同因不刷屏）：`is_repeat = wouldEvictCount === 0 &&
  上次发射 level 相同 && cap 相同`。repeat 时压制 warn 日志与
  `governor_pressure` 事件，直到距上次发射 ≥ `repeatReEmitMs`（缺省 5min）
  才重新发射。非 repeat 照常发射并刷新 `lastEmitted`。
- 压力解除（level null）清 `lastEmitted`——下次压力必发（哪怕同 level）。
- **蓝本偏差**：蓝本 repeat 再发射另叠 1% 采样门（analytics 体量优化），
  ACode 无对应遥测面，不移植。

## R7 事件闭集与日志

事件经 `onEvent(event)` 注入回调发出（无订阅 = 丢弃，不抛）；闭集五种：
`governor_would_evict`、`governor_soft_cap_exceeded`、`governor_yielded`、
`governor_pressure`、`governor_evict`。日志级别：acquire/驱逐路径 info、
压力发射 warn、订阅者抛错 warn（吞掉不破坏状态机）、ratio 读取失败 warn
一次。logger 为可注入可选端口（core 惯例：不直接 console）。

## R8 desktop 预热让路钩子

- `startupWorkspace.ts` 导出 `applyMemoryPressureToWarmupTargets(targets,
  { getFreeMemoryRatio?, logger? })`：无压力 → 原样放行；warning/critical →
  只保留 **primary（第 0 个）target**，其余 yield（本次启动不预热，用户切到
  对应项目时走既有冷启动路径——让路的代价与收益）。primary 是活动窗口的
  workspace，对齐「user spawn 永不阻塞」哲学，压力再高也不 yield。
- **钩子位置**：`desktopWindowLifecycle.ts` spawnLocalHost 组装 InitLocal
  消息处消费过滤结果（最小接线，不重构 warmup 解析逻辑）。
- desktop 侧同款 per-level 60s 日志抑制（模块级 lastLoggedAt），防多窗口
  反复 spawn 时刷屏。
- 阈值常量与 R5 缺省一致（5%/2%），实现独立（跨包不共享代码：desktop 不
  依赖 @acode/core，进程也隔离）。

## 验收场景（测试钉住）

1. **cap 公式**：24GiB → 8；18GiB → 6；8GiB → 6（floor 兜底）；48GiB → 16。
2. **user 超限放行**：at-cap 时 `acquireSlot("user")` 返回 yielded=false、
   inFlight+1、发 `governor_soft_cap_exceeded`；不驱逐任何受害者。
3. **warm at-cap 无可驱逐 → yield**：yielded=true、inFlight 不变、发
   `governor_yielded`。
4. **warm at-cap 有 idle≥60s 受害者 → 驱逐后放行**：stopTask 被调、发
   `governor_would_evict`(evicted=true) 与 `governor_evict`、yielded=false；
   registry 记录仍在且未归档（恢复面完整）。
5. **warm over-cap（effective>cap）→ yield 不驱逐**（即便有合格受害者）。
6. **idle guard**：受害者 idle 59s → warm yield、不驱逐；60s → 驱逐。
7. **驱逐端口缺席**：evictionOn=false，warm at-cap 一律 yield，压力清扫只发
   would_evict 语义事件不调 stopTask。
8. **per-level 限速**：critical 信号后 30s 再来 critical → 第二次被忽略；
   30s 时来 warning → 正常 sweep（各自计时）。61s 后 critical → 再 sweep。
9. **repeat 抑制**：同 level 同 cap 且 would_evict=0 的第二次压力 → 不发
   `governor_pressure`；推进 ≥5min 后同条件 → 重新发射。中间来 null 解除
   再回同 level → 立即发射（lastEmitted 已清）。
10. **压力清扫 demand 上限**：effective=3、合格空闲受害者 5 个 → 最多驱逐
    3 个（蓝本 demand=max(0, effective−0) 语义）；peek 粘住同一受害者 →
    循环 break 不死转。
11. **release 幂等**：双调用 inFlight 只减一次；yielded 槽位的 release 为
    no-op。
12. **轮询源**：ratio 0.04 → warning、0.01 → critical、0.5 → null；读取抛错
    → level null 且 warn 只记一次；定时器 unref。
13. **desktop 让路钩子**：3 targets + ratio 0.03 → 只留 primary 且日志含
    level；ratio 0.5 → 3 个全放行；空/单 target 原样返回；60s 内重复调用
    日志只记一次。

## 非目标

1. 不做跨进程压力转发（desktop→CLI 协议面零改动）；两面各自本地消费同阈值。
2. 不复用/不扩展进程级 pause-gate（语义不同层：全进程冻结 vs 单会话可恢复
   收口）；不新增 per-session park 机制。
3. 不引原生模块（darwin native 压力事件留接口注入位）。
4. 不做 warm spawn 等待队列/重试调度（yield 即返回，重试归调用方）。
5. 不治理舰队以外的会话面（主会话、subagent 一次性委托、workflow run 不计入
   countActive——口径 = 舰队在册记录，后续扩口径先改本 spec）。
