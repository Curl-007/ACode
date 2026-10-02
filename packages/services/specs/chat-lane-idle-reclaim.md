# chat lane 空闲回收:CLI 静默自检与优雅退出(chat-lane idle reclaim)

内存治理项。给 chat lane 的常驻 `app-server --stdio` 进程增加**CLI 侧静默自检 + 空闲优雅退出**:
当进程内所有自治工作为空且无订阅者、持续 N 分钟时,CLI 通知 Host 后主动退出;Host 归因为
expected 并按需懒重启。目标:闲置 workspace 的 CLI 进程不再全量常驻,每个被回收的进程归还
约 160-200MB 提交内存(2026-10-02 实测,见「背景」)。

本 spec 覆盖三个包的联动改动:`packages/shared`(协议新增一条 CLI→Host 通知)、
`apps/acode-cli/packages/bootstrap`(静默判定与退出发起)、`packages/services`
(退出归因、宽限回收、被动路径审计)。

## 背景

### 已核实的现状(起草时逐条核实,行号以当前检出为准)

1. **chat lane 的空闲回收被类型层面刻意禁止**:`CreateACodeAgentServiceOptions extends
   Omit<ACodeAgentProcessManagerOptions, "idleTimeoutMs">`
   (`packages/services/src/acode-agent/acodeAgentService.ts:858-859`),注释原话「仅供 MCP
   状态探测进程使用,不能把空闲回收传给 chat」。三个进程管理器中只有 mcp-status lane 配了
   `idleTimeoutMs`(5 分钟,`:319、:1087-1095`);chat(`:1056`)与 plugin(`:1078`)lane
   均无回收。
2. **禁止的理由成立**:Host 侧空闲判据只有 `onPendingRequestsDrained`
   (`acodeAgentProcessManager.ts:671-709、:1183-1184`),看不见 CLI 进程内的自治工作
   (后台 bash、排队命令、pending 权限、detached subagent、dwf run、记忆抽取)。按
   「无在飞请求即杀」回收会静默杀死这些任务。
3. **但内存代价真实**:2026-10-02 本机实测(`.tmp-mem-ab.log` 方法),3 个 workspace
   各常驻一个 chat 进程,闲置进程提交内存 ~160-200MB/个(工作集被 Windows 修剪到
   13-80MB,提交不还);CLI 层合计提交 ~965MB。CLI 内 session 驻留池 10 分钟驱逐空闲会话
   (`apps/acode-cli/packages/bootstrap/src/acode-protocol/session-resident-pool.ts:9`),
   但 Node 进程基线常驻。
4. **静默事实 90% 已有现成接口**(详见 R1 条件表):逐会话的 `readResidencyFacts`
   (`bootstrap/src/acode-protocol/session-residency.ts:76-93`)聚合了 Core 权威判据
   (`core/src/runtime/methods/residency.ts:21-28`:active/queued turn、running 后台任务、
   detached sidecar 计数、记忆抽取 pending);v4 侧有 `hasResidencyBlockingCommands`
   (`bootstrap/src/acode-protocol-v4/v4-gateway.ts:2535-2537`)、订阅者计数(`:2656-2658`)、
   MCP `pool.stats()`(`adapters/src/mcp/pool.ts:410-417`)。缺口只有四个小访问器(R5)。
5. **Off-Peak / automation(cron)调度器不在 CLI 进程内**:调度在 desktop main fork 的
   scheduler utilityProcess(`packages/desktop/src/main/desktopCronScheduler.ts:59-71`),
   派发经 Host → `getClient()`(`acodeAgentProcessManager.ts:875-931`)——**进程不在时
   自动懒重启**;无可用 Host 时 transient 回执 + 独立退避重试、顺延不丢弃
   (`desktopCronScheduler.ts:113-124、:151-162`)。因此空闲退出不丢定时/闲时任务,
   静默判定也无需查询它们的队列(那是 Host 事实);进行中的闲时/定时轮就是普通 turn,
   被 R1 的 turn 判据挡住。
