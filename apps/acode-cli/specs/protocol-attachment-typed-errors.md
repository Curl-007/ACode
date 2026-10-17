# protocol-attachment-typed-errors — stream-json 协议三件 + 两件 S 增量（T1-c3 波 2）

需求源：`ACode-价值提取-Claude-2.37337-第二轮.md` T1-c3。证据（只读还原工程
`Claude-2.31226/src/beautified-claude-code/chunk-9zqnhwha.js`）：`:13427-13489`（mcp_call
STAGED/typed error/supersede）、`:15227-15246`（ui_attach answers 申报）、`:11816-11840`
（permission_check_status）、`:16393-16420`（initialize pending 清单恒在可空）、
`:14806-14812`（规则 where 三态）。机制可搬，文案不可抄：本批全部叶子按 v4 既有惯例用
中文注释自文档，不使用 zod `.describe()`（v4 目录现零使用）。

落点纪律：新命令/事件只进 v4（`packages/shared/src/acode-protocol-v4/`）；legacy 面零改动。
本批只落协议类型 + 纯函数 + spec；跨所有权消费点（bootstrap CommandInbox/gateway、contracts
事件面、P1 permission、host attachment 调度、UI）见「接线需求」，一律不在本批实现。

## 术语

- **尝试型调用（attempted call）**：请求进入执行体、可能产生副作用的调用。与「根本没被
  尝试」（解析失败、路由失败、能力缺席、会话不存在）相对。
- **业务道 / 协议道**：业务道 = 成功响应的载体（ACode：CommandAck / RPC result），失败也
  以带 typed error code 的业务响应表达；协议道 = 传输/协议层错误（ACode：JSON-RPC error、
  CommandAck `reasonCode` 的 `proto.*` 命名空间），只表示根本没尝试。
- **重投递（redelivery）**：同一 `commandId`（= request_id）再次到达 admission。

## R1 typed error 分层（叶子 `typed-call-error.ts`）

规则（证据：mcp_call describe「Staged failures come back as a success-subtype response whose
staging field carries a typed error_code; subtype:error is emitted only when the call could not
be attempted at all and means nothing ran」）：

1. **两层不得混用**：`subtype:error` 等协议道错误（ACode：`proto.*` reasonCode、JSON-RPC
   error）**只**表示根本没尝试——什么都没执行，重投递安全。尝试后的失败必须走业务道：
   成功载体上带 typed error 字段，**不得**降级成协议道错误。
2. **typed error 形状**：`{ errorCode, errorMessage?, retryable? }`。errorCode 是调用面自己
   的闭集词表（每面独立、additive 演进）；errorMessage 人类可读，任何消费方不得对它做文本
   匹配分流（与 `attachment-faults.ts` 头注同一纪律；错误码「stamped from the state the
   handler branched on, never parsed from error」）。
3. **未知码收敛为缺席**：解析方用 `parseKnownTypedCallErrorCode(value, known)` 把闭集外的
   码读成 `undefined`（证据：error_code 枚举 `.catch(void 0)` +「treat an unknown one as
   absent」）。这让新码可以先行发布而不打碎旧消费方。
4. **尝试过失败的调用重试前必须对账**：尝试型失败可能已产生部分副作用；重试安全性由该
   调用面自己的幂等/CAS 机制回答（证据：output_conflict on retry = possible-prior-success,
   reconcile by etag）。协议层只保证「层不混用」，不承诺重试安全。
5. ACode 既有对照：CommandAck 的 `proto.*`（协议道：invalidPayload/sessionNotFound/
   staleRevision…）与 `fault.*`（业务道：guard id / fault code）命名空间**已经**是这套分层；
   本叶子把它显式化（`isNotAttemptedReasonCode`），并为未来 staged/跨机调用面提供可复用的
   业务道 typed error 形状。存量 fault 词表不迁移、不改名。

## R2 exactly-one commandId 取代语义（叶子 `command-redelivery.ts`）

规则（证据：mcp_call describe「a redelivered request_id supersedes the in-flight run (it is
aborted and its response suppressed — exactly one response per request_id)」+ control_request
信封「the receiver normally answers with exactly one control_response carrying the same
request_id; a requester ignores responses for request_ids it is not waiting on」）：

1. **每个 commandId 恰好一个业务终态**。重投递不得产生第二个业务终态；旧运行的业务响应
   被压制（suppressed），不进入 settled LRU、不进入持久事实。
