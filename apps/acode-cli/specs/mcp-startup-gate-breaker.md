# MCP 快启门 + Deferred 工具缓存 × 崩溃风暴熔断 × 静默探测阶梯 × 配置硬化

状态：2026-10-18 立项（价值提取 T1#12）。所有权域：`apps/acode-cli/packages/adapters/src/mcp/**`
及其测试（`apps/acode-cli/tests/mcp-startup-gate-deferred-tools.test.mjs`、
`apps/acode-cli/tests/mcp-crash-storm-probe-ladder.test.mjs`）。

机制形态参照外部成熟实现的**公开行为**（oh-my-pi，MIT：`docs/mcp-runtime-lifecycle.md`
110-124 行快启门 + DeferredMCPTool、197 行崩溃风暴熔断、196-198 行静默探测阶梯、
`discovery/helpers.ts` 的 `${VAR:-default}` 深展开、`tool-bridge.ts` 的确定性碰撞赢家），
实现与命名全部自撰；沿用既有边界纪律（懒重连 spec R1 的门禁与复位语义不动）。

## 背景

- `NodeMcpAdapter.connectConfiguredServers` 目前对全部配置 server `Promise.all` 等
  连接收敛——一个慢 server（冷启动 npx 拉包、远端挂起）把 session 启动拖到它的
  30s 超时为止。重连预算（R1）与 OAuth 已成熟，但**启动时序**没有预算门。
- 曾连接成功的 HTTP/SSE server 死掉后，恢复只有两条路：用户显式操作，或下一次
  工具调用的懒重连。会话空闲期间无人补位，资源订阅与工具面长期「无声死亡」。
- 反复「连接成功→立即崩溃」的 stdio server：connect 成功会复位 R1 的
  connect_failures 计数、in_call_crashes 只数调用中途断开——进程在两次调用之间
  崩溃的风暴形态两个计数器都追不到，spawn 循环无上界（参考实现 issue #1592 的
  fork-bomb 形态）。
- MCP 配置值不支持 `${VAR:-default}`：跨机器共享 `.mcp.json` 时路径/密钥只能写死
  或靠宿主预替换。
- 工具名 sanitizer 是有损的：`(server:"a.b", tool:"c-d")` 与 `(server:"a-b",
  tool:"c.d")` 都 mint 成 `mcp__a_b__c_d`。两个不同来源撞名时注册结果取决于数组
  顺序（重连后 append 顺序可能翻转），所有权不稳定。

## 产品规则

### R1 快启门 + Deferred 工具（缓存兜底）

- `connectConfiguredServers`（session 启动 / 配置变更全量收敛）给**整批**连接任务
  一个预算门：`startupGate.budgetMs`（缺省 **250ms**；`0` = 关门等全部收敛，对齐
  参考实现的 `0 = wait until settled`）。预算内 settle 的 server 走既有语义
  （connected/failed/disabled）；仍 pending 的 server：
  - **缓存命中**（工具缓存存在且配置指纹一致）：把缓存 descriptor 注册进该
    server 的 in-flight record（`record.tools` 原子赋值），状态保持 `connecting`。
    模型面立即可见工具（schema 可用）；`callTool` 经既有 `record.connecting`
    等待路径阻塞到握手完成或失败——「调用时未就绪则等待/明确报错」由既有
    waitWithinMcpDeadline 语义承担，不新增等待代码。
  - **缓存未命中**：启动不注册任何工具，连接任务**留在后台继续**（绝不取消）；
    完成后走既有 connected 路径注册真实工具。慢 server 永不阻塞启动。
- **后台完成 = 原子替换点**：`openServerConnection` 成功路径 `records.set(...)`
  一次性替换 record（真实工具 + connected 状态 + `connected` 状态事件）。代际
  守卫（`isCurrentConnection`）保证迟到的旧代际完成不会覆盖新代际（幂等边界）。
- **缓存**（`mcp-tool-cache.ts`，磁盘 JSON，落点
  `<数据基目录>/.acode/cli/mcp/tool-cache.json`）：
  - 键 = server 稳定身份（复用 `mcpServerNegotiationIdentityKey`：stdio 按
    command+args+env 摘要、http/sse 按 url 摘要）；值 = `{ observedAt,
    configFingerprint, tools }`，指纹为**展开后配置**的稳定 JSON SHA-256 前 32 位。
  - **schema 变更以新握手为准**：每次 `tools/list` 成功都 best-effort 覆写缓存；
    指纹不一致 = 配置变了 = 缓存不用于 Deferred（宁可启动少注册，不可拿旧配置的
    工具清单冒充新 server）。
  - fail-open 纪律与协商记忆一致：文件不可读 / 损坏 / 超大 / 过期（30 天）/ 版本
    不符 → 当作没有缓存；写入失败只记日志，绝不阻断连接。
  - 缓存条目落盘前已过名称长度剔除（openServerConnection 的注册边界过滤），但
    Deferred 物化时**重新**走同一条物化管线（normalize → 长度剔除 → 碰撞去重），
    不信任缓存内容绕过任何注册边界检查。
