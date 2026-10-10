# Codex 编排方案对照实现审计报告（2026-10-10）

> **审计对象**：[codex-orchestration-integration-plan.md](codex-orchestration-integration-plan.md)（生成于 2026-10-09，核实基线 `dev/0.0.9 @ 2855cce`）。
> **审计检出**：`dev/0.0.7`（HEAD `372f40f`，已合并 dev/0.0.9）。
> **方法**：5 路独立核对员按方案五个区域分工，对 65 条承重论断逐条读当前源码、按「文件名 + 符号名」重定位并引用 file:line 证据；再由 1 名未参与核对的独立复核员对全部偏离方案的结论（2 条 invalid）、全部安全论断（R1/R2/五道门/§6.1/§6.2）及 2 条 holds 抽查逐一反驳——**9/9 confirmed，0 refuted，0 unclear**。
> **性质**：只读审计，不改代码、不改 spec。本报告与对方案文档的定点修订（见 §4）是全部产出。

---

## 0. 总判定

**方案「未实施」的自述在当前检出仍然准确。** 五个 Phase 全部零实施痕迹：

- 四个规划 spec（`subagent-topology-persistence` / `swarm-observability-projection` / `agent-peer-messaging` / `subagent-nesting-budget`）均不存在；
- 全仓无 `subagent_edge` 迁移/仓库/绑定/事件类型（Phase 1）；
- shared/ui/rpc/tui 对 swarm 仍零命中，无 v4 状态键、无进度事件、无 GUI 面板（Phase 2）；
- 子 runtime 无 peer 工具、`origin.kind` 仍单值 `"coordinator"`、mailbox 仍无写入方、peer-5 悬挂 bug 未修（Phase 3）；
- `resolveSubagentPermissionMode` 无 rootMode/depth 参数、tool-policy 强制集未扩充、两个既有 spec 仍写「硬深度 1 / 现状钉住」（Phase 4）。

65 条论断核对结果：**39 holds / 23 drifted / 3 invalid / 0 implemented**。drifted 以 ±16 行内的行号位移为主（方案附录的行号时效性声明应验），论断本体成立。3 条 invalid 中 2 条源于 `c453fca`（2026-10-08 项目审查修复批）的**并行改动**（迁移编号、契约面），1 条是 §6.1 从「未核实」改判为「已核实：传递」——这是本次审计最重要的增量产出（详见 §2.5 与 §3 的 B4）。

## 1. 区域总览

| 区域（方案 Phase） | 论断数 | holds | drifted | invalid | 实施痕迹 | 独立复核 |
| --- | --- | --- | --- | --- | --- | --- |
| ① 持久化拓扑（Phase 1） | 15 | 7 | 6 | **2** | 无 | A1/A2 confirmed |
| ② swarm 可观测（Phase 2） | 15 | 11 | 4 | 0 | 无 | C2 confirmed（含对照组） |
| ④-P0 peer 通信（Phase 3） | 15 | 11 | 4 | 0 | 无 | C1 confirmed |
| ③ 深度嵌套与安全（Phase 4） | 15 | 8 | 7 | 0 | 无 | B1/B2/B3 confirmed |
| §6 未验证项 | 5 | 2 | 2 | **1** | — | B4/B5 confirmed（逐环重追） |

## 2. 逐区域对照明细

状态四态：**holds** 仍成立 / **drifted** 成立但锚点漂移 / **invalid** 已不成立 / **implemented** 方案改动已落地。路径前缀 `apps/acode-cli/packages/` 省略为 `~`；仓库顶层 `packages/` 保留原样。

### 2.1 Phase 1 · 持久化 agent 拓扑 + 崩溃恢复

