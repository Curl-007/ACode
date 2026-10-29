# M2-8：workspace + provider + process 域 legacy 方法迁 v4

> 状态：**已实施**（2026-10-28 落地，2026-10-29 补录）。
> 实施记录（验收节逐项证据）：
> A. `acodeProtocolMethods.` 消费：本域 11 法 12 → 0（§7 分词 grep 自证；
>    workspaceCancelGenerateText 原 2 处消费）；开工时 43 → 落地后 31（−12 处 / −11 法）。
> B. shared protocol-boundary.test.mjs 46/46 绿，其中本批 M2-8 块 4 条（892 行起）：
>    方法名面 11 条目、params parity×12 负载（含 refine/digest/noKey 边界）、result
>    parity×13 负载（reasonCode 六值/sessionMode/slashCommand 词表钉住）、三叶无反向 import。
> C. CLI handler 测试：按 §5 边界（apps/acode-cli/tests 无协议面引用）未建专属文件；
>    hookTrustGrant notify 联动（accepted → 同 workspaceKey 活跃 session 重载 trust）经
>    bootstrap typecheck + v4 handler 内逐字迁移接线证明；processManager cancel 超时
>    白名单已切 `V4_METHODS.workspaceCancelGenerateText`（不切 = cancel 超时误杀 client）。
> D. 套件（季末收口值；§7 为本批落地时点口径——shared 458、CLI 3181/1 红归兄弟批次台账）：
>    shared 478/478；services 578 pass/0 fail（7 skip 基线）；ui 1125/1125；
>    CLI 3205 pass/0 fail（38 skip 基线）；typecheck 32/32。
> E. lint 163w/0e（基线 164，−1）；architecture:check --changed new 0/regrown 0
>    （violations 303 = 基线，legacy 棘轮 413）。
> 冒烟：§6 如实登记——本批 11 方法**不在** 13 个高危名单；单链路功能测试 + 单测口径。
> 关联：docs/reviews/2026-10-28/m2-scoping.md §5 Batch M2-8；M2-5 三叶/实体迁移先例；
>    M2-6 additive 换名先例；§7 批次记录（含 server 红线三叶自登记录）。
> 上游调研：`docs/reviews/2026-10-28/m2-scoping.md` §5 Batch M2-8
> 收敛计划：`docs/legacy-protocol-convergence-plan.md` M2 节
> 迁移样板：M2-1（commit 5da76197）+ M2-5 plugins 三叶/实体迁移先例 + M2-6 additive 换名先例

## 1. 范围与行为

workspace / provider / process 三域 **11 个 legacy 方法全部迁 v4**（`v4/` 前缀，载体复用同一
JSON-RPC 传输），无保留词：

| legacy 词 | v4 词 | 形态 | 语义 |
|---|---|---|---|
| `workspace/readPresentation` | `v4/workspace/readPresentation` | query | workspace 展示面：mode + slashCommands 现扫 |
| `workspace/hooks/trustGrant` | `v4/workspace/hooks/trustGrant` | command（写） | workspace 级 hook 预信任授权；**accepted 时 notify 同 workspaceKey 全部活跃 session 重载 trust**（联动语义保持） |
| `workspace/updateInteractionPreferences` | `v4/workspace/updateInteractionPreferences` | command（写） | askUserQuestion 自动裁决开关 → runtime prefs + interaction registry |
| `workspace/updateModelIoPreferences` | `v4/workspace/updateModelIoPreferences` | command（写） | ModelIO 全量落盘开关 → runtime prefs + 全部 resident session adapter |
| `workspace/updateOffPeakToolPolicy` | `v4/workspace/updateOffPeakToolPolicy` | command（写） | Off-Peak 工具面灰度门（host 判定结论的进程缓存） |
| `workspace/updateDynamicWorkflowPolicy` | `v4/workspace/updateDynamicWorkflowPolicy` | command（写） | 动态工作流灰度门（同构进程缓存） |
| `workspace/generateText` | `v4/workspace/generateText` | query（有 LLM IO，可取消） | workspace 级一次性文本生成（prompt-polish 等）；operationId 键控取消注册表 |
| `workspace/cancelGenerateText` | `v4/workspace/cancelGenerateText` | 控制面 | 按 operationId 中止在途 generateText；best-effort |
| `provider/updateAccountConfig` | `v4/provider/updateAccountConfig` | command（写） | Account Provider Config 快照热同步（revision 回执校验） |
| `provider/testModelConnectivity` | `v4/provider/testModelConnectivity` | query（有网络 IO） | 连通性测试；先刷新 Provider Registry 再测，临时 app 用后关闭 |
| `process/childProcesses` | `v4/process/childProcesses` | query | MCP 子进程注册表内存态暴露（观测面；归属补齐，无 I/O） |

