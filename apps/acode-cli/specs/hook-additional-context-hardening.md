# Spec：hook additionalContext 注入通道防滥用硬化

来源：omp 价值提取波 2 WI-15（台账 T2「hooks additionalContext 通道」行 + 九路报告要点
存档⑦第 5 项）。概念参照 oh-my-pi（MIT）`docs/hooks.md`：hook 返回 `additionalContext`
以被动上下文形态随下一次模型请求送达、与工具输出分离。

## 现状审计（本波之前的既有面，全部不改语义）

台账假设「需要新增 additionalContext 输出字段」——**实测该通道已端到端存在**：

1. **输出面（contracts）**：`HookJSONOutput.additionalContext` / `additional_context`
   （顶层，任意事件）+ `HookSpecificOutput.additionalContext`（PreToolUse 与全部通知类
   事件，`contracts/src/hooks/hook-event-io.ts`）。外部进程 hook（含 workspace 7 可写
   事件，根 `packages/shared/src/workspace-hook-config.ts` 配置面）经
   `configured-runner-callback.ts parseHookStdout` → `HookJSONOutputSchema` 到达同一漏斗。
2. **收集（core hooks）**：`processHookOutput`（`core/src/hooks/output.ts`）把上述字段
   收进 `HookRunResult.additionalContexts: string[]`；`mergeHookRunResult` 顺序合并。
   唯一环节结算点：`runner-link.ts dispatchHookLink`（processHookOutput → merge）。
3. **注入面（system-reminder / modelContent）**：
   - 生命周期事件（SessionStart/UserPromptSubmit/Stop）：
     `injectHookAdditionalContextIntoMessageHistory`（`runtime/methods/hooks.ts`）→
     `systemReminderAttachmentEntry("hook_context", …)`（reminder 源已注册于
     `core/src/system-reminder/source.ts`，per_request 档）→ messageHistory；整体
     24,000 字符截断（`HOOK_CONTEXT_MAX_CHARS`）。
   - 工具事件（PreToolUse/PostToolUse/PostToolUseFailure）：
     `formatHookAdditionalContexts`（`tool/executor/hook-flow.ts`）拼进该工具结果的
     modelContent（call-runner / result-serialization，受工具结果预算约束）。
   - Stop 续跑判定 `shouldContinueAfterStopHooks`（≤3 次）既有语义不变。

因此根 `packages/shared` 与 `packages/services` **本波零改动**（无新增配置字段、无
schema 变更、无 digest 影响）；事件集 = 既有全部产出 additionalContexts 的事件
（漏斗处硬化，事件无关）。

## 本波增量：防滥用硬化（唯一事实源：`core/src/hooks/output.ts`）

| 机制 | 裁决 | 实施点（单写路径） |
| --- | --- | --- |
| 单条长度上限 | 8KB（8,192 字符）；超长头部截断并追加 `...[truncated]` 标记，截断后整条 ≤ 上限 | `hardenHookAdditionalContexts`（output.ts），由 runner-link 环节结算点在 merge 前调用 |
| 每事件注入次数上限 | 单次事件派发（一次 `hookRunner.run`）最多保留 8 条，超出静默丢弃（合并点无 logger，保持纯函数） | `mergeHookRunResult`（output.ts）——所有产出（含 middleware 自答与下游段）都经此合并 |
| 来源 hook 名标注 | `HookRunResult.additionalContextSources?: (string|undefined)[]` 与 additionalContexts 索引对齐；注入格式化时条目头渲染为 `#N (hook: <名>)` | 名字在 harden 点写入（= `resolveHookRefusalName`，即 descriptor.commandDisplay ?? source ?? "hook"，经 sanitizeHookDisplayText 消毒；再做单行折叠 + 80 字符截断，防 hook 名换行伪造标签） |

**关键取舍——标注不进内容本体**：`plugin-hook-middleware.test.mjs` 与
plugin-hook-middleware spec（"合并结果逐一不变"）精确断言 `additionalContexts` 数组
内容，故来源标注走**平行 sources 数组 + formatter 层渲染**，`additionalContexts` 字符串
本体只受截断影响（短文本零变化）。sources 数组仅在至少一条有来源时才存在，缺席条目
用 undefined 占位；不变式：存在时长度与 additionalContexts 一致（harden 与 merge 两处
共同维持，无第三写入点）。

**零回归保证**：无 sources 时（存量测试构造的裸 HookRunResult、skill-path 触发提醒等
非 hook 产出），两个 formatter 输出与现状逐字节相同（`#N\n<ctx>`）。

## 每轮上限的裁决（不做 turn 级全局预算）

上限实施在事件派发粒度：生命周期事件每轮派发次数本就有界（SessionStart/UserPromptSubmit
各 ≤1，Stop ≤1+3 次续跑），派发级上限即轮级上限；PostToolUse 按工具调用派发，注入附着
在各自工具结果内（已受 resultBudget 约束），跨调用的 turn 级全局预算需要执行器共享
计数器（新状态所有权），**登记后续 R2 与 tool_result 结果补丁一并评估**。

## 后续登记（本波明确不做）

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | tool_result 结果补丁 | omp `tool_result` handler 改写 content/details/isError（台账同行的另一半，大件：需 per-field 合并语义与序列化面改造） |
| R2 | turn 级注入预算 | 跨工具调用的每轮 additionalContext 总量预算（见上节裁决） |
| R3 | contracts 输出 schema 收口 | 在 `HookJSONOutputSchema` 层加 `.max(8192)` 类校验（当前在执行面截断，schema 保持宽容以兼容旧 hook） |

## 触及文件（core 最小接线面）

`core/src/hooks/{types,output,runner-link,index}.ts`、
`core/src/tool/executor/{hook-flow,call-runner,result-serialization}.ts`、
`core/src/runtime/internal-hook-methods.ts`、
`core/src/runtime/methods/{hooks,turn,turn-stop,resume}.ts`。
守护测试：`apps/acode-cli/tests/hook-additional-context-hardening.test.mjs`（新）+
存量 hook-events-* / plugin-hook-middleware 零改动零回归。

## 验收场景

1. 截断：单条 >8,192 字符 → 保留头部 + `...[truncated]`，总长 ≤ 上限；短文本逐字节不变。
2. 次数上限：单次派发 9+ 条（多 hook 各产多条）→ 合并结果恰 8 条，保留先到先得顺序。
3. 来源标注：workspace/插件 hook 产出的 context 注入文本含 `#1 (hook: <commandDisplay>)`；
   hook 名含换行/超长时被折叠截断为单行 ≤80 字符；无来源产出（skill-path 提醒）仍为 `#N`。
4. 对齐不变式：merge 混合「有源/无源」两侧时 sources 与 contexts 索引对齐（undefined 占位）。
5. 零回归：存量 hook-events-contract/lifecycle/failure-semantics 与 plugin-hook-middleware
   测试不改一行全绿；无 sources 时 formatter 输出与旧实现逐字节一致。
