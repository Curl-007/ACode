# task meta 缓存所有权与单一写入路径

状态：已实现（R2-06）。守护测试：`packages/ui/tests/taskMetaCacheOwnership.guard.test.mjs`
（组件源码白名单）+ `packages/ui/tests/taskMetaCacheComposition.test.mjs`（真实 store 组合）。

## 背景与问题

同一份 task meta（标题、pinned/archived 成员关系、updatedAt 等）在 UI 状态层存在多份副本，
彼此没有单一所有者，写入路径散落在组件里：

- `applyTaskQueryCacheMutation(` 曾在 6 个组件中出现 40 次，
  并在同一 handler 内与 `upsertOptimisticTaskListItem` / `removeTaskState` /
  `useRemoteTimelineTaskStore.upsertTask` / `useRemotePinnedTaskStore.upsertTask` 内联拼装，
  单次用户操作触发 3-4 条独立 store 写入。
- 乐观失败回滚路径需要手写镜像反向写入，极易漏写某一副本造成 drift。

本 spec 定义各副本的所有者与派生关系、rename/pin/archive/unread 的单一写入路径，以及乐观回滚口径。

## 副本清单与所有者

| 副本 | 位置 | 角色 | 唯一写入路径 |
|---|---|---|---|
| query cache meta | `taskQueryCacheStore.taskMetaByEntityKey` | 列表成员关系 + total 的**唯一权威** | `applyTaskQueryCacheMutation`（仅 `taskListMetaSync` 内部调用） |
| optimistic 池 | `acodeSessionStore.optimisticTaskListByTaskId` | 首发/未提交 meta 的乐观覆盖，Header/当前会话优先读 | `upsertOptimisticTaskListItem` / `removeOptimisticTaskListItem`（仅 `taskListMetaSync` 内部调用） |
| remote timeline | `remoteTimelineTaskStore.itemsByWorkspaceKey` | 远端 workspace 的 timeline 列表补充链路 | `remoteTimelineTaskStore`（仅 `taskListMetaSync` 内部调用其 `upsertTask`/`removeTask`） |
| remote pinned | `remotePinnedTaskStore.itemsByWorkspaceKey` | 远端 workspace 的 pinned 列表补充链路 | `remotePinnedTaskStore`（仅 `taskListMetaSync` 内部调用其 `upsertTask`/`removeTask`） |
| workspace taskListCache | `acodeSessionStore.taskListCache` | 本地 workspace 首屏快照缓存（服务端事件派生 reader） | `syncTaskMetaToTaskCaches` / `removeTaskFromTaskCaches` |

**taskListCache 与 taskQueryCacheStore 的边界（收敛计划）**：两者当前并存，不是同一事实的两份权威——
`taskListCache` 是服务端 workspace 事件（session/readSession 快照）驱动的**首屏列表快照**，
`taskQueryCacheStore` 是查询结果 + 增量成员关系的**权威缓存**，用户交互（rename/pin/archive/unread）
只经后者迁移成员关系。二者通过 `syncTaskMetaToTaskCaches` 的单调合并（`mergeTaskMetaCandidates`）对齐，
不存在双权威。用户交互写入路径**不触碰** `taskListCache`（它由 `syncTaskMetaToTaskCaches` 在快照同步时派生更新）。
彻底退役 `taskListCache`（合并进 query cache 单一所有者）风险过大且涉及首屏恢复时序，本轮不做硬删；
写入统一经事务函数即达成「消除多路径写入」的主要目标。后续若首屏快照也能由 query cache 派生，再整体退役。

## 单一写入路径：`writeTaskMetaToCaches`

`packages/ui/src/lib/taskListMetaSync.ts` 导出 `writeTaskMetaToCaches(write)`，是
**用户交互（rename/pin/archive/unread）对 task meta 四副本的唯一写入事务**。组件不得再直接调用
`applyTaskQueryCacheMutation`，也不得自己拼 optimistic/remote 多 store 写入。

事务字段：
- `workspacePath` / `workspaceIdentity` / `taskId`：身份定位（remote 副本按 `workspaceIdentity` gating）。
- `previousTask` / `nextTask`：迁移前后 meta；所有 upsert 副本统一写入 `nextTask`。
- `previousState` / `nextState`：`{ pinned, archived }` 成员关系，驱动 query cache 迁移与 total。
- `optimistic`：`"upsert"` | `"remove"` | `"none"`（默认）——optimistic 池放置。
- `clearTaskState`：`true` 时清 task 运行态（`removeTaskState`，含持久化草稿）；归档/删除终态使用。
- `remoteTimeline` / `remotePinned`：`"upsert"` | `"remove"` | `"none"`（默认）——远端副本放置；
  `remoteTimelineSortBy` 透传 timeline 排序键。

