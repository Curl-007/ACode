# 会话级 git worktree 生命周期（隔离 + base 合并 + 写围栏 + 不活跃收割）

波次 2（价值提取 T1-1 第 3 件机制移植）：给「会话」补上 workflow agent 已有的
worktree 隔离能力的**会话态**版本——会话直接开在用户 checkout 时，代码改动前进入
隔离 worktree；基分支合并跑宿主执行层；写围栏把工具写路径收敛进 worktree；不活跃
worktree 按天数收割。与 `specs/workflow-worktree-isolation.md`（S1，workflow 域）
是**同词汇、分台账**的两个域（R1）。

## 背景

- 既有先例：`packages/cli-workflow/src/workflow-worktree-manager.ts` 是 workflow 域
  worktree 生命周期的唯一所有者（ensure/release/prune、材料优先、fail-loud、
  `acode/workflow/...` 分支前缀、tmp 命名空间、真实路径归一）。本 spec 的会话域
  模块**复用其全部命名与失败语义惯例**，不另造词汇。
- cwd 漏斗：`core/src/runtime/methods/config.ts` 的 `setWorkingDirectory` 是执行 cwd
  的唯一写入口，波次 1 已挂 CwdChanged hook（`specs/hook-event-surface.md`）；
  `ToolExecutionContext.setWorkingDirectory` 已经由 runtime-tools → executor →
  call-runner 全链接通，工具 handler 可直接消费。
- 路径策略现状：`core/src/tool/path-policy.ts` 的 `resolveWorkspacePath` **故意不硬拦**
  工作区外绝对路径（子代理需要检视兄弟仓/外部文件）。熔断器
  `breaker.pathEscapeWrite`（bypass-immune-breakers.ts）只拦「工作区外」写入，且
  豁免 `os.tmpdir()` 与产品 scratch 根。
- 依赖方向：`cli-workflow → core`、`core → contracts/shared`、`adapters → contracts/shared`。
  core 不能 import cli-workflow（成环），adapters 不能 import core——跨包缝只能是
  「contracts 类型 + bootstrap 装配注入」（R7）。

## 产品规则

### R1 范围与分域（与 workflow worktree 域的关系）

- **分域裁决**：会话域与 workflow 域是两套台账，靠**命名空间前缀**互不侵犯：
  - 分支：会话域 `acode/session/<slug>`；workflow 域 `acode/workflow/<runId>/<slug>`（既有）。
  - worktree 落点：会话域 `<tmpRoot>/acode-session-worktrees/<sha256(repoRoot)[:12]>/<slug>`；
    workflow 域 `acode-workflow-worktrees/...`（既有）。
  - 台账：会话域是持久化 ledger（R3）；workflow 域是 activity result 信封（既有，无持久台账）。
- 会话域收割（R6）**只处理自己 ledger 里的条目**，绝不扫描/删除 workflow 命名空间；
  workflow 域的 prune 同样只扫自己的命名空间（既有纪律）。两套台账因此不会互相
  误删，也不需要互相可见。
- git runner 惯例（注入点、串行队列、锁重试、真实路径归一、fail-loud）在会话域模块
  内**镜像**而非共享——包依赖方向禁止复用 cli-workflow 的实现，词汇保持一致即是互通。
- 死名纪律不动：上游遗留占位死名（provider-visible-order.ts 头注释清单）永不回收，
  本 spec 的三个工具全部用新名（R2/R5/R6）。

### R2 会话 worktree 模块与 enter 语义

- 新目录 `core/src/worktree/` 是**会话域** worktree 生命周期的唯一所有者：别处不得
  为会话目的直接 spawn `git worktree`。git 走内部 execFile 执行面（与模型可见的
  Bash 工具面分离；模型面里 `git worktree add` 仍走审批）。
- 落点裁决：worktree 目录放 `os.tmpdir()` 命名空间（与 workflow 域同款），**不放**
  `~/.acode`。理由：`breaker.pathEscapeWrite` 的豁免面只认 `os.tmpdir()` 与
  scratchRoot——worktree 若落 `~/.acode`，隔离会话里每一笔 worktree 内写入都会命中
  熔断弹审批，隔离反而不可用。tmp 的易失性（Linux systemd-tmpfiles 等）由 R3 的
  tombstone 语义兜住：目录没了 → 台账记 `worktree-missing`，分支仍在，重进重挂。
