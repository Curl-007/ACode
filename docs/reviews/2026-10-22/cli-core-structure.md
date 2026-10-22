# ACode 1.0.3 深度 Review · CLI Core 内部结构与状态所有权

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查（grep + package.json exports + spec 核对），未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。CLI 运行时执行链路（CommandInbox/两套 workflow）另见 [cli-runtime.md](cli-runtime.md)。

范围：`apps/acode-cli/packages/core`（约 161,009 行）、`bootstrap`（约 58,603 行）、`adapters`（约 70,098 行）、`contracts`（约 26,183 行）的内部结构、状态所有权、分层边界、module-global 状态。

---

## 1. 层面整体评估

CLI core 的**依赖方向干净**：core 只依赖 contracts/shared/dynamic-workflow/shared-types/acode-cua，**零** adapters/bootstrap/cli-workflow 引用，无跨包 deep import（`core/src` 内 `@acode/*/src` 与相对越包均为 0）。W1-R3 拆包**已落地且无回潮**：`bootstrap/src/app/` 里 `dynamic-workflow-run-*`/`workflow-driver` 文件数为 **0**，引擎消费全经包名入口。状态所有权治理是**真实的类型级进步但未完成**：7 簇分接口 + 9 个关键字段收敛到 WeakMap owner（只读 getter + 有限写端口），生命周期簇扁平可写字段已清零。**最大风险有二**：(a) 原型注入机制未变——109 个 methods 文件经 `installAgentRuntimeMethods` 把约 180 个函数挂到 `AgentRuntime.prototype`，方法体一律 `this: AgentRuntimeInternal`，可读写**全部约 50 个尚未收敛的扁平可变字段**，owner 只读约束被 `this` 面绕过；(b) bootstrap「杂物间」只切走了 workflow 一块，`src/app/` 仍有 **57 文件 / 13590 行** 非装配的 application service。巨型文件问题恶化：`product-projection.ts` 5432→**6075 行**，`subagent/runner.ts` **2599 行**，core 内 **65 个文件 >400 行闸**、44 个带 `max-lines` 豁免。

## 2. 问题清单

**[P1] 原型注入 + `this: AgentRuntimeInternal` 使 owner 只读约束可被绕过** — `runtime/methods/index.ts:203-398`、`runtime/agent-runtime.ts:787`
- 描述：约 180 个方法通过 `proto.X = X`（`proto` 为 `Record<string, unknown>`）动态挂载；类型靠 `agent-runtime.ts:428` 的 declaration merging（`export interface AgentRuntime`）补。每个 method 文件签名是 `this: AgentRuntimeInternal`，而 `AgentRuntimeInternal`（`internal.ts:240-251`）组合了全部 7 簇，含 `RuntimeTurnState`/`RuntimeContextMemoryState` 等**未收敛的扁平可写字段**。
- 证据：`internal.ts:195-208` `RuntimeTurnState` 的 `turnNumber`/`activeTurn`/`pendingInputSequence`/`queueAutoDrain` 等仍是裸字段；只有 `branchGeneration`/`activeTurnStartReservation`/`runtimeCommandDrainActive` 等经 `declare private readonly`（`agent-runtime.ts:221,252,257,269,270`）。spec 自述「分簇仍保留扁平读面」（`internal.ts:75`）。
- 建议：把 `RuntimeTurnState` 的高频时序字段（`turnNumber`/`activeTurn`/`pendingInput*`/`queue*Drain*`）逐个迁到已有 `turn-coordination.ts` owner 模式，method 只经 port 读写；原型注入长期应换为显式组合（构造期把方法绑到实例或委托对象），使 `this` 面不再等于全字段并集。
- 验收：非 owner writer 在 `tsc` 下不能赋值目标字段（复用现有 readonly 负例套路）；`installAgentRuntimeMethods` 注入的方法数与 `AgentRuntime` 接口成员一一对应，无 `proto` 上未在接口声明的方法。

**[P2] bootstrap `src/app/` 仍是完整 application service 层，非「只做装配接缝」** — `bootstrap/src/app/`（57 文件 / 13590 行）
- 描述：W1-R3 只迁走 workflow 引擎族。剩余大量非装配服务：`official-plugin-*`（11 文件：runtime/cache-fs/seed-guard/seed-lock/definitions/cleanup…）、`workspace-hook-review-*`（8 文件：controller/mutation/pins/request/revoke/supervisor/telemetry/types）、`swarm-plan-runtime.ts`、`overnight-controller.ts`、`provider-registry-*`、`standalone-account-provider-runtime.ts`。`create-app.ts` 本身 1654 行。
- 证据：spec `bootstrap-app-boundary.md:14` 承认「约 24.9k 行完整 application service 层是 bootstrap 名不副实的主因」；W2 里程碑（改名/并入 cli）**依赖 legacy 协议 M3 删除**，尚未执行。
- 建议：按 bounded context 继续抽出 `official-plugin`、`workspace-hook-review`、`provider-registry` 为独立包（照 cli-workflow 先例：唯一 contract.ts 公开面 + 守护测试禁 deep import）。
- 验收：`src/app/` 行数显著下降且只剩 facade/wiring 装配；每抽出包独立 typecheck/lint/test 绿；守护测试扩展到新包。

