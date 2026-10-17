# agent 进程备用预热:spare 进程池与 miss 闭集(agent-process-prewarm)

会话启动加速项。给 chat lane 的 `ACodeAgentProcessManager` 增加**备用(spare)agent 进程池**:
host 装配后预先孵化 1 个不绑定任何 workspace 的待命 `app-server --stdio` 进程;首个
`getClient` 到来时**认领(claim)**该进程并把它登记为目标 workspace 的 runtime,省掉冷启动的
进程 spawn + Node/bundle 解析 + SQLite 迁移 + Provider Registry 启动。认领即补位;miss 原因走
封闭词表进 info 日志。机制移植自 2.37337 价值提取清册 T2-5 / T1-1 第 7 件(sparePrewarm +
SpareMissReason 闭集),只搬机制设计,不带任何厂商代号。

本 spec 只覆盖 `packages/services`(acode-agent 模块 + node.ts 装配);不改 CLI、shared、desktop。

## 档位判决:①完整 spare 进程池(可行,已按证据裁决)

任务给定的降级序列是 ①完整 spare 进程池 → ②spawn 前置开销预热 → ③仅 miss 词表登记。
**盘点结论:①可行**。关键可行性问题是「agent 进程启动是否需要 workspace/凭据/会话 id 绑定」,
逐面盘点如下(行号以 2864472 检出为准):

### 证据:workspace 绑定是 per-request 的,不是 spawn 时的

1. **session 创建按请求携带 workspace ref**:`session/create` 的 params 含
   `workspace: {workspaceKey, workspacePath, workspaceIdentity?}`
   (`apps/acode-cli/packages/bootstrap/src/acode-protocol/server-operations.ts:1134-1200`,
   `createSessionWithProjection` 直接消费 `params.workspace`)。
2. **per-session app 的执行 cwd 来自请求而非进程 cwd**:`createWorkspaceACodeApp` 把
   `runtimeConfig.workingDirectory = params.workspace.workspacePath` 注入 app,并单独注入
   `workspacePath`/`workspaceIdentity`/`remoteSessionId`
   (`apps/acode-cli/packages/bootstrap/src/acode-protocol/workspace-model-runtime.ts:32、54、82-95`)。
3. **MCP/presentation 同样 per-request**:协议层 `mcpList` 用
   `params.workspace.workspacePath` 当 workingDirectory
   (`apps/acode-cli/packages/bootstrap/src/acode-protocol/mcp.ts:40-43`);
   `readWorkspacePresentation` 同形态(`workspace-model-runtime.ts:20-36`)。
4. **session DB 是全局的**:缺省 `sessionDbPath = "~/.acode/cli/db/db.sqlite"`
   (`apps/acode-cli/packages/contracts/src/config/index.ts:330`);agent 主路径
   `getSessionDbPath(configResult)` 不带 cwd 参与解析
   (`apps/acode-cli/packages/bootstrap/src/acode-protocol-entrypoint.ts:154-168`;只有
   `prepareStorageOnly` worker 路径显式传 cwd 解析相对路径,`:89-101`)。storage startup 与
   workspace 无关,备件的存储就绪事实对任何 workspace 都同样成立。
5. **Provider Registry 是进程级全局事实**:`startProcessProviderRegistryRuntime(runtimeEnv)`
   从用户级配置重建(entrypoint `:171-184`),与 workspace 无关;任何按需 spawn 的 agent 进程
   都持有同一份用户级凭据面——备件**不扩大**该暴露面。
6. **spawn 时注入的 workspace 身份 env 只是兜底**:host 侧
   `buildAgentWorkspaceIdentityEnv(params.workspaceIdentity)`
   (`packages/services/src/acode-agent/acodeAgentProcessManager.ts:1095`、
   `packages/services/src/runtime-tools/agentProxyEnv.ts:116-121`)注入
   `ACODE_WORKSPACE_IDENTITY`;CLI 侧唯一消费点是官方 MCP auth 的 workspace **fallback**,且
   源码注释明说「agent 进程当前没有 identity 来源,因此实际多为 undefined」
   (entrypoint `:201-218`);per-request 的 connect 会显式带
   `workspaceIdentity`(`mcp.ts:87`)。备件缺该 env 不改变会话期行为。
