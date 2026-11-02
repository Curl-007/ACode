# AgentTeams 验收闭环（第 1/2 册：批次 M0 度量基线 + 批次 0 队长验收工具面）

覆盖 `docs/upgrades/orchestration-acceptance-2026-11.md` §5 的 **批次 M0（验收度量基线）** 与
**批次 0（队长验收工具面，G2+G3）**。**批次 1（`in_review` 态与合并↔任务耦合，G1）见第 2 册
`agent-teams-acceptance-loop-2-in-review.md`**；批次 2/3/4/5 不在本 spec 范围。

分册原因：单文件会超 `architecture-policy.yaml:341-343` 的 400 行零容忍上限。分册边界 =
批次边界（M0+0 / 1），契约面不重叠，两册各自可达 400 行内。

本 spec 是契约冻结先行（EI-137）：先落状态机、工具签名、返回形状与验收场景，实现独立提交后
再落地。方案是提案与路线图，本 spec 是实现契约；冲突时以本 spec 的冻结面为准。

## 背景与已核实事实

基线 `feature/cli-agent-teams-acceptance-loop`，全部路径相对
`apps/acode-cli/packages/agent-teams-plugin/`（下称「插件」）。

| 断言 | 核实结果 |
| --- | --- |
| 17 个工具（`src/server.ts:26-33` ALL_TOOLS）无 review/diff/checks | 属实（team 6 + member 3 + task 5 + message 1 + worktree 1 + wait 1） |
| `TeamTask.verify?: string` + `verify_required`（`src/state/types.ts:96,182`） | 属实；但 `verify` 现仅由成员在 `update_task` 写入（`create`/`amend` 无该字段） |
| `TEAM_ERROR_CODES` 已含 `reassign_limit_exceeded`（`src/state/types.ts:184`） | 属实 → 本批无需新增错误码 |
| 工作树 git 执行面 = `execFile` 无 shell、60s 超时、错误按结果分类（`src/worktree/git.ts:22-44`） | 属实（`git` 在 win32 是 `git.exe`，无需 shell hop；`pnpm`/`npm` 则不然，见 R1.3） |
| 成员等活上限 `WAIT_MAX_MS = 8 分钟` < `.mcp.json` `timeoutMs: 600000`（`src/tools/member-wait.ts:16`） | 属实 → `run_checks` 超时纪律的先例 |
| 合并工具只写 `member.worktree.status`，不动 `task.status`（`src/tools/worktree.ts:60-78`） | 属实 → G1 缺口（第 2 册 R2.2 修） |
| `MemberWorktree.baseCommit` / `lastMergedCommit` / `mergedAt` 已持久化（`state/types.ts:12-30`） | 属实 → 数据已有，缺读取入口（R1.1 补） |

**与方案假设不符（本册相关，第 1 处）**：方案称「`tools/tasks.ts`、`state/store.ts` 已贴近上限」
（§5 批次 0 约束）。实测 `src/tools/tasks.ts` 是 **10 行纯 barrel**（`tasks-captain.ts` 282 行、
`tasks-progress.ts` 227 行才是实现面）；贴上限的是 `state/store.ts`（369 行）与 `src/panel.ts`
（353 行）。结论不变（新能力仍放新文件），但理由要写对：**没有**「tasks.ts 快满」这回事。
另两处与批次 1 相关的不符记在第 2 册背景。

## 状态所有者与事件顺序

唯一权威 = 插件团队状态 JSON（磁盘唯一真相，`store.withLock` 读-改-写，EI-40/EI-12）。
面板、UI、度量全部是只读派生投影（EI-48），不落第二份台账。

