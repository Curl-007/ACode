# 编排验收闭环与迁移体验升级方案（2026-11，参照 Fynvra）

先落 Track A 批次 M0（验收度量基线）与批次 0（队长验收工具面），再按 in_review 态耦合推进宿主强制与验收可视化；Track B（Provider/MCP 配置导入）与 Track C（diff 渲染选型）与 Track A 正交，可并行立项。

本文是立项与实施提案，参照外部开源项目 Fynvra（Apache-2.0，Electron 桌面 AI coding workbench，约 9.4 万行 TS、188 个测试文件）的验收闭环设计。文中"新增/拟议"的接口、状态与工具均未实现，不代表行为已经存在。方法纪律遵循 EI-131（[engineering-invariants.md](../specs/engineering-invariants.md):242）：借契约与证据形状，不抄实现；先核对自身现状确认是真实差距；显式列出不做清单（§8）。

**基线与核查声明**：调查与核查基线 `dev/1.0.4` @ `49c0631e`（2026-11-02）。本文全部 file:line 已对该检出逐条抽查核实（17 项承重论断，15 项完全属实，2 项行号/路径漂移已在附录 A 修正）；实施时行号仍需复核。Fynvra 侧结论来自对其源码的独立只读调查；jev-judgment 校准工具在核查会话不可用，结论以源码证据为准，无工具校准概率。本文引用的 EI 编号（27 个）与 spec 文件名（11 个）已逐一确认存在于当前检出。

**与模块 spec 的关系**：本文是提案与路线图，不能替代模块 spec。每批次实施前先按 AGENTS.md 核心原则与 EI-137（契约冻结先行）落对应 spec，spec 独立提交后再实现。

## 1. 结论摘要

1. Fynvra 的 6 个编排特征里，4 个 ACode 已有等价或更强实现（§2）——照抄 Fynvra 会制造第二真源，违反 EI-2。
2. Fynvra 唯一真正领先的形态是编排闭环的**验收段**：宿主强制协调者只读、宿主提供受限 diff/检查入口、汇报态与合并态耦合、宿主自动唤醒空闲协调者。ACode 这四条全缺或半缺，拆为 G1–G8（§3）。
3. 落地分三个 Track：**A** 验收闭环（主线，批次 M0→0→1→2→3→4→5，约 7–10 个工作日）；**B** Provider/MCP 配置导入（Acode 已验证的真缺口，约 1–2 周，正交并行）；**C** diff 渲染与内嵌编辑器选型（与批次 4 汇合，单独立项）。
4. 两个前置裁决点：裁决点 1（run_checks 执行面，批次 0 前，§4.1 给出推荐）；裁决点 2（已停止队长的唤醒语义，批次 3 前，§4.2）。

## 2. 已核实的现状对照（不要重造）

| Fynvra 特征 | ACode 现状（证据，路径相对 `apps/acode-cli/packages/agent-teams-plugin/` 除非另注） | 判定 |
| --- | --- | --- |
| worktree 生命周期（create/status/diff/merge/remove/prune） | `src/worktree/{manager,merge,git,naming}.ts`：execFile 无 shell、60s 超时、`merge-tree --write-tree` 冲突预检（merge.ts:44-59）、失败回滚 `merge --abort` → `reset --merge`（merge.ts:61-68）、幂等 alreadyMerged/noChanges、保守清理带 keptReason（state/types.ts:22-29） | 已有，且比 Fynvra 更严 |
| 合并后仍可回看 diff 的提交对 | `MemberWorktree.baseCommit` + `lastMergedCommit` + `status:"merged"` + `mergedAt`（state/types.ts:12-30）已持久化在团队状态里 | 数据已有，缺读取入口（G2） |
| 一次任务多次尝试（Dispatch） | `TaskAttempt{id,seq,owner,startedAt,endedAt,outcome}`（state/types.ts:63-71）+ `activeAttemptId`/`attemptSeq` 防陈旧写（state/types.ts:88-91）+ `stale_attempt` 错误码（state/types.ts:170）+ reassign 失效当前 attempt | 已有 |
| 状态迁移集中校验（非法迁移返回错误不抛异常） | `state/machine.ts:15-35` TRANSITIONS 单一事实源 + assertTransition/canTransition + `tests/machine.test.ts` 穷举 (from, action) | 已有 |
| 消息注入的信任边界 | `src/trust-wrapper.ts`：4 空格缩进协议 + 列 0 框架行 + 三级信任词表（trust-wrapper.ts:15-30；比 Fynvra 的裸文本注入强一个量级） | ACode 更强 |
| 角色能力包 | AgentProfile + 派生配置链 + 插件模型覆盖 + live-refresh（[agent-teams-derived-config.md](../../apps/acode-cli/specs/agent-teams-derived-config.md)） | 部分有（G8） |

