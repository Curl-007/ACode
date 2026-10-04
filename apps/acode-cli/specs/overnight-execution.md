# Overnight 挂机执行：时间闸状态机 + 交接协议 + 晨报（K3）

方案条目：`docs/k-series-upgrade-plan.md` §K3。机制参照 jcode (MIT)
`crates/jcode-overnight-core`（OvernightManifest / TaskCard / 相位计算，1471 行）与
`crates/jcode-app-core/src/overnight.rs:231-384`（run_supervisor 循环、三层时间点、
四种一次性 poke、run_turn_monitored），自撰 TypeScript 实现，未拷贝任何文件。

给 ACode 补「挂机跑活」形态：用户对主对话下达 `/overnight 8h` 类指令后，fork 一个隐藏
coordinator 任务连续自主执行到设定时刻——到点前 30 分钟收尾易交接、到点发晨报、醒后
宽限期内只做有界安全工作、宽限期尽发最终收尾。**与 off-peak 语义正交**：off-peak 是
服务器驱动的闲时算力排队（`packages/services/src/session/offPeakTaskService.ts` 一族），
overnight 是**本地进程内的长时执行模式**（桌面开着挂机），两者可组合（coordinator 可
选配 off-peak 模型）。

红线：**off-peak 体系零改动**；cron/automation 体系零改动；权限语义不放宽（overnight
会话沿用 J1 分级与既有 permission 管线，jcode「禁支付/发邮件/推远端/删数据」的运营
契约作为提示词约束而非新的权限层）；**不承诺关机续跑**——生命周期绑定 app 运行期
（见 R1），跨重启的 overnight 是远程 workspace/服务器形态的产品决策，登记不立项。

裁剪边界：不做 review.html（桌面 UI 直接渲染 markdown 任务卡片）；不做 use_current_session
模式（jcode 的第二种模式，让可见会话自管生命周期——ACode 的 UI 语义下隐藏 coordinator
更安全，可见会话可继续他用）；不接通知渠道（完成通知走既有 UI 通知面，邮件/IM 批准
回环属 bots 渠道后续）。

---

## 背景：已核实的现状与 jcode 参照

> ACode 行号以 dev/0.0.2 `7798f76` 检出为准。

### ACode 已有面

1. **任务 fork 链已有**：`packages/services/src/session/acodeTaskService.ts:701` 的
   `sourceTaskId`（从源任务建新任务、继承上下文）——overnight coordinator 的创建走
   既有 fork 语义，不新建任务通道；
2. **turn 后调度点模式已有**：memory extraction 挂成功 Main turn 后
   （`core/src/runtime/methods/turn.ts:703-708`，J3-2/K2 同款挂点先例）；
3. **runtime-task 可见面已有**：`core/src/runtime-task/registry.ts`（后台任务快照、
   终态判定、活跃探测）——overnight run 作为 runtime task 投影；
4. **bash 后台与超时策略已有**（`bash-background-lifecycle.ts`、`bash-timeout-policy.ts`）
   ——coordinator 的工作执行复用既有工具面，无新执行原语；
5. **资源快照能力**：Electron host 侧有系统信息面（`packages/desktop` 的 platform
   service）；CLI 进程可自采 `os` 模块内存/负载——preflight 快照采集走进程内 + 平台
   服务可选增强，不新建诊断体系。

### jcode 参照机制（只读提炼）

- **三层时间点**：`handoff_ready_at = target − min(30min, duration/4)`（收尾窗口）、
  `target_wake_at`（到点）、`post_wake_grace_until = target + 2h`（醒后宽限）；
- **四种一次性 poke**（一次性标志防重发）：handoff-ready（「别弃有用工作但让 run 易
  交接」）、morning-report（到点且未发）、post-wake-continuation（已发晨报且仍在宽限：
  只许 bounded 安全可验证工作）、final-wrapup（宽限尽，一次性，下次循环 mark_completed）；
  常规继续 prompt（未到点每轮 continuation）；
- **supervisor 循环**：每轮重读 manifest（支持跨进程 cancel）→ 判定该发哪个 poke →
  跑一轮 monitored turn → turn 后再判定（晨报标志/完成判定）；
- **monitored turn**：agent turn 上叠两个 ticker——5min 资源采样、30min「turn 仍在运行」
  事件（防僵死无观测）；