- 显式单 server `connectServer` 不经过快启门（用户点了刷新就该等结果）。

### R2 崩溃风暴熔断（crash-storm breaker）

- **计数点 = 一次「毫无产出」的意外断开**（`client.onclose` 意外断连路径，且该
  连接自建立以来**从未完整成功过一次工具调用**）。断连之间夹着完整成功调用的
  server 是 R1 认定的**半可用形态**（「成功/崩溃交替永不挂起，继续服务」）——一次
  完整成功调用在成功点**清空**该 server 的风暴窗口，其后的断连不计入。这是熔断
  与 R1 半可用契约不打架的关键判据：风暴的证据是「连上就死、毫无产出」的 fork
  循环，不是一切断连。滑动窗口：**30s 内 > 5 次**（窗口条目先剪枝再入列，第 6 次
  入列即触发）→ **熔断**（broken）：停止该 server 的一切自动恢复（懒重连 + 探测
  阶梯），状态置 disconnected + 附加 `reconnectSuspension`（wire fail-safe，见
  「共享桶申请」）、派发 `reconnect-suspended` 事件、warn 日志（事件名
  `mcp.server.crash_storm.suspended`）。陈旧工具保留在注册面（调用报错并给指引）。
- **显式恢复途径**：`connectServer` / `disconnectServer`（设置页重连、session
  启动收敛）复位该 server 的熔断窗口；新 session（新 adapter 实例）天然从零开始。
  自动路径永不自我复位。
- **与 R1 重连预算的边界（不许互相打架）**：

  | 机制 | 管什么 | 计数什么 | 复位什么 |
  |---|---|---|---|
  | 重连预算（R1，`McpReconnectBudget`） | **退避节奏 + 调用路径挂起**：懒重连间隔 ≥ 30s、连续失败/中途崩溃达 3 次挂起调用路径的自动重连 | 连接尝试失败（任意时间尺度）+ 调用中途崩溃 | 连接成功 / 显式操作 / 一次完整成功调用（分维度） |
  | 风暴熔断（本 spec R2） | **风暴停机**：突发高频「毫无产出」断连（30s > 5 次）后一切自动活动停止 | 无成功调用的连接的意外断开事件（时间窗） | 仅显式操作 / 一次完整成功调用（清窗） |

  判定顺序：懒重连与探测先查风暴（broken 即拒），再查 R1 预算。预算与熔断**各自
  持有自己的状态**，不共享计数器；熔断不喂预算、预算不喂熔断。覆盖面互补：预算
  抓「连不上/调用即崩」（其计数器会被连接成功复位），熔断抓「连接成功但进程活
  不过窗口」的 fork 风暴（连接成功恰好是预算计数器的盲区）。

### R3 静默探测阶梯（quiet probe ladder）

- 适用面：**曾连接成功的 http/sse server**（`sawConnected` 标记）。stdio 不适用
  （进程死了等不来，定时重拉正是 fork 风暴；按需拉起走懒重连）。
- server 从 ready 跌落（onclose / ping 判死 / 重连失败）且未被显式断开时，武装
  静默探测：首次 **15s**，此后每次 ×2 封顶 **5min**（15→30→60→120→240→300s）；
  每次探测 = 一次完整连接
  尝试（含鉴权解析，走 `connectServerInternal(auto)`）。探测成功 → 阶梯拆除、
  R1 预算 recordSuccess；探测失败 → 既有 failConnection 记账 + 阶梯按已倍增的
  延迟重新武装。
- 节奏就是纪律：探测间隔（≥15s）远大于 R1 冷却间隔（30s）量级，探测**不经过**
  R1 的 check/cooldown 门（二者不重复计费）；但探测**必须**经过风暴熔断门
  （broken 即停，恢复交显式操作）。探测失败如实喂 `recordFailure`（server 的客观
  事实），因此调用路径可能在探测续命期间处于 R1 挂起态——这不是打架：挂起拦的是
  模型侧循环重试，探测是后台静默自愈，两者恢复语义独立收敛于同一次连接成功。
- 拆除点：连接成功 / 显式 `disconnectServer` / adapter `close()` / 熔断触发 /
  配置变更下发的同代际收敛。已武装的窗口内若出现 in-flight 连接，本次探测让位
  （不并发重连），由那次连接的成败结果重新武装或拆除（单一执行者，无并发探测）。

### R4 配置硬化（同文件域内）

- **`${VAR:-default}` 递归展开**（`expand-env.ts`）：`connectServerInternal` 入口
  对 server 配置做一次深展开（字符串叶子逐个替换，对象/数组递归；键名不动）。
  语义对齐 POSIX `:-`：`${VAR}` 取值（未设置则**保持字面**）；`${VAR:-default}`
  在未设置**或为空**时取 default。查找顺序 = 注入 env → 进程 env；只认
  own property（防 `__proto__` 等原型成员混入）。展开幂等（无占位符即恒等），
  连接去重的 `isDeepStrictEqual` 比较双方都用展开后配置，不会因比较基准不同而
  误判配置变更。变量名支持 `[^}:]+`；不支持嵌套 `${A${B}}`（单趟替换，超界字段
  如实保留字面）。