桌面侧已有团队只读投影：`packages/ui/src/v4/teamPanelModel.ts`（"宿主不解释插件状态"的受检投影，形状不符返回 null）+ `packages/ui/src/components/{TeamWorkflowCard,TeamTaskGraph,TeamStatusSummary}.tsx` + `packages/ui/src/app-shell/TeamSidePaneTasks.tsx`。缺的不是"呈现编排"，而是"呈现并执行验收"（G7）。

宿主机制储备（批次 2/3 直接复用，不新造）：

- `apps/acode-cli/packages/core/src/permission/service.ts:406-417`：disallowedTools 硬禁用前移到所有模式分支之前（yolo 不复活），策略地板 strictest-wins 并集。
- `apps/acode-cli/packages/core/src/subagent/peer-send-paths.ts:285`："Peer messages cannot resume stopped agents"——停掉的 agent 只能请协调者重派。
- `apps/acode-cli/packages/core/src/system-reminder/incoming-message.ts`：给活会话注入带信任声明的提醒文案层（含 permission-laundering 防线）；批次 3 需从消费方反查真正的注入调用点。
- `src/scheduler.ts:5-9`：现行唤醒是指令式的——"插件无法调用宿主 Agent 工具，唤醒的执行者是队长模型……wake 指令纯派生、无副作用，漏执行只延迟不破坏一致性"。

## 3. 真实差距（三组 8 项）

### A 组 · 验收闭环缺失（插件内可闭合）

**G1 · 没有「待验收」态，成员自述即终态** 🔴
`state/machine.ts:15-35`：`in_progress --update_done--> done`，`done: {}` 无出边（终态）。合并工具与任务状态完全解耦：`agent_teams_merge_member_worktree`（src/tools/worktree.ts）只写 `member.worktree.status = "merged"`（worktree.ts:66），不动 `task.status`。后果：任务可以 done 而代码从未合并，也可以合并了而任务还是 in_progress——没有单一事实源回答"这活验收了吗"。
Fynvra 对照（其 docs/ARCHITECTURE.md §6）：worker 汇报 succeeded 只置 in-review；只有 merge_worktree 才是 completed；只读/空改动任务也需经审查才 completed。

**G2 · 队长没有宿主提供的 diff 审读入口** 🔴
17 个工具（src/server.ts ALL_TOOLS = team/member/task/message/worktree/wait）里没有任何 review/diff 工具。队长要看成员改了什么只能 Bash 跑 `git diff`：走全量审批门、输出无界（EI-147 返回值累计成本）、且没有钉住 base/head——成员继续提交后，审的就不再是审过的那份。而 `baseCommit`/`lastMergedCommit` 已经存着了，只差一个读取口。

**G3 · 任务声明了验收命令，但没有宿主执行入口** 🔴
`TeamTask.verify?: string`（state/types.ts:96）+ `verify_required` 错误码（state/types.ts:182）说明验收命令是声明性字段，实际执行靠队长自觉用 Bash。Fynvra 的 run_checks 是协调者唯一的命令入口：带 CheckCommandPolicy 白名单、cwd 钉在 worker worktree、返回退出码 + 有界输出。

### B 组 · 强制层级与唤醒（需动宿主）

**G4 · 「协调者不写代码」是提示词纪律，不是宿主强制** 🟡
插件用 `memberAllowed:false` 做工具级鉴权（这是运行时强制，不是提示词——这点 ACode 做对了）。但队长会话本身仍持有全部 builtin 写工具（Write/Edit/Bash）。宿主侧机制齐备（permission/service.ts:406-417），缺的只是一个"协调者只读"预设把它接起来。

**G5 · 唤醒靠队长模型执行 SendMessage** 🟡
scheduler.ts:5-9 注释自认现状。宿主侧已有 system-reminder 注入面与 peer-send-paths，但 peer-send-paths.ts:285 明确停掉的 agent 不能复活。Fynvra 由宿主的协调者唤醒器（coordinatorWake）在收件箱出现 worker_done/question/escalation 且主 agent 空闲时合成 prompt 唤醒，不依赖模型自觉，且带防循环上限（MAX_REVIEW_PROMPTS=2、MAX_DELIVERY_ATTEMPTS=3）。

**G6 · 阻塞等待只有成员侧，没有队长侧** 🟡
`agent_teams_wait_for_work`（src/tools/member-wait.ts:76-85）+ `member.waitingUntil`（state/types.ts:55-60）让成员阻塞等活、调度器据此不重复唤醒。队长侧没有对应的 `wait_for_members(until:'any'|'all')`，也没有"成员提问立即返回"的防互等语义——Fynvra 的 wait_for_workers 遇 question/escalation 一到就返回，正是为了避免"提问的 worker 与等待的主 agent 互等"。

### C 组 · 呈现与度量

