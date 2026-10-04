# Bot 草稿引擎与权限模式选择（draftOptions）

为 Bot/远端创建的任务草稿引入「引擎 + 权限模式」选择能力：把每个 bot 的 `currentOptions`
（引擎 `cli` + 权限模式 `mode`）从「写了但没人读」的死配置，变成草稿初始化与首条消息派发的真实输入，
并在 BotsDialog 与 bot 聊天命令两侧暴露选择入口。

## 背景与裁决

- **引擎枚举已就绪**：`ACodeProvider` 已是 `glm | codex | opencode | gemini` 四引擎联合，
  `botDraftOptionsSchema.provider` / `botCurrentOptionsSchema.cli` 已是引擎枚举（engine-runtime 落地）。
  本 spec 不再拓宽取值域，只补齐「选择 → 草稿 → createTask」的链路。
- **远程入口设权限模式天花板（安全加固 P0-3，覆盖此前的「yolo 硬锁降级为默认」）**：
  被绑定的聊天用户可经 `/mode` 选 yolo 并 createTask 驱动 host agent，yolo 下无逐动作确认，
  等于「一条聊天消息 → 远程任意命令执行」；入站通道已扩到 4 个（飞书/Telegram/企业微信/Discord），
  该面随之放大。本特性此前把硬锁**降级为默认值**（缺省 yolo），现**改回硬天花板**：远程 bot 入口
  **不可达 yolo/bypassPermissions**，可选集最高到 build/edit/plan。需要全权限必须在桌面本地显式操作
  （任务工具栏切换），不经 bot 配置或聊天命令。
  **2026-10-03 增补（auto-mode-risk-classifier.md R5）**：auto 模式落地后同批加入 bot
  天花板集（`BOT_REMOTE_MODE_CEILING_FORBIDDEN`，与 bypass 身份集
  `BOT_REMOTE_FORBIDDEN_PERMISSION_MODES` **拆分**）——auto 的灰区动作由 LLM 分类器
  裁决，bot 场景请求者与审批者同一、裁决器可被提示注入影响，「远程消息 → LLM 放行 →
  主机执行」不可接受；桌面本地 auto 不受影响（`isBypassPermissionMode("auto")` 恒
  false，managed policy 的 modePolicyForbidden 判定不波及）。放开条件登记于分类器
  spec v3 批次。
- **天花板单一事实源**：`@acode/shared/bot-remote-guard`（`BOT_REMOTE_FORBIDDEN_PERMISSION_MODES` /
  `BOT_REMOTE_MODE_CEILING_FORBIDDEN` / `isBotRemoteForbiddenPermissionMode` /
  `filterBotSelectablePermissionModes` / `clampBotPermissionMode`）
  - 注册表派生的 `getBotSelectablePermissionModes`。services 的 `/mode` 列表、派发咽喉，UI 的默认权限模式卡片
    都从这一处派生，禁止各处内联枚举。
- **绑定码防爆破（安全加固 P0-3）**：绑定码从 `randomBytes(3)`（约 1670 万空间）扩到 `randomBytes(8)`
  （2^64 空间），保留单次使用 + 短 TTL（`BOT_BIND_CODE_TTL_MS`）。`handleBind` 叠加**每 bot 连续错误计数 +
  指数退避锁定**（`createBotBindAttemptGuard`），锁定期内连码都不校验，杜绝 TTL 窗口内高速枚举。
- **非 yolo 不会让 bot 任务卡死**：bot 已有完整权限中继（`pendingPermissionOptions` /
  `permission.respond` / `/approve` / `/deny` / elicitation 中继），权限请求会回到聊天等待用户响应。
  **注意**：中继把权限请求发回**发起该输入的同一聊天用户**（桌面端同时收到广播，但谁先响应谁生效）。
  因此非 yolo 模式在 bot 入口提供的是**逐动作摩擦**（每个副作用动作需在聊天点一次 `/approve`），
  而**不是**一个独立于请求者的信任闸——不能据此声称「远程用户无法执行任意命令」。要获得独立闸，
  需让权限请求只由桌面本地可信用户响应（bot 侧不可自批），那是后续工作，不在本加固范围。
- **外部引擎仍 `implemented:false`**：引擎选项由注册表生成并过滤到已实现引擎，当前等价于 `[glm]`，
  外部引擎接入会话协议后自动出现，UI/命令无需改动。

## 产品规则

- 每个 bot 的默认引擎 = `currentOptions.cli`（缺省 native `glm`）；默认权限模式 = `currentOptions.mode`
  （缺省 `BOT_DEFAULT_DRAFT_MODE = "build"`——受审批的模式，副作用工具经既有权限中继回到聊天等待响应、
  不静默执行。**注意**：响应者可以就是发起者本人，故 build 模式在 bot 入口提供的是逐动作摩擦，
  而非独立于请求者的信任闸——详见上方「非 yolo 不会让 bot 任务卡死」条目）。