| # | 论断 | 状态 | 当前证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | RuntimeTaskRegistry 纯内存、每 runtime 一份 | drifted | `~/core/src/runtime-task/registry.ts:19`（:20-23 全 Map 字段，全文件零持久化引用）；`~/core/src/runtime/agent-runtime.ts:314` fallback 新建 | 类起点 :141→:19（文件已收缩），运行态字段清单迁至 `runtime-task/types.ts:61-79` |
| 2 | 子代理事件默认只进内存 | drifted | `~/core/src/runtime/methods/subagent.ts:79-81` emitParentEvent→appendEvent（精确）；`~/bootstrap/src/app/create-app.ts:765` `eventStore ?? createInMemorySessionEventStore()`；`~/bootstrap/src/acode-protocol/server.ts:249` | create-app 锚点 :920→:765 |
| 3 | 命令队列纯内存；resume 清扫 discarded(session_resumed) | drifted | `~/core/src/runtime/methods/background-notifications.ts:61-63` 注释原文逐字仍在；`~/core/src/runtime/methods/steering.ts:1331-1344`（:1343-1344 收口） | 注释行号 :58-60→:61-63 且措辞扩充「账本是唯一 durable 痕迹」 |
| 4 | background-work-owner 沿 parentID 上溯、visited 防环 | holds | `~/bootstrap/src/acode-protocol/background-work-owner.ts:11-26`（全文 28 行） | 形状逐一吻合 |
| 5 | subagent-session-query 三源合成目录 | holds | 同目录 `subagent-session-query.ts:103-146`（事件源）/:160-215（tool part 源）/:396（子会话行过滤 `taskType!=="subagent_child"`） | 行号吻合 |
| 6 | childSessionId 兜底恒等式；孤儿终态 "lost" | holds | `subagent-session-query.ts:183`（`createSessionId(\`subagent_${agentId}\`)`）/:371/:373（`?? "lost"`） | 精确一致 |
| 7 | 崩溃后无自动拉起；dwf 有孤儿收敛对照 | drifted | `~/adapters/src/storage/session-store/repositories/dwf-journal.ts:256` listNonTerminalRuns；执行体已拆至 `~/cli-workflow/src/dynamic-workflow-run-reconcile.ts:75`（service :171/:179 调用）；Agent 侧全仓无 respawn | dwf 孤儿收敛执行体从 service 拆出独立模块；:216→:256 |
| 8 | 迁移最新编号 0027，新表可用 0028 | **invalid** | migrations/ 目录最新为 `0029-workflow-run-owner-lease.ts`；`migrations.ts:972/:977` 注册 0028/0029；`git show 2855cce` 无此二迁移，系 `c453fca` 引入 | **方案预留的 0028 号已被占用，Phase 1 新迁移须改用 0030** |
| 9 | migration-runner 历史不可变、无 down；0026 模板形状 | holds | `~/adapters/src/storage/session-store/migration-runner.ts:301-315` ensureMigrationChecksum（:308 注释原文）；`0026-swarm-plan-row.ts:5-13` | 吻合 |
| 10 | repositories/swarm-plans.ts 可作新仓库模板 | holds | `~/adapters/.../repositories/swarm-plans.ts:14-47`（db 第一参、`on conflict(session_id) do update`、返回 unknown，:11-12 头注） | 48 行形状完全一致 |
| 11 | dwf-journal 序号分配防多进程竞争 | drifted | `dwf-journal.ts:432-444`（`coalesce((select max(sequence)+1 …),0)` + `returning`，:430-431 WAL 论证注释仍在） | :386-411→:432-444 |
| 12 | runtime-binding duck-typing 探测 + sqlite-store 委托/懒加载模板 | drifted | `~/core/src/swarm/runtime-binding.ts:28-48`（三方法缺一返回 undefined，:5-9 头注「不伪装成功」）；`sqlite-session-store.ts:659-670` 委托、:951-953 `??=` 懒加载 | 形状未变，行号小幅漂移 |
| 13 | SessionInfo.parentID 在 events.ts 写入 | holds | `~/core/src/runtime/methods/events.ts:591`（createSession 入参，:593 taskType 同处落库） | +1 行 |
| 14 | 写入钩子单点 emitSubagentEvent、八发射点 | holds | `~/core/src/subagent/runner.ts:1938` 定义（精确）；调用 :236/:354/:399/:482/:1025/:1547/:1627/:1777 | 第 8 发射点 :1830-1857→:1777 |
| 15 | session-store.port.ts 契约面冻结、无 swarm/dwf 方法 | **invalid** | `~/contracts/src/interfaces/session-store.port.ts:1077-1088` 新增可选方法 `claimWorkflowSessionOwner`（"Durable owner lease shared by Dynamic/Script Workflow"），`c453fca` 引入；swarm 方法仍不在 port | 「冻结面」不再字面成立；Phase 1「不进 contracts」的论证实施前须按此先例重评 |

### 2.2 Phase 2 · 统一编排可观测投影（swarm 补 v4/GUI）

