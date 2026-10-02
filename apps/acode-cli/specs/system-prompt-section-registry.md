# 系统提示词段注册表、条件组装与版本清单（P1/P2/P3）

提示词主线 P1 项。把 `ContextBuilder.build()` 的硬编码调用序列换成**命名段注册表**
（`SectionDescriptor`），使三条身份通道、条件段、cache 分组与双组装路径共享同一份基础设施；
并在此之上建**构建期版本清单**（prompt-manifest）与可重复的 parity 校验脚本。

本 spec 是 `dispatch-discipline-prompt.md`（D1）与方案 P1/P6 各项的**承载基础设施**：
新增段一律经注册表登记，不再往 `build()` 里插 `sections.push(...)`。

红线：条件旗标一律是**本地** env/config 开关，**不打 applied 遥测、不做服务端 A/B**
（`specs/no-telemetry.md`）；manifest hash 只进本地 debug 日志。

## 背景

### 组装管线现状（已核实）

`core/src/context/builder.ts:82-223` 的 `build()` 是一条硬编码序列：

1. `:103-105` CLI prefix（workflow actor 跳过）
2. `:108-122` **三选一身份体**：`customSystemPrompt` / `workflowActor` / 默认 identity；
   `:92-97` 对 `workflowActor` 与 `customSystemPrompt` 同在**抛错**（有意大声失败）
3. `:130-173` 动态 system 段：desktop（`:131-133`，仅 `presentationSurface === "acode_desktop"`）、
   Dynamic Behavior（`:136-138`）、Session guidance（`:141-149`，可返回 null）、
   Memory（`:152-157`，需 `memoryRoot`）、Env info（`:158`）、Output Style（`:161-164`，可 null）、
   Context Management（`:167`）、git 快照（`:169-172`，可 null）。
   `customSystemPrompt` 在场时**整块跳过**（`:130` 的 `if (!hasCustomSystemPrompt)`，
   理由见 `:125-129` 注释）；`isWorkflowActor` 逐段跳过面向用户对话的三段。
4. `:179-187` Skills（仅当 `skills` 在场**且** `skillToolAvailable()`，判据 `:225-228`）
5. `:190-202` meta_user：request user context（agentsMd 等）+ current date
6. `:205` 自定义 section（`addSection`，`:65-77`）

排序与投递：`orderSectionsForInjection`（`:310-325`，system-stable → system-dynamic →
meta_user-stable → meta_user-dynamic）；`assembleSystemMessages`（`:230-277`）产出**最多 3 个**
system block（cli_prefix / stable body / dynamic），全部带 `EPHEMERAL_CACHE_CONTROL`（`:35`）；
`assembleMetaUserAttachments`（`:279-307`）产出 `skills_listing` 与 `context_prefix` 两个 attachment。

子代理走**独立组装路径**：`core/src/subagent/context-builder.ts:46-97` override `build()`，
每个 system 段**各自一条 system message、各自带 ephemeral breakpoint**（`:51-61`，注释明言这是
刻意的 cache 设计）。段清单在 `:106-163`：cli_prefix → subagent_agent_prompt（stable）→
subagent_notes（stable）→ subagent_environment（dynamic）→ request_user_context → current_date →
skills。它继承 `ContextBuilder` 但**不调用** super.build()，两条路径的公共段（cli_prefix、
request_user_context、current_date、skills）目前各写一遍。

### 已确认的缺口

1. **无命名段注册表**：段的 id 只以 `ContextSource` 联合存在（`context/types.ts:31-50`，18 个值），
   而 `build()` 里的启用条件是散落的 `if`；无法枚举「当前配置下哪些段被考虑过、哪些被启用」。
2. **无异步段通道**：所有 `build*Section` 都是同步的。任何需要 I/O 的段（例如读 memory 索引、
   读 git 状态）只能在调用方先取好数据再传进来——`builder.ts:152-157` 与 `:169-172` 就是这个形状。
3. **无版本清单**：提示词文本分散在至少 9 个文件（identity、dynamic-sections、workflow-actor、
   subagent/system-prompt、general-purpose、explore、runtime-reminders、compact/prompt、
   incoming-message），没有统一版本号或 hash，改版无法机器化对照。
4. **双路径重复维护**：主/子代理共享的四个段各写一遍（见上），改一处漏一处。

## 产品规则

### R1 SectionDescriptor 注册结构

