# M2-3 session 读写面八方法迁 v4（create / resume / list / read / messages / events / subscribe / runtimePreferences）

> 状态：**已实施**（2026-10-28）。实现面全落地（shared 叶 + transport 方法表 + CLI handler +
> services facade/推送面全切），§5 六项判据实测全绿（数值见各节）：services 消费 43 → **20**；
> protocol-boundary 42/42；m2-3 handler 12/12；resync 补洞 8/8、双订阅帧对照 1/1；
> acode-cli 十套件 68/68；services 585 零失败；shared/web/desktop/ui 全绿；server 唯一红属
> 在途兄弟批次未登记叶（§5E 如实登记）。
> 关联：docs/reviews/2026-10-28/m2-scoping.md §5 M2-3 条目、§6.3 裁决（sessionEvents 保持
> 独立事件日志查询、不并入 conversation frame）；M2-1 迁移样板 commit 5da76197；
> M2-2 spec（m2-2-session-control.md）的同批先例（ACK 后回读、v4 方法名即版本边界、
> result variant 拆叶）；apps/acode-cli/specs/legacy-session-subscribe-convergence.md
> （sessionSubscribe 直替 conversationSubscribe 的阻塞裁定，§6.2 偏差承接）。

## 1. 范围与判据

迁移八个 legacy 方法的 **services 消费侧**（`acodeProtocolMethods.` 点号消费实测 43 → 33）：

| legacy 方法 | services 消费点（迁移前） | v4 归宿 |
|---|---|---|
| `session/create` | acodeAgentService.ts `createSession`（:3859 主路径 + :3898 compat 重试） | 既有 v4 command op `createSession` 扩展 payload（parity 字段）→ ACK 后 `v4/session/read` 回读快照 |
| `session/resume` | `resumeSession`（:3971 主路径 + :4006 compat 重试） | **新 query `v4/session/resume`**（激活 runtime + 返回 legacy 快照形态） |
| `session/list` | `listSessions` :4028 | **新 query `v4/sessions/list`** |
| `session/read` | `requestSessionStateSnapshot` :3601（readSession + M2-1/M2-2 配置写回读共用单点） | **新 query `v4/session/read`** |
| `session/messages` | `readSessionMessages` :4126 | **新 query `v4/session/messages`**（偏差：不采 scoping 的 rowsRange 方案，§6.1） |
| `session/events` | `readSessionEvents` :4153 | **新 query `v4/session/events`**（裁决：独立事件日志查询） |
| `session/subscribe` | `onDynamicSessionEvent` :5370 | **新 query `v4/session/subscribe`**（换名承载 legacy 语义；§6.2） |
| `session/requestRuntimePreferences` | onRequest 处理器 :2248-2320（agent→host inbound） | **新 host→CLI 推送 `v4/session/runtimePreferences`** + CLI 侧缓存（§6.3） |

计数口径：create 2 + resume 2 + list 1 + read 1 + messages 1 + events 1 + subscribe 1 +
runtimePreferences 1 = **10 行**。create compat 分支内的 `sessionSetThoughtLevel` 重试
（:3916 附近）随 compat 删除自然死亡，额外 −1；若落地则实测 43 → **32**（server.ts 的
`sessionSetThoughtLevel` case 按 M2-1 裁决保留，服务旧 Host skew，不在本批消费口径内）。

消费归零后删除 legacy dispatch 七 case（server.ts 的 sessionCreate/sessionResume/sessionList/
sessionRead/sessionMessages/sessionEvents/sessionSubscribe）。**op 实体不删**：`createSession`/
`resumeSession`/`listSessions`/`readSession`/`readMessages`/`readEvents`/`subscribeSession`
（server-operations.ts）被新 v4 handler 叶复用，M3 随 legacy 目录整体搬迁时再收编
（session-header-meta-query.ts 头注的同一纪律：不在待删目录新增实体债，也不提前搬运存量实体）。

## 2. 行为规格

### 2.1 createSession（v4 command payload 扩展 + ACK 后回读）

