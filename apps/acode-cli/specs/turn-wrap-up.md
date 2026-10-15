# 回合收尾协议（turn wrap-up）

状态：已实现（波次 2 / T1-2）。本 spec 是回合收尾载荷、义务语义与投影/UI 承载的唯一事实源。

## 1. 背景与动机

ACode 的回合以模型自由文本结束：UI 没有结构化"下一步"槽位，用户要靠读消息而不是看卡片
跟进度；回合也没有"是否留下自成一体的后续任务"的显式判别。外部范式把「回合怎么结束」
做成**协议义务**：凡改了文件/跑了命令/维护了任务列表的回合，收尾消息之前必须产出一份
结构化收尾载荷（回顾 + 下一步 + 可选的建议任务卡），「没有这个调用，app 没东西可画」。

本 spec 把该机制 ACode 化：新工具 `TurnWrapUp` + v4 toolCall row 的入参通道承载 +
桌面/Web 轮尾收尾卡 + TUI 一行呈现。**不引入任何厂商工具名或代号**；命名一律 ACode 词汇。

## 2. 裁决摘要

### 2.1 产生方式：模型显式调用收尾工具（否决 runtime 推导）

- recap（两三句回顾）与 nextStep（下一步）是**意图性内容**，只有模型知道"这轮做成了什么、
  接下来该做什么"；runtime 从既有信号（文件变更摘要、todo 状态）只能推导出事实清单，
  推导不出叙述与判断，更给不出 followUpSuggestion 的 prompt。
- 对齐外部范式的「协议义务」形态：义务写进工具描述（模型面文本，恒英文，
  `specs/prompt-language-policy.md` R3 双面文本纪律），收尾载荷经协议事件承载。
- 侵入面评估（实测）：
  - 系统提示词零改动（本波不触碰 context/prompt 面）；义务文本全部在工具描述内。
  - 回合流程零控制流改动：runtime 只做**事实记录 + 收口评估 + 日志**（R3），
    不阻塞、不续跑、不注入。
  - provider 可见的强制 nudge（text-only 边界注入一次 reminder 并 continue）被**登记为
    后续批次**（§9.1）：它需要给 system-reminder 闭集（`core/src/system-reminder/source.ts`，
    本波文件所有权之外）新增一个 per-request source，并且每次触发多一个 model roundtrip。
    先以日志观测义务违反率（`turn.wrapup.missing`），有证据再决定是否上硬门。

### 2.2 协议承载：toolCall row 的 input 通道（否决新 row kind 与 display 通道）

三条候选通道的实证裁决：

| 通道 | 旧客户端行为 | 裁决 |
| --- | --- | --- |
| 新 row kind | 帧级 zod 校验失败 → `proto.frameAssemblyInvalidPayload` 是**确定性内容故障**，resync 重投必然再拒 → 订阅终态 `fault.subscription.contentRejected`（`wire-fault.ts`）。不存在逐行丢弃机制。 | 否决：不满足"旧客户端安全忽略" |
| toolCall display 载荷 | `display: …optional().catch(undefined)` 安全剥离 ✓，但生产点 dispatch 在 `core/src/tool/executor/result-display.ts`（本波所有权外），且两侧 strict union 成员表必须同步（`toolDisplay.ts` ↔ `tool-result-metadata.ts`） | 登记为可选后续（§9.4），本波不用 |
| toolCall row `input` | `input: z.unknown()` 对所有客户端版本**无 schema 透传**；`tool-result-metadata.ts` 冻结注释确立了先例："gate 专属的事实一律走工具入参通道（那一侧对所有版本都无 schema）" | **采用** |

结论：收尾载荷 = `TurnWrapUp` 工具入参，随既有 toolCall row 的 `input` 字段过线
（live 与 hydration 两条路径都已投影 `payload.input`，实测 `onToolCallScheduled` /
`onToolCallUpdated` / persisted part state.input）。**product-projection 零改动**——
这不是遗漏，是 input 通道的既有事实；本 spec 以验收场景 5 钉住该不变量。

### 2.3 schema 双份镜像（zod 版本边界）

contracts 用 zod v3、shared/UI 用 zod v4，运行时 schema 对象不能跨版本复用
（`tool-result-metadata.ts` 头注同款约束）。因此：

- **单一事实源（名字与上限）**：`packages/shared/src/acode-protocol-v4/turn-wrap-up.ts`
  定义 `TURN_WRAP_UP_TOOL_NAME`、`TURN_WRAP_UP_LIMITS`、`turnWrapUpPayloadSchema`（zod v4
  strict，客户端解析面）。contracts 直接 import 名字与上限常量（contracts→shared 依赖既有）。
- **producer 镜像**：`contracts/src/tools/turn-wrap-up.ts` 用 zod v3 镜像同一字段集
  （`TurnWrapUpInputSchema`，strict），供 handler 校验与 provider JSON schema 生成。
