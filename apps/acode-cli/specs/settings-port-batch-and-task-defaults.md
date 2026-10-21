# 设置面两项功能移植规格：子智能体批量编辑 + 新建任务默认值

- 状态：规格（R1 目标侧已由并发改动落地大半；R2 待实现）
- 日期：2026-10-20
- 源基线：`D:\Leo1\project\demo\anker-code`，HEAD `cf34bef97b064501055b0125969304b3027698ff`（2026-10-19），`zcode@3.14.3`
- 目标基线：`D:\AnkerCodes\QYDemo\ACode1`，HEAD `38b93920b85ec2527d9b7765a6b3192617b690f4`（2026-10-19），`acode@1.0.1`，`apps/acode-cli@0.16.9`
- 目标工作树快照：**2026-10-20 13:31:41 +0800**。快照期间目标仓 `packages/ui/src/settings/SubagentsSection.tsx` 正被并发修改（2314 → 2504 → 2546 行），批量测试与 i18n 同时落盘。本文以该快照为准；行号只作定位辅助，**以符号名为准**。
- 权威关联 spec：
  - `packages/ui/specs/subagent-batch-edit.md`（目标侧 R1 产品规则，已登记速度维度剥离、`maxTurns` 禁止回流、声明键批②六键透传）
  - `docs/specs/new-task-defaults.md`（源仓 R2 产品规则原文）
  - `apps/acode-cli/specs/settings-doc-style.md`（设置项文档三段式）
- 范围纪律：本文只登记规格；不修改任何代码，不修改源仓库。

> **2026-10-20 二次裁决（覆盖全文旧表述）**：speed 维度已在本批完整落地——shared `model-config`/`model-selection`、`model-option-map`、provider registry/completion/normalize/resolver/effective-selection、批量 Bar/Dialog/Apply、SubagentsSection 行内与表单、TaskDefaultsSection、composer 工具条全部恢复 speed；运行时 `speed-missing` / `speed-not-supported` 校验与源仓一致。本文中所有“speed 暂缓 / 剥离 / 不移植 / additive-only / 运行时不应用”的句子均作废，以本节与文末 §8 为准。

## 0. 裁决摘要

| 项 | 源仓现状 | 目标仓现状（13:31 快照） | 裁决 |
| --- | --- | --- | --- |
| 批量 Apply/Bar/Dialog 纯逻辑与组件 | 含 speed 维度 | 已存在，无 speed，Apply 已按目标仓适配（`SubAgentConfig` + 六键、无 `maxTurns`） | **保持目标适配，不整文件覆盖**；本轮不恢复 speed |
| 批量 SubagentsSection | 分组菜单、组/全局全选、整批一次推荐、行复选框、档位徽标 | 上述语义已基本落地；行复选框在 `batchApplying` 期间未禁用是最明确的剩余缺口 | 补齐禁用语义 + 测试；保留目标仓三条已登记差异（行点击选中、过滤裁剪、弹层目标重算） |
| 新建任务默认值 | 完整链路（shared schema → protocol → validation → TaskDefaultsSection → draft 初始化/刷新 → provider 默认档位取法 → i18n/测试） | **整条链路缺失**（`newTaskDefaults` / `defaultReasoningLevelPick` 全仓零命中） | 按本文 R2 全量移植；**存储 schema 保留 additive speed 字段**（默认 `null`，旧设置兼容），运行时不应用；适配目标仓 5 档权限模式（含 `dontAsk`） |
| speed 维度 | 源仓有（批量 + 新建任务默认值） | 目标仓无运行时能力：`modelSelectionSchema` strict `{ reasoningLevel }`、Registry `optionSpecs` 只有 `reasoningLevel`、无 speed-missing 运行时校验、无 `chat.toolbar.speed.*` 文案 | **批量编辑整体暂缓**（接口、控件、测试、文案都不恢复）；**新建任务默认值保留 additive storage schema**（`newTaskDefaults.speed` 可读写、默认 `null`），但运行时与 UI 不生效。待独立 speed spec 恢复 |
| 设置同步键 | `packages/shared/src/sync-scope.ts` 的 `SYNC_SETTINGS_INCLUDED_KEYS` 含 `newTaskDefaults` / `defaultReasoningLevelPick` | 目标仓无 `sync-scope.ts`，`git grep SYNC_SCOPE_IDS` 零命中 | **本批无同步键改动**；若未来移植设置同步，按源仓把两键列入 included keys |
| 版本/发布 | — | `release-it` + `dev → release/x.y.z → main` 流程 | 实现 PR 不改版本、不手工写 CHANGELOG；发布时按 minor 处理 |

---

## 1. R1 子智能体批量编辑

### 1.1 基线核对

| 文件 | 源仓 | 目标仓（快照） | 说明 |
| --- | --- | --- | --- |
| `packages/ui/src/settings/SubagentModelBatchApply.ts` | 214 行 | 170 行 | 差异仅为 speed 与目标仓适配 |
| `packages/ui/src/settings/SubagentModelBatchApply.test.ts` | 293 行 | — | 目标测试改落 `packages/ui/test/subagentModelBatchApply.test.ts`（213 行），已存在 |
| `packages/ui/src/settings/SubagentModelBatchBar.tsx` | 340 行 | 298 行 | 差异仅为 speed |
| `packages/ui/src/settings/SubagentModelBatchDialog.tsx` | 296 行 | 258 行 | 差异仅为 speed |
| `packages/ui/src/settings/SubagentsSection.tsx` | 2544 行 | 2546 行（并发编辑中） | 批量语义已大体对齐；剩余缺口见 1.5 |
| 批量接线测试 | 无独立文件 | `packages/ui/test/subagentBatchWiring.test.ts`（210 行） | 目标仓新增的源码契约测试 |
| 目标侧产品 spec | — | `packages/ui/specs/subagent-batch-edit.md`（126 行） | R1 产品规则权威面 |

并发改动提示：目标仓（快照）已包含 `Checkbox`/`DropdownMenu` 引用、`SubagentGroupBatchMenu`、`SubagentGroupSelectAll`、`applyBatchTarget`、整批一次 `recommendBatchStartPlan`、`batch.declined` 处理、档位徽标与全部新 i18n 键。**实施者应先跑本文 1.6 的测试再决定增量，避免重复覆盖。**

### 1.2 `SubagentModelBatchApply.ts` 逐差异与裁决

归一化（`@zcode/* → @acode/*`）后 diff 只剩以下语义差异：

| 差异 | 源仓 | 目标仓 | 裁决 |
| --- | --- | --- | --- |
| 返回类型 | `buildUserAgentBatchConfig` 返回内联对象类型，含 `maxTurns` | 返回 `SubAgentConfig`，无 `maxTurns`，透传声明键批②六键 `isolation/observer/observerMessage/observeSubagents/initialPrompt/hooks` | **保留目标仓**。`maxTurns` 已按 `subagent-maxturns-policy.md` 全链删除，禁止回流；六键透传是目标仓既有验收 |
| `SubagentModelBatchValue` | 有 `speed?: string` | 无 `speed` | **保留目标仓**（speed 暂缓） |
| speed 投影函数 | `resolveSubagentSpeedOptionState` / `isSubagentSpeedInvalid` / `ModelSelectionViewLike` | 无 | **不移植**，随 speed spec 一起恢复 |
| 定义文件载荷 | `options` 可写 `speed` | 只写 `reasoningLevel` | **保留目标仓** |
| doc 注释 | 3 处提到 speed / `toSubagentModelSelection` | 已改写为 `completeNewModelSelection` 与剥离理由 | **保留目标仓**注释，不覆盖 |