- **payload 扩展**（additive，v4 payload 非 strict，旧 CLI 静默丢键 fail-closed——与
  offPeakToolEnabled/clientMode 既有注释同款）：`sessionId?` / `persistence?` /
  `titleGenerationEnabled?` / `toolAllowlist?` / `toolDenylist?` / `importedHistory?` /
  `mode?` / `model?` / `thoughtLevel?`。字段实体放 shared 新叶 `session-readwrite.ts`
  （command.ts 受 max-file-lines 例外冻结纪律，只引名单，M2-2 result variant 同例）。
  - `parentSessionId` **不带**：全仓无生产者（acodeAgent.ts:232 声明、builder 透传、
    无任何调用方赋值；fork 走 createSelectionSideSession / session/fork 既有面）。
  - `engine` **不带**：全仓无生产者（bots 域的 engine 是另一词汇）。legacy schema 词
    保留服务旧 Host skew。
  - `importedHistory` 逐字 parity legacy `acodeSessionImportHistorySchema`
    （discriminatedUnion source，现仅 claudeCode 变体）。
- **CLI 接线**：`commands/handlers/session-mgmt.ts` createSession 透传新字段 →
  `commands/types.ts` 的 `createSessionRecord` 钩子签名扩展 → `v4-bridge.ts` 把字段织进
  `createSessionRecordForV4` 的 rawParams（legacy `acodeSessionCreateParamsSchema` 既认这些
  键，裁决/物化逻辑——sessionId 仅限 importedHistory、模型/思考深度初始设置、
  unsupported thoughtLevel 跳过告警、importedHistory persist+resume——**零改动复用**）。
  `persistence` 缺省维持 `"deferred"`（v4 draft 语义）；显式 `"immediate"` 由导入修复路径
  （taskAdapter :1256/:1809，均已显式传 immediate）携带。
- **config 与 parity 字段分工**：facade 迁移后走 parity 字段（mode/model/thoughtLevel
  进 rawParams → legacy createRecord 路径，含 workspace prefs 持久化等存量语义）；
  `payload.config` 继续服务桌面 UI 草稿态先行选择（既有生产者不动）。两者并存时 config
  后应用（handler 既有次序），facade 不同时发。
- **auto-at-create 裁决**（model-config.ts:74 注释留给本批的问题）：parity `mode` 经
  legacy createRecord → runtimeConfig.mode，**不经 SWITCHABLE_MODES 过滤**，与 legacy
  session/create 逐字一致（auto 可建）。producer 实测：`toACodeMode` 不产 auto，UI 草稿
  档集合与可切换档一致——auto-at-create 是理论值域，本批不扩不缩，保持 legacy 语义。
- **facade**：`createHostCommandEnvelope({type:"createSession", payload})` →
  `assertV4CommandAckOk` → `requestSessionStateSnapshot(client, {sessionId, ...})` 回读
  （M2-2「全量快照由调用方统一 ACK 后回读」先例）。`rememberSessionTrace`、
  `ensureAccountProviderConfigSynced`、日志面不变。**compat 重试整支删除**（含
  `buildSessionCreateParams`/`getSessionCreateCompatFields`/`SESSION_CREATE_OPTIONAL_COMPAT_FIELDS`
  与分支内 `sessionSetThoughtLevel` 追发）：v4 方法名即版本边界（M2-6 mcpList 先例），
  旧 CLI 不认识 `v4/command`，重试分支对新链路不可达。
- **缺省翻转登记**：legacy persistence 缺省 = immediate（server-operations.ts:3057），
  v4 缺省 = deferred（draft 语义，首发由 prompt-turn / legacy sendPrompt :1902 提升
  immediate——两条发送路径都有提升逻辑，混合链路安全）。这是与 v4 桌面创建路径的
  **有意统一**（session-mgmt.ts 头注「新会话一律 deferred」）。

### 2.2 resumeSession（新 query `v4/session/resume`）

- **params**：逐字 parity legacy `acodeSessionResumeParamsSchema`（sessionId + workspace? +
  thoughtLevel? + mcpServers? + toolAllowlist? + toolDenylist? + offPeakToolEnabled? +
  dynamicWorkflowEnabled?）——冷恢复重建 runtime 的工具面/灰度透传语义逐字保留。
- **result**：legacy `ACodeSessionStateSnapshot` 形态。scoping「不激活运行时的 resume」
  解读为「不启动 turn」；facade 消费方（acodeSessionService.resumeSession、
  taskAdapter:1159、harness translate:637）都要求 ACTIVE 会话，故 handler = legacy
  `resumeSession` op 直通（activateSessionForResume 激活 + snapshot 回读）。
- **CLI handler**：新叶 `session-readwrite.ts`（v4 目录）parse v4 schema → 调
  server-operations.ts `resumeSession`（既有导出，逐字复用）。
