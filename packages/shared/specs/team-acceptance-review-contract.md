# 团队验收面跨包契约（in_review 投影 + diff 按需读取）

来源：[`docs/upgrades/orchestration-acceptance-2026-11.md`](../../../docs/upgrades/orchestration-acceptance-2026-11.md)
§3 G7 / §5 批次 4 / §7 Track C / §8。本 spec 是**契约冻结**（EI-137）：先冻结通道归属、字段形状与
读取接口，再分别由插件侧与 UI 侧实现。UI 实现细则见
[`packages/ui/specs/team-acceptance-visualization.md`](../../ui/specs/team-acceptance-visualization.md)；
插件侧生产规则落 `apps/acode-cli/specs/agent-teams-acceptance-loop.md`（本批不含该文件）。

本 spec 只冻结契约与裁决，不含实现。**冻结项不得单方面更改**（并行 spec 依赖）。

## 背景（起草时逐条核实，行号以当前检出为准）

1. **通用插件状态通道已就位，宿主不解释内容**：`packages/shared/src/acode-protocol-v4/snapshot.ts:555`
   `pluginStates: z.record(z.string(), z.unknown()).nullable().default(null)`；
   `delta.ts:62` 同键 optional；归约走 `apply.ts` 的 `state.updated` **键级整体替换**
   （`apply.ts:119-121` 泛型 spread）。键 = `${pluginId}:${key}`，值归插件命名空间——
   **任何团队验收数据都无需协议改动**，只要插件把它放进 `TeamPanelState`。
2. **快照形状由 UI 端受检收窄，`v` 必须保持 1**：`packages/ui/src/v4/teamPanelModel.ts:233`
   `if (snapshot.v !== 1) return null;`（形状不符整卡丢弃），且
   `packages/ui/test/teamPanelModel.test.ts` 明确断言 `v: 2 → null`。既有 additive 手法
   （`panel-state.ts:79-107` 的 `teams?` / `recentEnded?` / `readyTaskIds` 等）注释逐字写明
   「v 仍为 1；缺席即退回旧行为，不构成形状不符」。**因此新增验收字段必须 additive，不得 bump v**。
3. **插件侧数据已存在**：`apps/acode-cli/packages/agent-teams-plugin/src/state/types.ts:12-40`
   `MemberWorktree{baseCommit, branch, baseBranch, status, lastMergedCommit?, mergedAt?}` 与
   `TeamWorktreeIsolation{repoRoot, baseBranch}` 已持久化；`TeamTask.verify?` 已存在。
   缺的只是把它们投影到面板状态、以及一个按 ref 范围读取 diff 的入口（G2）。
4. **现有 git 链没有任意 ref 范围 diff**：`packages/shared/src/git.ts:73-86` 的 `getDiff` 是按单
   `path` 的工作树/暂存 diff；`packages/services/src/git/repo/gitCliRepo.ts:1394-1439` 的
   `getBranchComparison` **硬编码 `trackingBranchName...HEAD`** 且只取 numstat（无 patch）。
   两者都不能读 `baseCommit..lastMergedCommit`。
5. **gitService 覆盖本地/远程/手机远控同一调用面**：桌面经 host 注册
   （`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:308`）；
   远程经 `packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts:11` 与
   `packages/desktop/src/host/legacyRemoteWorkspaceRpcContract.ts` 的 `gitService` 通道。
   即：扩展 `IGitService` 后，远程/手机沿既有通道自动可用，不需另立协议面。
6. **输出上界已有 EI-97 语义**：`gitCliHelpers.ts:585` `toDiffResult` 在
   `result.outputTruncated` 时返回 `availability: "truncated"` + `patch: null`（整段丢弃）；
   `git.ts:22` `GitDiffAvailability` 已含 `patch | binary | truncated | unavailable`。二进制识别、
   `allowedExitCodes`、超时语义均已具备，无需新造。
7. **UI 文本渲染面已存在**（零新依赖）：`packages/ui/src/components/ui/lightweight-diff-preview.tsx`
   与 `packages/ui/src/lib/patchDiffPreview.ts:9-26,150-161` 的截断标记行内部 token
   （`\ __ACODE_DIFF_TRUNCATED__:<n>`）+ i18n key `diff.preview.truncatedLines`。