```ts
interface SectionDescriptor {
  /** 稳定 id，manifest 与日志的键。点分命名：<area>.<name>，例 "identity.default"。 */
  readonly id: string;
  /** 既有 ContextSource（context/types.ts:31-50）。一个 source 可承载多个 id（见 R2）。 */
  readonly source: ContextSource;
  /** 投递通道 + cache 分组，二者共同决定落哪个 system block（R4）。 */
  readonly group: "system-stable" | "system-dynamic" | "meta_user-stable" | "meta_user-dynamic";
  /** 段内左边界（既有约定：dynamic system block 自带 "\n\n"，见 builder.ts:270-271）。 */
  readonly boundary?: "\n" | "\n\n";
  /** 纯谓词：本 ctx 下是否考虑该段。不得有副作用、不得读时钟/随机源。 */
  enabled(ctx: SectionContext): boolean;
  /** 允许 async；管线统一 await 解析（R3）。返回 null = 本次不产出。 */
  build(ctx: SectionContext): ContextSection | null | Promise<ContextSection | null>;
  /** 该段文本是否可进 manifest（含用户/项目数据的段必须为 false，见 R6）。 */
  readonly persistable: boolean;
  /** 归属文件（相对仓库根），manifest 的 owner 字段来源。 */
  readonly owner: string;
}
```

- `group` 与既有 `injectionTarget` + `cacheHint`（`context/types.ts:52-54,62-71`）一一对应：
  `system-stable` = `{ injectionTarget: "system", cacheHint: "stable" }`，其余同理。
  注册表化**不改** `ContextSection` 的字段语义，`group` 只是把两个字段合成一个可排序的键。
- 注册表是**声明序**数组，不是 Map：段的相对顺序即注入顺序，`orderSectionsForInjection`
  （`builder.ts:310-325`）的分组稳定排序保持不变——同组内按注册序。

### R2 段 id 与 source 的关系

- **id 是 manifest 与诊断的键，source 是既有协议面**。允许一个 source 下多个 id：例如
  `session_guidance` source 下可有 `guidance.skill`、`guidance.delegating_work`、
  `guidance.ask_user_question` 三个 id（对应 `dynamic-sections.ts:44-74` 的三组 bullet）。
  这样 D1 的纪律节能被单独追踪与单独开关，而不必扩 `ContextSource` 联合。
- 需要新增 `ContextSource` 值时，必须同批更新 `context/types.ts:31-50` 的联合与注释；
  跨包消费者（`packages/shared` v4 schema）若持久化该值，须同步 schema（跨包公开入口纪律）。
- **id 一旦发布不得改名**：改名等于 manifest 里一条缺失 + 一条新增，parity 报告会把它当两次
  变更。废弃段的做法是从注册表移除并在 manifest 的基线里标记为「有意移除」。

### R3 条件组装与本地开关

- `enabled(ctx)` 的输入 `SectionContext` 是**已解析好的纯数据**：`ContextBuilderConfig`
  （`context/types.ts:102-128`）+ 工具面（`guidanceToolNames`）+ 段级旗标（下述）。
  descriptor 不得自己读 `process.env`（外部 I/O 边界收敛，`apps/acode-cli/AGENTS.md`「外部 I/O 边界收敛」）。
- `build(ctx)` 支持 async，管线**统一 await 解析**后再排序、组装。解析失败的段：
  记 `warn` 日志（既有 logger 设施）并**跳过该段**，不让整个 build 失败——一个诊断段
  不该把会话打死。身份体三段（R5 互斥通道）例外：它们失败必须抛。
- **新增两个本地开关**（按 `apps/acode-cli/AGENTS.md:21` 要求，在此定义用途、优先级、
  错误行为与测试覆盖）：

