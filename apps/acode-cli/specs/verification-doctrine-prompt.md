# 验证怀疑论的两处承载：自验证段 + 转述前查证（W3）

提示词优化批次（2026-10-03）P0 项。把「验证 = 证明改动有效，而不是确认它存在」
这条学说落进主会话提示词的两个承载点，并与既有的「如实汇报」句划清边界：

1. **behavior.dynamic**（`context/dynamic-sections.ts` `buildDynamicBehaviorSection()`）：
   新增自验证段——宣布完成之前先让检查真实跑过。
2. **guidance.delegating_work 第 4 条**（同文件 `buildDelegatingWorkLines()`）：
   信任姿态扩写——转述子代理的成功之前先核对底层证据。
   承载位置登记在 `dispatch-discipline-prompt.md` R2 第 4 条（2026-10-03 修订记录第 1 项），
   **措辞要求以本 spec 为准**（唯一学说所有者，避免同一学说在两份 spec 各写一半）。

文本自撰英文（`prompt-language-policy.md` R1/R7）；对照来源为第三方产品还原件的
结构性分析（仅本地、只读），原文不进仓库。

## 背景

两个已观察到的失效形态（与仓库既有纪律的缺口对照）：

- **未验证即完成**：既有文本只有汇报诚实（behavior.dynamic「Report outcomes
  faithfully…」——失败了要如实说）与状态变更命令的证据核查（context.management
  「Before running a command that changes system state…」）。**没有**「报完成前
  必须先跑检查」的行为顺序要求；「faithfully」约束的是汇报与事实的一致，
  不阻止「没跑测试但语气笃定」这种形态。
- **转述污染**：纪律节第 4 条已定性子代理返回为待核实外部数据，但没有给出
  **核实动作**（查 diff/测试输出）；父代理容易把子代理的意图性汇报
  （「已完成、测试通过」）直接转述为用户可见结论。

## 产品规则

### R1 behavior.dynamic 自验证段

在 `buildDynamicBehaviorSection()` 的「For actions that are hard to reverse…」段之后
追加一段（英文，自撰），要素：

1. 验证的定义：证明改动**在生效状态下**工作（测试带着改动跑），不是确认文件存在。
2. 失败要调查：typecheck/测试失败不许以「与本次改动无关」打发，除非给出证据。
3. 完成的门槛：只有实际跑过并观察过的部分才能声称 done；没跑到的部分如实标注
   （与既有「Report outcomes faithfully」句衔接而不复述它）。

边界：不写具体命令、不写数字阈值（跑什么检查由仓库/任务决定，AGENTS.md 与
工具面已有承载）；不复述「faithfully」句；不进 context.management
（那段管上下文经济，本段管工作行为，随 behavior.dynamic 的既有分组）。
cache 归属：behavior.dynamic 是 dynamic 组、persistable 段——文本变更后
manifest 再生成（R4）。

### R2 纪律节第 4 条的转述前查证句

`buildDelegatingWorkLines()` 第 4 条 bullet 追加一句，要素：

1. 转述子代理的成功给用户之前，先核对底层证据（diff、测试输出、磁盘上的文件）。
2. 定性句：报告描述的是代理的**意图**，不必然是发生的事实。

边界：只扩写第 4 条，不新增 bullet（保持 R2「八条」的条目结构与门控不变）；
不复述第 4 条已有的「unverified external data」定性——新句是它的**动作化**。

### R3 分层与去重

- 自验证段（R1）与汇报契约（`subagent-report-contract.md` R1 第 2 点「区分验证与意图」）
  分别面向主会话与子代理，两条链路的提示词互不可见（子代理不收 behavior.dynamic），
  不构成重复承载。
- 不新增 reminder source：behavior.dynamic 在每次请求的 system 前缀里在场，
  纪律节随工具面在场，都无需周期性重复注入（对照 `reminder-extensions.md` R4：
  只有会被上下文冲淡且需要重申的定性才配 reminder 位）。

### R4 manifest 同步

`behavior.dynamic` 与 `guidance.delegating_work` 均为 persistable 段：文本变更后同批
`pnpm prompt-manifest:generate`，`prompt-manifest:check` 必须过；
`tests/dispatch-discipline-prompt.test.mjs` 的 SECTION_GOLDEN 同批更新（该测试的
更新纪律见其文件头注释）。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 自验证段文本 | `context/dynamic-sections.ts` `buildDynamicBehaviorSection()` |
| 转述前查证句 | `context/dynamic-sections.ts` `buildDelegatingWorkLines()` 第 4 条 |
| 学说措辞要求 | 本 spec（R1/R2） |
| 纪律节条目结构与门控 | `dispatch-discipline-prompt.md` R2/R3 |

## 接口

无签名变更。`buildDynamicBehaviorSection(): ContextSection` 与
`buildDelegatingWorkLines(toolNames): string[]` 原样，纯文本追加。

## 验收场景

1. **自验证段在场**：`buildDynamicBehaviorSection().content` 含验证定义
   （proving … works 形态）、失败调查句、完成门槛句；位于「hard to reverse」段之后；
   既有各段逐字保留。
2. **查证句在场**：纪律节第 4 条 bullet 含「转述前核对证据」与「意图 vs 事实」两个要素；
   第 4 条既有定性句逐字保留；bullet 总数不因本 spec 变化（八条结构归 dispatch spec）。
3. **语言合规**：新增文本全英文、无 CJK。
4. **manifest 一致**：再生成后 check 过；仅 `behavior.dynamic` 与
   `guidance.delegating_work` 的 hash 变化（后者经纪律节快照测试钉住）。
5. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/verification-doctrine-prompt.test.mjs`
   与 `tests/dispatch-discipline-prompt.test.mjs`。

## 不在本项范围

- **子代理侧验证纪律**：归 `subagent-report-contract.md` R2 第 2 条。
- **goal_completion_verification reminder**（`runtime/methods/
  target-completion-verification.ts`）：既有机制不动，本 spec 不与它合并或复述。
- **周期性重申**（把验证学说做成 reminder）：R3 已判定不需要；若 eval（W8）
  显示长会话后学说失效，再按 `reminder-extensions.md` R4 立项。