6. **退出归因存在明确缺口**:Host 归类 `terminationKind = managed.terminationIntent?.kind
   ?? "unexpected"`(`acodeAgentProcessManager.ts:1268`),且注释明说「signal crash 和
   长期运行的 Agent 自行 exit 0 同样是非预期退出」(`:1298-1300`)。`recordTerminationIntent`
   (`:711-729`)只允许 Host 主动回收建立 expected 意图,protocol close 不得把异常改写成
   expected。**CLI 主动退出必须在 protocol close 之前送达显式信号**,否则会被记为崩溃
   (errorLog + reporter.onExit unexpected)。
7. **恢复链现成可用**:进程退出 → Host 按 protocol close 回收进程树并摘除登记
   (`:1370-1392`)→ 下一次 `getClient()` 懒重启(`:875-931`,按 workspaceKey 收敛并发
   启动)→ `runtimeRestarted` 仅在真实 spawn 后发布(`:1191-1199`,防「假重启→重连→
   自激风暴」)→ v4 订阅方重订、按水位回放/冷恢复
   (`bootstrap/src/acode-protocol-v4/cold-session-resume.ts`、`replay.ts`)。
8. **优雅退出链现成可用**:CLI 唯一退出 owner `createProtocolProcessLifecycle`
   (`apps/acode-cli/packages/cli/src/protocol-lifecycle.ts:10-90`,flush + 1.5s deadline),
   stdin-EOF 路径的清理链 `cleanupProtocolRuntime`
   (`bootstrap/src/acode-protocol/runtime-cleanup.ts:12-66`,总预算 1.2s)已覆盖:停采样器、
   `server.shutdown()`(含杀后台 bash、abort 插件操作、关闭记忆抽取)、dispose v4 投影、
   关 node_repl browser broker / mcpPort / MCP pool(树杀 MCP 与 `__acode-plugin-host`
   子进程)、关 sqlite session store。
9. **持久化边界**:CLI 进程内唯一的 sqlite 连接是 session 库
   (`bootstrap/src/acode-protocol-entrypoint.ts:152-166`);tasks-index.sqlite 属 Host。
   纯内存事实(inbox settled LRU、runtime task registry 终态条目、v4 投影)均有 durable
   回源路径(`acode-protocol-v4/command-inbox.ts:263-266、:302-311`);WAL 由下次 open
   自动恢复。频繁重启的增量成本 = 每次冷启动重跑迁移门禁(与 prepare worker 的锁竞争面
   已有 BUSY 分类与退避,`adapters/src/storage/session-store/migration-runner.ts:113-120`)。

### 收益范围(诚实声明)

R1 把「存在订阅者」列为静默阻断条件:**正在被 UI 观看的 workspace/会话不会被回收**。
收益来自不再被观看的进程——切走的 workspace tab、关闭的会话面板(renderer 侧
`sessionDataLayer` keep-warm 30s 后释放订阅,`packages/ui/src/v4/sessionDataLayer.ts:139-149`)。
若 UI 对不可见面板仍持有订阅(如 forceMount 的隐藏 session tab),对应进程不会被回收——
这是安全语义的正确结果,收益兑现依赖 UI 订阅生命周期,见 R6 与「后续项」。

## 产品规则

### R1 静默判定:owner 是 CLI,条件集是白名单

CLI 进程自己拥有全部地面真相,静默判定**必须**在 CLI 侧完成;Host 不得基于
「无在飞请求」推断 chat 进程可杀(维持现状禁令)。判定公式:

```
quiescent =
    无 Host→CLI 在飞请求(transport 串行队列空闲 且 server 无 pending 反向请求)
  && 无协议操作租约(SessionResidentPool.activeOperationCount === 0 且无 in-flight deactivation)
  && ∀ 驻留 session(context.sessions 全量,复用 readResidencyFacts):
       !hasResidencyBlockingWork   // active/queued turn、running 后台任务(bash/agent/
                                   // workflow/dwf/monitor)、detached sidecar、记忆抽取 pending
       && !hasPendingInteractions  // v4 interaction registry + legacy 权限 broker
       && !hasQueuedCommands       // publisher 队列 + inbox pinned(inFlight/liveInputs)
       && !hasSubscribers && !hasLegacySubscriber
  && 无未提交/未过期的附件暂存上传(attachment-upload-registry)
  && 存储静默(无迁移/写入在飞;镜像 Host 门禁语义,含 storageStartup 未处于 waiting)
```

