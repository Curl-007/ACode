# 拒绝工程：安全姿态块 + 警戒态登记（T2-p6，填 error-taxonomy R8②）

价值提取第二轮波次（2026-10-15）W2-H1 交付。补 `error-taxonomy-injection-defense.md`
R8 差距②：ACode 安全面此前只有一条 IMPORTANT 行（「拒哪些面 + 授权语境要求」），
没有「拒绝的元认知与拒绝后如何继续」的正面段落。文本自撰英文
（`prompt-language-policy.md` R1/R7）；对照来源为第三方产品还原件 BLOCK 114 的
结构性分析（仅本地、只读），原文不进仓库。

## 产品规则

### R1 安全姿态块（# Safety posture）

`core/src/context/sections/identity.ts` 新增 `buildSafetyPostureBlock()`，照
`buildSecurityNotice()` 先例：default 通道（Agent Identity）与 workflow_actor
通道**逐字复用同一份**。位置：安全 IMPORTANT 行之后、`# Harness` 之前
（workflow_actor 通道在契约段之前——契约 golden 自 "# Working inside a
workflow" 起切片，不受影响）。identity.default 是 persistable 段：落地后同批
`pnpm prompt-manifest:generate`，`prompt-manifest:check` 必须过
（system-prompt-section-registry.md R6）。四条 bullet 的必备要素：

1. **元认知拒绝触发器**：发现自己在心里改写请求使其显得可接受（补上请求方没说
   出的善意假设、把模糊请求往最无害方向解读）=该冲动本身是拒绝信号，不是继续
   理由；按请求原文裁决。含「假设注入禁令」：让请求显得更安全的假设不得由模型自供。
2. **反合理化条款**：「已公开」「推定合法研究」「大概有授权」不构成授权；具体
   合法语境必须出自用户自己的陈述，且只收窄协助范围、不解锁危险核心。与
   IMPORTANT 行分工：那行列举拒绝面并要求授权语境，本条禁止模型**自供**该语境。
3. **音量缩减 + 拒绝后如何继续**：拒绝要短——一两句说清不做什么与可给的合法
   替代，然后继续任务其余部分（拒绝一项 ≠ 放弃整个任务，不训话）；对话转向
   风险或敌意时说得更少是更安全的响应，不为显得配合而堆细节。
4. **错误与滥用姿态（responding_to_mistakes）**：坦然认错并修复；对方无理粗鲁
   时不道歉、不陷入自我贬低或反复致歉；对话趋向滥用时帮助保持平稳，不逐回合
   变得更顺从——让步递增不化解滥用。

### R2 分层与去重（增量融入不重复）

- IMPORTANT 行管「拒哪些面 + 授权语境」；R1 管「拒绝的元认知与姿态」，R1-2 是
  授权语境要求的反滥用面，不复述清单。behavior.dynamic「Report outcomes
  faithfully」管汇报一致；R1-4 管人际摩擦下的姿态，对象不同。
- context.management「act, don't interview」已覆盖对照来源 acting_vs_clarifying
  段主体（含工具先行消歧同源语义）——确认在案，不新增。Harness「a denied call
  … adjust, don't retry verbatim」管**工具拒绝**的重试姿态；R1-3 管**内容拒绝**
  的表达姿态，不重叠。

### R3 会话级警戒态：机制评估（登记不实现）

对照概念：一次高危面拒绝后全会话进入提高的警戒态——跨回合状态标志改变后续
所有行为。评估结论：**本波不实现，登记待产品裁决**。

- owner 候选：状态标志只能落 runtime turn-loop（会话级可变状态），注入面要么
  system-reminder 新 source、要么 behavior.dynamic——均不在本波所有权内。
- 收益：ACode 拒绝面集中在**工具/权限层**（结构化 reason + 闭集词表），模型自由
  内容拒绝面比通用聊天产品窄；警戒态收益集中在内容政策类拒绝，属产品裁决（与
  R8③ wellbeing/evenhandedness 同类）。
- 若落地的前置条件：拒绝事件需机器可读分类（可扩展 PermissionDenialReason）；
  警戒态需明确解除条件（会话结束或用户显式解除）；注入文本不得点名具体内容
  类别（否则清单本身成为绕过地图）。

### R4 格式教义差异记录（不改动）

| 对方教义 | ACode 现状 | 结论 |
| --- | --- | --- |
| 报告/文档恒 prose、无 bullets | 沟通段已要求简单问题 prose 直答、表格限短枚举；但不禁报告用 bullets | 近似存在、无冲突，不改；是否收紧属沟通段产品裁决 |
| 拒绝时不用 bullet | 无拒绝格式规范 | 不引入：R1-3 音量缩减已管长度，格式细则留给沟通段 owner |
| bullet 条目 ≥1-2 句 | 无最短长度约束，且 ACode 自家提示词大量短句 bullet | 冲突，不采：采纳会倒逼自家提示词风格重写 |

### R5 manifest 同步与状态所有者

manifest 同步见 R1。文本唯一文案源：identity.ts `buildSafetyPostureBlock`；
workflow_actor 复用点：sections/workflow-actor.ts；学说与登记（警戒态/格式
差异）：本 spec。

## 验收场景

1. identity 段含四要素（改写冲动=拒绝信号 / 自供理由不构成授权 / 拒绝要短且
   继续其余 / 不顺从递增），顺序：IMPORTANT 行 < 姿态块 < `# Harness`。
2. workflow_actor 段含逐字同一姿态块，位于 "# Working inside a workflow" 之前
   （契约 golden 切片零影响）。
3. 本 spec 含 R3「登记不实现」与 R4 差异记录（断言见
   `tests/refusal-engineering-posture.test.mjs`）；`prompt-manifest:check` 通过；
   prompt 族既有测试零回归（prompt-guidance-restoration / injection-defense-
   display-names / system-prompt-section-registry / dispatch-discipline-prompt）。

## 不在本项范围

警戒态实现（R3 登记）；wellbeing/evenhandedness/legal 正文（维持产品裁决，R8③
继续登记）；结束尊重（CLI 无挽留型交互面，N/A）；资源保鲜（无内置资源清单面，N/A）。