7. **host 侧 1 进程=1 workspace 是登记语义,不是 CLI 限制**:manager 按
   `resolveWorkspaceKey`(identity||path)键控进程池
   (`acodeAgentProcessManager.ts:602、897-953`);认领后把备件登记到目标 key 即可,所有
   per-workspace 假设(runtimeIdentity、v4 订阅重订、activeClientsByWorkspaceKey)保持成立。

### 诚实登记的 spawn-cwd 残差(认领后与按需进程的已知差异)

- **dev-only `.env`**:非打包态协议入口从进程 cwd 读 `.env`
  (`apps/acode-cli/packages/cli/src/run.ts:263-272`);打包态经
  `shouldLoadCliDotenvForProtocolServer` 跳过。备件 cwd 是中性目录 → dev 形态下认领进程不带
  目标 workspace 的 `.env`。预热默认只在 desktop-local host 启用(见 R6),该形态即打包态;
  dev 强制开启时接受此差异。
- **MCP pool 缺省 workingDirectory**:连接池以进程 cwd 为 fallback
  (`apps/acode-cli/packages/adapters/src/mcp/index.ts:193-197、1647-1657`);per-session /
  per-workspace 连接都自带 workingDirectory(证据 2/3),fallback 只影响不带 workspace 的
  设置级探测(`protocol-settings` lease)。mcp-status lane 用独立 manager,不走备件,不受影响。
- **设置漂移**:代理/官方开关等 `resolveSpawnEnv` 内容在预热时读取;认领前用户改设置,备件
  仍带旧值。与既有「下次启动生效」语义一致(备件就是一次提前发生的启动),不额外补偿。
- **CUA 姿态**:见 R5 认领门禁。

## 背景

### 已核实的现状

1. **冷启动成本真实存在**:桌面 host 启动时按 workspace 预热
   `warmUpACodeAgent → initializeWorkspace → getClient → startClient`
   (`packages/desktop/src/host/index.ts:844-887`;
   `acodeAgentProcessManager.ts:1011-1122`),spawn 后 CLI 侧还要走 SQLite 迁移、Provider
   Registry、MCP pool、browser broker(entrypoint `:148-329`)。仓库已有字节码入口把就绪时间
   降 44%(`acodeAgentProcessManager.ts:468`,docs/j5-performance-baseline.md §3),预热是同一
   目标的进程维度补完。
2. **chat lane CLI 空闲自退缺省 15 分钟**(`packages/shared/src/acode-agent-idle-exit.ts:25-26`,
   spec chat-lane-idle-reclaim.md):无会话的备件会被 CLI 自己按静默阈值退出(exit 85 +
   expected 归因已就绪,`acodeAgentProcessManager.ts:1356-1404`)。池把该退出当**备件 TTL**
   消费:观察丢失 → 冷却 → 补位。
3. **spawn 装配面复杂且不可复制**:env 组装(sanitize、runtime env、代理、CUA、heap guard、
   E2E coverage、字节码回退标志)、admission hook、代际/ disposed 双检查全部集中在
   `startClient`(`acodeAgentProcessManager.ts:1011-1502`)。备件 spawn **必须复用**该路径,
   不允许第二套 spawn 实现(单一写入路径纪律)。
4. **进程生命周期上报**:`processLifecycleReporter.onSpawn/onExit` 以 spawn 时闭包捕获的
   `params.workspacePath` 归属 workspace(`:1297-1311、1418-1440`);认领改绑后若不换成
   managed 上的可变事实,desktop 进程监控会把认领进程的退出归到预热目录名下。

## 产品规则

### R1 池形态与所有权

- 池是 `ACodeAgentProcessManager` 的**内部组件**(新模块
  `acodeAgentSparePrewarm.ts` 提供纯状态机,manager 提供 spawn/claim 执行面);仅
  `options.sparePrewarm` 显式传入时启用。chat lane 主 manager 是唯一启用点
  (`acodeAgentService.ts:1069` 经 options 直通);plugin / mcp-status lane 的显式字段装配
  (`:1091-1110`)不透传,天然关闭。