- 两份 schema 的一致性由 parity 测试钉住（验收场景 8）：同一组 fixtures 必须同接受/同拒绝。
  这是 toolDisplay ↔ tool-result-metadata 既有同步纪律的同款。

## 3. 产品规则

- **R1 收尾载荷形状（闭集，strict）**
  `{ recap, nextStep, followUpSuggestion? }`：
  - `recap`：两三句回顾，1..600 字符；
  - `nextStep`：下一步一句话，1..300 字符；
  - `followUpSuggestion`（可选）：`{ title 1..120, tldr 1..280, prompt 1..4000 }`。
    建议任务卡语义 = new_task 判别载体（R8）：只有当后续**自成一体、新任务仅凭 prompt
    就能出发（可能没有本会话上下文）**时才给出；prompt 必须自包含。
  - 上限常量 `TURN_WRAP_UP_LIMITS` 住在 shared v4，contracts 镜像引用同一份数字。
- **R2 义务语义（触发条件，闭集）**
  回合内出现下列任一信号即"必须调用"（在收尾消息之前）：
  1. 任一已执行工具按 registry 元数据满足 `isWorkspaceMutatingToolCall`（写文件/git/
     不可证明只读的 shell——Bash、Write、Edit、ApplyPatch 全部落网；范围缺席按会改写处理，
     保守判义务成立）；
  2. `TodoWrite`（维护任务列表；sideEffectScope=session 不在 1 里，单列）。
  纯只读回合（Read/Grep/Glob/问答）与零工具回合**不**触发义务。
  义务只适用于：主对话 runtime（taskType ∉ {subagent_child, workflow_child,
  nested_workflow_child, selection_side_chat}——child 的收尾是它们自己的 report/submit
  契约，side chat 是只读轻量通道无轮尾卡读者）且非无人值守轮（无 automationId /
  offPeakTaskId）且回合成功收口（cancelled/failed 轮豁免——用户已经打断，收尾卡没有读者）。
- **R3 runtime 事实记录与收口评估（观测先行，不阻塞）**
  - 状态所有者：`RegularTurnLoopState.turnWrapUp`（每回合新建，随 loop state 释放；
    不持久化、不跨回合）。形状 `{ workSignalCount, recordedAtWorkSignalCount | null }`。
  - 写入点唯一：`turn-tools.ts` 的工具结果循环（成功失败都记 work 信号——失败的写尝试
    也是工作上下文；`TurnWrapUp` 成功结果记 recorded）。
  - 评估点唯一：`turn.ts` 成功收口路径（TurnComplete 之后），产出三种事实之一并落 info 日志：
    `recorded`（义务满足）/ `missing`（有信号、从未成功调用）/ `stale`（调用后又出现新的
    work 信号——载荷可能过时）。评估是纯函数（`evaluateTurnWrapUpObligation`），日志不落
    recap/nextStep 原文（用户数据不入日志），`status` 键只用保留闭集值。
  - **不做**：不阻塞收口、不注入 reminder、不发新 SessionEvent（事件面闭集在本波所有权外，
    且投影不需要——载荷已经在 toolCall row 上）。
- **R4 工具行为**
  - `TurnWrapUp` handler 无外部副作用：校验入参 → 返回 `{ status: "recorded", message }`；
    message 是模型面指令（收口：现在给最终回复，不要复述 recap/nextStep）。
  - sideEffectScope=session（协议档，`isWorldTouchingToolCall=false`——它不碰外部世界），
    readOnly、low risk、needsApproval=false、concurrentSafe=true。
  - 每回合至多一次有效收尾：多次调用不报错，**最后一次成功调用生效**（UI 卡片 last-wins，
    R6）；工具描述指令模型只调一次、作为收尾消息前的最后一个工具调用。
  - 注册：`builtInTools` 无条件注册（无端口门）。child 会话可见但义务不适用（R2）；
    child 排除名单登记为可选接线（§9.3）。
- **R5 v4 协议面（additive）**
  - shared v4 新文件 `turn-wrap-up.ts`：工具名常量、上限常量、`turnWrapUpPayloadSchema`
    （zod v4 strict）、`parseTurnWrapUpPayload`（safeParse 包装，失败回 undefined）。
    经 `acode-protocol-v4/index.ts` 公开入口导出。
  - **不加** row kind、**不加** delta op、**不加** snapshot 状态键、**不改** rows.ts /
    toolDisplay.ts（两者都已超行数 ratchet，只减不增）。
  - 旧客户端安全忽略的证明结构：载荷只住在 `input: z.unknown()` 里，旧 schema 逐字节可解析；
    验收场景 5 以"conversationRowSchema 无 wrap-up kind"负向断言钉住，防止未来有人改成
    新 row kind 破坏该保证。