后台 bash、detached subagent、legacy Workflow 子进程、dwf run 都被
`hasResidencyBlockingWork` 的 registry 判据覆盖
(`core/src/runtime-task/registry.ts:318-322`,任务类型 `local_bash | local_agent |
local_workflow | local_dynamic_workflow | monitor_mcp`),不另立条件。

### R2 空闲退出:搭现有节拍,连续静默 N 分钟才退

- **节拍**:静默自检搭 60s 资源采样器的既有节拍
  (`bootstrap/src/acode-protocol/resource-sampler.ts:30-38`,它已是驻留池 rebalance 的
  兜底驱动),不新增独立 timer。每次采样全清则累计,任一条件不满足即清零重计。
- **阈值 N**:默认 15 分钟(> 驻留池 10 分钟驱逐,保证「先释放会话、后释放进程」的
  层级顺序)。Host 经 spawn env `ACODE_AGENT_IDLE_EXIT_MS` 调节;`0` = 禁用(完全回到
  现状行为);缺省 = 默认值。该 env 是 Host→CLI 的装配通道(与 `ACODE_WORKSPACE_IDENTITY`
  同模式,`packages/services/src/runtime-tools/agentProxyEnv.ts:116-122`),不是用户 env
  注入面;打包态 env 门禁(`agent-command-env-gate.md`)不受影响。
- **退出路径**:复用 stdin-EOF 等价的优雅链——先发 R3 通知,再走
  `lifecycle.requestShutdown()` → `waitForClose()` → finally `cleanupProtocolRuntime`
  → `lifecycle.complete(保留退出码)`。**禁止 `process.exit` 硬跳**(POSIX 下会留孤儿
  MCP/插件宿主子进程;优雅链才有树杀,`adapters/src/mcp/stdio-transport.ts:155-174`)。
- **适用范围**:仅 chat lane 常驻 `app-server --stdio` 模式。`--prepare-storage` 短命
  模式、headless `--prompt`、TUI、plugin lane、mcp-status lane(已有自己的回收)一律
  不适用。

### R3 退出归因:显式通知为主、保留退出码兜底

- **协议新增**(落 `packages/shared/src/acode-protocol/index.ts`,严格类型 + 运行时校验,
  注册进 `acodeProtocolMethods`):CLI→Host 通知 `runtime/idleExit`,params
  `{ quiescentMs: number }`(仅诊断用途;Host 不据此重新判定)。
- **Host 收到通知**:立即记录终止意图 `{ kind: "expected", reason: "cli-idle-exit" }`
  (`AgentProcessCleanupReason` 联合类型扩一个值)。这是 `recordTerminationIntent`
  「只有 Host 主动回收能建立 expected」规则的**显式扩展点**:意图来源是 CLI 的声明帧,
  不是 Host 的推断,protocol close 仍不得改写异常(原不变量保持)。
- **宽限**:通知后 10s 内进程未退出 → Host 主动走 `cleanupManagedProcessWithRetry`
  (归因 idle-timeout),防止「声明了退出却卡死」的进程悬挂。
- **兜底**:进程以**保留退出码 85**(实现时核对与既有 0/1/129/130/143 无冲突)退出且
  无通知送达 → Host 仍归因 expected/`cli-idle-exit-code`,不打 unexpected errorLog。
  覆盖「通知帧与退出竞态/旧 Host 不识别通知」的降级面。
- **可观测**:退出走既有 `reporter.onExit`(terminationKind=expected +
  terminationReason),Host 打一条 info 级 `ACode agent process idle-exited`(含
  workspaceKey、pid、quiescentMs、uptimeMs),与既有
  `ACode agent process idle timeout; reclaiming` 日志对称。

### R4 重启纪律:只有交互路径可以拉起进程

- 空闲退出后 Host **不自动重启**。唯一拉起路径是既有 `getClient()` 懒重启
  (交互动作:sendText/v4 command、打开会话、Off-Peak/cron 派发、workspace 展示读取等
  主动请求)。
- **被动路径审计是验收项**:所有「observer 性质」的调用必须走 peek 入口
  (`acodeAgentProcessManager.ts:933-935`,「被动 observer 使用本入口避免 getClient 的
  隐式 spawn」)或容忍「进程不在 → 返回持久化事实/空结果」。实现时逐一列出
  `getClient()` 调用点并分类(交互/被动),被动误用即缺陷。
