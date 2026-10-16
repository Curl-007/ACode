# Spec：Hook 事件面全集扩展（hook event surface）

来源：价值提取 T1-6「hook 事件面全集」（只搬机制：事件分类学 + 失败语义；不引入任何厂商内部
代号）。目标：把 hooks 从「工具拦截面」升级为「运行时事件面」，在不破坏既有 7 事件与
workspace 信任门（`workspace-hook-trust`，bundleDigest）的前提下补齐生命周期事件。

## 事实源与所有权

- **事件枚举与 payload 契约（唯一事实源）**：`packages/contracts/src/hooks/` 三个文件——
  `hook-event-names.ts`（HookEventName/HookOutcome/HookSourceKind/HookPermissionDecision 词汇叶子）、
  `hook-event-io.ts`（各 `*HookInput` payload + `HookSpecificOutputSchema`）、
  `index.ts`（HookJSONOutput、配置/信任/生命周期 payload + `HooksRuntimeConfigPatchSchema`，
  并 `export *` 两个叶子）。对外公开 API 不变（contracts 根经 `hooks/index.ts` 再导出）。
- **Runner（执行与失败语义）**：`packages/core/src/hooks/runner.ts`（InMemoryHookRunner）、
  `configured-runner*.ts`（配置/插件 hook 进程执行）、`output.ts`（JSON 输出 → HookRunResult）。
- **触发点**：见下表「触发点」列；每个事件只允许一个触发漏斗（单一写入路径）。
- **守护测试**：`apps/acode-cli/tests/hook-events-contract.test.mjs`、
  `hook-events-lifecycle.test.mjs`、`hook-events-failure-semantics.test.mjs`。

## 事件全集（本波后）

### 存量事件（本波之前已存在，行为不变）

| 事件 | 触发点 | 可控性 | matchValue |
| --- | --- | --- | --- |
| SessionStart | `runtime/methods/hooks.ts runSessionStartHooks`（turn.ts startup / resume.ts / clear / compact 后） | 通知 + additionalContext 注入 | source（startup/resume/clear/compact） |
| UserPromptSubmit | `runtime/methods/hooks.ts runUserPromptSubmitHooks` | **阻断**（preventContinuation） | — |
| PreToolUse | `tool/executor/hook-flow.ts runPreToolUseHooks` | **阻断**（permissionDecision/updatedInput） | toolName |
| PermissionRequest | `tool/executor/hook-flow.ts runPermissionRequestHooks` | **阻断**（decision allow/deny/modify） | toolName |
| PostToolUse | `tool/executor/hook-flow.ts runPostToolUseHooks` | 通知 + additionalContext 进 modelContent | toolName |
| PostToolUseFailure | `tool/executor/hook-flow.ts runPostToolUseFailureHooks`（call-runner catch） | 通知 + additionalContext 进 modelContent | toolName |
| Stop | `runtime/methods/hooks.ts runStopHooks`（turn-stop.ts） | 特殊：`continue:true`+context = 续跑（最多 3 次） | — |

### 本波新增事件

| 事件 | 触发点（唯一漏斗） | 可控性 | matchValue |
| --- | --- | --- | --- |
| PostToolBatch | `runtime/methods/tools.ts executeTools` 消费 `batch_complete`（与 `ToolBatchComplete` 会话事件同点位；每个并行组结算后一次） | 通知（结果不回注模型上下文；block 输出只记日志） | — |
| PreCompact | `runtime/methods/compact-active.ts compactActiveConversationImpl`：`hasEnoughRuntimeEntriesToCompact` 通过之后、`CompactStarted` timeline 之前 | **阻断**：block/preventContinuation ⇒ 放弃压缩，落 `Skipped` timeline（reason `blocked_by_hook`），返回 `outcome:"skipped"` | trigger（manual/auto/partial/reactive/session_memory） |
| PostCompact | `runtime/methods/compact-active.ts compactActiveConversation` 包装层：impl 成功且 `outcome==="compacted"` 后一次 | 通知（hook 失败绝不影响已完成的压缩） | trigger |
| PreModelSwitch | `runtime/methods/turn-model.ts applySubmissionExecutionState`：检测到 session model selection 真实变化后、任何 mutation 之前 | **阻断**：block ⇒ 保持 previous selection，不落库、不发 `emitModelSelected`，本 turn 用 previous selection 重建 Model | nextModel（`providerId/modelId`） |
| PostModelSwitch | 同上漏斗：selection 已 set+persist、`emitModelSelected` 已发出之后 | 通知 | nextModel |
| StopFailure | `runtime/methods/turn.ts` 两个 turn 失败 catch（model 创建失败 + 执行失败），`appendTurnOutcomeEvent` 之后、`throw` 之前 | 通知（await 但内含 try/catch，hook 故障绝不掩盖原始 turn error） | failed / cancelled |
| TaskCreated | `tool/executor/background-tasks.ts emitBackgroundTaskEvent`：`BackgroundTaskStarted` 同点位 | 通知，**异步旁路**（fire-and-forget + warn；trackBackgroundTask 在工具结算路径上被 await，不允许 hook 拖慢工具结果） | toolName |
| TaskCompleted | 同上漏斗：`BackgroundTaskCompleted` 同点位（含 lost 分支） | 通知，**异步旁路**（同上） | toolName |
| CwdChanged | `runtime/methods/config.ts setWorkingDirectory`：cwd 真实变化后 | 通知，**异步旁路**（setWorkingDirectory 是同步接口且 bash 已 cd，事实不可回滚；hook 失败只 warn） | — |
| SessionEnd | **本波只落契约与配置面，不接触发点**（见「后续批次」F1） | 通知 | reason |

