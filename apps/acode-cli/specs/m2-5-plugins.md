# M2-5：plugins 域 legacy 方法迁 v4

> 创建日期：2026-10-28
> 上游调研：`docs/reviews/2026-10-28/m2-scoping.md` §5 Batch M2-5
> 收敛计划：`docs/legacy-protocol-convergence-plan.md` M2 节
> 迁移样板：M2-1（commit 5da76197）+ usageStats/headerMeta 的 v4 独立 query 先例 + M2-6 同季分区习惯

## 1. 范围与行为

plugins 域 18 个 legacy 方法名中 **16 个迁 v4**（`v4/` 前缀，载体复用同一 JSON-RPC 传输），2 个保留 legacy：

| legacy 词 | v4 词 | 形态 | 语义 |
|---|---|---|---|
| `plugins/list` | `v4/plugins/list` | query | 本地 plugin metadata 清单 + diagnostics（含 missing 配置行投影） |
| `plugins/overview` | `v4/plugins/overview` | query | 市场/可用/已安装/可恢复内置四段 + capability |
| `plugins/describe` | `v4/plugins/describe` | query（有 IO） | 单插件组件「名称+描述」枚举；未安装候选临时 clone 后清理 |
| `plugins/validate` | `v4/plugins/validate` | query（有 IO） | 候选/已安装校验 + compatibility 三桶 |
| `plugins/referenceCatalog` + `plugins/referenceCatalogWithCategory` | `v4/plugins/referenceCatalog` | query | Picker 只读 catalog（session/workspace 双 authority）；**v4 单方法恒带 category**（WithCategory 语义为超集，zod 形状两词本就同一 schema） |
| `plugins/resolveSuggestedReference` | `v4/plugins/resolveSuggestedReference` | query（有副作用：官方目录刷新） | 推荐 Prompt 安装前可信解析；missing 先刷新官方目录 |
| `plugins/setEnabled` | `v4/plugins/setEnabled` | command（写） | 启停写配置；可取消（abort 只阻断响应/UI 写入，配置不可回滚） |
| `plugins/marketplace/add` | `v4/plugins/marketplace/add` | command（写） | 加市场源；storage 锁串行化；可取消 |
| `plugins/marketplace/remove` | `v4/plugins/marketplace/remove` | command（写） | 删市场源；storage 锁 |
| `plugins/marketplace/update` | `v4/plugins/marketplace/update` | command（写） | 刷新市场目录；storage 锁；可取消 |
| `plugins/install` | `v4/plugins/install` | command（写） | 安装市场插件；storage 锁；可取消 |
| `plugins/uninstall` | `v4/plugins/uninstall` | command（写） | 卸载（pluginId 或 pluginName+marketplace 定向） |
| `plugins/update` | `v4/plugins/update` | command（写） | 按记录重装循环；串行化进同一 storage 锁 |
| `plugins/restoreBuiltin` | `v4/plugins/restoreBuiltin` | command（写） | 清 suppressedBuiltins 标记并重新 seed |
| `plugins/configure` | `v4/plugins/configure` | command（写） | 写插件 options / clearOptionKeys |
| `plugins/resetConfig` | `v4/plugins/resetConfig` | command（写） | 重置插件 options |
| `plugins/cancelOperation` | **保留 legacy** | 控制面 | 见 §4 skew/保留裁决 |

「command（写）」形态 = v4 名字空间的普通请求-响应 RPC（workspace 级、无会话、无 CAS），**不是** conversation `v4/command` 信封（那是 sessionId 键控的会话 CAS 命令面，plugins 操作不投影进会话）。dispatch 先例 = usageStats：server.ts 一行转发直调实体，不经 v4Gateway。

载荷形状与 legacy **逐字 parity**（同字段、同 strict、同值域）——消费者（设置页 / Picker / 推荐 Prompt 链）语义零变化。v4 侧在 `acode-protocol-v4/plugins.ts` 结构化再声明（不反向 import legacy barrel，守 protocol-boundary 纪律），两侧形状由 `packages/shared/tests/protocol-boundary.test.mjs` 新增用例钉住。

## 2. 所有权

- **协议面**：`packages/shared/src/acode-protocol-v4/plugins.ts`（域零件）+ `plugins-queries.ts`（读六法）+ `plugins-commands.ts`（写十法）——三叶拆分是 max-file-lines 400 门禁分流（单文件实测 538 行超限）；方法名常量在 `transport.ts` 的 `V4_METHODS`（16 个新条目）。`acodeDeliveryKindSchema` 不在 v4-imports-legacy-protocol 白名单（只登记了 acodeWorkspaceRefSchema），按「结构化再声明」纪律在 plugins-queries.ts 本地逐字再声明，值域 parity 由协议测试钉住。
- **CLI 实现**：
  - 新建 `acode-protocol-v4/plugins-management.ts`（共享投影/helper + 读四法 list/overview/validate/describe）与 `acode-protocol-v4/plugins-mutations.ts`（写十法）——同样因 400 行门禁拆分（合文件实测 604 行）；逻辑自 legacy `acode-protocol/plugins.ts` 逐字迁，params 改 parse v4 schema；legacy `plugins.ts` 删除（其全部 dispatch case 消费归零）。
  - referenceCatalog 与 resolveSuggestedReference 实体**留在** legacy `acode-protocol/plugin-reference-catalog.ts`：catalog 的两个 legacy case 因 services 侧 fallback 链仍存活（消费未归零），文件不删；v4 case 按 usageStats 先例一行转发到既有实体（`getPluginReferenceCatalog(..., true)` / `resolveSuggestedPluginReference`）。不向待删目录新增实体——这两个是既有实体，不是新债。
