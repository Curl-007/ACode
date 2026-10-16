# MCP 连接生命周期（懒重连 + 预算熔断）× 第一方写审计 × TTL 持久授权

状态：2026-10-15 落地。本 spec 覆盖三件互相独立、但同属「MCP 生产化」的机制：

1. **R1/R2 MCP 懒重连 + 重连预算 + 状态变更事件**（`adapters/src/mcp/`）；
2. **R3 readOnlyHint → is_write 写审计**（`core/src/mcp/`）；
3. **R4 TTL 持久授权**（`core/src/permission/`，挂进既有策略地板/熔断骨架，不另起炉灶）。

机制设计参照外部成熟实现的公开行为形态（懒重连、singleflight、崩溃预算、限期批准、
写审计），实现与文案全部自撰，落点遵循 ACode 既有边界：

- 连接生命周期的唯一所有者是 `NodeMcpAdapter`（`adapters/src/mcp/index.ts`）；pool
  （`pool.ts`）继续负责 lease/entry 复用与显式 revalidate，不复制预算状态。
- TTL 授权是 `PermissionService.checkPermission` 判定序列里的一个 allow 级位次，与
  策略地板（`managed-policy-floor-and-bypass-immune-breakers.md` R3）、项目 ask/deny、
  反射门共用同一收口，「只收紧不放宽」的总原则不变。
- 写审计沿用 `bash-confirm-reflex-gate.ts` 的审计 sink 接线形态（进程级 set +
  缺省 stderr 兜底），装配期由 bootstrap 换成 info 级服务日志。

## 背景

- `adapters/src/mcp/index.ts` 的 `callTool` 已有两处被动恢复：disconnected record 的
  调用前重连、"Not connected" 竞态的一次重试。但它们**无预算、无去重**：一个反复
  崩溃的 stdio server 会让每次工具调用都触发一轮完整 spawn+握手，模型侧收到裸
  `MCP server is not connected`，没有「别再循环重试」的指引；并发调用会各自发起重连。
- 连接状态（`McpServerStatus.status`）只能被拉取（`status()`），没有变更事件面，
  上层（desktop 设置页、TUI 侧栏）无法被动感知断开/挂起。
- MCP 工具的 `annotations.readOnlyHint` 已参与权限投影（`core/src/mcp/index.ts`），
  但没有任何调用级审计：第一方 server 的每次工具调用（读/写、耗时、成败）在生产
  日志里不可查。
- 权限批准只有两种寿命：会话级（`sessionRules`，随实例生灭）与项目持久级
  （sessionStore 的 project permission ruleset，永久）。「允许 N 天、到期回落询问」
  的中间形态缺失——无人值守场景（cron / off-peak 派发的运行）拿到的持久批准因此
  要么不给、要么永久，都不可接受。

## 产品规则

### R1 MCP 懒重连 + 重连预算（crash budget）

- **懒重连**：自动恢复只发生在「用到时」——`callTool` 发现目标 server 处于
  disconnected（进程关闭 / ping 判死）**或非鉴权类 failed**（或调用中途 transport
  断开）才触发；server 进程关闭（`onclose`）本身只把状态标记为 disconnected，
  不后台自旋重连。failed 也进懒重连面——否则一次自动重连失败后 record 永远停在
  failed，崩溃预算无法经工具调用耗尽。鉴权类失败（OAuth 授权未完成、官方 origin
  不可信）例外：自动重试会重新拉起浏览器授权流程，那是显式操作的副作用面。
- **singleflight**：同一 server 的并发自动重连共享同一个 in-flight promise；后到者
  等待同一结果，绝不重复 spawn/握手。
