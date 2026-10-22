# product-projection.ts 结构拆分 spec（v4 权威投影）

状态：进行中。批次 1（module-level 纯叶子抽出）已落地；批次 2+（class body 按事件域拆分）**被前置条件阻塞**。
位置：`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/product-projection.ts`。
背景 finding：`docs/reviews/2026-10-22/cli-core-structure.md` §2 [P2]、§4 巨型文件 Top 12 #1（6075 行，仓内最大单文件）。

## 1. 为什么这个文件不能直接按事件域拆

`ProductProjection` 是 CLI v4 权威投影第二 reducer：输入 `SessionEvent` 日志，输出 `ConversationDelta[]`，快照推进复用协议规范 `applyConversationDeltas`（逐字节一致是构造保证）。当前它是**单个有状态 god-class**（源 468–5916，约 5449 行）：

1. **约 60 个共享可变私有字段**（`this.snapshot` 被引用 141 次，`turnHeaderRowIdByTurnId`/`toolRowIdByCallId`/`turnUsageByTurnId`/`sessionToolStats` 等被多个事件域交叉读写）。
2. **`cloneProjection`/`adoptProjection` 手工逐字段枚举**（源 1155–1292）：`applyEventAtomically` 靠它在独立候选投影上归约、校验通过才原子提交、失败整体回滚。这是 16MiB 帧闸门与 rollback 隔离的正确性不变量——**漏拷任一字段 = 静默行为改变**（如 `sessionId` 漏拷曾导致 ::visualize live 链永久 MISS，见源 1157–1160 注释）。
3. **无黄金等价测试**：文件头注（2026-10-05 核实）明确「独立重放交叉验证黄金测试尚未建成，构造保证是当前唯一机械保障」。现有 59 个投影测试是行为点检（spot-check），**不是全投影 delta 流等价 harness**，无法机械捕获拆分引入的字段/clone 遗漏。

把 class body 的 `onXxx` handler 移到姊妹模块，只有两条路，都违反「行为完全不变」：
- (a) 把约 60 个私有字段放宽为 public/internal 让外部模块访问 —— 这正是本 review 周期 P1 要**移除**的原型注入 + `this: Internal` 反模式（`cli-core-structure.md` §2 P1）。
- (b) 传 `this`/巨型 context 对象给外部 handler —— 耦合原样搬迁，且任何 clone/adopt 字段遗漏静默破坏原子提交，无测试可捕获。

结论：class body 的事件域拆分**必须在等价 harness 建成之后**才能机械安全地做。本 spec 登记域划分、公开面契约、前置条件与批次，先落地零风险的纯叶子抽出。

## 2. 事件域划分（reduce() dispatch 的真实域，源 1436–1565）

按 `reduce()` 的 `switch(event.type)` 与状态簇归并，投影实际处理 14 个事件域。每域列出：输入事件、产出 delta、独占/共享状态字段、跨域耦合点。这是批次 2 拆分的目标模块边界。