「command（写）/query」形态 = v4 名字空间的普通请求-响应 RPC（workspace 级、无会话、无 CAS），
**不是** conversation `v4/command` 信封。dispatch 先例 = usageStats/plugins：server.ts 一行转发
直调实体，不经 v4Gateway。

载荷形状与 legacy **逐字 parity**（同字段、同 strict、同值域）——消费者语义零变化。v4 侧在
`acode-protocol-v4/` 结构化再声明（不反向 import legacy barrel，守 protocol-boundary 纪律），
两侧形状由 `packages/shared/tests/protocol-boundary.test.mjs` 新增用例钉住。

### 两项已知裁决的落实

1. **`workspaceGenerateText` 不提前退役，随本批迁 v4**：legacy 自述「LLM 执行面在 CLI，直连
   不可行」指 remote 场景，本地语义保留。operationId 取消注册表
   （`workspaceGenerateTextControllers`）与 `withWorkspaceGenerateTextSignal` 包装、重复
   operationId `-32600` 拒绝语义逐字保留。
2. **`processChildProcesses` 是 CLI 内存态暴露——迁（观测面保留）**：CPU/内存采样由桌面
   Host 完成，CLI 只做归属补齐；迁 v4 不改纯函数形状。

## 2. 所有权

### shared（`packages/shared/src/acode-protocol-v4/`，三叶，max-file-lines 400 门禁分流）

- **`workspace-runtime.ts`**（读/执行面三法）：readPresentation + generateText +
  cancelGenerateText 的 params/result。`acodeSessionModeSchema` 与 `acodeSlashCommandSchema`
  不在 v4-imports-legacy-protocol 白名单（前者在 legacy-types 但未登记，后者在 barrel），
  按「结构化再声明」纪律本地逐字再声明（plugins-queries.ts 的 deliveryKind 先例），值域
  parity 由协议测试钉住。`modelSelectionSchema` 取自中立叶 `../model-selection.js`。
- **`workspace-policies.ts`**（授权/配置同步面五法）：hookTrustGrant + interactionPrefs +
  modelIoPrefs + offPeakToolPolicy + dynamicWorkflowPolicy 的 params/result；hook digest
  正则与 reasonCode 六值枚举逐字再声明。
- **`provider-process.ts`**（provider 两法 + process 一法）：updateAccountConfig（states
  信封的 `accountProviderUnavailableReasonSchema` 取自中立叶 `../account-provider-state.js`）、
  testModelConnectivity、childProcesses。
- `transport.ts` 的 `V4_METHODS` 新增 11 条目（小锚点追加）；`index.ts` 加三叶 export。
- `command.ts` **不动**：11 法皆非 sessionId 键控会话 CAS 命令（M2-5 同款边界）。

### CLI（`apps/acode-cli/packages/bootstrap/src/`）

- 新建 v4 handler（`acode-protocol-v4/`）：
  - `workspace-runtime.ts`：`readWorkspacePresentationV4`（实体自 legacy
    `workspace-model-runtime.ts` 逐字迁，parse 改 v4 schema）。
  - `workspace-policies.ts`：四个 policy/prefs 写 handler（实体自 legacy 四个小文件逐字迁）。
  - `workspace-hook-trust-grant.ts`：`grantWorkspaceHookTrustV4` = 授权实体（自 legacy
    `workspace-hook-trust.ts` 逐字迁，parse 改 v4 schema）+ **notify 联动**（自 server.ts
    迁入 `notifyWorkspaceHookTrustGrantSessions`：accepted 后按 workspaceKey 通知全部活跃
    session `reloadWorkspaceHookTrust()`）。
  - `provider-process.ts`：`updateAccountProviderConfigV4` / `testProviderModelConnectivityV4`
    （实体自 legacy 逐字迁）+ `listChildProcessesV4`（纯函数逐字迁）。
