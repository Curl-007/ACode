# failure-recovery-tracks：分层故障恢复轨道（溢出晋升前置 + 截断恢复）

> 来源与许可：机制参照 oh-my-pi（MIT, oh-my-pi contributors）
> `packages/coding-agent/src/session/session-maintenance.ts`（`checkCompaction` 四 case 分派、
> `#tryContextPromotion`/`#promoteContextModel`/`resolveContextPromotionTarget`、
> `INCOMPLETE_RECOVERY_MAX_RETRIES = 3` 截断恢复封顶）与 `docs/non-compaction-retry-policy.md`
> （「四轨道入口统一且互斥」纪律）。**只提炼机制，实现为自撰 TypeScript**：omp 的该面与其
> 会话树（JSONL entry/branch/leaf 指针）、model registry（KDL compat/fitContextWindow）、
> 凭据体系深度耦合，本 spec 按 ACode 的 runtime/compact/auto-resume 既有边界重写，未复制代码。

## 背景与问题

ACode 现状（本 spec 落库前）：

1. **token 溢出只有一条恢复动作**：`MODEL_CONTEXT_EXCEEDED` 在
   `runtime/methods/turn-model-step.ts` 的 `recoverModelStepAfterContextExceeded` 直接进入
   reactive compaction（`runtime/methods/compact.ts`），溢出错误本身只被
   `runtime/helpers/model-errors.ts` 标记归类。同 provider 明明存在更大窗口的模型时，
   历史被压缩（有损）而不是换窗口重试（无损）。
2. **截断（stopReason=length）恢复语义不完整**：`turn-output-token-continuation.ts` 对所有
   length 截断一律「续写 ≤3 次 → 耗尽报错」，不区分：
   - 窗口占用低 + 已有可见产出（输出上限截断了真实交付物——续写只会重复撞同一上限）；
   - 窗口占用低 + 无产出（推理烧光输出预算——应移除该轮、注入提示重试并封顶）；
   - 窗口本身耗尽（应交给压缩轨道而不是盲续写）。

omp 语义：溢出先试「模型晋升」（换更大窗口模型重试同一请求，不压缩），无晋升候选才走压缩；
截断有产出保留告警、无产出移除重试封顶 3 次后 fail-loud。本 spec 把这两条落进 ACode。

**波外登记（本批不做）**：模型 fallback 链（依赖 provider 账号体系）与投机压缩
（依赖会话树/分支快照）——见台账 T1#3 波 2 范围说明。

## 分层定位

`specs/turn-auto-resume.md` 已登记五层恢复；本 spec 不新增层，而是给第 3 层与
「溢出/reactive compaction」决策点补分类前置：

1. 请求内 adapter 重试（adapters，不动）。
2. turn 内流恢复（streaming-recovery，不动）。
3. turn 内截断续写（turn-output-token-continuation）——**本 spec 在其判定前插入截断恢复
   分类器**（保留其机制作为 discard-retry 的执行体）。
4. 空响应重试（model-errors suspicious-empty，不动）。
5. 跨回合 auto-resume（transient/permanent 二分，**不改分类器**；本 spec 只钉住互斥事实：
   `context_exceeded ∈ permanent`、输出上限耗尽错误 `retryable:false → permanent`，
   两条都不会被 auto-resume 接管）。

压缩侧既有轨道（不动，只声明互斥）：microcompact（本地无损清理）、threshold auto compact、
reactive compact、HTTP 413 媒体阶梯（compact/payload-recovery.ts）、rapid-refill 熔断。

## 轨道状态机（统一入口，互斥分派）

唯一分类入口 = model step 边界（`turn-model-step.ts`）：请求 throw / finishReason /
stopReason 三类事实先归一成**恰好一条**轨道，任何一轮只进一条，轨道间不 fallback 串线
（omp 四轨道纪律照抄）。

