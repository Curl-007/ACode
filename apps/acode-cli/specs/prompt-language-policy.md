# 提示词语言策略：模型面恒英文、UI 面走 i18n（P4 决策记录）

提示词主线 P2 项，**决策型 spec**。本文件不设计新功能，而是把一个已经在事实上生效、
但从未写下来的决定固定下来：**送给模型的文本恒为英文；送给用户的文本走 i18n**。
并处置该决定暴露出的一处悬空配置（`ContextBuilderConfig.language`）。

写下来的理由：`language` 字段当前被声明、被透传、可被 patch，但**没有任何消费方**
（见背景）。没有这份决策记录，下一个人会把它当成「待实现的双语提示词功能」去接；
接上就同时踩三个坑（翻译漂移、cache 前缀分裂、parity 成本翻倍）。

## 背景

### 已核实的现状

**i18n 设施存在，但只覆盖 CLI/TUI 文案**：

- `apps/acode-cli/packages/i18n/src/index.ts:25-33`：`CATALOGS` 只有 `en-US` / `zh-CN` 两个目录，
  出口是 `getACodeCopy(locale?, detected?)`。
- `apps/acode-cli/packages/i18n/src/types.ts:5-9`：`ACodeCopy = { cli: CliCopy; locale; tui: TuiCopy }`。
  `CliCopy`（`:11-16`）只有 `errors.localeUnsupported(value)` 与 `help(version)`；
  `TuiCopy`（`:18+`）是输入框、登录流程、effort 开关、复制提示等**终端界面**文案。
- 消费方全在 CLI/TUI/bootstrap：`packages/cli/src/{help.ts,locale.ts,run.ts,cli-types.ts,command-center/*}`、
  `packages/bootstrap/src/app/{app-config-options.ts,session-facade.ts}`。
- locale 类型：`contracts/src/config/index.ts:306-307`
  （`SupportedLocale = "en-US" | "zh-CN"`；`UiLocale = SupportedLocale | "auto"`），
  配置位 `RuntimeConfig.ui.locale`（`:281-282`）。
- Desktop / Web 渲染层有**另一套**目录：仓库根 `packages/ui/src/i18n/locales/{en-US.ts,zh-CN.ts}`。
  两套不共享 catalog（跨包只走公开入口，`@acode/i18n` 是 CLI 侧的入口）。

**提示词正文全部是硬编码英文常量**（无一处走 i18n）：
`core/src/context/dynamic-sections.ts:4-42`（COMMUNICATION_PROMPTS / CONTEXT_MANAGEMENT_PROMPTS）、
`core/src/context/sections/identity.ts`（`buildSecurityNotice:13`、`buildHarnessBlock:21`、
`buildIdentitySection:42`）、`core/src/context/sections/workflow-actor.ts:23-46`、
`core/src/subagent/system-prompt.ts:10-40`、`core/src/tool/handlers/agent.ts:91-126`（工具描述）、
`core/src/runtime/helpers/runtime-reminders.ts:25-60`（Plan workflow）。
与之对照，这些文件的**代码注释是中文**——即仓库既有惯例已经是「注释中文、模型面文本英文」。

**`language` 字段是悬空配置**（`grep` 全 `packages/core/src` 只有三处命中）：

| 位置 | 做什么 |
| --- | --- |
| `core/src/context/types.ts:124` | 声明 `language?: string`（注意：类型是 `string`，**不是** `UiLocale`） |
| `core/src/runtime/methods/context.ts:138` | 透传：`language: this.config.language` 进 `ContextBuilderConfig` |
| `core/src/runtime/methods/config.ts:59-60` | 可被 config patch 改写：`if (patch.language !== undefined) this.config.language = patch.language` |

没有任何 section builder、工具描述构建函数或 reminder 读它。`ContextBuilder.build()`
（`core/src/context/builder.ts:82-223`）全程未引用 `this.config.language`。