8. **v4 / legacy 边界**：`packages/shared/specs/legacy-protocol-freeze.md` 已冻结「新命令/事件只进
   `acode-protocol-v4/`、legacy 只删不增」。本批不新增 v4 命令/事件，也不动 legacy。

## 裁决 1：协议面 vs 插件状态通道（逐项）

| # | 待呈现事实 | 通道裁决 | 理由 |
| --- | --- | --- | --- |
| 1 | 任务进入 `in_review` | **插件状态通道 additive**（`tasks[].status` 值域 + `counts.inReview?`） | 状态机权威在插件；`status` 已是透传字符串，UI 按值分组；bump v 会让 UI 整卡丢弃（背景 #2） |
| 2 | diff 可查的**只读坐标**（归属成员、钉住的 base/head 提交 SHA、可用性、不可用原因） | **插件状态通道 additive**（新 `reviews[]`） | 插件是这些 git 事实的唯一生产者；宿主不解释插件状态；缺席即旧行为 |
| 3 | 检查结果（`run_checks` 命令、退出码、通过位、有界输出摘要、执行时刻） | **插件状态通道 additive**（`reviews[].check?`） | 只可能由插件产生（宿主无法复算）；是插件权威记录 `task.review` 的派生投影 |
| 4 | 合并 / 打回**结果** | **插件状态通道（既有）**：`tasks[].status` 迁移（`done` / `todo`）+ `reviews[].status` 由 `in_review` 变 `merged`/`rejected` | 结果即状态迁移本身；不新增事件（EI-146） |
| 5 | **全量 unified-diff 文本** | **不改协议**：按需经既有 `IGitService` 的 ref-range 读取（契约 B） | 见裁决 2；diff 字节不进快照、不进会话事件流 |
| 6 | 结构化文件列表与 stat | **契约 B 的读取结果**（不进快照） | 可由 git 服务精确算出；放进快照等于把大派生数据推给每次状态写（快照体积纪律、单一 diff 源） |
| 7 | 「提醒队长验收 / 请求打回」消息 | **复用既有 v4 `sendText` 用户输入链路**（经 composer 唯一写入通道） | 见 UI spec R4；UI 不得另立写入路径（AGENTS.md） |
| 8 | 验收执行（accept = 合并 / reject = 打回） | **不经 UI，也无新协议**：仍由队长经 `agent_teams_*` 工具完成 | 冻结契约：UI 不做验收直写，避免多写路径 |

**结论：本批不新增任何 v4 命令/事件，不改 legacy，bump 不动的 `v` 保持 1。**

**重开条件（何时才需要 v4 读命令）**：若 ref-range 读取无法通过 `IGitService` 在三个平台与远程/手机
通道统一提供（例如某平台宿主的 git 能力不可扩展），或验收判定改用 runtime 事实而非 git 事实——
那时才在 `acode-protocol-v4/` 立读命令并更新本裁决。触发前不得预设 v4 面（EI-146）。

## 裁决 2：diff 数据通路与降级

**取混合方案（c）**：

1. **只读坐标走面板投影**：插件在 `TeamPanelState.reviews[]` 给出归属成员与**钉住的** `baseCommit` /
   `headCommit`。快照**不带任何文件列表、stat 或 diff 文本**。
2. **全文按需走既有 git 服务**：UI 经 `packages/ui/src/hooks/` 调 `IGitService` 新方法
   （契约 B），传入 **workspace 自身路径**、插件钉住的 `baseRef` / `headRef`。
   - **不拿主仓库当前 HEAD 代替成员提交**：调用方必须传显式 SHA；实现侧不得回退 `HEAD`
     （借用 Fynvra 的 `mergedDiff{baseCommit, headCommit}` 契约形状，附录 B）。
   - **读取仓库 = workspace 自身路径**：git linked worktree 与主树共享对象库与 refs，
     `git -C <workspacePath> diff <base> <head>` 在「主树」与「成员 worktree」两种 workspace 形态下
     都成立；因此**不需要向 UI 暴露成员 worktree 绝对路径**（减少快照面与路径泄漏面）。
   - **工作树已清理**：只要提交对仍可达（`--no-ff` 合并后 `baseCommit` 是 `lastMergedCommit` 的祖先，
     通常经基线分支可达）就仍可读；提交被 GC/不可达 → `availability:"unavailable"` + 可读 summary，
     **明确报不可用，不编造**（EI-9）。git 的判定优先于插件的 `diffAvailable` 提示（git 磁盘事实是最终判据）。