- **每 server 崩溃预算（双计数器）**：以下两个并列的连续计数**任一**达到
  `crashBudget`（缺省 3）即**熔断挂起**（suspended）：停止一切自动重试，状态携带
  `reconnectSuspension`（计数 + 挂起时刻 + 来源维度 `suspendedBy`），派发
  `reconnect-suspended` 事件，等待人工处理或下一次显式操作。两计数器共享同一
  阈值、同一 suspended 状态面、同一事件与同一显式复位路径：
  - **连续连接失败计数**（`suspendedBy: "connect_failures"`）：计数点 = 一次连接
    失败（显式与自动路径都累积）；复位点 = **任一连接成功**。
  - **连续中途崩溃计数**（`suspendedBy: "in_call_crashes"`）：计数点 = `callTool`
    执行中途 transport 断开（结构化断连错误：SdkError `CONNECTION_CLOSED` /
    `NOT_CONNECTED`，不按错误文本猜测）；复位点 = **一次工具调用完整成功**
    （transport 往返完成且非 in-band isError）。**连接成功不复位本计数**——
    否则「连接必成功、每次 tools/call 都崩溃」的 server 每轮懒重连的连接成功都会
    把计数清零，永远到不了阈值（2026-10-16 真实模型 E2E fixture B 实证：五连败、
    每轮完整 spawn+握手、永不挂起、错误始终是裸 `Connection closed` 无指引，
    恰是本 spec 背景节动机原文描述却未被旧规则覆盖的形态）。
  - `suspendedBy` 是 `reconnectSuspension` 的**附加字段**（来源维度），wire 形态
    保持 fail-safe：忽略它的旧消费者行为不变（至多把挂起显示为普通
    failed/disconnected）。
- **两形态预期行为**（真实模型 E2E 实证，验收测试钉住）：

  | server 形态 | 预期行为 |
  |---|---|
  | A：连接必成功，每进程第 2 次 tools/call 崩溃（成功/崩溃交替） | 懒重连每轮生效；完整成功的调用复位中途计数 → **永不挂起**（server 半可用，继续服务） |
  | B：连接必成功，**每次** tools/call 都崩溃 | 第 `crashBudget` 次中途崩溃即挂起（`suspendedBy: "in_call_crashes"`）；下一次调用起即拒：不再 spawn、错误带「不要在循环里重试」指引；显式 `connectServer` 复活且两计数复位 |

- **最小重试间隔**：两次自动重连之间至少间隔 `minRetryIntervalMs`（缺省 30s）；
  冷却期内的自动重连请求被拒（不 spawn），错误文案给出剩余等待语义。
- **预算复位（解除挂起）的触发点是「显式操作」**：用户/上层显式调用
  `connectServer` / `connectConfiguredServers`（设置页刷新、session 启动、配置变更
  下发的全量收敛）会先复位该 server 的预算（**两个计数器同时清零**）再连接。
  自动路径永不自我复位。
- **成功即清零（分维度）**：任一连接成功复位连续**连接失败**计数；一次工具调用
  完整成功复位连续**中途崩溃**计数。两个复位点互不代偿。
- 失败计数对显式与自动路径都累积（连续失败是 server 的客观事实），但**只有自动
  路径被门禁**——显式连接永远放行，保证用户始终有恢复手段。

### R2 连接状态机与状态变更事件

- 线面状态机沿用既有 `McpServerStatusKind`（connecting / connected / disabled /
  disconnected / failed / untrusted），**不新增枚举值**——`packages/shared` 的 wire
  schema 与 TUI/desktop 消费面对新枚举值的兼容不在本批范围。挂起是附加字段
  `McpServerStatus.reconnectSuspension`，忽略它的旧消费者行为不变（fail-safe：
  至多把挂起显示为普通 failed）。
- adapter 在每次状态跃迁时派发 `McpServerStatusChange`（serverName、previous、
  当前完整 status、trigger、connectionId、时刻）到注入的
  `McpServerStatusChangeListener`。trigger 闭集：`connect-started` / `connected` /
  `connect-failed` / `disconnected` / `disabled` / `reconnect-suspended`。
- 监听器故障不得反向影响连接生命周期（try/catch 吞掉，与遥测旁路同一哲学）。
- desktop/TUI 对该事件的实际接线（设置页实时状态、侧栏颜色）不在本批范围；本批
  只交付事件产出面。

### R2.1 面向模型的失败文案

自动重连被拒（挂起/冷却）与「server 未连接」的工具调用失败，错误文案必须：

- 说明事实（哪个 server、连续失败几次 / 还需等待多久）；
- 携带明确的模型指引：**不要在循环里重试该工具**；挂起时指引模型告知用户去检查
  server（配置/日志），并说明显式重连可恢复；
- 不粘贴内部堆栈、不泄露 env/凭据。

调用中途 transport 断开的裸 "Not connected" 同样收口为带指引的文案（原错误保留在
cause 链），模型侧不再看到无信息量的 SDK 内部措辞。

### R3 readOnlyHint → is_write 写审计（第一方 server）

- **is_write 推导**（`deriveMcpToolIsWrite`）：`annotations.readOnlyHint === true`
  且 `destructiveHint !== true` → 读（is_write=false）；**缺省 fail-closed 为写**
  （hint 缺席 = 按写对待）。审计口径只收紧：宁可把读工具记成写，不可把写记成读。
