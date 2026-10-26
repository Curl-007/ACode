# 长对话目录索引与窗口外跳转（U07）

## 背景

长会话的「问题目录」过去只反映 renderer 已加载的正文：rail 由 `renderUnits` 派生，
挂载后经 `loadAllOlder()` 沿 `rowsRange` 游标逐页读完整条分支才凑齐目录。这与
[renderer 内存预算](./renderer-memory-budget.md) 规则 3（投影窗口有界）方向相反——
为了目录把历史正文搬进 renderer。

事实上目录不需要正文。`ConversationTurnIndex` 已经在行**进入窗口时**登记轻量元数据
（`rowId`/`kind`/`origin`/`createdAt`/摘要，≤8000 项），被双上限裁掉的行仍保留目录依据。
本 spec 规定目录改由该索引供给，窗口外定位改由**一次定向 `rowsRange`** 完成。

非目标（与提案 §2.1 一致）：不建全文搜索；不承诺尚未索引的远古输入可立即定位；
不扩大 renderer 预算；不在打开目录时扫描正文；不实现服务端分页目录（若产品要求
完整历史目录，另立 v4 分页目录能力，追加 4–6 人日）。

## 产品规则

1. **目录只读索引**：目录条目、覆盖范围与「已淘汰」提示全部来自 `ConversationTurnIndex`
   的内存条目，**打开目录不产生任何 `rowsRange` 请求**，不扫描正文，不读 `renderUnits`。
2. **定向单页定位**：一次索引内跳转只发一个 `rowsRange` 请求，`beforeRowId = 目标 rowId + 1`，
   `limit ≤ rowsRangeMaxLimit(200)`。服务端 `getRowsRange` 以 `eligible.slice(-limit)` 收口，
   因此目标行必为返回页的**最后一行**——不需要「先找页再在页内找行」。
3. **超范围必须显式动作**：单次跳转累计 ≤3 个正文请求。更早内容只能由用户点击「继续加载更早」
   逐页推进（每页一个请求），到第 3 个请求为止；之后给出确定的「已到本次定位范围上限」状态。
   **绝不后台遍历全部历史**。
4. **尾部持续存活**：浏览历史期间权威尾部窗口继续接收订阅增量（运行状态、流式文本、队列）；
   历史焦点不吞掉任何权威更新。
5. **返回最新**：`returnToLive()` 释放派生焦点正文、作废在途定位请求、恢复尾部滚动意图。
   回滚到原目录入口时只关闭聚焦能力，**不得**以「恢复全量正文加载」作为回滚方案。
6. **淘汰可识别**：索引条目超过 8000 后 FIFO 丢最旧。目录必须显示「更早 N 条输入未纳入目录」
   （`evictionCount > 0` 即 `isPartial = true`），只承诺现有覆盖范围，不假装完整。
7. **陈旧结果零应用**：会话切换、workspace 切换、订阅代际（generation）变化、`logEpoch`
   变化或 store 关闭后到达的定位响应，**应用次数为 0**——既不写焦点正文，也不改目录选择态。
8. **单飞定位**：同一 store 最多一个**有效**定位操作。新的定位请求以自增 `focusRequestId`
   取代旧请求（supersede，不是拒绝），旧请求即使后到也因 id 不匹配而作废。
9. **目录求值按面板开关门控**：目录冷求值成本与索引规模成正比（实测 8000 项 ≈2 ms），
   而索引 size/bytes 在流式输出期间每个 delta 都变、控制器缓存必然未命中，
   因此**面板关闭时不得求值目录**，返回稳定的空目录引用，把这笔开销压到 0。
   `open` 状态的唯一所有者是 `useConversationIndexFocus`（面板不自持 `useState`，
   避免两条写入路径）。此规则是规则 1「打开目录 0 请求」的性能侧补充。

## 窗口语义裁决（提案 §2.2 要求实施前裁决）

**裁决：共享总预算 = 现有 `PROJECTION_WINDOW_MAX_ROWS(1200)` / `PROJECTION_WINDOW_MAX_BYTES(32 MiB)`
一个信封，不放大。焦点与尾部按「尾部优先、争用时才裁尾」分配，尾部下限
`INDEX_FOCUS_TAIL_FLOOR_ROWS = 60`。**

提案建议「保留尾部 60 行作为起点，须验证连续更新及 rewind 不变量后才采纳」。验证结论：
**60 行可作为下限采纳，但不可作为无条件收缩目标**。

### 证据 1：60 恰为权威自身的尾窗宽度（支持下限）