**G7 · UI 只能看不能验收** 🟡
§2 所列团队投影是只读的：counts、成员任务、任务图。没有 diff 查看、没有合并/打回动作、没有检查结果。Fynvra 对照（其 ARCHITECTURE §9.4）：`OrchestrationApi{snapshot, readWorkerOutput, reviewDiff}` + ChangesView。手机远控同样只拿到这个投影。

**G8 · 角色能力包不可导入导出；验收质量无度量** 🟢
Fynvra Role = 提示词 + Skills + MCP + 模型/思考档 + 工具策略 + 审批档位，单个 JSON 可导入导出。ACode 的 AgentProfile 有模型/工具/审批面，但插件成员固定用 `agents/member.md`。度量侧：Fynvra 用量页按 dispatch 归组算"一次验收通过率 / 平均尝试数 / 打回次数"；ACode 的 attempts/revisions/mergedAt 原始数据都在，缺投影（EI-142 同理：改验收流程前也该有基线数据）。

## 4. 两个前置裁决点

### 4.1 裁决点 1（批次 0 前）：run_checks 的执行面

背景：run_checks 是插件内的新命令执行面，而插件零 core 依赖（package.json 仅 `@modelcontextprotocol/server`；trust-wrapper.ts:22-24"插件独立承载，不依赖 @acode/core"），因此它看不到 PermissionService、策略地板与 bypass-immune 熔断器。

- **选项 A（推荐，修正版）**：只允许执行 `task.verify` 里预先声明的命令，fail-closed（EI-4），无 shell、cwd 钉在成员 worktree、超时上限（拟 10 分钟）、输出 ≤256 KiB。相对原提案的四点修正：
  1. **匹配语义从"前缀白名单"改为"规范化后整命令精确匹配"**（通配参数需在 verify 声明里显式列出）。理由：前缀白名单放行 `node`/`pnpm` 后，`node -e`、`pnpm exec` 即任意代码执行——前缀匹配的安全价值趋近于零。A 的真实价值在于**声明与执行分离 + 无 shell + cwd 钉死 + 超时 + 有界输出**，spec 必须如实这样写，不能包装成"白名单即安全"。
  2. **威胁模型写进 spec**：防的是队长模型的失误与提示注入漂移，不是恶意攻击者（队长本就在权限面内）；这是"以受限审批换有界面面"的显式 trade-off 裁决。未声明即 `verify_required` 拒绝。
  3. **Windows 语义**：execFile 无 shell 下 `pnpm.cmd`/`npm.cmd` 的解析规则要在 spec 定义（与 worktree/git.ts 的 execFile 惯例对齐）。
  4. **调用计数从第一天埋**（EI-142），为将来迁 B 留数据。
- **选项 B**：run_checks 做成宿主 core 工具 handler（走完整权限裁决与 blast-radius 门），插件只发指令。安全语义更正，但跨包接线、工作量 M–L，且与"插件独立承载"纪律冲突。不在批次 0 做；A 的调用数据支持后续是否迁 B 的决策。

### 4.2 裁决点 2（批次 3 前）：已停止队长的唤醒语义

"队长空闲"有两态：**回合内空闲**（system-reminder 注入面可用）与**已停止**（回合结束；peer-send-paths.ts:285 明确 peer 消息不能复活）。队长派完工大概率结束回合，成员数小时后 report_done 时唤醒目标很可能是停掉的会话——这是批次 3 最硬的问题，必须显式裁决：

- 选项 ①：宿主 auto-resume 复活队长会话（依赖 [turn-auto-resume.md](../../apps/acode-cli/specs/turn-auto-resume.md) 既有语义；须防重连/快照恢复重放成重复派工——世代号 EI-59 + 消息 ack + 存储层唯一约束去重 EI-22，不靠生成端约定）。
- 选项 ②：降级为 UI 显式提示"队长已停止，需人工唤醒"（EI-1 不静默），消息留箱不丢。

无论选哪个，"队长已停止时成员汇报"必须进批次 3 验收场景。

## 5. Track A · 批次实施（主线）

工时为评审修正后估算（原估偏乐观：spec 先行 + 穷举测试 + 负向断言 + 双链路验证的纪律成本）。

### 批次 M0 · 验收度量基线（前移，~0.5 天，风险极低）

原提案把度量放批次 5，但其自身引用的 EI-142 逻辑（改流程前先有基线）要求它先行：批次 1 上线后就没有"改前/改后"的一次验收通过率对照了。

- 只读扫描既有团队状态 JSON，投影"一次验收通过率 / 平均尝试数 / 打回次数 / 各任务验收耗时"；数据源 `attempts`/`revisions`/`worktree.mergedAt` 已全部落盘，只读投影不落第二份台账（EI-48），不上报（[no-telemetry.md](../../apps/acode-cli/specs/no-telemetry.md)）。
- 按 dispatch/attempt 维度归组，与 Fynvra 用量页的口径对齐，便于日后横向比较。