结论：**本轮 `SubagentModelBatchApply.ts` 无需功能性改动**。唯一应补的是测试覆盖（见 1.6）。

### 1.3 `SubagentModelBatchBar.tsx` 逐差异与裁决

除 `@zcode → @acode` 命名外，全部差异都是 speed 维度：

1. `SubagentSpeedField` 导入、`speed` state、`speedState`、`speedRequired`。
2. `applyDisabled` 增加 `speedRequired`。
3. `handleModelValueChange` 读取/回传 `completed.options.speed`。
4. `SubagentReasoningField.onValueCommit` 的 `onValueChange` 带 `speed`。
5. 新增 speed 控件与 `settings.subagents.batch.speedRequired` 提示。
6. 「设为继承默认」重置 `setSpeed(undefined)` 并带 `speed` 判空。
7. 应用回调带 `speed`。

裁决：**不移植以上任何一项**；目标仓当前实现即目标态。其余逻辑（模型可用性判定、触发器标签、结果汇总、进度、退出）与源仓一致，不做改写。

### 1.4 `SubagentModelBatchDialog.tsx` 逐差异与裁决

与 Bar 同理，差异全部是 speed：speed state/投影/必选校验/控件/确认按钮 disabled/应用回调。裁决：**不移植**。其余（继承默认 footer action、ModelConfigSelect 标签可见性修复、档位投影、未支持档位提示、`common.cancel`/`common.apply`）与源仓一致。

### 1.5 `SubagentsSection.tsx` 逐 hunk 语义与裁决

下表按「语义」而非行号组织。`源` 列为源仓当前实现，`目标` 列为 13:31 快照，`裁决` 为最终要求。

| # | 语义 | 源仓 | 目标快照 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | 批量入口 TID | 从 `@acode/shared` 导入 `TID_SUBAGENT_BATCH_TRIGGER` / `TID_SUBAGENT_BATCH_ROW_CHECKBOX` / `TID_SUBAGENT_GROUP_MENU_TRIGGER` | 组件内局部字面量（5 个，含两个 select-all） | **保留局部字面量**。现有 `subagentBatchWiring.test.ts` 已按局部字面量钉住；目标 `test-ids.ts` 的共享约定作为后续债务记录。若队长决定统一，改动面为 `packages/shared/src/test-ids.ts` + 组件 import + 该测试，三处必须同批 |
| 2 | 分组「…」菜单 | `SubagentGroupBatchMenu`：统一设置模型…（N）/ 本组恢复继承默认（N）；无可批量行或 applying 时禁用 | 已存在，`renderGroupHead` 内使用 | **已对齐**，保留 |
| 3 | 分组三态全选 | `SubagentGroupSelectAll` + `resolveGroupBatchCheckState`；批量模式替换分组菜单 | 已存在 | **已对齐**，保留 |
| 4 | 全局全选 | 搜索栏「全选」复选框，范围为当前过滤可见的全部可批量行；三态 | 已存在（`TID_SUBAGENT_BATCH_SELECT_ALL`） | **已对齐**，保留 |
| 5 | 行复选框原语 | 共享 `Checkbox`，`data-testid=subagent-batch-row-checkbox-<name>` | 自定义 `BatchRowCheckbox`（`<button role="checkbox">`），带同一 TID | **保留自定义原语**：目标 spec R1 要求整行可点击，自定义 button 与 `settingsResourceRowInteraction` 的 `INTERACTIVE_SELECTOR` 已兼容；改 Radix Checkbox 无功能收益 |
| 6 | 行复选框禁用（**缺口**） | `batchCheckboxDisabled={batchApplying \|\| !isBatchApplicableAgent(agent)}`，checkbox `disabled` | **无** `batchCheckboxDisabled`；`batchApplying` 期间行仍可切换选中，行点击也仍生效 | **必须补齐**：新增 `batchCheckboxDisabled` prop 并传给 `BatchRowCheckbox` 的 `disabled`；`checkboxVisible` 改为 `batchMode && isBatchApplicableAgent(agent) && !batchApplying`，使行点击在 applying 期间失效；同时在 `handleBatchCheckChange` 入口增加 `if (batchApplying) return` 防御。行交互在非 applying 的 batchMode 下仍保留（见 #7） |
| 7 | 行点击语义 | 批量模式取消行点击，只有复选框可切换 | 行点击切换选中（`settingsResourceRowInteraction`） | **保留目标仓**。`packages/ui/specs/subagent-batch-edit.md` R1 明确「行点击=切换选中」，属目标产品规则；源仓这是重构副作用，不覆盖 |
| 8 | 行高亮/栅格 | `batchChecked && "bg-selected"`；batchMode 固定四列 | 已存在 `bg-selected`，栅格仍按 `checkboxVisible` 分支 | **已对齐**，保留；不改纯视觉类名 |
| 9 | 定义文件行档位徽标 | `thoughtLevelLabelId` 投影为徽标，未知值原样 | 已存在 | **已对齐**，保留（source 的 speed 徽标与 `rowSpeedMissing` 不移植） |
| 10 | 批量状态所有者 | `SubagentsSection` 持有 mode/selected/applying/progress/result/dialog target | 同 | **已对齐**；Bar/Dialog 保持无状态受控 |
| 11 | 选中集裁剪 | 源仓**已删除**裁剪 effect：选中 id 可跨过滤保留，计数/应用只取可见交集 | 保留 effect：过滤/作用域变化时删除不可见 id | **保留目标仓**（目标 spec R6 + 接线测试明确要求）。差异登记为已知偏差；理由：避免隐藏选择在清除过滤后被意外批量应用，也避免跨作用域残留 |
| 12 | 单行落盘 | `applyBatchTarget`：override 路径复用 `handleModelOverrideChange`；definitionFile 路径 `updateAgent(buildUserAgentBatchConfig)` | 已存在且语义一致 | **已对齐**，保留。新增写入通道一律禁止 |
| 13 | 整批推荐 | `modelSelection` 非空时循环外调用一次 `recommendBatchStartPlan`；先合并顶层 `thoughtLevel`；拒绝时整批不写盘，结果按失败列出 `batch.declined` | 已存在 | **已对齐**，保留 |
| 14 | 应用循环 | 按列表顺序串行，单行失败不中断；结束清空 progress、`operatingAgentId`；成功数 > 0 才 refresh | 已存在 | **已对齐**，保留 |
| 15 | 弹层目标集 | 打开时快照 `{groupKey, groupName, agents}`，应用时对快照 `resolveBatchApplyTargets` | 按当前 `groupedAgents`/`pluginGroups` 重新计算 | **保留目标仓**：重算能保证定义文件透传基线是最新行投影，且组被刷新删除的行不会误写；与源仓的差异登记 |
| 16 | 入口/退出 | 入口 `batch.entry`；无批量行时不显示；applying 时禁用退出/搜索/新建 | 已对齐（`batch.entry`、`TID_SUBAGENT_BATCH_TRIGGER`） | **已对齐**，保留 |
| 17 | 操作条接线 | `selectedCount=可见已选数`；`disabled=refreshing`；`onValueChange` 清空结果；`onApply` 走 `applyBatchModelOverride` | `selectedCount=batchTargets.length`；`disabled=loading \|\| refreshing`；`onApply` 走 `applyBatchModelOverride` | **已对齐**；`loading` 额外禁用属防御，保留 |
| 18 | speed 维度 | 行内 speed 控件、form speed、badges、`toSubagentModelSelection` speed 参数、`speedMissing` | 无 | **不移植**（见 0 节裁决） |
| 19 | 与批量无关的源仓差异 | 内置目录 bundled 展名、`resolveSubagentRowDisplayName`（C-061）、`SubagentColorDot`、表单保存载荷内联、`ZCODE_AGENT_PROVIDER` 命名、触发器 truncate 类名 | 目标仓有各自更新版本（bundled 目录、`buildSubagentSaveConfig` 六键、`ACODE_AGENT_PROVIDER`） | **一律不移植**，避免覆盖目标仓既有能力 |