- **审计范围**：内置/第一方 server 的每次工具调用。第一方判定 =
  `descriptor.official === true`（宿主 origin 校验过的官方 http server）、宿主
  `node_repl`、或经不可伪造 authority 验明的官方 CUA server。第三方 server 不进
  本审计面（其调用日志已有 `adapters.mcp` 的 `mcp.tool.call` 事件承担）。
- **审计条目**：server、tool、is_write、durationMs、status
  （`completed` / `tool-error`（in-band isError）/ `failed`（传输级异常））、
  firstParty 判定依据。级别 info；经 `McpCallAuditSink` 派发，装配期接线到
  `createServiceLogger`（与 bash 反射门审计 sink 同一形态），缺省 stderr 兜底。
- **未覆盖写工具告警（warn 一次）**：注册期（`registerMcpTools`）发现第一方 server
  的写工具（is_write）被 `allowedTools` 显式放行——即默认审批门（MCP 工具
  `needsApproval=true`）被持久 allow 规则关掉——时，按 server 聚合派发一次
  `uncovered-write-tools` 告警事件。语义对齐「内置 server 暴露了未被默认审批覆盖
  的写工具」：ACode 的默认审批覆盖 = needsApproval 恒真，allowedTools 是唯一能
  关掉它的用户面规则，因此告警面就是「写工具 ∩ allowedTools」。
- 审计与告警都是旁路：sink 故障不影响工具调用与注册。

### R4 TTL 持久授权

- **授权形态**：批准可携带过期时间（「允许 N 天」）。载体：
  - wire/in-process：`PermissionUpdate` 增加可选 `expiresAt`（ISO 8601）。带
    `expiresAt` 的 allow 更新进 TTL 存储（持久、到期失效）；不带的维持既有语义
    （会话级 sessionRules 或项目持久 ruleset）。**legacy wire schema
    （`packages/shared` 的 strict zod）尚未携带该字段**，跨进程投递 TTL 批准需要
    shared/v4 schema 跟进（见「范围外接线」）。
  - 存储：`TtlApprovalStore`（`core/src/permission/ttl-approvals.ts`），单一所有
    者，内存为唯一读源，落盘为异步 best-effort（与 ambient 账本同一哲学）。
- **落盘位置与格式**：`<数据根>/cli/permissions/ttl-approvals.json`（数据根解析
  复用 `defaultAmbientDataRootDir`，即 services `getDataBaseDir` 的 core 侧镜像；
  与 ambient 域 `<数据根>/cli/ambient/` 同一层级惯例）。文件带版本号：
  `{ "version": 1, "grants": [...] }`；写入走临时文件 + rename 原子替换。
- **迁移与 fail-closed**：
  - `version` 缺失/0 → 按 1 宽松解析（逐条校验字段）；
  - `version > 1`（来自未来版本的写入）→ **整份作废**并告警：旧构建不得猜测未来
    语义；作废方向 = 授权消失 = 回落 ask，安全；
  - 文件损坏/不可解析 → 同上整份作废（宁可多问，不可误放）；
  - 逐条校验：`toolName` 非空、`expiresAt` 可解析、`origin` 在闭集内；非法条目
    丢弃并计数；已过期条目在加载时清除（lazy prune，评估时同样跳过）。
- **判定位次（与既有骨架的挂接方式）**：TTL allow 是 allow 级规则，消费点两处：
  1. `checkPermissionByMode`：plan 模式判定之后、项目 allow 规则之前——即
     **策略地板 deny/ask（步骤 0/1）、disallowedTools、项目 deny/ask、plan 拒写
     全部结构性压过 TTL 授权**；命中给 `rule.ttl.allow`。
  2. `checkAlwaysAsk`：会话 allow 之后同位消费；但受下条 ask 失效语义约束。
  匹配语义复用 `matchesProjectRules`（toolName + ruleContent + 能力域），不另造
  匹配器。TTL 授权**永不**参与 deny/ask 的加强，只作为放行来源被更严层压制。
- **过期回落 ask**：过期授权从 active 集合消失后，判定自然落回该工具原本的
  ask 分支（MCP 工具 needsApproval=true → build 模式 sideEffect ask）。不存在
  「过期后仍放行」或「过期即 deny」的第三种状态。
