# turn-auto-resume：跨回合临时性故障自动恢复

> 来源与许可：机制设计移植自 https://github.com/cv-superding/zcode-auto-resume
> （MIT, zcode-auto-resume contributors；其分类/退避思路源自 dsh-auto-continue, MIT）。
> 只搬机制，不复制代码与文案；原项目载体（Stop/UserPromptSubmit hook 注入、客户端
> 重试表补丁脚本）作废——ACode 原生落 core runtime，失败路径本身就是结构化事件。

## 分层定位（与源项目的差异，立项对照结论）

ACode 已有四层恢复，本 spec 只补第五层：

1. 请求内 adapter 重试：10 次 / 基数 2s / ×2 / 上限 60s / jitter / Retry-After 优先
   （`adapters/src/model/retry-policy.ts:13-30`，env 可配）——**无需再调**（源项目把
   2 次/3s 补到 9 次/~4min 的诉求 ACode 默认已更强）。
2. turn 内流恢复：`streaming-recovery.ts`（10 次，瞬态闭集）。
3. turn 内截断续写：`turn-output-token-continuation.ts`（finish reason 结构化判定，
   3 次）——源项目「未闭合代码块/尾部省略号」文本启发式**不重建**，原生更强。
4. 空响应重试：`empty-completion-retry.ts` + `model-errors.ts:67-103` 兜底——同上。
5. **跨回合 auto-resume（本 spec 新增）**：上述层全部耗尽、turn 以 TurnError 失败后，
   按分类与退避自动注入继续指令开新 turn。

## 分类（结构化闭集主判据，无文本正则）

判定输入 = turn 失败的结构化归因：`coreError.context.reason/retryable/statusCode`
（`helpers/turn-errors.ts:187-205`）、`SessionErrorClass`（`contracts/src/errors/reasons.ts:131-144`）、
`ModelRetryReason/ModelFailureReason`（`contracts/src/model/request-status.ts`）。

| 判定 | 条件 | 行为 |
| --- | --- | --- |
| transient | SessionErrorClass ∈ {rate_limit, network, timeout}，或 model_error 且 retryable ≠ false，**或 attribution.retryable === true**（adapter failure-classifier 的权威闭集判定——真实链路上 AiSdkModelAdapterError 经 UnknownError 包装 + reason 闭集收窄投影后，"network_error"/"rate_limited" 等 adapter token 会丢失，retryable/source/statusCode 存活；E2E 实测回归钉住）；且 resultType = error_during_execution | 退避后自动继续 |
| permanent | auth_error / context_exceeded / configuration_error / disk_full；任何 retryable:false | 放弃 + 计数清零 |
| budget | resultType ∈ {error_max_turns, error_max_budget, error_max_tool_calls} | 放弃（预算结局不是故障恢复面） |
| 不干预 | resultType = success；cancelled（用户停止，`isTurnCancellationError` 分流 TurnComplete{cancelled}） | 计数清零 |

源项目的「误报双重防护」（长消息尾部横幅/覆盖率门槛/用户讨论检测）**不移植**——
那是文本启发式形态的自卫；ACode 判定输入是结构化事件，无该误报面。

**分类单测纪律（E2E D2 教训）**：单测必须喂**真实投影产物形状**（reason 可能被闭集
收窄丢弃、只剩 retryable/source/statusCode/providerErrorCode），不得只喂理想闭集
token——接口形状漂移会让全绿单测放行「真实故障静默不触发」的缺陷。

## 退避、守卫与状态

- 第 n 次等待 = min(cooldownBaseSec × cooldownFactor^(n−1), cooldownMaxSec)；默认
  10s / ×2 / 60s；maxResumes 默认 8（同会话连续）。
- 循环守卫：相同错误签名（reason+statusCode+providerCode）连续出现 > loopGuardRepeats
  （默认 3）→ 停止。
- 计数重置条件：任一成功 turn、用户取消、**新用户输入被 admission**（`prompt-admission.ts`
  用户来源路径）、permanent/budget 判定。
- 状态 = 进程内 per-session 内存（`{count, repeats, lastSignature, updatedAt}`），
  **不跨进程持久化**：进程亡即重试链亡，杜绝重启后幽灵续跑；参数与长期开关走 config。
- 定时器纪律：pending 定时器在会话 abort / 停止命令 / 新用户输入 / 进程退出时必须取消；
  不能用定时器掩盖同步问题——触发前重查最新会话状态（可能已被用户手动续上）。

## 注入路径（照 goal-continuation 先例）

- 形态仿 `runtime/methods/target.ts:155-188` + `target-continuation-loop.ts`：
  `wrapSystemReminderForSource("auto_resume", continueText)` →
  `executeTurnCommand(prompt, undefined, { inputSource: "auto_resume", inputVisibility: "model-only" })`。
- `SYNTHETIC_USER_MESSAGE_SOURCES` 闭集（`contracts/src/interfaces/session-store.port.ts:55-75`）
  新增 `auto_resume` token。
- 继续指令**自撰**（英文，跟随 output-token continuation 惯例），语义要素：上一轮因
  临时性故障中断而非用户停止；从中断处继续；不重复已完成工作；上一步操作结果未知时
  先确认状态再继续。占位符 `{count}` `{max}` `{remaining}`；customMessage 覆盖仅作用
  于 transient 档。