### 1.6 测试与 i18n 要求

- 纯逻辑：`packages/ui/test/subagentModelBatchApply.test.ts` 已覆盖应用集、写路径、分组成员全选、三态、结果汇总、继承判空、定义文件载荷与六键透传、Markdown 往返。**保留**；speed 用例不恢复。
- 接线：`packages/ui/test/subagentBatchWiring.test.ts` 已覆盖单点写路径、行点击/裁剪、分组菜单、组/全局全选、`thoughtLevel` 合并、推荐只在循环外一次、speed 不回流、i18n 成对、TID 契约。**保留**。
- **新增接线断言**：行复选框在 `batchApplying` 时禁用（`batchCheckboxDisabled` 存在并传给 `disabled`），`handleBatchCheckChange` 有 applying 守卫。
- i18n：目标 `en-US.ts` / `zh-CN.ts` 已含 `batch.entry`、`batch.declined`、`batch.groupMenu.*`、`batch.selectAll.label`、`batch.groupSelectAll.*`、`batch.rowToggleAria`、`batch.bar.*`、`batch.result.*`、`batch.dialog.{title,scope,thoughtLevel}`。**不添加** `batch.dialog.speed`、`batch.speedRequired`、`row.speedMissing`；旧的 `batch.enter` / `batch.groupAction` / `batch.groupToggle` 不再使用（快照中已清零）。
- TID 契约：现有 5 个局部字面量必须与 `packages/ui/specs/subagent-batch-edit.md` 的接口节一致；共享 `TID_SUBAGENT_BATCH_BAR/APPLY/DIALOG/MODEL_TRIGGER` 继续从 `@acode/shared` 导入。

### 1.7 R1 冲突点清单（实施时必须显式选择）

1. **行点击选中 vs 仅复选框**：保留目标仓行点击（已裁决）。
2. **过滤裁剪 vs 跨过滤保留**：保留目标仓裁剪（已裁决）。
3. **弹层快照 vs 当前分组重算**：保留目标仓重算（已裁决）。
4. **局部 TID vs 共享 TID**：保留局部（已裁决），共享化作为后续债务。
5. **批量 speed**：整体暂缓，任何 PR 不得静默部分恢复（接线测试已钉住零出现）；与 R2 的 additive storage 字段无关。
6. **`maxTurns`**：不得随源仓内联返回类型回流。

---

## 2. R2 新建任务默认值

### 2.1 数据所有者与事件顺序

- **唯一持久化所有者**：`AppSettings.newTaskDefaults`（`setting.json`，经 `settingService` 读写）。
- **唯一 UI 所有者**：`V4ComposerDraft`（下一次提交的配置）。设置只在 `sessionId === null` / `initializeFromNewTask` 的初始化路径注入一次。
- **「上次使用」唯一来源**：`lib/composerRecent.ts` 的 `readComposerRecent`。本设置不复制、不缓存。
- **默认档位取法的独立设置**：`AppSettings.defaultReasoningLevelPick`，不受 `newTaskDefaults.enabled` 控制，作用于「跟随默认」的推理强度：新建任务初始化、空草稿目录刷新、用户主动切换模型。
- **存储类型与运行时投影分离**：`NewTaskDefaults`（`AppSettings.newTaskDefaults`）包含 additive 的 `speed: string | null`；运行时投影 `ResolvedNewTaskDefaults` **不含 `speed`**。
- **纯函数边界**：
  - `resolveNewTaskDefaults(settings)`：归一化已固定项；开关关闭或运行时三项（mode/model/reasoningLevel）全空返回 `null`；`speed` 不参与运行时判定（speed-only 固定等价于未固定）。
  - `applyNewTaskDefaults(view, selection, defaults)`：按目标模型 Option Spec 叠加固定档位，不触碰 IO；只应用 `reasoningLevel`，不向 `ModelSelection.options` 写 `speed`。
  - `pickReasoningLevel` / `completeNewModelSelection(registry, selection, { reasoningLevel })`：默认档位取法与别名阶梯。
- **所有者关系不新增第二份写入路径**：设置页只调 `useSettings().update()`；草稿只由 `V4ComposerDraft` 持有。

```text
setting.json
  -> AppSettings.newTaskDefaults / defaultReasoningLevelPick   (唯一持久化所有者)
  -> useSettings() 读取
  -> useDraftConfigControl (sessionId === null 初始化，等设置快照 settled)
       ├─ 固定模型? -> 作为 resolveDraftInitialModelSelection 的种子
       └─ 否则     -> readComposerRecent 的模型身份
  -> resolveDraftInitialModelSelection (既有回落链: 固定/Recent -> preferred -> 首个模型)
  -> applyNewTaskDefaults              (固定档位叠加 + validateModelSelectionOptions)
  -> V4ComposerDraft                   (唯一 UI 所有者)
  -> 用户改选 -> modelSelectionEdited=true -> 目录刷新不覆盖
  -> 提交时冻结 ModelSelection         (既有链路，不改)
```

### 2.2 shared schema（新增文件）

新增 `packages/shared/src/new-task-defaults.ts`，以源仓同名文件为母本做三处适配：

1. 导入路径 `./zcode-protocol-v4/submission.js` → `./acode-protocol-v4/submission.js`。
2. **保留 `speed` 字段（additive storage schema）**：`speed: nonEmptyString.nullable().default(null)` 进入 `newTaskDefaultsSchema`、`NewTaskDefaults` 类型与 `DEFAULT_NEW_TASK_DEFAULTS`。它只用于设置读写与跨版本兼容，运行时不消费；目标仓 `ModelSelection.options` 是 strict `{ reasoningLevel }`，因此**不得**把该值写入 `ModelSelection`。加字段而非删字段的理由：旧 `setting.json` 无需迁移即可读，未来独立 speed spec 落地时无需再改存储 schema。
3. `NEW_TASK_DEFAULT_MODE_IDS` 按目标仓 5 档权限模式取 `build/edit/yolo/dontAsk`（源仓为 3 档）。

要求形态：

```ts
const nonEmptyString = z.string().trim().min(1);

export const newTaskDefaultModelSchema = z
  .object({ providerId: nonEmptyString, modelId: nonEmptyString })
  .strict();

export const newTaskDefaultsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: submissionModeSchema.nullable().default(null),
    model: newTaskDefaultModelSchema.nullable().default(null),
    reasoningLevel: nonEmptyString.nullable().default(null),
    // additive：仅存储/兼容；运行时 applyNewTaskDefaults 不消费。
    speed: nonEmptyString.nullable().default(null),
  })
  // 绿色版与 dev 版共用 setting.json：未知字段丢弃不报错。
  .strip();

export const DEFAULT_NEW_TASK_DEFAULTS: NewTaskDefaults = {
  enabled: false,
  mode: null,
  model: null,
  reasoningLevel: null,
  speed: null,
};

// 目标仓权限模式含 dontAsk；plan 是 composer 独立勾选项，不可固定。
export const NEW_TASK_DEFAULT_MODE_IDS = ["build", "edit", "yolo", "dontAsk"] as const;
```