| 环境变量 | 用途 | 解析与优先级 | 错误行为 | 默认 |
| --- | --- | --- | --- | --- |
| `ACODE_PROMPT_SECTIONS_DISABLED` | 本地诊断：按段 id 排除段（逗号分隔）。用于隔离「某段是否导致行为异常」，不用于产品功能开关 | `adapters/src/config/env-config.adapter.ts` 的 `parseEnvConfig`（`:14-63`，`ACODE_` 前缀 `:9`）解析进 `RuntimeConfigPatch.prompt.disabledSections: string[]`，以 `ConfigScope.Env`（priority 40，`contracts/src/config/index.ts:192-199`）参与合并——即 Session(30) 之上、Cli(50) 之下 | 空串/全空白 → 空数组；未知 id → **忽略该项**并记一条 `warn`（不 fail-closed：这是诊断开关，拼错一个 id 不该让整个提示词体系降级）；重复 id 去重 | 空（零行为变化） |
| `ACODE_PROMPT_MANIFEST_TRACE` | 本地诊断：把本次组装的段 id 清单 + manifest hash 写进 **debug 级**日志 | 同上，解析进 `RuntimeConfigPatch.prompt.manifestTrace: boolean`；接受 `1`/`true`（大小写不敏感）为真，其余为假 | 非法值 → 按 `false` 处理并记 `warn`；**任何取值都不产生网络请求** | `false` |

- `RuntimeConfig` 相应新增（`contracts/src/config/index.ts:227-284` 与 patch `:287+`）：
  ```ts
  prompt: { disabledSections: string[]; manifestTrace: boolean }
  ```
- **明确禁止**：不新增任何形如「段 A/B 变体选择」「按用户分桶」的开关；不打 applied 遥测；
  不把段启用情况上报任何外部端点。旗标只有上述两个诊断用途（`no-telemetry.md` 红线）。

### R4 cache 分组与 breakpoint 不回退

- 组装产物仍为**最多 3 个 system block**（cli_prefix / stable body / dynamic），全部带
  ephemeral cacheControl（`builder.ts:230-277`）。注册表化不得增加 system block 数量。
- `group` 决定落哪个 block，映射固定：`system-stable` → 第 2 块（cli_prefix 单独第 1 块）、
  `system-dynamic` → 第 3 块（自带 `"\n\n"` 左边界，`:270-271`）、`meta_user-*` → attachment
  （`skills_listing` / `context_prefix`，`:279-307`）。
- **stable 前缀稳定性是硬约束**：任何进入 `system-stable` 组的段，其文本不得依赖
  会话内可变量（cwd、日期、git 状态、工具面）。现有 stable 段（cli_prefix
  `sections/cli-prefix.ts:10-17`、identity `sections/identity.ts:42`、desktop
  `sections/desktop.ts:4,30-37`、workflow_actor_identity `sections/workflow-actor.ts:70-82`）
  均满足；新段若不满足必须落 dynamic 组。
- 子代理路径**保留**每段独立 system message + 独立 ephemeral breakpoint
  （`subagent/context-builder.ts:51-61`）——这是刻意的 cache 设计，注册表化不得把它
  「统一」成主路径的 3-block 形态。

### R5 互斥通道语义不变

- 三条身份通道（`customSystemPrompt` / `workflowActor` / 默认 identity）**互斥**，
  `workflowActor` 与 `customSystemPrompt` 同在时**抛错**（`builder.ts:92-97`）。注册表化后
  这条硬失败必须原样保留，且必须有回归测试（验收场景 4）。
- `customSystemPrompt` 在场时跳过整个默认动态段体系（`builder.ts:130`），不是只替换 stable body
  （理由见 `:125-129` 注释）。注册表用 descriptor 上的 `channel` 标记表达：
  `channel: "default" | "custom" | "workflow_actor" | "any"`，管线按当前通道过滤。
- `isWorkflowActor` 逐段跳过 desktop / Dynamic Behavior / session guidance
  （`builder.ts:131-149`）同样用 `channel` 表达，不散落 `if`。

### R6 prompt-manifest 与 parity 校验

- **构建期**生成 `prompt-manifest`：每个 `persistable: true` 的注册段一条
  `{ id, group, source, owner, hash }`，外加顶层 `{ version, generatedAt, sectionsHash }`。
  结构以方案 §10.1 为草图，本 spec 为准。
- `hash` = 段**规范化文本**的 sha256。规范化 = 去除行尾空白、统一换行为 `\n`、
  不做大小写折叠。**不含**任何运行期数据（cwd、日期、git 状态、工具面）——含运行期数据的段
  必须 `persistable: false`，因而不进 manifest（例：env_info、system_context、current_date、
  request_user_context、memory、skills）。
- **manifest 只进本地 debug 日志**（受 `ACODE_PROMPT_MANIFEST_TRACE` 控制），不外发、不落
  任何上传通道（`no-telemetry.md`）。
- **parity 校验**是可重复脚本：输入 = 当前构建的 manifest + repo 内基线清单
  （`parity-baseline.json`，**只含机制对照项名称与期望段 id，不含任何第三方逆向原文**）；
  输出 = 差异报告（新增段 / 缺失段 / hash 变化段），供人工判定。
