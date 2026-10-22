# ACode 1.0.3 深度 Review · services 层（会话 / owner-lease / storage / workflow owner）

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + `architecture:check` 实跑，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/services`（365 文件 / 108,760 行）：会话库（session）、路由、连接租约（owner/lease）、派生 task index、storage（SQLite）、workflow owner、`createServiceLogger`。纳管状态：services（managed:false）、session（managed:true，publicEntrypoints 有意留空）、storage（managed:true）。

---

## 1. 层面整体评估

services 层在关键并发/持久化边界上比历史 review 时更稳：owner/lease 的 generation fence、automation/offPeak 的 claim-stale 单飞认领、taskIndexRepo 的 per-(workspace,task) 写串行链 + SQLite `BEGIN IMMEDIATE`、automationRepo 的 `markRunOutcome` CASE 防终态回退都健在，且 `task-index-writers` 守护测试当前 0 offender——历史点名的「派生库双写」已被门禁钉死。`architecture:check` 全绿（violations 412 / baseline 412 / new 0 / regrown 0）。最大风险不在状态所有权，而在两处纪律松动：(a) 凭据面日志绕过统一脱敏漏斗；(b) 身份 key 构造散落 10+ 份内联副本（EI-2）。结构债集中在 8 个 400+ 行巨型文件与 session publicEntrypoints 留空的迁移状态。未发现用 `setTimeout` 兜底同步的伪修复——所有定时器都是合法的超时中止、退避重排或协议帧组装降级（EI-91）。

## 2. 问题清单

**[P2] OAuth/凭据面日志绕过统一脱敏漏斗** — `packages/services/src/oauth/oauthService.ts:45`、`packages/services/src/oauth/providers/zaiProviderAdapter.ts:61`
- 描述：两处用裸 `console.log(formatLogPrefix("oauthService", process.pid), ...args)` 定义模块级 log helper，不经 `createServiceLogger` 的 `redactServiceLogArg`（`logger/serviceLogger.ts:61` 是唯一脱敏漏斗）。
- 触发/证据：OAuth/PKCE 授权流、provider token 交换路径调用该 helper 时，任何含 code/token/redirect 的 args 直接落 stdout，绕过 `log-privacy-redaction.md` 承诺的源头脱敏。AGENTS.md「日志」节明确要求 services 用 `createServiceLogger(scope)`。
- 建议：换成 `createServiceLogger("oauthService")` / `("zaiOAuth")`，保留 pid 前缀由 `formatLogPrefix` 在漏斗内处理。
- 验收：grep 确认 oauth 目录 0 处裸 `console.*`；单测断言含 token 字样的 args 经 helper 后被脱敏。

**[P3] 身份 key 构造重复实现（EI-2）** — `paths.ts:193`（私有 `getWorkspaceKey` 未导出）、`shared/src/task-realtime-core.ts:76`（`resolveWorkspaceKey`）、`acodeAgentConnectionScope.ts:124`（本地 `workspaceKey`）、`bots/workspaceHelpers.ts:8`、`hooks/hooksService.ts:264`、`file/fileService.ts:293`、`acode-session/acodeSessionDraftRegistry.ts:8`、`acode-agent/acodeAgentBrowserAmbientContext.ts:68` 等 10+ 处
- 描述：`workspaceIdentity?.trim() || workspacePath` 语义正确且各处取值一致（未发现仅按路径匹配的隔离缺陷），但同一规则有 10+ 份手写副本，shared 已有 `resolveWorkspaceKey` 却只被 13 个文件采用。
- 触发/证据：AGENTS.md「Workspace Identity」要求「复用现有构造和解析工具，不在业务代码中手写格式」；EI-2「一个语义一份实现」。任一处漏掉 `.trim()` 或改判空即静默分叉。
- 建议：统一导出 `resolveWorkspaceKey`（shared 或 paths.ts），内联副本逐处替换；`paths.ts` 的 `getWorkspaceKey` 改为复用而非另写。
- 验收：grep `workspaceIdentity?.trim() || workspacePath` 在业务文件归零，只保留单一工具定义。

**[P3] console.* 绕过统一 logger 的残留** — `acode-agent/acodeAgentService.ts:5051`（`console.warn`）、`mcp-sync/mcpSyncService.ts:515`、`node.ts:1403`、`setting/settingService.ts:39,45`
- 描述：同类文件已持有 `logger`（`hooksService.ts:216` 注释明确「services 层曾直接 console.warn，无法进入统一服务日志文件」——已知正在收敛的模式），这几处仍是裸 console，不进服务日志文件、不脱敏。
- 触发/证据：`acodeAgentService:5051` 是 session 订阅达最大重试的 warn，属「可恢复异常」应走 `logger.warn` 落盘；当前只到 stdout，生产环境丢失。
- 建议：替换为对应 scope 的 `createServiceLogger`；`node.ts` 组合根若早于 logger 装配可保留但加注释说明。
- 验收：services/src 内非 logger 模块的 `console.*` 计数从 8 降到仅剩装配根豁免项。

## 3. 历史问题回归核对

- **DWF-01..04 / SWF-01..08 / CLI-05/06**：均在 `apps/acode-cli`（bootstrap/core/dynamic-workflow），**不属 services 层**。`fix-status-2026-10-09.md` 记录已修复 + 二次复核（DWF 矩阵 106/106、SWF 回归 84/84、CLI-06 W1-R3 物理拆包完成、CLI-05 关键状态簇 WeakMap owner 化）。本层未见回归证据。
- **task-index 派生库双写（2026-10-05 P1）**：**已收口为门禁**。`tests/task-index-writers.test.mjs` 白名单 10 文件，当前实测 0 offender；spec `task-index-write-ownership.md` 明确 `acodeSessionService` 不直引 TaskIndexRepo、legacy `session_info_update` 投影随协议收敛里程碑删除。adapter 的 legacy stream 路径（`acodeTaskServiceAdapter.ts:1427/1671`）仍在，但受白名单 + `subagent_child` 守卫（`:1388`、syncer `:1716`）约束，未新增写入方。
- **owner/lease 边界**：**健在且更严**。`acodeAgentConnectionScope.ts` 的 `runtimeGenerationByWorkspaceKey` + 迟到 ACK 拒绝（`:586-595` 比对 generation，旧 runtime ACK 不反向 unsubscribe 新 runtime）、unavailable 直接失效本地 owner（`:668`）。未发现「仅按单一路径删除边界判断」。
- **identity/remoteSessionId 贯穿**：`remoteSessionId` 在 services 内 32 处传递，identity key 语义一致（见 P3——是重复实现问题，非隔离缺陷）。**无回归**。
- **持久化幂等**：automationRepo `markRunOutcome`（`:1353` CASE 防 running 覆盖终态）、`recordSkippedRun`（`ON CONFLICT DO UPDATE`）、claim/stale（`CLAIM_STALE_MS` 10min 与 `OFF_PEAK_CLAIM_STALE_MS` 独立常量，符合 spec「同库不同表、常量全独立」）均**符合历史结论，无回归**。settingsWriteQueue 的 `enterCommitPhase` 后禁用超时（`settingsWriteQueue.ts:44-49`）是正确的「不用超时掩盖同步」。

## 4. 巨型服务文件 Top 8

| 文件 | 行数 | 职责评估 |
|---|---|---|
| `bots/botsService.ts` | 6751 | bot 渠道运行时（telegram/feishu/discord/webhook/weixin）：连接、消息、附件下载、权限、context 状态、telegram offset 持久化全在一文件。职责严重过载，应按渠道/关注点拆分。legacy ratchet 冻结。 |
| `acode-agent/acodeAgentService.ts` | 5940 | ACode agent 会话订阅、stream、task 生命周期、model telemetry。核心服务。**较历史基线 5662 增长 278 行**——ratchet 只锁整个 legacy over-limit 计数不 regrown，单文件增长被 baseline 吸收，需警惕持续膨胀。 |
| `acode-agent/acodeTaskServiceAdapter.ts` | 5864 | task 用户操作（pin/archive/delete/rename/unread）+ legacy stream 投影 + 按需 seed。历史点名的双写风险面，现有守护测试 + subagent_child 守卫约束。 |
| `node.ts` | 2819 | 组合根/装配根。装配职责合理，但体量说明接线未下沉到 factory。 |
| `session/taskIndexRepo.ts` | 2567 | 派生索引 SQLite 本体，per-key 写串行链。登记在 `onboard-b3-session-over-limit` 例外（expires 2026-12-31），到期即门禁红。 |
| `settings-sync/settingsSyncService.ts` | 2408 | 设置跨端同步。legacy ratchet 冻结。 |
| `acode-agent/acodeAgentProcessManager.ts` | 2080 | agent 进程 spawn/admission/代际/disposed 检查。生命周期职责密集但内聚。 |
| `acode-agent/acodeTaskIndexSyncer.ts` | 1998 | 运行时状态唯一漏斗（v4 帧摄入、snapshot upsert、广播、协议帧组装超时降级）。spec 认证的唯一写入漏斗，体量反映其汇聚职责。 |

8 个文件全部带 `eslint-disable max-lines`：session 的 2 个（taskIndexRepo 等）走 over-limit 例外；其余 6 个走 legacy ratchet。acodeAgentService 的增长是 ratchet 机制下的隐性膨胀点。

## 5. 迁移债评估

**session publicEntrypoints 留空**：`architecture-policy.yaml:88` 确认 `publicEntrypoints: []`，checker 因此不校验 services→session 的 deep-import（`scripts/architecture/index.mjs` 只在列表非空时校验）。spec 登记为 31 条内部边 / 15 个实现文件；**当前实测约 39-40 条**（非 session 目录文件 import session 实现文件，前缀去重），目标集中在 `acodeTaskService.js`（10）、`offPeakTask.js`（6）、`taskIndexRepo.js`（5）、`acodeSession.js`（5）。`session/contract.ts` 仅暴露 13 个 export。**进展判断：ratchet 纪律（新代码从 contract.ts 导入、存量逐条迁移）未有效收敛，内部边反而增长约 8 条**。风险：contract.ts 作为「迁移目标入口」已落地但空转，双向耦合（services→session ~39、session→services 7 边）未解除；到期（2026-12-31）前若未拆分 7 个 over-limit 文件 + 移除 8 处 disable，门禁转红。建议：先让 checker 在 publicEntrypoints 非空时阻断新增 deep-import（当前纯靠评审纪律），把 contract.ts 注册为入口的前置——即把 ~39 条内部边迁到契约面——列为独立里程碑，而非无限期「惰性保持合法」。

**services 未纳管（managed:false）**：整个 services 包（除 session/storage 两个已纳管子模块）是 legacy，只受 `max-file-lines-ratchet` + `imports-into-managed-public-entrypoint` + `reverse-dependency-graph` 检查，**不受** module-dependency、cycle、domain-io、layer-direction、disable-count 约束。`architecture:context services` 显示 `owner: unassigned / requires: none / module.ts: missing`。fix-status 已定价：services 纳管前置是 2 个 type-only 环 + 48 超限文件 + checker resolver 三缺口（exports map、通配入口、asset 豁免）。风险：44 个顶层子目录、4242 个 legacy 文件在无 cycle/layer 门禁下演进，session↔services 双向耦合正是未纳管直接后果；acodeAgentService 增长无法被结构性拦截。**当前进展：已定价、未启动**，依赖 checker resolver 修复这一共同前置。

## 6. 修复入口建议

优先修 P2 凭据日志脱敏（`oauthService.ts:45` + `zaiProviderAdapter.ts:61` 换 `createServiceLogger`），这是唯一触及安全面的项，约 15 分钟。