```text
队长会话 ── 团队状态 JSON（权威）─────────────────────────────────────────────
  │ create_task(...) ─派工─▶ 成员 worktree（baseCommit 建树时钉住）
  │                              │ update_task(done, verify="$ <命令>")
  │                              ▼
  │                     task: 汇报/待验收（批次 1 起为 in_review，第 2 册）
  │ review_member_diff（baseCommit..head 钉住；attempt 锚定「当前」）
  │ run_checks（verify 声明精确匹配；cwd=worktree 根；有界输出）
  │   ├─ 通过 ─▶ merge_member_worktree（批次 1 起同一锁内 accept→done）
  │   └─ 不通过 ─▶ reassign ─▶ todo（旧 attempt 失效；worktree 保留）
  ▼
只读投影链：metrics ← 团队 JSON → panelState → v4 插件状态通道 → teamPanelModel 受检投影
  → 团队卡 / Side Pane；插件自带浏览器面板（M0 度量首屏）。单一路径，不新建链路。
```

**批次顺序约束**：批次 0 可独立先上线。此时（无 `in_review`）R1 的 attempt 锚定条件退化为
「成员持活 attempt 的 `in_progress` 任务」；批次 1 落地后锚定优先 `in_review`（第 2 册 R2.1/R2.2）。
两册的锚定函数必须同一处实现（EI-2），批次 1 只加一个状态偏好。

## R0 · 验收度量基线（批次 M0）

### R0.1 落点裁决

- 单一实现：新建 `src/metrics.ts`（纯函数、无 IO、无持久化、≤400 行）。输入
  `(team: TeamState, tasks: readonly TeamTask[])`，输出 `TeamAcceptanceMetrics`。
  **不新增工具**（EI-146）；**不写磁盘**、**不上报**（`specs/no-telemetry.md`）、
  **不落第二份台账**（EI-48：全部当场从 `attempts` / `revisions` / `worktree.mergedAt` 派生）。
- 消费点（additive，旧宿主缺席即退回）：
  1. `src/panel-state.ts` 的 `TeamPanelState` 追加 `metrics?: TeamAcceptanceMetrics`（`v` 仍为 1）；
  2. `src/panel.ts` 浏览器面板首屏与 `/api/state`（随 `buildTeamPanelState` 自动带出）；
  3. `src/tools/team-status.ts` 队长视角追加 `metrics`。
- **M0 零 UI 面**：`packages/ui/**` 本批不碰（桌面团队卡展示度量归批次 4）；面板文案走插件自带 HTML。
- 选「独立 `metrics.ts` + additive 投影」而非「直接扩 `panel-state.ts`」的理由：`panel.ts` 353 行、
  `store.ts` 369 行已贴上限，且度量口径要能被状态工具与面板**共用一个实现**（EI-2）。

### R0.2 度量定义（口径与数据源）

```ts
interface TeamAcceptanceMetrics {
  generatedAt: string;
  tasks: { total: number; accepted: number; inReview: number; open: number;
           failed: number; blocked: number; cancelled: number };
  acceptance: {
    acceptedTasks: number;      // status === "done"
    firstPassTasks: number;     // done && attempts.length <= 1
    firstPassRate: number | null;  // firstPassTasks / acceptedTasks；分母 0 → null
    totalAttempts: number;      // Σ attempts.length（仅曾认领的任务）
    avgAttemptsPerTask: number | null;  // totalAttempts / 曾认领任务数；分母 0 → null
    rejections: number;         // Σ max(0, attempts.length - 1)
  };
  latency: { sampleSize: number; avgAcceptLatencyMs: number | null };
  byTask: Array<{ taskId: string; status: TaskStatus; attempts: number;
                  revisions: number; rejections: number; acceptLatencyMs: number | null }>;
}
```

- **一次验收通过率** = `done && attempts.length <= 1` / `done`。口径按**任务**（每任务一行 =
  一个 dispatch 维度），与 Fynvra 用量页对齐，便于横向比较。
- **平均尝试数** = `totalAttempts / 曾认领任务数`。
- **打回次数** = `Σ reassignCountOf(task)` = `Σ max(0, attempts.length - 1)`（复用
  `src/state/types.ts:275-277`）。**复用既有 `attempts`，不新增计数器**——一次打回之后必有一次
  新认领，故二分同源，且与 `reassign_limit_exceeded` 的判据同一来源（EI-2）。边界：尚未重新
  认领的打回不计（第 2 册 R2.3）。
