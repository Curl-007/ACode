# prompt-polish：提示词一键润色

> 来源与许可：机制设计参考 https://github.com/c80361619/zcode-toolkit §七（MIT,
> c80361619；含 HHQ-666 MIT 组件声明）。只搬产品语义与防坑纪律，不复制代码与文案；
> 润色指令、错误文案全部自撰。

## 现状与红线（调查结论 2026-10-17）

- 轻量单发通道**已存在**：协议方法 `workspaceGenerateText`（params/result schema 在
  `packages/shared/src/acode-protocol/index.ts:1995-2035`：selection + prompt/messages +
  querySource + maxOutputTokens + operationId；result 带 usage/finishReason），host 实现
  `services/src/acode-agent/acodeAgentService.ts:4447-4505`（含 cancel 面），UI 触发先例
  GitActionMenu 生成提交消息。
- **红线**：legacy `prompt/enhance` 全簇已连根删除且列入死词清单
  （`acode-protocol/index.ts:7-18`）——不得复活旧方法名；本功能走
  `workspaceGenerateText`，`querySource: "prompt_polish"`。
- 草稿所有权：Lexical + ConversationComposer 组件态（`text/setText` + contentRevision）；
  程序化替换既有 action `requestComposerTextInsert(mode:"replace")`
  （`store/acodeSessionStoreWorkspaceSlice.ts:421-451`），**但当前仅 sessionId===null
  草稿 pane 生效**（`SessionPane.tsx:3339` 限制）；恢复先例 `restoreSubmittedDraft`
  （存 text+editorStateJson + composerDraftRevision guard）。

## 产品规则

1. 入口：composer 工具栏独立按钮，图标三态——待机 / 润色中 / 可还原。左键=润色当前
   草稿；右键=ContextMenu（Radix，TaskList 共享 root 先例）按 provider 分组列可用
   模型，选中即持久化为润色模型。
2. 润色模型解析优先级（**每档带「已解析则不覆盖」守卫**——源项目两次踩坑的静默覆盖
   教训，须有回归测试钉住）：
   explicit（本次右键临时选择）→ persisted（localStorage 偏好）→ session（当前会话
   模型）→ 无可用候选 = **可读错误回执，绝不发出注定失败的请求**（源项目跨机
   「Model is unavailable」根因教训）。可用性判定按既有模型目录字段（凭据齐、未禁用）。
3. 润色行为：`generateWorkspaceText`（selection=解析结果，querySource="prompt_polish"，
   合理 maxOutputTokens，operationId 支持取消）；润色指令自撰——语义要素：保留原意/
   语言/关键约束与专名，只提升清晰度与结构，输出仅含润色后草稿正文（无解释前后缀）。
4. 草稿替换与恢复：成功 → `requestComposerTextInsert(mode:"replace")` 替换（需解除
   sessionId===null 限制以覆盖已有会话 pane——解除时核对该限制的其他消费方，不得
   破坏既有插入语义）；原文（text+editorStateJson）保存于组件态，可还原态持续到
   用户编辑/提交/切换会话为止（composerDraftRevision guard 防迟到回包覆盖用户新编辑；
   **不做 20s 超时**——guard 已提供更强语义）。
5. 失败与边界：空/纯空白草稿不润色（按钮禁用）；润色中禁用重复触发；失败回执不动
   草稿；取消（operationId）回到待机态。
6. 偏好持久化：`lib/promptPolishPreferences.ts`（localStorage 唯一事实源，照
   `appearancePreferences.ts` 模式：唯一写入口 + 跨窗 storage 同步）+ store slice 只做
   回显与广播载体（BROADCAST_FIELDS + applyBroadcast 防回环）。
7. i18n：残留 `chat.promptEnhance.*` 词条（zh-CN.ts:3948-3952）语义匹配处复用，缺口
   新增 key（locales 文件编排者独占，实现代理交付 key 清单）。

## 实现形态（inert-until-wired）

- 新组件：`packages/ui/src/v4/composer/PromptPolishButton.tsx`（三态按钮 + ContextMenu
  模型选择，纯 props + hooks）；新 lib/store 模块如上。
- 编排者接线：V4ComposerToolbar 挂载、SessionPane replace 限制解除、store index、
  locales。
- 模型清单来源：既有 composer 模型目录面（ModelConfigSelect 同源数据），不新建目录。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 草稿正文 | Lexical/ConversationComposer 组件态（既有，不新增写路径） |
| 润色模型偏好 | ui localStorage lib（唯一写入口）+ store 回显 slice |
| 润色调用与取消 | services `generateWorkspaceText`（既有协议方法，operationId） |
| 替换/还原请求 | `requestComposerTextInsert` / restoreSubmittedDraft 模式（既有） |

## 验收场景

1. 模型解析单测：explicit/persisted/session 各档命中、守卫不被低档覆盖（回归钉住）、
   无可用候选给可读错误且零请求发出。
2. 草稿替换/还原单测：revision guard（用户新编辑后迟到回包不覆盖）、还原恢复
   editorStateJson、提交/切会话后还原态消失。
3. 偏好持久化单测：localStorage 读写、跨窗广播防回环、垃圾值归一。
4. 组件测试：三态切换、空草稿禁用、润色中禁重复触发、取消回待机。
5. E2E（desktop dev + 真实模型）：草稿润色替换 → 还原 → 右键换模型持久化 → 重开窗口
   偏好仍在；querySource="prompt_polish" 在 usage 账本可见（与 P0 今日合计口径互证）。