`normalizeNewTaskDefaultMode(mode)`：`plan` / 空 → `null`；其余必须在 `NEW_TASK_DEFAULT_MODE_IDS` 内，越界按 `null` 处理（不得写入不可固定的值）。

从 `packages/shared/src/index.ts` 追加 `export * from "./new-task-defaults.js";`（与源仓 index 同形态）。

### 2.3 protocol 与 validation

1. `packages/shared/src/protocol.ts` 顶部增加 `import type { NewTaskDefaults } from "./new-task-defaults.js";`，`AppSettings` 增加：
   - `newTaskDefaults?: NewTaskDefaults;`
   - `defaultReasoningLevelPick?: "first" | "highest" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";`
   位置放在接口尾部（`acodeEndpointOrigin` 附近），与源仓字段顺序一致。`NewTaskDefaults` 由 schema 推导，自动包含 additive `speed: string | null`；对象 schema 与 patch schema 同源，不需要再单独登记 `speed`。
2. `packages/shared/src/validationAppSettings.ts`：
   - 顶部导入 `newTaskDefaultsSchema` / `DEFAULT_NEW_TASK_DEFAULTS`。
   - 对象 schema（`appSettingsObjectSchema`）增加：
     ```ts
     newTaskDefaults: newTaskDefaultsSchema.default(() => ({ ...DEFAULT_NEW_TASK_DEFAULTS })),
     defaultReasoningLevelPick: z
       .enum(["first", "highest", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
       .optional(),
     ```
     外层 `.default()` 必须保留：旧 `setting.json` 缺 key 时只有外层 default 生效；内层字段 default 只在对象存在时补全。
   - patch schema（`appSettingsPatchSchema`）增加：
     ```ts
     newTaskDefaults: newTaskDefaultsSchema.optional(),
     defaultReasoningLevelPick: z.enum([...同上...]).optional(),
     ```
     patch 语义是**整份对象替换**：设置页每次提交完整对象（含 additive `speed`，保持已存值），避免半份 patch 清空未提及项。
3. 目标仓 `settingService` 的「只写显式键」持久化（`normalizeSettingsPatch` + 显式 key 集合）决定：新字段只会在设置页显式提交时落盘，不会因 schema 默认值被冻结进用户配置。**不要给 `defaultReasoningLevelPick` 加 `.default()`**。

### 2.4 同步键

- 源仓 `packages/shared/src/sync-scope.ts` 的 `SYNC_SETTINGS_INCLUDED_KEYS` 含 `newTaskDefaults`、`defaultReasoningLevelPick`。
- 目标仓**不存在** `sync-scope.ts`，`git grep "SYNC_SCOPE_IDS|SYNC_SETTINGS_INCLUDED"` 零命中。本批**无同步改动**。
- 若后续移植「设置导出/同步」，必须把两键加入 included keys（它们是不含凭据的跨机器用户偏好），否则同步后新机器丢设置。

### 2.5 设置页分区

1. `packages/ui/src/lib/settingsNavigation.ts`
   - `SettingsSectionId` 联合类型加入 `"taskDefaults"`。
   - `isSettingsSectionId()` 加入 `value === "taskDefaults"`。
   - 不加入 `HIDDEN_SETTINGS_SECTIONS`。
2. `packages/ui/src/settings/settingsPageConfig.ts`
   - 从 `lucide-react` 引入 `SlidersHorizontal`。
   - `BASE_SETTINGS_SECTIONS` 在 `modelProvider` 之后插入：
     ```ts
     {
       id: "taskDefaults",
       icon: SlidersHorizontal,
       titleId: "settings.taskDefaults.title",
       groupId: "basics",
     }
     ```
     位置理由：固定的是同一批模型/权限/档位选择，紧跟「模型服务」。
3. `packages/ui/src/SettingsPage.tsx`
   - 引入 `TaskDefaultsSection`。
   - 在 `activeSection === "modelProvider"` 分支之后、`memory` 分支之前增加：
     ```tsx
     ) : activeSection === "taskDefaults" ? (
       <ServiceProvider services={localHostServices}>
         <TaskDefaultsSection
           workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
           workspaceIdentity={activeWorkspaceIdentity}
         />
       </ServiceProvider>
     ```
   - 目录与「跟随默认」的最近提交都按**本地 Host + 当前 workspace**读取，与 `ModelProviderSection` 同口径。
4. `packages/ui/src/settings/SettingsPageParts.tsx`
   - `SettingsRow.controlLayout` 扩展 `"default" | "wide" | "model"`。
   - `"model"` 使用 `sm:grid-cols-[minmax(0,1fr)_minmax(192px,26rem)]`（源仓形态）；只加这一档，不改默认/`wide` 档的既有栅格。

### 2.6 草稿链实现要求

#### 2.6.1 `packages/ui/src/lib/newTaskDefaults.ts`（新增）

以源仓 72 行文件为母本；**运行时投影删除 `speed`**（存储 schema 仍保留 additive 字段）：

```ts
export interface ResolvedNewTaskDefaults {
  readonly mode: SubmissionMode | null;
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  readonly reasoningLevel: string | null;
}
```

- `resolveNewTaskDefaults(settings)`：`!enabled` → `null`；逐项归一化（`plan` → `null`）；运行时三项全空 → `null`，保证关闭时与升级前完全同路径。`settings.speed` 被忽略——即使只有 speed 固定，也返回 `null`（运行时不生效）。
- `applyNewTaskDefaults(view, selection, defaults)`：
  - `selection` 或 `defaults` 为空 → 原样返回；
  - 目标模型不在 view 中 → 原样返回；
  - 固定档位为空或等于当前值 → 返回**同一对象**；
  - 否则构造候选 selection（保留 provider/model，仅替换 `reasoningLevel`），用 `validateModelSelectionOptions(model, candidate).ok` 校验；不通过则返回原 selection（**不回写设置**，保留用户原意图）。

#### 2.6.2 `packages/provider/src/model-selection-config.ts`

以源仓同名文件为母本，删除 speed：

1. 新增 `DEFAULT_REASONING_LEVEL_PICK_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const` 与 `DefaultReasoningLevelPick`。
2. 新增厂商别名阶梯 `REASONING_LEVEL_RANK`（`disabled/none/nothink/off` → 0，`on/enabled/medium` → 3，`extra-high/xhigh` → 5，`ultra` → 7）与 `pickReasoningLevel(values, pick)`：
   - `undefined`/`"first"` → 第一项；
   - `"highest"` → 最后一项；
   - 具体档位 → 精确命中，否则最近更低档，再否则最近更高档，最后回落第一项。
3. `completeNewModelSelection(registry, selection, defaults: { reasoningLevel?: DefaultReasoningLevelPick } = {})`：返回 `{ providerId, modelId, options: { reasoningLevel } }`（目标仓无 speed）；模型不存在或无档位 → `undefined`。
4. 不改 `normalizeModelSelection` 的既有语义（目标仓只校验 reasoningLevel）。
5. 其余调用点保持两参数，不强制传入 pick。

#### 2.6.3 `packages/ui/src/lib/composerRecent.ts`

`resolveDraftInitialModelSelection(view, recent, reasoningPick?)` 增加第三参：

- 模型目录未就绪：原样返回 recent（既有）。
- recent 命中当前目录：**只用 recent 的模型身份**，档位由 `completeNewModelSelection(view, recent, { reasoningLevel: reasoningPick })` 重新取默认（源仓规则：最近提交只决定模型，不继承上一任务档位）。这与目标仓当前「保留 recent 中有效档位」的行为不同，是本移植的**有意的行为变更**。
- recent 不在目录 / 无 recent：按 `preferredSelection` → 目录首个模型 的顺序用同一 completion 取默认。
- `invalidated` 语义保持：recent 存在但不可用 → `true`。