**[P2] `product-projection.ts` 6075 行、`subagent/runner.ts` 2599 行职责过载** — `bootstrap/src/acode-protocol-v4/product-projection.ts`、`core/src/subagent/runner.ts`
- 描述：单文件承载 v4 全量投影 / 子代理前台后台生命周期 + registry + notification 顺序，远超 400 行闸，靠头注 `max-lines` 豁免（`runner.ts:1`、`agent-runtime.ts:1`）。
- 证据：runner.ts 头注「拆分前需要先稳定生命周期边界」；product-projection 仍在活跃改动（近期 5 提交含 DeferredToolCall/inFlight/promptCacheMisses）。
- 建议：runner 先按「前台生命周期 / 后台生命周期 / registry / notification」拆内聚模块；projection 按事件域拆。
- 验收：拆分后各文件 <400 行且移除豁免注释，回归绿。

**[P3] 进程级默认 audit sink 仍是 module-global `let`（session 层已收敛）** — `permission/bash-confirm-reflex-gate.ts:441`、`permission/auto-risk-classifier.ts:324`、`mcp/call-audit.ts:55`
- 描述：CLI-04 的「按 session 注册/释放」已落地（`sessionAuditSinks`/`sessionAutoClassifierAuditSinks` Map + 幂等释放函数，`bash-confirm-reflex-gate.ts:453-461`），但**进程级 fallback sink 仍是可变 `let`**，且 `process-policy-floor.ts:16` 是纯 module-global 单例。
- 证据：`emitAudit`（`bash-confirm-reflex-gate.ts:463-472`）在无 sessionId 时落到全局 `auditSink`；`process-policy-floor.ts:11` 自述「一个进程一个 createACodeApp 一份配置」——多 app 实例同进程会互相覆盖。
- 建议：保留 session Map 为主路径；把进程级默认 sink/policy floor 收进 app 上下文对象，消除「一进程一 app」隐含前提，或显式在 spec 登记该单例前提为不变量并加断言。
- 验收：同进程构造两个 app 时 audit sink/policy floor 互不串扰的测试。

## 3. 历史结构债核对

| 债务 | 当前状态 | 证据 |
|---|---|---|
| `AgentRuntimeInternal` 扁平可变状态 | **部分收敛，主体仍在** | 7 簇分接口 + 9 字段 owner/有限写端口（`runtime-state-ownership.md:109-119`）；生命周期簇扁平可写字段清零；但 TurnState/ContextMemory/MessageProjection/CacheDiagnostics 约 50 字段仍扁平，109 methods 共享 `this`（`internal.ts:195-238`） |
| 原型注入 methods | **仍在，未改** | `installAgentRuntimeMethods`（`methods/index.ts:203`）+ declaration merging；spec 明列其为债务背景（`internal.ts:72`） |
| bootstrap application service | **workflow 块已迁出，其余仍在** | app 目录 0 个 workflow 引擎文件；但 57 文件 13590 行非装配服务仍在（见 P2） |
| module-global audit/policy | **部分收敛** | audit 已加 session 级注册/释放（CLI-04）；进程级默认 sink + policy floor 仍 module-global `let`（见 P3） |
| W1-R3 拆包 | **已完成，无回潮** | 引擎迁 `@acode/cli-workflow`（公开面 index+contract.ts）；无 deep import |

## 4. 巨型文件 Top 12（core/bootstrap/adapters）

| # | 文件 | 行数 | 职责评估 | 该拆? |
|---|---|---|---|---|
| 1 | `bootstrap/…/v4/product-projection.ts` | 6075 | v4 全量投影 | 是（P2） |
| 2 | `bootstrap/…/acode-protocol/server-operations.ts` | 4051 | legacy 协议操作 | 随 M3 退役 |
| 3 | `bootstrap/…/v4/v4-gateway.ts` | 3486 | v4 网关 | 是 |
| 4 | `adapters/src/plugins/marketplace.ts` | 3006 | 插件市场 | 是 |
| 5 | `adapters/src/mcp/index.ts` | 2883 | MCP 适配 | 是 |
| 6 | `core/src/subagent/runner.ts` | 2599 | 子代理生命周期 | 是（P2） |
| 7 | `adapters/src/fs/index.ts` | 2126 | 文件系统适配 | 是 |
| 8 | `bootstrap/…/v4/transcript-hydration.ts` | 1975 | 转录水合 | 评估 |
| 9 | `bootstrap/…/acode-protocol/v4-bridge.ts` | 1878 | legacy↔v4 桥 | 随 M3 |
| 10 | `adapters/src/model/runner-stream.ts` | 1656 | 模型流 | 是 |
| 11 | `bootstrap/src/app/create-app.ts` | 1654 | app 装配 | 是（装配点应更薄） |
| 12 | `core/…/runtime/methods/session-fork.ts` | 1497 | 会话分叉 | 是 |

