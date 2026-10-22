# ACode 1.0.3 深度 Review · CLI 运行时与两套 Workflow

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + 三门禁实跑（typecheck/lint/architecture:check 全绿）+ 守护/SWF 回归测试实跑，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。CLI core 内部结构另见 [cli-core-structure.md](cli-core-structure.md)。

范围：`apps/acode-cli` 运行时——CLI 入口、`CommandInbox` 串行 admission、会话生命周期、两套 workflow（Dynamic + Script）执行链路、owner/lease、stale run 防护、W1-R3 拆包。**重点是核对 2026-10-08 历史修复在 1.0.3 是否回归。**

---

## 1. 层面整体评估

CLI 运行时在 1.0.3 处于**健康状态**：历史 review 的 CLI-02/03/05/07、DWF-01..04、SWF-01..08、W1-R3、ARCH-01 全部落地且未回归，`pnpm typecheck`/`pnpm lint`/`architecture:check` 三门禁实跑全绿（baseline 412、new 0；lint 167 warnings/0 errors）。W1-R3 物理拆包已完成并**超出**原范围——引擎族迁入 `@acode/cli-workflow`（70 文件），另新建 `@acode/workflow-run-command`（owner/resume 命令序）与 `@acode/workflow-run-read`（读模型）两个受管包，四者均纳管、深导入守护测试 4/4 绿。最大风险不在已修复项，而在**结构债再生长**：CLI-06 的 `create-app.ts` 从 1593 行涨到 1654 行、`bootstrap/src/app` 从 fix-status 宣称的 11,799 行涨到 13,590 行；以及 CLI-04 的**同类残余**——MCP 写审计 sink 与 worktree fence warn sink 仍是进程级 set（已知并注释，但与被修复的 bash/auto sink 是同一类多 App 串线风险）。

## 2. 问题清单

**[P3] CLI-04 同类残余：两个审计/告警 sink 仍是进程级单例** — `apps/acode-cli/packages/bootstrap/src/app/create-app.ts:294`（MCP call audit）、`create-app.ts:1585` + `apps/acode-cli/packages/core/src/worktree/session-worktree-fence.ts:311`（fence warn）
- 描述：bash-reflex 与 auto-classifier sink 已按 sessionId 注册/释放（CLI-04 正主已修），但 `setMcpCallAuditSink`/`setSessionWorktreeFenceWarnSink` 仍是无 sessionId 注册表的进程级 `let`，任一 App close 时 `setX(undefined)` 复位。
- 触发：同进程多 App（桌面 app-server）下后装配者覆盖、先 close 者把在跑 App 的 sink 打回缺省 stderr。
- 证据：`create-app.ts:288-289` 注释已承认「后装配者覆盖、close 复位兜底」。
- 建议：与 bash/auto 同款改为按 sessionId 注册表路由（entry 已带 sessionId，见 `:312`）。
- 验收：双 App 交错 MCP 写审计，各自归属正确 trace，一个 close 不影响另一个。

**[P3] CLI-06 结构债再生长：装配层行数不降反升** — `apps/acode-cli/packages/bootstrap/src/app/create-app.ts`（1654 行，历史 1593）、`bootstrap/src/app`（13,590 行，fix-status 宣称 W1-R3 后 11,799）
- 描述：W1-R3 迁出引擎后，1.0.x 新功能（tool-search、CliGovernor 内存治理、in-flight 用量链、conflict:// 面、密钥混淆）又在装配层堆积。
- 触发：每次新增应用服务接线。证据：`git log` 显示 a991cd0b/1ef4de30/802d90bb 等均改 bootstrap。
- 建议：按 W1 续批把 session/application facade 与进程装配分离，create-app 只建依赖与资源 owner。
- 验收：bootstrap/src/app 行数下降，新增服务有独立 typecheck/lint/test。
- 注：与 [cli-core-structure.md](cli-core-structure.md) §2 P2 是同一结构债的两个观测面，两份结论一致。

**[P3] resume-workflow-run 仍声明 concurrentSafe:true** — `apps/acode-cli/packages/core/src/tool/handlers/resume-workflow-run.ts:185`
- 描述：DWF-03 原文建议改 false 作缓解，现依赖 service 侧 `resumeAdmissions` 同步 reservation（已验证正确）兜底，故非缺陷；但工具面仍允许 executor 并发派发，防线只剩单层。
- 建议：确认 service reservation 是唯一权威后，可保留；否则改 false 做纵深。
- 验收：两次并发 resume 一个成功一个 already_running（已由 DWF-03 测试覆盖）。

