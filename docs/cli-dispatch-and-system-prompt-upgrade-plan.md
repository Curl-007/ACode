# CLI 调度与系统提示词升级方案（CLI Dispatch & System Prompt Upgrade Plan）

本文件是 ACode CLI 的两条主线升级路线图：**任务调度（dispatch/scheduling）**与**系统提示词（system prompt）**。方案基于对 zoode 逆向研究工作区中上游参考客户端（Claude Code CLI 2.1.283 快照）还原产物的机制级提炼，以及对 ACode 当前源码的逐项核实对照。适用于所有协作者与 AI 辅助会话；与 [AGENTS.md](../AGENTS.md) 冲突时以 AGENTS.md 为准。

> **文档状态**：方案（plan）+ **实施状态同步（2026-09-29）**。**Phase 0 / Phase 1 / Phase 2 已实施**；**Phase 3 已实施**——D4 todo 依赖字段、D5 并发只读诊断投影、P4 语言策略（含 P4-b UI 文案 i18n）、P7 reminder 扩展、D2 token 预算硬顶、P5 度量铺设 + 立项决策（**ToolSearch 本体未实施**，立项 ≠ 实施，仍须另立 spec 并评估 ephemeral cache 交互）。逐项状态与一句话依据见「优先级总览」表的**实施状态**列；Phase 0 待验证项的闭环结论见 §8.2；门禁结果与独立评审结论见 §11。**改动全部留在工作区、尚未提交**（本次实施与文档同步均未执行 git commit/push/merge）。每项落地均先按 AGENTS.md 的 spec-first 约定新增/更新 `apps/acode-cli/specs/*.md` 再改代码（实际产出 11 篇新 spec，见 §5；其中 `subagent-maxturns-policy.md` 为补登，spec-first 顺序倒置已在该 spec 内据实登记）。
>
> **生成日期**：2026-09-29。**实施日期**：2026-09-29（与生成同日）。**行号时效性**：以下 `file:line` 仍以基线 git `7578e1e`（2026-09-29 检出）为准；**本次实施改动（65 个修改文件 + 52 个新增文件，未提交）已使部分行号漂移**，定位请以文件名 + 符号名为主，行号仅作基线索引。
>
> **参考基线**：zoode 工作区 claudecli 还原产物（上游 Claude Code CLI 2.1.283 快照）的**机制级提炼**。该快照的调度事实为产物逐字确认但未经对抗式复核；所有推测级结论在本文中一律降级为「待验证假设」（见第 8 章），不作为方案设计依据。
>
> **合规声明**：本文仅提炼转述第三方客户端的机制设计思路，不包含其原始代码或提示词原文；逆向还原产物受目标软件 EULA 约束，禁止再分发与原文复制，禁止将其中的 mangled 标识符当作稳定 API 引用。本方案遵守 [`specs/no-telemetry.md`](../apps/acode-cli/specs/no-telemetry.md)：不恢复遥测、不引入服务端 A/B。安全 P0–P2 议题引用 zoode 工作区既有《ACode-提升方案.md》（2026-09-27）与 [`security-hardening-plan.md`](security-hardening-plan.md)，本文不重写。

---

## 执行摘要

**ACode 与上游机制同源度很高，真缺口比表面看起来少得多。** 逐项对照后确认：ACode 的子代理 Notes 模板与上游逐字同源（`apps/acode-cli/packages/core/src/subagent/system-prompt.ts:10-19`）；fan-out 深度门控比上游**更严格**（硬深度 1：派发工具过滤 + 子配置 `subagents:{enabled:false}` 结构性继承）；v4 CommandInbox 的三态分离、admissionSeq 权威顺序、CAS 拒 stale、settled LRU 等设计成熟度**高于**上游内部文档自曝的水平。这些都不需要再做。

真缺口收敛为两条主线共 11 个有效项：

1. **调度主线（D1–D7）**：上游的关键经验是**调度语义大量由提示词层承载**（后台优先、禁轮询、不预测后台结果），而非仅靠运行时硬约束——ACode 可以低成本移植这层「调度纪律提示词」（D1，P0）。运行时侧的真缺口是 dynamic-workflow 缺三道保险丝（agent 总数上限、单次条目数显式报错、token 预算硬顶，D2），以及命令/子代理终态语义需要一次只读审计（D3，把上游自曝的两处缺口当自查清单而非模板）。TodoWrite 依赖字段（D4）、并发只读诊断投影（D5）、cron 空闲触发验证（D6）为次级项；fork/team/coordinator/ScheduleWakeup/Dream 判为不适用或长期可选（D7）。

2. **提示词主线（P1–P7）**：主提示词中 Agent/AskUserQuestion 使用指导段目前被注释停用（`context/dynamic-sections.ts:48-66`），且与 Agent 工具描述存在内容重叠——恢复时必须做承载层去重审查而非简单取消注释（P1，P0）。组装管线与上游同构但缺**命名动态段注册表**与**版本化清单**（P2/P3）；memory 守则与 env 段存在已确认缺口（P6）；提示词恒英文判定为有意设计而非缺陷，出决策 spec（P4）；延迟工具 ToolSearch 先测量后立项（P5）；reminder 承载类型可小幅扩展（P7）。

**落地节奏**：Phase 0（spec + 审计 + 度量）→ Phase 1（P0 提示词层，仅动 4 个文件 + 快照测试，风险最小）→ Phase 2（P1 运行时）→ Phase 3（P2 可选评估）。P0 项全部为提示词/描述层改动，不触碰调度运行时；任何触碰队列的改动必跑 CommandInbox 不变量测试套件，并同步验证 `desktop-continuous` 与 `web-remote-replayable` 双语义链路。

> **实施进度（2026-09-29）**：Phase 0 / 1 / 2 / 3 **均已实施**，改动留在工作区未提交；唯一例外是 P5 的 ToolSearch 三件套本体（度量与立项决策已闭环，实施须另立 spec）。逐项状态与依据见「优先级总览」的**实施状态**列，门禁与评审结论见 §11，Phase 0 待验证项闭环情况见 §8.2。

## 优先级总览

