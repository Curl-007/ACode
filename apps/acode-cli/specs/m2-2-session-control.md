# M2-2 session 控制面四方法迁 v4（compact / goal / close / debug）

> 状态：**已实施**（2026-10-28）。
> 实施记录（验收节逐项证据）：
> A. `acodeProtocolMethods.` 消费：本 worktree 当前树（M2-5/M2-6 已落地）47 → 43（**−4**，
>    四目标方法 `sessionCompact/sessionGoal/sessionClose/sessionDebug` grep 实测归零；
>    M2-1 后原始基线 72 累计已降至 43，其余为兄弟批次成果）。
> B. shared 协议单测 protocol-boundary.test.mjs 22/22 绿（closeSession payload 值域与
>    legacy acodeSessionPersistenceSchema 逐字一致钉住、clearGoal 空形态、goalControl/
>    closeSession result variant、goal/debug query schema strict 与 debug result 中立叶同一性）。
> C. CLI handler 测试 tests/m2-2-session-control.test.mjs 11/11 绿（closeSession
>    expectedPersistence 三态钉住——mismatch 不调 host.closeSession 且 closed:false；
>    goal query supported/target 映射；debug 直通；clearGoal hadTarget 两态；
>    compact instructions `/compact <instructions>` 线程 + compactOperationLock 拒绝词）。
> D. 套件：shared 454/454；services 578 pass/0 fail（7 skip 基线）；CLI 受影响八套件
>    61/61 + 本批 11/11。
> E. typecheck：shared / services / bootstrap 三包 exit 0；oxlint 本批文件 0w/0e
>    （command.ts max-lines 经 result variant 拆叶 session-control.ts 解决，M2-5 通报协调）；
>    architecture:check --changed new 0 / regrown 0（acodeSessionGoalSchema 白名单经
>    review 显式登记于 scripts/architecture/protocol-boundary.mjs）。
> 冒烟：§5.1 如实登记——双链路真实冒烟环境结构性受限未跑，以上述 handler 级测试 +
>    队列/投影不变量套件 + services 全套替代（DualLinkHarnessScout 全仓调查佐证）。
> 关联：docs/reviews/2026-10-28/m2-scoping.md §5 M2-2 条目、§6.3 裁决（compact instructions 保留 /
> close≠delete 并存 / debug 保留新建 v4 query / goal query 形态随本批设计）；
> M2-1 迁移样板 commit 5da76197（`acodeAgentService.sendSessionConfigCommandV4` 路径）。

## 1. 范围与判据

迁移四个 legacy 方法的 **services 消费侧**（`acodeProtocolMethods.` 点号消费实测 72 → 68）：

| legacy 方法 | services 消费点（迁移前） | v4 归宿 |
|---|---|---|
| `session/compact` | acodeAgentService.ts `compactSession` | v4 command op `compact`（M2-1 已有，payload 含 `instructions`） |
| `session/goal` | `goalSession` | set/replace→`sendGoalCommand`、pause→`pauseGoal`、resume→`resumeGoal`、clear→**新 `clearGoal`**、show→**新 query `v4/session/goal`** |
| `session/close` | `closeSession` | **新 command op `closeSession`**（≠ deleteSession） |
| `session/debug` | `readSessionDebug` | **新 query `v4/session/debug`** |

消费归零后删除 legacy dispatch 四 case（server.ts）与对应 legacy op 实体
（server-operations.ts 的 `compactSession`/`goalSession`/`closeSession` 及其私有件；
session-debug.ts 的 `querySessionDebug`——观测写入 `observeSessionDebug`/`readSessionDebug`
保留，v4 handler 复用）。

## 2. 行为规格

### 2.1 compact（裁决 1：instructions 透传）

