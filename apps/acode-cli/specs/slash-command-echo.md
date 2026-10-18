# slash-command-echo：斜杠命令触发回显

> 来源登记：功能自 anker-code@6e698ada 移植，核心类型 + UI 组件由 zhengjunkj 落在
> f3ab0e6（分支 dev/from-acode-2026-10）；因当时 12 个 core/bootstrap 接线文件未跟随迁移、
> 零消费者成死代码，merge 0cc983f 将其剔除。本 spec 恢复该意图并登记完整接线，
> 原始 spec 名 docs/specs/custom-command-invocation-echo.md 在本仓不存在——以本文件为准。

## 目标

用户发送斜杠命令（`/xxx [args]`）并被 CLI 成功展开后，在会话流该用户行的气泡下方
回显一行「已触发命令 /<名称> · <来源> · <描述>」，与普通用户文本可区分。命令不存在
或输入不是命令时不回显——回显是「CLI 展开成功」的权威事实，UI 不得从输入文本反推。

## 产品规则

1. **触发事实唯一来源**：`CustomCommandInvocationMeta`（contracts/commands）只在
   resolver 展开成功时产生。GUI 以 row.customCommand 的有无判断「是否触发」；
   气泡里的命令 chip 来自 Composer 文本，命令不存在时也会画出来，不构成触发证据。
2. **覆盖面**：自定义命令（project/user/system/admin scope，source=agents/acode/plugin）
   与内置 prompt 命令（/init、/workflow、/ultracode，scope="builtin"）都回显；
   宿主动作命令（/overnight 族、/usage、/auto-resume）不开 turn、不进模型，不回显。
3. **未知来源不丢行**：row meta 的 scope/source 是宽松字符串（未知值原样显示），
   校验失败按缺席处理，绝不因此丢弃整条 userInput row。
4. **显示规则**：`已触发命令 /<name> · <来源标签> · <描述>`；source=plugin 优先于
   scope 标签；描述空则省略该段；描述超长单行截断 + 悬停全文；无 meta 不渲染。

## 状态所有者与数据流（单写路径）

```
bootstrap customCommandPromptResolver（唯一产生点）
  resolver 返回 { command, prompt }（prompt 进模型，command 只进展示链路）
    └→ input-facade：displayInput 与 customCommand 同生同灭
         ├→ ExecuteTurnOptions.customCommand
         │    ├→ core turn.ts：TurnStarted payload.customCommand        （live 事实）
         │    └→ core message-persistence：persistUserPrompt
         │         └→ 用户消息 metadata.customCommand                   （冷恢复事实）
         └→ admitPrompt（PromptAdmissionOptions ⊇ ExecuteTurnOptions，同字段透传）
v4 投影（bootstrap/acode-protocol-v4）
  live：event-normalizer 把 TurnStarted payload 归一到 CanonicalUserIntentFact.customCommand
  cold：transcript-hydration 从用户消息 metadata 读回，合成同形 TurnStarted
  两路共用 product-projection → userInput row.customCommand（shared rows.ts 宽松 schema）
UI（packages/ui）
  ConversationRowView.UserInputRowView → ConversationUserInputFooter →
  ConversationUserInputCommandEcho（row.customCommand 缺席即 null）
```

所有者裁决：meta 的产生者是 bootstrap resolver（core/shared/UI 只透传/消费，不反推、
不复制状态）；持久化事实唯一落点 = 用户消息 metadata（事件与投影均可重建）。

## 接口

| 面 | 契约 |
| --- | --- |
| contracts | `CustomCommandInvocationMeta{name,scope,source?,description?}`（scope 闭集 ∪ "builtin"）、`toCustomCommandInvocationMeta`（描述空串折叠）、`ResolvedCustomCommandPrompt{command,prompt}`、`TurnStartedPayloadBase.customCommand` |
| core | `ExecuteTurnOptions.customCommand`；TurnStarted payload 与 `persistUserPrompt` options 各带同份；metadata 键 `customCommand` |
| shared v4 | `customCommandInvocationMetaSchema`（宽松字符串，min(1)，未知来源不拒行）；`UserInputRow.customCommand` |
| UI | `ConversationUserInputCommandEcho` / `ConversationUserInputFooter`（回显在上、status 在下）；i18n key `chat.userInput.command.triggered` + `chat.userInput.command.scope.{user,project,system,admin,builtin,plugin}`（en/zh 成对） |

协议纪律：全部改动只进 `packages/shared/src/acode-protocol-v4/`，legacy 面零污染；
字段全部 optional（旧 CLI 事件、旧 transcript、旧 snapshot 均合法）。

## 验收场景

1. **live 回显**：展开成功的自定义命令 → 该轮 userInput row 带 customCommand（name/
   scope/source/description 逐字存活），snapshot/delta 过 v4 wire schema；
   无命令输入的 row 不带该字段。
2. **冷恢复同形**：持久化用户消息 metadata.customCommand → hydration 合成的 TurnStarted
   携带同份 → row 与 live 一致；畸形 metadata（类型不符）按缺席处理，row 照常产出。
3. **UI**：有 meta 渲染「已触发命令 /<name>」+ 来源标签 + 描述（truncate+tooltip）；
   plugin source 显示「插件命令」；未知 scope 原样显示；无 meta 只渲染 status，DOM
   与旧实现一致（`data-v4-user-input-status` 逐字节不变）。
4. **i18n**：7 个 key 在 en-US 与 zh-CN 成对在场。

## 已登记非目标 / 限制

- busy 排队路径（admitPrompt → enqueueDeferredInput）不透传 displayInput/customCommand：
  与既有 displayInput 行为一致（排队输入丢失原始展示是存量缺口，不随本功能扩大），
  排队命令落地后按展开后文本展示、无回显。后续如修，须与 displayInput 同批。
- steer/guide/control-only drain 路径同理不携带（这些路径今天也不带 displayInput）。
- 宿主动作命令（/overnight 族等）不回显：它们不产生 user turn。