- **`generateWorkspaceText` 实体留在 legacy `server-operations.ts`**（该文件不在本批范围，
  兄弟在途）：v4 case 按 usageStats/catalog 先例一行转发，继续经既有
  `withWorkspaceGenerateTextSignal` 包装；`cancelWorkspaceGenerateText` 私有方法与
  `getOperationId` 保持，legacy/v4 两词共用同一取消注册表（operationId 键控与协议代际无关，
  迁移窗口内旧词在途操作仍可被新词取消——但 services 侧同批切 v4，实际只有单代际在途）。
- legacy 删除（消费归零后删，M2-1/M2-5 同款纪律）：
  - 删文件×7：`interaction-preferences.ts` / `model-io-preferences.ts` /
    `off-peak-tool-policy.ts` / `dynamic-workflow-policy.ts` / `account-provider-config.ts` /
    `process-child-processes.ts` / `workspace-hook-trust.ts`（均仅 server.ts 引用，已复核）。
  - `workspace-model-runtime.ts` 保留但摘除 `readWorkspacePresentation` /
    `testProviderModelConnectivity` 两实体（`createWorkspaceACodeApp` /
    `hasSessionModelProvider` / `ensureSessionModelAvailable` / `resolveSessionModelContextWindow`
    仍被 server-operations.ts / v4-bridge.ts 消费）；`workspace.ts`（buildWorkspaceRef helper）
    不动。
  - `server.ts`：删 11 个 legacy case + 已迁移的 notify helper + 失效 import；v4 区加 11 个
    一行转发 case（generateText 保留 signal 包装；hookTrustGrant 联动在 v4 handler 内）。

### services（`packages/services/src/acode-agent/`）

- `acodeAgentService.ts` 12 处消费（11 方法；`workspaceCancelGenerateText` 两处）改调
  `V4_METHODS.*` + v4 result schema；legacy schema import 同步换成 v4 子路径 barrel。
- **`acodeAgentProcessManager.ts` 联动必改**（1884 行）：`onRequestTimeout` 对
  `"workspace/cancelGenerateText"` 字面量的 best-effort 白名单（cancel 超时不杀 client）改认
  v4 词——否则迁后 cancel 超时误判 stale 杀进程（行为回归）。与 M2-5「pluginsList 超时判定改
  v4 方法名」同款耦合。

### skew 语义保持（不改行为）

- `workspaceUpdateModelIoPreferences` / `offPeakToolPolicy` / `dynamicWorkflowPolicy` 的
  `isProtocolMethodNotFoundError` 降级保留：旧 CLI 不认识 v4 词 → -32601 → 同一降级路径。
- `processChildProcesses` 的 catch-all（旧 CLI 不认识/忙 → children 空，后代归 cli）保留。
- `workspaceReadPresentation` 的 closed-transport 重试一次保留（与方法名无关）。
- `providerUpdateAccountConfig` 的 revision 回执校验保留。

## 3. 不变量

1. **hookTrustGrant notify 联动**：accepted 后按 workspaceKey 匹配通知全部活跃 session 重载
   trust store（迁移逐字保留；联动代码与授权实体同驻 v4 handler，回归测试可直造 sessions Map）。
2. **trust 授权 fail closed**：policy provider 异常 → `workspace_hooks_blocked_by_policy`；
   未知异常只收敛公开稳定码，不透传底层文本（逐字保留）。
3. **generateText 取消语义**：活跃 operationId 唯一（重复 -32600）；注册表键控与代际无关；
   无 operationId 时裸跑。