- **协议面**（M2-1 已落）：`commandPayloadSchemas.compact = { instructions?: string }`。
- **CLI handler 消费接线**（本批）：`instructions?.trim()` 非空 → 提交文本
  `` `/compact ${instructions.trim()}` ``，否则 `/compact`——与 legacy
  `compactSession`（server-operations.ts:2004-2005）逐字一致。该文本贯穿三处：
  ① idle 直启 `startManualCompact`；② busy/held 入队（intent text 与 queue item text）；
  ③ 队列提升（queue.ts `kind==="compact"` 分支把 `queueItem.text` 透传进
  `startManualCompact`，重启恢复的旧队列项文本恒为 `/compact`，透传天然兼容）。
- **facade**（services `compactSession`）：
  - 发 v4 command op `compact`（非 CAS，与协议注释一致：admission 与 revision 无关），
    `timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS` 保留（ACK 边界放宽，终态仍由
    timeline/snapshot 推送——注释语义不变）。
  - facade 契约 `{ response, snapshot, compact.state }` 保持：v4 只回 ACK，snapshot 经
    `requestSessionStateSnapshot`（M2-1 单点，legacy `session/read`，M2-3 才迁读路径）
    ACK 后回读。
  - **already_running 等价物**：legacy 在 compact 运行中返回
    `{ compact: { state: "already_running" } }`  graceful 收口；v4 handler 同情形抛
    `compactOperationLock` → ACK `failed`。facade 把 `ack.status==="failed" &&
    ack.reasonCode==="compactOperationLock"` 映回 `already_running` 结果（读回 snapshot），
    adapter 的 `result.compact?.state === "accepted"` 分支语义不变。其它 failed/rejected
    经 `assertV4CommandAckOk` 抛结构化错误。
  - **busy 语义收敛（有意的行为变更）**：legacy busy 时抛 -32010「Cannot compact while a
    prompt is running」；v4 原生语义是 FIFO 入队（与 v4 UI `/compact` 一致）。facade 采 v4
    原生语义：入队 = accepted。仓内无消费者依赖 busy 抛错（adapter 只消费
    state/response/snapshot）。
  - `expectedRevision` 不透传（legacy stateRevision 与 v4 conversation revision 不互通，
    M2-1 同例）。

### 2.2 goal（裁决 4：query 形态 + clear 补全）

- **新 query `v4/session/goal`**（读面）：params `{ sessionId }`；result
  `{ supported: boolean, target?: acodeSessionGoalSchema | null }`。
  - CLI handler 走 `requireSession`（**live record 查询**，与 legacy `goalSession` 同一定域；
    刻意不做 headerMeta 式持久层冷读——goal 的权威是 runtime target 面，`app.readTarget`）。
  - `supported=false` 承载 legacy「Goal management is not available in this client.」分支
    （`!record.app.readTarget`）；`supported=true && target=null` = 无目标。
  - wire 形态复用 `acodeSessionGoalSchema`（legacy-types 叶，v4 已有 import 先例），CLI 侧
    用既有 `mapSessionGoal`（session-mapper.ts，本批导出）收窄。
- **新 command op `clearGoal`**（payload `{}`，非 CAS）：legacy `action:"clear"` 的 v4 等价
  （保守无能力损失——adapter 注释明示 clear 依赖旧 op 结构化 action 面；v4 UI slash 层
  标 unsupported 是产品面取舍，不回收协议能力）。handler：`readTarget` 无目标 → 幂等成功；
  有目标 → `clearTarget()` + `afterLegacyStateMutation("goal_cleared")`。