- **coordinator 创建**：fork 父会话全部 messages/compaction/provider 设置、关自动评审、
  复制 todos；
- **preflight**：跑前采集 usage 投影（risk/confidence/区间）、资源快照（RAM/swap/load/
  battery/disk）、Git 快照，写入 preflight 工件并注入 coordinator prompt；
- **运营契约**（prompt 声明）：优先可验证低风险工作（可复现 bug/回归测试优先），禁止
  品味类重构/支付/发邮件/推远端/删数据；「不要等用户」；swarm helper 只在期望值超过
  成本时用；
- **TaskCard**：before/after/validation 结构化卡片（id/title/status/priority/why_selected/
  verifiability/risk/outcome/followups），晨报与 review 的数据底座。

## 产品规则

### R1 生命周期与所有权

- **入口**：主对话消息级指令 `/overnight <duration>`（1 分钟–12 小时硬限；jcode 上限
  72h 是其本地 CLI 形态，ACode 桌面挂机场景收紧到 12h——单进程 bash/模型连接的可靠性
  窗口与内存稳态（renderer 内存泄漏修复记忆的 soak 结论）不宜拉到 72h）。解析复用
  既有 slash 指令通道；非法时长给可读错误；
- **coordinator**：经 `sourceTaskId` fork 隐藏任务（不进 UI 会话列表主视图，runtime-task
  投影可见），继承父任务 messages/compact/provider 配置；**独立 turn loop**——不占用
  用户会话的输入通道；
- **生命周期绑定**：overnight run 的 supervisor 状态（manifest）落**内存 + runtime-task
  快照**，不落盘跨重启续跑；app 退出（窗口关闭/进程终止）= run 终止，下次启动只读
  「上次 overnight 终止于 X 相位」的告警提示。理由：ACode agent 进程随 host 生命周期
  （AGENTS.md 进程模型章），跨重启续跑需要服务器侧任务形态，产品决策未做；
- **取消**：`/overnight cancel`（主对话）或 runtime-task 终止面——supervisor 每轮循环
  重读取消标志（jcode 跨进程 cancel 同款语义，ACode 单进程内为内存标志）。

### R2 manifest 与时间闸状态机

`core/src/overnight/manifest.ts`（纯数据 + 相位计算纯函数，对齐 jcode OvernightManifest
的 ACode 化裁剪）：

```ts
OvernightRunStatus = "running" | "cancel-requested" | "completed" | "failed"
OvernightManifest = {
  runId; parentTaskId; startedAtMs; targetWakeAtMs;
  handoffReadyAtMs; postWakeGraceUntilMs;     // 派生：R2 派生规则
  morningReportPostedAtMs: number | null;
  pokes: { handoffReady: boolean; morningReport: boolean; postWakeContinuation: boolean; finalWrapup: boolean };  // 一次性标志
  status: OvernightRunStatus;
  phase(): OvernightPhase;                     // running → wind-down → morning-report → post-wake → finalizing（纯函数，对齐 jcode overnight_phase）
}
```

- **派生规则**：`handoffReadyAtMs = target − min(30min, duration/4)`；
  `postWakeGraceUntilMs = target + 2h`（jcode 同值；ACode 不做配置面——三个时间点足够，
  配置项是拖延决策的借口）；
- **时钟源**：`Date.now()`（墙钟）判相位 + 单调钟（`performance.now()`）测 turn 时长/
  采样间隔——相位是用户可读的墙钟概念（「明早 8 点」），turn 监控是进程内间隔，两者
  不可混用（K1 R7 的时钟分轨原则复用）；app 睡眠（Windows 休眠）后墙钟跳进 → 相位
  自动前跳是**正确行为**（睡了 6 小时醒来就该发晨报），无需特殊处理，测试钉住；
- **supervisor 循环**（`core/src/overnight/supervisor.ts`）：
  `每轮：重读取消标志 → 计算 phase → 选 poke（未发且到时）→ 以对应 prompt 驱动
  coordinator 一轮 turn（monitored）→ turn 后更新一次性标志/晨报标志/完成判定 →
  未终态则等待（间隔 = min(下次相位点剩余, 60s)）→ 循环`；
- **完成判定**：finalWrapup poke 已发且下一轮循环 → `completed`；取消 → `cancel-requested`
  → 当前 turn 结束后 `completed`（带 cancelled 标记）；coordinator turn 连续失败 ≥3 →
  `failed`（复用 compact 的连续失败上限先例语义）。