| # | 论断 | 状态 | 当前证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | swarm 在 shared/ui/rpc/tui 四表面零命中 | holds | `grep -rni swarm` 四处 0 命中（shared/src 245 文件、ui/src 1495、rpc/src 22、tui/src 91）；唯一命中是 `tui/dist` 打包产物与 node_modules 副本，非实施痕迹 | 复核员用对照组（同命令在 core/src 命中 34 文件）排除工具假阴性 |
| 2 | swarm_plan 行持久化（0026）已存在 | holds | `0026-swarm-plan-row.ts:6-13` | 一致 |
| 3 | plan-store hydrate 含 running→queued 复位 | holds | `~/core/src/swarm/plan-store.ts:132` hydrate、:154-177 复位块（:163） | 行号未漂移 |
| 4 | swarm-plan-runtime wiring hydrate + onChange 观测口 | drifted | `~/bootstrap/src/app/swarm-plan-runtime.ts:206-216` hydrate、:91-108 onChange（:107 syncSwarmPlanRuntimeTask） | 约 2 行偏移；发射点仍成立 |
| 5 | buildSwarmPlanStatus 纯函数投影、双面共用 | holds | `~/core/src/swarm/projection.ts:62-102` + :1-6 头注 | 精确一致 |
| 6 | runtime-task 快照 type "swarm_plan" | holds | `runtime-binding.ts:63-107`（:94-95 type、:74-77 文本摘要、:60「专用字段留给后续 UI 批次」） | 逐项吻合 |
| 7 | 现有可见面只有三个 | holds | `~/core/src/tool/handlers/index.ts:313-324`（PlanSeed/Status/Control）；`~/core/src/system-reminder/source.ts:49/:126`；runtime-binding | 四表面零命中佐证无第四可见面 |
| 8 | tool-event-mirror live-only 不落父 event store | drifted | `subagent.ts:340-371`（:348 raw notifyEventSinks、:352 镜像、:343-347 注释「不再次 append」）；`~/core/src/subagent/tool-event-mirror.ts:38` | :335-367→:340-371 |
| 9 | v4 workflow-runs 状态键家族模板 | holds | `packages/shared/src/acode-protocol-v4/workflow-runs.ts:361/:522-526` + 同目录 reducer/delta/tables 分文件 | 精确一致 |
| 10 | snapshot optional 键 + wire 兼容注释模式 | holds | `packages/shared/src/acode-protocol-v4/snapshot.ts:460/:483-487` | 精确命中 |
| 11 | contracts 带前缀事件命名模板 | drifted | `~/contracts/src/events/session.events.ts:149-153`（注释+DynamicWorkflowRunProgress）/:970 Payload | :139-143→:149-153（约 10 行） |
| 12 | dwf-run-progress 追加方法模板 | holds | `~/core/src/runtime/methods/dynamic-workflow-run-progress.ts:24`（:20-22 rootTraceContext 注释、:30 appendEvent） | 它走 appendEvent 持久化——正是 swarm 缺失一环的模板 |
| 13 | v4-bridge 冷回放模板 | holds | `~/bootstrap/src/acode-protocol/v4-bridge.ts:199` replay、:1623 loadPersistedEvents、:1664 衔接；`dynamic-workflow-run-introspection.ts:283-296`（「逐字节相同」注释） | 起点行号精确 |
| 14 | product-projection / cursor 三件套 / GUI 双面板模板 | drifted | `~/bootstrap/src/acode-protocol-v4/product-projection.ts:1405-1406/:4280`（精确）；`packages/shared/src/acode-protocol/index.ts:1537-1544`（偏 12）；`server.ts:614-615`（偏 4）；`server-operations.ts:1593`（精确）；`packages/ui/src/app-shell/WorkflowRunDirectorySidePane.tsx`、`SubagentDirectorySidePane.tsx` 均在 | 模板本体全部健在 |
| 15 | 实施痕迹判定：投影链完全未动 | holds | shared 无 swarm-plan 状态键文件；contracts events 零 swarm 命中（`contracts/src/swarm/index.ts` 仅 plan schema/常量）；ui 零命中 | Phase 2「未实施」自评准确 |

### 2.3 Phase 3 · agent 间点对点通信（④-P0）

