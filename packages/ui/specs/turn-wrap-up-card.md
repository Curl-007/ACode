# ACode：回合收尾卡（recap / 下一步 / 建议任务卡）

## 背景与目标

CLI 侧把回合收尾载荷做成协议义务：模型在收尾消息之前调用 `TurnWrapUp` 工具，载荷
`{ recap, nextStep, followUpSuggestion? }` 随 toolCall row 的 `input` 通道过线（裁决与
证据见 `apps/acode-cli/specs/turn-wrap-up.md` §2.2）。本 spec 定义 renderer 侧：回合收口后
在轮尾渲染**收尾卡**（回顾 + 「下一步」框 + 建议任务卡），桌面与手机 Web 同一实现。

用户价值：靠卡片跟进度，不是靠读消息——「下一步」永远有一个固定槽位；建议任务卡把
"自成一体的后续"变成一键可发起的新任务。

## 数据面（单一事实源）

- 载荷 schema：`@acode/shared/acode-protocol-v4` 的 `turnWrapUpPayloadSchema`（strict）
  与 `TURN_WRAP_UP_TOOL_NAME`、`TURN_WRAP_UP_LIMITS`。UI 不复制字段表。
- 解析入口：`src/v4/turnWrapUpCards.ts` 的 `resolveTurnWrapUpCard(rows)` —— 纯函数：
  - 只看 `kind === "toolCall"`、`toolName === TURN_WRAP_UP_TOOL_NAME`、
    `status === "success"` 的行；
  - `parseTurnWrapUpPayload(row.input)` 失败 → 跳过该行（安全回落：该行仍按普通工具行渲染）；
  - 多次成功调用 → **最后一条生效**（last-wins，CLI spec R4/R6）；
  - 返回 `{ rowId, toolCallId, payload } | undefined`。
- 渲染门：`ConversationTurnGroup` 与 cron/off-peak 轮尾卡同一道缝——`unit.isRunning`
  为真不解析（轮没收口就没有"收尾"）；解析结果经 `useMemo` 派生，无组件级状态。

## 卡片结构与布局

```text
┌ 收尾卡（rounded border, --color-card 面）────────────────┐
│ recap（text-ui-sm，--color-foreground-subtle，≤3 句）    │
│ ┌ 下一步（--color-accent 弱强调块）───────────────────┐  │
│ │ 标签「下一步」 + nextStep（text-ui-base）            │  │
│ └──────────────────────────────────────────────────┘  │
│ ┌ 建议任务卡（在场时；子卡，border 分隔）─────────────┐  │
│ │ title（text-ui-sm 加粗） + tldr（subtle）            │  │
│ │ [展开 prompt ▾]（展开后等宽预览，max-h 内滚动）      │  │
│ │ 动作：〔发起为新任务〕〔复制 prompt〕                │  │
│ └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- 遵守 DESIGN.md：`text-ui-*` 字阶、语义色 token（card/accent/border/foreground-subtle）、
  无大面积品牌填充；位置在轮尾卡序列中排最前（它是本轮自己的摘要，先于 workflow/cron/
  off-peak 等副作用卡），文件摘要面板之前。
- 手机 Web：同一组件自然堆叠（卡片 100% 宽、动作按钮 touch target ≥ 现有按钮规格、
  prompt 预览 `max-h-40` 内滚动）；无桌面专属交互（hover-only 动作禁用）。
- 建议卡默认收起 prompt，只展示 title + tldr（对齐外部范式：卡面 = title+tldr，
  完整 prompt 需展开）。展开状态是组件局部 useState（纯 UI 态，不进 store）。

## 动作面

1. **发起为新任务**（`useTurnWrapUpSuggestedTask` hook，`src/hooks/`）：
   完全复用 root「新建任务」的同一组 store 动作序列（单一写入路径，CLI spec R7）：
   `activateTabByPath`（失败则 `addTab`）→ `isWorkspaceReadOnly` 拒绝 →
   `deactivateActiveGroup` + `resetToPrimaryPane` → `startDraft(createSource:"project")` →
   `persistV4ComposerDraft(V4_DRAFT_SCOPE_ROOT)` → `requestComposerTextInsert`。
   workspace 身份取自 `ConversationRowRenderContext`（卡片所在会话的工作区）。
   **预填不自动发送**（与 root initialPrompt 语义一致）：新任务草稿带着 prompt 等用户过目。
2. **复制 prompt**：`navigator.clipboard.writeText` + toast（既有 `toast` 面）；
   失败静默（剪贴板权限是环境事实，不弹错误对话框）。
3. 登记后续（不在本波）：「发回本会话」需要面向 session composer 的纯文本插入通道
   （既有 `composerTextInsertRequest` 只喂草稿态 composer，`sessionId === null` 门在
   SessionPane——该文件超行数 ratchet，不开新通道）。

## i18n

键（`chat.turnWrapUp.*`）：`nextStep`（下一步）、`suggestedTask`（建议任务）、
`showPrompt` / `hidePrompt`（展开/收起 prompt）、`startAsNewTask`（发起为新任务）、
`copyPrompt`（复制 prompt）、`copiedPrompt`（已复制）。

locale 词典文件在本波文件所有权外：键清单交协调者统一接线；接线前组件内置**英文回落
词典**（`formatMessage` 缺失键回落为 id 本身 → 组件检测到回落即取内置英文）。
移除条件：en-US.ts / zh-CN.ts 落键后删除回落词典（登记于 CLI spec §9.2）。

## 失败语义与降级

- 载荷解析失败/缺席：无卡片；`TurnWrapUp` 工具行仍按通用 ToolCallBlock 渲染（旧客户端
  同款呈现）——任何情况下不白屏、不抛。
- 轮未收口（isRunning）：无卡片（收尾是轮尾事实）。
- 只读工作区：发起动作静默拒绝（root 同款边界），复制仍可用。

## 验收

- `packages/ui/test/turnWrapUpCards.test.ts`：resolver 纯逻辑（last-wins、状态过滤、
  坏载荷回落、followUpSuggestion 透传）；包内无 DOM 测试先例，组件渲染以纯函数
  view-model 守护。
- 手动：桌面 + 手机 Web 视口下卡片布局、展开 prompt、发起为新任务落到草稿并预填。