### 批次 0 · 队长验收工具面（G2 + G3，~1 天，风险低）

- **spec 落点（先行）**：新建 `apps/acode-cli/specs/agent-teams-acceptance-loop.md`，定义产品规则、状态所有者、接口、验收场景（AGENTS.md 核心原则：先 spec 后码）。
- 新增 `agent_teams_review_member_diff { teamId?, member, baseRef?, headRef?, statOnly? }`：`memberAllowed:false`；base 默认 `worktree.baseCommit`、head 默认成员分支 HEAD；返回 `{ branch, baseCommit, headCommit, files[], stat, diff }`；diff 按字节上限**整段丢弃 + 失步标记**（EI-97，不从中间截断结构化流）。
- 新增 `agent_teams_run_checks { teamId?, member, command }`：按裁决点 1 选项 A（修正版）语义执行。
- 两个工具都要求 `activeAttemptId` 匹配当前 attempt（复用 `stale_attempt`），旧尝试不能审新重试（对齐 Fynvra"验收与清理只认当前 dispatch"）。
- **约束**：新增文件 ≤400 物理行（architecture-policy.yaml:341-343，新文件零容忍）；`tools/tasks.ts`、`state/store.ts` 已贴近上限，新工具放新文件。
- **验收场景**：① 成员有未合并提交时 review 返回钉住的 base/head；② 成员在 review 之后又提交，再次 review 的 head 变化且旧 head 可显式指定；③ 命令不在 verify 声明 → `verify_required` 且不执行（负向断言测试，仿 `apps/acode-cli/tests/no-telemetry.test.mjs` 模式，落插件 `tests/*.test.ts`）；④ 输出超限 → 截断 + 失步标记；⑤ 陈旧 attempt → `stale_attempt`；⑥ 测试穷举跨边界分支（EI-21）。

### 批次 1 · in_review 态与合并↔任务耦合（G1，~1–1.5 天，风险中）

- **spec 落点**：同 `agent-teams-acceptance-loop.md`（R2 起）。
- `TaskStatus` 增 `in_review`（state/types.ts:4）；TERMINAL_TASK_STATUSES 不含它。
- `machine.ts` TRANSITIONS 扩表：`in_progress --update_done--> in_review`；`in_review --accept(merge)--> done`；`in_review --reject(reassign)--> todo`；`in_review --update_failed--> failed`。迁移表是唯一事实源，工具层不得旁路改状态（沿用现有纪律）。
- 合并工具与任务状态耦合：`agent_teams_merge_member_worktree` 成功后，把该成员名下处于 `in_review` 的任务迁到 `done`；无 `in_review` 任务时显式告知"合并了但没有待验收任务"（EI-1 禁止静默降级）。
- 打回：`reassign_task` 接受 `from: in_review`，失效当前 attempt、递增 attemptSeq、写 TaskRevision，worktree 保留（成员在同一棵树里改，对齐 Fynvra reject_work）；受 maxReassignRounds 限（默认 3，越界 `reassign_limit_exceeded`）。
- 团队归档/暂停：`in_review` 视为未完成，归档时显式列出（EI-36 默认只删记录不删数据；EI-52 删除前先拍快照）。
- **（评审增补 P2）agent-facing 文档面同批同步**：`docs/usage.md`、`docs/protocol.md`、队长/成员提示词、以及 `agent_teams_update_task` 等相关工具的 description 文本——现有 description 教模型"done 是终态"，不改则模型行为与新状态机分裂（全局规范 §4：接口变化同步受影响入口与文档）。
- **（评审增补 P3）存量兼容裁决写进 spec**：旧状态 JSON 的值域是新值域子集，直接可读、无需迁移；**不支持向下混跑**——旧版插件读到 `in_review` 应显式报错而非静默当 `todo`（fail loudly）。归档扫描、TERMINAL_TASK_STATUSES 消费点、面板冷恢复（TeamState.seq 差量）逐一列受影响清单。
- 幂等/崩溃窗口：合并已落地但状态未写盘的场景沿用先例（tools/worktree.ts:66"幂等：alreadyMerged 也补写记录"）：`store.withLock` 内读-改-写，磁盘是唯一真相（EI-40 原子写、EI-12 at-most-once）。
- 面板与 UI 投影同步加 `in_review` 分组（panel-state.ts + packages/ui/src/v4/teamPanelModel.ts + 团队卡），中英文案同批（EI-107）。
- **验收场景**：① update_task(done) 从 in_progress 落到 in_review 而非 done；② 穷举 (from, action) 测试证明"未合并就 done"的路径不存在；③ 合并成功 → 关联任务 done + baseCommit..lastMergedCommit 提交对可查；④ 合并冲突 → 任务留在 in_review，主工作区已回滚；⑤ 打回 → todo + attempt 失效 + worktree 保留 + 轮次计数 +1；⑥ 超轮次 → `reassign_limit_exceeded`；⑦ 归档时 in_review 任务被显式列出而非静默丢弃；⑧ 旧状态文件可被新版直接读取（兼容回归）。