4. **testModelConnectivity 不旁路配置事实**：先 `refreshProviderRegistry("provider-connectivity")`
   再测；复用同 workspace 活跃 app，临时 app finally 关闭。
5. **v4 不反向 import legacy barrel**：三叶只从白名单符号（`acodeWorkspaceRefSchema`）与中立叶
   （model-selection / account-provider-state）取件；sessionMode/slashCommand 本地逐字再声明。
6. **失败语义**：参数非法走 `-32602`（parseParams 既有行为）；hookTrustGrant 领域失败走 result
   内 accepted/reasonCode，不抛协议错误。
7. **providerUpdateAccountConfig 缺运行时**：`syncAccountProviderConfig` 未装配 → `-32018`
   （逐字保留）。

## 4. 失败语义与版本偏斜

**11 法无 skew fallback 新增，也不保留 legacy 双写**：对照 M2-1 删除 sessionSetModel/
sessionSetMode、M2-5 管理面 16 法、M2-6 同批裁决——host 与 CLI 同版本发布，v4 方法名即版本
边界；写路径在版本错配时硬失败（用户升级）优于静默双写。既有 `isProtocolMethodNotFoundError`
降级链（§2 skew 节）是 host 侧既有行为，随词换名保留。

不删 legacy schema 与 `acodeProtocolMethods` 词表条目（M2-1/M2-5/M2-6 同款纪律，M4 统一删
barrel）。

## 5. 迁移边界

**做**：11 方法 v4 schema 三叶 + CLI 实体迁移/转发 + dispatch 换名 + services 12 处切换 +
processManager 超时白名单联动 + 协议单测。

**不做**：
- 不删 legacy barrel 任何符号（M4 统一）。
- 不动 `server-operations.ts`（兄弟在途；generateWorkspaceText 实体留驻一行转发）。
- 不动 PROVIDER_DIAGNOSTICS_METHODS（U08 中立叶，本就不在 legacy barrel 面）。
- 不动 UI（经 services facade 消费，载荷同形，无感）。
- 不动 core/adapters 的 trust store、provider registry、MCP 进程注册表实现。
- `apps/acode-cli/tests/**` 无协议面引用（实测 grep 无命中），不配套修改。

## 6. 冒烟与验收

本批 11 方法**不在** 13 个 stream/snapshot/queue 高危名单（subscribe/send/stop/
cancelBackgroundTask/fork/compact/create/resume/read/messages/events/goal/close）。
按纪律执行：单链路功能测试 + 单测。

验收场景：
1. workspace 展示面（readPresentation）：协议单测钉 parity；CLI 实体逐字迁移，行为不变。
2. hook 预信任（hookTrustGrant）：accepted → 同 workspaceKey 活跃 session 重载；rejected
   路径 reasonCode 词表不变。
3. 四策略同步（interaction/modelIo/offPeak/dynamicWorkflow）：runtime prefs 缓存与既有
   session 立即更新语义不变；-32601 降级保留。
4. generateText/cancel：operationId 注册表、重复 -32600、best-effort cancel 与 5s 超时、
   processManager cancel 超时不杀 client（v4 词白名单）。
5. accountConfig 热同步：revision 回执校验与 `-32018` 未装配语义不变。
6. testModelConnectivity / childProcesses：刷新-测试-关闭顺序与观测面形状不变。
7. `grep acodeProtocolMethods.` 本域 11 方法词 −11（分词 grep 自证）。
8. 新协议单测全绿；shared/services/bootstrap 受影响套件全绿；typecheck 文件集零错误；
   architecture 文件集 new 0 / regrown 0（兄弟批次在途改动经 `git status` 区分归属后标注）。

## 7. 批次记录（2026-10-28 落地）