- **CI 策略**：「manifest 与代码一致」为硬校验（阻断）——即注册表里的每个
  `persistable` 段都出现在 manifest、且 hash 与代码产出相符；parity 差异**仅报告不阻断**
  （控制快照维护成本）。
- 双组装路径共享的段（cli_prefix / request_user_context / current_date / skills）在 manifest 里
  **只有一条**，`owner` 指向共享的 descriptor 定义文件——这是「一份文本一处所有」的机器化表达。

### R7 双路径共享 descriptor，不共享组装

- 主路径与子代理路径**共享 descriptor 实例**（同一个 `SectionDescriptor` 对象），
  消除四处重复维护；但**各自保留组装器**（`ContextBuilder.build()` 与
  `SubagentContextBuilder.build()`），因为两者的 block 形态刻意不同（R4）。
- 共享段的 `boundary` 差异（主路径 `\n\n`，子代理 agent_prompt 用 `\n`、其余用 `\n\n`，
  见 `subagent/context-builder.ts:110-140` 注释）由**组装器**施加，不进 descriptor 文本——
  否则同一份文本在两条路径上 hash 不同，manifest 就失去意义。

## 状态所有者

```
contracts/src/config/index.ts        RuntimeConfig.prompt（旗标的类型所有者）
   ▲
adapters/src/config/env-config.adapter.ts:14-63   ACODE_ → RuntimeConfigPatch（env 的唯一读取点）
   ▲
core/src/context/registry.ts（新）    SectionDescriptor[] 声明序注册表（段文本与启用条件的唯一所有者）
   │                                    ├─ 主路径共享段 descriptor（cli_prefix / request_user_context /
   │                                    │   current_date / skills）→ 被两个组装器同时引用
   │                                    └─ 各段 owner 文件（sections/*.ts、dynamic-sections.ts、
   │                                        subagent/system-prompt.ts）→ 只产出文本，不决定启用
   ├─► core/src/context/builder.ts          主组装器：通道过滤 → enabled → await build → 排序 → 3 block
   └─► core/src/subagent/context-builder.ts 子代理组装器：同注册表，独立 block 形态（每段一 breakpoint）

构建脚本（新）                        prompt-manifest 生成（读注册表，不读运行时）
parity 脚本（新）                     manifest × parity-baseline.json → 差异报告
```

- **段的启用条件**唯一所有者是 descriptor 的 `enabled`；`build()` 里不得再出现
  「某段是否 push」的散落 `if`（`builder.ts:103-205` 现有形态是被替换对象）。
- **段文本**唯一所有者是各 `sections/*.ts` / `dynamic-sections.ts` 的构建函数；descriptor 只做
  登记与条件，不内联文本常量。
- **旗标**唯一所有者是 `RuntimeConfig.prompt`；descriptor 从 `SectionContext` 读，不读 env。
- **manifest** 唯一所有者是构建脚本；运行时只读不写。

## 接口

- `core/src/context/registry.ts`（新）：
  ```ts
  export interface SectionContext { /* ContextBuilderConfig + 工具面 + prompt 旗标，纯数据 */ }
  export interface SectionDescriptor { /* R1 */ }
  export const MAIN_SECTION_REGISTRY: readonly SectionDescriptor[];
  export const SUBAGENT_SECTION_REGISTRY: readonly SectionDescriptor[];
  export function resolveSections(
    registry: readonly SectionDescriptor[],
    ctx: SectionContext,
  ): Promise<ContextSection[]>;   // 通道过滤 → enabled → await build → null 过滤 → 声明序
  ```
- `core/src/context/builder.ts`：`build()` 改为 `async build(): Promise<ContextBuildResult>`
  （R3 统一 await 解析的必然结果）。**调用方需同步改造**：`builder.ts:82`、
  `subagent/context-builder.ts:46` 及所有 `createContextBuilder(...).build()` 站点。
  `assembleSystemMessages` / `assembleMetaUserAttachments` / `orderSectionsForInjection`
  签名与语义不变（`:230-325`）。
- `core/src/context/types.ts`：`ContextSource` 按需扩枚举（R2）；`ContextSection`（`:62-71`）
  字段不变。