2. **取代（supersede）= abort 旧运行 + 收口旧投递 + 新运行接管**：旧 wire 投递以一个
   `status:"stale"` + `reasonCode:"proto.supersededByRedelivery"` 的 close-out ack 收口
   （防止 RPC 悬挂），该 ack 由 `isSupersededCloseOutAck` 判别，**不是**业务终态；随后新
   投递按正常 admission 执行，其 settle 结果才是该 commandId 的唯一业务终态。
3. **取代是闭集 opt-in，不是默认**。`SUPERSEDE_ON_REDELIVERY_COMMANDS` 初始为**空集**：
   现行命令面（sendText/compact/resolveInteraction/…）没有任何一条声明重跑安全，默认语义
   保持既有 dedupe——在飞 duplicate 共享同一 final promise（`command-terminal-state-audit.md`
   R3 不变量 2，`command-inbox-invariants.test.mjs` 已钉死；重 admission = 双重执行是该审计
   记录的历史坑，不得回退）。
4. **入集验收标准**（三条全满足才可加入）：
   a. 副作用幂等/重跑安全（重跑不会把效果执行两次）；
   b. 以 `sourceCommandId` 键控的持久事实可被新 run 安全覆盖或旧写入可被封存作废
      （旧新两 run 共享同一 commandId，事实层必须能区分世代）；
   c. 该命令的执行链路有可用的 abort 点（host 回调可实际终止旧运行，不能只压制响应）。
5. **busy/running admission 不回退**：取代判定发生在 key gate 之内、session gate 之前，
   只影响同 commandId 的重投递路径；不同 commandId 的串行 admission、admissionSeq 权威
   顺序、settle 前不放行等既有语义逐字保持。
6. 消费点（本批不实现，见接线需求 W1）：`bootstrap/src/acode-protocol-v4/command-inbox.ts`
   `handle()` 的两处 pinned 分支（:135-136、:145-149）+ `CommandInboxHost` 增可选
   `abortInFlightCommand?(envelope)`；`v4-gateway.ts` 实现 abort（queue 项按
   `queueItemIdForCommand(commandId)` 移除 / 执行中转 stop 通道）。

## R3 answers 代答能力申报（叶子 `attach-answers.ts` + `transport.ts` 增量）

规则（证据：ui_attach describe「answers: The engine's requests this client answers…The engine
sends each only to a client that named it; a client that never names any (or names []) is never
asked…On a repeated ui_attach a given list (including []) replaces the earlier one and an
absent field keeps it: send [] to stop answering」+「Idempotent per client_id」）：

1. **闭集**：可代答的请求种类 = pendingInteraction kind 闭集（`permission` / `userInput` /
   `workspaceHookReview`），单一事实源在 `snapshot.ts` 的 `pendingInteractionKindSchema`
   （本批抽出为具名导出，值不变），叶子间不得各自手写副本。
2. **attach 时申报**：clientHello 的 `capabilities.answers` 携带该 client 能代答的种类集。
   语义三态：**给定列表（含 `[]`）= 整体替换**先前的申报；**字段缺席 = 保持**先前申报
   （`resolveAttachAnswers(previous, incoming)` 是这条规则的唯一实现）；`[]` = 显式停止
   代答（此后不得再被路由任何交互请求）。
3. **按 clientId 幂等**：重复 attach 不产生第二条 roster 记录；roster 回显
   （`attachAnswersRosterSchema`）是 informational 事实，供 host attachment 调度消费。
4. **未申报不路由**：交互请求只发给申报了该 kind 的 client；从未申报（或申报 `[]`）的
   client 永不接收。消费方判断必须 `includes(kind)` fail-closed。
5. **单向声明纪律**（与 workflowRunDeltas 同款，`clientHelloSchema` capabilities 是
   `.strict()` 的）：客户端只有在 Host hello 里见到 `interactionAnswerRoster === true` 时才
   能携带 `answers` 键，否则老 CLI 整条 clientHello 解析失败、连接握不上手。
6. 消费点（本批不实现，见接线需求 W2）：`packages/services/src/acode-agent/
   acodeAgentConnectionScope.ts`（hello 注位）、`packages/ui/src/v4/
   agentV4ConnectionHandshake.ts`（clientHello 回声明）、CLI gateway 交互路由与手机远控
   attachment 调度（roster 建账 + 按 answers 定向）。

## R4 permission_check_status 进度信号（叶子 `permission-check-status.ts`）

规则（证据：permission_check_status describe「'checking': the call has waited about four
seconds on its check and is still waiting. 'done': that wait is over…Most checks answer within
about four seconds and send nothing…Every 'checking' is followed by a 'done' for the same
tool_use_id…Display-only and best-effort」）：