### R3 四种 poke prompt + continuation（`core/src/overnight/prompts.ts`）

prompt 是**追加指令**形态注入 coordinator turn（作为用户侧消息），内容对齐 jcode 语义
的 ACode 化：

| poke | 触发 | 核心指令 |
| --- | --- | --- |
| （常规 continuation） | 每轮未到 handoff-ready | 继续当前工作；遵守运营契约；每完成一个任务卡片落盘 |
| handoff-ready | ≥ handoffReadyAtMs 未发 | 30 分钟内到点：不弃有用工作，但让 run 易交接（收尾进行中的、不再开大新线、更新任务卡片） |
| morning-report | ≥ targetWakeAtMs 且晨报未发 | 产出晨报（R5 结构）；发后记 morningReportPostedAtMs |
| post-wake-continuation | 晨报已发且 < grace | 只做有界、安全、可验证的小工作；不开新大线 |
| final-wrapup | ≥ grace 未发（一次性） | 最终收尾：更新全部卡片与总结，不再执行任何工作 |

一次性标志保证每种 poke **至多一次**；prompt 模板常量集中本文件，改模板即改行为
（prompt 变更走 spec 修订）。

### R4 monitored turn（防僵死可观测）

coordinator 每轮 turn 由 supervisor 的 monitored 包裹（`Promise.race` 形态，jcode
`tokio::select!` 双 ticker 的 JS 等价）：

- 30min turn 仍在运行 → 记 `overnight.turn_long_running` warn 事件（不中断——长任务
  合法，只保证可观测）；
- 每 5min 采样进程内存（`process.memoryUsage().rss`）记入 runtime-task 快照（趋势可查，
  不做阈值动作——内存治理是 host 侧职责，overnight 不越权）；
- turn 异常 → 计连续失败，≥3 触发 R2 failed。

### R5 任务卡片与晨报产物

- **任务卡片**：coordinator 的工作产物约定为 markdown 卡片落 workspace 下
  `.acode/overnight/<runId>/cards/<n>-<slug>.md`，frontmatter 结构化字段
  （id/title/status/priority/whySelected/verifiability/risk/outcome/followups——jcode
  TaskCard 字段的 markdown 化）；**落盘经既有 Write 工具**（coordinator 用工具写，
  走权限管线——不是引擎特权写）；
- **晨报**：`morning-report` poke 的回合产出 `.acode/overnight/<runId>/morning-report.md`
  （汇总卡片 + 时间线 + 花费 + 未尽事项），完成标志 = 文件存在（turn 结束后 supervisor
  探测；不存在则下轮重发 poke 前置提醒——一次性标志只在文件确认后置位，这是与 jcode
  「发 prompt 即置位」的**有意收紧**：jcode 晨报是 chat 消息天然落 transcript，ACode
  产物是文件，以文件为准）；
- **preflight**：run 开始前采集（进程内存/平台信息（IPlatformService 可用时）/当前 git
  分支与脏状态/usage 快照），写 `.acode/overnight/<runId>/preflight.md` 并注入首条
  coordinator prompt；
- **运营契约**（首条 prompt 声明，jcode 语义移植）：优先可验证低风险工作（可复现 bug、
  回归测试、日志排查），禁止品味类重构/支付/发邮件/推远端/删数据/动凭据；不要等用户；
  卡片先于代码（先记 why/risk 再动手）。

### R6 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| OvernightManifest | supervisor 实例（runtime 字段） | run（进程内） |
| phase 计算 | 纯函数 | — |
| coordinator 任务 | 任务存储（fork 创建，既有链路） | 持久（产物文件持久） |
| 卡片/晨报/preflight 文件 | workspace 文件系统（经 Write 工具） | 持久 |
| runtime-task 投影 | runtime-task registry（既有） | run |
| 取消标志 | supervisor 内存（`/overnight cancel` 写入） | run |

不变量：supervisor 是 manifest 唯一写者；一次性标志单调置位不回清；取消是协作式
（当前 turn 跑完才终态），不做 mid-turn kill（AGENTS.md「不能用超时掩盖同步问题」的
同族约束：kill 掩盖状态不一致）；产物只经工具写（无特权直写文件系统路径）。