### 批次 2 · 协调者只读预设（G4，~1 天，风险中）

- **spec 落点**：扩 [subagent-policy-floor-inheritance.md](../../apps/acode-cli/specs/subagent-policy-floor-inheritance.md) / [managed-policy-floor-and-bypass-immune-breakers.md](../../apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md)（先读真源，EI-2 不复制规则）。
- 为队长会话注入 `disallowedTools = {Write, Edit, ApplyPatch, NotebookEdit, ...}`，走 permission/service.ts:406-417 的既有硬禁用位次（所有模式分支之前，压不过既有 deny，yolo 不复活）；策略地板 strictest-wins 并集保证用户显式配置优先级更高（EI-149 逃生阀只能是用户显式配置；EI-152 默认值三级）。
- 必须可见（EI-1 + EI-17）：队长的系统提示词与首次工具拒绝都说明"协调者会话不写代码，写工具已按团队协议禁用；需要改动请派成员"，中性语言描述保留了什么，不描述为错误。
- fail-closed 裁决（EI-4，写进 spec）：身份解析失败（identity.ts 拿不到 captain 凭据）时不降级为可写，保持只读并报 `identity_missing`。
- 风险：与 plan mode、auto-mode risk classifier、技能激活期 deny（service.ts:419-427 同位次）叠加可能产生双重拒绝或矛盾文案 → spec 画出裁决优先级链，并对每种模式 × 队长/成员做穷举测试（EI-21）。
- **验收场景**：① 队长调用 Write 被拒且拒绝理由可读、含"派成员"指引；② 成员不受影响；③ 用户在设置里显式放开 → 生效（逃生阀可验证）；④ 身份缺失 → 只读 + `identity_missing`；⑤ plan/auto/yolo 三模式下行为一致且各有测试。

### 批次 3 · 宿主自动唤醒与队长侧等待（G5 + G6，~2–3 天，风险高）

- **spec 落点**：[agent-peer-messaging.md](../../apps/acode-cli/specs/agent-peer-messaging.md) / [agent-peer-messaging-cross-process.md](../../apps/acode-cli/specs/agent-peer-messaging-cross-process.md) / [subagent-pending-message-drain.md](../../apps/acode-cli/specs/subagent-pending-message-drain.md) / [turn-auto-resume.md](../../apps/acode-cli/specs/turn-auto-resume.md)（先读，判断是扩还是新立）。
- 宿主侧协调者唤醒器：团队邮箱出现 worker_done/question/escalation 等价消息且队长空闲时，合成一条注入 prompt 唤醒（复用 system-reminder 注入面 + trust-wrapper 边界，**不降级信任协议**）；队长忙碌时消息留箱，回合结束后再投（对齐 CommandInbox 串行 admission，Renderer 只留 pending overlay）。借鉴 Fynvra coordinatorWake 的防循环上限（唤醒 prompt 内带 next-step 提示与最大审查/交付尝试次数）。
- **（评审增补 P4）唤醒目标两态**：回合内空闲 → 注入提醒；已停止 → 按裁决点 2 执行。"队长已停止时成员汇报"是验收场景。
- 停了的成员：保留 peer-send-paths.ts:285 现有语义（不用 peer 消息复活已停 agent），但把"请队长重派"升级为宿主可执行的重派动作，并在 UI 显式提示，不静默丢弃（EI-1）。
- 队长侧 `agent_teams_wait_for_members { until:'any'|'all', timeoutMs }`：成员提问一到就立即返回（防互等死锁）；超时返回 `timedOut:true` 而非错误；timeoutMs clamp 到有界区间（EI-6）。
- **双链路硬要求（AGENTS.md）**：desktop-continuous 实时链路与 web-remote-replayable 恢复链路同时验证。断线重连/快照恢复后，唤醒不得重放成重复派工——世代号防旧请求覆盖新状态（EI-59），消息带 ack，投递去重落存储层唯一约束（EI-22），不靠生成端约定。
- 不做：不为手机另起 Agent / Local Host / 远程会话；不动 owner/lease 与 stale run 防护（AGENTS.md："不能仅根据单一路径删除边界判断"）。
- **验收场景**：① 成员汇报 → 空闲队长被自动唤醒且消息带信任框架；② 队长忙碌 → 消息留箱、回合后投递、不重复；③ 成员提问时队长的 wait(until:'all') 立即返回；④ 重连后不产生第二次派工（世代号/ack 证据）；⑤ 手机远控下同一语义成立；⑥ 已停成员 → 显式"需重派"而非静默无响应；⑦ 队长已停止 → 行为符合裁决点 2 的裁决。

### 批次 4 · 验收面可视化（G7，~1–1.5 天，风险中）

