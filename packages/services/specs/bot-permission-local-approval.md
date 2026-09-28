# Bot 任务权限的桌面本机确认（P0-3 诚实边界的真正修法）

状态：已实现（阶段 1 + 阶段 2，同一分支交付）。

## 背景与问题

bot 任务（Telegram/飞书等聊天机器人驱动的 ACode 任务）产生的工具权限请求，当前唯一批准入口是
发起聊天的用户在 bot 会话里点按钮（`botsService.ts` 的 `permission.respond`/`approve`/`deny`
三个 action → `acodeTaskService.respondPermission`）。这意味着**发起执行的人就是批准执行的人**
（self-approval）：远端聊天通道成了权限体系的旁路，「ask 模式需要人批准」在 bot 链路上退化为
一次点击的摩擦而不是边界。

桌面 renderer 侧现状（调查结论，均已核实）：

- `acodeTaskService.respondPermission` **已经**经 ProxyChannel 自动代理暴露在 RPC 面上
  （`packages/rpc/src/proxy-channel.ts` 按方法名分发；`packages/client/src/remoteServiceAccess.ts`
  的 `acodeTaskService` 是完整 `IACodeTaskService` 代理），无需新增 RPC 命令。
- bot 权限请求经 `bots:task` / `bots:task-stream` 广播进入
  `acodeSessionStore.setTaskPermissionRequest`（`packages/ui/src/root/useBotBroadcastEffects.ts`），
  但该 store 状态（`taskUiByTaskId[taskId].permissionRequest` + `pendingPermissionRequests` 队列）
  **没有任何读取方**——是只写不读的死状态。权限弹窗 `V4InteractionDialogs` 只消费当前打开
  session 的 v4 snapshot `pendingInteractions`；elicitation 已有 store 兜底消费先例
  （`botElicitationProgress`），permission 没有。
- 任务列表角标 `TaskInteractionBadge`（「等待确认」）由 sessions-index 投影的
  `task.pendingInteraction` 驱动，bot 任务就是普通任务，天然被覆盖，**不需要改动**。

## 设计决策（已与用户对齐）

分两阶段，同分支交付：

- **阶段 1（B，纯能力，无行为变更）**：桌面本机成为 bot 权限请求的可用批准入口。
- **阶段 2（A，门槛，默认关）**：用户级设置「Bot 任务权限需本机确认」；开启后 bot 聊天侧
  不再提供可交互批准卡片，只能在桌面本机批准。管理员可经 OS 托管策略地板强制开启
  （`requireLocalPermissionApproval`），用户设置无法放宽。
- 配对手机远控**不算**可信确认者：门槛开启后只有桌面本机窗口（renderer 直连 host 的
  `acodeTaskService` / v4 订阅）能批准。手机远控复用桌面 Host attachment 时走的是同一
  renderer 能力面，不在本 spec 内单独设限——其信任边界由远控配对鉴权负责。

## 所有者与事件顺序

```
权限请求权威状态：CLI runtime interaction-broker（pendingInteractions）
门槛判定所有者：host botsService（bot 通道收口）= AppSettings(用户) ∨ managed floor(管理员, fail-closed)
响应收口：v4 resolveInteraction（所有通道最终同一条命令；重复响应由 broker ACK duplicate/noop 吸收）

阶段2门槛开启时，permission_request 事件顺序：

CLI runtime(interaction-broker)
  │ permission_request（stream 事件）
  ▼
host botsService.watchTaskStream
  ├─(1) broadcastTaskListChange("bots:task", permission_request)   ── 始终发送，不受门槛影响
  │        ▼
  │     renderer useBotBroadcastEffects → acodeSessionStore.setTaskPermissionRequest（回放投影）
  │        ▼
  │     V4InteractionDialogs：snapshot 无同 requestId 交互时，用 store 兜底渲染 PermissionDialog
  │        ▼ 用户点批准
  │     services.acodeTaskService.respondPermission（RPC，task 级，不依赖 session 订阅健康）
  │        ▼
  │     adapter → v4 resolveInteraction(interactionId≡requestId) → CLI broker → agent 继续
  │        ▼
  │     botsService 收到 permission_resolved → 广播 → renderer store 出队（与本地乐观清理幂等）
  ├─(2) 门槛开：只读提示（摘要 + 「请在桌面端确认」文案）；不写 pendingPermissionOptions
  └─(3) 门槛关：SelectionPrompt 批准卡片（现状行为，不变）

桌面已打开该 session 且 v4 订阅健康时：snapshot.pendingInteractions 直接驱动弹窗
（既有路径），store 兜底按 requestId≡interactionId 去重后自动让位——单一事实源仍是 broker。

任务列表角标/通知：sessions-index 投影 → task.pendingInteraction → TaskInteractionBadge（既有，不动）
```