| # | 域 | 输入事件（SessionEventType） | 主要产出 | 独占状态字段 | 跨域耦合点 |
|---|---|---|---|---|---|
| D1 | session-lifecycle | SessionCreated / SessionResumed / SessionTitleUpdated / SessionForked / RewindTriggered | session 头、title row、fork marker、rewind 清理 | `sessionId`、`rewoundHookInvocationIds`、`invalidSubagentChildSessionIds`、`stableCompactCoverageBoundaryRowId` | resume 清 D7 pendingHook；fork/rewind 触碰 D4 editTarget 与 D11 goal |
| D2 | turn-lifecycle | TurnStarted / TurnComplete / TurnError | turnHeader row、轮收口 stats flush | `currentTurnId`、`currentProductTurnStartedAtMs`、`currentTurnStartedModelOnly`、`turnHeaderRowIdByTurnId` | 收口 flush D14 usage/metrics；TurnStarted 触发 D7 flushPendingSessionHookInvocations |
| D3 | model-stream | ModelStreaming / ModelNetworkStatus / StreamRecovery{Started,TailDiscarded,RetryStarted} / ModelSelected / ModelComplete | 流式 text/reasoning row、apiRetry、config、usage 累加 | `streamingTextRowId`、`streamingReasoningRowId`、`outputContinuation*`、`lastTurnModel`、`configModel*`、`contextWindowState`、`turnUsageByTurnId`、`lastTurnCacheMissTotal` | ModelComplete 写 D14 turnUsage/turnMetrics；config 与 D9 mode 共享 snapshot.config |
| D4 | tool-call | ToolCallScheduled / Started / Progress / Result / Error / AssistantFeedbackUpdated | toolCall row 状态机、input 流式、display 收窄、deferred 定稿 | `toolRowIdByCallId`、`openForegroundToolCallIds`、`fileToolInputPreviewByCallId`、`toolTerminalCountedIds` | 终态计数进 D14 sessionToolStats；permission 交互由 D5 挂到 tool row；AskUserQuestion/ExitPlanMode 生成 D5 pendingInteraction |
| D5 | permission-interaction | PermissionRequested / PermissionResolved / PermissionDenied / UserInputAutoResolutionUpdated | pendingInteraction row、选项构建、settle | `deliveryByPendingInputId`（共享）、snapshot.pendingInteractions | 挂/解 D4 tool row 的 approval 状态；与 D6 共用 pendingInteraction 生命周期 |
| D6 | workspace-hook-review | WorkspaceHookReview{Requested,Settled,Superseded} / WorkspaceHookAdmissionUpdated | hook review pendingInteraction、单调性裁决 | snapshot.pendingInteractions | 复用 D5 pendingInteraction 移除路径；裁决单源在 `@acode/shared/workspace-hook-review-monotonicity` |
| D7 | hook-run | HookRun{Started,Progress,Completed,Failed,Blocked} | hookInvocation row（executions 聚合、lane 映射、block error） | `hookRowIdByInvocationId`、`pendingSessionHookInvocations`、`rewoundHookInvocationIds`（共享 D1） | TurnStarted(D2) flush pending；SessionResumed(D1) clear pending；rewind(D1) 标记 rewound |
| D8 | turn-steer-queue | TurnSteer{Queued,DeliveryChanged,DispatchChanged,Drained,Discarded,Reordered} / SessionInputPromoted / QueueAutoDrainChanged | queue item row、delivery/dispatch 标记、product turn split | `deliveryByPendingInputId`（共享 D5）、`productTurnSplitOrdinalByRuntimeTurnId`、snapshot.queue | splitProductTurn 触碰 D2 turn 身份与 D1 productTurnIdByRuntimeTurnId 映射 |
| D9 | mode | FollowupModeChanged / SessionModeChanged | snapshot.config.mode / followupMode | `configModeTouchedByEvent` | 与 D3 config 共享 snapshot.config；事件日志优先于 seed |
| D10 | compact | CompactStarted / CompactCompleted / CompactFailed | compact marker row、coverage boundary | `compactMarkerRowIdByOperationId`、`stableCompactCoverageBoundaryRowId`（共享 D1） | boundary 影响 D1 fork candidate 稳定性判定 |
| D11 | target-goal | TargetChanged / TargetCompletionVerification | goal state patch、goal-verify marker row | `goalVerifyMarkerRowIdByLifecycleKey`、snapshot.goal | goal continuation 触发 D2 model-only turn |
| D12 | background-workflow | BackgroundTask{Started,Updated,Completed} / DynamicWorkflowRunProgress / SwarmPlanProgress / PluginStateUpdated | background work summary、workflowRuns/swarmPlan 键级 delta、pluginStates | snapshot.backgroundWork / workflowRuns / swarmPlan / pluginStates | reduce 单源在 `@acode/shared`（reduceWorkflowRunsState / reduceSwarmPlanState）；background notification 文本由 D4 tool update 承载 |
| D13 | subagent | SubagentSpawned / SubagentMessage / SubagentStopped | subagent row、前台/后台生命周期、镜像 tool 事件、cumulative tokens | `subagentRowIdByAgentId`、`subagentCumulativeTokensByChildSessionId`、`invalidSubagentChildSessionIds`（共享 D1）、`latestListAppsSnapshot`(cua) | 镜像 D4 tool 事件（isMirroredSubagentToolEvent）；spawn 复活 D1 invalid 集合；tokens 进 D14 |
| D14 | usage-metrics（横切） | 由 D2/D3/D4/D13 在收口点驱动 | turnHeader.stats、composerTurnMetrics、sessionToolStats | `turnUsageByTurnId`、`turnMetricsAccumulator`、`lastEmittedComposerTurnMetrics`、`sessionToolStats`、`lastEmittedSessionToolStats`、`fileChangesByTurnId` | 纯累加逻辑已抽到 `product-projection-usage.ts`/`-turn-metrics.ts`；接线与 clone/adopt 仍在 class |