- `contracts/src/config/index.ts`：`RuntimeConfig.prompt`、`RuntimeConfigPatch.prompt`（R3）。
- `adapters/src/config/env-config.adapter.ts`：`parseEnvConfig` 增两个 `configKey` 分支（R3 表）。
- `packages/dynamic-workflow` 的构建脚本侧：manifest 与 parity 脚本入口（方案 §10.2 的输入输出约定）。
- 不新增其他 `ACODE_` 环境变量；R3 的两个是本 spec 的全部 env 面。

## 验收场景

1. **全旗标组合组装快照**：`presentationSurface`（terminal / acode_desktop）× 身份通道
   （default / custom / workflow_actor）× `ACODE_PROMPT_SECTIONS_DISABLED`（空 / 排除一个
   dynamic 段 / 排除一个 stable 段）× 工具面（含 Skill / 不含 Skill）的组装结果快照全绿；
   快照断言段 id 序列而不只是文本。
2. **cache breakpoint 断言**：主路径 system block 数量 ≤ 3、每块带 ephemeral cacheControl、
   `system-stable` 组文本在两次不同 cwd/日期的构建间逐字节相同（R4 stable 前缀稳定性）；
   子代理路径每段一条 system message 且各带 breakpoint（`subagent/context-builder.ts:51-61` 不回退）。
3. **注册表段 id 全量出现在 manifest**：每个 `persistable: true` 的注册段在 manifest 里有且仅有
   一条；`persistable: false` 的段一条也没有；共享段只有一条且 owner 指向共享定义（R6）。
4. **互斥硬失败回归**：`workflowActor` 与 `customSystemPrompt` 同在 → 抛错，错误消息与
   `builder.ts:94-96` 逐字一致；`customSystemPrompt` 在场时默认动态段体系整块缺席（R5）。
5. **双路径共享段一致性**：cli_prefix / request_user_context / current_date / skills 四段在主路径
   与子代理路径产出的**文本主体**逐字节相同（差异只允许是组装器施加的 boundary，R7）。
6. **旗标错误行为**：`ACODE_PROMPT_SECTIONS_DISABLED` 含未知 id → 该 id 被忽略、其余生效、
   一条 `warn`、build 不失败；`ACODE_PROMPT_MANIFEST_TRACE` 取非法值 → 按 false 处理 + `warn`；
   两者任何取值下**无网络调用**（断言无 fetch/OTLP/exporter 引用，与 `no-telemetry.md` 一致）。
7. **async 段解析失败不致命**：注入一个 `build()` reject 的诊断段 → 该段缺席、一条 `warn`、
   其余段照常；身份体三段之一 reject → 抛（R3 例外）。
8. **parity 脚本可重复**：同一检出连续跑两次，差异报告逐字节相同；改一个段文本后重跑，
   报告精确指出该段 hash 变化；基线文件不含任何第三方原文（人工审查 + 一条断言基线 JSON 里
   只有 id 与名称字段的测试）。
9. **CI 硬校验**：故意让 manifest 与注册表不一致（漏一段）→ 硬校验失败；故意制造 parity 差异
   → 仅报告、不阻断（R6）。
10. **验证命令**（从仓库根执行，如实记录结果）：`pnpm typecheck`、`pnpm lint`、
    `pnpm architecture:check -- --changed`；CLI 包类型检查用
    `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit`。

## 不在本项范围

- **上下文余量倒计时段**：方案 P2 第 5 点登记为可选（ACode 已有 CONTEXT_MANAGEMENT
  「不必提前收尾」`dynamic-sections.ts:26-42` + rapid-refill 熔断），Phase 3 评估，本 spec 不建段。
- **实验平台 / 服务端旗标**：非目标（方案 §7.1）。任何「按用户分桶选段」的能力都不做。
- **段文本内容本身的增删**：D1 纪律节归 `dispatch-discipline-prompt.md`；memory/env 补齐归方案 P6；
  AskUserQuestion 段恢复归方案 P1。本 spec 只提供它们落地用的注册结构。
- **reminder 三来源分类的扩展**：归方案 P7；本 spec 只管 system/meta_user 段，
  不接管 `system-reminder/source.ts:20-51` 的分类。
- **旧 WorkflowGraphScheduler 与 dynamic-workflow 的收敛**：独立议题（方案 §9 风险表末行）。

## 落地偏差记录（P2 注册表实施，2026-09-29）