- 池大小缺省 1,上限 4(env 调优,见 R6)。认领即补位:claim 同步取出备件后立即调度补充。
- **唯一所有者**:待命进程与认领后进程的 OS 生命周期都归 manager 既有
  `ownedProcesses`/`cleanupManagedProcess` 体系;池只持有「哪些 managed 处于待命态」的索引,
  不另建 kill/dispose 路径。app 退出走既有 `disposeAll/disposeAllAndWait`,备件随
  `ownedProcesses` 统一回收(`:1598-1637`)。
- 备件 spawn 复用 `startClient`,以合成 key `__acode-agent-spare__:<uuid>` 登记;
  合成 key 永不与 `resolveWorkspaceKey`(identity||path)的真实 key 相等(前缀含 `__` 与
  `:` 的保留形态,且池索引不依赖 map 查找)。

### R2 认领(claim)语义

- 认领点是 `getClient` 的 spawn 决策位:既有进程/在飞启动命中时**不认领、不打 timing 日志**
  (那不是进程获取事件);否则同步尝试认领,失败走原 `startClient` 冷启动路径。
- 认领必须**全同步**(无 await),因此天然单飞:两个 workspace 并发 `getClient` 只有一个拿到
  备件,另一个得到 `spare_miss_consumed_race` 并冷启动。同 workspace 并发仍由既有
  `startingByWorkspaceKey` 收敛。
- 认领动作(rekey):
  1. `managed.workspaceKey` 改为真实 key,`managed.workspace` 写入真实
     workspacePath/identity;`processesByWorkspaceKey` 从合成 key 迁移到真实 key;
  2. `runtimeGeneration` 按真实 key 递增,`runtimeIdentity` 以真实 key 重建
     (generation/pid/lane 组成不变式保持);
  3. generation>1 时 fire `onRuntimeRestarted`(v4 订阅方重订,与正常 spawn 换代同语义),
     随后 fire `onRuntimeLifecycle(available)`——顺序镜像 `child.once("spawn")` 内既有顺序;
  4. 待命期被抑制的 lifecycle/storageStartup 事件以真实 key 补发一次当前快照。
- `startClient` 内所有以闭包捕获 `workspaceKey`/`params.workspacePath`/`runtimeIdentity`
  做**登记、判等或上报**的 handler,一律改读 `managed` 上的当前值(日志文本字段同样),保证
  认领后事件归属真实 workspace;正常(非备件)进程两者恒等,行为不变。
- 只读路径(`getExistingClient`、`getRuntimeIdentity`、service 层
  `getReadOnlyClient(existing-only)`)永不认领:被动 observer 不得把备件变成活动进程
  (对齐 `:1504-1516` 既有纪律)。

### R3 miss 原因闭集与 timing 日志

- `getClient` 每次走到进程获取决策(claim 或冷启动)时打一条 info:
  `"ACode agent session start timing"`,字段 `{outcome, workspaceKey, acquisitionMs}`,hit 时
  追加 `{sparePid, spareAgeMs, storageReady}`。`outcome` 是封闭词表(写入侧唯一工厂):

  | outcome                    | 语义                                                                               |
  | -------------------------- | ---------------------------------------------------------------------------------- |
  | `spare_hit`                | 认领到待命进程                                                                     |
  | `spare_miss_not_warmed`    | 池启用但无备件且无「认领消耗」在补位(首暖未完成/备件 idle-exit 或长寿丢失后冷却中) |
  | `spare_miss_consumed_race` | 备件刚被认领消耗,补位在飞/已排程(含并发竞态输家)                                   |
  | `spare_miss_spawn_failed`  | 补位 spawn 失败退避中或熔断打开                                                    |
  | `spare_miss_ineligible`    | 有备件但认领门禁拒绝(见 R5)                                                        |
  | `spare_miss_disabled`      | 池未启用(kill switch / size=0 / 非法配置 fail-safe)                                |