关键不变量：

- **renderer store 只是广播回放投影**，不产生新事实；snapshot 与 store 同时含同一 requestId 时
  snapshot 路径优先（它是权威投影），store 兜底仅在 snapshot 缺失该交互时渲染。
- **响应幂等**：`respondPermission` 与 `sendCommand(resolveInteraction)` 最终是同一条 v4 命令；
  两端 racing（bot 卡片 vs 桌面弹窗，门槛关闭时可能并存）由 CLI broker 的 duplicate/noop ACK 吸收。
- **门槛只收窄 bot 通道**：桌面本机（含打开 session 的 v4 路径与 store 兜底路径）永远可批。

## 规则

### R1 阶段 1：桌面兜底批准路径

- R1.1 新增纯函数模块 `packages/ui/src/v4/botPermissionFallback.ts`：
  - `selectFallbackPermissionRequest(snapshotPending, storeState)`：候选队列 =
    `[permissionRequest, ...pendingPermissionRequests]`（保序、去 null）；跳过 requestId 命中
    snapshot permission 交互 interactionId 的候选；返回首个剩余候选或 null。
  - `buildTaskRespondPermissionParams({taskId, workspacePath, workspaceIdentity, request, option})`：
    组装 `respondPermission` 参数；`response` 取自 `option.response`（legacy
    `ACodePermissionOption` 自带完整 response）；`workspaceIdentity` 仅在有值时出现。
- R1.2 `V4InteractionDialogs`：仅当 snapshot 无可渲染 pending（permission/userInput 均无）时，
  用 R1.1 的兜底请求渲染 `PermissionDialog`；onRespond 经
  `services.acodeTaskService.respondPermission` 提交，成功后本地乐观
  `removeTaskPermissionRequest`（队列自动顶上下一个；与广播 permission_resolved 的二次清理幂等）；
  失败（false/throw）展示既有 `chat.permission.responseFailed` 错误态并允许重试。
- R1.3 兜底路径与 snapshot 路径共用 responding/failed 视觉状态与单飞（flight）防重入约束。
- R1.4 不改任务列表角标、系统通知、广播协议、store 写入方。

### R2 阶段 2：门槛

- R2.1 AppSettings 新增布尔 `botPermissionLocalApprovalEnabled`，**默认 false**；三处同步：
  `validationAppSettings.ts` 主 schema + patch schema、`protocol.ts` 镜像类型。设置页在
  「Agent 提问自动继续」附近加 Switch 行，i18n zh/en 双份，带 test id。
- R2.2 managed policy 地板 schema 新增可选键 `permissions.requireLocalPermissionApproval: boolean`。
  该键对 CLI 权限判定无作用（CLI 侧接受但忽略）；语义由 host botsService 消费。**严格 schema
  必须同步接受该键**，否则管理员部署该键会让 CLI 地板降级为 MINIMAL_LOCKDOWN（丢 deny 规则）。
- R2.3 门槛判定（纯函数，`packages/services/src/bots/botPermissionLocalApproval.ts`）：
  `required = settings.botPermissionLocalApprovalEnabled === true
  ∨ managed.status === "invalid" ∨ managed.requireLocalPermissionApproval === true`。
  - 策略文件损坏/不可读 → **fail-closed 视为开启**（与 CLI MINIMAL_LOCKDOWN 同一克制哲学：
    不阻断工作——桌面本机仍可批——只收回较弱通道）。
  - 管理员地板开启时用户设置不能放宽（strictest-wins，∨ 语义天然满足）。
- R2.4 botsService 接线：
  - `permission_request` 事件分支：`broadcastTaskListChange` 照常先发；门槛开 → 发只读提示
    （复用 `formatBotPermissionRequestSummary` 摘要 + 新文案 `permissionAwaitingDesktopApproval`），
    **不写** `pendingPermissionOptions`（bot 侧从源头没有可交互路径）；门槛关 → 现状不变。
  - `permission.respond` / `approve` / `deny` 三个 action 分支：鉴权后、解析选项前加守卫，
    门槛开 → 回复新文案 `permissionLocalApprovalRequired` 并 return（纵深防御：覆盖门槛开启前
    已发出的旧卡片按钮与手打命令）。
  - 门槛每次事件即时判定（settings `get()` + 策略文件小 JSON 同步读），不做进程级缓存——
    权限事件天然低频，且设置/策略变更需立即生效。