**一处名字误导的灰区**：`ToolEntry.cancellation.userVisibleMessage`
（声明 `contracts/src/tools/contract.ts:158`；实例见 `tool/handlers/agent.ts:271-272`、
`tool/handlers/todo.ts:120,181`、`contracts/src/tools/websearch.ts:155`、
`core/src/mcp/index.ts:206`）。它名叫「user visible」，但消费路径是
`core/src/tool/executor/timeout.ts:105-106,157`——被塞进
`createCoreError(CoreErrorType.ToolCancelled, <该文本>)` 的 **message**；
而工具错误的 message 会进模型上下文：`core/src/tool/executor/errors.ts:20-55` 把
`error.message` 写进 tool result 的 `error.message`，其 `:23-24` 的注释原文是
「tool result 是**父模型和 UI hover 的共同来源**」；另一条路径
`core/src/tool/executor/call-runner.ts:696-698` 也用 `result.error.message` 兜底
`modelContent`。即：这段文本**同时**是模型面与 UI 面。

### 判断

上游客户端的全英文提示词是**有意设计**而非缺口（方案 P4）。ACode 的现状与之一致，
且已经有配套的 i18n 设施覆盖真正需要本地化的面（CLI/TUI、Desktop/Web UI）。
所以这不是「缺失功能」，而是「一处悬空配置 + 一条未写下的决策」。

## 产品规则

### R1 决策：模型面提示词恒英文

送给模型的文本（system 段、工具描述、工具结果格式化文本、reminder、通知文案）**一律英文**，
不随 locale 变化，不提供译文。三条理由，按权重排序：

1. **cache 前缀命中**：主路径的 system block 全部带 ephemeral cacheControl
   （`builder.ts:35,230-277`，最多 3 块），子代理路径每段一个 breakpoint
   （`subagent/context-builder.ts:51-61`）。按 locale 分叉文本 = 把 stable 前缀一分为二，
   同一台机器上切一次语言就废掉整段缓存。
2. **指令遵循一致性**：模型行为对提示词措辞敏感；维护两份措辞意味着两份**可能不等价**的
   行为，而等价性无法机器验证（`system-prompt-section-registry.md` R6 的 hash 只能保证
   「同一份文本没变」，保证不了「两份文本同义」）。
3. **快照与 parity 成本翻倍**：注册表化后的段快照矩阵（`system-prompt-section-registry.md`
   验收场景 1）与 parity 基线都要按 locale 各维护一份。

### R2 三个面的分类判定表

新增或修改任何一段文本前，先按这张表定它的语言。判定依据是**谁是读者**，不是变量名叫什么
（`userVisibleMessage` 就是反例，见 R3）。

| 面 | 读者 | 语言 | 承载点（当前检出） |
| --- | --- | --- | --- |
| **模型面** | 模型 | **恒英文** | system 段（`context/sections/*`、`dynamic-sections.ts`）、工具描述（`tool/handlers/*` 的 `metadata.description` / `modelInstructions`）、工具结果格式化（`formatModelContent`，例 `agent.ts:130-172`）、reminder（`runtime/helpers/runtime-reminders.ts`、`system-reminder/*`）、通知文案（`subagent/completion-notification.ts`） |
| **CLI / TUI 面** | 终端用户 | **走 `@acode/i18n`**（en-US / zh-CN） | `apps/acode-cli/packages/i18n/src/{index.ts,types.ts,locales/*}`；消费方 `packages/cli/*`、`packages/tui/*`、`bootstrap` |
| **Desktop / Web UI 面** | 图形界面用户 | **走 `packages/ui/src/i18n/locales/*`** | 仓库根 `packages/ui/src/i18n/locales/{en-US.ts,zh-CN.ts}`（与 CLI 侧 catalog 不共享） |

### R3 灰区裁决：双面文本按模型面处理

- **规则**：一段文本若同时到达模型与用户（即出现在 tool result 的 `error.message` /
  `modelContent` 上，又被 UI 直接展示），**按模型面处理 = 恒英文**。
  理由：R1 的三条理由全部适用，而 UI 侧有替代方案（下述），模型侧没有。