- 词表纪律(对齐波次 1 `error-taxonomy-injection-defense` 的双收窄):
  - 写入侧:`narrowAgentSpareStartOutcome(unknown) → outcome | null`,只认闭集字面量,
    非法值返回 null,调用方省略字段而不是透传;
  - 自由文本(如 spawn 失败的 `errorName`)进日志前经白名单
    `/^[A-Za-z][A-Za-z0-9_]{2,63}$/` 收窄(`narrowAgentSpareErrorName`),不匹配落
    `unknown_error`;错误 message/stack 一律不进该日志(既有 errorLog 已承载)。
  - `outcome` 字段不使用保留键名 `status`(contracts/logging 保留闭集键,避免撞集)。
- 未传 `sparePrewarm` 选项的 manager(远程 host、测试、plugin/mcp-status lane)不打该日志。

### R4 补位调度与反风暴

- 补位触发点:池启用后的首暖(host 装配后 `warmDelayMs`,缺省 1500ms,unref timer,不与
  host 启动峰值抢事件循环)、认领后(`replenishDelayMs`,缺省 250ms)、备件丢失后(按下述
  分类)。
- 备件丢失分类:
  - **认领消耗** → 立即补位(上面的 replenishDelayMs);
  - **长寿丢失**(存活 ≥ `minSpareLifetimeMs`,缺省 60s;含 CLI idle-exit 15min TTL、正常
    退出)→ 冷却 `lossCooldownMs`(缺省 30s)后补位。idle-exit 循环因此是
    「15min 存活 + 30s 冷却」的有界节拍,不是紧循环;
  - **短寿丢失**(< minSpareLifetimeMs,spawn 成功但早夭/崩溃)与 **spawn 失败**(startClient
    reject / child error)→ 指数退避 `failureBackoffBaseMs·2^n`(缺省 5s 起,上限
    `failureBackoffMaxMs` 缺省 5min);连续 `circuitFailureThreshold`(缺省 3)次 →
    **熔断**:停止补位,warn 一次(含收窄后的 errorName),此后 timing 日志 outcome 记
    `spare_miss_spawn_failed`。熔断只在 manager 生命周期内有效,不持久化。
- 所有池 timer 一律 `unref`,不得把 host 进程钉在事件循环里(对齐 `:728-730` 既有纪律)。
- manager `disposed` 后池拒绝一切补位;在飞备件 spawn 经自有 AbortController 中止
  (复用 `startClient` 的 admissionSignal 检查点)。

### R5 安全边界与认领门禁

- **认领前备件不得持有**:workspace 身份 env(`ACODE_WORKSPACE_IDENTITY` 不注入——预热
  context 无 identity)、任何会话数据(无 session 被创建)、目标 workspace 的 cwd
  (spawn cwd = 中性 `prewarmCwd`,缺省 `os.homedir()`,可配)。
- **如实登记**:备件持有用户级全局材料——provider/account 配置(证据 5)、设置页代理与官方
  开关 env(`resolveSpawnEnv` 预热 context 解析)。这与任何按需 spawn 的 agent 进程同面,
  不是预热引入的新暴露;但它是「预热进程在用户还没打开任何 workspace 时就持用户级凭据材料」
  的产品事实,默认只在 desktop-local host 启用(R6)以限定形态。
- **CUA 认领门禁**:`resolveSpawnEnv` 的 CUA broker env 依赖 workspace context
  (`packages/services/src/node.ts:2160-2240`:darwin 懒启动 socket / win32 helper token +
  per-workspace registry bookkeeping)。预热 context 的 CUA 姿态与认领目标可能不一致
  (workspace 级官方插件 enablement)。门禁经两个注入 hook 实现,CUA 知识留在 node.ts:
  - `collectSpawnContextFacts(prewarmContext) → Record<string, boolean>`:备件 spawn 时记录
    `{cuaEnabled}`;
  - `resolveClaimEligibility(targetContext, spare) → boolean`:目标 workspace CUA 启用而
    备件 spawn 时 CUA 未启用 → 拒绝认领(outcome=`spare_miss_ineligible`),走冷启动
    (冷启动路径会完整执行 helper admission)。反向(备件带 CUA env、目标未启用)无害:
    插件未启用则 computer-use MCP 不会被装配。
  - 门禁必须同步可判(`isCuaEnabledForContext` 是同步函数,`node.ts:1692-1700`),否则会
    破坏 R2 的全同步认领。

