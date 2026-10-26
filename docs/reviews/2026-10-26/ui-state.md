# ACode 1.0.4 深度 Review · UI 状态层

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/ui/src/{store,hooks,lib}/**` + `useTheme.ts` + 平台边界（IPlatformService，组件不直调 `window.acode`）+ Zustand 广播同步防回环。视觉组件层见 [ui-components.md](ui-components.md)。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R2-06 [P2]** task meta 四副本 + 38-40 处组件直调 `applyTaskQueryCacheMutation` 绕过漏斗 | `writeTaskMetaToCaches` 单一事务；38→0 直调；守护测试 + spec | **HOLDS** | `lib/taskListMetaSync.ts:71-118`（一函数内 5 处写入，远端按 identity 门控 `:95`）；直调现仅剩 `taskListMetaSync.ts:112,220` + store 定义 `taskQueryCacheStore.ts:1088`；6 个 Workspace*.tsx 全经 `writeTaskMetaToCaches`（核验：`.tsx` 内 0 处真实调用 `applyTaskQueryCacheMutation`/`upsertOptimisticTaskListItem`/`removeTaskState`）。**主审亲验远端门控 `if (write.workspaceIdentity)`（taskListMetaSync.ts:95）** |
| R2-06 守护是真负向 | 源码扫描，offenders==[] | **HOLDS** | `tests/taskMetaCacheOwnership.guard.test.mjs:34-53`——允许清单 = store 定义 + lib；regex `/applyTaskQueryCacheMutation\s*\(/` 正确排除 import 行 |
| **R2-07 [P2]** `useTheme()` 死代码 theme 双写旁路 | 删 hook、留纯函数、移除 index 导出、写入点唯一 | **HOLDS** | `useTheme.ts:78-82`（hook 本体删除，仅留注释）；纯函数 `applyTheme:57`/`resolveTheme:12`/`normalizeThemePreference:20` 保留；`index.ts:30` = 仅 `export type { Theme }`；唯一 `acode-theme` 写者 = `store/index.ts:283`（`setTheme`）。**主审亲验 store/index.ts:280,283 是唯一 localStorage `acode-theme` 读写点** |
| R2-07 守护测试 | themeWriteOwnership.guard | **HOLDS** | `tests/themeWriteOwnership.guard.test.mjs:30-71`——断言写者 == 精确 `[store/index.ts]` + hook 不再导出；真负向 |
| SettingsPage console.warn [P3] | → logger.warn | **HOLDS** | `SettingsPage.tsx:908` `logger.warn`；ui/src 内唯一残留 `console.*` 是 `sidePaneTerminalSessionRegistry.ts:86`（有 `eslint-disable`，豁免） |
| 平台边界——组件不直调 `window.acode` | 上轮：最干净纪律 | **HOLDS** | ui/src 内 0 处真实 `window.acode.*` 调用；12 处命中全是注释/`window.acodeViz`（不同全局）/logger 类型桥；`hooks/usePlatform.tsx:22` 是唯一 `IPlatformService` 适配器 |
| 广播防回环（theme/locale） | 单闭包标志 + BROADCAST_FIELDS | **INTACT** | `store/index.ts:260` `applyingBroadcast`；订阅早退 `:468-470`；onMessage try/finally set/clear `:499-523`；`BROADCAST_FIELDS:237`；theme 广播 → `setTheme`（唯一写者）`:503-504` |

> 注：自基线以来 store/hooks/lib 内仅 `lib/taskListMetaSync.ts` 变更（`git diff --stat`），无新文件（`--name-status` 无 `^A`）。remote store 早于本窗口。层面基本冻结——好迹象。

## 2. 新发现

### [P3] pin 回滚遗留 query-cache `total` 计数漂移；新组合测试未演练真实组件的回滚路径（主审亲验源码）

- 真实组件的 `.catch` 回滚调 `writeTaskMetaToCaches({ previousState:{pinned:false}, nextState:{pinned:false} })`（`WorkspaceTimelineTasksSection.tsx:418-419`，**主审逐行读取确认**）——一个**非逆变**的成员态迁移。乐观阶段用的是 `previousState:{pinned:false} → nextState:{pinned}`（`:383-384`），故回滚本应 `{pinned}→{pinned:false}` 才是逆变，但组件写死 `{pinned:false}→{pinned:false}`。组合测试的回滚反而用 `{pinned:true}→{pinned:false}`（正确逆变，`taskMetaCacheComposition.test.mjs:130-131`）——**与真实组件路径不一致**。
- `applyTaskMutation` 追踪（`taskQueryCacheStore.ts:807-845`）：可见 `taskKeys` 列表**确实正确恢复**（timeline 经 `nextIncluded=true` 重加；pinned 经 `wasVisible` 移除），但 `nextTotal = total + Number(nextIncluded) - Number(previousIncluded)` 对组件的 `{pinned:false}→{pinned:false}` 回滚两个 descriptor 都 = `total + 0`。故一次失败的 pin 之后：**timeline total 停 −1、pinned total 停 +1**，直到下次服务端 `setQueryResult` 覆盖。仅影响 `hasMore`/「显示更多」计数；可见行正确；刷新自愈。
- 基线即如此（`git show ebe9033b` 同用 `{pinned:false}→{pinned:false}`），故「零行为漂移」的重构声称成立——这是**既有潜在 nit，非 1.0.4 引入**。R2-06 的真实声称（四**副本**保持一致）**HOLDS**；残留漂移更窄，在 query cache 的 `total` 计账内。
- **测试保真缺口**：组合测试从不断言 `total`/`taskKeys`（只断言远端 item-id 列表 `:120-121,135-140` 与 meta `.pinned` `:142`），且其回滚用了无真实组件会传的成员态参数。故它**无法捕获此漂移**并**高估了回滚覆盖**。建议：测试复制组件精确的 `{pinned:false}→{pinned:false}` 回滚并断言 query-cache `total`，或组件改用逆变迁移。

### [P3] 远端写入守护模式偏窄——存在旁路形态

- regex 只在 40 字符窗口内捕获 `useRemote(Timeline|Pinned)TaskStore.getState().upsertTask/removeTask(`（`taskMetaCacheOwnership.guard.test.mjs:71-72`）。会漏「先解构」（`const s = useRemoteTimelineTaskStore.getState(); s.upsertTask(...)`）或「selector hook」（`useRemoteTimelineTaskStore(s => s.upsertTask)`）写入。当前无此形态（唯一 `.tsx` `getState()` 是读 `refreshWorkspace` `WorkspaceTimelineTasksSection.tsx:277`），守护今天绿且正确——只是对有意重构不健壮。主守护（`applyTaskQueryCacheMutation`，test 1）无此缺口。

### [P3] `writeTaskMetaToCaches` upsert 以 `nextTask.workspaceIdentity` 为键，remove 以显式 `write.workspaceIdentity` 为键（低价值 HYPOTHESIS）

- `remoteTimeline.upsertTask(write.nextTask, sortBy)` 从 **task 对象的** `workspaceIdentity` 派生键（`remoteTimelineTaskStore.ts:125`），而 `removeTask(write.workspacePath, write.taskId, write.workspaceIdentity)` 用**参数**。若调用方传入 `nextTask.workspaceIdentity` ≠ `write.workspaceIdentity`，upsert 与 remove 会指向不同键。当前所有调用方保持二者相等（`item.workspaceIdentity` 同时流入两处），故无活体 bug——一个隐式耦合，值得加注释。

## 3. 守护测试有效性

所有权守护对其主不变量是**真负向**：

- `taskMetaCacheOwnership` test 1（`applyTaskQueryCacheMutation` 调用点允许清单）——任何新组件直调会红。扎实。
- `themeWriteOwnership` test 1（唯一 `acode-theme` 写者）+ test 2（`useTheme` 不导出 + 纯函数保留）——任何新 theme 写入点或 hook 重引入会红。扎实；regex 覆盖字面键与 `STORAGE_KEY` 常量两种写入形态。
- `taskMetaCacheOwnership` test 2（remote-store 写入）——真实但偏窄（见上 P3）。
- `taskMetaCacheComposition`——真实的四副本一致性 + 门控测试，但其回滚用例不是组件的真实路径，且从不断言 query-cache `total`（见上 P3）。它证明了**漏斗原子写入所有副本**（R2-06 的核心声称），但对回滚-total 正确性给出假信心。

## 4. 层面健康度

**优**。R2-06 与 R2-07 均经独立源码核验 **HOLDS**；平台边界（0 处真实 `window.acode`）与广播防回环完整；所有权守护是真负向测试。唯一发现是三个 P3，全部既有/潜在（pin 回滚的 query-cache total 漂移从基线幸存、且被一个不复制真实路径的组合测试漏掉；两个窄守护/耦合 nit）。无 P1/P2、无回归、无绕过漏斗的新写入路径。