- **UI 侧的替代方案**：UI 要本地化这类文本，必须走**结构化字段 → i18n key** 的映射，
  不得翻译 message 本身。可用的结构化字段已经在 tool result 的错误形态里：
  `errors.ts:39-55` 产出 `error.type`（`CoreErrorType`）、`error.code`、`error.detail`。
  UI 按 `type`/`code` 查自己的 catalog，查不到时**回落展示原始英文 message**
  （回落是必须的：错误种类是开放集合，catalog 是封闭集合）。
- **`userVisibleMessage` 的处置**：它的名字与它的实际读者不符。二选一，在实现 PR 里定并回写本小节：
  - (i) **改名**为能表达「取消时进 tool result 的英文说明」的名字（例 `cancelledModelNotice`），
    同步 `contracts/src/tools/contract.ts:158` 与全部实例
    （`agent.ts:271-272`、`todo.ts:120,181`、`websearch.ts:155`、`mcp/index.ts:206`）；
  - (ii) **保留名字 + 加注释**说明它是模型面文本、UI 本地化走 `error.type`/`code` 映射。
  - 不选 (iii)「把它接进 i18n」——那会让 tool result 的文本随 locale 变化，直接违反 R1 第 1 条。
- **不追溯翻译既有英文文本**：本规则只管新增与修改；既有英文文案不因本 spec 而改动。

### R4 `language` 字段的处置

`ContextBuilderConfig.language`（`context/types.ts:124`）当前无消费方。按 R1，它**永远不该有**
提示词消费方。处置二选一，判定规则如下：

- **选 (i) 删除**，当且仅当：`grep -rn "\.language\b" apps/acode-cli/packages/*/src` 在删除
  `context/types.ts:124`、`runtime/methods/context.ts:138`、`runtime/methods/config.ts:59-60`
  三处后**再无命中**（即它确实只活在这条透传链上），且 `RuntimeConfigPatch.language`
  （`runtime/methods/config.ts:59` 消费的那个 patch 成员）没有跨包/协议消费者。
  删除范围必须包含 patch 成员与其协议声明，否则留下一个写了没人读的入口。
- **选 (ii) 保留 + 注释**，当：删除会触碰 `packages/shared` 的 v4 协议 schema 或 UI 的
  config patch 面（跨包改动超出本项范围）。此时必须在 `context/types.ts:124` 上方加中文注释，
  写明三件事：本字段**当前无提示词消费方**；按 `prompt-language-policy.md` R1 它不该有；
  UI 语言的真实所有者是 `RuntimeConfig.ui.locale`（`contracts/src/config/index.ts:281-282`）。
- **无论选哪个**：不得把 `language` 接进任何 section builder。若将来确有需要按语言改变
  **模型面**文本的场景（本 spec 判为不该有），必须先改本 spec 再改代码（spec-first）。
- **类型不一致顺带记录**：`language?: string` 与 `UiLocale`（`SupportedLocale | "auto"`）
  不是同一个类型。若选 (ii) 保留，注释里要写明它**不是** locale，避免被当成
  `RuntimeConfig.ui.locale` 的别名使用。

### R5 UI 可见文案接入 i18n 的范围（方案 P4-b）

- **CLI/TUI 侧**：新增用户可见文案一律进 `@acode/i18n` 的 `CliCopy` / `TuiCopy`
  （`i18n/src/types.ts:11-16,18+`），zh-CN 与 en-US **同批**补齐（缺一个 locale 就是回归：
  `getACodeCopy` 按 `resolveLocale` 选目录，缺键会在运行时炸而不是编译期）。
- **Desktop/Web 侧**：进 `packages/ui/src/i18n/locales/*`，遵守根 `AGENTS.md` 的
  UI 与平台边界（复用已有组件、兼顾桌面与手机 Web 的国际化）。
- **本项不做的**：不把两套 catalog 合并（跨包公开入口纪律，且两者的面不同）；
  不为「模型面文本」在任何一套 catalog 里建键。

### R6 明确禁止