```text
                       model step 结束（throw 或 finish）
                                  │
          ┌───────────────────────┼───────────────────────────┐
          │ throw                 │ finish/stopReason          │ 成功(stop/tool-calls)
          ▼                       ▼                            ▼
  isModelRequestPayloadTooLarge?  isContextExceededFinish?     正常 turn 收口
   ├─ 是 →【413 字节轨道】         ├─ 是 →【溢出轨道】(同左)     （不计入任何恢复计数）
   │   媒体阶梯 12MiB→0→耗尽抛错   └─ 否 → isOutputTokenLimit?
   │   绝不转投 token 轨道             ├─ 是 →【截断恢复轨道】
   └─ 否 → isModelContextExceeded?     └─ 否 → 其余错误 → TurnError
       ├─ 是 →【溢出轨道】                 → auto-resume 分类(transient/permanent)
       └─ 否 → 其余错误 → TurnError

【溢出轨道】(MODEL_CONTEXT_EXCEEDED)
  ┌────────────────────────────────────────────────────────────┐
  │ 晋升前置: 可晋升?(未晋升过 ∧ 非钉住轮 ∧ catalog 有候选)      │
  │   ├─ 是 → 切换晋升模型 → 原样重试同一请求（不压缩）→ 结束    │
  │   └─ 否 ↓（fail-safe：候选缺席/已晋升/钉住轮 = 静默跳过）    │
  │ rapid-refill 熔断? ─ 是 → 抛 CompactRapidRefill 错误        │
  │   └─ 否 ↓                                                   │
  │ reactive compaction（既有，本 step 仅一次）                  │
  │   ├─ compacted → 重试                                       │
  │   └─ skipped/failed → 抛原溢出错误                          │
  │        → auto-resume 分类为 permanent，不接管（互斥事实）    │
  └────────────────────────────────────────────────────────────┘

【截断恢复轨道】(stopReason=length / max_tokens / max_output_tokens /
                 model_context_window_exceeded 的成功响应)
  classifyTruncationRecovery（compact/truncation-recovery.ts，纯函数）：
  ┌──────────────────────┬───────────────────────────────────────┐
  │ 窗口未耗尽 ∧ 有产出   │ keep_with_warning：保留截断产出，warn  │
  │                      │ 日志 + stopReason=length 持久化/事件， │
  │                      │ 本轮按正常 text-only 收口（不续写）     │
  ├──────────────────────┼───────────────────────────────────────┤
  │ 窗口未耗尽 ∧ 无产出   │ discard_and_retry：空 assistant 不落   │
  │ (计数 < 3)           │ 请求历史，注入续写提示重试（既有机制）  │
  ├──────────────────────┼───────────────────────────────────────┤
  │ 连续 length 恢复计数  │ fail_loud：抛输出上限耗尽错误          │
  │ ≥ 3                  │ (retryable:false → auto-resume         │
  │                      │  permanent，链不接管 = 响亮终止)        │
  ├──────────────────────┼───────────────────────────────────────┤
  │ 窗口耗尽(占用≥阈值 或 │ compact：沿用既有续写机制挂起本轮，    │
  │ prompt+output≥有效窗 │ 下一 loop 边界由 threshold auto        │
  │ 或 窗口未知)         │ compact 压缩后续写（交接，不自行压缩）  │
  └──────────────────────┴───────────────────────────────────────┘
```

## 轨道 1：溢出先模型晋升再压缩

### 决策点（两处，共用同一执行体）

| 决策点 | 位置 | 顺序 |
| --- | --- | --- |
| reactive 溢出 | `turn-model-step.ts` `recoverModelStepAfterContextExceeded` 顶部 | 晋升 → rapid-refill 熔断 → reactive compaction |
| threshold 阈值 | `compact.ts` `autoCompactIfNeeded`（`shouldAutoCompact` 判 above_threshold 后） | 晋升 → rapid-refill 熔断 → auto compaction；晋升成功返回新结局 `promoted`，本轮不压缩，下一 loop 迭代按晋升后窗口重算阈值 |

执行体唯一：`runtime/methods/context-promotion.ts` `tryPromoteContextModelForRecovery`
（单一写入路径；两个决策点不得各自实现晋升）。