| # | 论断 | 状态 | 当前证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | peer 呈现文案超前于能力 | holds | `~/core/src/system-reminder/incoming-message.ts:5-8`（PEER_PERMISSION_GUIDANCE/PEER_REPLY_GUIDANCE）/:23-26（两个 presentation）——行号与方案完全一致；且被现役父→子链路渲染（`subagent-messages.ts:89`、`runtime-command-active-loop.ts:77`），子侧却无回复工具 | 文案超前属实 |
| 2 | SendMessage 不支持兄弟寻址 | holds | `~/core/src/subagent/runner.ts:913-919` sendMessageToLocalAgent（registry.get + type 校验，registry 外直接 failed）；:1072-1075 origin.kind 固定 "coordinator" | 无任何兄弟/跨 registry 路由 |
| 3 | 子 runtime 不注册 SendMessage | holds | `~/core/src/runtime/helpers/runtime-tools.ts:54-55`；`subagent.ts:292-295` + :64-66；`handlers/index.ts:256` | 门链完整：enabled:false → port undefined → includeSendMessage=false |
| 4 | SessionMailboxEnvelope + drainUnread | holds | `~/contracts/src/interfaces/session-mailbox.port.ts:3-10/:12-17` | 结构与行号逐字一致 |
| 5 | 文件适配器（rename 原子、逃逸防护） | holds | `~/adapters/src/mailbox/index.ts:15-59`（:39 rename、:45-58 SESSION_ID_PATTERN+relative 防护、:30 limit??20）；`create-app.ts:478` ACODE_MAILBOX_ROOT 缺省 ~/.acode/mailbox | 一致 |
| 6 | ACODE_MESSAGE_ENABLED 门控 | drifted | `~/bootstrap/src/app/app-config-options.ts:6-8`（精确）；`create-app.ts:472-481` | :492-501→:472-481，语义不变 |
| 7 | hook 三点 drain + 不可信提示行 | holds | `~/core/src/hooks/session-mailbox.ts:11-59`（:44 三事件、:9 MAILBOX_DRAIN_LIMIT=20、:68 不可信行）；注册点 `runtime-tools.ts:146-181`（以 port 在场为门） | 一致 |
| 8 | mailbox 缺口：无写入方、子 runtime 无 port、无 watch | holds | port 仅 drainUnread 无写方法；适配器全文无 writeFile；`create-app.ts:759-767` 只注入根 runtime；`subagent.ts:298-375` child deps 无该 port；全仓 grep 无任何生产写入方 | 仍是纯钩子轮询 |
| 9 | RuntimeCommandQueue（priority/mode/合批/前台租约） | drifted | `~/core/src/runtime/command-queue.ts:10/:11-17/:186-205`；`runtime-command-queue.ts:112-141/:143-152` | 合批块 :184-203→:186-205 |
| 10 | registry 消息面、origin.kind 单值 | drifted | 类型迁至 `~/core/src/runtime-task/types.ts:42-53`（:47 kind:"coordinator" 单值）/:55-57；`registry.ts:105-110` queueMessage、:112-118 drainMessages | kind 未扩展 "peer"；类型定义文件已迁移 |
| 11 | 三投递语义 steered/queued/resumed_background | holds | `~/contracts/src/interfaces/subagent.port.ts:74`；`~/core/src/subagent/message-steering.ts:29-41`（20×10ms）/:15-17；`runner.ts:956-1063`（:1061、:856-858 复用 childSessionId）；steer 失败回 queue :942-949 | 行号完全一致 |
| 12 | peer-5 悬挂 bug 仍在 | holds | `runner.ts:1401-1413` sink 注册→:1411 flushPendingMessages→:1421 registry.drainMessages（全仓唯一消费点）；sink 注册每 run 一次（`runner.ts:1151`→`subagent.ts:412`）；无 turn 起点/周期性 drain | 复核员 confirmed：P0 前置修复未落地 |
| 13 | peer-1 计费泄漏先例 | holds | `~/core/src/tool/handlers/send-message.ts:16-21` 泄漏注释、:22-23 hint、:50-53 assertNotOffPeakTurn、:15/:94 4096 截断；`runner.ts:973-983` resumeRequest 确实无 modelOverride 字段 | 机理属实 |
| 14 | peer-3/peer-4 证据锚点 | drifted | `subagent.ts:340-372`（mirror live-only）；`runtime-command-queue.ts:25-37`（:36 enqueue 即 drain）；RuntimeTaskPendingMessage 无 hop/TTL 字段 | 速率/环路守卫完全缺失，各漂移约 5 行 |
| 15 | 实施痕迹判定 | holds | origin.kind 单值；工具面无 peer-send；spec 不存在；全仓 peer 标识仅命中呈现层文案与 `dynamic-sections.ts:219` 注释（发信方姿态文案，同属呈现层超前） | 传输/持久/围栏三块零落地 |