| 项 | 主线 | 优先级 | 阶段 | 一句话摘要 | 影响包 | 工作量 | 实施状态（2026-09-29） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **D1** | 调度 | P0 | Phase 1 | 调度纪律提示词节（后台优先/禁轮询/Don't race/Don't peek 呼应）+ Agent 工具描述去烘焙 | core | M | **已实施** —「# Delegating work」纪律节落地（`dynamic-sections.ts:18` 常量 + descriptor `guidance.delegating_work`，`registry-main.ts:148`）；`agent.ts` 模块加载期烘焙常量已删（仅 `:91` 注释留档说明），描述改由 registry 装配期产出；测试 `dispatch-discipline-prompt.test.mjs` |
| **P1** | 提示词 | P0 | Phase 1 | 恢复停用的 Agent/AskUserQuestion 指导段（先去重）+ workflow-actor escalate 说明段 | core | S | **已实施** — 指导段恢复且做承载层去重（`getDirectSearchGuidance` 单点产出，去重审查 4 行记录在 `dispatch-discipline-prompt.md`「去重审查记录」表）；`sections/workflow-actor.ts` escalate 段按 driver 四时序（submit accept/reject/nudge/escalate）扩写；测试 `prompt-guidance-restoration.test.mjs`（6 例，含 escalate 四时序快照断言） |
| **P6** | 提示词 | P1 | Phase 1 | memory 守则 5 段 + env 段 3 项补齐 | core | S | **已实施** — `sections/memory.ts:49,55` 好记忆三特征（Applicable/Durable/Legible）+「记忆 = 待核实快照」定性段，查重句扩为扫 MEMORY.md 索引 + 目录；`sections/env-info.ts:15,17,93,103` 恢复 Node version / OS 明细（`describeOperatingSystem`）/ not-a-git-repo 显式指令段（条件渲染）；文本自撰英文（R7）；测试 `memory-env-sections.test.mjs` |
| **D6** | 调度 | P0(验证) | Phase 0 | cron 到期是否打断进行中 turn——集成测试验证，视结果立修正项 | core/bootstrap | S | **已实施（验证闭环，零产品代码修正）** — `tests/cron-idle-trigger.test.mjs` 5 例走真实链路（host sendText envelope → `NATIVE_HANDLERS.sendText` → `startPromptTurn(delivery:"start_turn")` → `admitPrompt` busy 裁决 → `enqueueDeferredInput`），断言「延迟入队、既不打断也不 steer 进在飞 turn、队列提升只在空闲」；按 D6 原判据判「已具备」仅补文档；`git status` 无 cron/prompt-turn/steering/queue-auto-drain 产品文件改动。结论详见 §8.2 #1 |
| **D2** | 调度 | P1 | Phase 2 | workflow 三保险丝：agent 总数上限 + 单次条目数显式报错（先行）；token 预算硬顶（P2） | dynamic-workflow(-runtime) | M | **已实施（三道顶全部落地，含原 P2 后置的 token 硬顶）** — `facade/budget-caps.ts:30,36,45`：`maxAsksPerRun=4096` / `maxPendingAsks=2048` / `maxTokensPerRun=2_000_000_000`；ask 准入时判定绝不静默截断（`scheduler-types.ts` effectiveAskBudget + runBudgetGatedAdmission）、错误经 `AgentBudgetExceeded`/`TokenBudgetExceeded` 进 `WorkflowError.details` 可序列化往返；token 侧含 resume/amend 预算继承（第一世 run-started 读回、拒新阈值）；spec 常量定值记录 + R4 实现记录已填；测试 `workflow-budget-fuses.test.mjs` |
| **D3** | 调度 | P1 | Phase 0 审计/Phase 2 修正 | 命令与子代理终态语义审计（maxTurns 终态/丢弃路径闭合/cancel 竞态三问） | core/bootstrap | S(审计) | **已实施（审计闭环；修正项 #1–#7 落地，#8 仍待验证）** — 结论区 + 追加小节 §A/§B/§C 已回填 `command-terminal-state-audit.md`（三问判定：问题 1 需修正 / 问题 2 主体已闭合 / 问题 3 需修正）；#1 悬空 `maxTurns` 全链删除（源码仅剩 `memory-agent-loop.ts` 内部参数，grep 复核）+ spec `subagent-maxturns-policy.md`；#2 memory 到顶可区分（`capped` 标记 + `memory.extraction.turn_capped` warn）；#3 first-wins 收进原语层（`runtime-task/registry.ts:133-173` + spec `subagent-terminal-first-wins.md` + 测试）；#4 inbox 约定文字（纯注释，行为零改动）；#5 stale-branch 可观测性（debug→info + 钉住测试 `stale-branch-terminal-observability.test.mjs`）；#6 死分支保留 +「纵深防御」注释；#7 不变量套件 `command-inbox-invariants.test.mjs`（7 例）；**#8 业务 guard 未接线仍待产品/host 侧回答**（→ §8.2 #7） |
| **P2** | 提示词 | P1 | Phase 2 | SectionDescriptor 注册表化组装管线，主/子代理路径共享 descriptor 基础设施 | core | L | **已实施** — `builder.ts` 重写为注册表管线（`resolveSectionEntriesSync`/`resolveSectionEntries` + 新增 `buildAsync`）；`MAIN_SECTION_REGISTRY`（`registry-main.ts:224`）恰 16 id = 本文件 12 + `registry-shared.ts` 4（prefix.cli / skills.listing / request.user_context / date.current）；`SUBAGENT_SECTION_REGISTRY` 3 id；新增 `section-descriptors.ts`/`section-flags.ts`/`registry*.ts`；三选一身份互斥硬失败语义与 `assembleSystemMessages`（≤3 system block 全 ephemeral）未触及（builder diff 中该名只出现在新增注释行）；落地偏差 3 条已记录在 `system-prompt-section-registry.md`；测试 `system-prompt-section-registry.test.mjs` |
| **P3** | 提示词 | P1 | Phase 2 | prompt-manifest 版本化清单 + 可重复 parity 校验脚本（不阻断 CI） | core/构建脚本 | M | **已实施** — `context/manifest.ts` + `context/generated/prompt-manifest.json`（6 个 persistable 段）+ `apps/acode-cli/scripts/generate-prompt-manifest.mjs`（generate/`--check`）+ `apps/acode-cli/scripts/check-prompt-parity.mjs` + `parity-baseline.json` + `prompt-parity-lib.mjs`；`apps/acode-cli/package.json:21-23` 新增 3 入口（`prompt-manifest:generate`/`:check`、`prompt-parity:report`）；parity 基线只含段 id + 中文机制名（有形状校验断言拒长编码载荷，无逆向原文）；测试 `prompt-manifest-parity.test.mjs` |
| **D4** | 调度 | P2 | Phase 3 | TodoWrite 可选 blockedBy+metadata 最小依赖形态（不做 owner/认领） | core(+ui 回归) | M | **已实施** — `contracts/tools/todo.ts:63,81` 可选 `id`/`blockedBy`/`metadata` + 派生 `available`，`superRefine` 做 id 唯一 / 悬空报错 / 成环点名 / 上界报错不截断；新 `todo-deps.ts` 纯函数归口；migration `0023-todo-deps-json.ts`（nullable 列）+ `migrations.ts` 登记；根 shared `acodeSessionTodoItemSchema` 最小加宽三个可选成员、`.strict()` 保留；session-mapper / codecs 携带与宽容重建；spec 实施记录 7 条（含 v4 链路核查、宽严解析取舍）；测试 `todo-dependency-fields.test.mjs` |
| **D5** | 调度 | P2 | Phase 3 | 各调度器并发只读诊断投影（否决全局信号量） | core | S | **已实施** — `contracts/model/index.ts:87,96` 新增可选成员 `concurrencyBuckets?()` + 收窄投影 `ModelRequestAdmissionBucketSnapshot`（key/ceiling/cap/inFlight/waiters/cooldownUntil）；governor 侧只读实现（不 observe 不 drain）；core `concurrency-diagnostics.ts` 聚合四固定域（tool_scheduler / dynamic_workflow / plan_explore / subagent_background）+ debug 日志；`scheduler.ts` 暴露 `snapshot()`；dynamic-workflow 本体零改动、无新增写入路径；spec 实现记录已填；测试 `concurrency-diagnostics.test.mjs` |
| **P4** | 提示词 | P2 | Phase 3 | 「模型面提示词恒英文、UI 面文案走 i18n」决策 spec + UI 可见文案接入 i18n | core/i18n | S | **已实施（推荐方案 a：保留 `language` + 注释；含 P4-b）** — `context/types.ts:132,141` 写明「永远不该有模型面消费方、`ui.locale` 是唯一所有者」及裸 `string` 非 `UiLocale` 的类型不一致；`contracts/tools/contract.ts` `userVisibleMessage` 注释（模型面恒英文、UI 走结构化字段 → i18n key → 回落原文）；P4-b 两键落地：i18n `toolCancelled`（`zh-CN.ts:88`「工具取消：${detail}」/ `en-US.ts:87` 纯透传）+ TUI 接入（`tui/src/app-event-data.ts:93`）；spec 实施记录含「(i) 删除 `language` 前置条件不成立」的 grep 论证与留给后续所有者的 5 处删除清单；测试 `prompt-language-policy.test.mjs`（12 条） |
| **P5** | 提示词 | P2(评估→**已立项**) | Phase 0 度量/Phase 3 实施 | 延迟工具 ToolSearch：tools schema token 占比 >15% 才立项——**2026-09-29 实测 19.4%，判据成立，立项**（实施仍排 Phase 3，另立 spec） | core | 评估→立项 | **部分实施（度量 + 立项决策已闭环；ToolSearch 本体未实施）** — 已落地：`tools-schema-token-metric.ts`（R1 debug 事件 `tools_schema_token_metric`：toolCount/systemToolCount/mcpToolCount/mcpServerCount/schemaChars/schemaTokens/tokenizer）+ `methods/config.ts` getTools 缓存重建分支触发 + `context-usage.ts` 与度量共用 `stringifyToolContractForEstimation` 口径合一 + `context-usage-log-compact.ts` 派生 `toolSchemaRatioPercent`；spec 实现记录 + R3 判据操作手册 + 测试 `tools-schema-token-metrics.test.mjs`。**未实施**：discovered-set / reminder 名单 / 按需取回三件套本体（须另立 spec 并先评估 ephemeral cache 交互）。**19.4% 为实施轮会话内度量记录、仓内不可复核**（debug 级生产不落盘，原始日志未留存；复测按 R3 手册），详见 §4 P5 决策记录 |
| **P7** | 提示词 | P2 | Phase 3 | reminder 扩展：TodoWrite 久未使用提醒、召回记忆提醒（归入三来源分类） | core(+shared v4) | S | **已实施** — `runtime-reminders.ts:109,217` todo 提醒内容门槛 `UNFINISHED_TODO_STATUSES=[pending, in_progress]`（与 spec R1 条件 5 一致，见 §4 P7 措辞勘误）；`:94,235` `MEMORY_RECALL_REMINDER_CONFIG` 5-turn 节奏 + `buildMemoryRecallReminderBody`；`system-reminder/source.ts` 将 `memory_recall` 归入 per_current_turn 档——**不新增 persisted source，v4 schema 零改动**（spec 落地偏差记录在案）；turn-loop 侧 todo_reminder 改条件提交（body 为 null 不落 synthetic notice）+ memory_recall per-request 接线（`outputTokenRecoveryActive` 时抑制）；测试 `reminder-extensions.test.mjs` |
| **D7** | 调度 | 非目标 | — | fork/team/coordinator/ScheduleWakeup/Dream 登记长期可选 | — | — | **未实施（有意）** — 非目标登记项，无产品需求方，本轮无任何代码/文档改动；触发条件见 §3 D7 |

> S=小（≤1 天）M=中（1–3 天）L=大（>3 天）。
>
> **实施状态列口径**：状态与依据由 **2026-09-29 文档同步轮**据工作区实况回填——依据来自实施轮/独立评审轮的书面记录，并由本轮对源码、spec、测试文件与 `git status`/`git diff` 的**只读复核**交叉验证（复核命令与结果见 §11.3）；**本轮未复跑任何测试或门禁**，「已实施」只表示改动在工作区且与 spec 一致，不表示本轮重新验证通过。行号以基线 `7578e1e` 为准，可能因本次改动漂移。

---

## 1. 背景与基线

### 1.1 ACode 调度链路现状

```
用户/远端输入
   │
   ▼
v4 CommandInbox（bootstrap/src/acode-protocol-v4/command-inbox.ts:107-505）
   │  锁序：key gate → per-session FIFO gate（:139-141）；settle 前不放行（:183-203）
   │  in-flight / live-input / settled 三态分离；settled 内存 LRU 512/session（:487-496）
   │  baseRevision + baseLogEpoch CAS 拒 stale（:325-364）；admissionSeq 权威顺序（:162-164）
   ▼
AgentRuntime.executeTurn（core/src/runtime/agent-runtime.ts:572）
   │  prompt admission（core/src/runtime/methods/prompt-admission.ts:20-126）：
   │  busy → steerTurn / enqueueDeferredInput；idle → reserveTurnStart + priority "next"
   ▼
RuntimeCommandQueue（core/src/runtime/command-queue.ts:117-135，now/next/later 三档）
   │  串行 drain（methods/runtime-command-queue.ts:23-44）+ 进程内 promotion lease（:111-149）
   ▼
runRegularTurnLoop（core/src/runtime/methods/turn-loop.ts:43，while(true)）
   │  每轮：mid-turn 命令吸收(:57) → microcompact(:73) → autoCompact+rapid-refill 熔断(:82-104)
   │  → 工具面过滤(:113-122) → reminder 注入(:120-167) → provider 投影+cacheControl(:168-183)
   │  → TurnMachineImpl 相位记录(:186-191) → runModelBackedTurnStep(:211)
   │
   ├──► 工具并发调度（core/src/tool/scheduler.ts:50-227，拓扑排序+并行分组，默认上限 10）
   ├──► subagent（tool/handlers/agent.ts:174-222 → runtime/methods/subagent.ts:59-90
   │      → core/src/subagent/runner.ts:131；前台 Promise.race + auto-background :291-334；
   │      后台完成同步写父队列 :115）
   └──► dynamic-workflow（engine/engine.ts WorkflowEngine、engine/scheduler.ts:43 AskScheduler、
          engine/concurrency.ts:25-61 自适应控制器；dynamic-workflow-runtime/src/harness.ts
          子进程 NDJSON 桥；bootstrap/src/app/workflow-driver.ts 每 actor 持久 child runtime）
```

恢复语义：冷恢复 `bootstrap/src/acode-protocol-v4/cold-session-resume.ts`；回放 `replay.ts`（三段纯函数归约）；workflow resume 以 journal + script_text 比对 + `resumedFrom` lineage + amend-resume（`harness.ts:74-160,279-380`）。双链路在协议握手处分叉：`packages/shared/src/acode-protocol-v4/transport.ts:46,56`（`desktop-continuous | web-remote-replayable`）。

### 1.2 ACode 系统提示词组装现状

`ContextBuilder.build()`（`core/src/context/builder.ts:82-223`）六步：① cli_prefix ② 三选一身份体（customSystemPrompt / workflowActor / 默认 identity，互斥硬失败 :92-97；custom 跳过整个默认体系 :124-129）③ 动态 system 段（desktop / Dynamic Behavior / Session guidance / Memory / Env / Output Style / Context Management / git 快照 :124-173）④ Skills（仅当工具面含 Skill :175-187）⑤ meta_user（agentsMd + currentDate :189-202）⑥ 自定义 section。

排序与投递：`orderSectionsForInjection`（:310-325，system-stable → system-dynamic → meta_user）；`assembleSystemMessages`（:230-277）产出最多 3 个 system block，全部带 ephemeral cacheControl；meta_user 组装为 `skills_listing` 与 `context_prefix` 两个 attachment（:279-336）。

子代理走**独立组装路径**（`core/src/subagent/context-builder.ts:46-163`）：每段独立 system message、各自带 ephemeral cache breakpoint——这是刻意的 cache 设计而非缺陷，但两条路径的公共段目前重复维护。

Reminder 有正式的三来源分类与投递通道枚举（`core/src/system-reminder/source.ts:20-55`：PREFIX / PERSISTED（15 种）/ PER_REQUEST）；新增注入点必须归入该分类。

i18n 现状：`apps/acode-cli/packages/i18n/src/index.ts:25-32` 仅覆盖 en-US/zh-CN **UI 文案**；`language` 字段在 `context/types.ts:124` 声明、`runtime/methods/context.ts:138` 透传，但**无任何 section 消费**；提示词正文全部为硬编码英文常量。

### 1.3 调研来源与置信度分级

本文结论来自三路输入的交叉验证：

1. **zoode 侧提炼**（上游 2.1.283 快照还原产物分析报告）：调度机制 A1–A11、提示词构成 B1–B8、prompt-parity 缺口 C 组。置信度三档：**产物逐字确认**（A/B/C 组主体）/ **推断**（代码级接线细节）/ **推测待验证**（深度预算函数语义、coordinator 产品入口、占位符→工具名映射、服务端实验放量——均进第 8 章，不作设计依据）。
2. **ACode 侧现状基线**：全部结论带 `file:line` 证据（基线 7578e1e）。
3. **架构复核**：对两侧结论逐项抽查 19 处关键文件，无矛盾；修正一处路径漂移（dynamic-workflow 引擎文件位于 `apps/acode-cli/packages/dynamic-workflow/src/engine/` 子目录）。