**固定写入顺序**（与各组件历史内联顺序一致，保证零行为漂移）：
1. optimistic 池（本地）→ 2. clearTaskState（本地）→ 3. remoteTimeline（远端）
→ 4. remotePinned（远端）→ 5. `applyTaskQueryCacheMutation`（query cache，收尾）。

remote 副本写入统一按 `workspaceIdentity` gating：本地 workspace 没有远端缓存副本，身份缺失时跳过，
避免把本地 task 误写进以 identity 为键的远端 store。query cache 迁移始终最后执行，是成员关系与 total 的收口点。

**为什么 remote 放置保持显式、不从 state 派生**：`remoteTimelineTaskStore.removeTask` 会递减 `total`，
若按 `nextState` 自动派生「pinned ⇒ 移出 timeline」会在 unpin/rollback 阶段错误增减 total。
各组件对 timeline/pinned 的放置意图（尤其 pin 三阶段的乐观/提交/回滚差异）本就不同，
显式声明 placement 是最忠实的 1:1 收敛，避免行为漂移。

### 身份键不变量：`nextTask.workspaceIdentity` 必须等于 `write.workspaceIdentity`

remote 两个副本的写入键来源不对称，调用方必须保证它们指向同一个键：

- `upsertTask(write.nextTask, sortBy)` 的 workspaceKey **从 task 对象派生**
  （`store/remoteTimelineTaskStore.ts` / `store/remotePinnedTaskStore.ts` 内
  `getWorkspaceKey(task.workspacePath, task.workspaceIdentity)`）；
- `removeTask(write.workspacePath, write.taskId, write.workspaceIdentity)` 的 workspaceKey
  **从显式参数派生**。

若调用方传入的 `nextTask.workspaceIdentity` ≠ `write.workspaceIdentity`（或 `workspacePath` 不一致），
同一次事务里的 upsert 与 remove 会落到**不同的** workspaceKey，副本之间静默 drift，
而 `workspaceIdentity` gating（`if (write.workspaceIdentity)`）也无法察觉。

**不变量**：调用 `writeTaskMetaToCaches` 时必须满足
`write.nextTask.workspacePath === write.workspacePath` 且
`write.nextTask.workspaceIdentity === write.workspaceIdentity`
（两者同时 `undefined` 也算相等）。当前所有组件调用方都从同一个 `item`/`meta`
同时流入两处，天然满足；该不变量由 `taskMetaCacheComposition` 的守护用例钉住
（mismatched 对不被静默接受），不在生产路径加运行时 throw。

## 乐观失败回滚口径

pin 是三阶段操作（乐观 → 提交 → 回滚），每阶段都是一次独立的 `writeTaskMetaToCaches` 调用：

- **乐观阶段**：`previousState` = 迁移前，`nextState` = 目标态；remote 副本按目标态互斥放置
  （pin ⇒ timeline `remove` + pinned `upsert`；unpin 反之）。失败可回滚。
- **提交阶段**（RPC 成功）：`optimistic: "remove"` 清乐观覆盖，remote 副本按已确认态放置，
  `previousState`/`nextState` 同为已确认态（不再改成员关系，只落权威 meta）。
- **回滚阶段**（RPC 失败）：remote 副本恢复到迁移前的相反放置，`nextState` 回到迁移前态，
  query cache total 相应回退。**回滚必须与乐观阶段的 remote placement 精确互逆**，否则副本 drift。

### 回滚必须是乐观写入的精确逆变换（含 total 计数口径）

回滚阶段传给 `writeTaskMetaToCaches` 的成员关系参数**必须**是乐观阶段那对参数的镜像交换：

```
乐观阶段：previousState = P（迁移前态）      nextState = N（目标态）
回滚阶段：previousState = N（乐观的 next）   nextState = P（乐观的 previous）
```

即 `rollback.previousState === optimistic.nextState` 且 `rollback.nextState === optimistic.previousState`。
remote placement 同样按相反方向放置（乐观 `timeline:"remove" + pinned:"upsert"` ⇒ 回滚
`timeline:"upsert" + pinned:"remove"`）。