跨域横切状态（**批次 2 的主要纠缠源**）：`snapshot`（全域）、`rowIndexById`/`messageIdByRowId`/`entityIdByRowId`（D1/D2/D4 行索引）、`productTurnIdByRuntimeTurnId`/`runtimeTurnIdByProductTurnId`（D1/D2/D8 轮身份映射）、`hydrationAccumulator`（hydration 重放路径）、`normalizationDiagnostics`/`droppedContentStreamEventCount`（诊断）。

## 3. 公开面契约（拆分中必须保持不变的导入面）

`product-projection.ts` 对外是稳定导入面，以下消费者依赖它，**任何拆分都不得改变这些导入路径**：

- `v4-gateway.ts`：`import type { SessionConfigSeed, SessionSubagentsSeed, SessionUsageSeed, ConversationRowTargetAction }`；运行时 `new ProductProjection(...)`、`.applyEvent`/`.applyEventAtomically`/`.getSnapshot`/`.resolveRowActionTarget`/`.seedConfig`/`.seedUsage`/`.seedSubagents`。
- `conversation-topic-publisher.ts`：`SessionConfigSeed`、`SessionUsageSeed`、`SessionSubagentsSeed`、`StableForkCandidateResolution`、`ConversationRowTargetAction`、`ConversationRowTargetResolution`。
- `stable-fork-target.ts`：`StableForkCandidate`。
- `commands/types.ts`、`commands/handlers/fork-edit-retry.ts`：`ConversationEditTarget`、`ConversationRowTargetAction`、`ConversationRowTargetResolution`。
- 测试（11 个 `.test.mjs`）：`import { ProductProjection } from ".../product-projection.ts"` 及动态 `await import(...)`。

保持手法（沿用 `eb6760d2`/`fb4c6e7b` 先例）：类型/纯函数移到姊妹模块后，`product-projection.ts` 用 `export type { ... } from './product-projection-types.js'` **re-export** 保持公开面；`ProductProjection` class 与其公有方法签名不动。

## 4. 批次计划

### 批次 1（本批已落地）：module-level 纯叶子抽出

把 class 之外、无 `this` 依赖的纯类型/常量/函数按域移到姊妹模块，主文件 import 回来、公开类型 re-export。零行为风险（纯函数、无共享状态），tsc + 59 测试可完全验证。产物：