既有《ACode-提升方案.md》（zoode 工作区，2026-09-27）已覆盖安全 P0–P2 与部分 P3 登记项；本文的增量边界是**调度 + 提示词两条主线的移植设计**，其中该方案仅一句话登记的「任务依赖图」「prompt-cache 诊断」在本文展开为 D4 与 P2/P3 的机制细节。

---

## 2. 差距分析总表

判定口径：**已具备** = 有等价或更严格机制；**部分具备** = 骨架在、细节缺；**缺失** = 无等价物且有价值；**不适用** = 产品面/约束排除。

> **时效性说明（2026-09-29）**：本章是**实施前基线**（`7578e1e`）的差距分析，实施后原样保留作为设计依据与追溯记录，**不代表当前仍存在的缺口**——各项落地状态见「优先级总览」的实施状态列与 §11；表中 `file:line` 为基线行号，本次改动已使部分漂移。

### 2.1 调度机制（A1–A11）

| 项 | 判定 | 差距说明（ACode 证据，基线 7578e1e） |
| --- | --- | --- |
| A1 coordinator/worker 双层 | 部分具备 | 无 coordinator 模式产品面（其入口在 zoode 侧即为推测项）；Host + subagent + task-notification 形态等价。只借鉴「派发者自身保持只读纪律」的设计思想，不新增模式 |
| A2 派发参数面 | 部分具备 | description/prompt/subagent_type/run_in_background/SendMessage 续跑/usage 统计均有（`tool/handlers/agent.ts:141-150`）；缺 isolation(worktree)/effort/name 参数（isolation 无产品面→不适用；name 由 agentId 覆盖）；「后台默认 + 禁 sleep/poll」提示词纪律未系统承载→**D1** |
| A3 fan-out 深度门控 | 已具备（更严格） | ACode 为硬深度 1：`runtime/methods/subagent.ts` 经 `tool/compat.ts:12` 过滤派发工具 + 子配置 `subagents:{enabled:false}` + dynamicWorkflowEnabled 结构性继承（:275 注释明言防灰度后门）。上游「剩余深度预算」为推断且 ACode 无多层 fan-out 需求 |
| A4 fork 语义 | 缺失（纪律半具备） | 无上下文继承/prompt-cache 共享的 fork 类型；Don't-peek 已在工具结果层承载（`agent.ts:159-166`）；Don't-race 归入 **D1**。fork 本体成本高、无需求方→长期可选不进路线 |
| A5 workflow 并发与预算 | 部分具备 | `caps.maxConcurrency` 落库 + `run-caps-changed` 事件 + 自适应控制器（`engine/concurrency.ts:25-61`）+ repair/nudge 预算（`engine/scheduler-submit.ts:51`）已有；**缺 token 预算硬顶、agent 总数保险丝、单次条目数显式报错**→**D2** |
| A6 命令队列 fold/终态 | 已具备（主体） | mid-turn 吸收 = fold 等价（`runtime-command-active-loop.ts:22-90`）；CommandInbox 三态分离 + admissionSeq + CAS + settled LRU 成熟。上游内部文档自曝两处缺口（到顶终态误报 completed；admission 丢弃后无终态）转为 ACode **自查清单**→**D3**，不照抄 |
| A7 cron 空闲/jitter/wakeup | 部分具备 + 待验证 | cron 存在且**有意不做 jitter**（`tool/handlers/cron.ts:210`，本地产品无全球错峰需求，合理）；嵌套创建守卫已有（`bootstrap/src/acode-protocol/automation-port.ts:25`）；**空闲触发（不打断进行中 query）待验证**→**D6**；ScheduleWakeup 类机制不适用（后台完成通知已替代轮询，D1 补提示词纪律） |
| A8 共享任务清单 DAG | 缺失（裁剪后） | `tool/handlers/todo.ts` 扁平（content/status/priority，无 owner/blockedBy）；「恰一个 in_progress」纪律已同源具备；上游 Team 四件套无消费产品面→**D4** 最小形态 |
| A9 恢复语义 | 已具备（主体） | workflow journal + script_text 比对 + resumedFrom lineage + amend-resume + stopped(interrupted) 可 resume（`harness.ts:74-160,279-380`）；cold-session-resume + replay 三段纯函数归约；rapid-refill 熔断 = thrash 检测等价（`turn-loop.ts:82-104`）。待验证：脚本确定性约束（禁非确定性时间/随机源）、中断输出围栏回灌等价物 |
| A10 团队机制 | 不适用 | 无 team-lead/named-teammate 产品面；后台任务「单独一行机器可读结果摘要」约定→D3 顺带对照 `core/src/subagent/completion-notification.ts` 核验 |
| A11 信任分级 | 部分具备 | 反「伪造用户批准」+ 反 permission-laundering 已在 `system-reminder/incoming-message.ts:5-10`；relay 鉴权归既有安全方案（引用不重写）；「批准动作 fresh-spawn 新 agent 执行」不适用（无对应产品面） |

### 2.2 系统提示词（B1–B8）

| 项 | 判定 | 差距说明 |
| --- | --- | --- |
| B1 组装管线 | 部分具备 | `builder.ts` section 数组 + source/cacheHint + 排序 + 三 system block ephemeral 与上游同构；**缺命名动态段注册表、异步段统一解析、上下文余量段**；上游 A/B 旗标改造为本地开关且不打遥测（no-telemetry 红线）→**P2** |
| B2 输出风格 | 已具备 | buildOutputStyleSection + identity 联动（`builder.ts:84-124`） |
| B3 工具描述条件模板 | 已具备（带缺陷） | per-model 投影（`tool/model-contract.ts:4-33`）、WebSearch 按模型门控、dynamicWorkflowEnabled 灰度、Plan 模式分工均在；**缺陷 = `agent.ts:128` 模块加载期烘焙常量**（灰度关闭时描述指向不存在工具的历史问题见 :84-90 注释）→**D1 去烘焙** |
| B4 延迟工具 ToolSearch | 缺失（评估项） | 无 discovered-set / reminder 名单 / 按需取回三件套；token 收益未测量→**P5** 先测量后立项（判据：tools schema token 占比 >15%） |
| B5 子代理提示词栈 | 已具备 | 基座（`general-purpose.ts:9` 与上游基座语等价）+ Notes 同源（`system-prompt.ts:10-19`）+ injectAgentsMd profile 控制 + 内置类型独立权限（`methods/subagent.ts:315`）。双组装路径是刻意 cache breakpoint 设计**非缺口**，但共享 descriptor 设施可消重复维护→**P2**；上游 2.1.283 注入防御加厚点列为实施时核对项（仅机制层面） |
| B6 subagent 权限收敛 | 已具备（spec 约束） | [`subagent-policy-floor-inheritance.md`](../apps/acode-cli/specs/subagent-policy-floor-inheritance.md) + resolveSubagentPermissionMode（`methods/subagent.ts:479`）+ managed-policy-floor spec；服务端风险分类器不适用（无服务端依赖产品面），本地 security-monitor 等价物为 P2 可选（归既有安全方案 P3 议题） |
| B7 reminder 承载类型 | 部分具备 | 三来源分类正式存在（`source.ts:20-55`）；skills_listing/通知/上下文尾注已有；**缺 TodoWrite 久未使用提醒、召回记忆提醒**→**P7**；延迟工具名单随 P5 |
| B8 memory/dream | 部分具备/不适用 | memory 段存在（`sections/memory.ts:25-40`）但保存守则缺 5 段→**P6**；Dream 后台记忆整合依赖 fork 机制→不适用（长期可选） |

### 2.3 prompt-parity 缺口重判（C 组）

parity 缺口清单原以 ZCode 3.14.0 为对照基线（17 段），**已按 ACode 当前检出重判**：

| 缺口（原清单） | 重判结果 |
| --- | --- |
| env-info.ts 3 段 | **确认缺失**：主提示词 env 段无 Node version / OS 明细 / not-a-git-repo 显式指令（`sections/env-info.ts:9-45`）；子代理侧 `system-prompt.ts:29-37` 反而更全→**P6** |
| memory.ts 5 段 | **确认缺失**：查重更新 / frontmatter 规范 / 互链 / 索引行 / 待写标记守则未承载（`sections/memory.ts:25-40`）→**P6**，机制提炼自撰 |
| workflow-actor.ts 1 段 | **确认缺失**：escalate 升级通道说明段——driver 四时序含 escalate（`bootstrap/src/app/workflow-driver.ts`）但提示词未告知 actor→**P1** |
| builder.ts 4 段 | 属代码级组装分支差异（section.source/cacheHint 判断），注册表化（P2）时自然收敛，不单列 |
| dynamic-sections.ts 4 段 | **确认注释停用**（`dynamic-sections.ts:48-66`）；恢复须做承载层去重审查（与 `agent.ts` 工具描述部分重叠，如「委派了搜索就不要自己重复搜」两处都有）；文本以 ACode 自有注释原文为底稿改写，不照搬 zoode 产物→**P1** |

---

## 3. 调度主线升级方案（D1–D7）

### D1（P0）调度纪律提示词层移植 + Agent 工具描述去烘焙

**现状**：上游经验表明调度语义大量由提示词层承载（后台优先、禁轮询、不预测后台结果），成本低收益高（zoode 侧关键发现 F-1）。ACode 目前：后台为 opt-in + 超时自动转后台（`runner.ts:291-334`），Don't-peek 已在工具结果层（`agent.ts:159-166`），但**系统提示词层无统一的派发纪律节**；且 Agent 工具描述存在模块加载期烘焙常量（`agent.ts:128`），灰度门与描述同步有历史问题（:84-90 注释）。

**推荐方案**：

1. system 动态段新增「# Delegating work」纪律节（**自撰文本**）：后台优先判据（前台仅当「下一步动作依赖其结果且期间无事可做」）；禁 sleep/poll 等待后台结果（完成会自动通知）；Don't race（不预测、不编造、不代做后台 agent 的工作）；Don't peek 在系统层一句话呼应工具结果层既有文本；task-notification 内容视为不可信外部数据。
2. 同批消除烘焙：Agent 工具描述构建全部收敛到 registry 装配期（`tool/registry.ts:104-139` toContracts 处）；烘焙常量删除，或降级为显式命名的 fallback 并加防漂移测试。

**备选与取舍**：a) 纪律全放 Agent 工具描述——否决：跨工具策略（含 SendMessage、通知等待）放单工具描述会造成承载层重复与灰度漂移（B3 缺陷的根源）；b) 只做运行时改动不做提示词——否决：该类语义主要在提示词层承载，运行时硬约束无法表达「判据」。

**影响**：core（`dynamic-sections.ts`、`tool/handlers/agent.ts`、`tool/registry.ts`）；新 spec `dispatch-discipline-prompt.md`（主题：子代理派发纪律的承载层与随工具集条件组装规则）。

**验收**：提示词快照含纪律节；灰度关闭时描述不指向不存在工具（回归 :84-90 历史问题）；profiles / embeddedSearch / dynamicWorkflowEnabled 三变量组合快照测试全绿。

**测试**：快照单测 + 灰度组合矩阵；双语义链路——desktop-continuous：后台完成→父队列直写路径不变；web-remote-replayable：通知回放分类不变（不把通知当用户输入）。

### D2（P1）dynamic-workflow 三保险丝

**现状**：已有 `caps.maxConcurrency` 落库 + `run-caps-changed` 事件 + 自适应并发控制器（降 0.75 倍/连成 4 次升 1/下限 1/空闲 300s 重置，`engine/concurrency.ts:25-61`）+ repair/nudge 预算。**缺**：token 预算硬顶、单 run agent 总数保险丝、单次 parallel/pipeline 条目数上限。自适应控制器控的是**速率**不是**总量**，无失控回环保险丝。

