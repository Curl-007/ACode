# Workflow Session Owner Lease：生命周期（心跳续租 + 惰性回收）

状态：已实施（2026-10-12，dev/0.0.8）。

## 背景

`workflow_session_owner` 表（migration 0029）是 Dynamic/Script Workflow 共享的跨进程
owner lease：`claimWorkflowSessionOwner` 在单个 SQLite 事务里 claim/renew——外部 token
只在 `lease_expires_at` 已过期时才能夺走（generation 递增），同 token 重入即续租
（generation 不变）。写闸门（`dwf-journal.updateRunStatus`、`script-workflow-runs` 的
更新路径）经 `isWorkflowSessionOwner` 要求「token+generation 匹配且租约未过期」。

接线侧（bootstrap/app/workflow-wiring.ts）此前是**一次性 claim**：app 构造时铸一个
随机 `ownerToken`，claim 一次，结果缓存在 `workflowOwnerReady` promise 里；两个消费端
（run service 的 `ensureWorkflowOwner`、script runtime 的 `run()`）看到 `null` 就直接抛
`Workflow session owner lease is held by another process`。没有任何续租与重试路径。

## 缺陷与现场证据（2026-10-11/12 实机战役，~/.acode/cli/db/db.sqlite）

**D1：无续租心跳——活 owner 的租约 30s 后过期，它自己的 gated 写入被拒。**
`dwfrun-ba4e6ad0`（parent `sess_f9bd56c6`，owner gen 6）创建于该进程 claim 之后约
14 分钟：`createRun` 不带闸门所以行落了库，随后每一次 `updateRunStatus` 都被
`Stale workflow owner write rejected` 拒掉——行永远冻结在 `status='running'`、
`time_updated == time_created`。`appendEvent` 不带闸门，所以事件流看起来正常，
状态权威却在说谎。对照样本 `dwfrun-ae81dcc5`：它的 `cancelled` 结算之所以写成，
是因为新进程恰好先完成了 gen-6 claim（lease 新鲜），47ms 后孤儿收敛带
`ownerTakeover` 写入才过闸。

**D2：一次性 claim——失败即进程级永久锁死。**
claim 返回 `null`（启动落在他人 30s 活跃租约窗口内，典型场景：快速 kill/restart
循环，上一个进程刚 wiring 完就被杀）或 `.catch` 到瞬时错误（重启竞态下的
SQLITE_BUSY）时，`workflowOwnerReady` 把 `null` 缓存到进程死亡为止。战役观测：
干净重启后 CreateWorkflow 仍连续被拒——新 agent 进程恰好在旧租约窗口内启动，
之后租约虽过期，进程却永不重试。owner 行 gen 停在 6、后续重启没有留下任何
claim 痕迹，与「claim 失败 → 缓存 null → 不再尝试」一致。

两个缺陷同根：**租约的「时间语义」只有原语层实现，接线层把它当成了一次性的
进程身份**。

## 产品规则

- **R1 唯一写者 = 会话宿主进程，进程在世即所有权在世。** 持有期间以
  `max(1s, leaseMs/3)`（缺省 10s）的间隔同 token 续租（claim/renew 同一事务原语，
  generation 不变）。心跳 interval 必须 `unref()`——不得延长进程寿命。
- **R2 死进程的租约 ≤ leaseMs 自然过期，过期即可被夺**（原语语义，不改）。
  进程被杀（含 taskkill /F）不需要任何清理动作。
- **R3 claim 失败不是无期徒刑。** 消费端（`ensureWorkflowOwner`、script runtime
  `run()`）看到 `null` 时先经 `reclaim()` 惰性重试一次：此刻旧租约若已过期即当场
  取得所有权；仍被活跃外部 owner 持有才抛既有错误。reclaim 并发去重（同一
  in-flight promise）。
- **R4 被接管后原 owner 必须停写。** 心跳续租收到 `null`（外部活跃 token 夺走）
  即停表并把自身置为非 owner（后续 reclaim 会再试）；generation 不匹配的写入由
  既有写闸门拒绝——闸门不改。
- **R5 惰性孤儿收敛（两侧）。** 构造时 claim 失败 ⇒ 构造期收敛被跳过；首次 reclaim
  成功后补跑一次（dwf 侧 `reconcileOrphanRuns` 在 run service 的 ensure 路径；script
  侧 `reconcileOrphanScriptWorkflowRuns` 在 bridge 包装的 reclaim 里）。安全论证与
  构造期收敛相同：本进程此前从未持有所有权 ⇒ 名下零在飞 run ⇒ journal/行表里的
  非终态记录只可能是死进程遗物。两侧补跑各至多一次（flag 防重）。
