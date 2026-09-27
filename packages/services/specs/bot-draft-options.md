# Bot 草稿引擎与权限模式选择（draftOptions）

为 Bot/远端创建的任务草稿引入「引擎 + 权限模式」选择能力：把每个 bot 的 `currentOptions`
（引擎 `cli` + 权限模式 `mode`）从「写了但没人读」的死配置，变成草稿初始化与首条消息派发的真实输入，
并在 BotsDialog 与 bot 聊天命令两侧暴露选择入口。

## 背景与裁决

- **引擎枚举已就绪**：`ACodeProvider` 已是 `glm | codex | opencode | gemini` 四引擎联合，
  `botDraftOptionsSchema.provider` / `botCurrentOptionsSchema.cli` 已是引擎枚举（engine-runtime 落地）。
  本 spec 不再拓宽取值域，只补齐「选择 → 草稿 → createTask」的链路。
- **yolo 硬锁是 ZCode 对等实现，不是 ACode 私自加的**：核对 ZCode 还原源
  （`applyDraftConfigOptions` 强制 `II='yolo'`、`/mode` 直接回 `modeLocked`）确认参考实现同样硬锁。
  本特性把硬锁降级为**默认值**：未显式选择时草稿仍用 `yolo`（既有 bot 行为零变化），
  用户显式选择后下发所选模式。这不是单方面放宽安全姿态，而是请求中的「permission-mode selection」。
- **非 yolo 不会让 bot 任务卡死**：bot 已有完整权限中继（`pendingPermissionOptions` /
  `permission.respond` / `/approve` / `/deny` / elicitation 中继），权限请求会回到聊天等待用户响应。
- **外部引擎仍 `implemented:false`**：引擎选项由注册表生成并过滤到已实现引擎，当前等价于 `[glm]`，
  外部引擎接入会话协议后自动出现，UI/命令无需改动。

## 产品规则

- 每个 bot 的默认引擎 = `currentOptions.cli`（缺省 native `glm`）；默认权限模式 = `currentOptions.mode`
  （缺省 `BOT_DEFAULT_DRAFT_MODE = "yolo"`，保持既有 bot 行为）。
- 草稿初始化（`buildInitializedDraftOptions`）必须读取 bot 默认值，而不是模块常量；
  这样 UI 选择与 `/engine`、`/mode` 命令都能影响后续聊天创建的草稿任务。
- 首条消息派发把草稿 `provider`（引擎）透传给 `createTask`，把草稿 `mode`（权限模式）经
  `applyDraftConfigOptions` → `acodeTaskService.setMode` 下发；下发前用活跃 task 的 configOptions 校验模式受支持。
- `/engine`、`/mode` 命令分别受 `allowedCommands.engine`、`allowedCommands.mode` 门控；新建 bot 默认两者开启。
- 引擎选项只列已实现引擎；权限模式选项按所选引擎的支持集（native = build/edit/plan/yolo）。
- 远端断连时草稿初始化仍只保留最小默认（`{provider}`），不偷偷申请远端 runtime；`/engine` 为静态列表，
  不依赖远端 runtime，断连也可用。

## 状态所有者与写入路径

- **bot 默认值唯一所有者**：`BotsRepo`（`bot-config.v3.json`）的 `bot.currentOptions`。
  写入路径：UI `onPatchBot` → `saveBot` → `normalizeBotCurrentOptions`（保留 `cli`/`mode`）；
  或 bot 聊天 `/engine`、`/mode`（`/engine` 经 `saveBot` 写 `currentOptions.cli`，`/mode` 在草稿态写 live draft）。
- **live 草稿所有者**：`BotsRepo`（`bot-state.v3.json`）的 `bot.draftOptions`，由 `writeDraftOptions` /
  `buildInitializedDraftOptions` 写。`currentOptions` 是「每 bot 默认」，`draftOptions` 是「每上下文实时草稿」，
  草稿初始化从默认派生，二者不互相覆盖。
- **引擎/权限模式取值域唯一所有者**：`@acode/shared` 引擎注册表（`acode-agent-registry.ts`）。
  UI 与 bot 聊天的选项列表都从注册表派生，禁止内联枚举。

## 接口

- `packages/shared/src/bots.ts`：
  - `BotCurrentOptions` 接口补 `cli?: ACodeProvider`（持久化键沿用 `cli`，与 `botCurrentOptionsSchema` 对齐）。
  - 新增导出 `BOT_DEFAULT_DRAFT_MODE = "yolo"`（services 与 UI 共用的缺省权限模式单一事实源）。
  - `BotAllowedCommands` 补 `engine?: boolean`；`botAllowedCommandsSchema` 补 `engine`；`DEFAULT_BOT_COMMANDS` 补 `engine: true`。
  - `BotCommand` 补 `engine.list` / `engine.set`；`SelectionPrompt.action` 补 `"engine.set"`。