- R2.5 新文案 keys（`messages.ts` zh + en 双份，TS 类型强制对齐）：
  `permissionAwaitingDesktopApproval`、`permissionLocalApprovalRequired`。
- R2.6 只读提示必须保留权限摘要（工具名/命令预览），让聊天侧用户知道桌面端在等什么。

### R3 managed-policy 单一来源

- R3.1 canonical schema、OS 路径解析、文件读取迁到 `packages/shared/src/node/managedPolicy.ts`
  （node-only，经 `@acode/shared/node` 子路径导出，不进 renderer bundle）；
  `ACODE_MANAGED_POLICY_FILE` env 覆盖与打包态忽略（`isPackaged` 语义）原样保留。
- R3.2 `apps/acode-cli/packages/adapters/src/config/managed-policy.ts` 改为 shared 加载器的薄包装：
  对外导出（`ACODE_MANAGED_POLICY_FILE_ENV`/`resolveManagedPolicyFilePath`/`loadManagedPolicyFloor`）、
  返回类型（contracts `ManagedPolicyFloorData` + `ConfigDiagnostic`）、诊断文案、
  MINIMAL_LOCKDOWN/空文件语义全部不变；`requireLocalPermissionApproval` 不进入 CLI floor 数据。
- R3.3 host 侧（services）直接消费 shared 加载器，`isPackaged` 取
  `isPackagedACodeDesktopRuntime()`（P1-7 同一门禁哲学：打包态只信 OS 托管路径）。
- R3.4 shared 加载器返回判别式结果 `{status: "missing"|"invalid"|"ok", policy?, filePath}`，
  fail-closed 策略留给各消费方（CLI→MINIMAL_LOCKDOWN；services→门槛开启），不在 shared 里做决策。

## 验收场景

1. 门槛关（默认）：bot 卡片可批（现状回归不变）；桌面打开该 bot 任务 session，snapshot 弹窗可批；
   桌面 store 兜底不重复渲染同 requestId 弹窗。
2. 门槛开：bot 收到只读提示（含权限摘要），无可交互按钮；`/approve`、`/deny`、旧卡片按钮一律
   被守卫拒绝并收到指引文案；`broadcastTaskListChange` 仍发出，桌面角标/弹窗/通知不受影响。
3. 门槛开 + snapshot 缺失（订阅不健康/事件竞态）：桌面打开 session 后 store 兜底渲染弹窗，
   批准经 `respondPermission` 落地，队列中下一个请求自动顶上。
4. 管理员策略文件含 `requireLocalPermissionApproval: true`：用户设置关闭也强制门槛开；
   CLI 地板正常加载（deny/ask 规则不丢、不降级 MINIMAL_LOCKDOWN）。
5. 策略文件损坏：CLI 侧 MINIMAL_LOCKDOWN（现状不变）；services 侧门槛 fail-closed 开启。
6. 两端 racing（门槛关时 bot 与桌面同时批）：先到者生效，后到者收到 duplicate/noop，不重复执行。

## 测试计划

- `packages/ui/test/botPermissionFallback.test.ts`：R1.1 两个纯函数（snapshot 去重、队列保序、
  workspaceIdentity 条件展开、response 取自 option）。
- `packages/shared/tests/managed-policy.test.mjs`：R3.1 schema 新键接受/未知键仍拒绝/损坏→invalid/
  路径解析与 env 门禁不变。
- `apps/acode-cli/tests/managed-policy-floor.test.mjs`：既有 13 条回归 + 新增「含
  requireLocalPermissionApproval 的策略文件正常加载且 CLI floor 语义不变」。
- `packages/services/tests/botPermissionLocalApproval.test.ts`：R2.3 真值表（设置/地板/invalid/缺失）。
- AppSettings schema：默认 false、patch 接受（并入现有 settings 测试风格）。

## 非目标

- 不改 CLI 权限判定与 interaction-broker（响应收口已存在）。
- 不做手机远控的独立确认者分级（见设计决策第三条）。
- 不改任务列表角标数据源（sessions-index 投影已是权威）。
- elicitation（AskUserQuestion）的 bot 代答门槛不在本 spec 范围——问答不是权限边界，
  且已有 autoResolution 设置约束。