- `runtimeRestarted` 仅在真实 spawn 事件后发布(现状不变量,`:1191-1199`,钉进测试),
  订阅方重订不得成为隐式 spawn 源。
- **无风暴验收**:回收后无用户动作时,观察窗(≥30 分钟)内不得出现自动重启或
  spawn/exit 循环。

### R5 需要新增的最小接口(白名单,禁止扩散)

| 缺口 | 位置 | 新增 |
| --- | --- | --- |
| 在飞请求数 | `bootstrap/src/acode-protocol/transport.ts:43`(processing 队列)、`server.ts:220`(pendingClientRequests,private) | 只读计数访问器 |
| 操作租约数 | `session-resident-pool.ts:64-66、:222-224`(activeOperationCount / inFlightDeactivations,private) | 只读计数访问器 |
| 附件暂存 | `bootstrap/src/acode-protocol-v4/attachment-upload-registry.ts:20-30` | 未提交条目计数 |
| 静默聚合 | bootstrap 协议层 | `collectQuiescenceFacts()` 单一聚合函数(组合上表 + 既有 readResidencyFacts/getQueueLength/pool.stats),供自检与 memoryDiagnostics 共用 |

其余判定一律复用既有接口,不新造平行状态(治理红线:避免重复状态和多条写入路径)。

### R6 数据安全与两种链路语义

- **不丢已受理输入**:存在 queued/pinned 命令即非静默(R1);退出时 CommandInbox 内存态
  丢弃是安全的——settled 幂等事实可从 durable 四级回源
  (`command-inbox.ts:302-311`),排队中的输入本身是持久化命令事实
  (`persistent-command-facts.ts`),重试语义靠 commandId 幂等兜底。
- **会话连续性**:会话事实全持久化,重启后经冷恢复透明重建
  (`cold-session-resume.ts:1-10`);丢失的只是内存投影/事件缓存,由订阅水位
  (logEpoch/seq)+ 回放补齐。**desktop-continuous 与 web-remote-replayable 两种语义
  都必须验证**(AGENTS.md 红线:修改 stream/snapshot/queue/重连时同时验证)。
- **手机远控**:attachment 场景同 R1 阻断;远控会话活跃即有订阅者/turn,天然不回收。

### R7 开关与灰度

- 默认启用,N=15 分钟。`ACODE_AGENT_IDLE_EXIT_MS=0` 完全禁用(回归到现状,验收场景 9)。
- 不新增用户可见设置项(首版);若后续需要,走既有 settings 面另立 spec。
- dev 源码态与打包态行为一致(env 由 Host 装配,不经用户环境)。

## 状态与事件时序(所有者视图)

```mermaid
sequenceDiagram
    participant UI as Renderer(订阅方)
    participant Host as Host services(ProcessManager)
    participant CLI as CLI app-server(chat lane)
    participant Sched as Desktop main(scheduler)

    Note over CLI: 60s 采样节拍:collectQuiescenceFacts()
    CLI->>CLI: 连续 K 次全清(K×60s ≥ N)
    CLI--)Host: runtime/idleExit {quiescentMs}(通知)
    Host->>Host: 记录 terminationIntent=expected/cli-idle-exit(10s 宽限)
    CLI->>CLI: requestShutdown → cleanupProtocolRuntime(优雅链,树杀 MCP/插件宿主)
    CLI--xHost: exit(85)
    Host->>Host: exit 归类 expected(通知或退出码兜底),reporter.onExit,摘除登记
    Note over Host: 不自动重启;UI 无错误态
    Sched->>Host: (任意时刻)cron/off-peak 派发
    Host->>CLI: getClient() 懒重启(spawn,generation+1)
    CLI--)Host: startup/storageState …(既有启动门禁)
    Host--)UI: runtimeRestarted(仅真实 spawn 后)
    UI->>Host: 重订(topic+水位)→ snapshot/resume 回放
    Host->>CLI: 派发命令(CommandInbox admission,commandId 幂等)
```

所有者划分:静默事实与退出决策 = CLI;归因、宽限、懒重启、订阅恢复 = Host(ProcessManager);
调度与派发重试 = desktop main scheduler;订阅生命周期 = Renderer(sessionDataLayer)。

## 验收场景(E2E)