`PROTOCOL_V4_LIMITS.snapshotTailWindowRows = 60`（`packages/shared/src/acode-protocol-v4/core.ts:75`）。
冷 `subscribe` 只下发最后 60 行。裁到 60 行意味着 renderer 持有量**不低于服务端自己的重订阅基线**，
因此任何「裁到 60」都能靠既有 `loadOlder`/`rowsRange` 原样取回，不引入新的不可恢复状态。

### 证据 2：连续更新——裁掉的行会静默丢流式增量（反对无条件收缩）

`applyConversationDelta` 对未加载行是**静默 no-op**：

- `row.upserted`：`const index = snapshot.rows.window.findIndex(...); if (index === -1) return snapshot;`
  （`packages/shared/src/acode-protocol-v4/apply.ts:82-84`）
- `row.delta`：`const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.rowId);`
  `if (index === -1 || target === undefined) return snapshot;`（`apply.ts:112-116`）

即：进入历史焦点时若把尾部从 1200 无条件砍到 60，被砍掉的 1140 行此后收到的任何
`row.delta` 流式追加都**不会落到本地投影**。权威源仍是 CLI，`returnToLive()` 后经
`rowsRange` 整行重取可以恢复正确内容，但这笔代价是「每次目录跳转都丢 1140 行 + 返回时重取」，
既制造请求也制造可见滚动跳变。因此**只在信封真的争用时才裁尾**：
尾部 60 行（冷订阅常态）时 `1200 - 60 = 1140` 行空闲，焦点无需触碰尾部。

### 证据 3：运行中的 turn 可能超过 60 行（下限必须按实况抬高）

单个 turn 的长工具链可产出远超 60 行。若尾部下限硬编码 60，运行中 turn 的头部会被裁掉，
其后续 `row.delta` 落入证据 2 的 no-op 路径 → **正在输出的内容当场丢字**。故下限不是常量，
而是 `max(INDEX_FOCUS_TAIL_FLOOR_ROWS, 运行中 turn 的行数)`，由 store 在调用预算函数时算出
（`resolveRunningTurnRowCount`），**永不裁进当前运行 turn**。

### 证据 4：rewind 不依赖 renderer 保留行数（支持裁尾安全）

`row.removed` 的权威重算只看服务端事实：

```ts
const removesEntireActiveBranch =
  snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
// totalCount / firstRowId 按 removesEntireActiveBranch 重算（apply.ts:91-110）
```

`firstRowId` 由权威快照携带，**不是** renderer 窗口的派生量，因此裁尾不会伪造分页锚点。
rewind 首轮后 rowId 继续单调递增（`apply.ts:101` 注释），跨 `logEpoch` 则 rowId 会重新编号——
所以焦点请求把 `logEpoch` 作为一等失效条件（规则 7）。rewind 命中焦点目标时，
定向页返回的 `eligible` 已不含该行，定位以 `target-missing` 收敛，**不无限重试**（U07-A4）。

### 证据 5：封顶后自动补拉已被既有守卫关闭（裁尾不自旋）

`shouldAutoLoadIncompleteLeadingTurn` 在窗口封顶时返回 `false`
（`conversationProjectionStore.ts:331`：「双上限已封顶时，补拉行会被窗口裁剪原样吃掉…不再自动补拉」）。
焦点占用信封后窗口处于争用态，该守卫确保裁尾不会触发自动补拉循环。

## 稳定实体标识：不新增拟议协议字段

提案 §2.2 提出「现有索引项没有 `turnId`；若需要新增稳定实体标识，标为拟议字段并同步严格 schema」。

**裁决：不新增任何协议字段。** 依据：`turnId` 与 `entityId` **已经在 wire schema 的每一行上**——
`rowBaseFields`（`packages/shared/src/acode-protocol-v4/rows.ts:11-31`）被展开全部 9 个 row 变体
（`rows.ts:98,142,201,213,236,280,313,374,492`），CLI 侧 `rowBase()` 对每行都写入两者
（`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/product-projection.ts:5570-5573`）。
缺的是 **UI 本地的轻量索引条目类型** `TurnIndexEntry` 没有携带它们。

因此正确做法是：`buildTurnIndexEntry` 在登记时**复制权威行上已有的** `turnId`/`entityId`。
这既满足「不能将 UI 推断出的 turn 当作权威值」（值是复制的，不是推断的），也避免为一个
已存在的字段新增严格 schema 面与跨进程兼容负担。`packages/shared/src/acode-protocol-v4/**`
**零改动**。