### 晋升候选（纯策略，`compact/promotion.ts`）

候选来源 = 现有 model 配置面 `ModelCatalogPort.listModels()`（宿主注册表活视图，
bootstrap 已接线；core 不新增配置面）。规则（全部满足才可晋升）：

1. **同 provider**：`candidate.providerId === current.providerId`（跨 provider 晋升涉及
   账号/计费面，波外）；
2. 非当前模型（`modelId` 不同且非 catalog `current` 条目）；
3. 未禁用（`disabledReason` 缺席——未配密钥/被策略禁用的模型不是候选）；
4. 窗口可证更大：当前窗口与候选窗口都是有限正数，且 `candidate.contextWindow >
   current.contextWindow`。**当前窗口未知 ⇒ 无法证明更大 ⇒ 无候选**（fail-safe，
   直接走压缩）；
5. 确定性选取：候选中取**最小**的更大窗口（最小充分跳变，成本保守）；同窗口按
   `modelId` 字典序（同输入必同输出，可单测）。

找不到候选 = 跳过晋升直接压缩（fail-safe，绝不因晋升失败阻断既有压缩恢复）。

### 晋升执行语义

- **每轮至多 1 次**：`RegularTurnLoopState.contextPromotionAttempted`（turn-scoped，
  轮终即弃；auto-resume 注入的新 turn 是新 state，不继承）。晋升后的重试再次溢出 →
  标志已在 → 直接进压缩轨道。晋升不重置 rapid-refill 计数（晋升不是压缩，不产生
  boundary，`recordCompactSuccess` 不被调用）。
- **钉住轮不晋升**（选择被显式钉住/无人值守时不得改模型，直接压缩）：
  `modelSelectionScope === "execution"`、`subagentModelOverride` 在场、
  `automationId`/`offPeakTaskId` 在场（无人值守轮用户不在场，不能替用户换计费模型）。
- **会话级切换，走既有唯一写入路径**：`setSessionModelSelection` +
  `persistRuntimeModelSelection` + `emitModelSelected`（与用户手动切模型同一事件面；
  v4 reducer 依 ModelSelected 更新 config 投影并产出 modelChange marker）。晋升后
  `state.model` 同步换绑，并调用 `rebuildContextPrefix`（turn.ts 同款纪律：context
  前缀按 step 实际持有的 Model 重投影；晋升限同 provider，渲染面天然兼容）。
  reasoningLevel 仅在候选模型 `reasoningLevels` 支持时随迁，否则缺席走工厂默认。
- **不许静默换模型（告知语义）**：晋升事实必须同时落三处——
  1. `logger.warn`（event `compact.context_promotion.applied`，from/to/trigger/窗口对）；
  2. `ModelSelected` 事件（UI 模型指示器 + transcript modelChange marker，用户可见）；
  3. 重试请求的 `ModelRequest` 事件天然携带晋升后 providerId/modelId。
  晋升是自动恢复动作：会话模型被切到更大窗口并**持久**（用户可随时手动切回）；
  后续轮次直接用晋升后模型（不会每轮重演「溢出→晋升」）。
- **fail-safe**：catalog 缺席/空、候选缺席、`createTurnModel` 抛错（provider client
  失效）、晋升后窗口复核不大于当前窗口（目录不可信防御）——一律 warn 日志 + 返回
  undefined，调用方无缝落入既有压缩轨道。晋升执行体自身抛错不允许冒泡打断恢复链。

### 与 omp 的有意差异（登记）

- omp 晋升目标来自模型显式配置 `contextPromotionTarget` + `contextPromotion.enabled`
  开关（默认 **false**，opt-in）；ACode 无该配置面（新增 config 字段 = contracts 共享桶，
  见「共享桶申请」），本批为**默认开启** + 每轮 1 次 + 会话可见切换。溢出路径默认开启
  是任务要求；threshold 路径默认开启属于对 omp 的放大，靠「可见 + 每轮 1 次 + 最小跳变」
  约束，配置开关登记为后续。