#### 2.6.4 `packages/ui/src/v4/composer/newTaskDraft.ts`

以源仓同名文件为母本，删除 speed 与 `seedImportedSessionDraft`（目标仓无首次分享导入消费者，`git grep "initializeFromNewTask: true"` 仅见 store 读取面）：

- `initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, view, settings?, reasoningPick?)`：
  - `resolveNewTaskDefaults(settings)`；
  - 模型种子 = `defaults?.model ?? recent?.modelSelection ?? null`；
  - `resolveDraftInitialModelSelection(view, seed, reasoningPick)`；
  - `mode = defaults?.mode ?? (recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"))`；
  - `planEnabled: false`；
  - `modelSelection: applyNewTaskDefaults(view, resolved.selection, defaults) ?? undefined`；
  - `initializeFromNewTask: undefined`。
- 新增 `refreshUneditedNewTaskDefaults(draft, view, settings?, reasoningPick?)`：
  - 硬门禁：`draft.modelSelectionEdited || draft.text.trim()` → 原样返回；
  - 重新解析并叠加固定档位；
  - 仅当 selection 为空、模型身份变化、或档位变化时才返回新对象；相等时返回原对象，避免无意义写盘。

#### 2.6.5 `packages/ui/src/v4/composer/composerDraftStore.ts`

- `V4ComposerDraft` 增加 `modelSelectionEdited?: true`。
- 读取归一化：`value.modelSelectionEdited === true` 时保留该字段。
- 空草稿判定不需要因该字段改变（与源仓一致）；它只作为「用户已显式改选」标记。

#### 2.6.6 `packages/ui/src/v4/composer/useDraftConfigControl.ts`

1. 引入 `useServices`、`refreshUneditedNewTaskDefaults`。
2. 设置快照门禁：
   ```ts
   const { settings: sharedSettings, loading: sharedSettingsLoading } = useSettings();
   const hasSettingService = Boolean(useServices().settingService);
   const newTaskSettingsSettled =
     sharedSettings !== null || !sharedSettingsLoading || !hasSettingService;
   ```
   新任务初始化条件从 `modelSelectionView !== null` 改为 `modelCatalogView !== null && newTaskSettingsSettled`。
   理由：初始化只消费一次 `newTaskDefaults`（`mode` 即初始化标记），若设置晚到会永久错过已固定的 mode/model，且结果写入 localStorage 跨重启粘住。
3. `initializeNewTaskDraft(...)` 传入 `sharedSettings?.newTaskDefaults` 与 `sharedSettings?.defaultReasoningLevelPick`。
4. 初始化块之后增加：
   ```ts
   if (sessionId === null && draft.mode && modelCatalogView) {
     draft = refreshUneditedNewTaskDefaults(
       draft,
       modelCatalogView,
       sharedSettings?.newTaskDefaults,
       sharedSettings?.defaultReasoningLevelPick,
     );
   }
   ```
5. `updateDraftConfig` 的 `updateComposerDraft` 回调写入 `modelSelectionEdited: true`（任何用户显式改选都置位）。
6. `handleDraftSelectModel` 调用 `completeNewModelSelection(modelCatalogView, parsedSelection, { reasoningLevel: sharedSettings?.defaultReasoningLevelPick }) ?? parsedSelection`。这会把目标仓原先「Reasoning 保持为空等待用户选择」的行为改为「按默认档位取法自动填充」；这是 `defaultReasoningLevelPick` 功能的定义，需在实现 PR 中显式说明。
7. speed 相关（`handleDraftSelectSpeed`、`speedFallback`、`completeNewModelSelection` 的 speed 输出）**不移植**。

#### 2.6.7 固定档位叠加优先级

1. `newTaskDefaults.enabled === true` 且 `reasoningLevel` 非空 → **固定值优先**于 `defaultReasoningLevelPick`。
2. 固定值必须通过目标模型 `validateModelSelectionOptions`；不通过 → 回落目标模型默认档位（`defaultReasoningLevelPick` 解析结果），设置值不修改。
3. 固定模型身份作为解析种子；模型被移除 → 走既有回落链（`preferredSelection` → 目录首个模型），不报错。
4. 未固定的 mode/model 保持既有语义：mode/model 沿用最近一次已接纳提交；推理强度用 `defaultReasoningLevelPick`（缺省 `first`）。
5. 用户在草稿内改选后（`modelSelectionEdited`）→ 目录刷新、设置变更都不得覆盖。
6. 已存在会话/已提交会话完全不受影响；Root 草稿在提交被接纳并提升为真实会话后，下一次新建才重新初始化。

### 2.7 speed 的 additive schema 与运行时边界

- **存储层（保留）**：`newTaskDefaultsSchema` / `NewTaskDefaults` / protocol / patch schema 保留 `speed: string | null`，默认 `null`；旧 `setting.json` 缺该字段按 `null` 读取，写入仍遵守「只写显式键」，不会因 schema 默认值物化。
- **运行时（不消费）**：`ResolvedNewTaskDefaults` 不含 `speed`；`resolveNewTaskDefaults` 忽略 speed（speed-only 固定等价于未固定）；`applyNewTaskDefaults` 只应用 `reasoningLevel`，**不向 `ModelSelection.options` 写 `speed`**（目标仓 `modelSelectionSchema` strict `{ reasoningLevel }`）。
- **UI（t-4）**：速度行**默认隐藏**；若实现选择「禁用展示」，需补 `settings.taskDefaults.speed` / `.speedDescription` 两键并显示「暂不可用」原因，且控件不可交互。无论哪种形态，都不得声称速度会生效。
- **批量编辑**：speed 仍整体暂缓（见 1.2–1.5、1.7），与新建任务默认值的 additive schema 相互独立；不得因 storage 字段存在就恢复批量 speed 控件。
- 若未来落地 speed spec，增量点为：`applyNewTaskDefaults` 的第二个 `applyFixedOption(..., "speed")` + UI 行启用 + provider completion 的 speed 首项 + 批量 speed 恢复 + i18n；存储 schema 无需再改。

### 2.8 边界与失败模式

- 设置读取失败（loading 结束且无快照）：按「未固定」初始化，不阻塞新任务草稿。
- 设置写失败：控件随下一次快照回退；`TaskDefaultsSection` 用 toast 显示可读原因。
- 非乐观 update：`TaskDefaultsSection` 必须用 `pendingDefaultsRef` 累积在途提交的完整对象；快照引用变化时以服务端快照重新同步，避免第二次提交把第一次改动回滚。
- 设置快照未就绪时整章不可交互（`settings?.newTaskDefaults !== undefined` 为门禁），否则会把已固定项静默清空。
- 目录未就绪：推理强度行禁用并显示 `settings.taskDefaults.catalogUnavailable`；mode/model 两行仍可用。
- speed-only 固定：`enabled: true, speed: "fast"` 且其余为空 → `resolveNewTaskDefaults` 返回 `null`，新任务行为与开关关闭一致；设置页速度行保持隐藏/禁用。
- `plan` 永不写入设置；存储中出现时归一化为 `null`（等同于「跟随默认」）。

---

## 3. R3 UI 落点与 i18n