- **远程入口天花板（P0-3）**：bot 驱动的会话**永不进入 yolo/bypassPermissions**。即使 `bot-config` 残留旧的
  `currentOptions.mode:"yolo"`（本加固之前持久化），派发咽喉 `resolveEffectiveDraftMode` 也会经
  `clampBotPermissionMode` 按引擎作用域夹取到 build/edit/plan，绝不放行全权限档。
- **活跃任务路径同受天花板约束（P0-3 修复）**：天花板不能只在 `createTask` 派发咽喉生效。
  `/task-attach` 可以挂到任意**已存在**的任务，而 off-peak/automation 任务默认即 yolo
  （`acodeAgentService` 的 `permissionMode ?? "yolo"`），因此活跃任务派发（`resumeTask` +
  `sendPromptInBackground`）必须在 **resumeTask 之前**核实该任务的有效模式
  （`readCurrentActiveTaskMode` = configOptions 的 mode `currentValue` ?? `task.mode`，与 `/mode` 展示同源）：
  - 命中 yolo/bypassPermissions → 回 `taskModeRemoteForbidden`，**拒绝派发**；
  - 读不到任务元数据 → 回 `noActiveTask`，**fail closed**（无法核实就不放行）。

  这里是**拒绝**而非静默降级：bot 只是同一 Session 的输入端，不得改写 Session 状态
  （活跃任务派发路径上的既有约定：「菜单可能过滤无效值，不能拿它反推原选择，更不能重新套用
  Bot 创建默认值」）；静默把用户在桌面显式选择的模式改掉会在其不知情下变更共享状态。
  需要 yolo 必须在桌面本地显式操作。

- **`/mode` 命令（草稿态 + 活跃任务态）只列天花板内档位**：可选集 = 引擎支持集剔除 yolo/bypass。
  显式请求 yolo/bypass（如 `/mode yolo`）回 `modeRemoteForbidden`（「远程入口不支持完全访问」），
  而非「模式未找到」，避免把「被天花板拒绝」误显示成「输错」。
- 草稿初始化（`buildInitializedDraftOptions`）必须读取 bot 默认值，而不是模块常量；
  这样 UI 选择与 `/engine`、`/mode` 命令都能影响后续聊天创建的草稿任务。
- 首条消息派发把草稿 `provider`（引擎）透传给 `createTask`，把草稿 `mode`（权限模式，已夹取到天花板）经
  `applyDraftConfigOptions` → `acodeTaskService.setMode` 下发；下发前用活跃 task 的 configOptions 校验模式受支持。
- **绑定码尝试守护（P0-3）**：连续错误绑定码达到 `BOT_BIND_MAX_ATTEMPTS`（缺省 5）即锁定该 bot；
  锁定时长按 `2^(失败次数-阈值)` 指数退避（base `BOT_BIND_BASE_LOCK_MS` = 30s，封顶 `BOT_BIND_MAX_LOCK_MS` = 15min）；
  绑定成功清零计数。计数按 botId 隔离，一个 bot 被锁不殃及其他。
- `/engine`、`/mode` 命令分别受 `allowedCommands.engine`、`allowedCommands.mode` 门控；新建 bot 默认两者开启。
- 引擎选项只列已实现引擎；权限模式选项按所选引擎的支持集（native = build/edit/plan，yolo 被天花板剔除）。
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
- **远程入口天花板取值域唯一所有者**：`@acode/shared`（`bot-remote-guard.ts`）的
  `BOT_REMOTE_FORBIDDEN_PERMISSION_MODES` + `getBotSelectablePermissionModes`（注册表派生）。
  绑定码尝试守护逻辑唯一所有者：`@acode/shared/bot-remote-guard` 的 `createBotBindAttemptGuard`
  （运行态计数仅存活于 `botsService` 进程内存，不落盘）。

## 接口

- `packages/shared/src/bot-remote-guard.ts`（安全加固 P0-3 新增，纯函数叶子、无 import、浏览器安全）：
  - `BOT_REMOTE_FORBIDDEN_PERMISSION_MODES = ["yolo","bypassPermissions"]`、`isBotRemoteForbiddenPermissionMode`。
  - `filterBotSelectablePermissionModes`、`clampBotPermissionMode`（天花板过滤 + 夹取原语）。
  - `createBotBindAttemptGuard`（每 bot 连续错误计数 + 指数退避锁定）+ 常量
    `BOT_BIND_MAX_ATTEMPTS` / `BOT_BIND_BASE_LOCK_MS` / `BOT_BIND_MAX_LOCK_MS`。
- `packages/shared/src/acode-agent-registry.ts`：新增 `getBotSelectablePermissionModes(engineId)`
  = 引擎支持集剔除全权限档（远程入口可选集）。
