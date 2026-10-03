# Workflow Agent Worktree 隔离（S1 落地）

路线图 S1（`docs/capability-uplift-plan.md` 缺口总览表，L 级）落地：把
`script-workflow-runtime.ts` 里 `isolation: "worktree"` 的 not-implemented 桩变成真实
的 git worktree 隔离。契约面（`WorkflowAgentIsolationSchema = z.enum(["worktree"])`）
自初始提交即声明该值合法，运行时却抛错——本 spec 让声明的行为成真（**兑现既有契约**，
不是发明新表面）。所有者拍板立项（2026-10-04「全都做了」），推翻此前「待需求信号」
的缓做裁决。

## 背景

- 桩点：`runLiveAgent()` 开头 `isolation === "worktree"` 即抛错（fail-loud、无副作用），
  位于子会话铸造之前。legacy 脚本工作流路径（`Workflow` 工具条目已移出 builtInTools，
  但协议 app 方法 `runWorkflowScript` 等仍完整接线）是 `isolation` 的唯一消费面。
- 现役 dwf 引擎（CreateWorkflow 家族）没有 isolation 概念（facade `agent()` 无该参数，
  两包 grep 零命中）。
- 子代理现状零隔离：`script-workflow-child-runtime.ts` 的 `workingDirectory` 直传父
  目录；`parallel()` fan-out 下多个 actor 共享同一工作区互相踩写。
- `workspaceRoot = workingDirectory` 同源（`agent-runtime.ts:305`）：覆盖 workingDirectory
  即同时移动 pathEscapeWrite breaker 的收敛根——worktree 内写入是「工作区内」，主
  checkout 对隔离 actor 变为「工作区外」。

## 产品规则

### R1 范围裁决（v1 = legacy 脚本路径；dwf 面显式非目标）

- 落地面 = `ScriptWorkflowRuntime.runLiveAgent` 的 `input.opts.isolation === "worktree"`
  分支——契约已声明、桩已 fail-loud 的那条路径。
- **dwf（CreateWorkflow）面不做**：给灰度门后引擎新增 facade 参数面（`agent()` 加
  isolation → schema/analysis/compiler/run-service/harness 全链）是投机性新表面，违背
  「不不断增加兜底/投机分支」纪律。触发条件登记：dwf 出灰度 **且** 出现真实并行
  actor 互踩需求信号时另立 spec。
- 不回收 `EnterWorktree`/`ExitWorktree` 死工具名（`provider-visible-order-hygiene`
  的「死名永不回收」纪律不动）：worktree 是 workflow agent 的**运行环境属性**，不是
  模型可调用工具。

### R2 生命周期与单一所有者

- 新模块 `bootstrap/src/app/workflow-worktree-manager.ts` 是 worktree 生命周期的**唯一
  所有者**：`ensureWorktree` / `releaseWorktree` / `pruneOrphans` 三个原语，别处不得
  直接 spawn `git worktree`。
- git 经内部 `execFile` 执行面（注入点 `deps.git` 供测试）——与模型可见的 Bash 工具面
  分离（模型面里 `git worktree add` 仍走审批，系统面不借道）。
- 每个隔离 activity 一个 worktree（`runId + activityId` 命名），activity 终态
  （completed/failed/aborted）即触发回收裁决（R5）。

### R3 落点与命名

- worktree 路径：`<tmpRoot>/acode-workflow-worktrees/<sha256(repoRoot)[:12]>/<runId>-<activityId>`
  （tmpRoot 缺省 `os.tmpdir()`；命名空间目录 `mode 0700`）。不放仓库内（污染 status、
  嵌套 checkout）也不放仓库父目录（惊扰邻居）；系统 temp 在 Windows 是 per-user、
  Linux 以 0700 + uuid 命名兜住窥探面（诚实边界见下）。
- 分支名：`acode/workflow/<runId-slug>/<label|activityId-slug>`（slug：非
  `[A-Za-z0-9._-]` 折 `-`、截 40 字符；git ref 非法序列 `..`/尾 `.lock` 拒绝）。
  基于 run 启动时的 `HEAD`（`baseRef` 入 handle）；**unborn HEAD（空仓）fail-loud**
  ——空仓上 worktree 无意义。
- 脚本实体落点不变：`<run 级 cwd>/.acode/workflow-runs/<runId>.mjs` 留在主 checkout
  （run 级产物）；worktree 只是 **actor 级工作目录**。run 记录的 `cwd` 语义不变
  （list/status 仍按主工作区过滤）。

### R4 注入面（零新接口）

- 注入 = `createScriptWorkflowAgentRuntime` 既有的 `configOverrides` 通道：
  `{ workingDirectory: worktree.path }`（其 spread 顺序天然覆盖 deps 直传的父目录）。
- breaker 收敛随 `workspaceRoot = workingDirectory` 同源自动移动到 worktree（R「背景」
  第 4 条）——隔离 actor 写主 checkout 会被 pathEscapeWrite 判逃逸，这是**期望语义**。
- 子代理 `mode: "yolo"` 既有事实不变：worktree 隔离是**状态隔离**（互踩/脏区分离），
  不是权限收敛手段。

### R5 回收裁决（材料优先，绝不毁 agent 产物）

- activity 终态时分类：
  - **clean**（`status --porcelain` 空 ∧ `rev-list baseRef..HEAD` 为 0）→
    `git worktree remove` + 删除分支（指向 baseRef 零信息量）→ `kept: false`。
  - **dirty**（有未提交改动或领先提交）→ **保留** worktree 与分支 → `kept: true`，
    path/branch/baseRef/releaseReason 写入 activity result 信封（`result?: unknown`
    自由 JSON，无契约改动）——未提交的工作就是材料，销毁比泄漏严重得多。
  - remove 失败（句柄占用等）→ 保留 + `reclaim-failed-kept`（尽力而为，日志告警）。