- **spec 落点**：`packages/ui/specs/` + `packages/shared/specs/`；协议改动只进 `packages/shared/src/acode-protocol-v4/`（新命令/事件只进 v4，严格类型 + 运行时校验）；legacy `acode-protocol/index.ts` 只删不增，本批不碰。
- 新增 v4 事件/命令覆盖"任务进入待验收 / diff 可查 / 检查结果 / 合并或打回结果"；UI 在团队卡上提供 diff 查看与验收动作入口，走 `packages/ui/src/hooks/` + `IPlatformService`（禁止 UI 直连 Service、直接调 `window.acode`）。
- 合并后仍可回看 diff：读 `MemberWorktree.baseCommit..lastMergedCommit`，**不拿主仓库当前 HEAD 代替成员提交**（这是 Fynvra 修过的坑，直接借契约形状）；两者已清理且无历史范围时明确报不可用，不编造（EI-9 能力声明必须诚实）。
- **（评审增补 P7）diff 渲染选型是本批 spec 的显式裁决**：MVP 用结构化文件列表 + 截断 unified-diff 文本（零新依赖）；增强态引入 CodeMirror merge view，与 Track C 合并为一个选型决策，避免两次引依赖。
- 治理硬约束：godComponentLineRatchet 只减不增（新增分区叶子，不塞进 TeamWorkflowCard）；400 行 ratchet；DESIGN.md token；EI-98~101 反馈分级/通道矩阵/toast 边界/空态给出路；EI-111 长列表分组折叠；移动端与桌面布局都要顾；中英文案同批。
- 不做：不把编排状态做成第二真源——UI 只持有投影，插件团队状态 JSON 仍是权威（EI-48 真实源与派生索引分离；teamPanelModel.ts 头注"宿主不解释插件状态"的受检投影模式不变）。

### 批次 5 · 角色能力包（G8 前半，~0.5–1 天，可选）

- 让插件成员支持按角色引用 AgentProfile（提示词 + Skills + MCP + 模型/思考档 + 工具策略 + 审批档），沿用 [agent-teams-derived-config.md](../../apps/acode-cli/specs/agent-teams-derived-config.md) 的派生配置链与 live-refresh，不新造第二套角色存储（EI-2）；导入导出走既有配置文件形态，可稳定 id 作键（EI-144）。度量投影已在 M0 前移，本批只补"按 dispatch 维度归组"的展示。

## 6. Track B · Provider/MCP 配置导入（~1–2 周，正交并行）