- `acodeProtocolMethods.` 消费实测（`git grep "acodeProtocolMethods\." HEAD -- packages/services/src` vs 工作树 grep）：
  - HEAD 基线 **72**；本批开工时合并工作树实测 **43**（acodeAgentService 41 +
    pluginReferenceCatalogRequest 2；M2-5 −16、M2-6 −9 已落地，M2-2 在途）。
  - 本批后工作树 **31**（acodeAgentService 29 + pluginReferenceCatalogRequest 2），
    本批 **−12 处 / −11 方法**（`workspaceCancelGenerateText` 原 2 处消费）。
  - 分词自证：本域 11 方法词的 `acodeProtocolMethods.` 消费 **12 → 0**（grep
    `acodeProtocolMethods\.(workspaceReadPresentation|workspaceHookTrustGrant|workspaceUpdate*|workspaceGenerateText|workspaceCancelGenerateText|providerUpdateAccountConfig|providerTestModelConnectivity|processChildProcesses)`
    实测 0 命中）。
  - 绝对数与验收口径（47→36）的偏移 = 兄弟批次同窗口落地节奏；域词分词口径达成 −11。
- legacy 删除清单：删文件 ×7（`interaction-preferences.ts` / `model-io-preferences.ts` /
  `off-peak-tool-policy.ts` / `dynamic-workflow-policy.ts` / `account-provider-config.ts` /
  `process-child-processes.ts` / `workspace-hook-trust.ts`，删除前复核均仅 server.ts 引用）；
  `workspace-model-runtime.ts` 摘除 `readWorkspacePresentation` /
  `testProviderModelConnectivity` 两实体（其余 session 模型 runtime helper 仍被
  server-operations.ts / v4-bridge.ts 消费，文件保留）；`server.ts` 删 11 个 legacy case +
  notify helper（迁 v4 handler）+ 失效 import。
- v4 新增：`V4_METHODS` 11 条目；shared 三叶（workspace-runtime / workspace-policies /
  provider-process）；CLI 四 handler（workspace-runtime / workspace-policies /
  workspace-hook-trust-grant / provider-process）；generateText/cancel 实体留驻
  server-operations.ts + server.ts 私有方法，v4 case 一行转发（usageStats/catalog 先例）。
- hookTrustGrant notify 联动保持证据：`acode-protocol-v4/workspace-hook-trust-grant.ts` 的
  `grantWorkspaceHookTrustV4` = legacy server.ts case 体逐字迁（grant → accepted 时
  `notifyWorkspaceHookTrustGrantSessionsV4` 按 workspaceKey 匹配 `context.sessions` 全部
  活跃 record 调 `app.reloadWorkspaceHookTrust()`）；bootstrap typecheck 通过证明接线完整。
- services 联动：`acodeAgentProcessManager.ts` onRequestTimeout 的 cancel best-effort
  白名单字面量 `"workspace/cancelGenerateText"` → `V4_METHODS.workspaceCancelGenerateText`
  （不随词改 = cancel 超时误杀 client 的回归）。
- 协议单测：protocol-boundary.test.mjs 新增 4 用例（方法名面 11 条目、params parity×12
  负载 + refine/digest/noKey 边界、result parity×13 负载 + reasonCode/sessionMode/
  slashCommand 词表钉住、三叶无反向 import）。
- 门禁实测：shared 458/458；services 578 pass / 7 skip（与基线一致）；bootstrap
  typecheck exit 0；services typecheck exit 0（shared dist 重建后）；
  architecture:check --changed new 0 / regrown 0；文件集 oxlint 0 错误（transport.ts:997
  no-control-regex 为既有 164w 基线内警告，非本批引入）。
- CLI 套件：apps/acode-cli 全套 3181 测试——3142 pass / 38 skip / **1 fail**；唯一红 =
  third-party-reproducibility L01 台账漂移，指名 `packages/ui/src/components/ai-elements/
  message.tsx`（兄弟批次 GodComponentsBatch5 在途改动，M2-5 已按 2ddaf691 先例 IRC 移交
  回补台账；台账禁区本批不碰）。本批文件集零红。
- server 红线登记（`packages/server/tests/harness-api.test.mjs` allowedChanges，M2-3 IRC
  提醒）：自登三叶 `workspace-runtime.ts` / `workspace-policies.ts` / `provider-process.ts`；
  复跑红线 unexpected 仅剩 M2-4 的 `inbound-interaction.ts`（在途批次不代登记纪律，属主
  自登）。本批三叶红线清零。