- **验收耗时**（`acceptLatencyMs`）= 权威 attempt 的 `startedAt` → 该成员 `worktree.mergedAt`。
  权威 attempt = `outcome === "done"` 的 attempt，否则最新 attempt。不可得（未开隔离 / 未合并 /
  `mergedAt < startedAt`）→ `null`，**不计入平均**，`sampleSize` 一并返回。
- `revisions` 取出 `task.revisions.length`（amend 次数），作为第二个审计维度。
- **缺数据一律 `null` + `sampleSize`**，不用 `0` 冒充「无数据」（EI-9 能力声明必须诚实）。

### R0.3 只读纪律

`buildTeamPanelState` 仍是纯读；metrics 每次由磁盘快照现算，不缓存、不落盘、不进 `seq`。
M0 在批次 1 之前上线，以保留「改前 / 改后」的一次验收通过率对照（EI-142 用数据决策）。

## R1 · 队长验收工具面（批次 0）

两个工具均 `memberAllowed: false`，进 `src/server.ts` 的 `ALL_TOOLS`，并导出给
`tests/tools.test.ts` 的 `ALL_TOOLS`。文件落点（新文件，零容忍 400 行）：

- `src/tools/review-diff.ts` — `agent_teams_review_member_diff`；
- `src/tools/run-checks.ts` — `agent_teams_run_checks`；
- `src/worktree/exec.ts` — 命令执行面（argv 规范化、声明解析、Windows 解析、有界输出）。

### R1.1 `agent_teams_review_member_diff`

入参（`.strict()`）：`{ teamId?: string; member: string; baseRef?: string; headRef?: string;
statOnly?: boolean }`（`statOnly` 默认 `false`）。

前置（顺序固定，fail-closed）：团队存在且 `worktreeIsolation.enabled`，否则 `worktree_disabled`；
`member` 在名册且未 removed，否则 `member_not_found`；`member.worktree` 存在，否则
`worktree_not_found`。

**attempt 锚定（复用 `stale_attempt`）**：工具不接受 `attemptId`（冻结签名）。它从磁盘现算
「成员当前可审任务」= 该成员持有活 attempt（`activeAttemptId` 指向的 attempt，`owner === member`）
的任务；批次 1 起 `in_review` 优先、否则 `in_progress`。一个都没有 → `stale_attempt`
（`data: { member }`）。因锚点每次从磁盘重算，**队长手上持有的旧 attempt 上下文不会被用来审
新重试**；`headRef` 可显式指定旧 head 用于「对已固定的那次交付复核」（EI-40 磁盘为准）。

**base / head 钉住语义**：

- base 缺省 = `worktree.baseCommit`（建树时的 HEAD，永不被主仓库当前 HEAD 冒充）；
  `baseRef` 显式给出时按 `git rev-parse --verify <baseRef>^{commit}` 解析，失败 → `invalid_input`。
- head 缺省 = `git rev-parse --verify refs/heads/<worktree.branch>`（成员分支当前 HEAD，而非
  主工作区 HEAD）；`headRef` 显式给出时按同法解析，**允许是指向旧交付的 commit sha**。
- 返回 `baseCommit` / `headCommit`（已解析的绝对 sha）、`branchHeadCommit`（分支当前 tip）与
  `headIsBranchTip`（`headCommit === branchHeadCommit`）。成员在 review 之后又提交时，
  再调一次 → `headCommit` 变化；显式传旧 `headRef` → `headIsBranchTip: false`，队长据此知道
  「审的不再是当前 tip」（EI-1 不静默）。

**diff 与截断**：文件清单走 `git diff --name-status <base> <head>`；统计走 `--stat`；补丁文本走
`git diff <base> <head>`（`statOnly: true` 时不取补丁）。上限（超出**整段丢弃 + 失步标记**，
EI-97，绝不从中间截断结构化流）：补丁 ≤ `MAX_DIFF_BYTES = 256 KiB`；
文件清单 ≤ `MAX_DIFF_FILES = 1000`；统计 ≤ `MAX_STAT_BYTES = 64 KiB`。任一超限 → 该段置 `null`、
`truncated: true`、`desync: true`，并在 `notes` 说明。