### 2.4 Phase 4 · 受约束深度嵌套（③）与安全项 R1-R5

| # | 论断 | 状态 | 当前证据 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 门①：child config 写死 enabled:false | drifted | `subagent.ts:292-295`（含 backgroundBashMaxMs 透传） | :287-290→:292-295 |
| 2 | 门②：createDefaultSubagentPort 返回 undefined | holds | `subagent.ts:60-66`（:64-66 逐字）；装配点 `agent-runtime.ts:327` | 一致 |
| 3 | 门③④⑤：includeAgent / 注册条件 / 第二入口 | holds | `runtime-tools.ts:54`；`handlers/index.ts:250-252`；`embedded-search-branch.ts:31`；`tool-allowlist.ts:70-72` 注释「两个入口…同一规则」 | 四处行号逐字命中 |
| 4 | **R1 提权路径仍在** | drifted | `subagent.ts:496-511` resolveSubagentPermissionMode（签名仍 `(parentMode, permissionMode, builtInExplore)`，case undefined 在 :506-507）；调用点 :174-178 传直接父自身模式；孙代理可写工具面前提 :287 `toolset: builtInExplore ? "explore" : "main"` | JSDoc :490-495 自证天花板「只对直接父成立」；提权链在当前代码形态下成立，仅锚点漂移 |
| 5 | **R2 allowlist 洞仍在** | drifted | `subagent.ts:527-563` resolveSubagentToolAllowlist（剔除 filter 在 :553 仅 inherits 分支；显式分支 :557-561 只过 filterSubagentChildToolNames）；`~/core/src/subagent/tool-policy.ts:4-7` 强制集恰为 [EnterPlanMode, ExitPlanMode] | 今天靠注册门（#3）兜住；洞原样存在 |
| 6 | depth 完全不被记录 | holds | core/src 全量 grep `maxDepth|subagentDepth|agentDepth|childDepth` = 0 命中（113 处 depth 命中全为其他域）；`runtime/types.ts:143-160` 与 `runner.ts:71-92` 均无 depth 字段 | dwf 域 `limits.maxDepth:6` 与子代理嵌套无关 |
| 7 | 权限路由回根天然成立、任意深度无需改 | holds | `~/core/src/runtime/helpers/child-client-ports.ts:33-41/:66-78`；`subagent-interaction-broker.ts:31-38`（:34 无条件覆写、:35 `??` 保留内层，:28-30 注释明文「可叠加…任意深度落到根」） | 逐字吻合 |
| 8 | R4 先例：闲时轮防护在 send-message | holds | `send-message.ts:16-23/:50-53` 逐字命中；同时核实 `agent.ts:179-237` 至今**无** assertNotOffPeakTurn 等价防护 | R4 护栏是建议而非现状 |
| 9 | R5：interaction-origin 单层结构 | holds | `~/core/src/subagent/interaction-origin.ts:8-16/:18-33`；rootSessionId 在 core+contracts 全量 grep 0 命中 | ancestors[]/rootSessionId 未落地 |
| 10 | 进程级 policy floor 唯一 depth 无关护栏 | holds | `~/core/src/permission/service.ts:169`（resolvePolicyFloor :161-170）；`process-policy-floor.ts:16-25`（:23，头注 :3-8 明文覆盖子代理自建实例） | 仍是地板非天花板，不能替代 R1 修复 |
| 11 | R3：Agent handler 零准入、scheduler 非树级闸 | drifted | `~/core/src/tool/handlers/agent.ts:179-237`（budget/quota/depth grep 0 命中）；`~/core/src/tool/scheduler.ts:48`（=10）/:50-55 纯函数式注释 | handler 尾部延伸至 :237；论断原样成立 |
| 12 | subagent_child 等价物 + 谱系事实三处 | drifted | `session-store.port.ts:38-47`（:44）；`subagent.ts:277-279`；`runner.ts:806-807/:817-835`（:832） | runner 两处逐字，subagent.ts 三行漂移 |
| 13 | 注入链按引用继承 + AIMD「免费一层」 | drifted | `create-app.ts:764` modelRequestAdmission；`runtime/types.ts:400`；`subagent.ts:306-308`（按引用透传注释）；`packages/dynamic-workflow/src/engine/concurrency.ts:8-9`（逐字，AIMD 现居 dynamic-workflow 包）；模板 `budget-caps.ts:1-21` 仍在 | 树级预算（tree-budget-caps）全仓零落地 |
| 14 | Phase 4-D 边界：taskType 判据 / swarm 无 depth 上限 / workflow 嵌套禁令 | drifted | `runtime-tools.ts:68/:73/:81/:89-93`（:72 注释逐字）；`~/core/src/swarm/graph/ops.ts:343/:420-438`；`~/contracts/src/swarm/index.ts:25`（=1024）；`~/cli-workflow/src/script-workflow-runtime.ts:435` | 唯一实质漂移：script-workflow-runtime 已迁出 core、现居 cli-workflow 包（:353-355→:435） |
| 15 | 实施痕迹判定：R1/R2 修复与放开嵌套均未动工 | holds | `subagent-policy-floor-inheritance.md:58`「### R3 …（现状钉住，不改行为）」、场景 5（:99-100）、场景 6（:101-102）原文未动；`dispatch-discipline-prompt.md:30-32/:285/:7`「硬深度 1」未动 | 两 spec 的自引锚点也已漂移（subagent.ts:275-287→284-295），Phase 4 的 spec-first 前置未启动 |