**推荐方案（分两步）**：

- **P1 先行**：① 单 run agent 总数上限——超限结算 failed，`budget_exhausted` 原因入 journal；② 单次 parallel()/pipeline() 条目数上限——**显式报错而非静默截断**。
- **P2 后置**：token 预算硬顶——需跨引擎 token 计量面；与 resume 预算继承联动（剩余预算随 journal 落库，resume 沿用）。

**备选与取舍**：只做总数上限 = P1 最小交付；三顶一次做——否决（token 计量面复杂度高）；信任自适应控制器不做——否决（速率≠总量）。

**影响**：dynamic-workflow（`engine/types.ts` Caps、engine-settlement、scheduler-submit）、dynamic-workflow-runtime（harness journal）；新 spec `workflow-budget-fuses.md`（主题：workflow 预算硬顶、总数保险丝与 resume 预算继承）。

**验收**：各顶触发时结算为 failed 且 journal 有明确 reason；resume 后剩余预算一致；`run-started`/`run-caps-changed` 事件字段不回退。

**测试**：engine 结算单测、resume 集成测试（journal 断言）、amend-resume 记账回归。**实施前须对上游机制做二次代码级核对**（ zoode 侧 R-5：并发帽/预算为产物确认但未经对抗复核）。

### D3（P1）命令与子代理终态语义审计

**现状**：ACode CommandInbox 设计成熟（三态分离/admissionSeq/CAS/锁序），mid-turn 吸收等价于上游 fold 语义。上游内部文档**自曝**两处缺口：到顶终态误报 completed；admission 丢弃后无终态。这两处是 ACode 的**自查清单**而非照抄模板（zoode 侧 F-5）。

**推荐方案**：只读审计 + 集成测试驱动，回答三问：

1. subagent `maxTurns`（默认 4，`methods/subagent.ts:270`）到顶的终态是否误报 completed？
2. 每条 admission 丢弃路径（branchGeneration 过期 / duplicate collapse / CAS stale 拒）是否有可观察终态回传调用方？
3. cancel/complete 竞态次序语义是否有明确文档化约定？

发现缺口才立最小修复项；审计结论写入 spec `command-terminal-state-audit.md`（主题：命令与子代理终态语义的完整闭合清单）。顺带对照上游「后台任务机器可读结果摘要」约定核验 `completion-notification.ts`（A10 残留项）。

**备选与取舍**：照抄上游队列语义重写 CommandInbox——**明确否决**：ACode 现有设计成熟度高于上游自曝水平；重写破坏 admission 不变量（治理红线）。

**验收**：三问各有 `file:line` 证据与测试覆盖；CommandInbox 不变量测试套件全绿（锁序、settle 前不放行、CAS、admissionSeq）。

### D4（P2）TodoWrite 依赖表示最小升级

**现状**：`tool/handlers/todo.ts`（198 行）仅 content/status/priority 扁平结构；上游共享任务清单为 DAG（owner 认领 + blockedBy/blocks + 最小 ID 优先 + 更新前重读防陈旧），是既有方案 P3「任务依赖图」的完整参考实现（zoode 侧 F-2）。但 ACode 无多 peer 产品面。

**推荐方案（裁剪后最小形态）**：todo 项增加**可选** `blockedBy`（列表内 ID 引用）+ `metadata`；工具输出区分 available（pending 且未被阻塞）；提示词纪律「最小可用 ID 优先、开工前核对 blockedBy 已清空、更新前重读防陈旧」（一句话挂 D1 纪律节）；blockedBy 成环即时 schema 报错。**不做** owner/认领/TaskList 四件套（无消费面，避免投机设计；未来 team 机制以此为演进基础）。

**影响**：core（`handlers/todo.ts`）；新 spec `todo-dependency-fields.md`（主题：todo 依赖字段语义、环检测与向后兼容）。

**验收/测试**：环检测单测、available 过滤单测、旧格式（无 blockedBy）向后兼容快照、UI 侧 todo 渲染回归（packages/ui 消费面核对）。

### D5（P2）并发治理面只读投影（不做全局调度器）

**现状**：并发上限多处独立无共享治理面——工具级默认 10（`tool/scheduler.ts:48`，可配 `agent-runtime.ts:250-254`）、dynamic-workflow caps + 自适应、Plan 模式 Explore 并行 3（`runtime-reminders.ts:29-37`）、subagent 后台。

**推荐方案**：仅建**只读诊断投影**：各调度器向 runtime 暴露统一 caps/current/degraded 快照接口，供 debug 日志与文档引用；参数调整权留在各域。

**备选与取舍**：全局信号量统一 admission——**否决**：三域语义不同（turn 内/run 级/会话级），统一会破坏 CommandInbox 与 owner/lease 边界（治理红线：不能仅按单一路径删边界判断）。

**验收**：快照接口不改变任何调度决策（纯投影）；无新增写入路径。

### D6（P0 验证项，视结果 P2 修正）cron 空闲触发对照

**现状**：上游 cron 仅在 REPL 空闲时触发（不打断进行中 query）。ACode cron 触发是否打断进行中 turn **未验证**（触发路径在 host 侧）。jitter 明确不做（`cron.ts:210` 有意设计，本地产品无全球错峰需求）。

**验证方法**：追踪 automation 触发→prompt 注入路径（automation-port→prompt-turn），确认到期时进行中 turn 是否被打断；写集成测试（cron 到期落在 in-flight turn 中，断言以 later/next 档延迟而非中断）。已空闲延迟→判「已具备」仅补文档；打断→立修正项。

### D7（非目标登记）fork / team / coordinator / ScheduleWakeup / Dream

均不进本路线：fork 与 team 无产品需求方且成本高（上下文转移 + cache 共享）；coordinator 入口在 zoode 侧即为推测项；ScheduleWakeup 与 Dream 依赖的机制已被现有通知/记忆体系替代或依赖 fork。登记为**长期可选**，触发条件：出现明确产品需求方（如多会话协作、记忆后台整合）时重评。

---

## 4. 系统提示词主线升级方案（P1–P7）

### P1（P0）指导段恢复与承载层去重审查

**现状**：`dynamic-sections.ts:48-66` 中 Agent 使用指导段与 AskUserQuestion 段**整段注释停用**，指导仅存于 Agent 工具描述（`agent.ts:102-125`）；且注释原文与工具描述内容**部分重叠**。workflow-actor 提示词缺 escalate 通道说明（driver 四时序含 escalate 但 actor 不知情）。

**推荐方案**：

1. 恢复注释段时做**去重审查**，分层规则写入 spec：**工具描述 = how to call（单工具调用细节）；system 段 = 跨工具工作策略**（何时派 Explore、广度探索超过 3 次查询判据、委派后不重复搜索）。两处重叠文本删其一。
2. 同批补 `sections/workflow-actor.ts` 的 escalate 通道说明段。
3. 文本以 **ACode 自有注释原文为底稿改写**（合规：非 zoode 产物）。

**验收**：AskUserQuestion/Agent 在工具面时对应指导段出现、不在时消失（条件组装测试）；与 `agent.ts` 描述无重复句子（人工审查记录进 spec）。

### P2（P1）动态段注册表 + 组装管线升级

**现状**：`builder.ts` 为硬编码调用序列；上游为「静态 section 数组 + 条件旗标段 + 命名动态段注册表（统一 await 解析、可排除落盘）+ null 过滤」，与 ACode section+cacheHint 架构同构，增量集中在注册表与条件组装（zoode 侧 F-6）。

**推荐方案**：

1. 注册表化：`SectionDescriptor { id, source, group(stable|dynamic|meta_user), cacheHint, enabled(ctx), build(ctx)（支持 async，统一 await 解析）, persistable }`。
2. 子代理路径**保留独立组装与独立 cache breakpoint**（刻意设计不动），但共享 descriptor 基础设施；公共段引用同一实例，消除双路径重复维护（薄弱点 14）。
3. 条件旗标 = 本地 env/config 开关（`ACODE_` 前缀须先在 spec 定义，遵守 CLI 纪律）；**不打 applied 遥测**（no-telemetry 红线），仅 debug 级本地日志。
4. 三选一身份互斥硬失败（`builder.ts:92-97`）语义保持不变。
5. 上下文余量倒计时段：登记为可选（ACode 已有 CONTEXT_MANAGEMENT「不必提前收尾」+ rapid-refill 熔断，收益存疑，Phase 3 评估）。

**备选与取舍**：a) 保持硬编码仅补段——短期可行，但版本化（P3）与双路径重复维护无解；b) 引入完整实验平台——否决（非目标 1）。

**影响**：core（`context/builder.ts`、`sections/*`、`subagent/context-builder.ts`）；新 spec `system-prompt-section-registry.md`（主题：段的注册结构、条件组装、cache 分组、互斥通道与版本清单）。

**验收**：全旗标组合组装快照；ephemeral cacheControl breakpoint 位置断言（≤3 system block 语义不变）；注册表段 id 全量出现在 manifest；typecheck + lint。

**测试**：快照矩阵 + cache breakpoint 断言 + 互斥硬失败回归 + 子代理/主路径共享段一致性测试。

### P3（P1）提示词版本化清单 + parity 校验流程

**现状**：提示词文本分散至少 9 个文件（identity、dynamic-sections、workflow-actor、subagent/system-prompt、general-purpose、explore、runtime-reminders、compact/prompt、incoming-message），无统一版本号或清单机制。

**推荐方案**：

1. 构建期生成 **prompt-manifest**（段 id / 版本 / hash / 归属文件），manifest hash 进 debug 日志（不外发）。
2. **parity 校验** = 可重复脚本：提取 ACode 段清单 + hash，对照 repo 内基线清单（基线只含**机制对照项名称**，不含任何 zoode 文本），输出差异报告供人工判定。
3. CI 只做「manifest 与代码一致」硬校验；parity 差异**不阻断** CI（控制快照维护成本）。

**合规要点**：parity 基线文件本身不得包含逆向原文。

### P4（P2，决策型）i18n 消费策略

**判断**：上游全英文提示词是**有意设计**（指令遵循一致性、cache 前缀命中、多语快照维护成本），非缺口。ACode 现状：`language` 透传但无消费点，属「悬空配置」而非「缺失功能」。

**推荐方案**：a) 将「模型面提示词恒英文、UI 面文案走 i18n」写为决策 spec `prompt-language-policy.md`；`language` 字段保留但在 context types 处加注释说明当前无提示词消费方（或删除误导性透传——实施时二选一）。b) 顺带把 `userVisibleMessage` 等 UI 可见文案接入 i18n（zh-CN 优先）。c) 提示词双语化——**否决**（翻译漂移 + cache 前缀分裂 + parity 成本翻倍）。

### P5（评估项→已立项）延迟工具 ToolSearch

**推荐**：**先测量后立项**。Phase 0 加本地 debug 度量（tools schema token 占比、MCP-heavy 会话分布）；判据 = 占比 >15% 才立项。立项后三件套（reminder 名单 / 按需取回 / discovered-set 由消息历史推导）须评估与 ephemeral cache 的交互——工具面变化会 bust cache 前缀，收益可能被 cache miss 抵消。本文档只给判据与草图，不承诺实施。