- enter 语义（工具 `EnterSessionWorktree`）：
  - 从**当前 HEAD** 切新分支建 worktree（`git worktree add -b <branch> <path> <HEAD-sha>`）；
    **不携带未提交改动**（worktree add 自 commit 建立，天然干净——用户 checkout 的
    dirty 材料留在原地，绝不被搬走也绝不被清掉）。
  - cwd 切换只经既有 `setWorkingDirectory` 漏斗（触发 CwdChanged hook）；
    `workspaceRoot` 不变（工作区身份不随执行 cwd 漂移，config.ts 既有不变量）。
  - 拒绝面（闭集 reason）：`not_git_repo` / `unborn_head`（空仓）/
    `inside_linked_worktree`（cwd 已在任何 linked worktree 内，含 workflow 域与用户
    自建——判据 `git-dir ≠ git-common-dir`）/ `already_in_session_worktree`（本会话
    已绑定且 cwd 就在其中）/ `branch_in_use`（目标分支被其它活 worktree 占用）。
  - 幂等/重开：本会话在 ledger 已有 active 绑定且 worktree 仍登记在场 → 复用并把
    cwd 切回去（`outcome: "reused"`）；绑定是 tombstone（被收割/目录丢失）→ 用
    `git worktree add <path> <branch>` **重挂既有分支**（分支 tip 就是重开时的
    材料，绝不从 HEAD 重建覆盖它）；分支也没了 → 按新建流程从 HEAD 切。
- 分支名：`acode/session/<slug>`，slug 规则与 workflow 域逐字同款（非
  `[A-Za-z0-9._-]` 折 `-`、截 40、拒 `..`/尾 `.lock`），缺省取 sessionId，可被
  入参 `branch_name` 覆盖（覆盖后仍进同一前缀）。

### R3 会话↔worktree 映射持久化（ledger，含 tombstone）

- 状态文件：`<dataRoot>/cli/session-worktrees/ledger.jsonl`，**追加式 JSONL**
  （先例：ambient usage-ledger）。选追加式而非单 JSON 文档的理由：桌面 host 一进程
  多会话、CLI 多进程可并发绑定，读-改-写文档会互相覆盖丢条目；追加行 + 读时折叠
  天然多写方安全。
- dataRoot 解析镜像 ambient usage-ledger：显式注入 > `ACODE_DATA_BASE_DIR` >
  `HOME` > `homedir()`，再拼 `.acode`（core 不依赖 services，同一兜底哲学）。
- 事件闭集（每行一个事件，`v:1`）：
  - `bind`：建立/重建绑定（sessionId、repoFingerprint、repoRoot、worktreePath、
    branch、baseRef、sourceBranch?、at）。
  - `touch`：活跃心跳（sessionId、repoFingerprint、at）——只更新 lastUsedAt。
  - `tombstone`：worktree 目录已不归本台账管（reason ∈ `reaped` / `worktree-missing`
    / `released`），**保留 branch 映射**供重开重挂（R2）；会话与对话数据在别处，
    本台账绝不删它们。
- 折叠：按 `(sessionId, repoFingerprint)` 合并，后事件覆盖同名字段；`touch` 只动
  lastUsedAt。机会式压实：行数 > 4×键数 + 64 时读后重写（best-effort，失败不影响读）。
- 心跳写入：绑定期间围栏命中（R4 的 lookup 成功）更新**进程内** lastActivityAt，
  节流 ≥5min 异步落一条 `touch`（fire-and-forget，失败只 warn）。enter/merge/reap
  的事件即时落盘。收割的「最近使用」判定合并进程内活动与 ledger 时间戳。
- 台账内不写凭据、不写文件内容、不写模型可见文本（只有路径/分支/sha/时间戳）。

### R4 写围栏（fence）

