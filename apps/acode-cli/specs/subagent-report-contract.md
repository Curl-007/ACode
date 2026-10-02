# 子代理汇报契约与工作纪律（W1，含 W4 命令白名单核查结论）

提示词优化批次（2026-10-03）P0 项。给子代理侧提示词补一层**汇报契约**与**工作纪律**：
结构化汇报（证据 → 可转述一句话）、scope 纪律、验证后才报完成、git 卫生、被拒上报协议、
resume 语义、空结果诚实汇报。全部是 profile/notes 层文本改动，不改任何运行时行为、
不改函数签名、不新增段或 reminder source。

文本一律自撰英文（`prompt-language-policy.md` R1/R7）；本批次的对照来源是对第三方产品
还原件的**结构性分析**（仅本地、只读），任何第三方原文不进仓库、不进本 spec。

## 背景

### 已核实的现状（基线：当前检出）

子代理提示词由三个文件承载（段 id 见 `system-prompt-section-registry.md`：
`subagent.agent_prompt` / `subagent.notes`）：

| 承载点 | 现有内容 | 缺口 |
| --- | --- | --- |
| `core/src/subagent/system-prompt.ts` `buildSubagentCommonNotes()` | 绝对路径、汇报带路径/少贴代码、禁 emoji、tool call 前不用冒号、禁写报告 .md | **无汇报结构契约**：不要求「先证据后一句话总结」，不区分「验证过的」与「打算做的」 |
| `core/src/subagent/general-purpose.ts` `buildGeneralPurposeSystemPrompt()` | 任务定位、strengths、搜索/分析/彻底性指导、禁滥建文件 | **无 scope 纪律**（发现无关问题会顺手修）、**无验证要求**（改完不跑测试就报完成）、**无 git 卫生**（可能 `git add .`）、**无被拒协议**（权限拒绝后可能反复重试或绕路）、**无 resume 语义**（被简短后续指令唤醒时可能当成含糊任务重读一切） |
| `core/src/subagent/explore.ts` `buildExploreAgentPrompt()` | 只读红线、POSIX 命令白名单、strengths、快返指导 | **无空结果诚实条款**：找不到时可能用记忆补路径 |

子代理**不接收**主会话的 `# Delegating work` 纪律节（`SUBAGENT_SECTION_REGISTRY` 不含
session guidance 段），且 fan-out 硬深度 1（`dispatch-discipline-prompt.md` 背景节）——
因此本 spec 的文本与父侧派发学说**无重复承载面**。

### W4 核查结论：命令白名单不需要 PowerShell 变体（记录在案，不改代码）

对照分析发现第三方产品的只读代理提示词按 OS 切换 POSIX/PowerShell 两套命令清单。
核查 ACode 实际执行链后判定**不适用**：

- Bash 工具的 shell 解析（`adapters/src/exec/bash-shell-provider.ts`）在 win32 上
  **自动探测 Git Bash**（固定安装路径 → git.exe 反推），posix 上解析 bash/zsh；
  即默认路径在所有平台都是 POSIX 方言。
- `cmd` 方言仅存在**用户显式配置** override 一条路（`resolveEffectiveWindowsBashShellSelection`
  的 user-config 分支）；探测全失败时落 `legacy-shell`（系统 shell）。
- 只读保证的执行面本来就不依赖提示词清单：Explore 工具面无 Write/Edit
  （`subagent/explore-tools.ts`）+ 进程策略地板 + 旁路免疫熔断器三层兜底
  （`subagent-policy-floor-inheritance.md` R1/R3）。

**决定**：`explore.ts` 的 POSIX 白名单措辞保持不变；不引入按平台分叉的双套清单
（默认路径全平台 POSIX，双清单会在 99% 的会话里注入错误方言、且违反
`prompt-language-policy.md` R1 的单一文本原则——方言不是 locale，但分叉成本同理）。
cmd/legacy-shell override 属用户显式选择的少数形态，清单措辞退化可接受，
硬保证由上列三层兜底承担。本条为 W4 的**全部交付**：核查 + 结论入档，零代码改动。

## 产品规则

### R1 汇报契约进 common notes（唯一承载点）

`buildSubagentCommonNotes()` 追加一条 bullet（含两行示例），要求最终回复：

1. **先证据后总结**：第一部分写做了什么/发现了什么，带可核查的具体物
   （文件路径、行号、跑过的命令与输出要点）；第二部分给**一句话**、
   父代理可原样转述给用户的 summary。
2. **区分验证与意图**：描述你验证过的事实，不是你的意图；没跑测试就明说没跑。
3. 示例一行 good / 一行 bad（good 带路径+测试+commit hash 形态；bad 是
   「看了文件、改了我们讨论的东西」形态）——示例是契约的一部分，不是装饰：
   没有对照示例时模型会把 bad 形态当合格。

约束：追加 ≤ 5 行（common notes 进**每一个**子代理的独立 system message，
行数成本按派发次数放大；段 id `subagent.notes` 的 cache breakpoint 结构不变）。
既有条目（绝对路径、禁 .md 报告等）保持原文原位——本条是新增 bullet，不改写旧条。

### R2 general-purpose 工作纪律

