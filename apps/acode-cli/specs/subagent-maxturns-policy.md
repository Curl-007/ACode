# subagent maxTurns 处置策略：悬空配置删除（D3 修正项 #1）

调度主线 D3 审计的修正项 #1 落地规格。来源：
[`command-terminal-state-audit.md`](command-terminal-state-audit.md) 问题 1（1 + 1b）——
`maxTurns` 在主/子代理 turn loop 里**没有强制点**，是悬空配置，且带用户可写面。

> **spec-first 顺序登记（据实）**：本 spec 的删除实现**先于**spec 成文落地（2026-09-29
> 同工作区批次），属 spec-first 顺序倒置，由当日盘点登记、本 spec 回填补登。删除范围
> 已按修正项 #1 的清单逐处 grep 复核为零命中，并由
> `apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs` 从「断言缺口存在」翻转为
> 「断言缺口已闭合」钉住。后续对本面的任何改动以本 spec 为准，不得再倒置。

## 背景

审计确认的事实（证据与行号见 `command-terminal-state-audit.md` 结论区问题 1，
E1/E2/E3 齐全）：

- 主/子代理 turn loop 是无条件 `while (true)`，只由 model step 返回 `"break"` 收口；
  break 的三个来源（automation 创建上限命中、assistant text-only 自然收口、工具主动
  请求停轮）没有一个是轮数上限。`turn-loop.ts` 与 `agent-runtime.ts` 对 `maxTurns`
  零引用。
- 但 `maxTurns` 有一条完整的**装配链**：`RuntimeConfig.maxTurns` /
  `subagents.maxTurns` 声明 → `methods/subagent.ts` 的「默认 4」装配 →
  workflow child runtime 装配 → child 边界透传（实测桩件收到 `maxTurns: 2`）→
  **无人读取**。
- 且它是**用户可写面**：agent markdown frontmatter 合法字段、`packages/services`
  双向序列化、设置页保存时原样带回、`packages/shared` 类型在案、另有两条全仓无消费
  点的 i18n 文案。用户手写 `maxTurns: 2` 被完整解析并透传后静默无效，child 照
  `while (true)` 跑到底、终态仍是 `completed`。
- 唯一真实的轮数强制点在 memory agent loop（`memory-agent-loop.ts` 的
  `for (; turns < input.maxTurns; ...)`），且只被硬编码常量 `EXTRACTION_MAX_TURNS = 5`
  喂入，不接任何用户/配置面；其到顶可观测性由
  `command-terminal-state-audit.md` §A 单独约束。

与既有产品决定直接一致：`apps/acode-cli/AGENTS.md`「长程任务优先：核心 agent loop
默认面向可持续运行的复杂任务设计，**不用 tool call 次数做硬停止**。资源与安全边界
应由 token/context limit 自动 compact、用户取消、权限拒绝、工具超时、输出截断、
provider retry 上限等明确条件承担。」

## 产品规则

### R1 主/子代理循环不设轮数硬停止

主 agent loop 与 subagent loop 保持 `while (true)` + break 收口的既有形态。资源与安全
边界只由 `AGENTS.md` 列举的明确条件承担（compact / 取消 / 权限拒绝 / 工具超时 /
输出截断 / provider retry 上限）。**禁止**以「补上 maxTurns 强制点」的方式给循环加
轮数硬停止。

### R2 配置面 maxTurns 整体删除，不留半条链

删除范围 = 修正项 #1 清单的全链（声明 / 装配 / schema / 透传 / frontmatter 往返 /
类型成员 / 设置页保留逻辑 / 孤儿 i18n 文案），删除后全仓 `*.ts`/`*.tsx` 源码
（dist 与测试文件除外）对配置面 `maxTurns` 零命中。不允许保留任何「解析了但没人读」
的中间形态——悬空配置带用户可写面时，比没有配置更糟（用户以为生效）。

### R3 兼容性：残留 frontmatter 键与未知键同等待遇

已写了 `maxTurns:` 的用户 agent markdown **不报错、不迁移、不回写**：

- 解析只挑已知键（`parseAgentProfileFromMarkdown` / `parseSubagentMarkdown` 均无
  maxTurns 分支），残留键与其他未知 frontmatter 键同等待遇，**不产 diagnostic**
  （它曾经合法、值无副作用，报错只会制造噪音）；
- 重序列化（`serializeSubagentMarkdown`）按已知字段清单输出，不回写残留键——用户
  下一次经设置页保存时该键自然消失。

### R4 唯一合法的轮数上限：memory agent loop 的内部参数

`runMemoryAgentLoop` 的 `input.maxTurns` 是**内部显式参数**而非配置字段：唯一调用方
是 project memory 抽取，唯一喂入值是硬编码常量 `EXTRACTION_MAX_TURNS = 5`。它不接
`RuntimeConfig`、不接 agent profile、不接 workflow script options。到顶的可观测性
（`capped` 截断标记 + warn 分流）按 `command-terminal-state-audit.md` §A 执行。
除这一个内部循环外，仓内不得出现其他轮数上限。

### R5 再引入必须先改本 spec（防回退）

若产品未来坚持给子代理恢复轮数上限，**不得裸加回字段**，必须先修订本 spec 并按审计
问题 1b 的 (ii) 分支执行：到顶终态必须是**可区分的截断态**（新 status 或 `completed`
+ 显式截断标记），不得裸复用 `completed`——否则调用方无法区分「做完了」与「被切断了」，
重新制造审计登记的缺口。