> **立项决策记录（2026-09-29，Phase 0 度量闭环）**：度量点已按
> [`specs/tools-schema-token-metrics.md`](../apps/acode-cli/specs/tools-schema-token-metrics.md)
> 落地（R1 工具面度量 + R2 占比判据字段 `toolSchemaRatioPercent`）。按该 spec R3 操作手册
> 实测稳态占比 **19.4% > 15%** → 判据成立，**ToolSearch 立项**。
> **立项 ≠ 立即实施**：实施仍排 Phase 3，须另立 spec 并先评估 ephemeral cache 交互
> （工具面变化 bust cache 前缀，收益可能被 cache miss 抵消）；`reminder-extensions.md`
> 登记的「延迟工具名单提醒」随之纳入立项范围。**数字来源据实登记**：19.4% 转录自
> 2026-09-29 实施轮的度量记录（当日盘点报告 p5Decision 字段）；debug 级度量生产默认
> 不落盘，原始日志行未留存仓内，复测按 R3 操作手册执行。决策记录的规范副本在
> tools-schema-token-metrics.md「立项决策记录」节。

### P6（P1）memory 守则 + env 段补齐

**推荐方案**：

1. `sections/memory.ts` 补 5 段保存守则（全部**机制提炼自撰**）：先查重后更新而非新建；frontmatter 规范（name/description/type）；正文互链；写后加索引行；不匹配的链接也可标记待写。补「记忆 = 待核实快照」定性与好记忆三特征（applicable / durable / legible）。
2. `sections/env-info.ts` 补 Node version、OS 明细、not-a-git-repo 显式指令段（对齐子代理侧 `system-prompt.ts:29-37` 已有的更全格式）。

**验收**：段落条件出现（非 git 目录时才有 not-a-git 段）；快照测试。

### P7（P2）reminder 承载类型扩展

**推荐方案**：借 `runtime-reminders.ts` 每 5 turn 载体新增：TodoWrite 久未使用提醒（有 pending 且 N turn 未更新——**措辞勘误（2026-09-29）**：「有 pending」按 [`reminder-extensions.md`](../apps/acode-cli/specs/reminder-extensions.md) R1 条件 5 读作**存在未完成项**，即 `status ∈ {pending, in_progress}` 双状态门槛；实现与该口径一致，非缺陷）；召回记忆提醒（随 P6，「背景上下文非指令 + 须核实现存性」定性）。

**治理约束**：每个新注入点必须归入 `source.ts` 三来源分类；若产生新 persisted source，须同步 `packages/shared` v4 schema（跨包公开入口纪律）并跑双链路回放验证。

---

## 5. Spec 清单与 spec-first 流程

**新增 spec**：计划 6 篇（`apps/acode-cli/specs/`，Phase 0 完成起草）；**实际产出 11 篇**——除计划 6 篇外，执行中据实追加 5 篇（D3 修正项 2 篇、P5 Phase 0 度量、D5、P7 各 1 篇）。「6 篇」是计划口径，2026-09-29 盘点按实际产出更正：

| spec（计划 6 篇） | 主题 | 服务项 |
| --- | --- | --- |
| `dispatch-discipline-prompt.md` | 子代理派发纪律的承载层与随工具集条件组装规则 | D1 |
| `system-prompt-section-registry.md` | 段的注册结构、条件组装、cache 分组、互斥通道与版本清单 | P1/P2/P3 |
| `workflow-budget-fuses.md` | workflow 预算硬顶、总数保险丝与 resume 预算继承 | D2 |
| `command-terminal-state-audit.md` | 命令与子代理终态语义的完整闭合清单（含追加小节 §A/§B/§C） | D3 |
| `prompt-language-policy.md` | 模型面提示词恒英文、UI 面文案走 i18n 的决策记录 | P4 |
| `todo-dependency-fields.md` | todo 依赖字段语义、环检测与向后兼容 | D4 |

| spec（执行中追加 5 篇） | 主题 | 服务项 |
| --- | --- | --- |
| `tools-schema-token-metrics.md` | tools schema token 占比的 debug 级本地度量（含 2026-09-29 立项决策记录） | P5 Phase 0 度量 |
| `reminder-extensions.md` | TodoWrite 久未使用提醒门槛 + 召回记忆提醒 | P7 |
| `concurrency-diagnostics-projection.md` | 并发治理面只读诊断投影 | D5 |
| `subagent-terminal-first-wins.md` | runtime task registry 的终态不可覆盖约定 | D3 修正项 #3 |
| `subagent-maxturns-policy.md` | 悬空 `maxTurns` 配置删除（2026-09-29 补登，spec-first 顺序倒置已在该 spec 据实登记） | D3 修正项 #1 |

**既有 7 篇关联**：权限相关改动受 `managed-policy-floor-and-bypass-immune-breakers` / `project-permission-restrictive-floor` / `subagent-policy-floor-inheritance` / `subprocess-env-credential-allowlist` 四篇约束；`no-telemetry` 为红线（P2 旗标、P3 manifest 均不得外发）；`plugin-git-source-pinning` 与本方案无交集。

**执行规则**：先 spec 后码（根 AGENTS.md 核心原则）——每项实施 PR 必须引用对应 spec；spec 未合入前不写实现。

---

## 6. 分阶段落地路线

### Phase 0 —— spec + 审计 + 度量（约 1 周）｜**已实施（2026-09-29）**

- 起草上表新 spec（清单见 §5：计划 6 篇，执行实际产出 11 篇）。
- 执行 D3 审计（三问）、D6 验证（cron 空闲触发集成测试）、A9 两项待验证（脚本确定性约束现状 / 中断输出围栏等价物）、P5 度量点铺设。
- **产出**：审计结论回写对应 spec；本文档第 8 章「待验证假设清单」据实更新。D3/D6 必须在 Phase 0 闭环，否则 D2/D6 的验收标准可能调整。
- **完成情况（2026-09-29）**：11 篇 spec 在仓（§5）；审计结论已回写（`command-terminal-state-audit.md` 审计结论区 + 追加小节 §A/§B/§C + 修正项登记 #1–#8）；§8.2 已据实回填——**#1（D6）/#2（D3 maxTurns）/#4（脚本确定性）/#5（中断输出围栏）闭环**，**#3（barrier 对照）/#6（注入防御对照）仍待验证**，#7/#8 为审计新增且仍待验证；D3/D6 均已闭环，**D2 的验收标准未因之调整**（D2 按原验收实施并通过）。P5 度量点已铺设且判据已实测立项（§4 P5、§8.2 抬头）。

### Phase 1 —— P0 提示词层（约 1–2 周）｜**已实施（2026-09-29）**

- 范围：D1（纪律节 + 去烘焙）+ P1（指导段恢复去重 + escalate 段）+ P6（memory/env 补齐）。
- 改动集中在 4 个文件（`dynamic-sections.ts` / `tool/handlers/agent.ts` / `sections/memory.ts` / `sections/env-info.ts`）+ `tool/registry.ts` 装配点 + 快照测试；**纯提示词/描述层，不动调度运行时**，风险最小。
- 验收：快照矩阵 + 灰度组合回归 + `pnpm typecheck` + `pnpm lint` + `pnpm --dir apps/acode-cli typecheck|lint`。
- 双链路验证点：task-notification 回放分类不变；reminder 注入不破坏 turn 序。
- **完成情况（2026-09-29）**：D1 / P1 / P6 全部落地，仍属提示词/描述层、未动调度运行时。**落地偏差**：P1 第 2 点的 escalate 段使 `sections/workflow-actor.ts` 成为第 5 个提示词文件（上文「4 个文件」估算未含它）；descriptor 登记另触及 P2 的 `registry-main.ts`。验收命令的实际执行结果见 §11.1——其中 `pnpm --dir apps/acode-cli typecheck|lint` 因 turbo 不在 PATH 改用仓库根 `tsc -p apps/acode-cli/packages/<包名>/tsconfig.json --noEmit`（见本章「命令口径修正」）。

### Phase 2 —— P1 运行时（约 2–4 周）｜**已实施（2026-09-29）**

- 范围：D2（总数 + 条目数保险丝先行）+ P2（注册表化）+ P3（manifest/parity 脚本）+ D3 修正项（若审计发现）。
- 验收：engine 结算单测 / resume 集成测试 / 组装快照 / cache breakpoint 断言 / **CommandInbox 不变量测试套件全绿**（锁序、settle 前不放行、CAS、admissionSeq——任何触碰队列的改动必跑）。
- 双链路验证点：desktop-continuous（后台完成→父队列直写→mid-turn 吸收路径不变）；web-remote-replayable（cold-session-resume / replay 三段归约对新增字段与新 reminder source 分类正确）。
- **完成情况（2026-09-29）**：D2（agent 总数上限 + 单次条目数显式报错，**token 预算硬顶同批落地、未拆到 Phase 3**）/ P2 注册表化 / P3 manifest + parity 脚本 / D3 修正项 **#1–#7** 全部落地（#8 待产品/host 侧回答，见 §8.2 #7）。原验收假定的「CommandInbox 不变量测试套件」经审计发现全仓为零，已补为 `command-inbox-invariants.test.mjs`（7 例）。不变量复核（本轮只读）：`command-inbox.ts` diff **36 增 0 删且新增行全为注释**（行为零改动）；owner/lease、prompt-admission、runtime-command-queue、`packages/shared/src/acode-protocol-v4` **零 diff**。门禁实际执行结果见 §11.1。

### Phase 3 —— P2 可选（评估后决策）｜**已实施（2026-09-29，P5 ToolSearch 本体除外）**

- 范围：D4（todo 依赖）/ D5（并发投影）/ P4-b（UI 文案 i18n）/ P5（ToolSearch **实施**——立项决策已于 2026-09-29 按 19.4% > 15% 判据做出，见 §4 P5 决策记录；实施前另立 spec 并评估 ephemeral cache 交互）/ P7（reminder 扩展）/ D2 token 预算硬顶 / 上下文余量段评估。
- 各项独立立项，以 Phase 0 度量与 Phase 2 落地经验为决策输入。
- **完成情况（2026-09-29）**：**D4 / D5 / P4（含 P4-b）/ P7 已实施**，D2 token 预算硬顶已在 Phase 2 同批落地（依据见「优先级总览」实施状态列）。两项**未实施**：① **P5 ToolSearch 本体**——度量与立项决策已闭环（19.4% > 15%，决策记录见 §4 P5 与 `tools-schema-token-metrics.md:135-147`），但 discovered-set / reminder 名单 / 按需取回三件套须另立 spec 并先评估 ephemeral cache 交互；② **上下文余量段**——`registry-main.ts:238-240` 留有占位注释（登记 id `budget.context_countdown`、group `system-dynamic`）待评估后落地，本轮 grep 复核确认 MAIN 注册表 16 个段 id 中无该段。

**每阶段统一命令**：`pnpm typecheck`、`pnpm lint`、`pnpm --dir apps/acode-cli typecheck|lint`、`pnpm verify:pre-push`；测试入口以各包 `package.json` 与实际测试文件为准（不假定统一单测命令）。

> **实施时的命令口径修正（2026-09-29）**：`pnpm --dir apps/acode-cli typecheck|lint` 依赖 turbo，**本机 turbo 不在 PATH**，该形式在实施环境不可用（属环境问题，非代码问题）。CLI 各包 typecheck 的等价形式是在**仓库根**运行 `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/<包名>/tsconfig.json --noEmit`；root `pnpm typecheck` 覆盖 `packages/*`（shared/services/ui 等）但**不覆盖** `apps/acode-cli`。CLI 测试约定为 `apps/acode-cli/tests/*.test.mjs`（node:test + assert），在仓库根以 `node --import tsx --test <文件>` 运行（裸 `node --test` 解析不了内部 `.js` → `.ts` 导入）。`apps/acode-cli` 的 **cli 包** typecheck 有既有环境红（`@acode/tui` dist 未构建导致 TS2307），按约定不作门禁；三个已知既有红测试文件（`packages/desktop/tests/no-official-platform.test.mjs`、`packages/ui/tests/no-telemetry.test.mjs`、`packages/ui/test/nonCliAcpRetirement.test.ts`）为基线问题，不修、不计入失败。实际执行的门禁与结果见 §11.1。