## 状态所有者与不变量

| 对象 | 所有者与不变量 |
| --- | --- |
| 目录条目 / 覆盖范围 / 淘汰提示 | `conversationProjectionStore`（唯一）；面板只读，不自行合并正文 |
| 权威会话与 row identity | CLI/runtime 投影事实源；UI 不为历史浏览创建第二份权威会话状态 |
| 历史焦点（派生只读视图） | `conversationProjectionStore` 内的 `indexFocus`；与尾部**共享**同一个 1200 行 / 32 MiB 信封 |
| 定位入口 | `store.focusIndexedRow(target)`；参数含 `sessionId`/`generation`/`logEpoch`/`rowId`；返回结构化结果与可恢复错误码 |
| 返回最新 | `store.returnToLive()`；清焦点正文、作废在途请求、恢复尾部滚动意图 |
| 单飞与有效性 | `store` 内自增 `focusRequestId`；提交前四重校验（id / generation / logEpoch / closed） |
| 预算裁决 | `v4/conversationIndexNavigation.ts` 纯函数（无 DOM、无 IO，可脱 jsdom 单测） |

**身份 key**：远端链路继续由既有 transport 层携带 `workspaceIdentity` 与 `remoteSessionId`
（`agentConversationTransport.rowsRange` 透传 `...workspace`）；本特性**不新建**身份 key，
需要时使用 `resolveWorkspaceKey`（`@acode/shared`），禁止手写
`workspaceIdentity?.trim() || workspacePath`。

**隐藏面板订阅**：[hidden-pane-subscription-release](./hidden-pane-subscription-release.md) R1
的 lease 规则继续生效。焦点正文挂在同一个 store 上，随 lease 释放 → keep-warm → `close()`
一并释放，历史导航**不额外长期持有隐藏订阅**。

### 不变量

1. `tailRetainRows + focusRows ≤ 1200` 且 `tailBytes + focusBytes ≤ 32 MiB`——
   **合计**受约束，不是各自 1200 后相加。瞬态分页缓冲计入 `focusRows`（合并后立即按预算裁剪），
   不作为第三份额外常驻。
2. `tailRetainRows ≥ max(60, 运行中 turn 行数)`；裁尾永不触及当前运行 turn。
3. 焦点页 `rowId` 全部 `< 尾部窗口首行 rowId`（焦点是**更早**历史），且升序、无重复 rowId。
4. 打开目录：`rowsRange` 请求数 **= 0**。一次跳转：**≤ 3**。单请求 `limit ≤ 200`。
5. 一次定位失败或被取代后，焦点正文行数 **= 0** 或保持上一次成功值，不出现半页拼接。

## 接口

实现落点（`conversationProjectionStore.ts` 与 `ConversationTimeline.tsx` 均已在 legacy
ratchet 基线上、超限只减不增，故本特性的全部新逻辑落到新模块；两处大文件行数**净下降**）：

| 模块 | 职责 |
| --- | --- |
| `v4/conversationIndexFocusBudget.ts` | 共享信封预算纯函数（尾部下限、行数/字节分配、焦点侧裁剪、运行中 turn 计数） |
| `v4/conversationIndexNavigation.ts` | 定向单页、合并去重、请求门槛、陈旧校验、目录投影、unitIndex 解析（纯函数） |
| `v4/conversationIndexFocusTypes.ts` | 类型面 + 宿主读取契约 + 空目录/idle 常量 |
| `v4/conversationIndexDirectoryView.ts` | 目录视图（带内容键缓存）；只读，0 请求 |
| `v4/conversationIndexFocusController.ts` | 焦点状态机：单飞、四重陈旧裁决、提交、失效 |
| `v4/conversationIndexFocusStoreAdapter.ts` | store ↔ 控制器适配工厂（含 close 终态） |
| `v4/conversationProjectionWindow.ts` | 既有窗口双上限/分页纯函数（从 store 原样外迁） |
| `v4/conversationProjectionFrames.ts` | 既有帧分类纯函数 + `earliestRemovedFromRowId`（从 store 外迁） |
| `v4/conversationScrollMemoryRestore.ts` | 既有滚动记忆裁决（从 timeline 原样外迁） |
| `v4/session-pane/sessionPanePure.ts` | 既有 pane 纯 helper（从 SessionPane 原样外迁） |
| `v4/ConversationIndexDirectoryPanel.tsx` | 目录面板（Popover + Button，只读 focusApi） |
| `v4/ConversationIndexFocusBridge.tsx` | 焦点提交 → 经 timeline 的 rowId 动作滚动（同一目标只抢一次） |
| `hooks/useConversationIndexFocus.ts` | 订阅目录/焦点 + 转发动作；组件不复制状态 |