- **R6 UI 轮尾收尾卡（桌面 + 手机 Web）**
  - 与 cron/off-peak 轮尾卡同一道缝：`ConversationTurnGroup` 在 `unit.isRunning === false`
    后由纯 resolver（`resolveTurnWrapUpCard(unit.assistantWorkRows)`）解析**最后一条**
    `toolName === "TurnWrapUp"` 且 `status === "success"` 且 payload 解析成功的 toolCall row。
  - 卡片结构：recap（次要文本）+「下一步」强调框 + 建议任务卡（在场时）：title + tldr，
    可展开完整 prompt；动作面 = **发起为新任务**（R7）与**复制 prompt**。
  - 降级：payload 缺失/解析失败 → 不渲染卡片；该 toolCall row 仍按普通工具行渲染
    （ToolCallBlock 通用路径），新旧客户端都有兜底。
  - `TurnWrapUp` 工具行本身保持普通工具行呈现（cron 卡先例："工具本身仍按普通工具行展示；
    成功卡片属于整轮完成后的结果摘要"）；不改 ConversationRowView 分发。
  - 文案 i18n：组件经 `intl.formatMessage` 取 `chat.turnWrapUp.*` 键；locale 文件在本波
    文件所有权外，键清单交协调者统一接线（§9.2），接线前组件内置英文回落词典
    （**过渡措施**，接线落地后移除——移除条件写死在 UI spec）。
- **R7 发起为新任务（动作面，单一写入路径）**
  完全复用 root「新建任务」的同一组 store 动作，不新建第二份状态：
  1. `tabStore.activateTabByPath(workspacePath, {workspaceIdentity})`，失败则 `addTab`；
  2. 只读工作区校验（`isWorkspaceReadOnly`）→ 拒绝并静默返回（root 同款边界再校验）；
  3. `useWorkbenchGroupStore.deactivateActiveGroup()` + `usePaneLayoutStore.resetToPrimaryPane()`；
  4. `useACodeSessionStore.startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" })`；
  5. `persistV4ComposerDraft(..., V4_DRAFT_SCOPE_ROOT, { text: prompt })` 先写草稿事实源，再
     `requestComposerTextInsert(workspacePath, prompt, workspaceIdentity)`（root 的同款双写
     顺序：remount 后新 composer 从草稿恢复同一文本）。
  工作区身份取自 row 渲染上下文（`ConversationRowRenderContext.workspacePath/workspaceIdentity`），
  即建议卡所在会话的工作区——新任务落在同一 workspace。
- **R8 任务范围判别（new_task / continuation）**
  本波载体 = `followUpSuggestion`：给出建议卡 ⇔ 模型判断存在"真正属于独立任务的后续"
  （下一步、未验证部分、可在用户 review 时并行的部分、早前搁置的事）；不给 ⇔ 后续默认
  continuation（用户下一条消息路由回本会话，无需显式声明）。
  显式 per-request scope 声明（任务列表工具首条消息带 `new_task | continuation | first_task`）
  需要 TodoWrite 持久化面 + plan 投影 + UI plan 面三处扩展，跨本波文件所有权，**登记分批**（§9.5）。
- **R9 TUI 最小呈现**
  `buildToolTranscriptProjection` 增加 `turnwrapup` 分支：detail 一行 `next: <nextStep>`
  （按终端宽度截断）。不做富渲染、不做卡片、不新增 i18n 面（TUI 工具行既有英文惯例）。

## 4. 状态所有者

| 状态 | 所有者 | 生命周期 | 读者 |
| --- | --- | --- | --- |
| 收尾载荷（canonical） | 会话事件日志 + tool part（`state.input`，既有持久化） | 随会话 | product-projection（live+hydration）、UI resolver、TUI |
| 义务事实 `{workSignalCount, recordedAtWorkSignalCount}` | `RegularTurnLoopState.turnWrapUp` | 单回合，收口即释放 | turn.ts 评估 → 日志 |
| v4 toolCall row `input` | ProductProjection（既有） | 投影生命周期 | 客户端 store |
| 卡片解析结果 | UI 纯函数（无状态，useMemo 派生） | 渲染期 | ConversationTurnGroup |
| 新任务草稿 | acodeSessionStore / composerDraftStore（既有） | 既有 | 既有 |

无新增持久化面、无新增事件类型、无第二份收尾载荷副本。

## 5. 事件顺序