- 围栏 = 「会话进入受管 worktree 后，工具写路径收敛到 worktree 内」的产品边界。
  两个执行点：
  1. **进程内 path-policy**（本批次落地）：`resolveWorkspacePath` 对
     `operation: "write"` 增加围栏判定——按调用的 workingDirectory 查进程内围栏
     注册表（键 = 归一化 worktree 路径；多会话进程天然按各自 runtime 的
     workingDirectory 分流）。命中绑定且解析后的写路径落在**该绑定的 repoRoot 内**
     （= 用户 checkout）而不在 worktree 内 → 违规。
  2. **子进程边界 env**（执行层注入，R7 接线后生效）：按 request cwd 注入
     - `ACODE_SESSION_WORKTREE=<worktree 路径>`（边界标记）
     - `ACODE_SESSION_WORKTREE_FENCE=<warn|enforce>`（档位）
     provider 缺席的键**删除**（防父进程 env 里的陈旧值漏给未绑定会话）；
     显式 `overlay.set` 仍后置优先（调用方意图 > 会话默认）。
- **违规边界裁决**：围栏只保护「用户 checkout（repoRoot）」不被隔离会话写脏；
  worktree 外且 repoRoot 外的路径维持现状语义（path-policy 故意不硬拦的既有裁决
  不动，scratch/tmp 写入不受影响）。围栏不是通用沙箱，Bash 子进程的写治理仍归
  bash 权限面（本批次不硬化，登记为后续项）。
- **档位裁决：缺省 warn + 遥测**。产品理由：path-policy 现状故意不硬拦（子代理
  检视外部文件是合法流），直接 enforce 会把既有合法流打成拒绝，且围栏是新事实源
  （注册表/台账折叠若有 bug，enforce 会锁死会话的写入面）。warn 档记录违规到
  进程内有界环形缓冲（≤64 条 + 计数，供诊断/后续设置面读取；不 console 刷屏，
  遵守日志纪律），可选 warn sink 由装配层接 logger。
  **enforce 触发条件（登记）**：a) env 显式 `ACODE_SESSION_WORKTREE_FENCE=enforce`
  即时生效（用户/宿主的显式选择）；b) warn 档遥测观察到误报率可接受后，由设置面
  提供会话级开关（另立 spec）；c) enforce 的拒绝走**既有 permission 语义**——
  `PermissionDenied` CoreError（recoverable），模型收到与权限拒绝同形的工具失败，
  不另造审批面。
- **关闭开关**：`ACODE_SESSION_WORKTREE_FENCE_OFF=1/true/on` 时注册表 lookup 一律
  未命中（E2E/测试逃生舱，对齐既有 `ACODE_CUA_DEV_MODE` 一类开关的判定形态）。
  关闭只停围栏判定，不停 R2/R3/R5/R6 的生命周期事实。
- 已知边界（登记不修）：会话经 Bash `cd` 离开 worktree 后，workingDirectory 不再
  命中注册表，围栏随之不生效——cd 逃逸是模型显式动作、transcript 可见；enforce
  泛化到 workspaceRoot 键控需要多会话共仓的所有权裁决，留给设置面批次。

### R5 base 合并（宿主执行层）

- 工具 `MergeBaseBranch`：把基分支合并进会话分支（在会话 worktree 内执行）。
- **宿主执行裁决**：git 经 `ToolExecutionContext.executionPort` 以 argv 模式、
  `sandbox: {enabled:false}` 直跑——不经 Bash 工具的沙箱/只读治理。理由与参考机制
  同款：合并常触碰受保护路径（hooks/skills/mcp 配置一类），沙箱面会把它拦死；
  而合并的目标是会话自己的隔离分支，风险由 R4 围栏与「不 push 不删除」兜住。
- base 闭集（其余一律拒绝，`base_not_allowed`）：
  - `source_branch`：会话 worktree 的切出分支（enter 时记录的 sourceBranch；
    enter 时是 detached HEAD → `source_branch_unknown`，改用 default_branch）。
  - `default_branch`：仓库默认分支（解析镜像 git-snapshot.ts 的 resolveMainBranch：
    `symbolic-ref refs/remotes/origin/HEAD` → origin 候选 show-ref → 本地
    main/master show-ref；全无 → `default_branch_not_found`）。
  - `pr_base`：PR base。**本构建无 PR 面**，拒绝 `pr_surface_unavailable`；
    接口位保留（入参词汇已含），PR 面落地后由装配层注入解析器（登记项）。