**为什么不能写「同一态 → 同一态」**：`taskQueryCacheStore.applyTaskMutation`
（`store/taskQueryCacheStore.ts`）对每个查询 descriptor 计算

```
nextTotal = max(0, total + Number(nextIncluded) - Number(previousIncluded))
```

其中 `nextIncluded` / `previousIncluded` 由 `matchesTaskDescriptor(descriptor, task, membership)`
决定（`membership` 分别是 `nextState` / `previousState`）。若回滚传 `{pinned:false}→{pinned:false}`
这种**非逆变**的参数，两个 descriptor（timeline 与 pinned）都会得到
`previousIncluded === nextIncluded`，delta 恒为 0，于是乐观阶段已经改动的 `total` **不会被回退**：
一次失败的 pin 之后 timeline total 停在 −1、pinned total 停在 +1，直到下次服务端
`setQueryResult` 覆盖该查询。可见行（`taskKeys`）本身能靠 `wasVisible` 分支正确恢复，
所以缺陷只体现在 `total` / `hasMore` 计数上（「显示更多」是否出现的判定），
不会表现为列表内容错乱，也因此极易被测试漏掉。

`total` 是 query cache 的权威计数口径（见「副本清单与所有者」），任何**非零**成员关系迁移
都必须在回滚阶段被等量撤销；恒零 delta 的回滚等于没有回滚 total。

rename/unread 是单阶段提交（RPC 成功后一次 `optimistic: "upsert"` + query cache 迁移，无独立回滚）；
archive 是终态（`clearTaskState: true` + remote 双副本 `remove` + query cache `archived: true`），
没有乐观预写因此也没有回滚路径。

**验收**：rename/pin/archive 后四副本一致；乐观失败回滚后不残留 drift，
**且 timeline / pinned 两个 descriptor 的 query cache `total` 与乐观写入前逐一相等**
（见 composition 测试——该测试必须复用真实组件回滚阶段的参数形状，
不得用组件从不传的 `previousState`/`nextState` 组合来「证明」回滚正确）。

## 守护

- **白名单守护**（`taskMetaCacheOwnership.guard.test.mjs`）：扫描组件源码，断言
  `applyTaskQueryCacheMutation` 的直调点仅存在于 `taskListMetaSync.ts`（唯一收口 lib），
  组件（`Workspace*.tsx` 等）零直调。新增绕过收口的组件写入即红。
- **remote 副本写入守护**（同一文件 test 2）：`.tsx` 组件内**任何**对
  `useRemoteTimelineTaskStore` / `useRemotePinnedTaskStore` 的引用都必须落在两类允许形态里：
  1. 只读订阅——`useRemoteXTaskStore((state) => state.xxx)` selector 形式；
  2. 显式登记的只读命令——目前只有 `WorkspaceTimelineTasksSection.tsx` 的
     `getState().refreshWorkspace(...)`（拉取远端列表，不写 task meta 副本），带注释登记在
     `REMOTE_STORE_READ_ONLY_COMMANDS` 白名单里。
  该守护**按引用扫描而不是按调用形态的正则**，因此「先解构再写」
  （`const s = useRemoteTimelineTaskStore.getState(); s.upsertTask(...)`）与
  「selector 取写方法」（`useRemoteTimelineTaskStore((s) => s.upsertTask)`）等
  绕过形态同样会红，而不只是 `getState().upsertTask(` 这一种字面写法。
  收口 lib（`taskListMetaSync.ts`）与两个 remote store 自身除外。
- **组合守护**（`taskMetaCacheComposition.test.mjs`）：真实 store 上跑 rename/pin(乐观+回滚)/archive，
  断言 optimistic 池、remote timeline、remote pinned、query cache meta 四副本一致，回滚后无 drift；
  pin 回滚用例复用**真实组件回滚阶段的参数形状**（乐观 nextState → 乐观 previousState 的精确逆变换），
  并断言 timeline / pinned 两个 descriptor 的 query cache `total` 在乐观写入后按预期 ±1、
  回滚后逐一还原（这是能捕获「非逆变回滚导致 total 漂移」的断言）。
  另钉住身份键不变量：`nextTask.workspaceIdentity` ≠ `write.workspaceIdentity` 时
  upsert 与 remove 会落到不同 workspaceKey，不被当作等价写法静默接受。