返回：`{ ok, teamId, member, branch, baseCommit, headCommit, branchHeadCommit, headIsBranchTip,
files, stat, diff, truncated, desync, task?: { taskId, attemptId, status }, notes[] }`。

全部 git 调用走既有 `src/worktree/git.ts` 的 `runGit`（`execFile`、无 shell、60s 超时），
不新增第二套 git 执行面（EI-2）。

### R1.2 `agent_teams_run_checks`

入参（`.strict()`）：`{ teamId?: string; member: string; command: string }`。

前置与 attempt 锚定同 R1.1。

**声明匹配（规范化后逐项精确匹配，v1 不支持通配参数）**：

- 声明源 = 锚定任务的 `TeamTask.verify`。解析：按行切分，**只取以 `$ ` 开头（`$` + 一个空格）
  的行**为机器声明，其余行是散文（结果叙述）。`verify` 非该语法 / 无 `$ ` 行 → 声明的命令集为空。
- 规范化（声明行与 `command` 同一函数，纯函数，落 `src/worktree/exec.ts`）：trim；把连续
  `[ \t]+` 折叠为单个空格；**不做引号解析**；得到 token 序列。
- `command` 规范化后必须与**恰好一条**声明行 token 序列**逐项相等**（大小写敏感）。不等或
  声明集为空 → `verify_required`（`data: { declared: string[], requested: string }`），
  **不执行**（负向断言）。
- token 字符集收窄（fail-closed）：任一 token 含 ``" ' ` $ & | < > ^ % * ? ( ) [ ] { } ; ! ~``
  或 `\n`/`\r`/`\t` → `invalid_input`，不执行。这是「无 shell + 精确匹配」的边界来源。

**执行面**：`execFile`（对齐 `worktree/git.ts` 惯例：无 shell 拼接、`windowsHide: true`、
错误不抛给调用方而按结果分类），`cwd` 钉在 `worktree.path`（成员 worktree 根；目录不存在 →
`worktree_not_found`）。**无超时入参**：硬上限 `CHECK_TIMEOUT_LIMIT_MS = 600_000`（冻结），
实跑常量 `CHECK_TIMEOUT_MS = 480_000`（8 分钟）——宿主 `.mcp.json` `timeoutMs = 600000`，
同刻到达会被传输层中断，取 8 分钟对齐 `WAIT_MAX_MS` 先例（OQ-5）。

**有界输出（EI-97）**：`stdout`/`stderr` 各自上限 `MAX_CHECK_OUTPUT_BYTES = 256 KiB`（以
`maxBuffer` 触发 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 判定）。超限 → 该流**整段丢弃**（不返回
被截断的部分），置 `truncated: true`、`desync: true`；`exitCode` 仍如实返回。

**并发与锁**：`manageOwnLock: true`（同 `member-wait.ts:82`）。分段：锁内解析 + 校验 + 计数
`+1` 落盘 → 解锁执行 → 再入锁写回结果计数。**绝不在持锁期等待命令**（否则卡死所有工具调用）。

返回：`{ ok, teamId, member, command, cwd, exitCode, timedOut, stdout, stderr, truncated, desync,
durationMs, task?: { taskId, attemptId, status }, notes[] }`。超时 → `ok: true` + `timedOut: true`，
**不是错误**（对齐 `wait_for_work` 的 `ready:false` 语义）。

### R1.3 Windows 下 `pnpm.cmd` / `npm.cmd` 的 execFile 解析规则

Node 在 Windows 上不能用 `execFile` 直接启动 `.bat`/`.cmd`（需 shell 或 `cmd.exe`）；`git` 是
`git.exe` 所以 `git.ts` 无需处理，而 `pnpm`/`npm` 在 win32 是 `.cmd` shim。规则：

1. `argv[0]` 含路径分隔符 → 按给定路径解析（必须存在）。否则在 `PATH` 内按序尝试（win32 追加
   `PATHEXT` 变体 `.exe`→`.cmd`→`.bat`，扩展名比对大小写不敏感）。