- **goalControl typed result**：`sendGoalCommand`/`pauseGoal`/`resumeGoal`/`clearGoal`
  原地执行（非入队）时回 `{ type:"goalControl", action, hadTarget, target, startedTurn,
  planContinuationSkipped? }`：
  - `hadTarget` = 裁决前目标存在性（clear/pause/resume 的「No goal to …」文案判据；
    set 时 = replacesExistingGoal）。
  - `target` = 裁决后目标 wire 态（clear 恒 null）。
  - `startedTurn` = legacy `continueGoalAfterChange` 的 `canContinue`
    （`!isPlanMode && !activeAbortController`）；pause/clear 恒 false。
  - `planContinuationSkipped` = set 落库遇 plan 模式未续跑（legacy 在 response 尾部追加
    `Plan mode 下已记录 goal，但不会自动继续。` 的事实源）。
  - 入队收口（busy 时 sendGoalCommand 走 FIFO）ACK 不带 result；facade 按
    startedTurn=false、response="" 收口（legacy busy 抛错 → v4 原生入队，同 2.1 的收敛）。
- **facade**（services `goalSession`）按 action 分派；回执文本逐字复刻 legacy
  （formatGoalSummary/formatGoalChanged/usage/No-goal 文案与 plan 提示，services 侧小纯函数）：
  - show → goal query；set/replace → `sendGoalCommand { text: objective.trim() }`（空 objective
    不发命令，直接回 legacy usage 文案 + 读回 snapshot）；pause/resume → CAS
    （`sendHostCasCommandV4`，M2-1 收敛件）；clear → `clearGoal`。
  - snapshot 一律 ACK 后 `requestSessionStateSnapshot` 回读（facade 全量快照契约，M2-1 同例）。
  - **已知分叉（v4 原生 guard 承接）**：resume 遇 plan 模式且目标存在时 v4 抛
    `guard.planGoalMutuallyExclusive`（legacy 落库不续跑 + 提示文案）。该路径仓内无消费者，
    采 v4 原生语义，不削弱 v4 guard。

### 2.3 close（裁决 2：close ≠ delete）

- **新 command op `closeSession`**：payload
  `{ expectedPersistence?: "immediate" | "deferred" }`——legacy `expectedPersistence` 断言的
  **等价物承载**（值域与 `acodeSessionPersistenceSchema` 逐字一致；非 CAS——legacy close 本无
  revision 断言，persistence 匹配本身就是它的条件断言语义，对应
  `shouldCloseSessionForExpectedPersistence`）。
- **CLI handler**（session-mgmt.ts）：`record.persistence` 与 payload 断言不匹配 → typed
  result `{ type:"closeSession", closed:false }`（**graceful no-op，不是错误**——legacy 返回
  `{closed:false}` 同理）；匹配/缺席 → `host.closeSession(sessionId)`（与 deleteSession 同一
  过渡钩子，v4-bridge 内联四步：退订→app.close→gateway dispose→注册表摘除）→
  `{ closed:true }`。
- `deleteSession` 语义不动（无条件关闭+清理）。
- **facade**：v4 command op `closeSession`；`closed` 读 typed result，缺省 `?? true` 的旧兼容
  行保留（面向不产 result 的旧 Agent 容忍，schema 上 v4 必带）。
- 断言语义测试钉住：mismatch 不调 `host.closeSession` 且 `closed:false`；match/缺席执行且
  `closed:true`（见 §5 验收 C）。

### 2.4 debug（裁决 3：保留，新建 v4 query）

- **新 query `v4/session/debug`**：params `{ sessionId }`；result = 既有
  `sessionDebugSnapshotSchema`（packages/shared/src/session-debug.ts，中立模块，零新建词汇）。
- **CLI handler**（新叶 `acode-protocol-v4/session-debug-query.ts`）：`requireSession` +
  `readSessionDebug(record)`（legacy session-debug.ts 的观测存储原样保留；只删 legacy
  dispatch 与 `querySessionDebug` 转发壳）。实体放 v4 目录、server.ts 一行转发（M3 纪律，
  同 session-header-meta-query.ts 先例）。
- **facade**：`readSessionDebug` 保持 `getReadOnlyClient(params, "existing-only")` 策略，
  仅换 method 名与（同一）result schema。live-only 语义不变（无 record → requireSession
  抛 sessionUnavailable，与 legacy 一致）。

## 3. 所有权与不变量