- **facade**：换方法名 + parity params；compat 重试整支删除（同 §2.1 裁决）。

### 2.3 listSessions（新 query `v4/sessions/list`）

- CLI 侧 query：事实源是 CLI sessionStore；sessions-index topic 是有界订阅窗口，供不出
  includeArchived / sessionIds 显式身份查询（含隐藏会话）/ limit / TASK_LIST_SESSION_TYPES
  过滤 + active-record 合并语义。handler = legacy `listSessions` op 直通。
- **params**：逐字 parity legacy `acodeSessionListParamsSchema`（workspace? / sessionIds?
  min1 max64 / includeArchived default false / limit?）。
- **result**：`{ sessions: acodeSessionInfoSchema[] }`——`acodeSessionInfoSchema` 在
  legacy-types 叶（M4 幸存面），经 protocol-boundary.mjs 白名单显式登记后被 v4 叶引用。
- **facade**：`getReadOnlyClient(params, params.runtimePolicy)` 策略不变，trace 台账
  （sessionTraceIdBySessionKey 回填）不变。

### 2.4 readSession（新 query `v4/session/read`）

- **params**：逐字 parity legacy `acodeSessionReadParamsSchema`（sessionId + deliveryKind? +
  messageLimit? + afterSeq?）。deliveryKind 写入 record 的副作用（:1784）逐字保留——
  它承载 legacy live 转发的投递画像。
- **result**：legacy `ACodeSessionStateSnapshot` 形态（snapshotWithDiagnostics 同一
  builder）。**不采** scoping 的「sessionHeaderMeta + conversationSubscribe 拼接」：
  renderer 仍消费完整 legacy 快照（SessionPane.tsx:1213、acodeTaskServiceAdapter
  :1508/:2725/:3219 等对 snapshot.messages/settings/projection 的重度消费）；host 侧无
  rows→ACodeMessageWithParts 映射，60 行尾窗也填不满全量 messages。CLI 侧合成是唯一
  不发明新投影的路径。
- **facade**：只改 `requestSessionStateSnapshot` 单点（:3598-3610），readSession 与
  M2-1/M2-2 全部配置写回读自动跟随。

### 2.5 sessionMessages（新 query `v4/session/messages`，偏差 §6.1）

- **params**：逐字 parity legacy `acodeSessionMessagesParamsSchema`（sessionId +
  afterMessageId? + limit?）。afterMessageId = 严格其后（findIndex+1 切片）、limit =
  尾部 N 条——语义由 CLI op 原样承载。
- **result**：`{ messages: acodeMessageWithPartsSchema[] }`（legacy-types 叶符号，
  白名单登记）。
- handler = legacy `readMessages` op 直通；facade 换方法名。

### 2.6 sessionEvents（新 query `v4/session/events`）

- 裁决（m2-scoping §6.3）：**保持独立事件日志查询**，不并入 conversation frame。
- **params**：逐字 parity legacy（sessionId + afterSeq? + limit?）。result =
  `{ events: ACodeSessionEvent[] }`；CLI 侧 `readEvents` op 直通——
  readProtocolSessionEvents 的 protocol-visible seq 重编号 + streaming-delta 批处理
  语义零改动。
- **result schema 承载**：事件词汇 26 变体的 discriminated union 实体在 legacy barrel
  （index.ts:1379 起，依赖闭合含 envelope/各 payload schema，体量数百行）。services 侧
  继续用 barrel 的 `acodeSessionEventsResultSchema` 校验 v4 响应（services 不受
  v4→legacy 边界约束；wire 形态本就逐字一致）；v4 叶不复制该闭合（拒绝数百行
  parity 重复的漂移面），schema 居所 consolidation 归 M4（legacy-types 幸存面收编）。

### 2.7 sessionSubscribe（新 query `v4/session/subscribe`，偏差 §6.2）

- **params**：逐字 parity legacy `acodeSessionSubscribeParamsSchema`（sessionId +
  deliveryKind + afterSeq? + includeSnapshot? default false）。
- **result**：legacy `acodeSessionSubscribeResultSchema` 形态（sessionId + eventSeq +
  events + snapshot?）——同一 watermark 原子返回，拆成 events 查询 + read 查询会破坏
  水位一致性（events 到 seq X、snapshot 在 seq Y）。