`buildGeneralPurposeSystemPrompt()` 在 Guidelines 之后追加一个纪律块，五条：

1. **scope 纪律**：只做被要求的任务；沿途发现的无关问题写进汇报作为 follow-up 建议，
   不动手修。
2. **验证后完成**：报「改完了」之前先验证——环境允许就跑相关测试/检查，
   汇报里写跑了什么、结果如何；无法验证就显式声明。与 R1 第 2 点同口径，
   但 R1 管**汇报措辞**、本条管**行为顺序**（先验证再报完成）。
3. **git 卫生**（条件句：仅当任务包含提交时）：只 stage 实际改动的文件，
   禁 `git add .` / `git add -A`，汇报 commit hash。与主会话 Bash 描述的
   「Commit or push only when the user asks」不冲突：子代理的提交永远是任务授权的。
4. **被拒协议**：工具调用被拒/被拦截时，汇报里给出确切动作、拒绝原因、
   需要什么批准或变更才能解锁——**一次**。不原样重试同一被拒动作，不绕路达成同一效果。
5. **resume 语义**：可能被简短后续指令唤醒（如「补上测试」）；此前上下文完整保留，
   简短是有意的、不是含糊——基于已知继续，不重读一切。

约束：追加 ≤ 6 行；不复制主会话纪律节的任何句子（子代理收不到那一段，
但文本重复会稀释两份提示词各自的所有权）。

### R3 explore 空结果诚实条款

`buildExploreAgentPrompt()` 的 Guidelines 追加一条：找不到就明说找不到，
列出搜过的位置/模式；**不得**用记忆补路径、补符号名。约束：≤ 2 行。

### R4 语言与合规

全部新增文本为自撰英文（`prompt-language-policy.md` R1/R7：模型面恒英文、
禁复制第三方产品提示词原文）；代码注释中文。新增文本不含 CJK
（`prompt-language-policy` 测试的同款断言在本 spec 测试里重复一份，防跨文件回归）。

### R5 manifest 与快照同步

`subagent.notes` / `subagent.agent_prompt` 若为 persistable 段（以注册表 descriptor 为准），
文本变更后同批运行 `pnpm prompt-manifest:generate`（`apps/acode-cli` 下）更新
`context/generated/prompt-manifest.json`；`prompt-manifest:check` 必须过。
既有测试对这三个函数的文本断言（如有）同批更新 golden。

## 状态所有者

| 事实 | 所有者 | 本 spec 的角色 |
| --- | --- | --- |
| 汇报契约文本 | `subagent/system-prompt.ts` `buildSubagentCommonNotes()` | 追加一条 bullet（R1） |
| general-purpose 纪律文本 | `subagent/general-purpose.ts` | 追加纪律块（R2） |
| explore 诚实条款 | `subagent/explore.ts` | 追加一条 guideline（R3） |
| 只读命令白名单 | `subagent/explore.ts`（现状） | **不动**（W4 结论） |
| 段注册/manifest | `context/registry-subagent.ts` + `scripts/generate-prompt-manifest.mjs` | 只触发再生成，不改结构 |

## 接口

无签名变更：`buildSubagentCommonNotes(): string`、`buildGeneralPurposeSystemPrompt(): string`、
`buildExploreAgentPrompt(options): string` 原样。纯文本追加，调用方零改动。

## 验收场景

1. **汇报契约在场**：`buildSubagentCommonNotes()` 输出含结构要求（证据部分 + 一句话
   可转述 summary）、验证/意图区分句、good/bad 示例各一行；既有条目逐字保留。
2. **五条纪律在场**：`buildGeneralPurposeSystemPrompt()` 输出可逐条定位 scope、
   验证后完成、git 卫生（含 `git add .` 禁令字面量）、被拒协议（含「一次」语义）、
   resume 语义；strengths/guidelines 既有条目逐字保留。
3. **空结果条款在场**：`buildExploreAgentPrompt({})` 与
   `buildExploreAgentPrompt({ embeddedSearchEnabled: true })` 两个变体都含
   「找不到就明说 + 不用记忆补」条款；只读红线段与命令白名单逐字不变（W4 钉住）。
4. **语言合规**：三个函数的输出无 CJK 字符；新增行全英文。
5. **manifest 一致**：`pnpm prompt-manifest:generate` 后 `pnpm prompt-manifest:check` 过；
   受影响段 hash 变化、其余段 hash 不变。
6. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/subagent-report-contract.test.mjs`
   与既有 `apps/acode-cli/tests/*.test.mjs` 全量。

## 不在本项范围

- **父侧派发学说**（continue-vs-spawn 判据、派单 prompt 质量、权限门姿态）：
  归 `dispatch-discipline-prompt.md` 2026-10-03 修订。
- **验证怀疑论的两处承载**（behavior.dynamic 自验证段、纪律节转述前查证句）：
  归 `verification-doctrine-prompt.md`。
- **fork/team/coordinator 形态、风格变体、子代理 fan-out 深度**：维持既有 spec 的
  「长期可选/不做」判定。
- **workflow actor 契约段**（`sections/workflow-actor.ts`）：已有独立契约文本与
  submit/escalate 时序，本批不动。