## 3. 历史问题回归核对表

| 编号 | 状态 | 证据（精确位置） |
|---|---|---|
| CLI-01 | 已修复 | 根 `.oxlintrc.json:80` ignore CLI 属**设计**（两级配置）；CI 有独立 `Lint CLI workspace`（`ci.yml:89`）+ 单一类型门禁 `pnpm typecheck` 含 cli 阶段 |
| CLI-02 | 已修复 | `file-config.adapter.ts:498 mutateConfigFile` 包在 `withFileLock`（跨进程，`@acode/shared/node`）内读-改-原子写 |
| CLI-03 | 已修复 | `session-registry.ts:490 #validateCwd` 用异步 `realpath`，`:522` 全路径段判断 `rel===".."||startsWith(".."+sep)`，拒绝越界 junction |
| CLI-04 | 部分修复（主项已修，残余见 P3） | bash-reflex `:442 sessionAuditSinks` Map + `:454 register`/`:459` 幂等释放；auto-classifier 同款。MCP/fence sink 仍进程级 |
| CLI-05 | 已修复（lifecycle 簇） | `internal.ts:232 RuntimeSessionLifecycleState` 全为 readonly View；`shuttingDown`/`permissionFullAccessPending`/`lastPermissionGrantId`/`pendingModelChangeTimeline` 经 WeakMap owner + `Object.defineProperty` getter + 有限写端口。context/turn/projection/cache 簇仍登记债（见 cli-core-structure.md P1） |
| CLI-06 | W1-R3 已实现，装配层再生长 | 见 P3；`cli-workflow` 70 文件、contract 81 行（历史 61） |
| CLI-07 | 已修复 | `supervisor.ts:357 lastHeartbeatAt`、`:368 scheduleCoreHealthCheck`（healthy/degraded/unresponsive）、`:471` generation+child 双绑定、`:440 scheduleAutomaticReadyDeadline` |
| DWF-01 | 已修复 | signal 全链：`engine-world.ts:120-121 throwIfAborted()`+传 driver → `workflow-driver.ts:461` → `workflow-world-read.ts:340-347 executionPort.run(...,{signal})` → `node-execution-adapter-lifecycle.ts:52-56 controller.abort()` |
| DWF-02 | 已修复 | `scheduler.ts:186 seq=actor.nextAdmitSeq`（读不增），`:193/197` 仅命中/准入时 `++`；拒绝经 `scheduler-budget.ts:17 recordAskAdmissionRefusal` 落 failed 行、`:7 isAskAdmissionRefusal` 无 actorSeq |
| DWF-03 | 已修复 | `dynamic-workflow-run-submit.ts:408-411 resumeAdmissions.has/add` 在任何 await 前；`:164` service 级 Set（非 per-call）；`:554 finally` 释放 |
| DWF-04 | 已修复 | `engine-artifacts.ts:127-134 queueArtifactPublish`（同 id FIFO + 新 id 共享 lane）；版本在队列内算 `engine-artifact-content.ts:58` |
| SWF-01 | 已修复 | `script-workflow-process.ts:115 pendingHandlers` Set + `:147 Promise.allSettled` close 后排空再结算 |
| SWF-02 | 已修复 | `background-task-registry.ts:79-110 rearm` 复位结算面（notified/completedAt/error/resultText） |
| SWF-03 | 已修复 | `script-workflow-replay.ts:215 latestStart` 按最后 workflow_started 切 attempt，`:220` 只判最新 attempt 终态 |
| SWF-04 | 已修复 | `script-workflow-process.ts:41/60 throwIfAborted` spawn 前后双检，`:105` 订阅后立即 abort |
| SWF-05 | 已修复 | `script-workflow-meta.ts:3 parseModule`（meriyah AST），`:239` 非纯字面量拒绝，无 eval/子进程 |
| SWF-06 | 已修复 | `workflow-worktree-manager.ts:78 branch` 含 activityId；`:101 normalizeForCompare` 用 `realpathSync.native`（修 8.3 短名数据丢失） |
| SWF-07 | 已修复 | `script-workflow-runs.ts:173 begin immediate` + `:188` 既有事件幂等短路 + `:213` owner-token stale 拒绝；runtime `:686 usageSettled`/`:673 activityFinalized` 双 guard |
| SWF-08 | 已修复 | `workflow-run-command/script-workflow-owner.ts:35` parentSession+`:45` workspaceIdentity+`:51` remoteSessionId 三重 gate，fail-closed |
| W1-R3 | 已实现（超范围） | `cli-workflow` 包 + 新增 `workflow-run-command`/`workflow-run-read`；守护测试 4/4（引擎不在 bootstrap、深导入即红、人为 fixture 自检） |
| M2 capability | 部分（M2-B 落地） | `services/test/v4-capability-query.test.ts` + `specs/v4-capability-query.md`；深度迁移待续（见 protocol.md §3） |
| ARCH-01 | 已修复 | descriptor 参数校验债务清零（`rpc-descriptor-surface` 门禁强制，见 protocol.md §4） |