### R6 配置与 kill switch(env,ACODE\_ 前缀规约)

- `ACODE_AGENT_SPARE_PREWARM`:`"1"` 强制启用(任意 authority mode,dev 试验用)、`"0"`
  强制关闭(kill switch)、其他非法值视同未设置;未设置时缺省策略 = 仅
  `serviceAuthorityMode === "desktop-local"` 的 host 启用(远程 SSH/WSL server host 内存
  敏感,不默认常驻备件;desktop-attached-remote 同不启用)。
- `ACODE_AGENT_SPARE_POOL_SIZE`:十进制整数,clamp 到 [0,4];`0` = 关闭;非法值 fail-safe
  关闭预热(对齐 `resolveACodeAgentIdleExitConfig` 的 fail-safe 纪律)并 warn 一次。
- 解析是纯函数 `resolveAgentSparePrewarmConfig(env, {isDesktopLocalAuthority})`,node.ts
  装配时调用;结果对象含 `{enabled, poolSize, disabledReason?}`,disabledReason 供装配日志。
- env key 常量定义在 services 模块内(host 侧唯一消费方);不进 `packages/shared`
  (CLI 不读这两个 key,无跨包契约面)。

### R7 desktop 宿主接线

- **无需改 packages/desktop**:desktop host 以 `serviceAuthorityMode: "desktop-local"` 调
  `createLocalServices`(`packages/desktop/src/host/index.ts:2243`),装配在
  `packages/services/src/node.ts` 完成;`CreateACodeAgentServiceOptions extends
Omit<ACodeAgentProcessManagerOptions, …>`(`acodeAgentService.ts:867-873`)使
  `sparePrewarm` 选项直通 chat lane manager。既有 per-workspace `warmUpACodeAgent` 不变:
  它经 `getClient` 自然成为第一个认领者。
- 进程监控面:备件 spawn 时照常上报 `onSpawn`(workspacePath=prewarmCwd,诚实反映待命
  进程);认领不重复上报 spawn;认领后 `onExit/onException` 以 managed 当前 workspace 上报
  (R2 第 5 条)。

## 验收场景

1. **认领命中**:池启用且备件就绪后,首次 `getClient(workspaceA)` 返回备件的 client,
   timing 日志 outcome=`spare_hit`;不产生第二个进程(spawn 事件计数=1);池随后补位。
2. **认领竞态单飞**:备件 1 个,两个不同 workspace 并发 `getClient`:恰一个
   `spare_hit`,另一个 `spare_miss_consumed_race` 并各自冷启动成功。
3. **kill switch**:`ACODE_AGENT_SPARE_PREWARM=0` → 池不 spawn 任何备件,timing 日志
   outcome=`spare_miss_disabled`,getClient 行为与预热不存在时一致。
4. **词表闭集**:`narrowAgentSpareStartOutcome("spare_hit; DROP TABLE")` → null;
   `narrowAgentSpareErrorName("Error: boom\ninjected")` → `unknown_error`;合法
   `ENOENT` → 原样。timing 日志 outcome 字段恒 ∈ 闭集。
5. **失败反风暴**:备件 spawn 连续失败(命令不可执行)→ 退避递增,第 3 次后熔断,warn
   恰好一次;熔断后 getClient 记 `spare_miss_spawn_failed`,冷启动路径不受影响。
6. **dispose 统一回收**:存在待命备件时 `disposeAllAndWait()` → 备件进程树被回收
   (exit 事件到达),池 timer 清空,后续 getClient 抛既有 disposed 错误。
7. **认领门禁**:注入 `resolveClaimEligibility` 返回 false → 不认领,outcome=
   `spare_miss_ineligible`,冷启动进程正常服务,备件留在池中。
8. **只读路径不认领**:`getExistingClient` / `getRuntimeIdentity` 在有备件时不消耗备件、
   不打 timing 日志。
9. **真实冒烟**(仓库进程 fixture 惯例,`node -e` 假 CLI,对齐
   `test/acodeAgentIdleExitAttribution.test.ts`):真实 spawn 备件 → 认领 → 返回的 client
   与备件同 pid;认领后 workspace 的 `getRuntimeIdentity` 给出真实 key 的 identity。