2. 解析到 `.exe`（或 posix 可执行文件）→ 直接 `execFile(abs, args)`。
3. 解析到 `.cmd`/`.bat` → **唯一允许的 shell hop**：`execFile(process.env.ComSpec ?? "cmd.exe",
   ["/d", "/s", "/c", abs, ...rest])`，各参数作为独立 argv 元素交给 Node 的 Windows 引号规则
   组装（不做字符串拼接）。`/d` 关 AutoRun、`/s` 保留引号语义、`/c` 执行后退出。
4. 解析不到 → `invalid_input`，不执行。

残余面由 R1.2 的 token 字符集收窄（`& | < > ^ % "` 等已被拒）封住；`cmd.exe` 的元字符解释因此
无输入可乘。此 hop 与「声明-执行分离」共同构成「以受限审批换有界接口」的裁决（R1.4 如实写明，
不包装成「白名单即安全」）。

### R1.4 威胁模型与显式 trade-off

- **防的是**：队长模型的失误（审了错的对象、跳过验收、把自述当结论）与提示注入导致的漂移
  （捏造命令、扩大输出、绕过声明）。**不防**：恶意攻击者——队长本就在权限面内，插件零 core
  依赖（`package.json` 仅 `@modelcontextprotocol/server`），看不到 `PermissionService`。
- **显式 trade-off**：以「受限审批面」换「有界接口面」。四个真实价值点：声明与执行分离
  （`verify` 声明 + 精确匹配）、无 shell（除 R1.3 的 `.cmd` hop）、cwd 钉死成员 worktree、
  超时 + 有界输出。**不声称具备权限白名单**；`node`/`pnpm` 前缀白名单无安全价值（`node -e`、
  `pnpm exec` 即任意执行），故匹配语义直接用整命令精确匹配而非前缀。
- 未声明即 `verify_required` 拒绝（fail-closed，EI-4）。裁决点 1 选项 A（修正版）即本节的裁决；
  选项 B（宿主 core handler）不在批次 0，R1.5 的调用计数为其取舍留数据。

### R1.5 调用计数（EI-142）

`TeamState` 追加 additive `checkRuns?: { total: number; byMember: Record<string, number>;
lastAt?: string; lastExitCode?: number }`，在同一 `store.withLock` 段内写盘。**本地磁盘事实，
不上报**（`specs/no-telemetry.md`）。`review_member_diff` 计数暂不埋（本批不新增字段），
登记为后续项。

## 验收场景 · 批次 0（①-⑥，测试落 `tests/review-checks.test.ts`，真实 temp git 仓）

1. **钉住 base/head**：成员树有未合并提交 → review 返回 `baseCommit = 建树 baseCommit`、
   `headCommit = 成员分支 tip`，且 `headIsBranchTip === true`；断言 `baseCommit` **不等于**主仓库 HEAD。
2. **再提交后 head 变化 + 旧 head 可指定**：成员再提交一次 → 第二次 review 的 `headCommit` 变化、
   `headIsBranchTip === true`；显式传第一次的 `headRef` → `headCommit` 回到旧值、
   `headIsBranchTip === false`、`files` 只剩该次交付的差异。
3. **未声明命令拒绝（负向断言）**：`task.verify` 只有 `"$ pnpm typecheck"` 时，
   `run_checks(command: "pnpm test")` → `verify_required`，且**该命令未被执行**（注入探针文件 /
   记录型可执行件断言零调用、零副作用）；`command: "pnpm typecheck"` → 执行成功。
   变体：无 `$ ` 声明行（散文 `verify`）→ `verify_required`；token 含 `&&`/`|`/`*` → `invalid_input`。
4. **输出超限整段丢弃 + 失步标记**：声明一条产出 > 256 KiB 的命令 → `truncated === true`、
   `desync === true`、`stdout === null`（不返回被截断的部分），`exitCode` 如实；
   变体：`statOnly: true` 省略补丁文本（`diff === null`，`files`/`stat` 仍在）。