- handler = legacy `subscribeSession` op 直通：`record.deliveryKind` 写入 +
  `legacyStreamSubscribed = true`（resident 回收门）、replay 缺口读取、可选快照，
  全部逐字。live 事件继续经既有 `session/event` 字面量 notify 通道（不在
  `acodeProtocolMethods.` 消费口径）。
- **facade**：`onDynamicSessionEvent` 只换方法名与 result schema 引用；重试/栅栏/
  缓冲释放/eventCoalescing 机制不动（:5297-5403 区段其余行不变）。

### 2.8 sessionRequestRuntimePreferences（新 host→CLI 推送 `v4/session/runtimePreferences`，§6.3）

- **方向与载体**：v4 topic 全是 CLI 发布面，装不下 host 权威数据；host→CLI v4 请求
  有 connectionFlow / networkCaptureSetEnabled 先例。故载体 = 新 host→CLI v4 方法
  `v4/session/runtimePreferences`，params = `{ preferences }`（结果形态逐字 parity
  legacy `acodeSessionRuntimePreferencesResultSchema`：nativeSearchEnhancementsEnabled /
  memoryEnabled / askUserQuestionAutoResolutionEnabled / integratedTerminalShell? /
  modelContextBudgetStrategy——两 scope 合并后一次推全量）。
- **CLI 侧**：新叶 `session-runtime-preferences.ts`：push handler 校验+写进程级缓存；
  `readCachedSessionRuntimePreferences()` 供 server-operations.ts 消费。
  `resolveSessionStartupPreferences` 改读缓存：**缓存缺失 → 今天 -32601/-32020 兼容分支的
  同一组缺省值**（askUserQuestionAutoResolutionEnabled:true / memoryEnabled:false /
  modelContextBudgetStrategy:"preflight-v1" / nativeSearchEnhancementsEnabled:true，shell 缺席）。
  `initializeAskUserQuestionAutoResolutionEnabled` 调用时机不变。
  `requestSessionRuntimePreferences` 函数删除（无其他调用方）。
- **services 侧**：
  - 删除 onRequest 处理器（:2248-2320）。`sessionRuntimePreferencesRequestEmitter` /
    `pendingSessionRuntimePreferences` / `respondSessionRuntimePreferences` /
    `takePendingSessionRuntimePreferences` / `expireSessionRuntimePreferencesRequest`
    **保留**——desktop-attached remote 的 external authority 桥
    （remoteWorkspaceServiceCollection.ts:205，packages/desktop 不在本批可改面）
    仍订阅该 emitter。
  - 新 `pushSessionRuntimePreferences(client)`：local authority 直调既有 resolver；
    external authority 走既有 emitter+pending 桥（desktop 应答路径不变），15s 超时与
    缺省回落语义在 services 侧等效承载；推送失败 log + 继续（CLI 缓存缺失回落缺省，
    与今天 CLI 侧兼容回落同值）。
  - **推送时机**（freshness parity）：① wireClient 连接建立后 eagerly（覆盖冷恢复订阅
    等 services 不见物化点的路径）；② facade createSession 发命令前 await 推送；
    ③ facade resumeSession 发查询前 await 推送。②③ 使「物化时刻拿到现读值」与今天
    的 pull 语义逐字对齐（含 external authority：推送前现走 desktop 桥应答）。
- **行为差登记**：今天非兼容类错误（如 -32022 超时）会**阻断** runtime 创建；推送模型下
  物化以缺省值继续（可用性取向）。今天每次物化现读；推送模型读「最近一次推送」，
  设置变更的传播时机 = 下次连接/下次物化前推送（app-global 设置，会话中途翻转率极低；
  desktop external 桥的中途变更推送归后续批次，本 spec 如实降级登记）。

## 3. 所有权与不变量

- `V4_METHODS`/`commandPayloadSchemas`/新 params schema：shared v4 叶唯一权威；
  v4 文件不 import legacy barrel（protocol-boundary 守护）；legacy-types 幸存符号
  新增引用（`acodeDeliveryKindSchema`/`acodeSessionInfoSchema`/`acodeMessageWithPartsSchema`）
  经 scripts/architecture/protocol-boundary.mjs 白名单显式登记（M2-2 goal 同例）。
- v4 handler 只做「parse v4 schema → 调 server-operations 既有导出 op」的薄转发；
  实体不搬（M3 收编 legacy 目录时随目录走），server.ts 只加一行转发 case。