- 前置拒绝（闭集）：`not_in_session_worktree`（cwd 不在受管 worktree）/
  `merge_in_progress`（已有 MERGE_HEAD，先解决或 abort）/ `uncommitted_changes`
  （有未提交改动即拒——合并不得吞掉进行中的材料）/ `base_is_current_branch` /
  `base_not_found`（base 解析不出真实 ref）。
- **不 push、不删除任何分支/远端引用**；合并只产生本地 merge commit（`--no-edit`）。
- **abort 语义**：冲突时**保留冲突现场**（MERGE_HEAD 在场、冲突标记在文件里），
  返回 `outcome: "conflict"` + 冲突文件清单（`git diff --name-only --diff-filter=U`）
  ——模型可就地解决后 commit，或再次调用 `action: "abort"` 执行 `git merge --abort`
  恢复干净态（`outcome: "aborted"`；无冲突现场时 `no_merge_in_progress`）。
  工具自身绝不静默 abort（那会销毁模型正在解决的现场），也绝不在冲突态上叠加新合并。

### R6 不活跃收割

- 工具 `ReapSessionWorktrees`：入参 `older_than_days ∈ {30, 60, 90}`（闭集，对应
  设置面「清理不活跃会话」的档位语义；设置面 UI 本批次不做，登记）。
- 候选 = ledger 折叠后的 active 绑定（tombstone 无目录可收，跳过）。
- **绝不动**（保护序在删除判定之前）：
  1. 本进程注册表在绑的会话（= 运行中/打开着）→ `in_use_current_process`；
  2. lastUsedAt（合并进程内心跳）距 now 不足阈值 → `recently_used`；
  3. dirty（`git status --porcelain` 非空）→ `dirty_kept`——材料优先，未提交改动
     绝不随目录销毁（对齐 workflow 域 R5 的同一裁决）。
- clean → `git worktree remove <path>`（不带 --force；失败 → `remove_failed_kept`）
  → ledger 落 `tombstone(reaped)`。**会话与分支保留**：分支是重开时重新 checkout
  的材料（R2 重挂），对话/会话数据不在本台账管辖内，一概不动。
- 目录已丢失（外部清理/tmp 回收）→ 落 `tombstone(worktree-missing)`，计入
  `tombstoned` 而非 `reaped`（诚实语义：没有目录被本工具删除）。
- 输出为逐条目闭集 reason + 计数；单条失败不阻断其余（best-effort，逐条上报）。

### R7 装配面（本批次不接线的部分）

以下接线归注册表/装配所有者（WSE/bootstrap），本批次交付实现 + 契约 + 测试，
接线片段随实现报告移交：

1. `core/src/tool/handlers/index.ts`：三个 ToolEntry 进 `builtInTools`（无需注册门
   ——enter/merge/reap 对任何 git 仓会话自洽；非 git 仓由工具拒绝面兜住）。
2. `contracts/src/tools/index.ts`：barrel 追加 `export * from "./session-worktree.js"`。
3. bootstrap `create-app.ts` 的 `createNodeExecutionAdapter({...})` 注入
   `sessionWorktreeEnv` provider（core 围栏注册表 → adapters 缝；adapters 不 import
   core，缝的形状见下）。
4. `packages/shared/src/runtimeEnv.ts` 的键常量登记（shared 归 WSE 独占；本批次
   键常量定义在 core/adapters 各自模块内，命名对齐 `ACODE_` 规约，shared 收编与否
   由 WSE 裁决）。
5. adapters 缝（本批次落地，缺省无行为变化）：`NodeExecutionAdapterOptions` 增加
   `sessionWorktreeEnv?: (cwd: string | undefined) => Record<string, string> | undefined`
   与 `sessionWorktreeEnvKeys?: readonly string[]`；`buildExecutionEnv` 在 base 组装
   后、`overlay.unset/set` 之前应用 provider 结果（在场键 set、名单内缺席键 delete）。
   provider 未注入时零变化——围栏进程内判定（R4-1）不依赖此缝。