- **缺口已验证**：全仓 cc-switch/ccswitch 0 命中；`packages/provider-node/src/` 只有 builtin 物化（acode-builtin-*）与 legacy 迁移（legacy-reasoning-level*），无外部工具 provider 配置导入。注意与会话历史导入（`packages/services/src/session/external-import/adapters/` 已有 claudeCode/codex/cursor/geminiCli/opencode 五家）是两回事，后者不覆盖本缺口。
- **Fynvra 参考模板**（Apache-2.0，允许带署名移植/改写；保留版权声明、记录改动）：三层结构 `locate`（定位本机配置）/ `readers`（纯函数解析）/ `scan`（指纹去重编排）。readers：Claude Code `~/.claude/settings.json`（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN||ANTHROPIC_API_KEY`，忽略 default/sonnet/opus 别名）；Codex `config.toml` + `auth.json`；CC Switch SQLite（复制到临时目录再读，按 app_type/apiFormat 映射协议）。
- **ACode 落点**：`packages/provider-node` 新增 external-import 域（architecture-policy 模块声明同步）；密钥只写 `packages/provider/src/provider-api-key-vault.ts`，明文不出 Node 端；去重按 providerFingerprint（baseUrl+key）标 `duplicate:'existing'|'candidate'`；view 逐字段构造脱敏（hasApiKey/apiKeyHint 形状），不展开 input；单来源失败只产生该来源 warning；候选明文缓存 Node 端 TTL + 候选 id 回换（Fynvra IMPORT_CACHE_TTL_MS 模式）。
- **MCP 面**：`packages/services/src/mcp-sync/` 补 reader 面（cursor/gemini/opencode/vscode/cc-switch，jsonc 解析带注释 JSON），接入既有 candidate/import 通道，不新建第二套 MCP 配置真源。
- **spec 落点**：新建 `docs/specs/provider-config-import.md`（来源清单、指纹规则、密钥只落 vault、脱敏视图契约；负向验收：明文 key 不出现在任何 IPC 返回值、视图、日志与导出中）。
- **凭据安全约束**：只从环境变量或密钥服务（vault）读取凭据；源码、示例与测试不写入可用的凭据字面量，夹具一律合成。

## 7. Track C · diff 渲染与内嵌编辑器选型（与批次 4 汇合）

- 现状已验证：全仓无 monaco/codemirror 依赖；桌面只有 `packages/desktop/src/main/openInEditor.ts` 外链编辑器 + GitPane diff 卡片。
- 建议：批次 4 先用零依赖 unified-diff 文本 MVP 验收闭环；是否引入 CodeMirror 6（Fynvra 用 `@uiw/react-codemirror`）做 merge view / 通用编辑，单独立项决策——涉及 DESIGN.md、i18n、手机布局与 bundle 体积，投入 3–6 周量级，先由 MVP 验证验收闭环的实际使用价值再定。
- 不做：不为 review 场景引入第二套编辑器栈。

## 8. 不做清单（EI-131 强制要求）

1. **不搬 Fynvra 的进程模型**：Electron Main 作权威 + utilityProcess 托管多会话 + IPC 通道方案，与 ACode 的 stdio CLI、Host attachment、owner/lease、远程连接注册表冲突。只借"identity + seq 防 stale run"这类局部契约形状。
2. **不新增第四套 worktree 域**：已有 workflow 域、session 域、agent-teams 插件域三套，靠命名空间前缀分域（[session-worktree-lifecycle.md](../../apps/acode-cli/specs/session-worktree-lifecycle.md) R1 已裁决）。本方案全部落在插件域，不新建命名空间、不跨域扫描删除。
3. **不搬 vcs:'none' in-place 模式**：ACode 已有自己的答案（团队不开隔离即共享工作区，`worktree_disabled` 错误码显式告知）。
4. **不搬 pi SDK 的事件归一化与 jsonl 权威源**：ACode 的权威源是协议 v4 + session 存储，两个面不同源。
5. **不动 legacy 协议面**：`packages/shared/src/acode-protocol/index.ts` 只删不增，按 [legacy-protocol-convergence-plan.md](../legacy-protocol-convergence-plan.md) 里程碑退役。
6. **不为手机另起 Agent / Local Host / 远程会话；不动 owner/lease 与 stale run 防护。**
7. **不把 Fynvra 的 10 个编排工具名照搬成 ACode 工具名**：新增沿用 `agent_teams_*` 前缀域（EI-146 接口面克制，不新增语义重复的工具）。
8. **不把 trust-wrapper 换成 Fynvra 的裸文本注入**：ACode 现有缩进协议更强，降级即事故。
9. **（评审补充）不在 UI 或宿主造第二套编排状态机、第二套角色存储、第二份度量台账**（EI-2、EI-48）。

## 9. 全局硬约束与门禁

- **架构**：maxFileLines 400 / maxContractLines 300 / maxPublicMethods 12（architecture-policy.yaml:341-343），新文件零容忍；`state/store.ts`、`tools/tasks.ts` 已贴上限 → 新增能力放新文件。UI 侧 god component ratchet 只减不增。
- **每批门禁**：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm --filter @acode/agent-teams-plugin test`；推送前 `pnpm verify:pre-push`。真实报告结果，不把已有失败写成通过。
- **测试纪律**：关键不变式用测试钉死（EI-120）——迁移表穷举、跨边界事件两侧穷举（EI-21）、负向断言（不该执行就一定没执行）、固定时钟与内存态隔离（EI-121）。
- **分支**：`feature/cli-agent-teams-acceptance-loop` 等，切自当前 dev 分支，squash 合入（[git-collaboration.md](../git-collaboration.md)）。
- **提交粒度**：spec 先行独立提交（EI-137），再实现；一个提交只做一件事。

## 10. 路线图总览

```
Track A 主线（约 7–10 个工作日，串行）
  M0 度量基线(0.5d) → 批次0 验收工具面(1d) → 批次1 in_review 耦合(1–1.5d)
  → 批次2 协调者只读(1d) → 批次3 宿主唤醒+队长等待(2–3d) → 批次4 验收可视化(1–1.5d)
  → 批次5 角色包(0.5–1d, 可选)
  [裁决点1 在批次0前 · 裁决点2 在批次3前]

Track B Provider/MCP 导入（约 1–2 周，与 A 并行）    Track C 编辑器选型（批次4 处汇合）
```

目标态的所有者与事件顺序（AGENTS.md：涉状态/时序方案用图展示）：

