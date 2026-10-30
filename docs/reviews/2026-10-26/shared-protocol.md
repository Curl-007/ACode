# ACode 1.0.4 深度 Review · 协议与共享类型（packages/shared）

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验 + `git diff ebe9033b..HEAD` 改动面分析。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/shared/**` —— v4 协议（`acode-protocol-v4/`）vs legacy（`acode-protocol/index.ts`）退役、descriptor 校验、identity key 语义、凭据原语、DPAPI/钥匙串。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R2-02 [P2]** legacy barrel 违规新增 schema 导出 `acodeMcpReconnectSuspensionSchema` | 定义迁中立叶子；barrel 改纯 re-export；守护测试 + 基线（246） | **HOLDS** | 定义现在 `acode-protocol-shared.ts:94-102`；barrel 仅 re-export `acode-protocol/index.ts:53-60`；`git diff ebe9033b..HEAD` = **+0/−2 export**（净删除）。守护 `test/legacy-protocol-barrel-freeze.test.ts` 断言子集关系；**基线 246 = 当前 246 精确相等**（0 增 0 删，sorted+dedup）。测试经 `package.json:30` glob `test/**/*.test.ts` 接线 |
| **dontAsk [P3]** offPeak 冻结面内追加枚举值 | 合法新产品档位；约束已成文 | **HOLDS** | `acode-protocol/index.ts:3435` `acodeOffPeakPermissionModeSchema = z.enum([…"dontAsk"])`。约束「offPeak v4-化时复用 submissionModeSchema，不得另建第二份五档词表」已成文于 `specs/legacy-protocol-freeze.md:50-52`。v4 `submission.ts:6` + `command.ts:234` 携带相同五值集。无双源分叉（offPeak 无 v4 命令） |
| **resolveWorkspaceKey** 从 `@acode/shared` 根公开导出 | 已导出，无需改动 | **HOLDS** | 定义 `task-realtime-core.ts:76`；re-export `index.ts:92`（`export * from "./task-realtime-core.js"`）。services 消费方确认从 `@acode/shared` import（`acodeAgentConnectionScope.ts:18`、`acodeAgentProcessManager.ts:34`、`acodeAgentService.ts:19`）。路径解析通过 |
| **DPAPI [P3]** PowerShell 插值 | spawn 前 base64 校验 | **HOLDS** | `credentialKeychain.ts:260` `/^[A-Za-z0-9+/]+={0,2}$/` 在 `spawnPowershell` 前门控 read；测试 `tests/credential-keychain.test.mjs:151-175` 注入 `AAAA'); Start-Process calc.exe #` 断言 error + `calls.length===0` + argv 干净。写路径正确地不校验（输入是 Buffer 重编码 base64，`:290`） |
| **relay_bridge 死枚举**（desktop G 的跨文件事项，shared 侧） | desktop 记为有意预留；shared 侧「主审可选删值或加注释」 | **NOT-FOUND / DROPPED** | 仍是死的：`task-realtime-core.ts:101` + `task-realtime.ts:78` 未变（`git diff ebe9033b..HEAD` 空）。见新发现 3 |

## 2. 新发现

### [P2] v4→legacy 反向依赖经 `acode-protocol-legacy-types.ts` 存在，且**不在架构检查器的守护边界内**（主审亲验）

- **CONFIRMED 证据**：守护谓词 `isSharedV4ToLegacyProtocolImport`（`scripts/architecture/index.mjs:42-49`）只匹配 `imported.startsWith("packages/shared/src/acode-protocol/")`（**尾部斜杠 = 仅目录**）。而 `acode-protocol-legacy-types.ts` 是**同级文件**，不在该目录下——`ls` 证实二者是兄弟路径（`acode-protocol/index.ts` vs `acode-protocol-legacy-types.ts`），谓词对 legacy-types 返回 **false**。4 个 v4 文件直接 import 它：`acode-protocol-v4/snapshot.ts:11`（拉 `acodePermissionResponseSchema`、`acodeContextUsageBreakdownSchema`、`acodeInteractionRequestOriginSchema`、`acodeSessionContextCacheUsageSchema`）、`transport.ts:7` + `script-workflow-management.ts:17`（`acodeWorkspaceRefSchema`）、`telemetry.ts:2`（`acodeSyntheticUserMessageSourceSchema`）。架构 fixture（`apps/acode-cli/tests/architecture-coverage.test.mjs:167-171`）只演练 command.ts→barrel（拒）与 command.ts→shared-leaf（放），**从不演练 v4→legacy-types**。
- **为何重要**：上轮 review §6 认证「v4→legacy 反向依赖被架构 fixture 与真实 checker **双层禁止**」「无回归」，但只核验了 `command.ts`→barrel。该认证**实质不完整**：存在一条活的、无守护的 v4→legacy 标注面路径。收敛计划（`docs/legacy-protocol-convergence-plan.md:37`）明确把 `acode-protocol-legacy-types.ts` 标注为 legacy 面（「承重类型继续留在…直至 M4 甄别」）。
- **减轻因素（亲验源码注释）**：legacy-types.ts 的头注（`:1-6`）自述为**幸存面**——「旧协议死亡（acode-protocol/index.ts 删除）后，这是该协议面的唯一幸存面」。故它**不在 M4 被删**（是被甄别保留），这些 v4 边不会因 barrel 死亡而断裂——与 v4→barrel 边不同。M2-B 中立叶子模式正是为避免 v4→*barrel* 而生；这 6 个 schema 只是从未迁进叶子。所以**活体断线风险低**，但**守护边界窄于成文规则**，且上轮「双层守护/无回归」的认证不准确。未来维护者若新增一条 v4→legacy-types 的 import（引入一个 M4 会被甄别删除的符号），门禁不会拦截。
- **修复入口**：把 `isSharedV4ToLegacyProtocolImport` 的 target 判定从「目录前缀带斜杠」扩展为「`acode-protocol/` 目录 **或** `acode-protocol-legacy-types.ts` 文件」，并对 legacy-types 采用「白名单幸存符号」而非全禁（因其确是幸存面）；fixture 补一条 v4→legacy-types 用例钉住边界。