1. **阈值 4s**：`PERMISSION_CHECK_STATUS_SLOW_THRESHOLD_MS = 4_000`。依据：证据面「约四秒」；
   ACode 侧最慢自动检查路径是 auto 模式风险分类器，`AUTO_CLASSIFIER_TIMEOUT_MS = 15_000`
   （core/src/permission/auto-risk-classifier.ts:21），4s 阈值给分类等待留出 ~3.75 倍于
   阈值的静默窗口，快检查零信号。
2. **配对不变量**：每个 `checking` 必有同 `toolCallId` 的 `done` 跟随；一次调用可发多对；
   `done` 不携带裁决（allow/deny 由工具结果、permission_denied 或交互请求本身表达）。
3. **display-only、best-effort**：信号可丢帧。显示端必须在收到该 toolCallId 的**任何其他
   帧**或回合结束时立即清除指示，不得依赖 done 必达。叶子提供纯 reducer
   （`permissionCheckStatusDisplayReducer`）作为显示端收敛的唯一读法。
4. **不进 snapshot/持久事实**：与 `v4/telemetry/event` 的 live-only 纪律同族（重放不补造）。
5. 发出点与信道（本批不实现，见接线需求 W3）：唯一自然的发出点是
   `core/src/runtime/methods/auto-risk-classifier-sidecar.ts` `runClassifierSidecar` 对
   `model.generateText` 的 await（4s timer 包裹）；上 wire 需要 contracts 新 SessionEventType
   + bootstrap `conversation-telemetry-facts.ts` 投影 + hello 位 `permissionCheckStatus`
   门控（老 host 未声明则 CLI 不发）。

## R5 attach 响应 pending 交互提示清单恒在可空（叶子 `pending-permission-hints.ts` + `conversationSubscribeAckSchema` 增量）

规则（证据：initialize 响应 `pending_permission_requests`「Always present (possibly empty) on
a success initialize response from v2.1.268 or later; earlier versions could omit it, so treat
absence as an older CLI rather than as 'nothing pending'」）：

1. **ACode 落点**：v4 无独立 initialize RPC；会话 attach 的对应面是 conversation subscribe
   的 ACK（`conversationSubscribeAckSchema`）。新增字段 `pendingInteractionHints`：
   schema 上 `nullable().optional()`（偏斜安全：新桌面解析老 CLI 的 ack 不得失败），
   **发出侧纪律**：新 CLI 起该字段**恒在**（可空）。任务口径「pending 权限提示清单」在
   ACode 覆盖交互 kind 全闭集（权限是其中主要成员），故命名 interaction 而非 permission。
2. **字段存在性做版本判代**（`readPendingInteractionHints` 是唯一读法）：
   - 字段缺席 = 老 CLI 世代（legacy），**不得**推断成「无 pending」；完整清单仍以后续
     snapshot 帧的 `pendingInteractions`（恒在数组）为权威；
   - `null` = 新世代但本次响应不枚举（如投影尚未就绪）；
   - `[]` / 非空数组 = 新世代的确定清单。
3. **与 `V4_WIRE_PROTOCOL_VERSION` 的关系**：wire 版本是**连接级**协商（hello/clientHello
   双端 `z.literal(3)`，不同代直接握不上手）；字段存在性是**响应级**判代探针，用于同一
   wire 代内的字段级能力差异——relay 转发、web-remote-replayable 客户端缓存旧 schema 构建、
   以及未来 wire bump 后的混合窗口里，literal 版本无法表达「这个字段这一代有没有」。两者
   互补；禁止用字段存在性反推 wire 版本，也禁止用 wire 版本替代字段判代。
4. hint 是轻量引用（interactionId/kind/toolCallId?/toolName?/createdAt/anchorRowId），不是
   payload 副本；与 snapshot `pendingInteractions` 冲突时以 snapshot 为准。
5. 消费点（本批不实现，见接线需求 W4）：CLI 侧 ack 构造在 bootstrap `v4-gateway.ts`
   subscribe 处理（恒在发出 + 从会话投影取 hints）；客户端读法接入
   `packages/services/src/acode-agent/acodeAgentService.ts` /
   `packages/ui/src/v4/agentV4ConnectionHandshake.ts` 的 attach 链路。

## R6 权限规则 where 三态（叶子 `permission-rule-where.ts`）