```
队长会话（CLI runtime）★团队状态机唯一权威 = 插件状态 JSON（磁盘唯一真相，store.withLock 读改写）
  │ 派工 SendMessage ────────────────┐        ▲ 唤醒（批次3 宿主注入器：
  │                                  ▼        │   回合内空闲→system-reminder 注入；
  │                            成员会话       │   已停止→裁决点2：auto-resume 或 UI 显式人工）
  │                                  │ 插件域 worktree 干活
  │                                  ▼
  │                            成员 worktree（baseCommit 建树时钉住）
  │                                  │ report_done
  │                                  ▼
  │                            task: in_review（批次1；汇报≠验收）
  │  review_member_diff（baseCommit..head 钉住，attempt 匹配）
  │  run_checks（verify 声明精确匹配，cwd 钉 worktree，有界输出）
  │      ├─ 通过 → merge_member_worktree（--no-ff；baseCommit..lastMergedCommit 固化）
  │      │         → task: done → 保守清理（keptReason；diff 凭固化提交对仍可查）
  │      └─ 不通过 → reassign（attempt 失效、seq++、worktree 保留）→ task: todo
  ▼
投影链（只读，EI-48）：panelState → v4 通用插件状态通道 → teamPanelModel 受检投影
  → 团队卡 / Side Pane（desktop-continuous 实时链路）
  → web-remote-replayable 快照重放（手机，同一投影面，不另建链路）
```

## 附录 A · 证据核查记录（2026-11-02，基线 49c0631e）

核查方法：两路独立只读调查（Fynvra 源码 / ACode 现状）+ 主线对全部承重论断逐条 file:line 抽查。jev-judgment MCP 工具在核查会话不可用（插件需配置 TypeSafe API key 后新开会话），未使用工具校准概率，结论以源码为准。

**核实属实（15 项）**：machine.ts TRANSITIONS 与 done 终态；merge 工具只写 worktree.status（worktree.ts:66）；17 工具无 review/diff/checks（server.ts ALL_TOOLS）；MemberWorktree.baseCommit/lastMergedCommit/keptReason；TaskAttempt + activeAttemptId/attemptSeq + stale_attempt；TeamTask.verify 与 verify_required；permission/service.ts:406-417 disallowedTools 硬禁用位次（注释与引用逐字一致）；scheduler.ts:5-9 指令式唤醒注释；peer-send-paths.ts:285（行号精确）；member-wait.ts:76-85 仅成员侧等待；插件零 core 依赖 + trust-wrapper.ts:22-24；merge.ts:44-68 merge-tree 预检与回滚兜底；UI 团队只读投影存在（teamPanelModel.ts + TeamWorkflowCard/TeamTaskGraph/TeamStatusSummary + TeamSidePaneTasks）；EI-131 原文（engineering-invariants.md:242）；架构 ratchet 数值（architecture-policy.yaml:341-343）。另：本文引用的 27 个 EI 编号与 11 个 spec 文件名全部存在。

**漂移修正（2 项，正文已按修正后引用）**：

1. 原提案引用的 `types.ts` 实为 `src/state/types.ts`；`verify_required` 在其 182 行（原写 157）；TRANSITIONS 起于 machine.ts:15（原写 17/22）。
2. `system-reminder/incoming-message.ts:8` 处是注入文案与信任声明层（PEER_REPLY_GUIDANCE 等），非注入通道本身；批次 3 落 spec 时需从消费方反查真正的注入调用点。

## 附录 B · 值得借鉴的 Fynvra 设计点速查（源路径相对 fynvra 仓库根）

| 设计点 | Fynvra 源路径 | 用于本方案 |
| --- | --- | --- |
| mergedDiff {baseCommit, headCommit} SHA 固化，清理/重启后 diff 仍可查、不拿主仓库 HEAD 冒充 | `src/main/services/orchestration/queries.ts`（reviewDispatchDiff）+ Task.mergedDiff | 批次 4（ACode 数据已在，补读取口） |
| Task/Dispatch 分离：打回 = 同一 worktree 新建权威尝试，settleDispatch 只结算一次 | `packages/core/src/orchestration/transitions.ts` | 批次 1（对应 attempt 语义） |
| coordinatorWake：收件箱驱动、空闲才唤醒、prompt 带 next-step 与防循环上限（MAX_REVIEW_PROMPTS=2 / MAX_DELIVERY_ATTEMPTS=3） | `src/main/services/agentHost/coordinatorWake.ts` | 批次 3 |
| protectedCommand 底线：rm -rf / git push / reset --hard / publish 任何审批档位都要人确认，allowSession 不豁免 | `packages/agent-runtime/src/approval/protectedCommand.ts` | 横切核对项：对照 ACode permission 引擎（apps/acode-cli/packages/core/src/permission/）确认有无等价物，缺则补 |
| worker brief 五段模板（Target/Change/Constraints/Ownership/Acceptance）+ report_done 契约 | `packages/core/src/briefs/renderBrief.ts` | 横切核对项：与 dispatch-discipline-prompt.md 对照融合 |
| 保守清理规则：只清理已验收/已放弃，清理前检查干净且无未合并新提交 | `src/main/services/orchestration/worktreeCleanup.ts` | ACode 已有等价物（keptReason），不搬 |
| Provider 导入三层结构 + 指纹去重 + 明文缓存 TTL + 候选 id 回换 | `src/main/services/providers/import/{locate,readers,scan}.ts`、`src/main/services/mcp/import/mcpImporter.ts` | Track B 实现模板 |