- **R6 store 无能力面（legacy in-memory host）时一切语义不变**：ready/reclaim 均
  `undefined`，无心跳，消费端走既有「无 owner facts」路径。

## 接口

**新增 `packages/cli-workflow/src/workflow-owner-lease.ts`**（单一所有者：claim/
renew/心跳/重试只在这一个模块里发生；经 `"./contract"` 公开面导出——引擎族文件住
cli-workflow 是 W1-R3 边界，bootstrap 只保留装配接缝）：

```ts
export interface WorkflowOwnerLeaseFacts { ownerGeneration: number; ownerToken: string }
export function createWorkflowOwnerLeaseManager(deps: {
  claim?: (input: { leaseMs?: number; ownerToken: string; parentSessionId: string }) =>
    Promise<{ leaseExpiresAt: number; ownerGeneration: number; ownerToken: string } | null>;
  leaseMs?: number;          // 缺省 30_000，与原语缺省一致
  logger?: { warn(message: string, meta: object): void };
  ownerToken: string;
  parentSessionId: string;
  renewIntervalMs?: number;  // 缺省 max(1_000, floor(leaseMs / 3))
}): {
  ownerReady: Promise<WorkflowOwnerLeaseFacts | null | undefined>;
  reclaim(): Promise<WorkflowOwnerLeaseFacts | null | undefined>;
  dispose(): void;           // 停心跳（测试/拆卸用；生产不调——interval 已 unref）
};
```

**消费端**（均为可选 dep，缺席时行为与今天逐字节一致）：

- `DynamicWorkflowRunServiceDeps.workflowOwnerReclaim?: () => Promise<facts|null|undefined>`
  ——`ensureWorkflowOwner` 在 `null` 时先 reclaim；成功后按需补 R5 收敛。
- `ScriptWorkflowRuntimeDeps.ownerReclaim?`——`run()` 的 owner 门同上。
- bridge（script-workflow-methods）：`ownerReclaim` 透传给 runtime；bridge 自己的
  fallback claim（`deps.ownerReady` 缺席的宿主）也改走 manager，杜绝第二份租约逻辑。
- wiring：manager 的 `ownerReady`/`reclaim` 分别接进 run service 与 bridge。

## 验收场景（tests/workflow-owner-lease-manager.test.mjs，真 sqlite store）

**live 实机证据（2026-10-12，dev 桌面 + 重打 acode.cjs）**：新会话 owner 行在运行期
留下 22 个不同 `time_updated`、严格 10s 步进（心跳实证，R1）；CreateWorkflow → hole →
FillWorkflowHole → Amend → completed 全链路零 lease 拒绝（对照：修复前同环境连续
「held by another process」）；claim 后 134s 与 8 分钟的 gated 写入（superseded 结算、
fill 的前驱 cancelled/后继 completed）全部过闸——修复前这些写入必被
`Stale workflow owner write rejected` 拒绝（D1 直接反证）；三个死会话的 owner 行
纹丝不动（R2 自然过期语义不变）。

1. 心跳延寿：manager 持有（小 leaseMs），租约名义过期后外部 claim 仍 `null`；
   `dispose()` 后到期外部 claim 成功且 generation 递增。
2. 惰性回收：外部活跃租约下 manager 初始 claim → `ownerReady` 为 `null`；外部租约
   过期后 `reclaim()` → facts（generation 递增），且心跳随即武装（外部再 claim 被拒）。
3. 被接管：manager 持有 → dispose 停表 → 外部夺走 → manager `reclaim()` 返回 `null`
   （活跃外部 owner），不返回旧 facts。
4. 无能力面：`claim` 缺席 → ready/reclaim 均 `undefined`，不起心跳。
5. 接线断言（source-text，swarm-test 模式）：wiring/run-service/script-runtime/bridge
   的 reclaim 路径与 R5 补收敛 flag 在场。

## 未做与取舍

- **pid 存活探测**：时间语义（R2）已经覆盖死 owner；pid 复用与跨平台探测的复杂度
  买不到额外正确性。
- **退出时 release 台账**：taskkill /F 不保证 exit hook 运行；R3 的惰性重试已把
  30s 窗口从「永久锁死」降为「至多重试一次工具调用」。
- **reclaim 内等待循环**：真·双活宿主（同会话双 attach）下等待会把可见错误变成
  30s 悬挂；工具报错可由模型/用户数秒后重试自愈，悬挂更糟。
- **写闸门改动**：单写者防护维持原样；D1 由心跳根治而不是放宽闸门。