## 状态所有者

本项**删除**状态面，不新增任何状态所有者：

| 面 | 处置 |
| --- | --- |
| `RuntimeConfig.maxTurns` / `subagents.maxTurns`（core/runtime/types.ts） | 已删除 |
| agent frontmatter `maxTurns` 往返（services/subagentMarkdown.ts、core/subagent/profile.ts） | 已删除（残留键按 R3） |
| 类型成员（packages/shared/subagents-types.ts 两处） | 已删除 |
| 设置页保留逻辑（packages/ui/SubagentsSection.tsx）与 i18n 两条孤儿文案（en-US/zh-CN 各 2 键） | 已删除 |
| workflow script schema 成员 + `MAX_WORKFLOW_AGENT_TURNS`（contracts/workflow/script.ts） | 已删除 |
| child 边界透传（core/subagent/runner.ts、methods/subagent.ts、bootstrap/script-workflow-child-runtime.ts） | 已删除 |
| memory 抽取轮数（`EXTRACTION_MAX_TURNS`，project-memory-extraction.ts） | **保留**（R4，硬编码常量） |

## 接口

本项不定义新接口。对外可见的接口变化 = 删除：

- `AgentProfile` / `SubAgentConfig`（packages/shared）不再有 `maxTurns?` 成员；
- `ExploreSubagentRuntimeRequest`（core/subagent/runner.ts）不再携带 `maxTurns`；
- workflow `agent()` options schema 不再接受 `maxTurns`。`WorkflowAgentOptionsSchema`
  是 `.strict()`（contracts/workflow/script.ts:44-58）：显式写了 `maxTurns` 的旧脚本
  会在 schema 校验时**报错**（unrecognized key），不是被静默剥掉。这是有意的显式失败
  ——该键从未生效过，静默剥离会让作者继续相信它有效；报错文本足以指引删掉该键
  （resume/amend 携旧脚本时同此口径）。
- `runMemoryAgentLoop` 的入参 `maxTurns: number` **保留**（内部参数，见 R4），返回值
  形状为 `{ capped, messages, turns }`（§A）。

## 验收场景

由 `apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs`（8 例）钉住，其中
(1)(2)(4) 钉审计事实防回退、(3)(5)(8) 钉删除面、(6)(7) 钉 §A 可观测性：

1. `turn-loop.ts` / `agent-runtime.ts` / `turn-stop.ts` / `turn-tools.ts` 对 `maxTurns`
   零命中（强制点不存在的事实不被「补强制点」悄悄推翻——那必须先过 R5）。
2. 装配面与声明面零命中：`methods/subagent.ts`、`script-workflow-child-runtime.ts`、
   `runtime/types.ts`、`contracts/workflow/script.ts`（含 `MAX_WORKFLOW_AGENT_TURNS`）、
   `runner.ts`。
3. 用户可写面零命中：`subagentMarkdown.ts`、`profile.ts`、`subagents-types.ts`、
   `SubagentsSection.tsx`、`packages/ui/src` 全域（含 i18n 文案键）。
4. memory loop 强制点仍在且只被 `EXTRACTION_MAX_TURNS` 喂（唯一调用点）。
5. child 边界行为核查：profile 上被强行挂 `maxTurns: 2` 时，child 收到的请求不携带
   该字段、终态 `completed` 不带截断标记（透传确实断了）。

## 不在本项范围

- **memory 抽取到顶的可观测性**：归 `command-terminal-state-audit.md` §A（修正项 #2）。
- **给子代理实现真实轮数上限**：R5 路径，须先修订本 spec。
- **workflow 预算/总量保险丝**：归 `workflow-budget-fuses.md`（D2）——那是 run 级
  agent 总数与 token 预算，不是单 agent 轮数。
- **旧 agent markdown 的批量迁移工具**：R3 已论证不需要（残留键无副作用、保存即消失）。

## 实现记录（2026-09-29）

- 删除落点（与本 spec R2 清单一致，git diff 复核）：
  `apps/acode-cli/packages/core/src/runtime/types.ts`（-2 行）、
  `apps/acode-cli/packages/core/src/runtime/methods/subagent.ts`（「默认 4」装配）、
  `apps/acode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts`（装配）、
  `apps/acode-cli/packages/contracts/src/workflow/script.ts`（-2 行：schema 成员 +
  `MAX_WORKFLOW_AGENT_TURNS`）、`apps/acode-cli/packages/core/src/subagent/runner.ts`
  （请求字段 + profile 透传）、`apps/acode-cli/packages/core/src/subagent/profile.ts`
  （-12 行：类型成员 + `normalizePositiveInteger` + 解析/组装）、
  `packages/services/src/subagents/subagentMarkdown.ts`（-14 行：解析 + 序列化）、
  `packages/shared/src/subagents-types.ts`（-2 行：两处类型成员）、
  `packages/ui/src/settings/SubagentsSection.tsx`（-1 行：保存带回逻辑）、
  `packages/ui/src/i18n/locales/en-US.ts` 与 `zh-CN.ts`（各 -2 行：
  `settings.subagents.form.maxTurns.label/.placeholder` 孤儿文案）。
- 测试：`apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs` 已翻转为闭合断言
  （文件头注明翻转理由与两个缺口各自的钉住方式）。