1. **提示词双语化**：不为 system 段 / 工具描述 / reminder / 通知文案提供 zh-CN 版本。
2. **按 locale 切模型面文本**：不得让 `ui.locale`、`language`、`Accept-Language`、
   环境变量或任何运行期输入影响模型面文本的**语言**。
3. **把 locale 引入 cache 前缀**：`system-prompt-section-registry.md` R4 的 stable 前缀
   稳定性约束已覆盖此条；本 spec 再钉一次——locale 不得成为任何 `system-stable` 组段的
   `enabled` 或 `build` 输入。
4. **机器翻译既有提示词**：翻译漂移会改变模型行为，且无法用 hash 验证等价性（R1 第 2 条）。
5. **新增 `ACODE_` 语言开关**：语言选择的既有所有者是 `RuntimeConfig.ui.locale`
   （含 `"auto"` 与 `detectLocale`/`resolveLocale`，`i18n/src/index.ts:4-21`），不另开 env 面
   （`apps/acode-cli/AGENTS.md:21`）。

### R7 新增文本的语言约定

- **模型面文本**：英文，自撰。禁止复制第三方产品提示词原文（方案 §7.2 合规要求）；
  以 ACode 自有注释原文为底稿改写是允许的（方案 P1 第 3 点）。
- **代码注释**：中文（仓库既有惯例；根 `AGENTS.md`「修复 bug 时用中文注释说明原因和修复依据」）。
- **面向用户的错误提示**：按 R2 分类进对应 catalog；双面文本按 R3。
- **日志**：英文或中文均可，但**不得**含凭据、真实用户数据、内部服务地址
  （根 `AGENTS.md`「日志」章）；日志走既有 logger 设施（`packages/ui/src/logger.ts` /
  `createServiceLogger`），不用 `console.log`。

## 状态所有者

```
模型面文本语言      本 spec（决策所有者）——恒英文，无运行期开关
                     └─ 各段/描述的文本所有者见 system-prompt-section-registry.md「状态所有者」

CLI/TUI locale      RuntimeConfig.ui.locale（contracts/src/config/index.ts:281-282）
                     ├─ "auto" 解析：i18n/src/locale.ts 的 detectLocale / resolveLocale
                     │   （经 i18n/src/index.ts:4-21 再导出）
                     └─ catalog 所有者：i18n/src/locales/{en-US,zh-CN}.ts

Desktop/Web locale  packages/ui/src/i18n/locales/*（独立所有者，与 CLI 侧不共享 catalog）

language 字段       runtime/methods/config.ts:59-60（写入）→ context/types.ts:124（声明）
                     → runtime/methods/context.ts:138（透传）→ 无消费方（R4 处置对象）
```

- **语言选择的唯一所有者是 `RuntimeConfig.ui.locale`**；`ContextBuilderConfig.language`
  不是它的别名，也不得成为第二个语言所有者（R4）。
- **模型面文本没有语言所有者**——它恒英文，不存在「按什么选语言」这个问题。这是刻意的：
  没有选择点，就没有漂移点。

## 接口

本 spec 不新增接口。它约束以下既有接口的**语义**：

- `core/src/context/types.ts:124` `ContextBuilderConfig.language?: string` —— R4 处置（删除或加注释）。
- `core/src/runtime/methods/config.ts:59-60` 的 `patch.language` 分支 —— 与 R4 的处置同批。
- `apps/acode-cli/packages/i18n/src/index.ts:31-33` `getACodeCopy(locale?, detected?): ACodeCopy`
  —— UI 面文案的唯一取用入口，语义不变。
- `contracts/src/tools/contract.ts:158` `cancellation.userVisibleMessage` —— R3 处置（改名或加注释）。
- `core/src/tool/executor/errors.ts:39-55` 的 tool result 错误形态（`type` / `code` / `detail`）
  —— R3 指定的 UI 本地化映射键来源，字段不新增、不改名。
- 不新增 `ACODE_` 环境变量（R6 第 5 条）。

## 验收场景