- `packages/shared/src/bots.ts`：
  - `BotCurrentOptions` 接口补 `cli?: ACodeProvider`（持久化键沿用 `cli`，与 `botCurrentOptionsSchema` 对齐）。
  - 导出 `BOT_DEFAULT_DRAFT_MODE = "build"`（services 与 UI 共用的缺省权限模式单一事实源；
    P0-3 由 `"yolo"` 改为受审批的 `"build"`，与注册表 native `defaultPermissionMode` 一致）。
  - `BotAllowedCommands` 补 `engine?: boolean`；`botAllowedCommandsSchema` 补 `engine`；`DEFAULT_BOT_COMMANDS` 补 `engine: true`。
  - `BotCommand` 补 `engine.list` / `engine.set`；`SelectionPrompt.action` 补 `"engine.set"`。
- `packages/services/src/bots/config.ts`：`normalizeBotCurrentOptions` 保留并归一 `cli`（`normalizeAgentProviderToACodeAgent`）与 `mode`。
- `packages/services/src/bots/botConfigHelpers.ts`：`isUserCommandAllowed` 入参联合补 `"engine"`。
- `packages/services/src/bots/commandParser.ts`：`/engine`（+ 中文别名 `/引擎`）→ `engine.list` / `engine.set`。
- `packages/services/src/bots/commandOrder.ts`：`BOT_POLICY_COMMAND_ORDER` 插入 `engine`。
- `packages/services/src/bots/messages.ts`：新增 `helpEngine` / `engineSelectTitle` / `engineMissing` / `engineChanged`；
  新增 `modeRemoteForbidden`（「远程入口不支持完全访问」，P0-3）、`bindLocked`（绑定锁定剩余等待，P0-3）。
  `modeLocked` 不再由 `/mode` 触发（保留键避免破坏 `BotMessageId`，但改为不可达或复用）。zh-CN / en-US 键集一致。
- `packages/services/src/bots/botsService.ts`：
  - `BotAuthorizedCommand` 补 `"engine"`；`requiresRemoteWorkspaceRuntime` 排除 `engine`（静态列表）；`helpMessageByCommand` 补 `engine`。
  - `createCode()` 用 `randomBytes(8)`（P0-3 扩熵）；`createBotsService` 内实例化 `bindAttemptGuard`；
    `handleBind` 锁定窗口内直接拒绝、错误尝试计数退避、成功清零，仍保留单次使用 + 短 TTL。
  - `getBotDraftModeOptions` 过滤全权限档；新增 `isForbiddenModeRequest`；`/mode`（草稿态 + 活跃任务态）
    显式请求 yolo/bypass 回 `modeRemoteForbidden`，可选集与菜单均剔除全权限档。
  - `buildInitializedDraftOptions(context, defaults?)` / `buildActiveTaskDraftOptions(context, defaults?)` 读取 bot 默认引擎与模式；调用点透传 `auth.bot.currentOptions`。
  - `applyDraftConfigOptions` 下发草稿所选模式（缺省 `BOT_DEFAULT_DRAFT_MODE`）；
    `resolveEffectiveDraftMode` 经 `clampBotPermissionMode` 按引擎作用域夹取到天花板（P0-3 派发侧兜底），
    即使残留 `currentOptions.mode:"yolo"` 也只落到 build/edit/plan。
  - 新增 `engine.list` / `engine.set` 处理器：列表来自 `BOT_ACODE_PROVIDER_OPTIONS`；`engine.set` 写 `currentOptions.cli` 并按新默认重建草稿。
- `packages/ui/src/botsUi.ts`：新增 `BOT_ENGINES`、`getBotPermissionModesForEngine`
  （从 `getBotSelectablePermissionModes` 派生 `{id,labelId}`；P0-3 剔除全权限档，与远程入口天花板同源）。
- `packages/ui/src/BotsDialog/BotSummaryCard.tsx`：新增 `BotEngineCard`、`BotPermissionModeCard`（仿 `BotReplyGranularityCard`，经 `onPatchBot({currentOptions})` 保存）。
- `packages/ui/src/BotsDialog.tsx`：在既有 `SettingsGroupCard` 内挂载两张卡片。
- `packages/ui/src/BotsDialog/shared.tsx`：`createDefaultCommands` 补 `engine: true`。
- `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`：新增 `bots.engine*` / `bots.permissionMode*` / `bots.allowedCommands.engine` 键（复用既有 `engine.*.name` / `engine.permissionMode.*`）。

## 事件顺序