**每阶段统一双语义链路验证**：新 reminder source / 新事件字段须同步 `packages/shared` v4 schema（跨包公开入口纪律）；不得把通知当用户输入；不改 owner/lease 与 admission 不变量。

---

## 7. 合规与非目标

1. **不恢复遥测、不引入服务端 A/B**：上游的旗标体系改造为本地 `ACODE_` 开关且先在 spec 定义；applied 遥测一律不做（[`specs/no-telemetry.md`](../apps/acode-cli/specs/no-telemetry.md)）。
2. **不复制 zoode 逆向原文**：所有提示词文本基于机制提炼**自撰**，或以 ACode 自有注释原文为底稿改写；不引用 mangled 标识符作为 API；zoode 还原产物禁止再分发。
3. **安全 P0–P2 议题不在本文范围**：引用 zoode 工作区既有《ACode-提升方案.md》（2026-09-27）与 [`security-hardening-plan.md`](security-hardening-plan.md) / [`security-hardening-handoff.md`](security-hardening-handoff.md)，不重写。
4. **不做 team / coordinator / fork / ScheduleWakeup / Dream 产品面**：登记长期可选 + 触发条件（D7）。
5. **不破坏既有不变量**：CommandInbox admission、owner/lease 路由、stale run 防护、双语义链路语义；不新增第二条写入路径；不用超时掩盖同步问题。
6. **遗留登记（2026-09-29 独立评审，backlog 不随本方案实施）**：`core/src/runtime/helpers/runtime-reminders.ts` 的 `TODO_STALE_REMINDER_TEXT`（TodoWrite 久未使用提醒文案）为**基线既有**的第三方产品逐字文案（经 `git show` 核实在基线 HEAD 即逐字存在；本轮 P7 仅将其提取为命名常量并加未完成项门槛，文本零改动，不构成本轮新增照搬）。第 2 条红线对本轮新增文本已全部满足；该存量文案的自撰改写**另立项处理**——改写会变更模型已熟悉的提醒措辞，需单独评估行为影响，不并入本方案。

---

## 8. 待验证假设清单

### 8.1 zoode 侧推测项（一律不作为本方案设计依据）

| 假设 | 置信度 | 处置 |
| --- | --- | --- |
| 上游「剩余深度预算」函数语义（fan-out 门控依据） | 中 | 不采用——ACode 硬深度 1 更严格（A3 判已具备） |
| coordinator 模式的产品入口 | 中 | 不采用——A1 仅借鉴「派发者只读纪律」思想 |
| mangled 占位符→工具名映射 | 中高 | 仅作来源定位辅助，文档与代码不引用 |
| 上游服务端实验段的实际放量 | 不可知 | 不采用——B1 旗标体系按本地开关设计 |

### 8.2 本次新增待验证项（Phase 0 闭环，各附验证方法）

> **状态标注口径（2026-09-29 回填）**：**已验证** = 只读核对 / 集成测试取证完成且结论已落仓；**已修正** = 结论触发的产品代码修正项已落地；**仍待验证** = 未闭环（缺证据，或缺产品/host 侧决策）。
>
> 当前分布：**#1（D6 cron 空闲触发）已验证** · **#2（D3 subagent maxTurns）已修正** · **#4（workflow 脚本确定性约束）已验证** · **#5（中断输出围栏回灌等价物）已验证**；**#3 / #6 / #7 / #8 仍待验证**——#7/#8 为 D3 审计新增，卡点分别是产品/host 侧意图确认与一次并发运行时复现；#3/#6 是 Phase 0 两项上游对照的结论未落任何仓内文件。§8.1 的 zoode 侧推测项处置不变（一律不作本方案设计依据）。
>
> **P5 度量与立项决策（不属本表项，登记于此便于检索）**：度量点已铺设、判据已按 R3 操作手册实测并**立项**（详见 §4 P5 决策记录）；规范副本在 [`specs/tools-schema-token-metrics.md`](../apps/acode-cli/specs/tools-schema-token-metrics.md)「立项决策记录（2026-09-29）」节（2026-09-29 复核：该 spec 第 135-147 行含 19.4% 与数字来源登记）。**「19.4%」无法从当前工作区复核**——R1 度量是 debug 级、生产不落盘，原始日志行未留存仓内，全仓 grep 亦无第二处独立来源；引用该数字时须标注为**实施轮会话内计算、未经持久化**，复测按 R3 手册执行。spec 明确「判据（15%）与立项决策 = 人的决策，不进代码常量」，故该决策的家是文档面（本方案 §4 P5 + 该 spec），代码内不含 15% / 19.4% 常量。