5. **陈旧 attempt**：成员被 reassign（或任务已 done / 成员 removed）后 review / run_checks →
   `stale_attempt`，不返回任何 diff、不执行任何命令。
6. **穷举跨边界（EI-21）**：对 `{worktree_disabled, member_not_found, worktree_not_found,
   无活 attempt, baseRef 不可解析, headRef 不可解析, 命令未声明, 命令含非法字符, 无 $ 声明}`
   逐项断言错误码；对 `$ ` 声明解析 + 规范化的输入面（空白折叠 / 大小写 / 空行 / 多个声明行）
   逐分支断言。win32 分支：`pnpm`/`npm` 解析到 `.cmd` 走 `cmd.exe` hop；解析不到 → `invalid_input`
   （在 win32 CI 上真实跑一次 `.exe` 直跑路径）。

## 实施约束

- **新文件 ≤400 物理行、零容忍**（`architecture-policy.yaml:341-343`）。`state/store.ts` 369 行、
  `panel.ts` 353 行已贴上限 → 新增能力放新文件（`src/tools/review-diff.ts`、
  `src/tools/run-checks.ts`、`src/worktree/exec.ts`、`src/metrics.ts`）。
- 测试全部放插件 `tests/*.test.ts`（`node --import tsx --test`），与既有 `machine.test.ts` /
  `worktree.test.ts` / `tools.test.ts` 同构（temp 目录 + `TeamStore` + `createToolContext`）。
- 每批门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、
  `pnpm --filter @acode/agent-teams-plugin test`；真实报告结果。spec 先行独立提交（EI-137）。
- 分支 `feature/cli-agent-teams-acceptance-loop`，squash 合入；不做验收可视化 UI（批次 4）。
- 状态读-改-写一律 `store.withLock`；`run_checks` 用 `manageOwnLock` 分段，绝不在持锁期执行命令。
- 测试纪律（EI-120/EI-121）：固定时钟 + 内存/临时目录，不触网、不上报；关键不变式（声明匹配、
  输出上限、锚定）用负向断言钉死。

## 开放问题（需主 agent 裁决，本册部分）

- **OQ-2**：`review_member_diff` / `run_checks` 是否加**可选** `attemptId` 显式锚定 attempt
  （冻结签名无该字段）。v1 为磁盘现算隐式锚定（R1.1）；推荐后续下限时加可选字段而不改必填形状。
- **OQ-4**：`verify` 机器声明的语法取 `$ ` 前缀行（本 spec）还是「每非空行皆声明」。
  推荐 `$ `（散文与声明可区分，且 fail-closed）。
- **OQ-5**：`run_checks` 超时常量。硬上限 600s（冻结）与宿主 `.mcp.json timeoutMs=600000`
  同刻 → 实跑 480s。若同意，写入 `.mcp.json` 说明或 userConfig；若不同意，需宿主侧放宽工具超时。
- **OQ-8**：`verify_required` 现语义是「`done` 时缺 `verify` 字段」（`tasks-progress.ts:158-163`）。
  本册把同一错误码复用于「命令不在声明集」。是否统一为一个码的两条 message，还是分新码
  `check_not_declared`？推荐复用（错误码面无谓扩张，EI-146/147）。

## 非目标 / 登记项（本册）

- 不搬 Fynvra 的进程模型 / 编排工具名 / 裸文本注入；不新增第四套 worktree 域；不改 legacy 协议面
  （方案 §8）；不把编排状态做成第二真源（UI 只持有投影）。
- 登记（另立批次）：批次 1（第 2 册）、批次 2 协调者只读、批次 3 宿主唤醒 + 队长侧等待、
  批次 4 验收可视化 + diff 渲染选型、批次 5 角色能力包；`run_checks` 迁宿主 core handler
  （选项 B，吃 R1.5 计数数据）；`review_member_diff` 调用计数；Windows 下超时被杀的子进程
  孙进程残留（`pnpm` 派生 `node`）；度量「按 dispatch 维度归组」的桌面展示（批次 4）。