- legacy 面只删不增：七 case 删除后八方法在 services 消费归零；legacy schema 词全部
  保留（旧 Agent/Host skew 容忍与测试基线），dispatch 不再可达。
- facade 契约不变：createSession/resumeSession/readSession 返回
  `ACodeSessionStateSnapshot`；listSessions 返回 sessions 数组；readSessionMessages/
  readSessionEvents 返回数组；`onDynamicSessionEvent` 事件词汇不变。
- 会话事件 live 通道不变：`session/event` notify（deliveryKind 门控）与 v4 ingest
  双轨并行现状不动；`sessionSubscribe` 迁移只换 replay/激活入口的协议名。

## 4. 失败语义

| 场景 | v4 收口 | facade 映射 |
|---|---|---|
| createSession ACK failed（含 input 空拒绝 proto.invalidPayload 等） | assertV4CommandAckOk 抛 | 抛（legacy create 失败同抛） |
| create 后回读 read 失败 | query 抛协议错误 | 抛（legacy 无此两拍，但等价于 create 半失败上行；sessionId 已在 ACK 到手，调用方按既有 catch 处理） |
| resume/read/messages/events/subscribe 会话不存在 | requireSession 抛协议错误 | 抛（legacy 一致；taskAdapter isSessionMissingError 文案匹配不变） |
| list 空结果 | `{sessions:[]}` | 同 legacy |
| 旧 CLI 不识 v4 方法 | -32601 | 抛，不做 legacy 回落（v4 方法名即版本边界，M2-2/M2-6 同款；plugins catalog 的 -32601 回落链是显式登记的例外，不适用本批） |
| runtime prefs 推送缺失/失败 | CLI 缓存缺失 → 缺省值组 | 与今天 -32601/-32020 兼容回落同值 |
| runtime prefs external 桥超时（15s） | services 侧缺省值组推送 | 与今天 CLI 侧超时回落同值（但不再阻断物化，见 §2.8 行为差） |
| 旧 Host 调 legacy 七方法 | case 已删 → -32601 | —（legacy schema 词保留仅服务协议解析层 skew） |

## 5. 验收

A. **消费计数**：`acodeProtocolMethods.` 在 packages/services/src 实测 43 → **20**
   （2026-10-28 `grep -rn "acodeProtocolMethods\." packages/services/src | wc -l` = 20；
   八方法 + setThoughtLevel 兼容重试逐方法 grep 归零；余量 20 全部属他批方法：
   sessionSend ×2、sessionSubagents、pluginsCancelOperation、offPeakList/Create、
   interactionRequestUserInput/ProviderRuntimeHeaders/Permission/OfficialMcpAuthHeaders、
   interactionBrowserList/Execute、computerUseOperationEvent、automationUpdate/List/
   Delete/Create/CheckTaskBinding）。
B. **协议单测**（packages/shared/tests/protocol-boundary.test.mjs）：**42/42**（26 基线 +
   本批 6 + 兄弟 M2-4 10）。本批 6 钉：V4_METHODS 七方法名（含 push 键
   `sessionRuntimePreferences: "v4/session/runtimePreferences"`）；六方法 params 与 legacy
   schema 交叉 parse 逐字同形（subscribe 无 `mode` wire 字段——handler 层概念，钉拒绝）；
   sessions/list result = legacy-types 规范化 sessionInfo 数组（交叉 parse）；createSession
   九 parity 字段 additive 收放（缺省 deferred / unknown-key 静默丢弃 / persistence 枚举）；
   runtime prefs push 严格 + result `z.object({}).strict()`；v4 叶零反向 import。
   **messages 刻意无 v4 result schema**（wire 直通 raw opencode MessageWithParts，§6.5）。
C. **CLI handler 测试**（apps/acode-cli/tests/m2-3-session-readwrite.test.mjs）：**12/12**。
   - resume：冷恢复直通（record 缺席 → 协议错误；在场 → activate+snapshot）；
   - list：includeArchived/sessionIds/limit 语义 parity（includeArchived schema 缺省 false）；
   - messages：afterMessageId 严格其后 + limit 尾部切片 parity（**替代 scoping 的
     「适配层方向反转」专项钉**：本批不建 rowsRange 适配层，钉的是 legacy 语义本身，
     §6.1）；
   - events：afterSeq 重编号 parity；
   - subscribe：eventSeq+events+snapshot 同一水位原子性、deliveryKind/legacyStreamSubscribed
     副作用写入（deliveryKind 为必传枚举）；
   - runtime prefs：push→缓存→物化读取（缺失→缺省值；推送后→推送值；user-execution
     惰性 shell 读取；integratedTerminalShell 判别联合按 mode 收放）；
   - createSession：parity 字段经钩子织进 createSessionRecordForV4 rawParams
     （persistence 缺省 deferred / 显式 immediate / sessionId+importedHistory 放行 /
     sessionId 无 importedHistory 拒绝）。