| # | 待验证项 | 验证方法 | 影响 |
| --- | --- | --- | --- |
| 1 | ~~cron 到期是否打断进行中 turn~~ → **已据 D6 验证据实更新（2026-09-29）**：**不打断，判「已具备」，无修正项**。真实链路（host `dispatchCronRun` → services `sendPromptToAgent` 收敛 v4 sendText → CLI `NATIVE_HANDLERS.sendText` → `startPromptTurn(delivery:"start_turn")` → `admitPrompt`）实测：到期命令落在 busy 会话时走 `enqueueDeferredInput` **延迟入队（queue lane）**——在飞 turn 无 abort/preempt 原样存续，也**不 steer** 进在飞 turn 的内存引导队列（`pendingInputs` 不被注入；对照：用户 auto 车道输入可 steer）；队列提升只在空闲发生（`shouldAutoDrainV4QueueHead` 要求 `!sessionBusy`；`requireIdle` admission 在 busy 时 rejected；idle-only lease 提升沿用原 runId，终态可与派发对账）。Cron 写工具（CronCreate/Update/Delete）进 turn 级 disallowlist 的既有防护同批核实。按 D6 原判据「已空闲延迟 → 判已具备仅补文档」闭环，本行即文档补充。证据：`apps/acode-cli/tests/cron-idle-trigger.test.mjs`（5 例：idle 直启 / in-flight 延迟不打断 / busy 不自动提升双保险 / 空闲提升 / 车道对照；host 侧不在 CLI 测试进程内，以 host cron 派发同形的 sendText envelope 在协议边界复现） | **已验证 · 已闭环**（结论取代本项；**无产品代码修正**——2026-09-29 复核 `git status` 无 cron.ts / prompt-turn.ts / steering.ts / queue-auto-drain.ts 等任何相关产品文件改动，与实施轮自报一致。**本轮未复跑该测试**，结论摘自测试文件头与用例名） |
| 2 | ~~subagent maxTurns 到顶终态是否误报 completed~~ → **已据 D3 审计据实更新（2026-09-29）**：原问法前提不成立。主/子代理 turn loop 对 `maxTurns` **零引用**（`turn-loop.ts:47,215` 是无条件 `while(true)`，`agent-runtime.ts` 全文无命中），不存在「到顶」，故不存在「到顶误报 completed」；`completed` 由 `runner.ts:1170-1171` 写出，但触发它的是 child 自然收尾（`turn-stop.ts:236`），按 spec R1 判定口径**不构成误报**。真缺口有两条：(a) `maxTurns` 是**悬空配置且带用户可写面**——agent frontmatter 可写、services 双向序列化、设置页原样带回、还有两条无消费点的 i18n 文案，值一路透传到 child runtime 边界（实测桩件收到 `maxTurns: 2`）后无人读取；(b) 唯一真实强制点 `memory-agent-loop.ts:58` 到顶后返回值只有 `{messages,turns}`、无截断标记，调用方 `project-memory-extraction.ts:163-164` 无条件报 `success`，「被 5 轮切断」与「自然收尾」对外同形。→ **D3 修正项 #1（删除悬空字段，与 CLI `AGENTS.md:11` 长程任务优先一致）+ #2（memory 抽取到顶可区分）**；证据见 `apps/acode-cli/specs/command-terminal-state-audit.md` 结论区问题 1，测试 `apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs`（8 例全绿） | **已修正 · 已闭环**（结论取代本项；修正项 #1 悬空 `maxTurns` 已全链删除、#2 memory 抽取到顶已可区分。**2026-09-29 复核**：全仓 `*.ts`/`*.tsx` 源码中 `maxTurns` 仅剩 `core/src/memory/memory-agent-loop.ts` 自身入参与截断标记注释（另有 `packages/core/dist/*.d.ts` 陈旧构建产物命中，非源码），与 spec R4 一致；spec 落点 `subagent-maxturns-policy.md`（149 行）已建，`command-terminal-state-audit.md` §A 已回填。**本轮未复跑测试**） |
| 3 | parallel()/pipeline() barrier 语义与上游对照 | Phase 0 读 `engine/` 源码核对 | **仍待验证（未闭环）**：2026-09-29 文档同步轮复核 `grep -rln "barrier" apps/acode-cli/specs/ apps/acode-cli/tests/` **零命中**——D2 已实施，但该对照结论未落任何仓内文件。D2 的单次条目数上限按「显式报错而非静默截断」独立定值（`maxPendingAsks`，定值依据见 `workflow-budget-fuses.md`「常量定值记录」），并未以本项对照为前置；本项保留为 D2 后续调参时的校准输入 |
| 4 | ~~workflow 脚本确定性约束现状（非确定性时间/随机源）~~ → **已据 A9 核对该实更新（2026-09-29）**：现状 = 「**运行期禁令 + resume 比对门**，无编译期确定性约束」，三层事实：(a) 编译层——`Date.now()` / `Math.random()` / 无参 `new Date()` **零诊断通过**（`child-source.ts` 自称「编译诊断是 suspenders」，对这三个源不成立；对照：同一套编译环境确实拒 `process`——纯度契约在编译期是真的，只是不含时钟/随机）。(b) 运行层——沙箱 BOOTSTRAP 的三个禁令**确实生效**（违规 run 以 errored 结算、错误文本即禁令文本），且刻意留住确定性的 Date 面（`new Date(ms)` / `Date.parse` / `Date.UTC`）。(c) resume 层——`script_text` 门是**逐字节**的（scriptHash 不符构造期同步抛，检测不到语义非确定性）；journal replay 的 inputHash 门按 **(siteId, ordinal) 定位**：值分歧**大声失败**（InputHashMismatch → errored，world-read 同一道门），但站点形状分歧与次数分歧不报错（见下）。**三个真实缺口的处置登记**（现状全部由测试钉住，断言的是实际行为不是期望行为）：**① 沙箱禁令可绕**（原型链上溯 `Object.getPrototypeOf(Date).now()` 拿到真时钟、hand-written lowered 体直接用 `__NativeDate`，绕过后 run 照常 completed）→ **不立修正项**：禁令定位是防误用的 suspenders 而非安全边界（脚本由受信 agent 撰写，恶意绕过不在威胁模型），且 `__NativeDate` 是 `__WorkflowDate` 的实现依赖——删掉它就删掉了 (b) 刻意保留的确定性 Date 面；resume 的真一致性闸门是 inputHash 门（值分歧大声失败）。绕过面已由测试 C1–C3 钉死防扩大；未来若做加固（冻结原型链/收走 `__NativeDate`）另立项走 spec。**② 站点形状分歧 → live ask 永久停驻**（同一 actor 在 journal 有记录行、第二世改走另一 ask 站点：hold 规则等 `nextAdmitSeq >= recordedCount` 而记录节点永不释放——无报错、无超时、无 run-stalled 事件（stall 时钟要先见过一次 model_retry_scheduled 才上膛，`workflow-driver-concurrency.ts:311-315`），run 停在 running；显式 stop 可把 run 结算为 stopped 但解不开停驻的 ask，harness 随后 kill 子进程）→ **登记长期观察项，暂不立修正项**：触发前提是脚本非确定性（缺口 ①；纯 replay 下 ask/world-read 的答复都从 journal 逐字重放，形状不会分歧——对照 D3b：换新 actor 走分歧分支即不停驻）；有人工 stop 出口，缺的是自动可观测性；补自动超时与「不用超时掩盖同步问题」纪律相抵。生产出现真实停驻即重评立项（候选方向：parked live 节点的诊断事件，或 resume 时对 recordedCount 做一致性预检）。**③ 次数分歧 → 前缀静默复用、超出部分静默转 live**（回环多跑一圈：第 1 圈命中 journal 零派发，第 2、3 圈 live 派发，run 照常 completed，只花钱不报错）→ **不另立修正项**：「超出转 live」本身是回环 resume 的正常语义；其失控烧钱面正是 D2 的输入，已由 [`workflow-budget-fuses.md`](../apps/acode-cli/specs/workflow-budget-fuses.md) 的三道保险丝兜住（agent 总量 / fan-out 宽度 / token 硬顶，R2–R4 已落地，含 resume/amend 预算继承的防刷新论证）。证据：`apps/acode-cli/tests/workflow-script-determinism.test.mjs`（18 例：A1–A3 编译层 / B1–B4 运行层 / C1–C3 绕过面 / D1–D7 resume 门） | **已验证 · 已闭环**（结论 + 处置登记取代本项。三处真实缺口的处置均已在左栏登记：① 沙箱禁令可绕 → 不立修正项，绕过面由测试 C1–C3 钉死防扩大；② 站点形状分歧致 live ask 永久停驻 → 长期观察项，生产出现真实停驻即重评立项；③ 次数分歧静默转 live → 由 D2 三道保险丝兜住，D2 已于 2026-09-29 实施。**本轮未复跑测试**，结论摘自测试文件头与用例名） |
| 5 | ~~中断输出围栏回灌等价物~~ → **已据 A9 核对该实更新（2026-09-29）**：**等价机制存在且是两条，判「已具备」，A9 不补项**——但形态与「围栏」不同：① **turn 路径**（输出被 output token 上限截断）：截断的 partial assistant 文本作为**普通 assistant 条目**原样回灌进 canonical history 与本轮 request entries（`turn-model-step.ts:721` 调用 → `turn-output-token-continuation.ts:108` commitAssistantToTurnRequest，行号 2026-09-29 复核），随后追加一条 user 条目 `OUTPUT_TOKEN_CONTINUE_PROMPT`（`turn-output-token-continuation.ts:12-13,139-142`，要求「直接续写、不道歉、不复述、从被切断的那半句接上」）；**截断处不带任何标记**（无 [truncated]、无 XML 界定，模型只能从「消息到此为止 + 紧跟续写指令」推断）；指令条目是 query-scoped（`message-history.ts:56`），**跨 compact / 跨冷恢复不保留**而 partial 文本保留；续写上限 3 次（MAX_OUTPUT_TOKEN_CONTINUATIONS），耗尽转可恢复 ModelError。② **compact 路径**：**有围栏形态**——摘要生成被 `<analysis>` / `<summary>` 标签界定（BASE_COMPACT_PROMPT，且要求逐字引用「你正在做什么、停在哪里」），回灌前 formatCompactSummary 剥掉 analysis、把 summary 解围成 "Summary:" 段（`compact/prompt.ts:119-131`），再套「本会话从上一段对话继续」框（:142-144）与「Resume directly — do not acknowledge / do not recap / pick up as if the break never happened」指示（:159-162）。③ **用户取消（Esc）路径**：partial 同样被持久化并回灌进 live history（`turn-model-step.ts:372-393` + `cancelled-stream-persistence.ts`），但**不追加任何续写指示**（turn 已结束）、不带截断标记——此条不在测试断言范围（需要整套 runtime），据实记录为结论。证据：`apps/acode-cli/tests/interrupted-output-continuation.test.mjs`（12 例：触发面 / 决策表 / partial 回灌无标记 / 续写指示 / 脚手架不外泄 / 计数复位 / compact 围栏与解围 / 手动 compact 形态 / 逃生舱字段） | **已验证 · 已闭环**（结论取代本项；判「**已具备**」，A9 不补项——等价机制存在且为两条：turn 路径无围栏标记、compact 路径有 XML 围栏形态；用户取消（Esc）路径据实记录为不在测试断言范围。**本轮未复跑测试**，结论摘自测试文件头） |
| 6 | 上游 2.1.283 注入防御加厚点清单 | 实施 P1/P2 时核对（仅机制层面，不复制文本） | **仍待验证（未闭环）**：P1/P2 已于 2026-09-29 实施，但本项对照结论未见记录——复核 `grep -rln "注入防御" apps/acode-cli/specs/ docs/` 仅命中本文档 2 处（§2.2 B5 行与本行），11 篇新 spec 中无该对照登记。合规约束不变（仅机制层面、不复制文本）。保留为后续提示词改版的对照输入 |
| 7 | `CommandInboxHost.guard` 是有意预留还是遗漏接线（D3 审计新增） | 代码侧已判**不可达**：`CommandInbox` 全仓只在 `v4-gateway.ts:632-657` 构造一次，该宿主不提供 `guard`，于是 `command-inbox.ts:394` 恒回落 `{verdict:"allow"}`，业务 guard 的三条分支（含唯一 `remember:true` 的 `noop`，`:423-435`）在生产永不执行。三条分支本身正确（D3 测试装上桩 guard 后实测各自可达、语义正确）。需要 host/产品侧回答：是否有 product-protocol guard id 本该由它承载 | **仍待验证**（需 host/产品侧回答意图，代码侧无法判定；判定前不动代码）——决定 D3 修正项 #8 是「接线」还是「删除死扩展点」。注：编号相近但无关的 D3 修正项 **#7**（CommandInbox 不变量套件仓内不存在）已于 2026-09-29 落地为 `apps/acode-cli/tests/command-inbox-invariants.test.mjs`（7 例：锁序 / settle 前不放行 / CAS / admissionSeq / 三态分离含 >512 churn） |
| 8 | 子代理 cancel/complete 的**并发**覆盖是否真的在线上发生过（D3 审计新增） | D3 已确认**不变量缺失**（**审计时状态；修正项 #3 已于 2026-09-29 落地**，见右栏）：`InMemoryRuntimeTaskRegistry.update()`（`registry.ts:132-143`）无终态守卫、可双向覆盖终态；三处 finalize 路径（`runner.ts:1501-1502→1504→1519`、`:1580-1581→1589→1600`、`:1667-1668→1701→1702`）的守卫与写入之间都夹着真实文件 I/O（`mkdir`+`writeFile`）。两个**串行**方向实测正确。缺的是一次并发运行时复现（两条 finalize 的 I/O 交错），D3 未做 | **仍待验证**（并发运行时复现未做，本轮亦未复跑）+ **更新（2026-09-29）**：修正项 #3 已落地——`runtime-task/registry.ts:133-173` 的 `update()` 增终态 **first-wins** 守卫（拒「终态 → 另一终态」并返回赢家快照 `current`）+ 约定注释对齐 `dynamic-workflow/src/engine/engine-settlement.ts:7`，spec `subagent-terminal-first-wins.md`（227 行）与测试 `subagent-terminal-first-wins.test.mjs` 均在仓。因此本项不再影响 #3 成立，只剩「是否已有用户可见的错误终态」的严重度定级未闭环 |

---

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| **版本漂移**：zoode 快照（2.1.283）与 ACode `file:line`（7578e1e）均会漂移 | 头部基线声明；P3 prompt-manifest 机制化段版本；实施前复核行号 |
| **强断言未经对抗复核**：zoode 侧调度事实为产物确认但未经怀疑者核查（安全六维除外） | D2/D3 实施前对上游机制做二次代码级核对；本文所有此类引用仅作为「设计输入」而非「事实断言」 |
| **提示词 cache 前缀分裂**：注册表化/条件段可能改变 stable 前缀 | P2 验收含 cacheHint 分组断言与 breakpoint 位置断言（≤3 system block 语义不变） |
| **快照测试维护成本**：提示词快照易碎 | parity 差异不阻断 CI（P3）；快照矩阵按旗标组合最小化 |
| **双工作流体系并存**：旧 WorkflowGraphScheduler 与 dynamic-workflow 各自独立 | 本方案只动 dynamic-workflow；旧图调度不扩权、不新增能力；两者收敛为独立议题不在本文范围 |
| **承载层重复回归**：指导段恢复后与工具描述再次漂移 | P1 分层规则写入 spec（工具描述 = how to call；system 段 = 跨工具策略）；去重审查记录进 spec |

---

## 10. 附录

### 10.1 prompt-manifest 结构示例（P3 草图）

```jsonc
{
  "version": 1,
  "generatedAt": "<build-time>",
  "sections": [
    {
      "id": "identity.default",
      "group": "system-stable",
      "cacheHint": "stable",
      "owner": "apps/acode-cli/packages/core/src/context/sections/identity.ts",
      "hash": "<sha256-of-normalized-text>"
    }
    // ... 每个注册段一条
  ]
}
```

### 10.2 parity 脚本输入输出约定（P3 草图）

- **输入**：当前构建的 prompt-manifest + repo 内基线清单（`parity-baseline.json`，只含机制对照项名称与期望段 id，**不含任何 zoode 文本**）。
- **输出**：差异报告（新增段 / 缺失段 / hash 变化段），供人工判定是否为有意变更。
- **CI 策略**：「manifest 与代码一致」为硬校验（阻断）；parity 差异仅报告（不阻断）。

### 10.3 术语表

| 术语 | 含义 |
| --- | --- |
| fold / steering | 把排队命令折叠进已在飞的 turn（运行中注入），ACode 等价物为 mid-turn 命令吸收 |
| admission | 输入准入：决定立即执行、转向（steer）还是排队（deferred）的串行化入口 |
| CommandInbox | v4 协议层每会话命令收件箱：锁序、三态分离、幂等结算（`bootstrap/src/acode-protocol-v4/command-inbox.ts`） |
| lease | 前台提升租约：进程内有效，释放时须主动恢复队列 drain |
| 双语义链路 | `desktop-continuous`（实时连续）与 `web-remote-replayable`（可回放恢复）两种客户端语义，改队列/流/重连必须同时验证 |
| ephemeral cacheControl | provider 提示词缓存断点标记；ACode 最多 3 个 system block 全带 ephemeral |
| SectionDescriptor | P2 引入的段注册结构：id/group/cacheHint/enabled/build/persistable |
| prompt-manifest | P3 引入的构建期段清单：段 id/版本/hash/归属文件 |
| parity 校验 | ACode 段清单与机制基线清单的可重复对照流程（不含逆向原文） |
| 保险丝（fuse） | 失控保护硬上限：超限显式失败而非静默降级（D2） |

---

## 11. 实施记录（2026-09-29，改动未提交）

> 本章为**状态同步**，不改写前 10 章的设计内容。结论有两类来源，逐处标注：**「记录」**= 实施轮 / 独立评审轮的书面结论（本次文档同步轮**未复跑**，属转录）；**「本轮复核」**= 2026-09-29 文档同步轮对工作区执行的只读命令（`git status` / `git diff` / `grep` / `ls` / `wc`，清单见 §11.3）。

### 11.1 门禁结果（转录自实施轮与独立评审轮，本次同步未复跑）

**实施首轮记录：全仓门禁全绿** —— CLI 5 包 `tsc`、CLI 测试全量、root `pnpm typecheck`、root `pnpm lint`、`pnpm architecture:check`。