```ts
// 纯函数（可脱 jsdom 单测）
resolveIndexFocusBudget(input): IndexFocusBudget;       // 共享信封分配 + 裁尾裁决
trimIndexFocusRows(rows, budget, byteOf): {...};        // 焦点侧行数/字节双上限，末行优先
resolveRunningTurnRowCount(window): number;             // 证据 3 的实况下限
resolveIndexFocusCommit(params): {...};                 // 合并 → 分配 → 裁剪 的完整账目
resolveIndexFocusRows(merged, tailFirstRowId): T[];     // 升序 + 去重 + 严格早于尾部首行
resolveIndexFocusOutcome(params): IndexFocusOutcome;    // 终态裁决（含 no-budget 优先级）
resolveIndexFocusReconciliation(params): {...};         // 尾部前插后的焦点让位裁决
planIndexFocusPage(targetRowId, maxLimit): IndexFocusPage;  // beforeRowId = target + 1
clampRowsRangeLimit(requested): number;                 // 恒 ≤ rowsRangeMaxLimit(200)
resolveIndexFocusNextAction(input): IndexFocusNextAction;   // none|continue-older|range-exhausted
isIndexFocusResponseApplicable(input): {applicable, reason}; // 四重陈旧校验（规则 7）
resolveIndexDirectory(entries, evicted, opts): IndexDirectory; // 索引 → 目录 + isPartial
resolveUnitIndexForRowId(units, rowId): number | null;  // 滚动落点（timeline 派生事实）

// store 公共入口（唯一写入方）
store.getIndexDirectory(): IndexDirectory;                 // 0 请求
store.captureIndexFocusTarget(rowId): IndexFocusTarget|null; // 原子捕获 session+generation+epoch
store.focusIndexedRow(target): Promise<IndexFocusResult>;   // ≤3 请求
store.continueIndexFocusOlder(): Promise<IndexFocusResult>; // 显式「继续加载更早」
store.returnToLive(): void;
store.getIndexFocusState(): IndexFocusState;                // 只读派生态
store.subscribeIndexFocus(listener): () => void;            // 独立通道，不牵动主投影订阅者
store.indexFocusDiagnostics(): { focusRows, focusBytes };   // 内存诊断计数
```

`captureIndexFocusTarget` 是必需的：`generation` 与 `snapshot` 必须**同一次读取**捕获。
若调用方先读 snapshot 再单独读 generation，两次读取之间可能已 `++generation`，
捕获到的就是自相矛盾的身份。

`IndexFocusResult.status` 封闭枚举（可恢复错误码）：
`focused` / `stale`（附 `staleReason: request|session|generation|epoch|closed`）/
`not-indexed` / `target-missing` / `range-exhausted` / `retryable-failure` / `no-budget`。
失败保留目录与当前尾部，UI 给出「继续加载更早」「返回最新」等确定动作。

### 无预算降级（no-budget）

运行中 turn 独占共享信封的极端形态：单个运行中 turn 就 ≥1200 行（长工具链）时，
尾部下限被抬到 `runningTurnRowCount`，焦点容量为 0。此时**焦点整体让位**、
不裁尾（裁进运行中 turn 会丢 `row.delta` 流式增量，见证据 2/3），
定位收敛为确定的 `no-budget` 降级态而非「focused 但 rows 为空」的死状态。
UI 提示用户「当前回答过长，返回最新后重试」，保留目录与尾部不动。
实测回归：修复前该边界会让焦点+尾部合计突破信封（1200+1=1201），违反不变量 1。

### 方向独占与交错防护

「更早」方向在焦点生效期间由聚焦独占，`loadOlder` 与 `loadAllOlder` 均被抑制：
`loadAllOlder` 会沿游标遍历整条分支，正是规则 3 禁止的后台遍历；`loadOlder` 前插尾部
会与焦点争用同一方向并产生重复 rowId。

但互斥只挡住「聚焦期间发起补拉」。反向交错仍可能：自动预取在用户点目录**之前**已发出，
其响应在焦点提交**之后**才落地，把焦点行覆盖进权威尾部 → 同一 rowId 渲染两次
（违反 U07-A2「没有重复行」）。因此尾部前插提交后必须调用
`controller.reconcileAgainstTail(tailFirstRowId)`，让落进新尾部的焦点行让位给权威侧；
若焦点因此一行不剩则退化为 idle，避免「返回最新」挂在空焦点上。