实施范围受任务所有权约束（`context/builder.ts`、`context/sections/*`、
`subagent/context-builder.ts`、新增测试；禁触 `tool/handlers/*`、`runtime/*`、
`dynamic-workflow`），与本 spec 接口草案有两处接线偏差，语义与红线不变：

1. **`build()` 保持同步 + 新增 `buildAsync()`**。「接口」节的
   「`build()` 改为 async，调用方需同步改造」无法在本期执行：调用方
   `runtime/methods/context.ts:278` 与 `runtime/methods/context-refresh.ts:37`
   都在禁触的 `runtime/*`。落地形态：`resolveSections` / `resolveSectionEntries`
   按 R3 统一 await 解析；`ContextBuilder.buildAsync()` 是完整 async 通道；
   `build()` 为同步兼容入口（`resolveSectionEntriesSync`），同步管线遇到 async 段
   按 R3 失败语义处理（critical 抛、其余 warn+skip）。当前两条注册表全部 descriptor
   同步产出，两个通道产物一致（有测试断言）。runtime 调用方迁到 `buildAsync()`
   归 runtime 所有者的后续项。
2. **旗标接线暂不走 `RuntimeConfig.prompt`**。R3 表的完整链路
   （adapters `parseEnvConfig` → contracts `RuntimeConfig.prompt` → 调用方传入）
   需要改 `adapters/`、`contracts/` 与 `runtime/methods/context.ts`（配置折算点），
   均在本期所有权之外。落地形态：`ContextBuilderConfig.prompt` /
   `SubagentContextBuilderConfig.prompt` 为显式覆盖位（未来 RuntimeConfig 接线点）；
   缺席时由管线入口 `context/registry.ts` 的**单点** env 读取按 R3 表的名称、
   默认值与错误行为解析（未知 id 忽略+warn、非法 trace 值按 false+warn、去重、
   默认零行为变化）。descriptor 仍只吃纯数据（R3 纯度不变）。注意：warn 与
   manifest trace 都需要 `config.logger` 在场才有输出；runtime 侧把 logger 与
   RuntimeConfig 旗标传进 `createContextBuilderFromSnapshot` 是接线补齐项。
3. **构建期 manifest 文件与 parity 脚本（R6 / 验收 3、8、9）**：P2 注册表实施期未落地
   （当时宿主被划在禁触的 `packages/dynamic-workflow` 构建脚本侧）；**P3 专项已落地，
   宿主改在 `apps/acode-cli/scripts/`**（该目录既有生成脚本先例
   `generate-bash-command-registry.mjs` 的 generate/--check 模式）：
   - `packages/core/src/context/manifest.ts`：目录计算 / 段 hash（规范化文本 sha256）/
     顶层 sectionsHash / `verifyPromptManifest` 硬校验（「manifest 与代码一致」的
     唯一计算源；缺段、多段、hash/group/source/owner/顺序漂移都判失败；generatedAt
     不参与判定）；
   - `scripts/generate-prompt-manifest.mjs`：生成 + `--check` 硬校验（CI 阻断项），
     产物 `packages/core/src/context/generated/prompt-manifest.json`（生成物随代码提交）；
   - `scripts/check-prompt-parity.mjs` + `scripts/parity-baseline.json`（基线只含
     机制对照项名称与期望段 id）+ `scripts/prompt-parity-lib.mjs`（纯函数）：
     差异报告（缺失段/新增段/hash 变化段）**仅报告不阻断**（恒退出码 0，
     操作性错误除外）；
   - package.json 入口：`prompt-manifest:generate` / `prompt-manifest:check` /
     `prompt-parity:report`；
   - 「manifest hash 进 debug 级本地日志」的运行期半边：`ACODE_PROMPT_MANIFEST_TRACE`
     的 debug trace 在 P2 的组装级 hash 之外补 `manifestVersion` /
     `manifestSectionsHash`（与构建期 manifest 的 sectionsHash 同源同值，
     `emitSectionManifestTrace`，不外发）。
4. **`session_guidance` 按 R2 拆为两个 id**：`guidance.session`（工具指导 bullet 组）
   与 `guidance.delegating_work`（D1 纪律节），非 R2 示例的三 id 拆分——
   AskUserQuestion bullet 与 Explore/Skill bullet 共用「# Session-specific guidance」
   标题，单独成段会把标题复制两份；两段拆分在 dynamic block 内以 "\n\n" 连接，
   组装文本与拆分前逐字节一致（有测试断言）。