**D3 审计轮（Phase 0）记录 E1** —— 规范副本在 [`specs/command-terminal-state-audit.md`](../apps/acode-cli/specs/command-terminal-state-audit.md)「E1 执行记录」（:275-295 命令表、:297-312 未执行项）：4 个新增审计测试合跑 **40 tests / 40 pass / 0 fail**（`subagent-maxturns-dangling` 8 + `command-inbox-discard-terminal-state` 15 + `subagent-terminal-race-ordering` 8 + `subagent-completion-notification-summary` 9）；8 个既有 CLI 测试文件回归 **62 / 62 / 0**；`pnpm lint` → `Found 76 warnings and 0 errors.`（= 基线）；`pnpm architecture:check -- --changed` → violations 0 / baseline 0 / new 0；`pnpm typecheck` exit 0。该轮据实登记的未执行项（turbo 缺失致 `pnpm --dir apps/acode-cli` 不可用、cli 包既有环境红、三个既有红测试文件未运行、dynamic-workflow(-runtime) 未单独 typecheck、验收场景 5 的不变量套件当时仓内不存在、验收场景 6 双链路未做端到端）见 spec :297-312——其中「不变量套件不存在」已由修正项 #7 补为 `command-inbox-invariants.test.mjs`。

**独立评审轮（只读评审）实际执行的命令与结果**（均从仓库根执行）：

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test apps/acode-cli/tests/*.test.mjs` | exit 0，**304 tests / 304 pass / 0 fail**（含 21 个新测试文件） |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | **0 errors / 76 warnings**（= 基线水位） |
| `pnpm architecture:check -- --changed` | OK，violations 0 / baseline 0 / new 0 |
| `tsc --noEmit` 六包（contracts / core / adapters / dynamic-workflow / dynamic-workflow-runtime / bootstrap） | 全部 exit 0 |
| `node --import tsx apps/acode-cli/scripts/generate-prompt-manifest.mjs --check` | exit 0（6 sections） |
| `node --import tsx apps/acode-cli/scripts/check-prompt-parity.mjs` | exit 0（三类差异均 0） |

**未执行 / 不计门禁（据实登记，理由见 §6 命令口径修正）**：

- `apps/acode-cli` 的 **cli 包** typecheck —— 既有环境红（`@acode/tui` dist 未构建 → TS2307），按约定不作门禁。
- 三个已知既有红测试文件（`packages/desktop/tests/no-official-platform.test.mjs`、`packages/ui/tests/no-telemetry.test.mjs`、`packages/ui/test/nonCliAcpRetirement.test.ts`）—— 基线问题，不修、不计入本次失败。
- 双链路（`desktop-continuous` / `web-remote-replayable`）**端到端**运行 —— 未做；双语义验证以测试内的分类断言与投影核实承载（见 §11.2「双语义链路」）。
- P5 的 **19.4%** —— 无法从工作区复核（debug 级度量生产不落盘、原始日志未留存仓内），登记见 §8.2 抬头与 §4 P5 决策记录。

### 11.2 独立评审结论（只读评审，未修改任何仓库文件）

**总体结论**：本轮未提交改动（65 个修改文件 + 约 40 个新增文件，基线 HEAD `7578e1e`）与本方案及 11 篇新 spec **高度一致**，实现质量与 spec-first 纪律执行良好；所有实际执行的门禁全绿，**未发现 high 级问题**。findings **4 条，其中 high 0**（各条 finding 正文未随本次文档同步材料提供，故本文不予转录、也不推测其内容）。评审分项结论：

- **合规红线**：diff 新增行与全部新文件对 fetch/http/OTLP/exporter/telemetry 类网络原语**零命中**（grep 扫描；registry / diagnostics / metric 三处另有测试级红线断言）；对 `C:\Users`、`/Users/`、用户名**零命中**（diff、11 篇 spec、本方案、tests、scripts、`parity-baseline.json` 全扫）；新增 `ACODE_` 环境变量恰为 spec R3 定义的两个诊断旗标（`ACODE_PROMPT_SECTIONS_DISABLED` / `ACODE_PROMPT_MANIFEST_TRACE`），实现与 spec 的解析 / 默认值 / 错误行为逐条相符；新增提示词文本（Delegating work 六条、memory 三特征 + 快照定性、`memory_recall`、not-a-git 段、escalate 扩写）为**机制级自撰**，`parity-baseline.json` 只含段 id + 中文机制名并有形状校验断言（拒绝长编码载荷）。
- **不变量**：`command-inbox.ts` diff 为**纯注释**（§B 约定文字，行为零改动，逐行核实）；owner/lease、prompt-admission、runtime-command-queue、`packages/shared/src/acode-protocol-v4` 均**零 diff**；`assembleSystemMessages` 未触及（≤3 system block + 全 ephemeral cacheControl），三选一身份互斥硬失败消息逐字保留；新增 `command-inbox-invariants.test.mjs` 7 例钉住锁序 / settle 前不放行 / CAS / admissionSeq / 三态分离含 >512 churn（D3 修正项 #7 落地）。
- **治理**：跨包只走公开入口（`BUDGET_CAPS` / `isWorkflowErrorCode` 经 dynamic-workflow index、D5 契约成员经 `@acode/contracts`、TUI 文案经 `@acode/i18n`）；依赖方向合规（core 不 import bootstrap，AIMD 事实经契约可选成员 `concurrencyBuckets`）；日志全走既有 logger 且分级符合根 `AGENTS.md`（§C 命令丢弃 debug→info 附理由注释、事件路径刻意保持 debug）；`memory_recall` 正确归入 `source.ts` per-request 档、不进任何 persisted / 跨包名单并有双链路断言；根 shared `acodeSessionTodoItemSchema` 加宽最小（仅 3 个可选成员、`.strict()` 保留）；`maxTurns` 删除后全仓 `*.ts` / `*.tsx` 源码仅剩 `memory-agent-loop` 内部参数。
- **双语义链路**：todo 投影改动同验 `desktop-continuous`（session-mapper 场景 5）与 `web-remote-replayable`（tool-plan-adapter/v4 场景 9 + product-projection 核实）；reminder 7a/7b/7c 三例做双链路分类断言；D6 由 `cron-idle-trigger.test.mjs` 5 例闭环。

### 11.3 本次文档同步轮的只读复核（2026-09-29）

**范围**：只改本文件，不重写设计内容、不动任何代码 / spec / 测试；未执行 `git commit` / `push` / `merge`，改动留在工作区。为核对上文状态与「优先级总览」实施状态列的依据，本轮实际执行的只读复核：

| 复核项 | 命令（仓库根） | 结果 |
| --- | --- | --- |
| 新增 spec 篇数 | `git status --porcelain apps/acode-cli/specs/` | **11** 个未跟踪 `.md`，与 §5 两张表逐名相符 |
| 新增测试文件 | `git status --porcelain apps/acode-cli/tests/` | **21** 个未跟踪 `.test.mjs`（含 `cron-idle-trigger` / `command-inbox-invariants` / `subagent-terminal-first-wins` / `stale-branch-terminal-observability` / `workflow-script-determinism` / `interrupted-output-continuation` 等） |
| 改动规模 | `git diff --name-only \| wc -l`；`git ls-files --others --exclude-standard \| wc -l` | **65 个修改文件 + 52 个新增文件**（21 tests + 11 specs + 本文档 + 19 源码/脚本/生成物）。评审轮记为「约 40 个新增文件」，差异源于本轮计数含 docs 与 generated 产物 |
| CommandInbox 行为零改动 | `git diff --numstat` + 过滤非注释新增行 | **36 增 / 0 删**，新增行全部为注释（无非注释新增） |
| 不变量面零 diff | `git diff --name-only` 过滤 owner / lease / prompt-admission / runtime-command-queue / acode-protocol-v4 | 仅命中 `bootstrap/src/acode-protocol-v4/command-inbox.ts`（纯注释），其余零 diff |
| `assembleSystemMessages` 未触及 | `git diff -U0 .../context/builder.ts` 过滤该名 | 仅出现在**新增注释行**中 |
| D3 修正项 #7 测试规模 | `grep -n "^test(" apps/acode-cli/tests/command-inbox-invariants.test.mjs` | **7 例**，覆盖锁序 / per-session 锁序 / duplicate 共享 final promise + settle 幂等 / CAS / admissionSeq / 三态分离 >512 churn / 约定文字与 §B §C 互引 |
| D3 修正项 #5 钉住测试 | 读 `tests/stale-branch-terminal-observability.test.mjs` 文件头 | 自述「修正项 #5 的验收测试」，钉住 §C 四条约定（含命令丢弃走 info、事件路径刻意保持 debug 的分级理由） |
| D3 追加小节是否已回填 | `grep -n "^## \|^### §"` `specs/command-terminal-state-audit.md` | 审计结论区（:267）+「追加小节（修正项落地的规格，2026-09-29 回填）」含 §A（:437）/ §B（:471）/ §C（:517）；修正项登记表 #1–#8 与判定汇总在案 |
| D3 审计轮 E1 记录是否在仓 | 读 `specs/command-terminal-state-audit.md:269-312` | E1 命令表（:277-295）逐条含 40/40、62/62、`lint` 0 errors、`architecture:check` 0 violations、`typecheck` exit 0；未执行项 6 条（:297-312）据实登记（含「不变量套件仓内不存在」→ 修正项 #7） |
| D3 修正项 #3 守卫是否真在代码里 | 读 `core/src/runtime-task/registry.ts:146-173` | `update()` 在 `:162-168` 拦「终态 → 另一终态」并 `return current`（赢家快照），注释 `:133-154` 写明放行条件与 first-wins 理由 |
| D1/P2/P3/D2/D4/D5/P4/P6/P7 落点存在性 | `grep -n` 符号名、`ls` 脚本与 migration、`grep -n` `apps/acode-cli/package.json` 入口 | 逐项命中，file:line 见「优先级总览」实施状态列（D2 `budget-caps.ts:30,36,45`；P2 `registry-main.ts:224` 含 12 id、subagent 3 id；P3 三个脚本 + `package.json:21-23` 三入口；D4 `todo.ts:63,81` + `0023-todo-deps-json.ts`；D5 `contracts/model/index.ts:87,96`；P4 `types.ts:132,141` + `zh-CN.ts:88` / `en-US.ts:87` + `app-event-data.ts:93`；P6 `memory.ts:49,55` + `env-info.ts:15,17,93,103`；P7 `runtime-reminders.ts:94,109,217,235`） |
| P5 决策是否已持久化 | `grep -n "立项决策记录\|19.4" specs/tools-schema-token-metrics.md` | 命中「## 立项决策记录（2026-09-29）」（:135）与 19.4%（:137）及数字来源据实登记（:147）→ 决策记录的规范副本**在仓**，本方案 §4 P5 与之一致 |
| §8.2 #3 是否已闭环 | `grep -rln "barrier" apps/acode-cli/specs/ apps/acode-cli/tests/` | **零命中** → 判「仍待验证」 |
| §8.2 #6 是否已闭环 | `grep -rln "注入防御" apps/acode-cli/specs/ docs/` | 仅命中本文档 2 处（§2.2 B5 行、§8.2 #6 行），11 篇 spec 无登记 → 判「仍待验证」 |

**本轮未执行**：任何测试（`node --import tsx --test`）、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check`、`tsc --noEmit`、manifest / parity 脚本、双链路端到端。因此 §11.1 的「全绿」与 §11.2 的评审结论**均为转录**，「已实施」只表示改动在工作区且与 spec 一致，不表示本轮重新验证通过。

---

**来源对照（转述级）**：本文的机制参考全部来自 zoode 工作区 claudecli 还原产物的分析报告（上游 2.1.283 快照，产物逐字档 + 深度安全分析报告 45/48 CONFIRMED）与 `prompt-parity-missing.json` 缺口清单（原基线 ZCode 3.14.0，已按 ACode 当前检出重判）；ACode 现状证据全部来自基线 7578e1e 检出的源码逐项核实。既有《ACode-提升方案.md》（2026-09-27）为安全议题与增量边界的基线。