```text
UI 选择权限模式（天花板内）:
  BotsDialog BotPermissionModeCard onValueChange
    └─ onPatchBot({currentOptions:{...cli, mode}}) → saveBot
         └─ normalizeBotCurrentOptions 保留 cli/mode → 写 bot-config.v3.json
         （选项来自 getBotSelectablePermissionModes，不含 yolo/bypass）

聊天创建任务（首条消息，P0-3 天花板）:
  handleMessage → withAuthorizedContext(message,"message")
    └─ buildInitializedDraftOptions(context, auth.bot.currentOptions)
         provider = normalizeAgentProviderToACodeAgent(currentOptions.cli ?? glm)
    └─ createTask({provider, modelSelection, v4Create:true})
    └─ applyDraftConfigOptions(submissionDraftOptions, taskId)
         selectedMode   = resolveEffectiveDraftMode(draft, currentOptions)
                            → clampBotPermissionMode(req, getAgentEnginePermissionModes(provider), BOT_DEFAULT_DRAFT_MODE)
                            → 剔除 yolo/bypass；残留 currentOptions.mode:"yolo" 也被夹到 build
         resolvedMode   = resolveSupportedDraftMode(configOptions, selectedMode, provider)
         acodeTaskService.setMode({taskId, mode: resolvedMode})   // 永不 yolo

/mode yolo（草稿态或活跃任务态）:
  parseBotCommand("/mode yolo") → mode.set
    └─ isForbiddenModeRequest(provider, "yolo") === true
         └─ 回 msg(locale, "modeRemoteForbidden")（不写草稿、不 setMode）

/bind 错误码（P0-3 防爆破）:
  handleBind → bindAttemptGuard.isLocked(botId)  // 锁定期内直接回 bindLocked，不校验码
    └─ 码无效 → bindAttemptGuard.recordFailure(botId)
         failures >= BOT_BIND_MAX_ATTEMPTS → 锁 2^(failures-阈值)·base（封顶 max）→ 回 bindLocked
    └─ 码有效 → 绑定 → bindAttemptGuard.recordSuccess(botId)（清零）→ bindCodes.delete（单次使用）
```

## 验收场景

1. 既有 bot（`currentOptions` 无 `cli`/`mode`）：聊天创建任务用 `glm` + `build`（P0-3 由 yolo 改为受审批缺省），
   副作用工具经既有权限中继回到聊天等待响应，不静默执行（注意：响应者可即发起者本人，见产品规则的中继说明）。
2. 残留 `currentOptions.mode:"yolo"`（本加固前持久化）：派发咽喉经 `clampBotPermissionMode` 夹到 `build`，
   远程入口绝不进入 yolo；该任务触发权限请求时经既有中继回到聊天等待响应，不卡死。
3. UI 把某 bot 权限模式设为 `plan` 并保存：下一条聊天创建的任务经 `setMode` 落到 `plan`；
   UI 默认权限模式卡片选项不含 yolo/bypass。
4. `/mode`（草稿态 + 活跃任务态）列出天花板内模式（native = build/edit/plan，无 yolo）；
   `/mode yolo` 被拒并回「远程入口不支持完全访问」（`modeRemoteForbidden`），不回 `modeMissing`、不写草稿。
5. `/engine` 列出已实现引擎（当前 `[glm]`）；`/engine glm` 写 `currentOptions.cli` 并重建草稿。
6. 连续错误绑定码 N 次（缺省 5）后该 bot 锁定，锁定期内再发任意码回 `bindLocked`（含剩余等待秒数）；
   退避随失败次数翻倍并封顶；绑定成功清零；锁定按 botId 隔离。绑定码为 `randomBytes(8)`（16 hex），单次使用 + 短 TTL。
7. `bot-state.v3.json` / `bot-config.v3.json` 严格 schema round-trip：写入含 `cli`/`mode` 的配置后重新读取通过 `.strict()` 解析。
8. 远端断连：`/engine` 仍可用（静态列表）；草稿初始化只保留 `{provider}`，不申请远端 runtime。
9. **活跃任务天花板（P0-3 修复）**：`/task-attach` 挂到一个已存在的 yolo 任务（如 off-peak/automation 默认 yolo 的任务）
   后发消息 → 回 `taskModeRemoteForbidden` 且**不 resumeTask、不派发 prompt**；该任务在桌面本地切回 build/edit/plan 后可正常派发。
10. **fail closed**：活跃任务元数据读不到时回 `noActiveTask`，不在无法核实模式的情况下放行派发。

## 不在本特性范围

- 外部引擎（codex/opencode/gemini）的会话协议适配器仍 `implemented:false`，不接入；引擎选项过滤后当前只有 glm。
- `sandboxMode` / `approvalPolicy` 选择 UI 与命令：schema 已承载（`botCurrentOptionsSchema`），
  但 codex 等外部引擎未实现，缺真实下发路径，本次不暴露选择入口（保留字段，留待引擎运行时接入）。
- 被刻意禁用的 `allowedCommands` 编辑器不重启用；新命令经 `DEFAULT_BOT_COMMANDS` 默认开启即可生效。