## 验收

### 编号场景（映射提案 U07-A1..A5）

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| U07-A1 | 6000 行合成会话，目标在索引内、正文窗外 | 打开目录 `rowsRange` 计数 = 0；点击后恰好 1 个请求、`beforeRowId = rowId+1`、`limit ≤ 200`；返回页最后一行 = 目标行；不全量加载历史 |
| U07-A2 | 会话持续流式输出 | 焦点期间尾部仍应用 `row.appended`/`row.delta`；`returnToLive()` 后焦点行数 = 0、尾部滚动意图恢复、无重复 rowId |
| U07-A3 | 定位请求在途时切会话/workspace/换代 | 迟到响应应用次数 = 0：焦点行数不变、目录选择态不变、`rowsRange` 不重发 |
| U07-A4 | 焦点目标被 rewind/edit 移除 | 定向页不含目标 → `target-missing`；不无限重试（重试次数有界）；索引与焦点一起失效 |
| U07-A5 | 索引 > 8000 项 | `isPartial = true`、`evictionCount > 0`；目录只承诺现有覆盖范围；被淘汰 rowId 定位 → `not-indexed` |

### 量化门槛

- 合计预算：焦点 + 尾部 + 瞬态页缓冲全部落在同一个 1200 行 / 32 MiB 信封内——
  测试断言**总和**，不逐份断言。
- 请求门槛：打开目录 0；单次跳转 ≤3；单请求 ≤200 行。
- 性能门槛：固定本地 fixture 中目录打开 p95 ≤100 ms、定位 p95 ≤800 ms；≥30 次操作样本；
  远端在受控 150 ms RTT 下**单列**结果，不混入本地数字。
- 生命周期：同一 store 最多一个有效定位；会话切换 / 关闭 / generation 变化后旧结果应用次数 = 0。

### 实测记录（本地 fixture，一次性量测脚本，未落库）

fixture：6000 行合成会话，每 10 行一条 realUser query；wire 尾窗 60 行；深滚动至窗口封顶后
索引 1260 条 / 目录 126 项，窗外目标 rowId=4750。样本 N=40（满足 ≥30 次操作样本要求）。
量测在最终实现形态（`resolveIndexFocusCommit` / `resolveIndexFocusOutcome` 抽取后）上跑，
机器为本开发机单进程 node。

| 指标 | 本地（无网络） | 远端（受控 150 ms RTT，单列） | 门槛 | 结论 |
| --- | --- | --- | --- | --- |
| 目录打开 p50 / p95 / max | 0.000 / 0.009 / 0.013 ms | 0.002 / 0.114 / 0.234 ms | p95 ≤100 ms | 通过 |
| 打开目录新增正文请求 | 0 | 0 | = 0 | 通过 |
| 索引内定位 p50 / p95 / max | 0.146 / 0.246 / 1.494 ms | 155.7 / 158.3 / 166.8 ms | p95 ≤800 ms | 通过 |
| 单次跳转正文请求数 | 1.00 | 1.00 | ≤3 | 通过 |
| 聚焦后预算 tail + focus | 1000 + 200 = **1200** | 同 | ≤1200 行 | 通过（信封争用时裁尾 200 行让位） |
| 聚焦后 focusBytes | 21700 B | 同 | ≤32 MiB | 通过 |

远端定位 p95 几乎全部由单次 150 ms RTT 构成（158.3 ms ≈ 150 ms + 本地 0.25 ms + 调度），
而目录打开在同样 150 ms RTT 下仍是 0.114 ms——两者相差三个数量级即为「打开目录不触网」的
直接证据：若目录打开需要一次往返，它的 p95 会同样抬到 ~150 ms。

计时是拟议回归目标；本轮已在固定本地 fixture 上实测并记录如上，但**尚未**沉淀为
CI 内的常驻性能门禁（没有落库的 fixture harness，量测脚本为一次性、用完即删）。

### 门禁

`pnpm typecheck`、`pnpm lint`、`pnpm --filter @acode/ui test`、
`pnpm architecture:check --changed` 无新增违反；`conversationProjectionStore.ts` 与
`ConversationTimeline.tsx` 已在 legacy ratchet 基线上（超限只减不增），本特性**不得使其行数增长**，
新增逻辑一律落到新模块。