6. `core/src/runtime/methods/config.ts`：**零改动**——enter 经既有
   `context.setWorkingDirectory` 漏斗，CwdChanged hook 自动触发，无需新接缝。

### R8 日志与错误纪律

- 日志/遥测 detail 键不使用保留闭集键 `status`（用 `outcome` / `fenceMode` /
  `reapReason` 等非保留键）。
- 生命周期失败 fail-loud（抛 CoreError），绝不静默降级回共享 cwd（假装隔离比不隔离
  更糟，对齐 workflow 域 R7）；业务性拒绝（R2/R5/R6 的闭集 reason）是**普通工具
  结果**而非错误——模型需要读到 reason 改道，不是重试同一堵墙（对齐 escalate 的
  「拒绝不是错误」裁决）。
- 围栏 warn 档违规只进有界缓冲，不打 console（TUI 刷屏 = 用户面噪音）；enforce 档
  抛 `PermissionDenied`（recoverable: true，模型可改写路径重试）。

## 验收场景（测试映射 tests/session-worktree-*.test.mjs）

1. **enter 全链（真实 git）**：建仓 + 主 checkout 留未提交改动 → enter → worktree
   在 tmp 命名空间、分支 `acode/session/...`、内容与 HEAD 一致且**不含**未提交改动；
   `setWorkingDirectory` 被调用（漏斗触发 CwdChanged）；ledger 落 bind。
2. **拒绝面**：非 git 仓 / 空仓 / cwd 已在 linked worktree / 已在受管 worktree →
   各自闭集 reason；已绑会话 cwd 飘走后重进 → `reused` 且路径不变。
3. **tombstone 重挂**：收割后重进 → 同分支重挂、分支 tip 的提交材料在场；
   分支也被删 → 从 HEAD 新建同名分支。
4. **merge-base**：source_branch / default_branch 各合并成功（真实 git：base 加提交
   → merge → 文件在场、merge commit 生成）；dirty 拒绝；冲突 → `conflict` + 冲突
   文件清单 + MERGE_HEAD 在场 → `action:"abort"` 恢复干净；`pr_base` →
   `pr_surface_unavailable`；git 经注入的 ExecutionPort（argv、sandbox disabled）
   而非 execFile/bash 面；不 push（远端引用零变化）。
5. **围栏**：绑定后 `resolveWorkspacePath` write 到主 checkout → warn 档返回原路径
   且违规入缓冲；enforce 档（env）→ 抛 PermissionDenied；写 worktree 内 → 放行；
   write 到 repoRoot 外第三方路径 → 维持现状放行（既有语义回归）；未绑定会话 →
   与改动前逐字节同行为；`ACODE_SESSION_WORKTREE_FENCE_OFF` → 全部放行。
6. **收割**：三条目（新鲜 / 老龄 clean / 老龄 dirty）+ 本进程在绑条目 → 只收老龄
   clean；分支保留、worktree 目录移除、ledger 落 tombstone(reaped)；dirty 条目
   材料在场；目录已丢 → tombstone(worktree-missing)。
7. **ledger**：折叠（bind+touch+tombstone 序）、多写方追加并发、压实触发。
8. **exec env 缝**：buildExecutionEnv 注入 provider 键、缺席键删除、overlay.set
   优先、provider 未注入零变化。

## 非目标 / 登记项

- dwf（CreateWorkflow 引擎）会话面集成、设置面「清理不活跃会话」UI、PR base 解析器、
  bash 子进程级围栏硬化、enforce 缺省化（触发条件见 R4）、shared runtimeEnv 键收编、
  跨进程「打开中」会话的强保护（现靠心跳新鲜度，见 R3）——全部登记，另立批次。
- 桌面（packages/desktop）与手机远控链路本批次零触碰：会话 worktree 是 CLI runtime
  域事实，desktop 面若消费走既有 CwdChanged/协议事件，不需要新协议命令。