- omp 晋升后按 revert policy 回切；ACode 不回切（无冷却/账号面），用户手动切回。
- 晋升不跑 Pre/PostModelSwitch hook（恢复动作不应被 hook 阻塞/延迟；治理需要时随
  配置开关一并登记后续）。

## 轨道 2：截断恢复（stopReason=length）

### 分类器（纯函数，`compact/truncation-recovery.ts`）

判定输入 = 结构化事实（无文本正则）：`hasDeliveredOutput`（本轮可见文本非空；tool call
轮不进本轨道——`classifyOutputTokenContinuation` 对 toolCallCount>0 返回 none，工具循环
照常）、`promptTokens`（provider usage 优先的输入占用，`estimateCurrentModelInputTokens`）、
`outputTokens`（本轮 usage）、`config`（与 `autoCompactIfNeeded` 同构的
`AutoCompactPolicyConfig`，阈值/有效窗口从 `compact/policy.ts` 单一来源计算）、
`consecutiveLengthRetries`（既有 `TurnRequestState.outputTokenContinuationCount`）。

```text
windowExhausted = 窗口未知(≤0/缺席)
               ∨ promptTokens ≥ getAutoCompactThreshold(config)
               ∨ promptTokens + outputTokens ≥ getEffectiveContextWindowSize(config)

!windowExhausted ∧ hasDeliveredOutput → keep_with_warning
windowExhausted                       → compact
!windowExhausted ∧ !hasDeliveredOutput ∧ retries+1 ≤ 3 → discard_and_retry
!windowExhausted ∧ !hasDeliveredOutput ∧ retries+1 > 3 → fail_loud
```

封顶常量 `TRUNCATION_NO_OUTPUT_MAX_RETRIES = 3`（omp `INCOMPLETE_RECOVERY_MAX_RETRIES`
同值同义：连续无产出恢复封顶；任何交付了产出的轮次都会重置计数——keep 分支收口与
非 length 正常步都走 `completeOutputTokenRecovery`）。

### 运行时映射（决策 → 既有机制，不新造执行体）

| 决策 | 执行 |
| --- | --- |
| keep_with_warning | **唯一新行为**：跳过续写注入，`logger.warn`（event `model.response.truncated_kept`），assistant 以 `finish=length` 正常持久化，`ModelComplete.stopReason=length` 照常发（UI 可见截断事实），走 `finishModelStepWithoutToolCalls` 正常收口（含 Stop hook/guide drain 既有语义），计数清零 |
| discard_and_retry | 既有续写机制原样：空 assistant 不入请求历史（`includeEmptyAssistant:false`）、追加 `OUTPUT_TOKEN_CONTINUE_PROMPT`、计数 +1 |
| compact | 既有续写机制挂起本轮；下一 loop 迭代 `autoCompactIfNeeded`（threshold）压缩后续写——截断轨道**不自行压缩**，压缩永远只有 compact.ts 一个执行体 |
| fail_loud | 既有耗尽路径：抛 `OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE` 错误（提取为 `createOutputTokenLimitExhaustedError`，单一构造点）。错误 `retryable:false`（`createCoreError` 默认）经 `projectExecutionErrorPayload` 投影出 `attribution.retryable=false` → auto-resume 分类 permanent → **链不接管**，turn 以 TurnError 响亮终止 |

### 互斥边界（与既有面的关系，逐条钉住）

- **与既有续写分类**：`classifyOutputTokenContinuation` 保持不变（触发面/3 次上限/
  exhausted 语义全保留）；截断分类器只在其结果为 `continue` 时**改道** keep 分支，
  是前置分流不是替代。`interrupted-output-continuation.test.mjs` 钉住的纯函数契约零改动。
- **与溢出轨道**：raw `model_context_window_exceeded` 的**成功响应**仍按既有注释语义
  归截断轨道（`isOutputTokenLimitFinishReason`）；只有 throw / 空内容 + 超窗 marker 才进
  溢出轨道（turn-model-step 既有 503 分支用原 continuation 判定守门，keep 改道不会把
  超窗 marker 轮误放行到溢出分支——两个判定读同一 `outputTokenContinuation` 原值）。
