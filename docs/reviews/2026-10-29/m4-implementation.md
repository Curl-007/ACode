# M4a 实施记录：shared legacy 协议 barrel 整删（M4b 登记为协议扩展开放项）

> 日期：2026-10-29（Asia/Shanghai）。分支 `fix/project-review-2026-10-26`（PR #11），
> worktree `exciting-spence-bf1be9`，基线 HEAD `88b63152`（M3 完成 + CI 四检查全绿）。
> **结论：M4a 已完成。** `packages/shared/src/acode-protocol/`（barrel 3,652 行）与
> `acode-protocol-legacy-types.ts`（607 行）整删，承重面收编为 14 个有意命名的中立模块。
> spec：`apps/acode-cli/specs/m4-shared-barrel-removal.md`（裁决 A–E + 消费面盘点 + checklist 核验）。
> 本文件前身是 M4 启动前置核验报告（「未执行删除」版），实施后改写为终态记录；
> 前置核验与消费面盘点的完整数据保留在 spec §2–§5。

---

## 0. 裁决（全部落档 spec §0，保守无能力损失默认，产品可推翻）

- **裁决 A**：验收判据按 M3 先例重写——「符号面归零 + 幸存三词 wire 字面量收敛到最小登记模块」。
- **裁决 B**：`acodeProtocolClient.ts` 保留（永久传输载体，M2-0 裁决），类型联合收窄
  （`ACodeProtocolClientMethod = ACodeAgentRpcMethod`，不再引用 barrel 的 `ACodeProtocolMethod`）。
- **裁决 C**：legacy-types 按符号甄别——10 个 v4 消费符号迁中立叶后文件无剩余承重面，随 barrel 删除。
- **裁决 D**：测试锚点同步改指，不豁免（实测 13 处真引用 + 2 处路径断言，全部处置）。
- **裁决 E**：NDJSON 信封按 M2-0 载体先例定性为**版本无关 wire 载体面（永久，非 legacy 债务）**，
  迁 `acode-protocol-envelope.ts`；v4 原生信封建模拆出为 **M4b（协议扩展工程，开放项）**，不阻塞 M4a。

## 1. 实施链（如实记录）

1. **盘点代理**：AST 级消费面扫描（464 导出 / 196 被消费 / 139 生产文件）、A/B/D 三向归类、
   四条活链路阻塞证据、四项裁决建议——零代码改动，产出 spec 与本报告初版。
2. **实施代理**（编排方批准 M4a/M4b 分段 + 裁决 E 后）：完成 (i) 零消费删除、(ii) A 类 107 符号
   切 v4（117 文件，`m4-rewrite-consumers.mjs` 机械化改写）、(iii) D 类 71 符号迁 14 个中立模块 +
   B 类幸存三词迁 survivor 模块、根入口 re-export 切换，`tsc -b` 全绿；(iv) 段进行中被终止。
3. **收尾代理**：删孤儿 barrel/legacy-types、freeze 三件退役、boundary 守护改写、红线登记、
   6 测试锚点改指、policy 4 条定点删——代码面全部落地后、验证与文档段之前被运行时重启终止。
4. **编排方**：裁决 E 补录 spec、全部门禁亲验、本报告与收敛计划终态、提交。

## 2. 删除与收编

| 项 | 数值 |
| --- | --- |
| 删除：barrel `acode-protocol/index.ts` | 3,652 行（目录 `acode-protocol/` 随之消失） |
| 删除：`acode-protocol-legacy-types.ts` | 607 行（10 个 v4 消费符号先迁中立叶） |
| 删除：freeze 测试 + 2 份基线 JSON | `legacy-protocol-barrel-freeze.test.ts` 使命随 barrel 终结 |
| 收编：14 个中立/幸存模块 | 合计 2,298 行（见 §3） |
| 消费面改写 | 117 文件（A 类 107 符号 → v4 子路径；ui 54 / cli 43 / services 32 / shared 6 / desktop 2 / server 2 按包分布） |
| 工作树形状 | 182 文件（161 M / 5 D / 16 新增），已跟踪面 +1,317 / −7,303 |

## 3. 14 个中立/幸存模块（`packages/shared/src/`）

| 模块 | 行 | 承载 |
| --- | ---: | --- |
| `acode-protocol-envelope.ts` | 84 | NDJSON RPC 信封族（裁决 E：版本无关载体面，永久） |
| `acode-protocol-legacy-survivors.ts` | 154 | M3 幸存三词 wire 字面量 + 专属 schema/类型（头注含裁决依据与逐词移除条件；绝不扩新能力） |
| `acode-protocol-legacy-skew.ts` | 41 | 13 个偏斜回落方法词 + 8 个 legacy 通知词（M3 遗留①偏斜面登记，仅迁词不改逻辑） |
| `acode-storage-startup.ts` | 46 | 存储启动控制面（desktop host 消费） |
| `acode-agent-notifications.ts` | 224 | agent→host 通知载荷（mcp telemetry / resource samples / tool exec / idleExit / plugin operationProgress + 3 常量） |
| `acode-model-options.ts` | 93 | 模型选项 / 思考档 / 上下文预算策略 / runtime preferences |
| `acode-session-types.ts` | 167 | session 核心类型（goal/info/mode/status/kind/workspaceRef/deliveryKind 等） |
| `acode-message-types.ts` | 314 | 消息模型（messageInfo/parts/tokenUsage/toolState/timelinePart/messageWithParts/textFrom） |
| `acode-interaction-types.ts` | 88 | 权限裁决 + interaction origin + CUA/refine 常量 |
| `acode-session-runtime-types.ts` | 112 | runtime 状态（apiRetry/autoResume/contextCacheUsage/contextUsageBreakdown 等） |
| `acode-session-projection.ts` | 305 | session 投影（snapshot/settings/todo/pendingPermission/activeToolCall + goal/compact/create/list params） |
| `acode-session-events.ts` | 121 | session 事件信封 / type / 26 变体 union / eventsResult / stateUpdated |
| `acode-session-event-payloads.ts` | 394 | 26 事件变体 payload |
| `acode-tool-result-display.ts` | 155 | 工具结果展示（nodeRepl 图片 / workflow 因果图 / toolResultObject） |