| 新模块 | 内容（域） |
|---|---|
| `product-projection-types.ts` | 公开契约类型 + 内部状态类型：SessionConfigSeed / SessionUsageSeed / SessionSubagentsSeed / StableForkCandidate(+Resolution) / ConversationEditTarget / ConversationRowTargetAction / ConversationRowTargetResolution / HookInvocationRowContent / PendingSessionHookInvocation / ContextWindowProjectionState / FileToolInputPreviewState / TurnModelBaseline |
| `product-projection-primitives.ts` | 通用值 helper：positiveInteger / nonNegativeInteger / isPlainRecord / nonEmptyString |
| `product-projection-hooks.ts` | D7 hook 纯 helper：HOOK_SCRIPT_RUNNERS / USER_PROMPT_HOOK_BLOCK_ERROR_TYPE / unquoteHookDisplayToken / hookCommandLabel / hookExecutionDisplayName |
| `product-projection-model.ts` | D3 model/retry 纯 helper：LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK / cloneSparseModelSelection / sameSparseModelSelection / modelRetryReasonCode / streamRecoveryReasonCode |
| `product-projection-tool-display.ts` | D4/D5 tool-call + ask-user 纯 helper：TOOL_TERMINAL_STATUSES / readToolCallDurationMs / toProtocolToolCallDisplay / stringifyToolInput / finalizeDeferredToolCallRow / isAskUserQuestionToolName / isExitPlanModeToolName / createExitPlanModeApprovalQuestion / readAskUserQuestionPayloadQuestions(+ readRawAskUserQuestions / normalizeAskUserQuestionPayload{Question,Option}) |

批次 1 后主文件仍 >400（class body 未动），`max-lines` 头注豁免**收窄**为「纯叶子已抽出，剩余 bulk 是有状态 ProductProjection class，待等价 harness 前置条件（见 §5）」。`architecture-policy.yaml` 例外登记由架构代理 L 处理（本代理无所有权）。

### 批次 2（前置条件阻塞，未落地）：建黄金等价 harness

**这是 class body 拆分的硬前置。** 建一个 replay-equivalence 测试：录一段代表性 `SessionEvent` 日志（覆盖 14 域的典型序列 + hydration 重放 + applyEventAtomically 拒绝/回滚路径），逐事件喂给 `ProductProjection`，把产出的完整 `ConversationDelta[]` 流与最终 `ConversationSnapshot` 做逐字节快照断言。此后任何拆分只要 harness 绿即证明 delta 流不变。文件头注宣称的「独立重放交叉验证」正是此物，从未建成。

### 批次 3+（依赖批次 2）：class body 按域拆分

harness 就位后，按 §2 域边界把 `onXxx` handler 族逐个移出。两条候选路径，**都需在 harness 保护下验证**，且需先解决约 60 字段的 clone/adopt 单一真源问题（否则每移一域都要手工同步 clone/adopt，遗漏即静默 bug）：

- 路径 A（推荐）：先把约 60 个可变字段收敛为**显式 state 对象**（单一 owner，clone/adopt 改为整体深拷该对象而非逐字段枚举），使域 handler 成为「读 state 对象 + 返回 delta + 返回 state patch」的纯归约；再按域把 handler 移到姊妹模块，主文件只留 dispatch（`reduce()` switch）+ state 对象装配。这同时偿还 P1 的字段收敛债。
- 路径 B（次选）：保留 class，但把每域 handler 抽为接收 `(state, event)` 的独立函数，class 方法只做 `return domainFn(this.state, event)`。耦合仍在 state 对象，但物理上分文件。风险低于 A 的收益也低于 A。

每域拆出后：harness 绿 + tsc 绿 + 该域测试绿 + 主文件行数下降 + clone/adopt 仍单一真源。目标终态：主文件 <400（只剩 dispatch + 装配），每域模块 <400，移除 `max-lines` 头注豁免与 policy 例外。

## 5. 验收

- 批次 1：`pnpm --filter @acode/bootstrap typecheck` exit 0；11 个投影测试计数不降（基线 59 pass / 0 fail）且全绿；抽出每模块 <400 行；公开导入面（§3）零改动；无循环 import。
- 批次 2：harness 覆盖 14 域典型序列 + hydration + atomic 拒绝路径，逐字节断言 delta 流与 snapshot。
- 批次 3+：每域拆出后 harness 绿、主文件行数单调下降、clone/adopt 保持单一真源、行为零变化。