1. **模型面无 locale 依赖**：以 `ui.locale = "zh-CN"` 与 `"en-US"` 分别构建 context，
   断言 `systemMessages` 与工具描述逐字节相同（覆盖 `builder.ts:230-277` 的三块与
   `subagent/context-builder.ts:51-61` 的每段）。这条测试同时钉住 R6 第 2、3 条。
2. **`language` 处置生效**：
   - 选 (i) 删除：`grep -rn "\.language\b" apps/acode-cli/packages/*/src` 无提示词链命中；
     typecheck 通过（删除后无悬挂引用）；config patch 面不再接受 `language`
     （写它得到既有的未知键处理，而不是静默忽略）。
   - 选 (ii) 保留：`context/types.ts:124` 上方有中文注释，含 R4 要求的三件事；
     一条测试断言「设置 `language` 不改变组装结果」。
3. **双面文本按模型面处理**：取消一个工具 → tool result 的 `error.message` 是英文
   （`errors.ts:20-55` 路径）；UI 侧按 `error.type`/`code` 取到本地化文案，
   取不到时回落展示原始英文（回落路径有测试）。
4. **i18n 双 locale 同批**：新增任一 CLI/TUI 文案键后，`en-US.ts` 与 `zh-CN.ts` 同时含该键
   （一条遍历两套 catalog 键集合相等的测试）；`getACodeCopy("zh-CN")` 与
   `getACodeCopy("en-US")` 返回的 `ACodeCopy` 结构形状相同。
5. **cache 前缀不因语言分裂**：`system-prompt-section-registry.md` 验收场景 2 的
   stable 前缀断言在两个 locale 下都通过。
6. **无新增 env 面**：`grep -rn "ACODE_" apps/acode-cli/packages/*/src` 的结果里没有
   语言相关的新变量（R6 第 5 条）。
7. **验证命令**（从仓库根执行，如实记录结果）：`pnpm typecheck`、`pnpm lint`（期望 0 error）、
   `pnpm architecture:check -- --changed`（期望 0 violations）；CLI 包类型检查用
   `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit`
   （`cli` 包有既有环境红：`@acode/tui` dist 未构建导致 TS2307，不作为门禁）。

## 不在本项范围

- **提示词文本内容的增删**：D1 纪律节归 `dispatch-discipline-prompt.md`；memory/env 段补齐
  归方案 P6；段注册与 manifest 归 `system-prompt-section-registry.md`。本 spec 只定语言。
- **两套 i18n catalog 的合并**：跨包面变更，独立议题（R5）。
- **新增支持的 locale**（例如 ja-JP）：`SupportedLocale`（`contracts/src/config/index.ts:306`）
  的扩展是独立决策，需同时评估 CLI/TUI 与 Desktop/Web 两套 catalog 的维护成本。
- **UI 文案的翻译质量审查**：本 spec 只定「哪些文本走 i18n」，不审既有译文。
- **`userVisibleMessage` 之外的工具契约字段命名清理**：R3 只处置这一个已确认的误导名字；
  其余字段的命名一致性归各工具契约的常规维护。

## 实施记录（P4 落地，2026-09-29）

实施范围受任务所有权约束（`context/types.ts` 注释、i18n 接入点文件、新增测试）。
两处「二选一」的裁决、P4-b 的接入点与最小集合、以及验收对照如下。
行号以本批次工作区为准（`context/types.ts:141`、`contract.ts:173` 等都是改动后的位置）。

### R4 `language` 字段：选 (ii) 保留 + 注释

按 R4 的判定规则逐条核实，**(i) 删除的前置条件不成立**：

1. 删除 spec 点名的三处（`context/types.ts:141` 声明、`runtime/methods/context.ts:138`
   透传、`runtime/methods/config.ts:59-63` patch 写入）后，
   `grep -rn "\.language\b" apps/acode-cli/packages/*/src` **仍有命中**：
   `bootstrap/src/app/runtime-config.ts:137`（`language: options.runtimeConfig?.language`，
   把 `StartSessionOptions.runtimeConfig.language` 装进 `RuntimeConfig`）。
   即它不止活在这条透传链上，删除必然外溢到 bootstrap 的会话装配面（跨包）。
   （同一次 grep 还会命中 `tui/src/app-shiki-highlighter.ts:89-95` 的 `input.language`，
   那是语法高亮的语言标识，与本字段无关，不计入本链。）