注：历史点名的 `browserGuestManager.ts`（4663 行）在当前树**已不存在**（find 无结果，疑似已删/改名/拆出）。core 内 >400 行文件共 **65 个**，44 个带 `max-lines` 豁免注释。

## 5. 依赖方向与边界

**守住**。core→ports(contracts)→adapters 单向：
- `core/src` 引用 `@acode/adapters`/`@acode/bootstrap`/`@acode/cli-workflow` = **0**（`core/package.json` deps 仅 contracts/shared/shared-types/dynamic-workflow/acode-cua + 第三方）。
- 跨包 deep import（`@acode/*/src`、`../bootstrap/src`、`cli-workflow/dist`）= **0**。
- `cli-workflow` 公开面 = `index.ts` + `contract.ts`（package.json exports 仅 `.` 与 `./contract`），符合 W1-R3「唯一公开面」目标。
- 无循环依赖迹象；`bootstrap-app-boundary.md:17` 记录的跨包引用全经包名公共导出。

## 6. module-global 可变状态清单（core，顶层可变单例）

| 文件:行 | 用途 | 风险 |
|---|---|---|
| `permission/process-policy-floor.ts:16` | 托管策略地板进程单例 | 多 app 同进程互相覆盖；影响所有权限决策含 yolo 管控 |
| `permission/bash-confirm-reflex-gate.ts:441-442` | 反射门 audit sink（进程默认 + session Map） | 进程默认 sink 全局；session 层已收敛 |
| `permission/auto-risk-classifier.ts:324-325,129` | 分类器 audit sink + `activeProvenanceDigest` | 同上；digest 全局可变 |
| `mcp/call-audit.ts:55` | MCP 调用 audit sink | 进程级默认 |
| `fleet/governor.ts:44-46` | governor 单例 + evictionPort + configuredDeps | 进程级会话治理单例 |
| `fleet/registry.ts:234` | fleet registry 单例 | 同上 |
| `ambient/runner.ts:475` | `activeAmbientRunner` | 单进程单 runner |
| `ambient/usage-ledger.ts:304` | `sharedLedger` | 用量账本全局共享 |
| `ambient/session-kind.ts:14` | `ambientSessionIds` Set | 会话身份全局集 |
| `lsp/client-registry.ts:10,20,23,26` | LSP clients/locks/invalidated/barriers | 进程级 LSP 客户端注册表 |
| `lsp/client-idle.ts:53`、`client-io.ts:31`、`client.ts:84` | idle interval / wedgedTeardown / spawnOverride | 定时器与传输覆盖全局 |
| `lsp/ts-diagnostics.ts:49`、`deferred-diagnostics.ts:134`、`client-files.ts:41,61` | programCache / owners / pendingDiskWrites / fileOperationLocks | 诊断缓存与文件锁全局 |
| `context/stable-prefix.ts:129` | `cacheRegistry` | 前缀缓存全局注册 |
| `agent/skill-path-activation.ts:17`、`skill-user-invocation.ts:16` | 会话键控技能激活 Map | 按 session 键控，`beginShutdown` 已清（`agent-runtime.ts:400-402`）；风险低 |

说明：core 顶层 `let` 共 35 处，上表为**可变单例**（已剔除 `const` 只读集合）。skill/conflict 类会话键控 Map 已在 `beginShutdown`（`agent-runtime.ts:398-404`）按 sessionId 清理，所有权清晰；真正无会话隔离的是 policy floor、fleet、ambient、lsp、audit 默认 sink 五类进程级单例，均以「一进程一 app」为隐含前提，未在类型上强制。

超时核查：`streaming-tool-coordinator.ts:364`（取消 drain race）、`turn-model-step.ts:362`/`target-completion-verification.ts:328`（admission 退避重试）、`auto-resume/coordinator.ts:36`（可注入定时器面 + unref）均为正当用途，**未见用 setTimeout 掩盖本应事件驱动的同步**。

## 7. 修复入口建议

运行 `pnpm architecture:context acode-cli` 交叉验证本报告的依赖方向与巨型文件基线结论（2 分钟）。P1 的第一个可动切片是把 `RuntimeTurnState.turnNumber` 迁到 turn-coordination owner。