## 4. 两套 Workflow 边界

执行语义**各自 owner 保留清晰**。Dynamic：`WorkflowEngine` + typed actor/node/journal，`dwf_*` 表，纯引擎不读时钟/IO，resume 要 byte-identical 脚本+同 runId，amend 铸新 runId 停前驱。Script：`ScriptWorkflowRuntime` + `workflow_*` 表 + `wf_*` 标识，ALS callPath 缓存（非 temporal replay），resume 复用原记录按 callPath 命中 activity。复用面收敛在**观察层**（共享 reducer + progress adapter）与**命令序**（`workflow-run-command` 的 owner gate），两 dialect 的 attempt/持久结果/生命周期各写各的表，不互串。W1-R3 后边界更硬：`cli-workflow/contract.ts:81` 明文列「本包不拥有」清单（会话事实归 core、journal 归 adapters、读模型归 run-read、命令序归 run-command），深导入守护测试机械阻断。schema 校验（SWF-schema）现按受限 JSON Schema 子集在 child 启动前（`script-workflow-runtime.ts:471`）+结果提交前（`:594 parseStructuredResponse`→`utils.ts:121 validateJsonSchema`）双向 fail-closed，与 Dynamic typed ask 仍是不同机制（文档已区分）。

## 5. W2/legacy M3 阻塞评估

**仍阻塞，未在 1.0.3 推进。** `docs/legacy-protocol-convergence-plan.md:87` 记 bootstrap legacy server **48 文件/14,713 行 M3 未启动**，v4-bridge 过渡钩子 6 个。依赖链：M3（删 CLI legacy 协议 server）依赖 M2（services 双栈切换），M2 目前只落地 M2-B（shared schema 边界）+ `capabilities/query` 最小切片，其余 legacy services 调用仍在后续批次。W2（bootstrap workflow 写面物理拆包）依赖 M3。评估：这是**登记在案的结构里程碑债**，非缺陷——按 AGENTS.md「新命令只进 v4、legacy 只删不增」冻结规则，风险受控（不会恶化），但 48 文件 legacy server 与 6 个桥钩子仍是 protocol 面的主要复杂度来源。前置是为 plugins/mcp/skills/workflows-hub/automation 等写路径新增 v4 契约并按双链路（desktop-continuous/web-remote-replayable）真实冒烟，工作量大，分批合理。**不阻塞 1.0.3 交付。**

## 6. 门禁实跑

本机 Node v25.9.0：typecheck exit 0、lint exit 0（167 warnings/0 errors）、architecture:check OK（baseline 412/new 0/regrown 0）、boundary 守护 4/4、SWF 回归 54/54。DWF 的 `workflow-artifact-races`/`workflow-lifecycle-replay` 2 个测试文件因本 worktree 未生成 `libs.generated.js`（构建产物，非提交文件）import 失败，同批 26/28 断言通过——**非代码回归**，跑前需 `pnpm --dir apps/acode-cli build`。

## 7. 修复入口建议

跑 `pnpm --dir apps/acode-cli build` 后重跑那两个 DWF 测试文件确认 0 fail（约 3 分钟）。三个 P3 均为结构债/纵深防御，不阻塞交付，可纳入下一周期。
