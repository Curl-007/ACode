# 未读状态单一事实源：迁移终点与分步验收

状态：迁移终点已定义（2026-10-05，深度审查 P1「UI 未读双 store 迁移期投影要有迁移终点」落地件）。
S1-S3 为登记的实施步骤，各带验收标准；S3 属交互变更，须按 AGENTS.md 补 E2E 或附人工验证记录后实施。

## 现状（2026-10-05 实证）

「任务未读」这一个事实目前存在三处：

| 存储 | 位置 | 角色 |
| --- | --- | --- |
| `meta.unreadAt` | session store `taskListCache`/`optimisticTaskListByTaskId` + 后端持久化 | 持久事实 |
| unread overlay | `store/taskQueryCacheStore.ts` 的 `taskUnreadOverlayByEntityKey`（entity key 精确寻址） | V4 侧栏的乐观层；侧栏 TaskListItem 已只消费 query row 的 `unreadAt` |
| `taskUnreadByTaskId` | `store/acodeSessionStoreTypes.ts:180`（legacy map） | 迁移期投影：Dock badge fallback + 未读谓词 OR 分支 |

**写入方**：`lib/taskStatusUnreadSync.ts`（后台终态事件：overlay + legacy 双写，失败回滚 `rollbackTaskQueryCacheUnread`）；`WorkspaceTimelineTasksSection.tsx:474/866`、`WorkspacePinnedTasksSection.tsx` 等组件（`service.setTaskUnread` 持久化后再写 legacy indicator）；store slices（task 迁移/删除时的 copy/rest 维护）。

**读取方**：`store/acodeSessionStoreSelectors.ts:266-270` 未读谓词（meta 优先，OR legacy map，注释记录了重启水合顺序的回退理由）；`lib/unreadTaskCount.ts` Dock badge 计数（meta 驱动，仅当 workspace `visibleTasks` 为空时回退 legacy map——覆盖「后台窗口收到终态事件但列表未加载」与 remote path/identity 双 key 兼容态）。

## 目标（迁移终点）

未读事实唯一所有者 = 持久化 `meta.unreadAt`，`taskQueryCacheStore` overlay 作为唯一乐观层；Dock badge 与侧栏蓝点读同一份数据；`taskUnreadByTaskId` 从类型、初始状态、slices、组件与谓词中整体删除。

## 分步迁移（先建桥、再拆梯）

### S1 — Dock badge 桥接 query cache overlay

`countAllUnreadTasks` 增加 overlay 读取分支（按 entity key 去重），使「visibleTasks 为空 + overlay 有未读」的场景不再依赖 legacy map。
验收：`unreadTaskCount` 单测覆盖 overlay-only、meta-only、双 key 去重三场景；行为只增不减（legacy fallback 暂留）。

### S2 — 组件 mark-read 停写 legacy indicator

组件路径改为：持久化 `service.setTaskUnread` + overlay 乐观写/清除；`setTaskUnreadIndicator` 写入方收敛到 `taskStatusUnreadSync` 一处。
验收：grep `setTaskUnreadIndicator` 组件层归零；ui 测试全绿；手工核对本地与 remote workspace 的蓝点即时清除。

### S3 — 删除 legacy map（交互变更，需 E2E）

删除 `taskUnreadByTaskId` 字段、谓词 OR 分支、Dock fallback、slices 维护逻辑。
验收：`git grep taskUnreadByTaskId -- packages/ui/src` 归零；ui 测试全绿；三个场景的手工/E2E 验证记录——desktop 本地未读蓝点与 Dock badge、手机远控（web-remote-replayable）未读恢复、重启后水合顺序（query cache 先于 session store）。
约束：当前仓库无 UI E2E 设施，S3 不得在无验证记录时合入（AGENTS.md「交互改动需要 E2E 场景」）。

## 风险登记

- remote workspace 同时保留 path key 与 workspaceIdentity key 兼容状态，S1 的 overlay 桥接必须按 entity key 去重，否则窗口角标重复计数（`unreadTaskCount.ts` 现有注释即为该事故类的既有防线）。
- 重启水合顺序（列表先从 query cache 恢复、session store 后水合）是谓词 legacy 分支的存在理由之一；S3 删除前必须确认 overlay 在该窗口期同样可读。
- 本 spec 落地前，任何新代码不得再新增 `taskUnreadByTaskId` 的读取方（写入方维持现状直至 S2/S3）。
