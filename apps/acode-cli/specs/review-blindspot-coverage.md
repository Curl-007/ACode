# 高风险覆盖盲区补测（review 2026-10-22 §7）

本 spec 只登记**测试覆盖**，不改任何 src 行为。对应 `docs/reviews/2026-10-22/testing.md` §7
点名的五个高风险盲区，各自落一个专门测试文件（均在 `apps/acode-cli/tests/`）。每条断言都是
真负向：改坏对应实现会红（验证方式见下）。

## 状态所有者与接口（被测的既有事实源，不改）

| 盲区 | 权威实现 | 测试文件 |
| --- | --- | --- |
| 1. 取消/中止 | `node-execution-adapter-{run,lifecycle}.ts`、`workflow-world-read.ts:340-347`、`workflow-driver.ts:461`、`engine-world.ts:120-121` | `runtime-abort-concurrency.test.mjs` |
| 2. 水合 | `read-file-state-hydrator.ts`、`session-history-hydrator.ts:activeSessionMessages`、`compact-session.ts` | `resume-hydration-read-state.test.mjs` |
| 3. 远程 identity | `task-realtime-core.ts:resolveWorkspaceKey`、`acode-protocol-v4/controller.ts` | `workspace-identity-routing.test.mjs` |
| 4. 两链路对照 | `acode-protocol-v4/core.ts:DELIVERY_PROFILES`、`profiles.ts`、`transport.ts:helloMessageSchema` | `delivery-profile-contrast.test.mjs` |
| 5. 快照/重放对账 | `acode-protocol-v4/controller.ts:isWindowHostControllerFrameGap`、`coalesce.ts`、`task-realtime-core.ts` mirror batch | `snapshot-gap-repair.test.mjs` |

## 验收场景

### 盲区 1：abort
- world.run 把 `deps.signal` 原样透传给 `ExecutionPort.run`（缺席时为 undefined，不伪造）。
- 运行中 run 被取消：真实子进程被终止，结算 `status="cancelled"`。
- 派发前已 aborted 的 signal：短路 `cancelled before spawn`，不 spawn 子进程。
- 后台任务取消幂等：已 terminal 再 cancel 不改写终态；`waitForBackgroundTask` 可被等待者 signal 中止且取消后收敛到终态。

### 盲区 2：hydrate
- preserved tail 内真实 Read 跨 resume 水合后，真实 Edit 不误报 FILE_NOT_READ（daf32bee 防回归）。
- preserved head 之前被修剪的读取不水合，真实 Edit 如实报 FILE_NOT_READ。
- 真实 range Read 按 metadata 窗口 key（offset/limit）恢复，不退回未读、不伪造全量 key。
- partial-view metadata 水合后 `isPartialView` 保持，真实 Edit 报「截断视图」文案而非未读。
- 水合恢复的 freshness metadata 驱动 stale 守卫：外部改动后真实 Edit 报 STALE_FILE。

### 盲区 3：identity
- `resolveWorkspaceKey = workspaceIdentity?.trim() || workspacePath`（trim / 空串 / 缺席 / 大小写敏感）。
- 同路径不同 identity 不串线；同 identity 不同路径归并。
- wire schema 强制 `workspaceKey === resolveWorkspaceKey`：仅按路径匹配（带 identity 却填 path）被拒。
- `remoteSessionId` 在场却缺 `workspaceIdentity` 一律拒绝（远程地址 / workspace fact / owner command / task row address↔meta 一致）。

### 盲区 4：delivery profile 对照
- 两 profile 参数表分叉：flush 30/150ms、streamPaths、toolProgress false/true、streamOutputCapBytes 262144/0、desktopOnlyRows。
- filter：continuous 保留全部流式路径，replayable 抑制 inputText/output.text（纯减法），结构事件恒透传、不改入参。
- 收口不变量：同一事实流经两 profile 投影后终态 byte-identical，且与权威 apply 一致；中间态确实分叉。
- `helloMessageSchema` 强制 clientMode↔deliveryProfile 绑定，错配被拒（一个 profile 语义不泄漏到另一个）。

### 盲区 5：snapshot / reconcile
- `isWindowHostControllerFrameGap`：序号空洞 / seq 回退 / logEpoch 变 / subscriptionId 变都判 gap，衔接帧不误判。
- coalesce 幂等 + 语义保持（合并与逐条投递终态一致）；`conflateByKey` 按 key 只留最后一次、按末次出现下标保序。
- `stream_mirror_gap` 是合法 invalidation reason；invalidation 事件 workspaceKey 必须符 fallback。
- 快照帧强制 fromSeq=0 且 frame.logEpoch===snapshot.logEpoch；delta 帧 toSeq<fromSeq 被拒。
- mirror batch：runId===traceId（贯穿 identity），ops.seq / fromSeq 必须为正整数（区别于快照帧 fromSeq=0）。

## 负向有效性验证

对四个实现文件各做一处定向破坏，确认对应测试变红后还原（`git diff --stat` 归零）：

| 破坏 | 变红的测试 |
| --- | --- |
| `read-file-state-hydrator.ts` `includeCompactPreservedSegment: true→false` | hydrate(1)、hydrate(2) |
| `task-realtime-core.ts` `resolveWorkspaceKey` 改成 path-only | identity(1)(2)(3)(4)(5c) |
| `profiles.ts` continuous filter 改成只放行 text | profile(2)、profile(3b) |
| `controller.ts` `isWindowHostControllerFrameGap` 去掉 seq 检查 | gap(1) |
| `workflow-world-read.ts:347` worldRun 的 signal 传 undefined | abort(1) |

## 边界（本批不做）

- 不改任何 `src/`；测试暴露的真实缺陷只登记，不顺手修。
- 真实子进程的取消依赖 Windows 强杀宽限窗（`CANCEL_WAVE_GRACE_MS_WINDOWS=5000`），
  abort(2)/(4b) 各含一次真实 kill，属确定性等待非墙钟定时；无固定 sleep，等待用 `waitUntil` 有界轮询。
- mirror batch 的 `ops` 内部 seq 与 `fromSeq/toSeq` 的连续性、跨批次去重是**宿主消费侧**职责
  （relay/Main 只转发不保存业务状态），shared 层只保证 wire schema 与序号正整数，故此处只钉 schema 面。