- **显式 ask 使已记住的免确认失效**：项目规则层对该工具存在显式 `ask` 规则时，
  alwaysAsk 工具的已记住批准（会话 always-allow 与 TTL 持久授权）**全部不消费**，
  每次调用重新确认（`rule.project.ask`）。策略地板 ask 的同类压制由
  `resolvePolicyAskFloorDecision` 收口既有保证（policy ask 命中时任何 allow 级
  来源都被托底为 ask），TTL 自动包含在内。
- **无人值守默认带期限**：`origin: "unattended"`（cron / off-peak /
  automationTurn 派发的运行）的持久批准一律限期：
  - 带 `expiresAt` → 夹紧到 `MAX_UNATTENDED_TTL_DAYS`（缺省 30 天）；
  - 不带 → 默认 `DEFAULT_UNATTENDED_TTL_DAYS`（缺省 7 天），**绝不永久**。
  交互式（`origin: "interactive"`）批准带 `expiresAt` 时夹紧到 `MAX_TTL_DAYS`
  （缺省 365 天）；不带的 allow 更新不进 TTL 存储（维持既有持久规则路径）。
- **作用域**：grant 可携带 `scopeKey`（项目标识 / workspace identity）；带
  scopeKey 的授权只对携带同一 `permissionScopeKey` 的判定上下文生效，不带的为
  本机用户级。上下文缺省 scopeKey 时只消费用户级授权（fail-closed）。
- **同规则去重**：同 `toolName + ruleContent + scopeKey` 的新授权替换旧授权
  （续期即重新批准），存储不累积重复条目。

## 状态所有者

| 状态 | 唯一所有者 | 说明 |
|---|---|---|
| 连续连接失败计数 / 连续中途崩溃计数 / 冷却 / 挂起 | `McpReconnectBudget`（adapter 实例私有） | 每个 adapter 实例一份；pool 多 entry（多 lease/workspace）各自持有 adapter，预算按连接实例隔离，不跨实例共享。挂起事实以预算为唯一读源，record 状态只携带投影 |
| 自动重连 in-flight promise | `NodeMcpAdapter.autoReconnects` | singleflight 去重表 |
| 连接状态与事件派发 | `NodeMcpAdapter`（records + emitStatusChange） | pool 不复制状态 |
| TTL 授权（内存 + 落盘） | `TtlApprovalStore` | 进程内单实例由装配层持有并注入 `PermissionConfig.ttlApprovals`；内存为唯一读源 |
| is_write 判定 | `deriveMcpToolIsWrite`（纯函数） | 权限投影（readOnly/riskLevel）与审计共用同一 annotations 事实，但各自推导、互不覆写 |

## 事件顺序

```text
[server 进程关闭]
onclose → status=disconnected → event(disconnected)
                                   │（不自动重连，等待使用）
[下一次 callTool]
callTool → budget.check
   ├─ suspended → throw（带模型指引：勿循环重试，告知用户检查 server）
   ├─ cooling   → throw（带模型指引：勿循环重试，稍后由显式操作恢复）
   └─ allowed   → singleflight(autoReconnect)
                     ├─ 成功 → budget.recordSuccess → status=connected → event(connected)
                     └─ 失败 → budget.recordFailure
                          ├─ 未达预算 → status=failed → event(connect-failed)
                          └─ 达到预算 → 挂起 → status=failed+reconnectSuspension
                                        → event(reconnect-suspended) → warn 日志

[显式操作]（设置页刷新 / session 启动 / 配置变更）
connectServer/connectConfiguredServers → budget.reset（两计数器同时清零）
  → 正常连接流程（永不被门禁）

[callTool 执行中途 transport 断开]（第二计数器）
SDK onclose 同步先派发 → status=disconnected → event(disconnected)
  → 挂起的 tools/call 以结构化断连错误（CONNECTION_CLOSED / NOT_CONNECTED）拒绝
callToolOnClient catch → budget.recordInCallCrash
   ├─ 未达阈值 → 原错误上抛（"Not connected" 竞态维持既有一次重试路径）
   └─ 达到阈值 → 挂起(suspendedBy=in_call_crashes)
        → 当前 status 附加 reconnectSuspension → event(reconnect-suspended) → warn 日志
        → 抛带 R2.1 模型指引的错误（原错误进 cause 链）

[工具调用完整成功]（transport 往返完成且非 in-band isError）
callToolOnClient → budget.recordToolCallSuccess → 中途崩溃计数清零
（连接成功只清零连接失败计数，不清中途崩溃计数）

[TTL 授权]
批准（带 expiresAt 的 allow 更新 / grantSessionPermission / store.grant）
  → 内存即刻生效 → 异步落盘（失败仅 warn）
判定：checkPermission
  → 策略地板 deny/ask（既有步骤 0/1，压过 TTL）
  → disallowedTools / 项目 deny / 项目 ask（压过 TTL）
  → plan 拒写（压过 TTL）
  → TTL active allow 命中 → allow rule.ttl.allow
  → （过期后）落回原 ask 分支
```