### 3.1 文件落点

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `packages/shared/src/new-task-defaults.ts` | 新增 | schema + 默认值 + mode 归一化 |
| `packages/shared/src/index.ts` | 修改 | `export * from "./new-task-defaults.js";` |
| `packages/shared/src/protocol.ts` | 修改 | `AppSettings` 两字段 |
| `packages/shared/src/validationAppSettings.ts` | 修改 | 对象 schema + patch schema |
| `packages/provider/src/model-selection-config.ts` | 修改 | pick 阶梯 + completion 第三参 |
| `packages/ui/src/lib/newTaskDefaults.ts` | 新增 | 纯函数 |
| `packages/ui/src/lib/composerRecent.ts` | 修改 | `reasoningPick` 第三参 |
| `packages/ui/src/v4/composer/newTaskDraft.ts` | 修改 | 初始化 + 刷新 |
| `packages/ui/src/v4/composer/composerDraftStore.ts` | 修改 | `modelSelectionEdited` |
| `packages/ui/src/v4/composer/useDraftConfigControl.ts` | 修改 | 设置门禁与接线 |
| `packages/ui/src/settings/TaskDefaultsSection.tsx` | 新增 | 设置章节 |
| `packages/ui/src/SettingsPage.tsx` | 修改 | import + 分支 |
| `packages/ui/src/lib/settingsNavigation.ts` | 修改 | section id |
| `packages/ui/src/settings/settingsPageConfig.ts` | 修改 | 侧栏条目 |
| `packages/ui/src/settings/SettingsPageParts.tsx` | 修改 | `controlLayout="model"` |
| `packages/ui/src/v4/composer/modelTriggerDisplay.ts` | 修改 | 新增 `splitModelTriggerLabelParts` |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 修改 | 两套 locale 键组 |

`TaskDefaultsSection` 相对源仓的适配：

1. 速度行不接入运行时：默认隐藏；若实现选择「禁用展示」，则渲染只读的 `settings.taskDefaults.speed` 行并置灰。`speedValues` / `speedOptions` / `speedLabel` 与 `commit` 的 speed 分支不接入，`applyNewTaskDefaults` 也不消费 `defaults.speed`。
2. 删除 `runUserActionAsync`（目标仓 `git grep runUserActionAsync` 零命中，无 telemetry 子系统）；直接 `await update({...})`，`catch` 时 toast。
3. 保留 `pendingDefaultsRef` 的整份对象累积语义。
4. `SELECT_TRIGGER_CLASSNAME` / `MODEL_TRIGGER_CLASSNAME` / `MODEL_TRIGGER_LABEL_CLASSNAME` 原样保留（依赖新增的 `splitModelTriggerLabelParts`）。
5. `optionSourceModel` 的种子顺序：固定模型 → `readComposerRecent` → `view.preferredSelection` → 目录首个模型。
6. 推理档位选项用 `withStoredValue` 把已固定但当前模型不支持的值保留在列表里（否则 Radix Select 显示空，像设置丢了）。
7. 模式选项用 `NEW_TASK_DEFAULT_MODE_IDS`（含 `dontAsk`），标签经 `getACodeAgentAvailableModes()` + `getModeOptionDisplayLabel(intl, ACODE_AGENT_PROVIDER, entry)`。
8. 顶部「默认推理强度」`Select` 不受 `enabled` 开关控制；`first` / `highest` / 具体档位。
9. 章节结构：第一个 `SettingsGroupCard` 放默认推理强度；第二个放总开关；第三个放 mode/model/reasoning 三行。

### 3.2 批量编辑 locale 键（已完成态，保留）

`settings.subagents.batch.entry`、`.declined`、`.rowToggleAria`、`.groupMenu.aria`、`.groupMenu.setModels`、`.groupMenu.resetInherit`、`.selectAll.label`、`.groupSelectAll.label`、`.groupSelectAll.aria`、`.bar.selected`、`.bar.progress`、`.bar.setInherit`、`.bar.apply`、`.bar.exit`、`.result.success`、`.result.partial`、`.result.failedNames`、`.dialog.title`、`.dialog.scope`、`.dialog.thoughtLevel`。

禁止新增/恢复：`.dialog.speed`、`.speedRequired`、`settings.subagents.row.speedMissing`、`chat.toolbar.speed.*`（接线测试已钉住）。

### 3.3 新建任务默认值 locale 键（两套都必须）

`settings.taskDefaults.title`、`.enabled`、`.enabledDescription`、`.mode`、`.modeDescription`、`.model`、`.modelDescription`、`.reasoningLevel`、`.reasoningLevelDescription`、`.followDefault`、`.reasoningPick`、`.reasoningPickDescription`、`.reasoningPick.first`、`.reasoningPick.highest`、`.catalogUnavailable`。

- 速度行默认隐藏：不要求 `.speed` / `.speedDescription`。若实现选择「禁用展示」，必须补这两键（文案说明暂不可用），且控件不可交互。
- `enabledDescription` / `reasoningLevelDescription` 只描述 mode / model / reasoning，不得声称速度会生效。
- 侧栏标题复用 `settings.taskDefaults.title`。
- 两套 locale 同步添加；目标仓有多个「双语键成对」测试模式（如 `packages/ui/test/scriptWorkflowSurface.test.ts`），建议新增同等测试。

---

## 4. R4 测试映射与验收场景

### 4.1 测试映射

| 源仓测试 | 目标仓落点 | 动作 |
| --- | --- | --- |
| `packages/ui/src/settings/SubagentModelBatchApply.test.ts`（293 行） | `packages/ui/test/subagentModelBatchApply.test.ts`（已存在 213 行） | 保留；删除 speed 用例；保留六键透传、Markdown 往返 |
| 无（目标仓新增） | `packages/ui/test/subagentBatchWiring.test.ts`（已存在 210 行） | 保留；新增行复选框 applying 禁用断言 |
| `packages/ui/src/lib/newTaskDefaults.test.ts`（136 行） | `packages/ui/test/newTaskDefaults.test.ts` | 新增；运行时用例忽略 speed，增加 `dontAsk` 归一化、`plan → null`、speed-only 固定等价未固定、不支持档位保留原值、固定值等于默认值返回同一对象 |
| `packages/ui/src/lib/composerRecentReasoningPick.test.ts`（82 行） | `packages/ui/test/composerRecentReasoningPick.test.ts` | 新增；删除 speed 断言；保留 first/highest/具体档位/别名/未知档位回退 |
| `packages/services/src/setting/settingService.salvage.test.ts`（newTaskDefaults 片段） | `packages/services/tests/settingsNewTaskDefaultsSalvage.test.mjs` 或并入既有 `settingsExplicitKeyPersistence.test.mjs` | 新增：旧 setting.json 缺字段 → 默认；未知字段丢弃；单键 update 不物化默认；显式 patch 落盘 |
| 源仓 `packages/ui/src/test/dom/ComposerModelSelection.test.tsx`（late settings 场景） | 无 DOM 测试基建 | **不移植**；目标仓无 jsdom / testing-library，且 `packages/ui` 的 test script 只匹配 `test/**/*.test.ts`。该场景改为手工验收（见 4.3） |

共享 schema 测试建议放 `packages/shared/test/newTaskDefaults.test.ts`（目标仓 shared 的 test script 匹配 `test/**/*.test.ts`），覆盖：

1. 缺 `newTaskDefaults` key → `appSettingsSchema.parse({})` 得到 `{ enabled:false, mode:null, model:null, reasoningLevel:null }`。
2. 未知字段（如 `futureField`）被 strip 且不报错。
3. `mode: "plan"` 经 `normalizeNewTaskDefaultMode` → `null`。
4. `appSettingsPatchSchema.parse({ newTaskDefaults: {...} })` 通过；半份对象按 schema 默认补齐。
5. `defaultReasoningLevelPick` 非法值被拒绝。
6. `speed` additive 兼容：缺 `speed` 的旧设置解析为 `null`；显式 `speed: "fast"` 可读可写；`DEFAULT_NEW_TASK_DEFAULTS.speed === null`；该字段不进入 `ResolvedNewTaskDefaults`（运行时用例钉住）。