2. 声明点也不止一处：`core/src/runtime/types.ts:231` 的 `RuntimeConfig.language?: string`
   与 `runtime/methods/config.ts:49` 的
   `Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">`
   必须同批改，否则正是 R4 要防的「留下一个写了没人读的入口」。
3. **协议面核实结果为空**：`packages/shared/src/**` 与
   `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/**` 没有 `language` 成员
   （grep 0 命中）；`updateConfig` 的三个调用方
   （`bootstrap/src/app/workflow-facade.ts:232`、`cli/src/prompt-command.ts:506`、
   `cli/src/tui-prompt-handler.ts:231`）都只传 `mode`。所以 R4 (ii) 里「触碰 v4 协议 schema」
   这一条**不是**本项的理由——真正的理由是第 1、2 条的跨包装配面与声明面。

**落地形态**：`context/types.ts:141` 上方加中文注释，写明 R4 要求的三件事
（当前无提示词消费方；按 R1 永远不该有；UI 语言的真实所有者是 `RuntimeConfig.ui.locale`，
`contracts/src/config/index.ts:281-283`）+ 类型不一致记录（裸 `string`，**不是** `UiLocale`，
不是 locale 的别名，不得成为第二个语言所有者）。写入点与透传点保持原样不动。

**留给后续所有者的删除清单**（将来要收敛这条悬空链，一次改完这 5 处 + 本 spec 的
「状态所有者」节与「接口」节）：`core/src/runtime/types.ts:231`、`core/src/context/types.ts:141`、
`core/src/runtime/methods/context.ts:138`、`core/src/runtime/methods/config.ts:49,59-63`
（`Pick` 成员与随之无意义的 `rebuildContextPrefix` 调用）、
`bootstrap/src/app/runtime-config.ts:137`。

### R3 `userVisibleMessage`：选 (ii) 保留名字 + 注释

(i) 改名要同批动 `contracts/src/tools/contract.ts:173` 与 42 处实例（含 9 个 workflow 工具与
`core/src/mcp/index.ts:206` 的 MCP 动态入口），跨包面且与本项「最小集合」冲突；名字误导由注释消解。
落地：`ToolCancellationPolicy.userVisibleMessage` 上方加中文注释，写明它是**模型面文本、恒英文**
（消费路径 `timeout.ts:106,157` → `createCoreError(ToolCancelled, …)` → tool result 的
`error.message`，即 R3 判定的双面文本），UI 本地化走**结构化字段 → i18n key** 映射、
查不到回落原始英文。**没有**选 (iii)：它不接 i18n，`@acode/i18n` 里没有它的键。

### R5 / P4-b UI 可见文案接入 i18n：接入点与最小集合

**核实结论：本方案改动路径上没有新增 CLI/TUI 用户可见文案。** 逐项核过本方案的工作区改动面
——`core/src/context/*`、`core/src/subagent/*`、`core/src/tool/handlers/agent.ts`、
`dynamic-workflow/*`、`dynamic-workflow-runtime/harness.ts`、
`bootstrap/src/acode-protocol-v4/command-inbox.ts`（注释-only）新增的英文字符串全部是
**模型面文本**或 **logger 消息**（R2 表：两者都不进 catalog；R7：日志不走 i18n）；
`packages/ui` 侧唯一的 UI 改动（subagent `maxTurns` 移除）已由该专项同批删掉
`en-US.ts` / `zh-CN.ts` 的两把键，符合 R5 的「双 locale 同批」。

所以 P4-b 的落地是**把 R3 指定的那条映射真正接上**（此前两套 catalog 里没有任何工具错误的键，
UI 侧只能直接展示英文原文），最小集合两个键：