**降级矩阵（EI-9 诚实声明）**：

| 场景 | 行为 |
| --- | --- |
| 本地 desktop workspace | `IGitService` = 本地 host 服务；正常读取 |
| SSH/Docker 远程 workspace | `IGitService` = 远程 host 服务（背景 #5）；正常读取，**绝不回落到本机仓库**（回落即错仓库） |
| 手机远控（web-remote-replayable） | 经桌面 Host attachment 复用远程/本地 `gitService` 服务通道；语义与上两行相同 |
| workspace 未连接 / RPC 未就绪 | **不发起 RPC**（沿用 `useGitRepository` 的 `shouldEnableWorkspaceRpc` 门控，避免把断连代理错误放大成首屏日志噪音）；UI 显示「工作区未连接，diff 暂不可用」 |
| 团队未开启工作树隔离（`worktree_disabled`） | 插件置 `diffAvailable:false` + `unavailableReason:"worktree_disabled"`；UI 显式说明，不尝试读取 |
| 提交不可达（清理后 GC） | 读取返回 `unavailable` + `reason:"ref_unresolved"` + summary；UI 显式说明「工作树已清理且提交不可达」 |
| git 不可用 / 超时 / 输出溢出 | `reason` 逐项（`git_unavailable` / `timeout` / `output_too_large`）+ 既有 `availability`；UI 显式呈现，不显示半截内容冒充全文 |

## 契约 A：插件状态通道 additive 字段（冻结）

在 `apps/acode-cli/packages/agent-teams-plugin/src/panel-state.ts` 的 `TeamPanelState`（`v: 1`）上
**只增不改**下列字段；缺席一律表示「旧插件 / 无验收面」，UI **不得**因此判定形状不符：

| 字段 | 类型 | 缺席语义 | 上限 |
| --- | --- | --- | --- |
| `counts.inReview` | `number` | 0 | — |
| `tasks[].status` | 值域追加新成员 `"in_review"`（插件侧 `TaskStatus` 联合同步扩一个成员；**wire 与消费侧仍是透传字符串**，UI 收窄 `typeof === "string"` 不受影响） | 旧值域 | — |
| `reviews` | `TeamPanelReview[]` | 空数组（不渲染验收面） | 条数上限由插件持有常量 `MAX_PANEL_REVIEWS`（建议 24）；超限按 EI-97 整段丢弃并置 `reviewsTruncated: true`（新 additive 标志） |

```ts
export interface TeamPanelReview {
  taskId: string;
  member: string;                 // 归属成员名（与 TeamTask.assignee / MemberWorktree 对应）
  status: "in_review" | "merged" | "rejected";
  baseCommit?: string;            // MemberWorktree.baseCommit（缺席 = 无法钉住起点）
  headCommit?: string;            // 未合并 = 成员分支 HEAD（快照生成时钉住）；已合并 = lastMergedCommit
  mergedAt?: string;
  // 只报插件实际执行过的检查；缺席 = 未执行 / 旧插件
  check?: {
    command: string;
    exitCode: number;
    passed: boolean;
    summary?: string;             // 有界文本（插件侧已截断并自标 truncated）
    truncated?: boolean;
    ranAt: string;
  };
  diffAvailable?: boolean;        // 插件知识：提交对是否可读；缺席按 false
  unavailableReason?:
    | "worktree_disabled"
    | "worktree_cleaned"
    | "commits_unreachable"
    | "unknown";
}
```

约束与纪律：

- **生产者是插件**（`panel-state.ts` 与插件状态写路径）；本 spec 冻结的是**消费方契约**
  （UI 与插件必须同时对同一形状达成一致，EI-137）。
- **不在快照里放文件列表、stat、diff 文本**（裁决 2）——快照按工作区推给每个会话，体积是固定成本；
  diff 全文的累计成本已由 G2/EI-147 说明。
- `headCommit` 是**快照时刻**的事实：快照不是提交历史，UI 必须原样使用该 SHA，不得改读 `HEAD`
  （否则成员继续提交后审的就不是同一份）。