1. **闲置回收发生**:打开 workspace B 后切到 A,B 订阅释放、全静默持续 N → B 进程退出;
   归因 expected/cli-idle-exit;无 unexpected errorLog;UI 无错误提示;资源管理器中
   B 进程消失。
2. **后台 bash 阻断**:B 有 running 后台 bash → 超过 N 不退。
3. **排队命令阻断**:B 的 inbox 有 pinned/queued 命令 → 不退。
4. **pending 权限阻断**:B 有未决 permission/userInput → 不退。
5. **附件中间态阻断**:B 有未提交附件上传 → 不退。
6. **定时任务自动拉起**:B 被回收后 cron/off-peak 到点 → 派发经 getClient 自动 spawn →
   任务正常执行 → 结束后重新进入静默计时。
7. **冷启动无缝**:B 被回收后首次 sendText → 懒重启 → 命令被 admission 受理(等待
   spawn 完成),不丢、不重复执行。
8. **订阅恢复双语义**:重启后 v4 订阅方经 runtimeRestarted 重订、按水位回放,
   desktop-continuous 与 web-remote-replayable 终态一致。
9. **开关回归**:`ACODE_AGENT_IDLE_EXIT_MS=0` → 行为与现状完全一致(不退出、无通知)。
10. **优雅链完整**:退出时 MCP 子进程/`__acode-plugin-host` 全树杀(POSIX 无孤儿)、
    sqlite 正常关闭、node_repl broker net server 关闭(事件循环不被钉住)。
11. **通知丢失兜底**:模拟通知未送达、进程以 85 退出 → Host 仍归因 expected,
    无 errorLog。
12. **无风暴**:回收后无用户动作,≥30 分钟观察窗内无自动重启、无 spawn/exit 循环。

## 测试与验证

- 单元(CLI):`collectQuiescenceFacts` 各条件的组合真值表;计时器「任一条件破坏即
  清零」;N 的 env 解析(缺省/0/自定义)。
- 单元/集成(Host):通知 → terminationIntent 记录;宽限回收;退出码兜底归因;
  `AgentProcessCleanupReason` 扩展后的 reporter 字段。
- E2E:场景 1、6、7、8、12(交互改动,E2E 必测);其余场景至少集成级覆盖。
- 既有门禁:`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`;
  协议 schema 变更走 `packages/shared/src/acode-protocol` 的运行时校验测试。
- 收益验证:沿用 `.tmp-mem-baseline.mjs` 快照法(提交内存口径),回收前后对比;
  Host `reporter.onExit`(reason=cli-idle-exit)作为回收事件的事实源。

## 已知诚实边界(记录,不在本 spec 修)

- **冷启动延迟**:回收后首次交互需等 spawn + 存储门禁(预期 1-2s 量级,实现时实测)。
  缓解:N=15min 远大于交互间隔;storage prepare 已把迁移挪出常驻启动路径。
- **workspace 来回切换的 thrash**:极端情况下反复 spawn/exit。N 与 keep-warm(30s)
  已天然抑制;若上线后观察到 thrash,加退出后最小存活退避,不在首版预置。
- **UI 订阅生命周期是收益前提**:forceMount 隐藏面板持有订阅 → 对应进程不回收
  (安全语义正确,收益打折)。「不可见面板释放订阅」属 renderer 侧独立改动,
  列后续项(关联 `packages/ui/specs/renderer-memory-budget.md`)。
- **plugin lane 不回收**:plugin 进程管理器(`acodeAgentService.ts:1078`)维持现状;
  其空闲特征与 chat 不同,需单独评估。
- **版本偏差**:旧 Host + 新 CLI 时通知被忽略、退出码兜底同样依赖新 Host 的归因表——
  偏差仅存在于 dev 混跑场景(monorepo 同构建),接受为诊断噪音,不做能力协商。
- **锁竞争面**:每次冷启动重跑迁移 checking,与 prepare worker/其他 lane 的 BUSY
  竞争已有退避;回收频率(≥15min/进程)不改变竞争量级。

## 后续项(非本 spec 范围)

- Renderer 不可见面板的订阅释放(收益放大器)。
- v8 堆上限护栏(Host fork `desktopHostProcess.ts:243-249` 与 app-server spawn 的
  `--max-old-space-size`),独立小改动,可并行。
- 用户可见的「低内存模式」设置项(若产品需要)。
