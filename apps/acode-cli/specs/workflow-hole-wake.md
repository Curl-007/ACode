# ACode：workflow hole 中途唤醒（hole-wake）

状态：**立项（2026-10-11）**，未实施。前置事实见 `specs/workflow-holes.md`
「实机验证与已知缺口」节（二次排查修正版）。

## 问题陈述

hole-reached 是中途态：终态通知（run-settled → background-tasks 的
workflowNotification → 新 turn）只覆盖结算，洞停靠时**没有任何机制唤醒
orchestrator**。实机表现：发起 turn 正常结束后 run 停驻，填充只能等用户手动
新 turn 介入；自动化场景（off-peak、bot、无人值守）hole 永久停驻。
FillWorkflowHole 的 alwaysAsk 批准门与 wake 正交：wake turn 仍可能停在批准卡
（安全语义保留，用户点批准；本文不放宽）。

## 产品规则

1. **唤醒条件**：run 到达 hole 且该 run 的 origin session 当前**无在飞
   orchestrator turn** 时，铸一条 hole-wake 通知并自动开启一个 orchestrator
   turn（系统源输入，UI 可标注来源）。在飞 turn 存在时不 wake——在飞 turn 本就能
   经 GetWorkflowRun 的 pendingHoles 发现面自行处理（避免双驱动）。
2. **去重与幂等**：每个 journal `hole-reached` 事件至多铸一次 wake。cast 事实以
   新 journal 事件 `hole-wake-cast`（payload 含 reached 事件 sequence）落盘——
   冷恢复/进程重启重放 journal 时据此跳过已铸的 wake，不会每次开会话重复唤醒。
3. **失效即弃**：cast 前复查等待事实（`hole-filled`/`run-settled`/stopped 已出现
   则不铸）；wake turn 启动后再失效由 FillWorkflowHole 的结构化拒绝兜底
   （hole_not_waiting），不新增补偿路径。
4. **循环洞**：loop 内每轮 reach 是新的 reached 事件 → 每轮一次 wake；run 结算后
   不再 wake。
5. **路由**：wake 只投给 run 的 origin session（owner token/lease 既有纪律）；
   bot/off-peak 派发的 run 同样适用（无人值守正是本特性主受益面），但派发上下文
   已结束的 run 不 wake（无活 orchestrator 可唤醒，停驻事实留给 Resume 链）。
6. **准入**：wake turn 走既有 CommandInbox 准入（queue/interrupt 设置语义不变）；
   与用户输入竞争时按既有排队纪律，不插队。

## 状态所有者

- 等待事实：journal `hole-reached / hole-filled / run-settled`（既有，唯一事实源）。
- wake cast 事实：journal `hole-wake-cast`（新增事件类型，双轨记录与引擎 record()
  同纪律：journal + 进度事件）。
- caster：cli-workflow run service 内、与终态通知同一条 journal Watcher 扩展
  （终态检测在 core background-tasks 消费 run service 暴露的结算事实；hole-wake
  的检测点放在 run service，因为它持有 registry + journal，能复查在飞 turn 状态由
  core 侧传入的会话活性谓词）。
- 在飞 turn 判定：core runtime 的 session turn 状态（既有），经 deps 注入谓词，
  run service 不直接读 runtime 内部。

## 接口

- 实施定稿（2026-10-11）：wake 铸在**进度汇**（core `recordDynamicWorkflowRunProgress`
  的 `notifyHoleWaiting`，与 escalation/stall 同层同纪律）——进度汇是唯一同时看得见
  run 事件与 AgentRuntime 的地方；hole-reached 经引擎双轨的进度载荷到达（eventType
  透传），每 reach 恰好一条通知。通知走既有 `enqueueBackgroundTaskNotification`
  管线：空闲会话自动开轮、在飞回合作为 run 中情报追加（后者比原 spec 的「在飞不
  wake」更优：在飞 turn 可立即填，无需等 turn 结束）。
- 通知载荷：shared `workflowNotificationMetaSchema` 新 kind `hole-waiting`
  （holeId≤80 / ordinal / stage≤4000 / prompt≤4000，与 pendingHoles 同界）；contracts
  mirror 联合同步。renderer 只特判 terminal，新 kind 走通用通知行（降级安全）。
- 文案：`formatWorkflowHoleWaitingNotification`（workflow-notification-copy.ts，
  escalation 同族：系统通知头 + XML-ish 节转义 + 散文下一步逐字 hole_ref）。
- **延期项**：journal `hole-wake-cast` 事件与冷恢复 restore-wake 未实施——进度事件是
  live-only，进程重启后 parked run 不自动 wake（UI hole chip / ListWorkflowRuns /
  GetWorkflowRun pendingHoles 仍可发现并人工或新 turn 介入）。restore-wake 需要
  attach 时 journal 扫描 + cast 台账，独立批次再做；验收场景 4 的「无 wake-cast 且仍
  在等 → 恰好一次 wake」在该批次实现前不成立，如实标注。
- **live wake E2E 状态（2026-10-11）**：未跑通，原因是测试战役的环境污染而非代码——
  反复 dev 重启留下 zombie run 与旧 agent 进程，CreateWorkflow 报
  「Workflow session owner lease is held by another process」拒建新 run。wake 链的
  可信度由三层组成：formatter/边界单测、进度汇接线源码断言、以及 hole-reached 与
  stall/escalation 共用同一条进度汇→enqueueBackgroundTaskNotification 生产先例。
  干净环境（无 zombie lease）下的 live 验收留待提交后首轮实机补跑。
- **新发现（2026-10-12，独立立项候选）**：workflow session owner lease 在 owner 进程
  死亡后**未观察到回收**——zombie run（owner 已死）仍让同会话的 CreateWorkflow 报
  「lease is held by another process」，干净重启后的新进程也拿不到租约。多进程安全是
  lease 的存在理由，但死 owner 的回收（pid 活性探测 / owner_generation 超时 / 显式
  release 台账清理）缺失会把一次崩溃变成长期阻塞。本批次不修（安全面语义需独立设计），
  登记待立项；live wake 验收亦被它挡住第二次。

## 验收场景

1. turn 结束 + hole 到达 → ≤5s 内 wake turn 自启，上下文含 hole_ref；合规 agent
   填洞（批准卡人工点）→ run settled completed，journal 序：
   reached → wake-cast → filled → settled。
2. hole 到达时在飞 turn 存在 → 无 wake-cast 事件、无额外 turn。
3. reach 后、cast 前 run 被 stop → 无 wake-cast、无 wake turn。
4. 进程重启后会话冷恢复，journal 已有 wake-cast → 不重复 wake；无 wake-cast 且
   仍在等 → 恰好一次 wake。
5. loop 洞两轮 reach → 两条 wake-cast、两个 wake turn；第二轮 fill 后 run 结算，
   无第三条。
6. wake turn 与用户键入竞争 → 按 queue 设置排队，不丢用户输入。

## 风险与不做

- 动 turn/queue 不变量是本项目最大风险：wake 只**复用**既有通知→turn 管线，不新
  建 turn 启动路径；实施首日核实通知管线的 session 活性与 owner/lease 边界。
- 批准卡停驻 wake turn 是预期行为（安全优先），不做自动批准。
- 不改「parked run 不吊住 turn」语义；不做 hole 的 UI 重设计。