### 2.5 §6 未验证项 —— 核实结果（本次审计的增量产出）

四条开放问题全部得出明确结论；除特别注明外均为「以放开嵌套为条件」的反事实推演（当前嵌套被 2.4 #1-#3 的五道门硬关）。

**§6.1 闲时轮 `subagentModelOverride` 是否传递到 depth≥2 → 已核实：传递（invalid：方案「传递链未核实」可改判）。**

- 显式链确实断在当层：child `executeTurn`（`subagent.ts:414-421`）不传 `modelExecution`/`intent`，孙层 loopState 无 `subagentModelOverride`（`turn.ts:546-558`），`agent.ts:227` 的 modelOverride 为 undefined。
- 但 override **模型**经三条继承链全部到达孙代理：
  1. childSelection（= override selection，`subagent-selection.ts:22-24` 无条件最高优先）→ child `config.modelSelection`（`subagent.ts:253`）→ `agent-runtime.ts:318` 初始化 → 孙层 `resolveSubagentSelection` 的 parentSelection；
  2. `context.model`（child 活动模型，`turn-tools.ts:186-187`→`call-runner.ts:414-418`→`agent.ts:226`）→ 孙层 `inheritedModel`（`subagent.ts:111-115`）；
  3. **最强**：`createSubagentOverrideModelFactory`（`subagent.ts:477-488`）把任意 target selection 无条件重写为 `override.selection` 并携带 requestDependencies，作为 childModelFactory 的 fallback（:207-212，child deps :311）归纳传递到任意深度——孙代理即使 profile 显式指定模型也会被重写。
- 放大项：background deny 门（`runner.ts:151`）以 `launchOptions.modelOverride` **存在**为判据，孙层无显式 override → 门失效；后台启动路径只转发 model 不转发 modelOverride（`runner.ts:466-479`），孙代理可携闲时轮凭据（deny 的生产源头：`packages/desktop/src/host/offPeakRunDispatch.ts:342-352`）转后台，正是 :152 注释要防的事。
- 独立复核逐环重追后 confirmed，未找到任何一环反证。**R4 由「待核实」升级为「已确认的条件性泄漏」；护栏必须落在工厂链或 deny 门判据上，仅显式透传 override 不够。**

**§6.2 AbortSignal 链在 depth≥2 是否完整 → 已核实：前台完整、后台有意断开、孤儿风险确认（drifted）。**

- 前台链逐层派生、任意深度闭合：`agent.ts:225` → `runner.ts:200-204`（taskAbort 挂 parentSignal）→ `runExploreAgent options.signal` → `subagent.ts:414-415` child executeTurn → `call-runner.ts:372-373/:403` → 孙层 launch。
- 断链只在 background 路径且是有意设计：`port.start` 的 taskAbort 不挂 parentSignal（`runner.ts:466-469`，仅一次性 aborted 检查）；前台转后台 `detachParent()`（:319-320，实现 :636-638）。
- 孤儿确认：child 的 `runtimeTaskRegistry` 新建独立实例（`agent-runtime.ts:314`，child deps :300-360 不传该 dep）；取消兜底 `cancelRunningRuntimeBackgroundTasks` 只过滤 `type==="local_bash"`（`background.ts:300-323`），而子代理任务快照写死 `local_agent`（`runner.ts:1444-1469`）→ 根取消后，后台/detach 的孙代理既收不到 abort 也不在根 registry 可见范围，继续烧 token（放大 R3/R4）。
- 锚点漂移登记：`agent-runtime.ts:298→314`、`subagent.ts:293-370→298-375`、`:402-403→414-415`。