D. **双链路冒烟补洞**（DualLinkHarnessScout 裁决的两个空洞测试，均落地）：
   1. `tests/v4-resync-reserved.test.mjs`：**8/8**（4 场景 × 2 clientMode）。gateway 级
      resync 直测：subscribe → ingest → resync（base / forceSnapshot 两态）→ resume/
      snapshot 裁决 + post-response outbox 次序断言。实测钉住的实现事实：发布面 log seq
      每事件自增从 0 起（与 raw sequenceNumber / 水合 sourceEventSeq 解耦），base/current
      水位由观测帧派生不硬编码。
   2. `tests/v4-dual-profile-frame-contrast.test.mjs`：**1/1**。同一 gateway 同一会话挂
      desktop-continuous + web-remote-replayable 两个 connectionId，ingest 同一事件流
      （分组间隔 300ms 越过 flush 合并窗），断言 continuous 帧含 `row.delta`（inputText）
      而 replayable 帧不含、两者皆收 text 增量与结构 op、终态水位相等、终态 row.upserted
      行逐字节一致。
E. **套件**（2026-10-28 实测）：shared 474/474；services 585 零失败（578 pass + 7 skip；
   双 clientMode 边界 + 盖章 + adapter 快照在列；三个 legacy 面零新增源码断言随
   buildSessionCreateParams/buildSessionResumeParams 删除翻转为「函数已删除」断言）；
   web 41/41；desktop 451/451；ui 1125/1125；apps/acode-cli 受影响十文件 68/68
   （delivery-profile-contrast / snapshot-gap-repair / v4-deferred-live-session-repro /
   command-inbox-invariants / command-inbox-redelivery / command-redelivery-admission /
   m2-3-session-readwrite / m2-2-session-control / v4-resync-reserved /
   v4-dual-profile-frame-contrast）。**server 102/103**：唯一失败为 harness 红线登记测试，
   余量仅 `?? inbound-interaction.ts`——在途 M2-4 批次未登记的自有叶（M2-2/3/5/6/8 各叶
   均已登记，M2-4 已通报），与本批实现零因果。
F. **门禁**：typecheck shared exit 0、services exit 0；bootstrap 剩余 2 个 TS2305 全部位于
   在途 M2-4 的 interaction-broker.ts（V4_METHODS/v4InteractionRequestAckSchema 误引根桶，
   已通报属主；本批 server.ts/server-types.ts 的同类问题已修为子路径 import）；oxlint 本批
   触面 0w/0e；architecture:check --changed new 0 / regrown 0。

### 5.1 冒烟边界（如实登记）

经 DualLinkHarnessScout 全仓调查：Electron main 持续通道端到端与外部 relay→桌面
attachment 真实回路在本 headless 环境**结构性不可跑**（desktopRemoteSessions.ts 绑定
Electron；verify:remote-ssh 需 Docker 且只验 WS 升级握手）。本批以 D 节两个补洞测试 +
C 节 handler 级测试 + 既有 CLI 六套件（delivery-profile-contrast / snapshot-gap-repair /
v4-deferred-live-session-repro / command-inbox-invariants / command-inbox-redelivery /
command-redelivery-admission）+ services/server/web/desktop/ui 五包套件替代。真实双链路
冒烟列为发布期门禁（release.yml desktop-smoke / ci.yml remote-ssh），非批次验收依据。

## 6. 偏差说明

### 6.1 sessionMessages 不采 rowsRange 适配层

scoping/任务书规划「→ conversationRowsRange + services 适配层做 afterMessageId ↔
beforeRowId 方向反转」。实测三点否定：① facade 契约固定返回 `ACodeMessageWithParts[]`
（acodeSession.ts RPC 面不在本批可改文件集），rows 词汇（turnHeader/userInput/
assistantText/toolCall/…）与 legacy messages 不同形，host 侧**不存在**
rows→ACodeMessageWithParts 映射（全仓实测），采用即须新写一套投影适配器；
② 全仓无消费方（renderer/web/desktop/mobile/server 均不调用 readSessionMessages，
唯 services RPC 面注册）；③ conversationRowsRange 只有 beforeRowId 单向游标，
「最新 N 条 after X」需要反向语义，现查询面供不出。为零消费方新造投影适配器违背
无聊设计纪律，故采 parity query 换名（CLI op 直通）。若未来出现 rows 形态消费方，
届时再建适配层并补方向反转专项测试。