- **无人值守标记透传（安全红线）**：automation/off-peak turn 失败后的 auto-resume 注入
  turn 必须携带原 turn 的 `automationId`/`offPeakTaskId`（`turn-loop-state.ts:115-117`），
  继承同款 mutation 限制（`turn-loop.ts:299-324`）——auto-resume 不得把受限 turn 洗成
  无约束 turn，不得提升任何权限（dontAsk 下 ask 仍终局 deny，不变）。

## /auto-resume 命令面（零 token）

- 子命令：`status`｜`on`｜`off [时长]`｜`msg <文本>`｜`msg clear`。
- 时长：`45s/30m/2h/1d`，纯数字=分钟，上限 30 天；`off <时长>` = 进程内 pause 到期
  自动恢复；裸 `off`/`on` = 持久化 config（照 `/locale` 写 config 先例，回执 configPath）。
- `status` 回执：开关/暂停到期/自定义消息/当前会话计数与重复签名次数。
- 单一实现模块：`apps/acode-cli/packages/cli/src/auto-resume-command/`（解析+回执文本，
  随 locale）；desktop 经 bootstrap `v4/command` handler leaf 复用同一模块。
- 注册三件套（`acode-slash-command-help.ts` entry、`parseSlashCommand` 分支、
  `command-center/create.ts` 拦截）与 v4 handler 接线 = **编排者独占**，实现代理不碰。

## 配置面（autoResume 节，modelAnomalyGuard 全链路同构）

`adapters/src/config/schema.ts` z.object({ enabled, maxResumes, cooldownBaseSec,
cooldownFactor, cooldownMaxSec, loopGuardRepeats, continueMessage? }) →
ACodeConfigFileSchema → parse 回填 → config-merger → runtime-config →
core `runtime/types.ts` RuntimeConfig 字段 → auto-resume coordinator 消费。
热更新走既有 `updateConfig` patch 面；不新建文件 watcher。

**默认值分档裁决**：attended/unattended 统一默认 enabled=true——adapter 已重试 10 次后
仍失败的跨回合故障是稀有事件，两类场景都受益；惊讶成本由 maxResumes/退避上限/命令
off 覆盖。分档差异不写死，config 可逐项覆盖。

## 状态上报

- `ModelNetworkStatus` 闭集（`contracts/src/model/request-status.ts:262` payload 面）
  新增 `auto_resume_scheduled` 子类型（additive optional：attempt/maxAttempts/delayMs/
  errorSummary）；发射点 = 调度决定时与注入前（`runtime/methods/model-status.ts` 通道）。
- `session-mapper.ts` 映射扩展：`ACodeApiRetrySlotValue`（`packages/shared/src/acode-api-retry-status.ts`）
  additive `kind:"auto_resume"` → ui store 既有 apiRetry 槽渲染（文案区分 kind）；
  TUI 走 `logModelNetworkStatus` 既有通道。
- **通道裁决（接线期定案）**：legacy apiRetry 槽的 wire schema
  （`acode-protocol-legacy-types.ts` 的 `acodeSessionApiRetryStatusSchema`，strict literal
  `api_retry`）以 union 扩出 `acodeSessionAutoResumeStatusSchema` 变体（幸存承重面的
  维护性扩集，与 synthetic source 词表镜像同性质；apiRetry 槽退役时随收敛计划两变体
  一起迁移，不另开新通道）；`normalizeACodeApiRetryStatus` 对 `kind:"auto_resume"`
  保留变体不压扁（压扁会丢 resumeDelayMs/maxResumes 语义）。v4 snapshot 的
  ApiRetryState reasonCode 词表**暂不扩**——legacy 槽是桌面呈现主链，最小面原则；
  v4 原生化随 apiRetry 整体收敛演进（登记项）。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 分类/退避/守卫/计数/定时器（运行时唯一写入点） | core `runtime/auto-resume/`（新模块） |
| 失败事件观察挂点 | core `runtime/methods/turn.ts` 失败路径（通知 coordinator，不改判定语义） |
| 参数持久化 | adapters config 链（schema→merger→runtime-config） |
| 命令解析与回执 | cli `auto-resume-command/`（bootstrap handler leaf 复用） |
| 状态子类型与投影 | contracts 闭集 + session-mapper（additive） |

## 验收场景

1. 分类器单测：transient/permanent/budget/cancelled/success 各分支 + retryable:false 优先。
2. 退避序列与循环守卫单测（相同签名 3 次停、签名变化重置 repeats）。
3. 重置条件单测：成功/取消/新用户输入 admission。
4. 定时器取消单测：abort/新输入后不触发；触发前重查会话状态。
5. 注入单测：automation turn 的 auto-resume turn 仍带 automationId 且 mutation 受限
   （安全红线回归）。
6. 配置链单测：schema 解析/默认值/覆盖/merge。
7. 命令单测：时长格式全谱/上限/msg 占位符/status 回执。
8. E2E（真实会话）：构造临时性故障（如指向不可达 endpoint 的模型配置）观察自动继续、
   UI 状态提示、/auto-resume status 计数、off 后不干预。