新事件 payload 全部继承 `BaseHookInput`（cwd/sessionId/traceId/turnId/mode/timestamp/agentName）。
自由文本 reason/status/type 字段一律 `string` + `TODO(闭集)` 注释，指向 WSB 波次的闭集错误词表
收敛工作（`core/src/errors`、`contracts/src/errors` 归 WSB，本波不 import 任何未落地枚举）。

## 失败语义（统一裁决）

对照提取文档 T1-6 失败语义（hook 起不来 / 超时 / 非 0 或 2 退出码 / JSON 校验失败 ⇒
`continue` 类默认放行、`block` 类等同退出码 2）。ACode 既有 runner 已实现同构语义，本波
**不改既有行为**，统一裁决如下并适用于全部新旧事件：

| 故障 | Runner 行为 | 对「阻断类」事件的效果 | 对「通知类」事件的效果 |
| --- | --- | --- | --- |
| hook 进程起不来 / 超时 / 非 0 且非 2 退出码 | callback 抛错 → `HookRunFailed` 生命周期事件 + warn 日志，继续下一个 hook | **放行**（fail-open：不 deny、不 preventContinuation） | 放行 |
| stdout JSON schema 校验失败 | 同上（`parseHookStdout` 抛错进同一 catch） | 放行 | 放行 |
| stdout 非 JSON | 视为诊断文本，忽略 | 放行 | 放行 |
| 退出码 2 | `createExitCodeBlockOutput` → `continue:false`（Stop 为 `decision:"block"`） | **等同拒绝**：PreToolUse/PermissionRequest ⇒ deny；UserPromptSubmit/PreCompact/PreModelSwitch ⇒ preventContinuation（触发点必须拒绝该动作）；Stop ⇒ 续跑 | `blockRequested=true` 但触发点按通知类忽略（PostToolBatch 记日志） |
| hook 未通过 admission / workspace trust（不可用） | 不注册或被 `HookRunBlocked` 剔除，不执行 | 放行（信任门 fail-closed 只作用于「hook 本身不许跑」，不阻断业务动作） | 放行 |

要点：
- **fail-open 是 ACode 的既定裁决**（hook 故障不得把可用运行时拖成不可用）；「block 等同
  拒绝」只发生在 hook **显式**表达拒绝（退出码 2 / `continue:false` / `decision:"block"` /
  permissionDecision deny）时。
- `shouldPreventContinuation`（`core/src/hooks/output.ts`）本波扩为：PreToolUse、
  PermissionRequest、UserPromptSubmit、**PreCompact**、**PreModelSwitch**。
- 通知类事件的 hook 运行要么被触发点 try/catch 包住（PostCompact/StopFailure），要么
  fire-and-forget + catch warn（TaskCreated/TaskCompleted/CwdChanged），任何 hook 故障都
  不允许改变业务路径的成败。

## 决定与边界

- **D1 workspace 信任 bundle 面保持 7 事件**：`WORKSPACE_HOOK_SCHEMA_FIELDS.events` 与
  `workspaceHookEventNameSchema`（contracts/hooks/workspace-hook-trust.ts）不加新事件。
  该字段表参与 bundleDigest 计算，改动会使全部已信任 workspace hooks 失效（stale_digest →
  重新审查），属于信任面破坏性变更；且其上游 discovery 枚举在根 `packages/shared`
  （本波范围外）。新事件本波经 **插件 hooks.json**（adapters `SUPPORTED_HOOK_EVENTS` 由
  `HookEventName` 派生，自动放行）与 **HooksRuntimeConfigPatch**（程序化配置面）可达。
- **D2 用户配置文件面（acode.json `hooks` 字段）**：经根 `packages/shared/src/workspace-hook-config.ts`
  的 `workspaceHooksConfigSchema`（strict，7 事件）校验——新事件写入用户配置文件会被拒。
  属范围外依赖，登记为后续批次 F2。
- **D3 SessionEnd 契约先行**：事件、payload、配置键、schema 全部落地并有契约测试；触发点
  缺席（见 F1），**不写死代码**。
- **D4 不做事件**：本波不实现 Claude 枚举里的 Notification / UserPromptExpansion / Setup /
  TeammateIdle / Elicitation / ElicitationResult / ConfigChange / FileChanged /
  DirectoryAdded / MessageDisplay——ACode 当前无对应事实产生点或属其他波次目录，避免为
  凑全集造合成触发点。