**§6.3 多层镜像可观测性 → 已核实：成立且比预期更糟（holds）。**

- 叙事层：镜像白名单只含 ToolCall*/Permission*（`tool-event-mirror.ts:19-31`，其余事件 :38-47 返回 undefined），assistant 正文任何层都不镜像 → 孙代理正文永远到不了根 timeline，根只见「child 的 Agent 工具 ToolCallResult（内嵌孙摘要）再包一层 child 最终摘要」——字面意义的「摘要的摘要」。
- 工具事件层：**双重镜像**——child 层把 raw 事件原样转发（`subagent.ts:348-351`）**又**发镜像产物（:352-370），父层对两者都再跑一次 mirror → 同一孙代理工具调用在根 timeline 至少两条重复：raw 直接镜像那条 agentId 归属错乱（标成 child），镜像的镜像那条 toolCallId 前缀叠加（`tool_subagent_X_tool_subagent_Y_…`，`tool-event-mirror.ts:132-134`）。
- 当前无「已镜像产物不再镜像」抑制（无 source 判别）——**放开嵌套的新增阻塞前置**。

**§6.4 runtimeScope 二值消费点 → 已核实：约半数深度无关，失真集中在协议透传与遥测（holds）。**

- 判定源未漂移：`runtime-tools.ts:265`（taskType 二值）；类型 `tool/types.ts:104`。
- 不失真（语义本就深度无关）：`respond-to-coordinator.ts:30`（每层 child 各有指向直接父的 port，`subagent.ts:316-322`）；`node-repl-browser-broker.ts:171`（所有子层一律拒 Browser）；`bash-cwd-policy.ts:37`（cwd 策略仅 main 适用）；`background-tasks.ts:180/:507`（后台时限对所有子层同等生效）。
- 失真：① **MCP `runtime_scope` 协议透传**——`adapters/src/mcp/index.ts:697/:1759` 把二值透传给 server 侧，node-repl-host 三个 bridge/broker（`browser-bridge.ts:98`、`cua-bridge.ts:125`、`cua-broker.ts:133`）按二值解析，且 `packages/shared/src/browser-use/nodeReplBroker.ts:11` 的 zod enum 把二值**固化进跨进程协议**——加 depth 维度须改协议 schema；② `tool-perf.ts:83` workspaceKind 把所有子层降级 "unknown"，遥测无法按层归因（影响轻，本就丢弃信息）。

**锚点漂移总登记（§6 专用）**：未漂移——`subagent.ts:104-109/:110-115/:111`、`runtime-tools.ts:265`；已漂移——见 §6.2 条目（三处各 12-16 行）。

## 3. 独立复核裁定（9/9 confirmed）

复核员未参与核对，全部按符号名独立重定位、亲读函数体，不信任核对员给出的 file:line。

| 编号 | 被复核结论 | 裁定 | 关键补充 |
| --- | --- | --- | --- |
| A1 | 迁移最新编号已到 0029，0028 被 `c453fca` 占用 | confirmed | `git ls-tree 2855cce` 证实基线只到 0027；`git branch --contains` 证实 c453fca 仅在 dev/0.0.7 线上；下一空闲编号为 0030 |
| A2 | SessionStorePort 新增 `claimWorkflowSessionOwner`，「契约面冻结」不再字面成立 | confirmed | port :1077-1088 首个成员即该方法；字面 "dwf" 缩写仍 0 命中，但语义上正是 workflow 域方法；swarm 方法仍不在 port |
| B1 | R1 提权路径仍在（无 rootMode、case undefined yolo 分支） | confirmed | 函数体原文核实；:490-495 JSDoc 自证天花板只对直接父成立 |
| B2 | R2 allowlist 洞仍在（剔除只在 inherits 分支、强制集不含 Agent/Task） | confirmed | `compat.ts:1-14` 证实派发集就是 {"Agent","Task"}；今天被注册门独立兜住 |
| B3 | 硬深度 1 五道门完整 | confirmed | 五道全部亲读函数体；唯一理论旁路（child deps 显式传 subagentPort）当前不存在 |
| B4 | §6.1 override 三链传递 + deny 门孙层失效 → R4 成立 | confirmed | 逐环重追三条链与 deny 生产源头（offPeakRunDispatch.ts:342-352），未找到任何反证；链③最强（无条件重写） |
| B5 | §6.2 后台孤儿孙代理确认、前台链完整 | confirmed | 两条根取消路径都堵死：前台 child 的 finally 兜底只杀 local_bash；后台/detach 的 child 收不到根 abort |
| C1 | peer-5 悬挂 bug 仍在（drainMessages 全仓唯一消费点在 sink 注册） | confirmed | 生产代码唯一消费点 runner.ts:1421；悬挂窗口真实存在 |
| C2 | swarm 四表面零命中 | confirmed | 对照组（core/src 同命令 34 文件命中）排除假阴性 |

