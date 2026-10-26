# ACode 1.0.4 深度 Review · CLI 运行时行为

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`apps/acode-cli` 运行时行为——CommandInbox 串行 admission、会话生命周期、两条 workflow 执行链路、owner/lease 路由、stale run 防护、busy/running 输入处理、交付 profile（desktop-continuous vs web-remote-replayable）。core 内部结构见 [cli-core-structure.md](cli-core-structure.md)。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **CLI-04 残余：MCP 写审计 sink**（进程级单例） | sessionId 注册表 + 幂等释放 + 按 sessionId 路由 | **HOLDS** | `core/src/mcp/call-audit.ts:68`（`sessionAuditSinks` Map）、`:82` register、`:85` 幂等 delete；`:93` 按 `event.sessionId` 路由；接线 `create-app.ts:296`、释放 `:1589` |
| **CLI-04 残余：worktree fence warn sink** | 同 sessionId 注册表范式 | **HOLDS** | `core/src/worktree/session-worktree-fence.ts:74`（`sessionWarnSinks` Map）、`:340` register、`:346` 幂等 delete、`:83` 按 sessionId 路由；接线 `create-app.ts:329`、释放 `:1591` |
| 双 App 交错测试 | 绿 | **HOLDS** | `tests/mcp-lifecycle-call-audit.test.mjs:301`（「一个 close 不影响另一个」，断言 seenA/seenB 隔离）+ `tests/session-worktree-fence.test.mjs:248` |
| resume `concurrentSafe:true` 依据 | service reservation 唯一权威；handler 纯 passthrough；await 前同步 has/add | **HOLDS** | handler passthrough `resume-workflow-run.ts:139-147`（仅 `port.resume`）；reservation `dynamic-workflow-run-submit.ts:408-411` 在首个 `await`（`:467`）前同步 `has`/`add`；service 级 Set `dynamic-workflow-run-service.ts:164`；`finally` 释放 `:554` |
| 代理 N 的 5 个盲区测试（37 个） | 真行为、无固定 sleep、临时目录清理 | **HOLDS** | 6+6+8+7+10=37 确认。abort 测试唯一 `setTimeout` 是有界 `waitUntil` 轮询步长（`runtime-abort-concurrency.test.mjs:52`，15ms 步/15s 上限）——非固定 sleep。断言风格压倒性 `assert.equal/deepEqual/rejects`。临时目录测试全用 `t.after`+`rm force/recursive` |
| turn 时序 7 字段迁移——无漏迁写入点 | 全部写入经冻结端口 | **HOLDS** | `runtime-turn-timing.ts:107` `Object.freeze` 端口、`:168` `defineProperties` 无 setter getter + `configurable:false`；**25/25** 写入点经 `getRuntimeTurnTimingPort`（steering/turn/resume/rewind/rewind-message/compact/control-only-turn 全覆盖）；对迁移字段的 `this.<field> =`/`++`/`+=`/`.set(`/`.delete(` 穷举 grep = **0** 扁平写入（仅 `===` 读 + owner 内部 `#` 写）。**主审已在 cli-core-structure 专项交叉核验同一结论** |
| `pendingInputDrains` `0→undefined` 映射 | 语义保持 | **HOLDS** | owner 映射 `0`→`undefined`（`runtime-turn-timing.ts:96`）；唯一消费者 `permission-full-access.ts:28` 是真值判断——两者同 falsy，字节等价 |
| subagent runner.ts 拆分——不拆、登记 | spec 3 前置条件；不再增长 | **HOLDS** | `specs/subagent-runner-split-plan.md` 在位（6.8KB，「前置条件」3 项）；`runner.ts` 在 `ebe9033b` 与 HEAD 均为 **2599 行**（diff 空——零增长） |
| CommandInbox / owner-lease / stale-run | 上轮结论「良」，不变量存续 | **HOLDS** | `command-inbox.ts`、`workflow-run-command/`、`fleet/registry.ts` 自基线**未触碰**（diff 空）。SWF-08 owner gate 完整：`script-workflow-owner.ts:35` parentSession + `:39` workspaceIdentity + `:40` remoteSessionId fail-closed |

## 2. 新发现

### [P3] CliGovernor 是进程级单例，持有**首个 App** 的 `runtimeTaskRegistry`/`logger`，无 per-App 重置——跨 App 驱逐守护失效（主审亲验机制）