### 4.2 命令（目标仓根目录执行）

```bash
pnpm --filter @acode/shared test
pnpm --filter @acode/provider test
pnpm --filter @acode/ui test
pnpm --filter @acode/services test
pnpm --dir apps/acode-cli test
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

- 团队目标要求补跑**完整 CLI/shared 测试与 knip 基线对比**：实施前后各跑一次 `pnpm --dir apps/acode-cli test`、`pnpm --filter @acode/shared test`、`pnpm knip`，记录新增/消失项；只允许本功能新增的导出/文件，不得引入未使用依赖或死文件。
- 门禁以 `pnpm verify:pre-push` / `node scripts/ci-local.mjs` 为准；不用管道吞退出码（参考 `AGENTS.md`）。

### 4.3 验收场景

**批量编辑**

1. 分组菜单：组内 N 个可批量行 → 「统一设置模型…（N 个）」打开弹层；确认后逐行落盘；行内覆盖控件反映新值。
2. 分组菜单「本组恢复继承默认」→ 该组可批量行全部回到继承默认，其他组不变；覆盖行清除 override，自建行定义文件移除 `model/thoughtLevel`。
3. 组内无可批量行 → 分组菜单禁用；不渲染行复选框。
4. 全局全选：当前过滤结果内全部可批量行被勾选；半选/全选/空选三态正确；筛选变化时选中集按目标仓规则裁剪。
5. 带失败批次：某行抛错 → 后续行继续；结果展示成功/失败计数与失败行名；失败行保留原值。
6. Start Plan 推荐：目标模型非空时整批只弹一次；拒绝后整批不写盘，结果列出「已取消推荐弹窗，保留原值」。
7. 应用进行中：行复选框、组全选、全局全选、分组菜单、退出、搜索、新建全部禁用；结束后进度清空、不残留转圈。
8. 声明键保真：含 `isolation/observer/observerMessage/observeSubagents/initialPrompt/hooks` 的自建 agent 批量改模型后，定义文件仍携带全部键；`maxTurns` 零出现。
9. 速度维度零回流：`SubagentSpeedField`、`resolveSubagentSpeedOptionState`、`batch.speedRequired`、`chat.toolbar.speed.*` 在 UI 源码与 locale 中零出现（现有接线测试）。
10. i18n：全部批量键 en-US / zh-CN 成对；`batch.entry` 等新键实际被组件引用。

**新建任务默认值**

1. 开关关闭（默认）：新建任务运行时取值与升级前逐项一致（mode/model 沿用最近提交，推理强度取 `defaultReasoningLevelPick` 缺省 `first`；speed 不参与）。
2. 开启并固定 mode=`yolo`：新任务权限按钮直接显示「完全访问」并带警示态；`dontAsk` 同样可选且生效。
3. 开启并固定模型 A + 推理强度「低」：新任务模型为 A、档位为低；A 不支持「低」→ 用 A 的默认档位，设置页仍显示「低」。
4. 固定模型已从目录移除：回落到 `preferredSelection` 或目录首个模型，不报错。
5. 只固定模型、其余跟随默认：mode 沿用上次提交；档位用固定模型的第一项。
6. 固定推理强度后目录刷新（`refreshUneditedNewTaskDefaults`）：档位不会被改回默认。
7. 用户在新任务草稿内改选档位后（`modelSelectionEdited`）：目录刷新与设置变更都不覆盖。
8. 设置快照晚于模型目录到达：已固定 mode/model **仍然生效**（等价源仓 DOM late-settings 场景；目标仓无 DOM 测试，需手工/临时脚本验证）。
9. 设置变更不影响已有会话草稿与已提交配置。
10. 模型目录未就绪：推理强度行禁用并显示「模型目录未就绪」；mode/model 行仍可用。
11. 旧 `setting.json` 无字段：读取得到默认关闭、零迁移报错；单键 update 不把默认对象物化落盘。
12. `defaultReasoningLevelPick=highest`：切到档位列表 `["low","high","max"]` 的模型显示 `max`；具体档位 `high` 在 `["low","medium","max"]` 上落到 `medium`；别名 `none/enabled/extra-high` 按阶梯匹配。
13. 文案：`settings.taskDefaults.*` 两套 locale 成对；速度行默认隐藏（不要求 speed 两键）；若选择禁用展示则两键齐全且文案说明暂不可用。
14. additive speed：旧 `setting.json` 无 `speed` → 读取 `null`；显式 `speed` 可保存但新建任务 `ModelSelection` 不含 speed；speed-only 固定等价于未固定。

### 4.4 未验证声明

- 目标仓无 jsdom / testing-library，**没有 UI 渲染级测试**；上述交互场景只能通过源码契约测试 + 手工验收，不能声称已自动化。
- 目标仓无统一 E2E 命令；`apps/acode-cli/tests` 是 CLI 测试，不覆盖设置页 UI。
- 本文所有目标仓行数、locale 键存在性、缺失文件结论均来自 2026-10-20 13:31:41 的实际读取；由于目标工作树正被并发修改，实施前需重新核对当前 `git status` 与本文 1.5 的缺口表。

---

## 5. R5 版本/发布裁决

### 5.1 是否需要版本变更

- **实现 PR 不改任何 `package.json` 版本**：根 `acode@1.0.1`、`apps/acode-cli@0.16.9` 保持不变。
- 本次改动位于根 `packages/*`（shared/provider/ui/services），不修改 `apps/acode-cli` 的源码；CLI 版本仅在 CLI 自身发布时由 `apps/acode-cli` 的 release 流程决定。CLI/shared 测试作为跨包回归基线执行（见 4.2）。
- 是否需要 minor 版本由发布分支决定：这是新增用户可见功能（设置页新分区 + 批量编辑增强），按 semver 应在下一次发布取 **minor**（`1.0.1 → 1.1.0`）；不在功能 PR 内落版本号。
- 不手工创建 `CHANGELOG.md`：根 `.release-it.mjs` 使用 `@release-it/conventional-changelog` 生成；目标仓当前无 CHANGELOG 文件，release 时生成。
- 不打 tag、不推送 `main`：按 `docs/git-collaboration.md`，功能先入 `dev`，发布走 `release/x.y.z`，全部门禁绿后 `merge --no-ff` 到 `main`，由 Actions 触发 Release 工作流生成 tag。

### 5.2 源仓版本参照

- 源仓基线 `zcode@3.14.3`。R2 功能提交：`71af0f2c`（2026-09-24，新建任务默认值）、`4c2796f1`（2026-09-28，默认取第一项）、`5aefb499`（2026-10-16，具体档位可固定）。
- R1 功能提交：`47060940`（2026-09-23，批量编辑）、`c5f43507`（2026-09-23，速度与自建）、`731990d5`（2026-09-29，全选/进度）、`a685a7df`（2026-10-16，档位不被冲回）、`cf34bef9`（2026-10-19，内置名本地化）。
- 目标仓上一次批量接线：`046a2781`（2026-10-18，「复活四个 0cc983f 剔除功能」）。本移植是在其上的增量，不是重新引入已删除功能。
- 源仓的 speed 运行时维度（`c5f43507` / `d3abe99a`）不在本批发布内容内。本批仅保留 `newTaskDefaults.speed` 的 **additive 存储字段**（默认 `null`、不产生用户可见行为、不写入 `ModelSelection`）；批量 speed 与运行时 speed 均不发布。若后续补 speed，应单独走 spec + minor 发布。

### 5.3 回滚边界

- 若 R2 引发设置读取问题：回滚 `validationAppSettings.ts` 的两处字段登记即可让旧版本忽略未知字段（schema `.strip()`），`newTaskDefaults` 数据保留在 `setting.json` 不阻塞读取。
- 若批量编辑接线出问题：`SubagentsSection` 回滚到 `046a2781` 主接线；Apply/Bar/Dialog 纯逻辑与测试可独立保留。
- 任何回滚不得关闭/削弱门禁（`--no-verify`、放宽 lint/architecture、baseline 登记等手段禁止）。

---

## 6. 实施顺序

1. R2 shared 层：`new-task-defaults.ts` → index → protocol → validation → shared 测试。
2. R2 provider 层：pick 阶梯 + completion 第三参 + provider 测试。
3. R2 UI 纯函数：`lib/newTaskDefaults.ts` → `composerRecent.ts` → 测试。
4. R2 草稿链：`composerDraftStore` → `newTaskDraft` → `useDraftConfigControl`。
5. R2 设置页：`settingsNavigation` → `settingsPageConfig` → `SettingsPageParts` → `modelTriggerDisplay` → `TaskDefaultsSection` → `SettingsPage`。
6. R2 i18n 两套 locale。
7. R1 剩余缺口：行复选框 applying 禁用 + 接线测试（其余已落地项只做核对）。
8. 全量验证：4.2 命令 + knip 基线对比 + 手工验收（4.3）。

---

## 7. 引用核实记录

以下文件在 2026-10-20 13:20–13:32 实际读取（源仓库只读；目标仓库只读，除本 spec 外未写任何文件）：

- 源：`packages/ui/src/settings/SubagentModelBatchApply.ts`、`.test.ts`、`SubagentModelBatchBar.tsx`、`SubagentModelBatchDialog.tsx`、`SubagentsSection.tsx`、`TaskDefaultsSection.tsx`；`packages/ui/src/lib/newTaskDefaults.ts`、`.test.ts`、`composerRecent.ts`、`composerRecentReasoningPick.test.ts`；`packages/ui/src/v4/composer/newTaskDraft.ts`、`useDraftConfigControl.ts`、`composerDraftStore.ts`、`modelTriggerDisplay.ts`；`packages/ui/src/settings/settingsPageConfig.ts`、`.test.ts`、`SettingsPageParts.tsx`、`SettingsPage.tsx`、`lib/settingsNavigation.ts`；`packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`；`packages/shared/src/new-task-defaults.ts`、`protocol.ts`、`validationAppSettings.ts`、`sync-scope.ts`、`model-selection.ts`、`test-ids.ts`；`packages/provider/src/model-selection-config.ts`、`registry.ts`；`packages/services/src/setting/settingService.salvage.test.ts`；`docs/specs/new-task-defaults.md`。
- 目标：对应同名文件的当前版本（`SubagentsSection.tsx` 2546 行、Apply 170 行、Bar 298 行、Dialog 258 行）；`packages/ui/test/subagentModelBatchApply.test.ts`、`subagentBatchWiring.test.ts`；`packages/ui/specs/subagent-batch-edit.md`；`packages/ui/src/settings/SettingsPageParts.tsx`、`settingsPageConfig.ts`、`SettingsPage.tsx`、`lib/settingsNavigation.ts`、`ModelConfigSelect.tsx`、`chat-input-toolbar/display.tsx`、`display-help.ts`、`thoughtLevelOptions.ts`、`hooks/useSettingService.ts`、`hooks/useWorkspaceServices.tsx`、`hooks/useModelSelectionView.ts`、`v4/composer/{newTaskDraft,useDraftConfigControl,composerDraftStore,modelTriggerDisplay}.ts`、`i18n/locales/{en-US,zh-CN}.ts`、`shared/src/{protocol,validationAppSettings,model-selection,test-ids,settings-sync,index}.ts`、`packages/provider/src/{model-selection-config,registry}.ts`、`packages/services/src/setting/{settingService,normalizeSettingsPatch}.ts`、`packages/services/tests/settingsExplicitKeyPersistence.test.mjs`、根 `package.json`、`apps/acode-cli/package.json`、`.release-it.mjs`、`docs/git-collaboration.md`、`AGENTS.md`。
- 关键负向核实（`git grep` 零命中）：目标仓 `newTaskDefaults`、`defaultReasoningLevelPick`、`SYNC_SCOPE_IDS`、`SYNC_SETTINGS_INCLUDED`、`runUserActionAsync`、`splitModelTriggerLabelParts`、`modelSelectionEdited`、`seedImportedSessionDraft`、`refreshUneditedNewTaskDefaults`、DOM `.test.tsx`；`packages/ui/package.json` 无 `jsdom` / `@testing-library` 依赖，现有测试头注明确「ui 测试无 jsdom 先例」。
- 关键正向核实：目标仓 `submissionModeSchema` 含 `dontAsk`；`getACodeAgentAvailableModes()` 返回 build/edit/plan/yolo/dontAsk；`getModeOptionDisplayLabel` 已登记 dontAsk；`validateModelSelectionOptions` 只接受 reasoningLevel；`modelSelectionSchema.options` 为 strict `{ reasoningLevel }`；目标 `packages/ui` test script 匹配 `test/**/*.test.ts` 与 `tests/**/*.test.mjs`，不匹配 `.test.tsx`。

## 8. 2026-10-20 二次裁决：speed 维度完整落地

最终实现不再保留“speed 暂缓”的口径，以下为当前事实：

- **协议与模型栈**：`modelSelectionSchema.options` 含 `reasoningLevel + speed`；`ModelSelectionValidation` 含 `speed-missing` / `speed-not-supported`；`packages/model-option-map` 的 `ModelOptionName/ModelOptionMapSpecs/ModelOptionValues` 含 speed；shared `model-config` 恢复 `completeSpeedOptionSpecDataSchema` / `speedOptionSpecDataSchema`；provider `ModelOptionSpecsConfig` 恢复 `SpeedOptionSpecConfig`，resolver 投影 speed，completion 取 speed 列表首项，normalize 校验 speed 合法性，effective-selection 将 speed 错误归入 selectionIssue。
- **批量编辑**：`SubagentModelBatchValue.speed`、`resolveSubagentSpeedOptionState`、`isSubagentSpeedInvalid` 恢复；Bar/Dialog 显示 speed 控件并在 speed 必选时阻止应用；Apply 把 speed 写入 `ModelSelection.options`；SubagentsSection 行内覆盖、编辑表单、行徽标均显示/校验 speed。
- **新建任务默认值**：`NewTaskDefaults.speed` 不再只是存储字段；`resolveNewTaskDefaults` 归一化 speed，`applyNewTaskDefaults` 在 reasoningLevel 之后叠加 speed（命中 Option Spec 才写入）；TaskDefaultsSection 在模型声明 speed spec 时渲染“模型速度”行；composer 工具条新增 `ModelSpeedControl` 并接 `handleDraftSelectSpeed`。
- **持久化**：定义文件 frontmatter 增加 `speed` 序列化/解析；状态文件中的 `ModelSelection.options.speed` 由 schema 直接保留。
- **验收**：UI 452/452、shared 280/280、provider 32/32、services 479 项（477 pass + 2 既有 skip）、typecheck/lint/architecture（new 0）全绿；speed 新增/更新用例覆盖 schema、批量值、frontmatter 往返与运行时投影。