规则（证据：list_permission_rules 行 `editability: ['persistent','session','readonly']`
「Informational for hosts; this request never changes rules」+ notInEffect「managed settings
pin…Such rows are readonly」）：

1. 三态闭集：`persistent`（落设置文件的持久规则）/ `session`（仅内存、本会话有效，含 TTL
   授权——到期回落）/ `readonly`（托管策略、policy floor、breakers 等 host 不可编辑集）。
2. **informational for hosts**：携带 where 的查询/回显是只读面，永不修改规则；where 不参与
   任何权限裁决（裁决只认 behavior + 规则匹配 + 策略地板）。
3. 协议侧提供存储类别→where 的映射表（`PERMISSION_RULE_WHERE_BY_STORAGE`）作为读法示例；
   **权威映射与规则枚举面在 P1 的 core/src/permission**（规则存储事实源：项目 ruleset /
   sessionRules / policyFloor / TTL grants），本批不落任何消费代码。
4. `notInEffect: true`（被托管 pin 忽略的行）必须 `where:"readonly"`（schema refinement
   钉死）；rule 字符串按存储原文 VERBATIM 承载，转义是显示层责任（证据：「Can carry
   invisible or control characters by design — escape at display」）。

## 验收场景

1. R1：`parseKnownTypedCallErrorCode("fault.x.newCode", 旧闭集)` → `undefined`；
   `isNotAttemptedReasonCode("proto.invalidPayload")` → true、`("fault.command.x")` → false；
   业务道失败形状过 `typedCallErrorSchema` strict 校验，多键拒绝。
2. R2：`resolveCommandRedelivery(t)` 对**全部**现役 CommandType 返回 `share-final`（默认集
   空 = 零行为变化）；注入含成员的集合时返回 `supersede`；close-out ack 过
   `commandAckSchema` 且被 `isSupersededCloseOutAck` 判别、不被误判为业务终态；真实
   CommandInbox 在飞重投递仍共享 final（duplicate），既有不变量套件不回退（CLI 侧测试）。
3. R3：`resolveAttachAnswers(prev, undefined)` = prev；`(prev, [])` = `[]`；重复 attach 幂等；
   clientHello 带 `answers` 过 schema、老形状（无 answers）原样过；hello 无
   `interactionAnswerRoster` 位时客户端不得申报（单向纪律注释 + 消费点门控）。
4. R4：reducer 收 checking 亮指示、done 熄灭、任何其他帧熄灭、多对不串扰；阈值常量 = 4000。
5. R5：`readPendingInteractionHints` 三态判代（缺席/null/[]）；老形状 subscribe ack
   （无该字段）仍过 schema；新形状（null 与数组）过 schema。
6. R6：映射表覆盖全部存储类别；`notInEffect:true` + 非 readonly 被拒；where 枚举闭集外值被拒。

## 接线需求（跨所有权，本批未实现）

- **W0 shared barrel**：六个新叶子经 `acode-protocol-v4/index.ts`（v4 自身结构，本批已加）
  即从 `@acode/shared/acode-protocol-v4` 子路径可达（package.json exports 直指该 index）；
  `packages/shared/src/index.ts` 根 barrel **无需**改动，本批未触碰（禁改面）。若需根 barrel
  再导出，请路由给 shared barrel 所有者。
- **W1（R2）**：bootstrap `command-inbox.ts` pinned 两分支接 `resolveCommandRedelivery`；
  `CommandInboxHost` 增可选 `abortInFlightCommand?`；`InFlightEntry` 增 suppressed 标记，
  旧 execute 的 settle 在被取代后 no-op（close-out 不入 settled LRU / 持久事实）；
  `v4-gateway.ts` 实现 abort 回调。空集下全部为惰性路径，可与 R2 入集评审同批落。
- **W2（R3）**：services 连接域 hello 注 `interactionAnswerRoster` 位；UI 握手按位回声明
  `answers`；CLI/host 交互路由按 roster 定向（手机远控 attachment 调度消费 roster 回显）。
- **W3（R4）**：contracts 新 SessionEventType（如 `permission_check_status`）+ sidecar 4s
  timer 发出 + bootstrap 事实投影（live-only）+ hello 位 `permissionCheckStatus` 门控 +
  UI 工具行「检查中」指示（用叶子 reducer）。
- **W4（R5）**：bootstrap subscribe ack 构造恒在发出 `pendingInteractionHints`；attach 链路
  （services/UI）接 `readPendingInteractionHints` 判代。
- **W5（R6）**：P1 权限面落规则枚举查询（host 只读面），用叶子 where 三态 + 权威映射表。