- `commandPayloadSchemas`/`commandResultSchema`/`V4_METHODS`：shared v4 叶唯一权威；
  `command.ts` 不得 import legacy barrel（protocol-boundary 测试钉住），goal wire 复用
  `acode-protocol-legacy-types.ts`（snapshot.ts 已有先例）。
- v4 命令失败语义：handler 抛带 `reasonCode` 的领域错误 → ACK `failed` + reasonCode 上行；
  facade 只把 `compactOperationLock` 映回 graceful already_running，其余一律抛。
- legacy 面只删不增：四 case 删除后 `acodeProtocolMethods.sessionCompact/sessionGoal/
  sessionClose/sessionDebug` 在 services 消费归零；legacy schema 词保留（旧 Agent  skew
  容忍与测试基线），dispatch 不再可达。
- 队列身份：compact 带 instructions 的队列项 `kind:"compact"` 不变；queue promotion 透传
  `queueItem.text` 进 `startManualCompact`，旧队列项（文本恒 `/compact`）行为不变。

## 4. 失败语义

| 场景 | v4 收口 | facade 映射 |
|---|---|---|
| compact 重复（running/queued） | ACK failed `compactOperationLock` | graceful `already_running` + 回读 snapshot |
| compact/goal 遇 restoreWarning | ACK failed `restoreWarning` | 抛（legacy 同抛 -32031） |
| goal set 空 objective | facade 短路：usage 文案 + 读回 snapshot（不发命令） | 同 legacy |
| goal clear/pause/resume 无目标 | ACK accepted + goalControl `hadTarget:false` | legacy「No goal to …」文案 |
| close expectedPersistence 不匹配 | ACK accepted + `{closed:false}` | 返回 false |
| closeSession 会话不存在 | handler requireRecord 抛 → ACK failed | 抛（legacy requireSession 同抛） |
| debug/goal query 会话不存在 | requireSession 抛协议错误 | 抛（legacy 一致） |

## 5. 验收

A. **消费计数**：`acodeProtocolMethods.` 在 packages/services 实测 72 → 68（−4），grep 证据。
B. **协议单测**（packages/shared/tests/protocol-boundary.test.mjs）：closeSession payload
   expectedPersistence 两值收/非法值拒/缺省收；clearGoal 空 payload；goalControl 与
   closeSession result variant 形态。
C. **CLI handler 测试**（apps/acode-cli/tests/m2-2-session-control.test.mjs）：
   closeSession expectedPersistence match/mismatch/缺席三态（mismatch 不调 host.closeSession）；
   goal query supported/target 两态；debug query 快照直通；clearGoal hadTarget 两态；
   compact handler instructions 线程（idle 直启文本 = `/compact <instructions>`）。
D. **受影响套件全绿**：shared tests、services tests、apps/acode-cli tests 中受影响套件。
E. **typecheck**：shared / services / bootstrap 三包零错误。

### 5.1 冒烟边界（如实登记）

compact（snapshot 重写）与 close（终止 snapshot）在 13 个 replayable 高危名单内。
经 DualLinkHarnessScout 全仓调查：**双链路真实冒烟（desktop-continuous Electron 持续通道 +
web-remote-replayable 外部 relay 回路）在本 headless 环境结构性不可跑**
（desktopRemoteSessions.ts 绑定 Electron；verify:remote-ssh 需 Docker 且只验 WS 升级握手）。
本批以以下替代（全部 headless 可跑）：
- 本批 C 节 handler 级测试（compact/close 执行面语义直测）；
- CLI 既有队列/投影不变量套件：command-inbox-invariants、command-inbox-redelivery、
  command-redelivery-admission、delivery-profile-contrast、v4-deferred-live-session-repro；
- services 全套（含 connection-scope 双 clientMode 边界）。

与 M2-1 同一先例：真实双链路冒烟列为发布期门禁（release.yml desktop-smoke /
ci.yml remote-ssh），非批次验收依据。