- 成功路径在写 completed 记录**之前**完成回收裁决（result 信封要带 kept 信息）；
  失败/abort 路径在 catch 内同样裁决后写 failed 记录；finally 兜底防漏。
- **不做自动 merge-back**：隔离分支的去留（合并/发 PR/丢弃）是调用方（host/用户）的
  决定，v1 只登记 path+branch。

### R6 并发与竞争

- 进程内：manager 以 promise 队列**串行化** ensure/release/prune（`git worktree add`
  对 `.git/worktrees` 有锁，`parallel()` fan-out 的并发创建必须排队）。
- 进程间（同仓两个 CLI run）：依赖 git 自身锁 + 锁冲突错误**一次**退避重试（250ms）；
  再失败即 fail-loud（activity failed，不静默降级共享 cwd）。
- 数量天花板由既有 `workflow-concurrency-ceiling`（≤16）天然封顶。

### R7 失败语义（fail-loud，绝不静默降级）

以下全部 = activity failed + 明确错误文本，**绝不**回落共享 cwd（静默降级 = 假装隔离）：
非 git 仓库；空仓（unborn HEAD）；git 二进制缺失；worktree add 重试后仍失败。

### R8 孤儿清理

- `ensureWorktree` 时机会式 `pruneOrphans`（每 repoRoot 进程内至多一次）：
  `git worktree prune`（git 原生、只清管理条目已死的）+ 命名空间内**不在 git 登记**
  且 mtime 龄期 > 1h 的目录 best-effort 删除（failed-add 残骸/崩溃遗留；龄期门槛避开
  并发进程刚建的目录）。
- 崩溃遗留的 dirty worktree 是**保留**语义（R5）：prune 不动 git 仍登记的条目——材料
  宁可漏收不可误毁。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| worktree 生命周期（建/收/清） | `workflow-worktree-manager.ts`（唯一） |
| 隔离注入 | `script-workflow-runtime.ts` runLiveAgent（configOverrides 通道） |
| kept/path/branch 登记 | activity result 信封（session-store 既有持久化） |
| 并发天花板 | `workflow-concurrency-ceiling.ts`（既有，不改） |
| git 系统执行面 | manager 内部 execFile（与模型 Bash 面分离） |

## 接口

```ts
interface WorkflowWorktreeHandle { path; branch; baseRef; repoRoot }
interface WorkflowWorktreeReleaseResult { kept; reason: "clean-reclaimed"|"dirty-kept"|"reclaim-failed-kept"; path; branch }
class WorkflowWorktreeManager {
  ensureWorktree({ repoDir, runId, activityId, label? }): Promise<WorkflowWorktreeHandle>
  releaseWorktree(handle): Promise<WorkflowWorktreeReleaseResult>
  pruneOrphans(repoDir): Promise<void>
}
// ScriptWorkflowRuntimeDeps += worktreeManager?: WorkflowWorktreeManager（测试注入）
```

## 已知边界（诚实声明）

- Linux `/tmp` 命名空间靠 0700 + uuid；tmp 清理器可能在长跑 workflow 中途删 worktree
  目录（git 登记还在）→ agent 侧表现为 IO 错误，activity failed，prune 下轮收编。
- worktree 在主 checkout 的 `git worktree list` 可见——用户会看到 `acode/workflow/*`
  分支与 temp 路径条目；dirty-kept 的分支**有意**留给人处置（R5）。
- dwf 面 isolation 缺位是显式非目标（R1），不是遗漏。
- 隔离 actor 的 Bash 仍可 `cd` 出 worktree（yolo 既有事实）；breaker 只收敛文件工具
  写路径。状态隔离≠沙箱，与主会话语义一致。

## 验收场景

见 `apps/acode-cli/tests/workflow-worktree-isolation.test.mjs`（真实 git 临时仓 +
注入 git runner 双轨）：

1. **ensure**：git 仓内建 worktree——路径在命名空间下、分支名合 slug 规则、HEAD 内容
   与主 checkout 一致；非 git 仓 / 空仓 / git 缺失 → 各自 fail-loud 错误文本。
2. **release clean**：无改动 → worktree 移除、分支删除、`kept:false reason:clean-reclaimed`。
3. **release dirty**：未提交改动 → 保留 + `dirty-kept`；仅提交（领先 baseRef）→ 保留；
   remove 失败（注入 git 报错）→ `reclaim-failed-kept`。
4. **幂等/复用**：同 handle 重复 ensure（resume 形态）→ 复用已登记 worktree 不重建；
   failed-add 残骸目录（未登记）→ 清掉重建。
5. **串行化**：并发 ensure×3 → git 调用序列无交叠（队列断言）。
6. **prune**：git 登记外的老龄残骸目录被清、新目录与登记内目录不动。
7. **接线**：runtime 源码不含 not-implemented 抛错；isolation 分支走 manager +
   configOverrides.workingDirectory（源码不变量钉桩，照 auth-login-vault-wiring 模式）。
8. **文档纠偏**：`docs/security-hardening-plan.md` 的「已实现 worktree 隔离」陈述与
   源码一致（本批次落地后才为真）。

## 不在本项范围

- dwf（CreateWorkflow）面的 isolation 参数（R1 触发条件登记）。
- 自动 merge-back / PR 创建（R5 裁决：调用方决定）。
- 子代理 prompt 里的 worktree 感知文案（actor 从 cwd/env 自然感知；文案面另议）。
- `EnterWorktree`/`ExitWorktree` 工具名回收（死名纪律）。