## 4. 方案文档修订清单（已随本审计执行）

以下定点修订已直接写入 [codex-orchestration-integration-plan.md](codex-orchestration-integration-plan.md)，其余行号漂移不逐条改动（方案附录的「以文件名 + 符号名为主」纪律继续适用，逐条漂移登记以本报告 §2 为准）：

1. 头部新增「复核记录（2026-10-10）」段：登记复核范围、结论与本报告链接。
2. Phase 1 关键改动：新迁移 `0028-subagent-edge.ts` → **`0030-subagent-edge.ts`**；注册说明「最新是 0027」→「最新已到 0029（c453fca 追加 0028/0029 workflow-run-owner 族）」。
3. Phase 1 关键改动：「session-store.port.ts 契约面冻结，无 swarm/dwf 方法」→ 补充 c453fca 已破例新增 `claimWorkflowSessionOwner`，「不进 contracts」论证须按新先例重评。
4. §5 R4 行：「待核实」→「**已核实：传递**」，护栏要求补充「须落在工厂链/deny 门判据」。
5. §6 四条：逐条附加核实结果（结论 + 关键证据链），标题注明「已于 2026-10-10 全部核实」。
6. 附录：补一句复核已完成及 65 条论断的四态统计。

## 5. 下一步建议（按方案自身依赖序）

1. **R2 可立即单独修**（方案自己也论证过「即使不放开嵌套也值得先做」）：今天它是被注册门兜住的潜在绕过，改动面小（把派发剔除移出 inherits 分支，或加进 `tool-policy.ts` 强制集），配不变量守护测试即可。
2. **Phase 1 仍是地基且可启动**：全部模板（swarm-plans 仓库形状、dwf-journal 序号分配、runtime-binding duck-typing、migration-runner 不可变纪律）核实健在；启动时按 §4 的修订用 0030 号迁移，并重评「不进 contracts」论证。
3. **Phase 4 的阻塞前置从「R1/R2」扩充为四条**：R1、R2 之外，新增 §6.1 工厂链泄漏（deny 门判据修复）与 §6.3 双重镜像抑制（「已镜像不再镜像」判别）。§6.2 的后台孤儿问题与 Phase 1 的边表持久化天然耦合，建议合并设计。
4. **Phase 2/3 无新增前置**：论断全部 holds/drifted，模板健在，可按方案原文推进（行号按本报告 §2 刷新）。
5. **spec-first 提醒**：四个新 spec 与两个既有 spec 的修订（`subagent-policy-floor-inheritance.md` R3、`dispatch-discipline-prompt.md`「硬深度 1」）仍未动——与方案「每个 Phase 动手前先更新 spec」的边界一致，属预期状态而非遗漏。

## 6. 覆盖声明

**已验证**：

- 65 条承重论断由 5 名独立核对员在当前检出源码逐条读取并引用 file:line（按符号名重定位，不依赖方案行号）；
- 9 条高危结论（2 invalid + 5 安全 + 2 抽查）由未参与核对的复核员独立重追，全部 confirmed；
- A1/A2/B4 额外用 git 历史（`git show 2855cce`、`git log -S`、`git branch --contains`）核实了「基线不存在、c453fca 引入」的归因；
- 四个规划 spec 不存在由发起方 `glob apps/acode-cli/specs/*.md` 预先确认，核对员未重复核。

**未覆盖**：

- Codex（openai/codex）侧机制描述未复核——外部仓库，本仓不举证（与方案附录约定一致）；
- 未运行 typecheck/lint/测试——本审计为只读对照，不改码；
- 论断按承重抽样核对（每区域 8-15 条），非方案全文逐行比对；drifted 条目的行号登记以核对员实际读到的为准，未漂移条目未逐一列举；
- §6.1/§6.2/§6.3 的结论是「放开嵌套后」的反事实推演（当前五道门硬关），推演基于现行代码路径，未实际运行嵌套场景。