- `core/src/fleet/governor.ts:44-46` 模块级全局（`governorSingleton`/`evictionPort`/`configuredDeps`）；`getCliGovernor():89` 已有单例即早退；`:90` 把 `const deps = configuredDeps` **快照进闭包**（`:96` `peekFleetLruIdleVictim(deps)`）。
- `configureCliGovernor:54` **重新赋值** `configuredDeps = {...configuredDeps, ...deps}`（新对象）——第二个 App 的调用被已建成的单例静默丢弃，governor 永远持 **App#1** 的 `runtimeTaskRegistry`（App 作用域，`create-app.ts:969 new InMemoryRuntimeTaskRegistry()`）与 App#1 的 logger。
- 受害扫描迭代**进程级全局** `getFleetRegistry()`（所有 App 的会话，`registry.ts:234`），却用 App#1 的 registry 过滤「running」：`peekFleetLruIdleVictim → isFleetSessionRunning(record, runtimeTaskRegistry)`（`governor.ts:71`）。在 **App#2** 中活跃运行的会话不在 App#1 registry 里 → `get(agentId)` 返回 `undefined` → `archive.ts:35` 返回 `false` → 会话看似 idle → 成为 LRU 受害候选 → 内存压力下 governor 可能 `stopTask`（暂停）一个真在运行的会话。
- **主审亲验**：全仓仅有的 reset 是 `resetCliGovernorForTest`（测试专用，`governor.ts:138`）；`create-app.ts` 的 close 路径重置 4 个 sink 但**不含 governor/fleet-registry**（grep 确认 create-app.ts 只有 `configureCliGovernor` 调用，`:973`）。
- **与 CLI-04 同类（进程级单例），但在其修复范围之外。** 早于 1.0.4（`configureCliGovernor` 在 `ebe9033b` 已存在）——**非本轮回归**。影响可恢复（暂停非杀死，`SendToSession` 可唤醒）且需「内存压力 + 驱逐端口已接 + 多 App」三条件叠加，故 P3；**若生产确认多 App 桌面场景则升 P2**。
- **前提矛盾（需产品/工程裁决）**：`specs/gen-ui-visualize.md:70` 记载多 App 同进程为**真实**（2026-10-12 真机 Bug 6：「每会话一个 create-app，多 app 并存」），CLI-04 修复正是按该前提行动；但 `specs/subagent-policy-floor-inheritance.md:147` 断言多 app 同进程「**不存在**：一个进程一个 createACodeApp」。**两份 spec 互相矛盾**（主审亲验原文）。governor 隐患在 CLI-04 自己接受的前提下是活的——先裁决哪份 spec 是真源，再决定 governor 是否需要 per-App 化。

### [P3-邻近，较低关注] ambient usage ledger + network-capture 为进程级但按 App 绑定——by-design

- `setSharedAmbientUsageLedger`（`usage-ledger.ts:313`，`ambient-runtime.ts:95` 以 per-App ledger 调用）：后到 App 覆盖，但 ledger 按 `dataRootDir` 作用域（机器内一致）且注释明记「共享账本…单一写入点」——有意共享，良性。
- `installNetworkCaptureObservation`（`network-capture-observation.ts:125`）：进程级包裹 `globalThis.fetch`，单 sink/ring；fetch 无 per-call 会话身份（不同于审计 sink），注释明记「进程级事实」——接受的设计，非 sink 类串线。

运行时 diff 中**零新增超时掩盖**（`setTimeout`/`setInterval`/`sleep` 新增 grep = 0）——AGENTS.md 禁令被遵守。

## 3. 交付 profile 分离结论——**清晰且有测试（HOLDS）**

`continuous` vs `replayable` 完全分离且现为 schema 强制：

- 参数分叉（`shared/src/acode-protocol-v4/core.ts:34-57`）：flushWindowMs **30 vs 150**；streamPaths continuous 全开 vs replayable 仅 `text`（抑制 inputText/output.text/summaryText）；toolProgress **false vs true**；streamOutputCapBytes **262144 vs 0**；desktopOnlyRows **true vs false**。
- wire 级绑定：`helloMessageSchema` 强制 `clientMode↔deliveryProfile` 匹配，失配拒绝。
- `tests/delivery-profile-contrast.test.mjs`（7 个真行为测试）：断言参数分叉、过滤减法、两 profile 对权威 apply 的**终态逐字节相同**（`:154`）、upsert 前**中途态分叉**（`:177`）、负向互漏测试（`:216` desktop↔replayable 交叉绑定被拒）。断言与当前源码核对无漂移。

## 4. 层面健康度

**良**。上轮全部 CLI 运行时修复保持：CLI-04 两 sink 真会话化（幂等释放 + 双 App 测试）、resume reservation 同步于 await 前且唯一权威、时序 7 字段迁移机械干净（25/25 写入经冻结端口、零扁平写入、无 setter getter、`0→undefined` 语义保持）、CommandInbox/owner-lease/stale-run 未被触碰。代理 N 的 37 测是真行为 + 有界轮询 + 临时目录清理。一个新发现的**既有**潜在单例（CliGovernor 跨 App 驱逐守护）与 CLI-04 同类但在其修复范围外——可恢复、需三条件叠加、非 1.0.4 回归、不阻塞交付；值得后续工单 + 先裁决两份 spec 的多 App 前提矛盾。