- `reviews[]` 与 `reviewsTruncated` 均参与「缺了只是少画一块」一类（不参与形状判定）。
- **`metrics?: TeamAcceptanceMetrics` 不在本 spec 的契约面**：其形状与口径由批次 0 spec
  `apps/acode-cli/specs/agent-teams-acceptance-loop.md` R0.2 单一拥有（同一 additive 手法、
  `v` 仍为 1、不上报不落盘）；UI 侧的消费规则见
  `packages/ui/specs/team-acceptance-visualization.md` R12。**本 spec 不复制该形状**（EI-2 单一真源）。
- **注意 `counts.inReview`（批次 1）与 `metrics.tasks.inReview`（批次 0）是两个字段携同一计数**：
  两者都从同一任务列表派生，不构成第二真源，但属接口面重复（EI-2/EI-146 精神）。由主 agent
  在批次 4 落地时裁决是否让 `metrics` 复用 `counts`（本 spec 不预设）。

## 契约 B：git ref-range 读取（`IGitService` 扩展）

类型落 `packages/shared/src/git.ts`（本包既有 git 类型的唯一事实源）：

```ts
export interface GitRefRangeDiffRequest extends GitRepositoryRequest {
  baseRef: string;   // 显式提交（SHA）或 ref；调用方传插件钉住的 baseCommit
  headRef: string;   // 同上
  path?: string;     // 省略 = 整个范围；给定 = 单文件
}

export interface GitRefRangeFileChange {
  path: string;
  originalPath?: string | null;
  kind: GitChangeKind;
  added: number;
  removed: number;
}

export interface GitRefRangeDiffResult {
  baseRef: string;
  headRef: string;
  resolvedBase: string | null;        // 实际解析出的提交 SHA；解析不到 = null（EI-9）
  resolvedHead: string | null;
  availability: GitDiffAvailability;  // 复用既有枚举：patch | binary | truncated | unavailable
  /**
   * 机器可判的原因码。UI 据此选文案，**不得**去匹配 summary 字符串
   * （字符串匹配文案是最易碎的耦合；EI-9 要的是可判读，不是可猜读）。
   */
  reason:
    | "ok"                  // 正常（availability 为 patch / binary）
    | "no_changes"          // 范围内无差异（availability 为 unavailable）
    | "ref_unresolved"      // baseRef / headRef 解析不到
    | "not_a_repository"    // workspacePath 不是仓库
    | "git_unavailable"     // git 不可用 / 命令失败
    | "timeout"
    | "output_too_large"    // 触发字节上限（availability 为 truncated）
    | "unknown";
  files: GitRefRangeFileChange[];     // 上限内；超限整段丢弃（见下）
  filesTruncated: boolean;            // true = files[] 被整段丢弃（失步标记，EI-97）
  stat: { added: number; removed: number; fileCount: number } | null;
  patch: string | null;               // 有界文本；溢出（availability === "truncated"）时 = null
  summary?: string | null;            // 人读补充（诊断用）；不作为判定依据
}
```

接口登记（同批，缺一即门禁红）：

- `packages/services/src/git/git.ts`：`IGitService` 增
  `getRefRangeDiff(params: GitRefRangeDiffRequest): Promise<GitRefRangeDiffResult>`；
  descriptor `allowedMethods` 增同名条目；`argumentValidators` 增
  `getRefRangeDiff: (args) => requireGitParams(args, ["workspacePath", "baseRef", "headRef"])`。
- 实现（`packages/services/src/git/…`）：`posture: "read"`，`cwd = repoRoot/workspacePath`，
  timeout 与字节上限沿用既有常量族（`DEFAULT_GIT_*`），命令为
  `git diff --numstat -z --find-renames <baseRef> <headRef> --` 取 `files[]`/`stat`，
  `git diff --find-renames <baseRef> <headRef> -- [path]` 取 `patch`；结果经既有 `toDiffResult`
  语义归约（二进制 → `binary`、溢出/超时 → `truncated`/`unavailable` + `summary`）。
- `packages/services/test/rpc-argument-validators-mid.test.ts` 的既有约定要求：新方法的非法参数
  必须返回 `rpc-invalid-arguments` 且**方法体不执行**（stub + call tracking 验证）。