- `packages/services/src/bots/config.ts`：`normalizeBotCurrentOptions` 保留并归一 `cli`（`normalizeAgentProviderToACodeAgent`）与 `mode`。
- `packages/services/src/bots/botConfigHelpers.ts`：`isUserCommandAllowed` 入参联合补 `"engine"`。
- `packages/services/src/bots/commandParser.ts`：`/engine`（+ 中文别名 `/引擎`）→ `engine.list` / `engine.set`。
- `packages/services/src/bots/commandOrder.ts`：`BOT_POLICY_COMMAND_ORDER` 插入 `engine`。
- `packages/services/src/bots/messages.ts`：新增 `helpEngine` / `engineSelectTitle` / `engineMissing` / `engineChanged`；
  `modeLocked` 不再由 `/mode` 触发（保留键避免破坏 `BotMessageId`，但改为不可达或复用）。zh-CN / en-US 键集一致。
- `packages/services/src/bots/botsService.ts`：
  - `BotAuthorizedCommand` 补 `"engine"`；`requiresRemoteWorkspaceRuntime` 排除 `engine`（静态列表）；`helpMessageByCommand` 补 `engine`。
  - `buildInitializedDraftOptions(context, defaults?)` / `buildActiveTaskDraftOptions(context, defaults?)` 读取 bot 默认引擎与模式；调用点透传 `auth.bot.currentOptions`。
  - `applyDraftConfigOptions` 下发草稿所选模式（缺省 `BOT_DEFAULT_DRAFT_MODE`），不再强制 yolo。
  - 删除 `/mode` 的两处 `modeLocked` 早返回；草稿态 `mode.list` 改从注册表（`getACodeAgentAvailableModes`）取选项，绕开 stub 的 `listUserConfigOptions`。
  - 新增 `engine.list` / `engine.set` 处理器：列表来自 `BOT_ACODE_PROVIDER_OPTIONS`；`engine.set` 写 `currentOptions.cli` 并按新默认重建草稿。
- `packages/ui/src/botsUi.ts`：新增 `BOT_ENGINES`、`getBotPermissionModesForEngine`（从注册表派生 `{id,labelId,descriptionId}`）。
- `packages/ui/src/BotsDialog/BotSummaryCard.tsx`：新增 `BotEngineCard`、`BotPermissionModeCard`（仿 `BotReplyGranularityCard`，经 `onPatchBot({currentOptions})` 保存）。
- `packages/ui/src/BotsDialog.tsx`：在既有 `SettingsGroupCard` 内挂载两张卡片。
- `packages/ui/src/BotsDialog/shared.tsx`：`createDefaultCommands` 补 `engine: true`。
- `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`：新增 `bots.engine*` / `bots.permissionMode*` / `bots.allowedCommands.engine` 键（复用既有 `engine.*.name` / `engine.permissionMode.*`）。

## 事件顺序

```text
UI 选择权限模式:
  BotsDialog BotPermissionModeCard onValueChange
    └─ onPatchBot({currentOptions:{...cli, mode}}) → saveBot
         └─ normalizeBotCurrentOptions 保留 cli/mode → 写 bot-config.v3.json

聊天创建任务（首条消息）:
  handleMessage → withAuthorizedContext(message,"message")
    └─ buildInitializedDraftOptions(context, auth.bot.currentOptions)
         provider = normalizeAgentProviderToACodeAgent(currentOptions.cli ?? glm)
         mode     = currentOptions.mode || BOT_DEFAULT_DRAFT_MODE
    └─ createTask({provider, modelSelection, v4Create:true})
    └─ applyDraftConfigOptions(submissionDraftOptions, taskId)
         resolvedMode = resolveSupportedDraftMode(configOptions, draft.mode, provider)
         acodeTaskService.setMode({taskId, mode: resolvedMode})   // 不再强制 yolo

/engine 命令:
  parseBotCommand("/engine codex") → engine.set
    └─ withAuthorizedContext(message,"engine")（不要求远端 runtime）
    └─ saveBot({currentOptions:{...cli:engine}}) → 草稿态则按新默认 writeDraftContext 重建
```

## 验收场景

1. 既有 bot（`currentOptions` 无 `cli`/`mode`）：聊天创建任务仍用 `glm` + `yolo`，行为零变化。
2. UI 把某 bot 权限模式设为 `build` 并保存：下一条聊天创建的任务经 `setMode` 落到 `build`；
   该任务触发权限请求时经既有中继回到聊天等待响应，不卡死。
3. `/mode`（草稿态）列出 native 四个模式（build/edit/plan/yolo）并可切换，不再回 `modeLocked`。
4. `/engine` 列出已实现引擎（当前 `[glm]`）；`/engine glm` 写 `currentOptions.cli` 并重建草稿。
5. `bot-state.v3.json` / `bot-config.v3.json` 严格 schema round-trip：写入含 `cli`/`mode` 的配置后重新读取通过 `.strict()` 解析。
6. 远端断连：`/engine` 仍可用（静态列表）；草稿初始化只保留 `{provider}`，不申请远端 runtime。

## 不在本特性范围

- 外部引擎（codex/opencode/gemini）的会话协议适配器仍 `implemented:false`，不接入；引擎选项过滤后当前只有 glm。
- `sandboxMode` / `approvalPolicy` 选择 UI 与命令：schema 已承载（`botCurrentOptionsSchema`），
  但 codex 等外部引擎未实现，缺真实下发路径，本次不暴露选择入口（保留字段，留待引擎运行时接入）。
- 被刻意禁用的 `allowedCommands` 编辑器不重启用；新命令经 `DEFAULT_BOT_COMMANDS` 默认开启即可生效。