- **D5 contracts hooks 模块拆分**：事件扩到 17 个后 `hooks/index.ts` 超 oxlint
  max-lines(400) 门禁，按词汇叶子拆为 `hook-event-names.ts` + `hook-event-io.ts` +
  `index.ts`（再导出，公开 API 与模块内既有消费者 `../hooks/index.js` 均不变）。
- **D6 新触发函数的形态**：runtime 侧新触发函数（runPostToolBatchHooks 等）用「runtime
  显式首参」的普通函数形态而非 `this:` 原型方法——`this:` 形态要求在
  `runtime/internal-hook-methods.ts`（本波所有权外）声明接口；普通函数与
  `applySubmissionExecutionState` 既有模式一致。

## 后续批次登记（本波明确不做）

| # | 事件 | 依赖 | 说明 |
| --- | --- | --- | --- |
| F1 | SessionEnd 触发点接线 | shutdown 链路所有权（bootstrap `session-facade.close` / `agent-runtime.beginShutdown`，均在本波文件所有权外） | 契约已就绪；接线时应 await（含超时）且失败只 warn，reason 建议闭集（clear/logout/exit/dispose…） |
| F2 | 用户配置文件可写新事件 | 根 `packages/shared/src/workspace-hook-config.ts` + `workspace-hook-discovery`（含 digest 字段表演进策略） | 需与 D1 的信任 digest 版本化一起设计，避免一次性 invalidate 全部已信任 bundle |
| F3 | PermissionDenied | WSA 的 permission 面（`core/src/permission` 本波禁触） | PermissionRequest 已存在；Denied 应挂在 permission broker 拒绝结算点 |
| F4 | WorktreeCreate / WorktreeRemove | 波次 2 worktree 生命周期 | — |
| F5 | SubagentStart / SubagentStop | WSB（`core/src/subagent` 本波归 WSB） | TaskCreated/TaskCompleted 已覆盖后台 subagent 任务的 started/completed 事实，Subagent* 应聚焦 subagent 会话自身生命周期，接线时避免与 Task* 双写同一事实 |
| F6 | InstructionsLoaded | WSB（`core/src/context` 本波归 WSB） | — |
| F7 | PostToolUseFailure `error.type` 闭集收敛 | WSB 闭集错误词表（`contracts/src/errors`） | 现为 `string`（CoreErrorType 或 Error.name），词表落地后收窄 |
| F8 | **v4 投影面扩宽（阻塞 @acode/bootstrap typecheck）** | 根 `packages/shared/src/acode-protocol-v4/rows.ts:327-335`（hookInvocationRowSchema.hookEventName 的 z.enum 仍是 7 事件）+ `packages/bootstrap/src/acode-protocol-v4/product-projection.ts`（`hookInvocationLane`，~1740-1748） | 本波把 `HookEventName` 扩到 17 后，bootstrap 把 `HookRunLifecyclePayload.hookEventName` 赋给 v4 row 的 7 成员联合即编译失败（product-projection.ts:1579，实测 1 处 error）。修法：v4 rows enum 增补 10 个新事件名（协议改动，注意旧客户端 row 校验兼容，需与 WSD/桌面渲染协调）+ lane 映射建议：PostToolBatch→toolAfter，其余新事件→assistantWork。两处文件均在本波所有权外，未动 |
| F9 | 桌面侧 hook 事件枚举同步 | 根 `packages/shared/src/hooks.ts:10`、`workspace-hook-trust-store-file.ts:29`、`acode-protocol-v4/workspace-hook-review.ts:120`、`packages/services/src/hooks/hooksService.ts:42`（WSD/desktop 面） | 桌面若要允许配置/审查新事件，需同步这些清单；本波 desktop 侧只读 |

## 验收场景

1. 契约：`HookEventName` 含全部新事件；`HookSpecificOutputSchema` 接受每个新事件的
   `{hookEventName, additionalContext}`；`HooksRuntimeConfigPatchSchema.events` 接受新事件键、
   拒绝未知键（strict）。
2. PreCompact 阻断：hook 返回 `continue:false`（或退出码 2）⇒ `preventContinuation`；
   通知类事件（如 PostToolBatch）同样输出 ⇒ 仅 `blockRequested`，无 `preventContinuation`。
3. 失败语义：超时 / 非 0 非 2 退出 / schema 校验失败 ⇒ `HookRunFailed` + 结果放行；
   退出码 2 ⇒ 阻断类事件拒绝。
4. 触发 payload 形状：PostToolBatch（toolResults/successCount/errorCount）、
   Pre/PostModelSwitch（previousModel/nextModel）、StopFailure（errorType/cancelled）、
   TaskCreated/TaskCompleted（taskId/taskStatus/toolName）、CwdChanged（previousCwd/newCwd）、
   Pre/PostCompact（trigger/outcome/token counts）。
5. 回归：既有 7 事件的触发与语义不变（存量测试全绿）。