语义要点：

- **两端解析失败或 ref 不存在** → `availability:"unavailable"` + `reason:"ref_unresolved"` +
  `resolvedBase/Head` 如实置 null + 可读 `summary`（不得吞成空结果）。
- **范围内无差异** → `availability:"unavailable"` + `reason:"no_changes"` + `files` 空 +
  `stat.fileCount === 0`；UI 把它当「无改动」而非「坏了」呈现（不靠 summary 字符串判读）。
- **结构化列表**（`files[]`）超上限 → **整段丢弃** + `filesTruncated: true`（EI-97 原义：绝不从中间
  截断结构化序列）。**diff 文本**（`patch`）的展示层截断属 UI 职责，见下条。
- **`patch` 是面向展示的自由文本**：服务侧沿用既有 `toDiffResult`（溢出 → `patch:null` +
  `availability:"truncated"` + `reason:"output_too_large"`）；**行级展示截断由 UI 落地**
  （`packages/ui/specs/team-acceptance-visualization.md` R3），复用既有 `LightweightDiffPreview`
  + 截断标记行约定。EI-97 禁止的是从中间截断结构化流；unified-diff 文本按**整行**截断并追加显式
  「省略 N 行」标记，不产生静默损坏，二者不冲突。
- **无 shell、无写面变化**：本方法只读；不改 `stage/commit/push` 语义，不引入新审批面。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 任务状态机（含 `in_review`）与验收结账 | 插件状态 JSON（`store.withLock` 读改写，磁盘唯一真相） | UI 只投影（本 spec 契约 A） |
| 面板验收投影（`reviews[]`） | 插件（`panel-state.ts`） | 派生，只读；宿主不解释 |
| git 事实（提交可达性、diff 字节） | git 磁盘（仓库对象库与 refs） | `IGitService` 是读取面；git 判定优先于插件提示 |
| 通道与类型行状 | `packages/shared/src/git.ts`（契约 B）+ v4 `pluginStates`（既有） | v4 不改，legacy 不动 |

## 验收场景（契约层）

1. **旧插件回归**：`pluginStates` 中 `TeamPanelState` 无 `reviews` / `counts.inReview` →
   UI 收窄得空集合、团队卡照常渲染（不判形状不符）。
2. **bump v 保持被拒**：`v: 2` 快照 → 团队卡整卡不渲染（既有纪律不得被本批放宽）。
3. **单条 `reviews[]` 形状坏** → 该条丢弃、其余保留（与 `teams[]` 同纪律）。
4. **base=fhead 无差异** → `files` 空、`stat.fileCount === 0`、`availability:"unavailable"`、
   `reason:"no_changes"`。
5. **输出溢出** → `files[]` 整段丢弃 + `filesTruncated:true`；
   `patch` 溢出 → `patch:null` + `availability:"truncated"` + `reason:"output_too_large"`。
6. **非法参数**：缺 `baseRef` → `rpc-invalid-arguments`、方法体不执行（stub 计数为 0）。
7. **不回落 HEAD**：请求显式传两个 SHA 时，服务命令行必须逐字含这两个 SHA（源文本断言）；实现不得
   把其中一个替换成 `HEAD` 或 `status.summary.branchName`。
8. **远程/手机**：同一 `workspacePath + workspaceIdentity + remoteSessionId` 解析出的 `IGitService`
   与远程通道一致（背景 #5）；断连（`shouldEnableWorkspaceRpc` 为假）时 UI 侧不发起该 RPC。

## 不做清单

1. **不新增 v4 命令/事件**，不改 `acode-protocol-v4/`，不动 legacy barrel（裁决 1）。
2. **不把 diff 全文、文件列表或 stat 写进插件状态快照**（快照体积与单一 diff 源，裁决 2）。
3. **不把成员 worktree 绝对路径写进快照**（用 workspace 自身路径读，裁决 2）。
4. **不引入第二套 diff 渲染/编辑器栈**：CodeMirror merge view 等属 Track C 单独立项
   （来源 §7），本批零新依赖。
5. **不在本批给 UI 任何验收写入面**（accept/reject 仍由队长经 `agent_teams_*` 工具）。
6. **不改 git 写面**（`stagePaths`/`commit`/`push`）语义，不给 review 读取引入新审批档位。