- **工具名碰撞确定性赢家**（`descriptor.ts`）：同一批注册的 descriptor 里两个
  **不同来源**（serverName\0toolName 原始身份）mint 出同一模型面名时，赢家 =
  原始身份键**字典序较小**者（与数组顺序、重连先后无关），败者剔除并产出碰撞
  事实（调用方 warn 日志点名两个来源）。同源重复（同一 server/tool 出现两次）
  静默去重。长度上限剔除照旧先行。

## 状态机与事件顺序

每 server 一台状态机，**唯一所有者 = NodeMcpAdapter**（`records` 持有连接与工具
投影；`McpReconnectBudget` 持有 R1 计数；`McpCrashStormBreaker` 持有风暴窗口；
`McpProbeLadder` 持有探测定时；`McpToolCache` 持有磁盘缓存）。上层只读
`status()/listTools()` 与 `onStatusChange` 事件，不持有第二份状态。

```text
                      显式 connectServer（复位预算+熔断）
                                      │
   ┌──────────────────────────────────▼──────────────────────────────────┐
   │ connecting ──250ms 门内 settle──► ready ──意外 onclose──► crashed   │
   │     │                            ▲  │                   │          │
   │     │ 门到期+缓存命中             │  │探测/懒重连成功     │30s>5断连  │
   │     ▼                            │  ▼                   ▼          │
   │  deferred(connecting 保持,       │ recovering ──────失败──► crashed│
   │    tools=缓存 descriptor) ───────┘ (探测阶梯 15s→5min)   │          │
   │     │ 后台完成=records.set 原子替换                            │      │
   │     │ 连接失败→failed→crashed                                  ▼      │
   │     └──────────────────────────────────────────────────►  broken   │
   │                                                    (熔断:自动全停,  │
   │                                                     显式操作复位)   │
   └─────────────────────────────────────────────────────────────────────┘
   并行维度（不在这台状态机上）：R1 预算挂起（suspended，拦调用路径懒重连）
   与 disabled（配置 enabled:false）。
```

事件顺序（启动门，全部幂等）：

1. `connectConfiguredServers`：清退失配 server → 逐 server 发起连接（代际 +1，
   record.connecting 挂共享任务）→ `race(全部 settle, 门 250ms)`。
2. 门到期：对仍 pending 的 server 读缓存（指纹一致才用）→ `record.tools = 缓存
   descriptor`（同一 record 对象原位赋值，状态不变、**不发事件**——状态没有跃迁）。
3. 后台完成：成功 → `records.set`（真实工具）+ `connected` 事件；失败 → 既有
   failConnection（failed 状态 + `connect-failed` 事件，缓存工具随 record 一并
   消失——失败 server 不留幽灵工具）。
4. `records.set` 是唯一替换点；代际守卫丢弃迟到旧代际（幂等）。

事件顺序（风暴熔断）：onclose（意外断开）→ 窗口计数 → 未超限：仅断连事件；
超限：状态置 disconnected + `reconnectSuspension` 附加 → warn 日志 →
`reconnect-suspended` 事件 → 阶梯拆除。此后懒重连/探测在门禁处被拒，直到显式
操作 `connectServer` 复位窗口。

## 验收场景

1. 门内就绪：快 server 在 250ms 内 settle → 快照含真实工具，无 Deferred。
2. 超预算 Deferred：慢 server（握手被夹住）+ 有缓存 → 门到期后 `listTools()`
   立即可见缓存工具、status 仍 connecting；放行握手后后台原子替换为真实工具并派
   发 `connected` 事件。
3. 超预算无缓存：慢 server 无缓存 → 启动快照无其工具；后台完成后注册。
4. 缓存 schema 更新：tools/list 成功即覆写缓存；再次 Deferred 读到**新**清单；
   配置（或展开后 env）变化 → 指纹不符 → 不用缓存。
5. 熔断：30s 内 6 次意外断开 → broken；后续 callTool 拒绝懒重连（不再 spawn），
   文案带「不要循环重试 + 显式重连恢复」指引；显式 connectServer 复位并复活。
6. 探测阶梯：ready → 断开 → 武装；延迟序列 15s→30s→60s→120s→300s（封顶）；
   探测成功拆除；显式断开/熔断拆除；stdio 永不武装。
7. 硬化：`${VAR}`/`${VAR:-default}`（设置/未设置/空值/递归嵌套对象）；碰撞赢家
   与数组顺序无关。
8. 既有面不回归：oauth / reconnect-budget / pool / negotiation 测试原样通过。

## 范围外（报告另行建议）

- 后台完成后的**工具注册面 rebind**（core initializeMcp 只在启动快照时注册一次；
  late tools 的 rebind 需动 core/共享面——见共享桶申请）。
- `suspendedBy: "crash_storm"` 的契约字面扩展（见共享桶申请）。
- SSE Last-Event-ID 续传、`!cmd` 密钥命令展开：不同机制面，另行立项。