- **dispatch**：`acode-protocol/server.ts` 加 16 个 v4 case（一行转发；setEnabled/resolveSuggested/marketplaceAdd/marketplaceUpdate/install 五个可取消操作经既有 `withPluginOperationSignal` 包装）；删 15 个 legacy case（14 管理面 + resolveSuggestedReference）；保留 3 个 legacy case（referenceCatalog×2 + cancelOperation）。
- **services**：`acodeAgentService.ts` 16 行 facade 改调 `V4_METHODS.*` + v4 result schema（含 pluginsList 超时判定改 v4 方法名）；`pluginReferenceCatalogRequest.ts` 改为 v4 primary + legacy 两级 fallback。

## 3. 不变量

1. **storage 锁串行化**：marketplace add/remove/update、install、update、validate、describe 经 `withPluginStorageLock` 串行化同一 storageRoot 的读-改-写（迁移逐字保留）。
2. **catalog authority fail closed**：带 `sessionId` 必须命中 resident Session，禁止静默回退 workspace authority（草稿/会话权威不混淆）。
3. **resolveSuggested 信任链**：stableId 必须匹配官方市场 `acode-plugins-official` 且形态合法，否则 `unavailable`；missing 必先刷新官方目录（10s 超时中止底层网络），失败禁止旧快照安装；actionable 结果（ready/disabled/missing）必须带 marketplace+pluginName+sourceTrust="official"（superRefine 钉住）。
4. **sensitive 配置不出协议**：`toPluginInfo` 的 configuredOptions 过滤 `sensitive: true` 键（迁移逐字保留）。
5. **v4 不反向 import legacy barrel**：`acode-protocol-v4/plugins.ts` 只从 `acode-protocol-legacy-types.js`（workspace ref / deliveryKind）取中性零件，其余逐字再声明。
6. **取消语义**：五个可取消操作（setEnabled/resolveSuggested/marketplaceAdd/marketplaceUpdate/install）经 `withPluginOperationSignal` 注册 AbortController（operationId 键控，协议代际无关）；取消入口见 §4。
7. **失败语义**：参数非法走 `-32602`（parseParams 既有行为）；resolveSuggested 的领域失败走 result 内 status/diagnostics 判别，不抛协议错误；marketplace 诊断聚合进 result.diagnostics 不静默吞。
8. **`plugins/operationProgress` 通知不改名**：resolveSuggested 的 refreshing 通知是 CLI→host 单向通知，不在本批 16 个请求方法清单内，保持 legacy 词（services 的 progress emitter 消费不变）。

## 4. 失败语义与版本偏斜

**保留 3 行 services legacy 消费（裁决：保守无能力损失默认）**：

1. **`pluginReferenceCatalogRequest.ts` 两级 fallback（2 行）**：v4 `v4/plugins/referenceCatalog` primary → `-32601` 回落 legacy `plugins/referenceCatalogWithCategory` → 再 `-32601` 回落 legacy `plugins/referenceCatalog`。该文件的存在理由就是这条 fallback 链（new host / old CLI skew 方向，既有行为）；迁 v4 时**在链顶加 v4 层**而不是拆掉旧链——拆掉会让 pre-v4 CLI 的 Picker 从「降级无 category」退化为「整体不可用」，违反保守默认。
2. **`plugins/cancelOperation`（1 行）**：中止注册表 `pluginOperationControllers` 按 operationId 键控，与协议代际无关——legacy cancel 可以中止 v4 启动的操作，反之亦然。它是唯一无 workspace 参数的进程内控制面原语（同步查表、无 schema 漂移面），保留 legacy 词可让任何代际启动的在途操作都可取消；v4 plugins 域因此不含 cancel（域内 16 方法 = 6 读 + 10 写）。

**其余 16 方法无 skew fallback**：对照 M2-1 删除 sessionSetModel/sessionSetMode、M2-6 退役 mcpList 兼容重试链的同批裁决——host 与 CLI 同版本发布，v4 方法名即版本边界；mutation 在版本错配时硬失败（用户升级）优于静默双写。