### 6.2 sessionSubscribe 不直替 conversationSubscribe

legacy-session-subscribe-convergence.md（2026-10-09）裁定直替阻塞：eventSeq 与
logEpoch/seq 两个水位域不能字段重命名伪造连续；frame≠legacy 事件，需投影 mapper +
owner 清理 + 进程换代 fencing；消费方（taskAdapter.onDynamicTaskEvent / harness
translate）说 legacy 词汇，最终摘除与「replayable 读路径 v4 store」同批
（taskAdapter:3140 注释）。任务书「M1 已解阻」指 UI 投影收口落地，但上述 adapter
仍不存在。本批采 v4 名空间换名承载 legacy 语义（`v4/session/subscribe` = 同一实现、
同一水位原子性），消费口径归零；frame→legacy-event 投影适配器建成前，legacy 词汇的
wire 形态保留——日落归后续批次，本 spec 登记。

### 6.3 runtimePreferences 载体非「v4 topic」

任务书「CLI 侧发射器改 v4 topic」按 v4 事实面落地为 host→CLI 推送：v4 topic 全部是
CLI 发布面（host 订阅），host 权威数据无 topic 载体；host→CLI 请求有 connectionFlow
先例。推送时机（连接 + 物化前）保持 freshness parity，见 §2.8。

### 6.4 createSession 兼容重试与 setThoughtLevel 追发删除

v4 方法名即版本边界后，unrecognized_keys 兼容重试对新链路不可达（旧 CLI 整条
v4/command 都不认识），整支删除；分支内的 sessionSetThoughtLevel 追发随之死亡。
server.ts 的 sessionSetThoughtLevel case 按 M2-1 裁决保留（旧 Host skew）。若产品需要
「新 Host + pre-v4 CLI」的 create 级回落，那是超出 M2-1/M2-2/M2-6 既定先例的新策略，
需单独裁决，不在本批。

### 6.5 session/messages result 不自立 schema（raw 直通 parity）

实现期实测：CLI op `readMessages`（server-operations.ts）直通 raw opencode
MessageWithParts（`info.id` 词汇），而 legacy-types/barrel 的
`acodeSessionMessagesResultSchema` 描述的是 normalized 词汇（`messageId/sessionId/role/
agent` 必填）——两者**不同形**。legacy services 侧该 barrel schema 只是孤儿 import，
从未挂进 `client.request` 校验（运行时真实流通的是 raw 形状；接口返回类型
`ACodeMessageWithParts[]` 是历史类型谎言）。迁移逐字 parity = 维持「不校验」：
v4 叶不立 `v4SessionMessagesResultSchema`，services `readSessionMessages` 不带 result
schema 并以类型参数承载既有接口形状。normalized messageWithParts 词汇的真实产地是
session/read snapshot 路径的 `mapMessageWithParts`（message-mapper.ts），与本 op 无涉。
初版曾误立 normalized result schema 并挂进 services 校验——任何非空消息数组即判
校验失败，属新引入的生产回归，已在批内拆除（边界测试以
`v4SessionMessagesResultSchema === undefined` 钉住该决定）。

### 6.6 createSession 门面收口对 scriptWorkflow/toolSearch 门闩的差量

legacy `session/create` 对 `scriptWorkflowEnabled`/`toolSearchMode` 的语义是「缺席 =
本机缺省档（onDemand / off）」的豁免路径；本批 createSession 走
`buildConversationCommandEnvelope` 后，门面**总是**显式写出 scriptWorkflowEnabled，
toolSearchMode 亦按三态裁决显式落值——与 desktop v4 草稿路径同一收口件，豁免缝闭合。
legacy wire 面零新增的不变量由「参数构造函数整体删除」承载（强于区域扫描）；
services 侧三个 legacy 面零新增源码断言测试（createSessionClientModeStamp /
scriptWorkflowModeFieldChain / toolSearchModeFieldChain）已同步翻转为删除断言，
legacy 会话的「缺席=缺省档」语义随 wire 面一并退役。