| 键 | zh-CN | en-US | 依据 |
| --- | --- | --- | --- |
| `tui.errors.toolCancelled(detail)` | `工具取消：${detail}` | `${detail}`（纯透传） | `CoreErrorType.ToolCancelled`，即 `userVisibleMessage` 的 UI 端点 |
| `tui.errors.unknown` | `未知错误` | `Unknown error` | 事件里既取不到 message 也取不到 reason 时的兜底行，原本是硬编码英文 |

- **接入点**：`tui/src/app-event-data.ts:77` 的 `formatEventError(payload, errors)`
  （两处调用方：`app-events.ts:157` 的 ToolCallError 分支、`:270` 的 TurnError/ModelError 分支）。
  按 `error.type` 查表；表外**回落原始英文 message**（R3：错误种类是开放集合，catalog 是封闭集合，
  回落是必须的）。原来硬编码的 `"Unknown error"` 一并进 catalog（它是纯 UI 文本，
  没有对应的模型面原文，所以可以整条本地化）。
- **en-US 刻意做成纯透传**：既有显示逐字不变（零回归），本地化只发生在 zh-CN 侧。
- **zh-CN 用名词「工具取消」而不是断言「已取消」**：同一个 type 下也有「同步执行、无法取消」的
  原文（例 `tool/handlers/create-workflow.ts:397`），断言式标签会与 detail 自相矛盾。
  detail 一律原样保留英文——R3 禁止翻译 message 本身。
- **未接入的（记录为后续，跨包）**：run 级 workflow 错误在 v4 协议里只有 message 字符串
  （`packages/shared/src/acode-protocol-v4/workflow-row-meta.ts:26`；
  `workflow-runs-reducer.ts:526-560` 只取 `error.message`），**没有 code**，
  所以 D2 新增的 `AgentBudgetExceeded`（结构化 `details.{limit,cap,actual}` 齐全）
  在 TUI 卡片（`tui/src/app-workflow-card.tsx:158`）上无法按码本地化。要做需先给 run 级
  协议加结构化失败字段（节点级的 `workflow-workspace.ts:40` `{code,message}` 是既有先例），
  属跨包面变更，不在本项范围。

### 验收对照

新增 `apps/acode-cli/tests/prompt-language-policy.test.mjs`（12 条），覆盖：

| 场景 | 落地断言 |
| --- | --- |
| 1 模型面无 locale 依赖 | `language` 取 zh-CN / en-US / 缺席时 `systemMessages` 与 `metaUserAttachments` 逐字节相同；`core/src/context/**` 与 `core/src/subagent/**` 源码不 import `@acode/i18n`、不调 `resolveLocale`/`detectLocale`/`getACodeCopy`、不读 `.language`（同时钉住 R6 第 2、3 条） |
| 2 (ii) 保留生效 | `context/types.ts` 声明上方的注释含 R4 三件事 + 类型不一致记录；`core/src` 与 `bootstrap/src` 的 `.language` 命中文件集合冻结为三处（新消费方接上即红） |
| 3 双面文本按模型面处理 | 全部 `cancellation.userVisibleMessage` 实例无 CJK；经 `createErrorResult`（`tool/executor/errors.ts`）投影后 `error.message` 仍英文、`error.type === "tool_cancelled"`；UI 侧 zh-CN 取到本地化标签且保留英文 detail、表外类型回落原始英文、en-US 逐字不变、无 message 时走 `unknown` 键 |
| 4 双 locale 同批 | 两套 catalog 的键路径集合与每个键的 `typeof` 完全相同；新增两键在两套里同批在场 |
| 5 cache 前缀不分裂 | stable 前缀两块跨 `language` 取值逐字节相同，且每块各带 `ephemeral` cacheControl |
| 6 无新增 env 面 | CLI 全部源码里出现的 `ACODE_*` 名称集合中无 `LANG`/`LOCALE`/`I18N`/`TRANSLAT` 命中 |
| 7 验证命令 | 命令与实测结果记录在实施批次报告（spec 不复制易过期的命令输出） |