**超时-回收-重试保留**：`plugins/list` 的 timeout → stale client 回收 → 重试一次与方法名无关，迁 v4 后保留；`isProtocolRequestTimeout` 判定改用 v4 方法名（error.method 随请求名）。

## 5. 迁移边界

**做**：16 方法 v4 schema + CLI 实体迁移/转发 + dispatch 换名 + services 16 行切换 + 协议单测。

**不做**：
- 不删 legacy schema 与 `acodeProtocolMethods` 词表条目（M2-1/M2-6 同款纪律，M4 统一删 barrel）。
- 不动 `plugins/operationProgress` 通知词。
- 不动 UI（经 services facade 消费，载荷同形，无感）。
- 不动 core/adapters 的插件解析、市场、安装事务实现。
- `apps/acode-cli/tests/**` 无协议面引用（实测仅 `plugin-install-transactions.test.mjs` 引 adapters 内部件，不涉及方法名），不配套修改。

## 6. 冒烟与验收

本批 16 方法**不在** 13 个 stream/snapshot/queue 高危名单（subscribe/send/stop/cancelBackgroundTask/fork/compact/create/resume/read/messages/events/goal/close）。按纪律执行：单链路功能测试 + 单测。

验收场景：
1. 设置页插件清单/总览/详情/校验（list/overview/describe/validate）：协议单测钉 schema parity；CLI 实体逐字迁移，行为不变。
2. Picker catalog：session/workspace 双 authority 与 fail-closed 不变；v4 单方法恒带 category；`-32601` fallback 链在 pre-v4 CLI 上逐层降级。
3. 推荐 Prompt 解析（resolveSuggested）：信任链四态（ready/disabled/missing/conflict/unavailable）与官方目录刷新超时不变。
4. 市场与安装写路径（marketplace×3/install/uninstall/update/restoreBuiltin/configure/resetConfig/setEnabled）：storage 锁与可取消语义不变。
5. `git grep "acodeProtocolMethods\." -- packages/services/src | wc -l`：72 → **56**（−16；残留 3 行 = §4 裁决的 catalog fallback×2 + cancelOperation×1）。
6. legacy dispatch 15 case 删除、3 case 保留；legacy `plugins.ts` 文件删除。
7. 新协议单测全绿；shared/services/bootstrap 受影响套件全绿；typecheck 零错误（兄弟批次在途改动经 `git status` 区分归属后如实标注）。

## 7. 批次记录（2026-10-28 落地）

- `acodeProtocolMethods.` 消费实测（`git grep "acodeProtocolMethods\." HEAD -- packages/services/src` vs 工作树 grep）：
  - HEAD 基线 **72**（plugins 域 19 行：acodeAgentService 17 + pluginReferenceCatalogRequest 2）。
  - 本批后工作树 plugins 域残留 **3 行**（cancelOperation×1 + catalog fallback×2），**−16**；
    单批口径 72 → **56** 达成。合并工作树实测 47——兄弟 M2-6 批次 −9（8 方法，mcpList 含
    超时常量行）同窗口落地，各自批次归属以 plugins/workflows/skills/mcp 词分别 grep 可证。
  - 残留 3 行证据：`acodeAgentService.ts` pluginsCancelOperation 1 行 +
    `pluginReferenceCatalogRequest.ts` referenceCatalogWithCategory/referenceCatalog 2 行（§4 裁决）。
- legacy 删除清单：`acode-protocol/plugins.ts` 文件删除（14 handler 迁 v4 目录）；
  `server.ts` 15 个 legacy case 删除（list/resolveSuggested/setEnabled/overview/marketplace×3/
  install/uninstall/update/restoreBuiltin/configure/resetConfig/validate/describe）；
  3 个保留（referenceCatalog×2 fallback 服务 + cancelOperation）。
- v4 新增：`V4_METHODS` 16 条目；shared 三叶（plugins/plugins-queries/plugins-commands）；
  CLI 两 handler 文件（plugins-management/plugins-mutations）+ catalog/resolveSuggested
  一行转发（usageStats 先例）。
- 协议单测：protocol-boundary.test.mjs 新增 6 用例（方法名面+排除 cancelOperation、
  params parity×16、result parity×11、catalog category 合并语义、resolveSuggested
  superRefine、三叶无反向 import + 白名单纪律 + deliveryKind 值域钉住）。
- 门禁实测：shared 449/449；services 578/578（skip 7 与基线一致）；typecheck 全仓 exit 0；
  architecture:check --changed new 0 / regrown 0；lint 见交付报告（兄弟批次在途归属标注）。
- CLI 套件：apps/acode-cli 全套 25 套件 3170 测试——3131 pass / 38 skip / **1 fail**；
  唯一红 = third-party-reproducibility L01 干净树台账审计，漂移指名
  `packages/ui/src/components/ai-elements/message.tsx`（兄弟批次 GodComponentsBatch5 在途
  改动，已IRC 移交其按 2ddaf691 先例回补台账）。本批文件集零红（协议/架构/插件套件全绿）。