### [P3] 冻结守护仅覆盖 schema 定义，不覆盖更广的「不得新增导出」规则（主审亲验）

- **CONFIRMED**：守护 `test/legacy-protocol-barrel-freeze.test.ts:24-25` 只提取 `^export const ([A-Za-z0-9_]+Schema)`。barrel 另有 **14 个非 Schema `export const`**（含 `acodeProtocolMethods:3495`、`acodeProtocolNotifications:354`、协议常量）与 **189 个 `export type/interface/function`**——均不在覆盖内。成文冻结规则（convergence-plan:37、spec:12）是「不允许**新增导出**」，比「不得新增 Schema 定义」更宽。向 `acodeProtocolMethods` 加新方法、加新 notification、或加非 schema const **都不会触发守护**。
- **无活体违规**：`git diff ebe9033b..HEAD` 显示冻结日以来零新增非 schema 导出、方法表无新增。仅潜在覆盖缺口。无其他机械保护（架构检查器不数 barrel 导出）。

### [P3] relay_bridge 枚举全仓仍死；desktop 注释宣称的 server-cli 权威并不存在（主审亲验）

- **CONFIRMED**：`git grep "relay_bridge" -- packages/ apps/` 仅命中两处 shared 声明 + 注释/spec。**`packages/acode-server-cli` 对 `relay_bridge` 返回零命中**——但 `desktop/src/main/taskRealtimeBus.ts:15` 与 `desktop/specs/task-realtime-bus-mirror.md:84` 断言「relay_bridge 的权威在 acode-server-cli」。全仓无生产者、无分支消费者。desktop 侧修复（上轮代理 G）明确把 shared 侧作为跨文件事项搁置（「主审可选择在 shared 侧删值或加注释，低优先」）；两者都没发生——shared 文件与基线逐字节相同，两处声明行均**无解释性注释**。**desktop 注释指向的权威源不存在**是该 P3 的实质：注释撒了一个源码不支持的谎。

## 3. legacy 退役里程碑状态 + 冻结纪律

**全部里程碑停滞；convergence-plan 文档从未为 1.0.4 刷新**（最后触碰 `c453fca5`，2026-10-09；进度表仍是 2026-10-09 测量值）：

| 里程碑 | 状态 | 证据（主审亲验计数） |
|---|---|---|
| **M1**（UI projection 收口，目标 0） | **停滞/增长** | `acodeSessionProjection` 消费文件数（排除 test/spec）主审 grep = **18**（口径与上轮 review 的「10→12」因过滤范围不同而有差，但方向一致：未降反增） |
| **M2**（services 双栈，目标 0） | **未推进** | 仍 6 个 legacy 消费文件；`acodeProtocolClient.ts` 仍在。与上轮 review 时相同 |
| **M3**（删 bootstrap legacy server） | **未启动** | `bootstrap/src/acode-protocol/` 下仍 **48** 文件（主审 find 亲验） |
| **M4**（删 shared legacy barrel） | **未启动** | barrel **3652** 行（上轮 review 时 3654；−2 仅为 R2-02 的 export 迁移，非退役）。legacy-types 607 行 |

- **barrel 冻结纪律：HOLDS。** R2-02 已正确修复 + 机械守护（子集测试、精确 246 基线）。冻结日以来无新 schema/export 违规（git 核验：仅 `43afaba1` +2 后 `5888cbb5` −2 净零；`1272746b` dontAsk 是 +1/−1 就地改）。
- **守护纪律：PARTIAL**——仅 schema（新发现 2），且反向依赖守护有边界缺口（新发现 1）。
- **2026-12-31「最硬 deadline」**：shared **不携带**本地 `expires: 2026-12-31` 例外——barrel 用的是 `oxlint-disable max-lines` 头注（`index.ts:6`），非架构例外。上轮 review 点名的会「门禁转红」的硬例外（`onboard-b3-session-over-limit` 等）位于 **services/session，本层之外**。shared 的暴露是**间接的**：M4 被停滞的 M2/M3 阻塞，使 shared 的 legacy 退役落在通往该 deadline 的关键路径上，却没有 shared 本地的绊线。

## 4. 层面健康度

**良**。核心协议治理扎实——v4 严格校验、中立叶子模式、单一真源 `resolveWorkspaceKey`、DPAPI 注入守护全部保持，唯一确认的上轮 P2（R2-02）已带精确机械守护正确修复。扣分项：legacy 退役停滞且 **M1 活跃增长**（消费面未降反增）；冻结守护仅覆盖 Schema 定义（不含成文的「不得新增导出」规则）；一条真实的 v4→`acode-protocol-legacy-types.ts` 依赖**落在架构检查器守护边界之外**——与上轮 review「双层守护/无回归」的认证相矛盾（该认证只验了 v4→barrel）。无 P1，层内无数据/安全/门禁失效。新发现 1 的活体断线风险因 legacy-types 是「幸存面」而低，但守护缺口与过期认证需订正。