session 投影/事件形状**一律未改**（v4 `conversationSnapshotSchema` 的 4 身份字段缺口不在本批补——
那是 M4b 性质的协议工程，登记为开放项）。

## 4. 守护与策略同步

- `scripts/architecture/protocol-boundary.mjs`：白名单收窄（`acodeMessageWithPartsSchema` 无 v4
  importer，移出）并转 **tombstone 语义**——barrel 目录与 legacy-types 路径若被复活式引用，
  fail-closed 立即报违规；头注登记 10 个符号 → 中立叶的完整映射。
- `packages/shared/tests/protocol-boundary.test.mjs`：断言面改为新事实（根入口无 barrel
  re-export、survivor/skew 模块在位、v4 面不含幸存词）。
- `packages/server/tests/harness-api.test.mjs` 红线守护：M4a 的 shared 面改动按流程**逐文件登记**
  （1 条 ` D ` barrel 删除 + 15 条 ` M ` v4 叶 import 改指，均带 spec 引用，不用通配）。
- `architecture-policy.yaml`：`onboard-b3-shared-over-limit` / `-disables` 两节中 barrel 与
  legacy-types 的 **4 条 paths 定点删除**；`.architecture-baseline.json` 实测无需改动（shared 零条目）。
- 6 处测试锚点改指：`acp-host-adapter` / `architecture-coverage`（fixture 保留合成 barrel 路径
  字符串——那正是 tombstone fail-closed 的测试方式）/ `todo-dependency-fields` /
  `harness-api` / `providerDiagnostics.test` / `workspaceModeConfigOptions.test`。

## 5. 终态判据（裁决 A 口径，实测）

- `git grep "acodeProtocolMethods\.\|acodeProtocolNotifications" -- packages apps`：代码零命中。
- `packages/shared/src/acode-protocol/`：不存在。
- `acode-protocol/index` 字样：仅存历史注释（标「M4a 已删」）、fixture 字符串与红线登记条目。
- 根入口 `packages/shared/src/index.ts`：barrel re-export 删除，中立模块 `export *` 在位。

## 6. 门禁（编排方亲验，真实执行）

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck`（全仓） | exit 0 |
| `pnpm lint` | 163 warnings / 0 errors（持平基线） |
| `pnpm architecture:check --changed` | new 0 / regrown 0 |
| `node scripts/licenses.mjs reproducibility --inputs-only` | **2904 项全符**（barrel/legacy-types 不在登记面，零漂移——证实前置核验 §台账订正） |
| 全仓 `pnpm -r run test`（排除 agent-teams-plugin，见 §7） | **EXIT 0，17 包全绿 fail 0**：cli 根 3243/3206 pass/37 skip；shared **479/479**（freeze 退役与 boundary 改写后净 +1）；services 585/578/0/7；ui 1231；desktop 451；core 130；server 114；web 41；formal-proof 39；provider 49；server-cli 39；rpc 30；provider-node 29；harness-sdk 15；model-option-map 14；client 12；adapters 5 |
| 终态 grep（§5 四条） | 全部通过 |

## 7. 已知问题（均与 M4 无关，登记待专项处置）

1. **agent-teams-plugin real-git 套件本机 3 例失败**：`worktree.test.ts` 的 member worktree
   生命周期用例在本机 Windows（全局 `core.autocrlf=true`）下失败；fixture 临时仓继承全局配置
   未中和（`git init` 后只设了 user.email），产品源码零 autocrlf 引用。CI Linux（权威平台）
   该包全绿。**待裁决**：属「测试 fixture 未中和环境」还是「产品 Windows 面真实缺陷」——
   若是后者，Windows 用户的 member worktree merge/snapshot 流程受影响。全量门禁暂排除该包。
2. **workflow-script-determinism C1 时钟 flake**：全量运行中偶发一次失败
   （`Object.getPrototypeOf(Date).now()` 绕过用例的真钟读数落在测试进程 `[before, after]`
   窗口外）；单文件复跑 18/18 绿，M4 未触碰该测试与沙箱源码。判定为系统时钟回拨（NTP 校准）
   撞上窗口断言。**加固建议**：窗口断言引入容差或改用单调性校验。

## 8. M4b 开放项（协议扩展工程，待产品/工程排期）

- v4 原生 NDJSON 信封 schema 建模（替代中立载体 `acode-protocol-envelope.ts` 的长期归宿）；
- v4 `conversationSnapshotSchema` 补 4 个身份字段（与 session 投影面等价化）；
- 需双链路真实冒烟环境前置（desktop-continuous + web-remote-replayable，见 m2-scoping.md §4）。

M3 遗留偏斜面（host 侧 17 条 inbound legacy 字面量分支、`state.updated` legacy 广播面）
仍独立待裁决，与 M4b 一并归入「偏斜面与发布形态」专项。