## 验收场景

1. 同一 server 两个并发 `callTool`（record disconnected）只发起一次重连（singleflight）。
2. 连续 3 次自动重连失败后预算耗尽：状态携带 `reconnectSuspension`，派发
   `reconnect-suspended` 事件；后续 `callTool` 不再 spawn，抛出的错误文案含
   「不要在循环里重试」指引。
3. 挂起后显式 `connectServer` 复位预算并正常连接；成功后计数清零。
4. 冷却期内（< minRetryIntervalMs）的第二次自动重连被拒，不产生 spawn。
5. 每次状态跃迁派发一条 `McpServerStatusChange`；监听器抛异常不影响连接流程。
6. `deriveMcpToolIsWrite`：readOnlyHint=true → false；readOnlyHint 缺席 → true；
   readOnlyHint=true 且 destructiveHint=true → true。
7. 第一方 server 的工具调用产生 info 级审计条目（server/tool/is_write/durationMs/
   status）；in-band isError 记 `tool-error`，传输异常记 `failed` 且异常照常冒泡。
8. 第一方 server 的写工具出现在 allowedTools 时，注册期派发一次
   `uncovered-write-tools` 告警；无 allowedTools 覆盖时不告警。
9. TTL 授权命中：needsApproval 的 MCP 工具在 build 模式由 ask 变 allow
   （`rule.ttl.allow`）；过期后回落 ask。
10. 策略地板 ask 命中时，TTL allow 被托底为 ask（`rule.policy.ask`）；策略 deny
    直接 deny。
11. 项目显式 ask 规则命中时，alwaysAsk 工具的会话 always-allow 与 TTL 授权都不
    消费，每次 ask（`rule.project.ask`）。
12. 无人值守 origin 的持久批准：不带 expiresAt → 7 天默认；带 90 天 → 夹紧 30 天。
13. 存储文件 `version: 2`（未来版本）或损坏 → 整份作废（授权消失、回落 ask）并
    告警；`version` 缺失的 v0 形态按 1 迁移。
14. 带 scopeKey 的授权不作用于缺省 scopeKey 的判定上下文；同规则重复批准替换旧条目。
15. 「每次 tools/call 都崩溃、连接必成功」的 server：第 `crashBudget` 次中途崩溃即
    挂起，状态携带 `reconnectSuspension`（`suspendedBy: "in_call_crashes"`）并派发
    `reconnect-suspended` 事件；下一次调用不再 spawn、错误含「不要在循环里重试」
    指引；显式 `connectServer` 复活且两计数器复位（复活后再崩溃从零重新计数）。
16. 「成功/崩溃交替」（每进程第 2 次 tools/call 崩溃）的 server：≥6 轮交替不挂起
    ——完整成功的调用复位中途崩溃计数，懒重连每轮正常生效。

## 范围外接线（后续批次 / 其他所有者）

- **desktop/TUI 消费 `McpServerStatusChange`**：设置页实时状态与侧栏指示的事件
  接线（desktop main / packages/ui / tui）。
- **bootstrap 装配**：`create-app.ts` 构造 `TtlApprovalStore`（load 后注入
  `PermissionConfig.ttlApprovals`）、注册 `McpCallAuditSink` 到
  `createServiceLogger`（对齐 `setBashReflexAuditSink` 的既有接线位）。
- **审批 UI 的「允许 N 天」选项与 broker 结果携带 `expiresAt`**：
  permission-flow / broker / v4 协议 schema（`packages/shared`）。wire schema
  （strict zod）未更新前，TTL 批准仅进程内可用；带 `expiresAt` 的更新跨 legacy
  wire 会被 strict schema 拒绝——接线批次必须先改 shared schema。
- **无人值守运行的 origin 标记透传**：permission-flow 把
  `automationTurn`/`offPeakTurn`（`ToolExecutionContext` 已有事实）映射为
  `origin: "unattended"` 传入 `grantSessionPermission` /
  `TtlApprovalStore.applyPermissionUpdates`。
- **项目级 ruleset 与 TTL 存储的合并展示**（设置页「已记住的批准」列表）。