## 常量（`core/src/overnight/constants.ts`）

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `OVERNIGHT_MIN_MS` / `OVERNIGHT_MAX_MS` | `60_000` / `12 * 3_600_000` | R1 |
| `HANDOFF_LEAD_MS` | `min(30min, duration/4)`（派生） | R2 |
| `POST_WAKE_GRACE_MS` | `2 * 3_600_000` | R2 |
| `SUPERVISOR_TICK_MS` | `60_000` | R2 |
| `TURN_LONG_NOTICE_MS` | `30 * 60_000` | R4 |
| `RESOURCE_SAMPLE_MS` | `5 * 60_000` | R4 |
| `MAX_CONSECUTIVE_TURN_FAILURES` | `3` | R2/R4 |

## 接口

core 新增：`core/src/overnight/{manifest,prompts,supervisor,constants}.ts`；
runtime 接线：slash 指令解析（`/overnight`）→ fork coordinator → supervisor 启动；
runtime-task 注册 `type: "overnight"`（registry 的 RuntimeTaskType 联合扩展一个值，
快照含 phase/卡片计数/内存趋势摘要）。**不新增协议命令**（ACode Protocol v4 零改动，
UI 经 runtime-task 既有投影面读取）。

## 验收场景

测试：`apps/acode-cli/tests/overnight-execution.test.mjs`（fake coordinator turn +
时钟桩）。

1. 指令解析：`8h` / `45m` / `90s` 合法；`0`、`13h`、负数 → 可读错误（边界含 12h 整）；
2. 相位纯函数：五相位在时间轴上的转移序列（running→wind-down→morning-report→post-wake
   →finalizing）逐一钉住；duration<2h 时 handoff lead 收缩为 duration/4；
3. poke 一次性：构造时钟桩使循环跨 handoff-ready 窗口多次 tick → handoff prompt 恰发
   一次；晨报标志在**文件不存在时不置位**、下轮重发前置提醒、文件落盘后置位（R5 收紧
   语义的行为钉住）；
4. 取消：`/overnight cancel` → 当前 turn 完成后 status=completed（带 cancelled），
   无 mid-turn kill（coordinator turn 正常收尾断言）；
5. monitored：时钟推进 35min turn 未完 → `overnight.turn_long_running` warn 恰一次
   （每 30min 一次）；内存采样间隔 5min 一次进快照；
6. 失败熔断：coordinator turn 连续 3 次抛错 → failed，不再发 poke；
7. fork 语义：coordinator 任务携带父任务 messages 投影与 provider 配置（mock 任务服务
   断言 create 参数）；
8. 运营契约在场：首条 prompt 含禁止清单与卡片优先声明（prompt 快照）；
9. 重启语义：supervisor 不存在（进程重启后）→ runtime-task 显示 terminated 告警，
   无残留定时器/无自动重启（单测以实例销毁+时钟推进断言零后续 turn）；
10. off-peak/cron/automation 域零命中（源码断言不改其文件）。

## 未做与取舍

1. **不跨重启**（R1）：登记未来演进——远程 workspace 形态（acode-server-cli）天然适合
   服务器侧 overnight，届时 manifest 落盘与 lease 语义与 K6/K7 的基建合并设计；
2. **不做 use_current_session 模式**：ACode 可见会话继续他用时被 overnight 指令劫持
   语义混乱；隐藏 coordinator 是唯一形态；
3. **不做通知渠道接入**（完成邮件/IM 推送）：bots 渠道（Telegram/Discord/飞书/微信）
   是现成载体，接入是渠道域的独立小项，不混入本项；
4. **不做 Windows 睡眠阻止**（SystemPowerManagement keepAwake）：桌面端宿主能力，
   归 desktop 包后续（本项只在 preflight 记录「系统可能入睡」提示）；用户挂机场景
   的电源设置引导进 UI 文案，不进引擎。
5. **review 产物不做 HTML**：桌面 UI 渲染 markdown 即可（AGENTS.md UI 边界）；
   jcode 的 review.html 深色主题是其 TUI 生态的 Web 侧展示，ACode 有原生 UI。

## 第三方归属

`core/src/overnight/` 文件头注明「机制参照 jcode (MIT)：crates/jcode-overnight-core
（三层时间点/四种 poke/TaskCard 字段）与 crates/jcode-app-core/src/overnight.rs
（supervisor 循环/monitored turn 双 ticker）」，自撰 TypeScript 实现。
