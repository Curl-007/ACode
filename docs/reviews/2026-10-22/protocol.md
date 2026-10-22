# ACode 1.0.3 深度 Review · 协议与 RPC 层（shared / rpc / client）

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + 实跑 descriptor 门禁测试，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/shared`（约 5.1 万行，286 文件）协议 v4 / legacy / harness-api / identity 工具、`packages/rpc`（4016 行）、`packages/client`（855 行）。

---

## 1. 层面整体评估

协议/RPC 层是 ACode 当前治理最扎实的一层：v4 schema 严格（`.strict()` + `safeParse` 收口）、40 个 RPC descriptor 全部显式冻结并有「漏登记即红」的机械门禁（实跑全绿）、v4→legacy 反向依赖被架构 fixture 与真实 checker 双层禁止、identity 贯穿与 fail-closed 都达标。最大风险不在校验完整性或 identity，而在 **legacy 退役进度**：收敛计划停在 M2-B（2026-10-09），之后的两个 feat 提交反而往冻结的 legacy barrel **净增了 schema 导出**，违反「只删不增」冻结规则。M2/M3/M4 里程碑均未推进（bootstrap legacy server 48 文件仍在、services legacy 消费 6 文件未清零）。descriptor 与 capability 的历史修复（ARCH-01、M2）当前状态健康，无回归。

## 2. 问题清单

**[P2] legacy 冻结面被违规新增 schema 导出** — `packages/shared/src/acode-protocol/index.ts:659-667`
- 描述：提交 `43afaba1`（2026-10-19，冻结日 2026-10-05 之后）在 legacy barrel 新增 `acodeMcpReconnectSuspensionSchema` + 类型 `ACodeMcpReconnectSuspension`（git 实证 `+export:2 / -export:0`）。
- 证据：收敛计划第 37 行冻结规则明令「新命令、新事件、新 schema 只进 `acode-protocol-v4/`；legacy 面只允许删减与缺陷修复，不允许新增导出」。该 schema 在 v4 目录无任何对应（grep `acode-protocol-v4/` 零命中），经 `mcp.ts:7` 与 UI `McpFailurePresentation.tsx` 消费，是全新 wire 契约字段而非既有 schema 修改。
- 建议：虽是修 strict schema 拒收的缺陷，但新 schema 应落在中立模块（如 `mcp.ts` 自身或新建叶子），legacy barrel 只 re-export，与 M2-B 处理 MCP/browser schema 的既定模式一致。
- 验收：legacy barrel 不再新增 `export const ...Schema`；新字段定义迁入中立叶子；`git grep -c "^export const.*Schema" acode-protocol/index.ts` 不增长。

**[P3] legacy enum 值域在冻结面内扩张** — `packages/shared/src/acode-protocol/index.ts`（`acodeOffPeakPermissionModeSchema`）
- 描述：提交 `1272746b`（2026-10-17）把 `acodeOffPeakPermissionModeSchema` 值域从 `["build","edit","plan","yolo"]` 扩为追加 `"dontAsk"`。
- 证据：git diff `+export:1 / -export:1`；这是修改既有导出而非新增，属灰区，但仍改动了 legacy wire 契约值域。
- 建议：确认 `dontAsk` 是否为已冻结值域的必要缺陷修复；若是新语义应进 v4。
- 验收：v4 与 legacy 对该 permission mode 枚举不出现双源分叉。

**[P3] descriptor 门禁阈值恰好贴边** — `packages/services/tests/rpc-descriptor-surface.test.mjs:88`
- 描述：`assert.ok(descriptorCount >= 40)`，而实测注册恰好 40 个（39 处调用点 + `providerFacadeServices.ts` 含 2 个）。
- 证据：门禁逻辑本身健全（逐 descriptor deepEqual interface 成员 + 方法必须登记校验器），但 `>=40` 只在删除时报警；若某 service 被合并导致计数变化，阈值需手工跟随。
- 建议：低优先；可在门禁里断言精确等于当前登记数，减少「删一个又加一个」的静默漂移。
- 验收：descriptor 总数变动时门禁有明确信号。

## 3. legacy 退役进度

对照收敛计划里程碑，**当前停在 M2-B（2026-10-09），M2/M3/M4 均未推进**：

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M2（services 双栈切换） | 未完成 | 计划表：services legacy 消费 6 文件，目标 0；`acodeProtocolClient.ts` 仍在（72 行 class） |
| M3（删 bootstrap legacy server） | 未启动 | 计划表：48 文件 / 14,713 行未减 |
| M4（删 shared legacy barrel） | 未启动 | `acode-protocol/index.ts` 现 3,654 行（计划基线 3,714→目标 0） |

- **违规新增**：除上述 P2/P3，冻结日之后无其他 legacy 导出净增（8a1018ea 等为纯移动/删除）。
- **剩余量**：legacy barrel 3,654 行 + `acode-protocol-legacy-types.ts` 607 行；`acodeProtocolMethods` 表（`index.ts:3497`）仍有大量非 deprecated 命令（sessionCreate/Resume/List、workspace*、plugins*、workflows* 等），多数尚无 v4 契约（计划第 92-94 行明确承认）。
- **双源真相**：未发现同一命令在 v4 与 legacy 双重定义。`V4_METHODS` 全带 `v4/` 前缀，legacy `acodeProtocolMethods` 用 `session/*`、`workspace/*` 等旧词，前缀隔离；deprecated 项（sessionStop/sessionFork/sessionCancelBackgroundTask）已注明「wire case 留兼容，随旧词整体删除」。

## 4. v4 校验与 descriptor 覆盖

- **运行时校验完整**：v4 command 收口在 `parseCommandEnvelope`（`command.ts:369`）——先 `commandEnvelopeSchema.safeParse` 校验信封，再按 `type` 用 `commandPayloadSchemas[type].safeParse` 校验 payload，额外强制 CAS 命令带 `baseRevision`、row-targeting 命令带 `baseLogEpoch`（376-391）。schema 全用 `.strict()`。capabilities schema（`capabilities.ts`）刻意闭合 key 集、result 重复 queried key 防串答、注释要求消费方 `=== true` fail-closed。
- **40 descriptor 冻结现状**：实跑 `pnpm --filter @acode/services test` 全绿，含「descriptor 为每个公开成员登记参数校验器」「遗漏显式表按空表拒绝，不回退原型发现」「校验器表 frozen 不暴露可变 Map」等。门禁逐个 deepEqual descriptor.allowedMethods 与 interface 成员、校验器表 frozen、方法（除普通 `onXxx` 事件）必须登记校验器、校验器键不得超出方法表。
- **装配强制**：`collection.ts:40-43` 把 descriptor 的 `allowedMethods`/`argumentValidators` 注入 `ProxyChannel.fromService`；`proxy-channel.ts:206` `collectServiceMembers` 在有 allowedMethods 时只按白名单收集、屏蔽 `constructor/__proto__/prototype`、排除 Object.prototype 继承方法，call/listen 前跑校验器抛 `rpc-invalid-arguments`（104-125）。ARCH-01 的「内部原型方法暴露」缺陷已闭合。
- **漏登记风险**：低。普通事件 `onXxx` 豁免校验器是有据的——`proxy-channel.ts:74-79` listen 先命中 `eventMap` 缓冲直返，校验器路径对该分支不可达，门禁注释已如实说明。

## 5. identity 贯穿核对

**达标，无仅路径匹配违规**：

- **协议命令/事件带 identity**：`controller.ts` 的 `windowHostTaskAddressSchema`（17）、`windowHostControllerWorkspaceFactSchema`（36）均含 `workspaceIdentity` + `remoteSessionId`，并用 `superRefine` 强制「有 remoteSessionId 必须有 workspaceIdentity」（26-32、53-59）；`windowHostControllerTaskRowSchema`（90）进一步校验 address 与 meta 的 workspaceIdentity 一致（107-118）。`workspace-hook-review.ts`、`snapshot.ts:520` 同样带 identity 字段。
- **统一 key**：身份 key `workspaceIdentity?.trim() || workspacePath` 由 `task-realtime-core.ts:80` `resolveWorkspaceKey` 单点实现，被 `botsService.ts:2555`、`paths.ts:215/224` 等复用（经 `getWorkspaceKey`）。
- **工具复用，无手写格式**：`remote-workspace-identity.ts` 提供 `buildRemoteWorkspaceIdentity`（49）/`parseRemoteWorkspaceIdentity`（77），从 `index.ts:93` 公开；未发现业务代码手写 identity 拼接格式（`split(":")` 等零命中）。
- **命令信封例外（设计正确）**：`commandEnvelopeSchema`（`command.ts:352`）只带 `sessionId` 不带 workspaceIdentity——因桌面 stdio 管道已绑定到窗口 Local Host/workspace，identity 路由发生在 Host owner/lease 层而非 wire 信封，与 AGENTS.md「Main 不承载 task 业务状态、Host owner/lease 负责路由」一致。远程恢复链路的 identity 由 controller fact 承载。

## 6. 历史问题回归核对

| 历史项 | 当前状态 |
|---|---|
| **ARCH-01**（RPC descriptor 校验迁移） | **无回归，健康**。40/40 descriptor 冻结 + 参数校验器登记，机械门禁实跑全绿；装配经 collection→ProxyChannel 强制白名单，内部原型方法不可远程调用。 |
| **M2 capability**（independent Plan preflight） | **无回归，健康**。`independentPlanSupport.ts` 走严格 `v4/capabilities/query`，`supported !== true` 或缺字段即 `throw proto.independentPlanUnsupported`（24-29）；`-32601`/网络失败经 `.catch` fail-closed（31-34）；WeakMap 缓存失败即 `checks.delete(client)` 可重试（32）。**但仅覆盖 `independentPlanState` 单 capability**（最小切片），key 集闭合。 |
| **v4→legacy 反向依赖禁止** | **无回归，双层防护**。真实 checker `scripts/architecture/index.mjs:261` `isSharedV4ToLegacyProtocolImport`（39-46）对 `acode-protocol-v4/ → acode-protocol/` 导入报 `v4-imports-legacy-protocol` 违规；fixture `architecture-coverage.test.mjs:164-175` 验证拒绝旧 barrel、放行 `acode-protocol-shared`。核实 `command.ts` 实际只 import `../acode-protocol-shared.js`（33），无 legacy barrel import。 |

**注**：M2-B 抽出的 `acode-protocol-shared.ts` 中立模块运作正常（v4 与 legacy 双向都从这里取 MCP/browser schema）；但 P2 的新 MCP 熔断 schema 未走同一模式，直接进了 legacy barrel——这是本次 review 唯一确认的规则违反。

## 7. 修复入口建议

核 P2——`git show 43afaba1 -- packages/shared/src/acode-protocol/index.ts` 看新增 schema 是否可移入 `mcp.ts` 叶子或 `acode-protocol-shared.ts`（约 15 分钟含测试）。