- **与 413 阶梯**：413 是字节轨道（`isModelRequestPayloadTooLargeError`），不进截断/
  溢出分类；截断轨道不消费 413 事实，阶梯耗尽照旧抛错（compact-invariants I5 不动）。
- **与 microcompact**：microcompact 是每轮先行的本地无损清理，与截断分类无共享状态；
  keep 收口不触发任何压缩动作。
- **与 auto-resume**：截断轨道全部四个结局都在 turn 内收口，不产生 transient 分类输入；
  fail_loud 的 permanent 投影是两轨道的唯一交界，测试钉住。
- **与晋升轨道**：ACode 的 maxOutputTokens 由执行链显式收敛（`resolveNormalRequestMaxOutputTokens`），
  换更大窗口模型不放大输出预算——**截断轨道不咨询晋升**（与 omp 有意差异，omp 的
  incomplete→promotion 依赖其 per-model 输出上限差异，ACode 无此事实面）。

## 状态所有权与幂等边界

| 状态 | 唯一所有者 | 生命周期 | 重置条件 |
| --- | --- | --- | --- |
| `contextPromotionAttempted` | `RegularTurnLoopState`（turn-loop-state.ts） | turn | 轮终即弃（state 不跨轮） |
| 会话模型选择 | runtime model selection port（`setSessionModelSelection` 唯一写点） | 会话 | 用户/晋升切换（晋升持久生效） |
| `outputTokenContinuationCount` | `TurnRequestState` | turn（query-local） | `completeOutputTokenRecovery`：正常步/keep 收口/工具批次 |
| `autoCompactConsecutiveFailures`、rapid-refill 计数 | runtime / `CompactLoopTracking` | 既有 | 既有（不动） |

幂等边界：晋升执行体以 `contextPromotionAttempted` 先占后做（同轮并发重入 = 第二次
直接 undefined）；晋升失败路径不置位标志（fail-safe 落压缩后，同轮后续溢出仍按
「已压缩」既有守卫收敛，不会无限重试）。keep_with_warning 无状态（纯分类 + 既有收口）。

## 验收场景（测试落 `apps/acode-cli/tests/failure-recovery-tracks*.test.mjs`）

1. 晋升候选解析：更大窗口命中/更小·跨 provider·disabled·窗口未知全部缺席/最小跳变与
   字典序确定性/钉住轮资格判定。
2. 晋升执行体（桩 runtime 注入）：候选在场 → 换绑 state.model + ModelSelected 发出 +
   selection 持久化调用 + warn 日志；**第二次调用返回 undefined（只试一次）**；
   catalog 缺席/工厂抛错 → undefined 且状态零改动（fail-safe）。
3. 截断分类器：四分支 + 窗口未知归 compact + 计数封顶边界（2→retry，3→fail_loud）。
4. fail-loud 互斥：耗尽错误经 `projectExecutionErrorPayload` → `classifyAutoResumeFailure`
   = permanent；溢出 CoreErrorType = permanent（既有事实，回归钉住）。
5. 接线守卫（源码断言，compact-invariants 同款）：溢出恢复函数在 compaction 之前调用
   晋升执行体；`autoCompactIfNeeded` 在 compaction 之前调用晋升执行体；turn-model-step
   在续写判定后消费截断分类器。
6. 存量零回归：`compact-invariants` / `auto-resume-*` / `interrupted-output-continuation`
   全绿。

## 共享桶申请 / 后续登记（本批不改）

- contracts `RuntimeConfig` 增 `contextPromotion` 配置面（enabled/revert），对齐 omp
  opt-in 语义——需要动 `packages/contracts` + `packages/shared`（DefaultRuntimeConfig），
  登记为共享桶申请，由编排器裁决。
- `ModelAnomalyWarningCategory` 增 `context_promotion` / `output_truncated` 类目，把
  告知从「日志 + ModelSelected/stopReason」升级为 UI 显式提示——contracts 共享桶。