```text
turn_started
  → model step …工具批（每个结果：work 信号记录 / TurnWrapUp 成功：recorded 记录）
  → tool_call_scheduled(TurnWrapUp, input=载荷)   ── 投影 → toolCall row（input 随行）
  → tool_call_result(TurnWrapUp, success)          ── 投影 → row success（input 保留）
  → 最终 assistant 文本（text-only step）
  → Stop hook 边界（既有，不改）
  → turn_complete
  → turn.ts 成功路径：evaluateTurnWrapUpObligation → info 日志（recorded/missing/stale）
UI：turn isRunning=false → resolveTurnWrapUpCard → 轮尾卡（最后成功调用生效）
TUI：tool_call_scheduled/result → 工具行 detail 一行 next step
```

崩溃/恢复：载荷在事件日志与 part 里，hydration 重放走同一投影路径，卡片冷恢复后仍在。
取消轮：turn_complete(cancelled)/turn_error 不评估义务；已持久化的 TurnWrapUp row 照常投影
（用户打断前模型已收尾的部分事实保留）。

## 6. 失败语义

- 入参校验失败（超长/多余键/空串）：executor 的 runtimeInputSchema 校验 + handler 再 parse，
  双保险；错误 = 普通工具错误（error tool_result 回模型，可修复重试），零副作用。
- 载荷超上限：schema 拒绝（不是截断）——收尾卡是给用户看的承诺，静默截断会伪造事实；
  模型面错误文本提示上限。
- UI/TUI 解析失败：安全回落（通用工具行 / 无 detail），绝不抛。
- 义务违反：只日志（R3），永不失败回合。

## 7. 验收场景

1. **schema 校验**：合法载荷 → `{status:"recorded"}`；recap 601 字符 / 多余键 /
   nextStep 空串 → 拒绝（contracts 与 shared 两侧同判）。
2. **义务触发条件**：`{Edit}`、`{Bash}`、`{TodoWrite}` 各自 → required；`{Read,Grep}`、
   零工具 → not required；信号后成功调用 → recorded；调用后再 `Write` → stale；
   只调用无信号 → not required（recorded 事实存在但无义务）。
3. **评估范围**：subagent_child / automation / offPeak / cancelled 轮不评估。
4. **投影**：turn_started → tool_call_scheduled(TurnWrapUp) → tool_call_result(success)
   喂给真 ProductProjection：产出 toolCall row 且 `row.input` 逐字节等于载荷；
   全部 delta 过 `conversationDeltaSchema`。
5. **旧客户端安全忽略**：上述 row/delta 用**不含任何 wrap-up 知识**的既有 schema 解析成功；
   负向断言 `conversationRowSchema` 的 kind 闭集不含 wrap-up 成员（防止未来改走新 row kind）。
6. **UI resolver**：两次成功调用 → 取最后一条；error/cancelled 行忽略；坏 input → undefined；
   非 TurnWrapUp 行忽略。
7. **TUI**：`buildToolTranscriptProjection("TurnWrapUp", input)` → 单行 `next:` detail。
8. **schema parity**：fixtures 矩阵（合法/超长/缺键/多键/嵌套多键）在 contracts zod v3 与
   shared zod v4 两份 schema 上接受/拒绝结论一致。

## 8. 测试

- `apps/acode-cli/tests/turn-wrapup-contract.test.mjs`（场景 1/2/3/8）
- `apps/acode-cli/tests/turn-wrapup-projection.test.mjs`（场景 4/5）
- `apps/acode-cli/tests/turn-wrapup-tui.test.mjs`（场景 7）
- `packages/ui/test/turnWrapUpCards.test.ts`（场景 6；包内无 DOM 测试先例，纯逻辑守护）
- UI spec：`packages/ui/specs/turn-wrap-up-card.md`

## 9. 后续批次登记（本波刻意不做）

1. **provider 可见 nudge（硬门）**：text-only 边界（`turn-stop.ts`）评估 missing → 注入
   per-request reminder 并 continue 一次（每回合至多一次）。前置：`SYSTEM_REMINDER_PER_REQUEST_SOURCES`
   新增 `turn_wrapup` source + descriptor（`core/src/system-reminder/source.ts`，闭集，
   本波所有权外）。决策输入 = `turn.wrapup.missing` 日志的违反率。
2. **locale 键接线**：`chat.turnWrapUp.*` 键清单（en-US / zh-CN），见 UI spec；接线后移除
   组件内置英文回落词典。
3. **child 会话排除**（可选）：`WORKFLOW_CHILD_DISALLOWED_TOOLS` / subagent 名单加
   `TurnWrapUp`（`core/src/runtime/helpers/tool-allowlist.ts`，本波所有权外）。
4. **display 通道升级**（可选）：`result-display.ts` dispatch + 两侧 display union 加
   `turn_wrapup` kind，把载荷升级为带版本的一等展示载荷（input 通道保持兼容）。
5. **显式 scope 声明**：TodoWrite 首条消息带 `scope: first_task | new_task | continuation`
   （contracts todo 面 + 持久化 + plan 投影 + UI plan 面；R8 的分批登记）。
