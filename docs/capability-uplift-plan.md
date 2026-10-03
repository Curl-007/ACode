# ACode 能力提升完整方案（zoode 逆向情报驱动）

> **定位**：把 zoode 工作区对 ZCode / ChatGPT·Codex / Claude Desktop / Claude Code CLI 的逆向研究产出，转化为 ACode（本仓库，ZCode 3.14.x fork，MIT）的**能力**提升路线图。安全 track（P0–P2）经核实已基本落地，本方案聚焦**能力跃升**，并把残桩与安全收尾登记为后置批次。
> **生成日期**：2026-10-03。**核实基线**：分支 `dev/0.0.2`（HEAD `5ac9523`）。所有 `file:line` 均已对当前检出源码核实；实现时仍需复核（行号会漂移）。
> **方法**：4 路只读核查 agent 逐项对照 zoode《ACode-提升方案.md》(2026-09-27) 与 ACode 当前源码 + 实跑相关测试（策略地板 43/43、bot 护栏 11/11、更新门 4/4 全过）。
> **边界（务必遵守）**：
>
> - **只搬运「机制设计」，不复制 zoode 还原的专有代码/提示词**。zoode 产物受各目标 EULA 约束、含厂商内部信息，禁止再分发；本方案借鉴的是跨产品共识的机制哲学，落地为 ACode 自有实现。
> - **spec-first**（AGENTS.md 核心原则）：每项先写/更新对应 spec（`apps/acode-cli/specs/` 或 `packages/*/specs/`），明确产品规则、状态所有者、接口、验收场景，再改码。
> - **不不断增加兜底分支**：优先收敛到统一表达（策略地板/熔断器骨架已存在，新能力挂上去而非旁路堆叠）。
> - **不变量守护测试**：仿 `apps/acode-cli/tests/no-telemetry.test.mjs` 模式，为每条新行为写负向断言，防回归。

---

## 0. 执行摘要

**zoode 的提升方案对 ACode 现状判断已过时**——安全 P0–P2 核心已在 `e5f0fe1`/`070eaec`/`580f7a5` 落地，P3 能力清单 5 项里 2 项早已实现、1 项一半过时。逐项核实后，**真正还开着的能力缺口只有 2 个头条项 + 1 个半项 + 一批快赢/残桩**：

- 🔴 **#1 auto 模式 LLM 风险分类器**（真缺口，价值最高，高风险，需先出设计文档对齐）
- 🔴 **#2 heartbeat 自动化协议**（真缺口，自足，中风险，**推荐头条**）
- 🟡 **#4 prompt-cache miss-cause 归因**（命中率已端到端存在，仅缺归因/健康态，增量、低-中风险）
- ✅ **#3 跨厂商插件清单**（`.claude`/`.codex` 已全接受，仅缺 `.cursor-plugin`，S）
- ✅ **#5 任务依赖图**（blockedBy/id/available/confidenceHistory 已实现，仅缺 `owner` 字段，S）
- 🐞 **悬空工具引用 bug**（`edit.ts:196` 叫模型用不存在的 NotebookEdit、`bash-gh-rate-limit.ts:7` 提 ScheduleWakeup，S，需先确认是否与在做的提示词审计冲突）
- 残桩：worktree 隔离、ApplyPatch handler、保留工具名（EnterWorktree/ExitWorktree/LSP/NotebookEdit/ScheduleWakeup）、CUA fail-closed（本构建故意）

**推荐落地顺序**：批次 0 快赢 → 批次 1 heartbeat → 批次 2 miss-cause → 批次 3 auto 分类器（设计对齐后）→ 批次 4 残桩/安全收尾（按需）。

---

## 1. 已验证缺口总览

| ID  | 主题                         | 状态                | 集成点（当前源码）                                                                                               | 工作量 | 风险  | 批次 |
| --- | ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ | ----- | ---- |
| C1  | auto 模式 LLM 风险分类器     | OPEN                | `core/src/permission/service.ts:358`（deny 桩）；异步接缝 `tool/executor/permission-flow.ts:47`                  | L      | 高    | 3    |
| C2  | heartbeat 自动化协议         | OPEN                | `desktop/src/host/index.ts:809-816`（无条件标未读）、`dispatchCronRun` `host/index.ts:839+`                      | M      | 中    | 1    |
| C3  | `.cursor-plugin` 清单兼容    | DONE-1              | `adapters/src/plugins/index.ts:109`、`marketplace.ts:56`、`zip-source.ts:328`                                    | S      | 低    | 0    |
| C4  | prompt-cache miss-cause 归因 | PARTIAL             | `core/src/agent/message-history.ts:125,252`（`setCacheMiss` 仅布尔）；上报 `contracts/.../session.events.ts:766` | M      | 低-中 | 2    |
| C5  | TodoWrite `owner` 字段       | 撤销（spec 已裁剪） | `apps/acode-cli/specs/todo-dependency-fields.md` 裁剪边界                                                        | —      | —     | —    |
| C6  | 悬空工具引用修正             | BUG                 | `core/src/tool/handlers/edit.ts:196`、`bash-gh-rate-limit.ts:7`                                                  | S      | 低    | 0    |
| S1  | worktree 隔离                | STUB                | `bootstrap/src/app/script-workflow-runtime.ts:282`                                                               | L      | 中    | 4    |
| S2  | ApplyPatch handler           | STUB                | `contracts/src/tools/apply-patch.ts` 有、`handlers/index.ts:79` 注释                                             | M      | 中    | 4    |
| S3  | 保留工具名落地/清理          | STUB                | `core/src/tool/provider-visible-order.ts:11-19`                                                                  | S–M    | 低    | 4    |
| R1  | 凭据主密钥接 OS 钥匙串       | 残留                | `shared/src/node/credentialMasterKey.ts`（现随机 0600 文件）                                                     | M      | 中    | 4    |
| R2  | 移除 `?token=` query 兼容    | 残留                | `server/src/http.ts:292-300`（弃用窗内）                                                                         | S      | 低    | 4    |
| R3  | bot 本地审批默认策略         | 残留                | `services/src/bots/botPermissionLocalApproval.ts`（默认 OFF）                                                    | S      | 中    | 4    |

> DONE-1 = 主体已实现，仅差一小块。

---

## 2. 分批实施方案

### 批次 0 · 快赢（S，低风险）— 首个 PR，跑通 spec-first 流程

**C3 · `.cursor-plugin` 清单兼容**

- 现状：`.acode-plugin`/`.claude-plugin`/`.codex-plugin` 在发现(`plugins/index.ts:109-111` + `findManifest:939`)、市场(`marketplace.ts:55-58` + `findPluginManifestPath:2183`)、zip 安装(`zip-source.ts:328-334`)三层全接受；`.cursor-plugin` 全仓 0 处。
- 目标：把 `.cursor-plugin/plugin.json` 加进上述三处候选列表（保持 ACODE > CLAUDE > CODEX > CURSOR 稳定优先级）。
- spec 落点：更新 `CONTEXT.md` 插件清单词汇 + 若有 `packages/services/specs/plugin-*.md` 则补一行；无独立 spec 则在 PR 描述记录。
- 不变量测试：断言含 `.cursor-plugin/plugin.json` 的目录能被发现/安装；断言优先级顺序不变。
- 验收：放一个 `.cursor-plugin` 样例插件 → 市场可发现、可安装。

**C5 · TodoWrite `owner` 字段**

- 现状：`contracts/src/tools/todo.ts:78-93` 已有 id/blockedBy/metadata/completionConfidence，`:102-108` confidenceHistory，`:121-127` available 派生，`todo-deps.ts` 有环检测+悬空拒绝；spec `todo-dependency-fields.md`/`todo-confidence-semantics.md` 已在。仅缺 Claude Code TaskCreate 的 `owner`。
- 目标：给 TodoItem 增可选 `owner`（字符串，标注归属代理/人），进入 view schema 与模型可见提示文本（`core/src/tool/handlers/todo.ts:218` 附近）。
- spec 落点：`apps/acode-cli/specs/todo-dependency-fields.md` 增 `owner` 语义（可选、不参与依赖计算、仅展示/归属）。
- 不变量测试：owner 缺省不影响 available/blockedBy 计算；带 owner 往返一致。
- 验收：TodoWrite 接受 owner 并在 TodoRead 视图回显。

**C6 · 悬空工具引用修正**

- 现状：`handlers/edit.ts:196` 模型可见文本 "Use the NotebookEdit to edit this file"、`bash-gh-rate-limit.ts:7` "use ScheduleWakeup instead of retrying"——两工具均无 handler（仅在 `provider-visible-order.ts` 保留名）。
- ⚠️ **前置确认**：近期提交在做提示词审计（F1–F6），先确认这两处不是已登记/故意保留的项，避免与在做的审计冲突。
- 目标：改为指向**真实存在**的工具/行为（NotebookEdit→用 Edit/Write 处理 notebook；ScheduleWakeup→用 Cron/OffPeak 或既有重试语义），或删除该误导句。
- spec 落点：属提示词文本修正，记录进提示词审计报告（`docs/prompt-corpus-audit-2026-10.md`）而非新 spec。
- 验收：全仓 grep 模型可见文本不再引用无 handler 的工具名（可加一条轻量守护测试）。

---

### 批次 1 · #2 heartbeat 自动化协议（M，中风险）— **推荐头条**

**为什么是头条**：自足、直击真实痛点（定时/闲时任务"通知刷屏"），机制可从 zoode 还原的 Codex desktop heartbeat 清晰映射，且不触碰安全决策咽喉（风险可控）。

- 现状（已核实）：
  - 终态**无条件**标未读：`desktop/src/host/index.ts:809-816` `setTaskUnread({..., unread:true})`（"定时任务后台完成后统一置为未读"）——与"默认安静"相反。
  - 无 NOTIFY/DONT_NOTIFY 决策协议；`automation-types.ts`(202 行) 无通知字段。
  - 过期不自删：`automationService.ts:384,405` 耗尽 endAt/maxRuns 仅置 `lifecycleStatus:"completed"` 并持久化，删除只靠显式 `delete()`(:427)；`automationRepo.ts:1421` `pruneRuns(maxAgeMs)` 是**死代码（零调用）**。
  - 现有 "heartbeat" 是无关的 claim 租约保活（`cronRunLifecycle.ts:31` `MANUAL_CLAIM_HEARTBEAT_MS`）。
  - bot 推送是创建期 opt-in（`cronBotDelivery.ts:22-45`，无 target 即 false）。
- 目标（移植 Codex heartbeat 机制，ACode 自有实现）：
  1. **默认安静**：心跳/定时触发本身不构成通知理由；终态不再无条件 `unread:true`。
  2. **强制单个决策输出**：被派发的自动化提示词要求模型产出**恰好一个** `NOTIFY` 或 `DONT_NOTIFY` 结构化决策（XML/JSON），settle 时解析。
  3. **决策驱动通知**：仅 `NOTIFY` 才标未读/推送 bot；`DONT_NOTIFY` 静默完成。
  4. **过期自删**：把死代码 `pruneRuns` 接上生命周期——耗尽/过期的自动化按策略自删（或标记后清理），避免僵尸自动化堆积。
- 状态所有者与事件顺序（AGENTS.md 要求图示）：
  - 所有者：`automationService`（生命周期/持久化）为唯一事实源；`host/index.ts` 终态回调为通知决策执行点；`ACodeAutomationRun` 增 `notifyDecision` 字段持久化决策。
  - 顺序：scheduler(utilityProcess) 触发 → `dispatchCronRun` 注入"须输出 NOTIFY/DONT_NOTIFY"的提示 → agent 运行 → 终态回调 `settleCronRunTerminalOutcome` 解析决策 → 据决策 `setTaskUnread`/`watchCronRunBotDelivery` → 过期则 `pruneRuns`/自删。
  - 幂等边界：不得破坏 runId 幂等、claim 租约、resume/bound-first-run/init 派发分支（`offPeakDispatchPlan.ts:3-19`）。
- spec 落点：**新建** `packages/desktop/specs/automation-heartbeat-protocol.md`（或 `packages/services/specs/`，取决于所有者归属）+ 更新 `packages/shared/src/automation-types.ts` 对应类型 spec。明确：决策语法、默认安静规则、解析失败时的 fail-safe（建议失败→DONT_NOTIFY 静默，避免刷屏回潮）、过期自删策略、bot 推送门。
- 不变量守护测试：
  - 终态默认**不**标未读（除非决策=NOTIFY）；
  - 提示词缺决策/解析失败 → 静默（不刷屏）；
  - 过期自动化被清理（pruneRuns 有调用方）；
  - runId 幂等/claim 租约不回归。
- 验收：`pnpm dev:desktop` 建一个定时任务 → 默认安静完成；模型输出 NOTIFY 时才未读+推送；过期任务自删。手测覆盖 desktop-continuous 与 web-remote-replayable 两种语义（AGENTS.md 要求）。
- 工作量 M / 风险 中（跨 scheduler→main→host→session）。

---

### 批次 2 · #4 prompt-cache miss-cause 归因（M，低-中风险，纯增量）

- 现状（已核实）：命中率**已端到端存在**——`core/src/runtime/methods/turn-model-step-usage.ts:126-148`（`latestHitRate`，分母用 total input）、`MainTurnCacheHitAggregate`(`runtime/types.ts:277`)、协议 `ModelCompletePayload.cacheHit`(`contracts/.../session.events.ts:766-777`)、UI `contextUsage.tsx`（生产隐藏<78%，DEV 可见）+ `CodingPlanUsagePanel.tsx:919`。**真缺**：miss 只是布尔（`message-history.ts:125,252` `setCacheMiss()`→`lastCacheHit=false`），无"为什么 miss"的归因；无 warm/TTL 健康态。
- 目标（借鉴 Claude Code `prompt_cache` 健康对象的 miss-cause 闭集，ACode 自有实现）：
  1. 在已有 `setCacheMiss` 调用点附**闭集 cause**：`system_prompt_changed` / `tools_changed` / `model_changed` / `messages_rewritten`(rewind/compact) / `ttl_expired` / `turn_interrupt`（调用点已是这些事件：`turn.ts:520`、`rewind-message.ts:726`、`control-only-turn.ts:113`）。
  2. 经 `ModelCompletePayload.cacheHit` 扩展上报 cause 计数；可选补 warm/TTL 健康态。
  3. UI 在 contextUsage 弹出层/session-debug 面板展示 miss 归因。
- **硬约束**：受 `apps/acode-cli/specs/no-telemetry.md` 约束——诊断**必须留在端侧/本地**，不得新增任何网络上报。
- spec 落点：更新 cache 诊断相关 spec（若无则新建 `apps/acode-cli/specs/prompt-cache-diagnostics.md`），明确 cause 闭集、本地-only 不变量。
- 不变量守护测试：cause 取值在闭集内；无网络上报（可复用/仿 no-telemetry 守护）；命中率既有行为不回归。
- 验收：制造一次 rewind/compact/model-switch → 诊断面板显示对应 miss-cause；命中率显示不回归。
- 工作量 M / 风险 低-中（增量，但须守住本地-only）。

---

### 批次 3 · #1 auto 模式 LLM 风险分类器（L，高风险）— **须先出设计文档对齐，不直接改码**

**为什么须先对齐**：这是把 auto 从"全 deny"变成"LLM 裁决"，**根本性改变 ACode 安全姿态**，且涉及 sync→async 决策咽喉改造。按 AGENTS.md「发现设计缺陷先与用户对齐、不不断增加兜底分支」，先出设计文档确认后再实现。

- 现状（已核实）：
  - auto 仍是纯 deny 桩：`core/src/permission/service.ts:358-364`（`deny("mode.auto.unimplemented", "Auto mode is reserved but not implemented yet")`）+ `:548-554` 同。
  - **未接新地板**：`bypass-immune-breakers.ts`/`process-policy-floor.ts` 只 gate **yolo** 路径；breakers 只对非-deny 决策生效(`service.ts:231`)，auto 的 deny 到不了。
  - auto **可达**：`CollaborationMode` 含 `"auto"`(`contracts/.../session.port.ts:32`)，子代理 `permissionMode:"auto"` 直通(`subagent.ts:484`)。
  - **元数据地基已具备**（比方案设想的 richer）：`ToolPermissionSpec.riskLevel`(low/medium/high/critical)/`sideEffectScope`/`needsApproval`/`denyPriority`/`alwaysAsk`(`contracts/.../contract.ts:87-95`)；build 模式已按 riskLevel 分支(`service.ts:665-680`)；Bash 爆炸半径 `assessBashCommandTargetRisk`(`bash-target-risk/`)。
  - 异步接缝：`checkPermission` 是 **sync**(`service.ts:165`)；异步 seam 在两处调用方 `tool/executor/permission-flow.ts:47`(`resolveToolPermission`, 调 checkPermission 于 :123) 与 `permission-input-recheck.ts:73`。
- 设计文档须覆盖（借鉴 Codex Guardian / Claude Code auto 分类器**机制**，自有实现）：
  1. **分类器置于确定性规则之后**（Codex 哲学）：先跑现有 riskLevel/sideEffectScope/blast-radius + breakers + 策略地板（只收紧），确定性 deny/allow 先决；仅"灰区"才交 LLM 风险判官。
  2. **地板只收紧不放宽**：breakers + managed policy floor 作为不可被分类器放松的地板（沿用既有不变量）。
  3. **审批疲劳校准**：Codex 式"目标已确认为空/不存在则降级"（如 `rm -rf` 空目录），减少无谓弹窗。
  4. **分级裁决**：Claude Code 式 HARD/SOFT BLOCK 分级 + 转录取证规则。
  5. **sync→async 改造**：在 `resolveToolPermission` 注入 async auto-mode policy；保证 `permission-input-recheck.ts` 同语义；不破坏 fail-closed。
  6. **失败安全**：分类器不可用/超时 → 降级到 ask（不静默 allow）。
  7. **子代理 auto 继承**：经进程级策略地板收敛（`subagent-policy-floor` 已有地基）。
- spec 落点：**新建** `apps/acode-cli/specs/auto-mode-risk-classifier.md`（设计文档先于 spec）。
- 不变量守护测试：auto 下确定性 deny 仍 deny；分类器只收紧不放宽；分类器失败→ask；breakers/policy floor 不被绕过；input-recheck 同语义。
- 验收：auto 模式对灰区动作由分类器裁决（allow/ask/deny），对已确定危险动作仍走 breakers/policy deny；审批疲劳有校准。
- 工作量 L / 风险 高（安全咽喉 + sync→async）。**前置：设计文档 + 用户对齐。**

---

### 批次 4 · 残桩与安全收尾（按需/后置）

**能力残桩**

- **S1 worktree 隔离**（`script-workflow-runtime.ts:282` 抛 not-implemented）：dynamic-workflow 的 `isolation:"worktree"` 落地——为每个 workflow agent 建 git worktree 隔离工作区。工作量 L，风险中（git 状态/清理/并发）。spec：`apps/acode-cli/specs/workflow-worktree-isolation.md`。
- **S2 ApplyPatch handler**（contract 有、`handlers/index.ts:79` 注释、无 handler）：实现 handler 或正式移除 contract（避免悬空）。工作量 M。
- **S3 保留工具名**（`provider-visible-order.ts:11-19` EnterWorktree/ExitWorktree/LSP/NotebookEdit/ScheduleWakeup 无 handler）：要么落地，要么从 provider-visible 顺序移除以免占位误导（与 C6 联动）。工作量 S–M。
- **CUA fail-closed**：本构建故意，不在本方案范围（除非决定启用 Computer Use）。

**安全收尾（zoode 方案 P0–P2 的残留，非新漏洞）**

- **R1 凭据主密钥接 OS 钥匙串**：现为每安装随机 0600 文件（`shared/src/node/credentialMasterKey.ts`），与密文同盘——挡不住整目录外带。接 Electron `safeStorage`(macOS Keychain/Win DPAPI/Linux libsecret) + CLI `keytar`/原生；host→main IPC 请求加解密，密钥永不落盘明文。注意 safeStorage/keytar 是异步/原生依赖，需处理接口异步化。工作量 M，直接支撑"隐私/无监控"卖点。spec：`packages/services/specs/credential-storage.md` 更新。
- **R2 移除 `?token=` query 兼容**：弃用窗后移除（`server/src/http.ts:292-300`），仅留 Bearer + cookie。工作量 S。spec：`packages/server/specs/server-auth.md` 更新。
- **R3 bot 本地审批默认策略**：`botPermissionLocalApprovalEnabled` 默认 OFF → 远程仍是"一条消息+N 次聊天审批"。评估是否对高风险动作默认开启本地审批（独立于请求者的信任闸）。工作量 S，风险中（UX 权衡）。spec：`packages/services/specs/bot-permission-local-approval.md` 更新。
- **P2 的 11 项加固清单**：尚未逐项核实（子进程 env 白名单、Electron 加固四件套/fuse、agent 命令 env 门禁、工作区路径收敛、OAuth PKCE、http 明文告警、插件 git commit 固定、Chrome 提权解密门、遥测残留、子代理模式继承）。部分可能已随 P2 骨架收敛（子代理继承有 `subagent-policy-floor.test.mjs`、工作区收敛有 breaker `pathEscapeWrite`）。**启动前需先逐项核实**，再决定纳入哪个批次。

**提示词/工具描述对标（cross-cutting，可选）**

- 用 claudecli 还原的 4705 提示词块（7 系统提示/24 工具描述/17 agent）+ ZCode 提示词同源发现，对照改进 ACode 系统提示词与工具描述的**覆盖面/结构/清晰度**（只借鉴机制，不逐字复制专有提示词）。与在做的提示词审计（`docs/prompt-corpus-audit-2026-10.md`）合流，避免重复。

---

## 3. 统一验证方式（每项落地后，遵循 AGENTS.md）

1. **类型 + lint**：`pnpm typecheck`、`pnpm lint`（0 error），如实报告，不把既有失败写成通过。
2. **不变量守护测试**：每条新行为写负向断言（仿 `no-telemetry.test.mjs`）。
3. **架构检查**：`pnpm architecture:check --changed`（跨包改动时），确保不引入 UI→Repo 直调、循环依赖。
4. **桌面手测**：`pnpm dev:desktop`，逐项验证；涉及 stream/snapshot/queue/重连时**同时验证 desktop-continuous 与 web-remote-replayable 两种语义**。
5. **CLI 分发手测**：`pnpm build:acode` 后解压运行，验证 CLI（无 Electron）路径。
6. **提交规范**：按 `docs/git-collaboration.md`，`feature/`/`fix/` 分支 → `dev` squash；Conventional Commits；**每项先更 spec 再改码**。

---

## 4. 落地顺序与依赖

```
批次0 快赢(C3 .cursor / C5 owner / C6 悬空引用)   ← 无依赖，先做，跑通 spec-first
        │
批次1 heartbeat(C2)                               ← 自足，头条；先出 spec 草案过目
        │
批次2 prompt-cache miss-cause(C4)                 ← 增量，守 no-telemetry 本地-only
        │
批次3 auto 分类器(C1)                             ← 高风险：设计文档 → 用户对齐 → 再实现
        │
批次4 残桩/安全收尾(S1-S3 / R1-R3 / P2-11项 / 提示词对标)  ← 按需；P2-11项启动前先核实
```

依赖要点：R1（OS 钥匙串）独立但支撑隐私卖点，可与能力批次并行；C6 与 S3 联动（悬空引用 ↔ 保留名）；批次 3 依赖批次 0–2 不回归（同一 permission/context 区域）。

---

## 5. 法律与伦理边界

- zoode 产物受各目标 EULA 约束、含厂商内部信息（未发布模型代号、内部端点、凭据路径），**禁止再分发**；本方案**只搬运机制设计**，所有落地代码为 ACode 自有实现，**不复制 zoode 还原的专有源码或逐字提示词**。
- 对 ACode 的改动全程遵循仓库 spec-first + 架构治理 + 不变量测试纪律。
- 提示词对标只借鉴覆盖面/结构/机制，不做逐字搬运。

---

## 6. 证据来源

| 来源                                                                             | 用途                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| zoode `ACode-提升方案.md`(2026-09-27)                                            | P0–P3 原始清单与机制情报（已核实其现状判断过时）                                    |
| zoode `chatgpt-recovered/native-analysis/security-policy.md`                     | Codex Guardian 分类器、fail-closed 沙箱、requirements.toml 策略地板、heartbeat 机制 |
| zoode `claudecli/analysis/claude-code/深度安全分析报告.md` + `prompts/`(4705 块) | Claude Code auto 服务端分类器、prompt_cache 健康对象、工具/权限模式能力清单         |
| zoode `ZCode-深度分析报告.md` / `prompt-parity-missing.json`                     | ZCode↔Claude Code 提示词同源、能力缺口定位（按 ACode 当前源码重判）                 |
| ACode 源码直接核实(dev/0.0.2 @ 5ac9523)                                          | 本方案所有 `file:line` 与状态判定（4 路只读核查 + 实跑测试 43/43、11/11、4/4）      |

_本文档由 zoode 逆向情报 + ACode 当前源码交叉核实生成，2026-10-03。实现时以当前检出源码为准复核行号。_

---

## 实施记录（2026-10-03 · 批次 0）

- **C3 已完成**：spec `apps/acode-cli/specs/plugin-foreign-manifest-compat.md` 新建；
  8 处发现点补齐 `.cursor-plugin` 候选（CLI adapters：`plugins/index.ts` findManifest、
  `marketplace.ts` findPluginManifestPath、`zip-source.ts` hasPluginManifest；services：
  pluginSyncService / commandsService / settingsSyncService / skillsService /
  subagentsService）；`CONTEXT.md` Plugin Manifest 词条同步。守护测试
  `apps/acode-cli/tests/plugin-foreign-manifest-compat.test.mjs`（4/4）+
  `packages/services/tests/plugin-foreign-manifest-compat.test.mjs`（5/5）通过。
  核实中的关键发现：`adapters/src/skills/index.ts` 自初始提交（85c7bb6）即接受
  `.cursor-plugin`，各发现点互相分叉——这是本次修正的事实依据（zoode 核查 agent
  曾误报「全仓 0 处」，已按源码纠正）。
- **C5 撤销（spec 裁决，不改码）**：`apps/acode-cli/specs/todo-dependency-fields.md`
  裁剪边界明文排除「owner / 认领 / blocks 反向边 / TaskList 四件套」——理由：ACode
  无多 peer 协作产品面，加 owner 属投机设计。zoode 方案「对齐 Claude Code TaskCreate
  owner」与该既有决策冲突；按 AGENTS.md spec-first 纪律不落地。未来若出现 team 机制，
  以该 spec 的 id+blockedBy 为基础重开裁剪边界，而非现在预埋字段。
- **C6 已完成**：两处模型可见文本的悬空工具引用修复——`edit.ts` .ipynb 守卫文案
  改指真实路径（Write 整写 / Bash 结构化编辑），`bash-gh-rate-limit.ts` 提示去掉
  ScheduleWakeup 改为单次 sleep 行为指导；登记为 `docs/prompt-corpus-audit-2026-10.md`
  F7。修复前核实两字符串无 golden/行为测试钉住。`provider-visible-order.ts` 保留名
  的落地/移除归 S3，本轮不动。
- **批次 1 heartbeat**：spec 草案已出——`packages/desktop/specs/automation-heartbeat-protocol.md`
  （默认安静 / NOTIFY-DONT_NOTIFY 决策协议 / failed 恒通知 / Bot 回推同源 /
  notifyDecision 落 run 台账 / pruneRuns 接线 + 耗尽 automation 过期删除）。
  **待所有者裁决 4 个开放问题（Q1 保留窗口、Q2 Bot 是否同批、Q3 注入形态、
  Q4 off-peak 路径核实）后再动代码。**
- **验证**：typecheck / lint / architecture:check 与相关测试的实跑结果见本批次
  提交说明（如实记录，不以既有失败冒充通过）。

## 实施记录（2026-10-03 · 批次 1 · heartbeat 通知决策协议）

Q1–Q4 所有者批复「按建议」后实施完成。spec 已按实施前侦察修正（R1 第二未读写入方
门控 / R2 流式累积替代不存在的按 run 消息读取 API / R3 共享解析器 + runId 透传 /
R4 migration 0004 形态 / R7 范围收缩：OffPeakCreate 不动、同批修正 cron.ts 矛盾句）。

- **shared**：新增 `automation-notice.ts`（协议词汇唯一家：指令常量 / last-match
  解析器 / 8KB 滚动尾部缓冲）；`automation-types.ts` 增 `notifyDecision` 与两个
  保留窗口常量（run 台账 30 天 / 耗尽定义 7 天）。
- **services**：migration `0004_automation_notify_decision`（冻结 SQL 常量，body
  分派改显式 else-if + fail-loud）；`automationRepo` 行编解码 / `markRunOutcome`
  第 4 参 COALESCE 写 / `upsertRunClaimed` 重试复位 / 两处认领字面量补列 /
  新增 `pruneExhaustedAutomations`（只删 completed 过窗，failed/active 不删）；
  **syncer 门**：`applyTerminalTransition` 对 `isCronTask` 任务抑制
  `background_terminal` 未读信号（第二写入方，源头门控，UI 无需改）；**bots 门**：
  `BotAutomationRunWatchParams` 增 `runId`，`watchTaskStream` 为 automation watch
  累积决策尾部、`task_complete` 非 notify 静默（`task_error` 恒推，普通聊天 watch
  零影响）。
- **desktop**：host `trackCronRunOutcome` 订阅窗内累积 `agent_message_chunk`
  （inputId=runId、主 agent 正文）→ 终态解析 → settle 落台账 → 仅 notify/failed
  标未读（absent 记 warn）；`dispatchCronRun` sendPrompt 后缀注入指令常量；
  `cronBotDelivery` 透传 runId；scheduler `main()` 启动序列接线 `pruneRuns` +
  `pruneExhaustedAutomations`（死代码转正）。
- **CLI**：`cron.ts` CronCreate 描述补注入协议说明；修正与 R5b 矛盾的
  「not auto-deleted」旧句。
- **测试**（新增 17 个，全绿）：`packages/shared/tests/automation-notice.test.mjs`
  （6：解析/fail-safe/last-match/缓冲/指令形态）；
  `packages/services/test/automationNotifyDecision.test.ts`（5：临时库往返 /
  running 不抹决策 / 重试复位 / prune 谓词 / pruneRuns）；
  `packages/desktop/tests/automation-heartbeat-protocol.test.mjs`（6：五执行点
  源码不变量，任一被回退即红）。
- **已登记边界**：bound task（targetTaskId 复投普通聊天任务）的 meta 无 automation
  标记，syncer 门对其不生效——该子路径保持既有聊天未读行为（spec R1 已登记，
  彻底解决需 turn 级 attribution，后续项）。off-peak 独立 settle 链路（Q4 核实），
  本批未覆盖，后续项。
- **未执行**：`pnpm dev:desktop` 端到端手测（建高频 automation 观察未读/Bot 行为、
  桌面与手机远控两种语义）——需要交互环境，待人工或 browser-use 补验。

## 实施记录（2026-10-03 · 批次 2 · prompt-cache miss-cause 归因）

spec `apps/acode-cli/specs/prompt-cache-diagnostics.md` 先行；实施前侦察修正了本
路线图 C4 的两处假设：`turn.ts:520` 的 setCacheMiss 是**每 turn 无条件重置**而非
interrupt 标记；`setCacheMiss`/`lastCacheHit` 旗标路径（Path B）**从不进 GUI/协议**，
GUI 命中率唯一来源是 provider-usage 驱动的 `recordMainTurnCacheHitUsage`（Path A）
——归因点因此落在 Path A，而非原计划的 setCacheMiss 调用点。

- **因集闭集（7 因，按 ACode 真实可检测事件推导，不照抄 Claude Code 因名）**：
  conversation_rewind / control_only_turn / compaction（含 microcompact）/
  context_refresh / model_changed / idle_ttl_suspected（推断值，UI 标注「疑似」）/
  unknown。system_prompt_changed / tools_changed 登记 phase 2（需 runtime hash
  对比回路，可复用 `context/manifest.ts` 纯函数）。
- **落地**：contracts 因集唯一家 + `cacheHit.missCauses`；core 五个显式事件点写
  `pendingCacheMissCause`、归因/计数/快照收敛在 `recordMainTurnCacheHitUsage`
  单点（优先级：显式 > 换模 > 闲置疑似 > unknown；命中也消费 pending 防陈旧污染）；
  resume/rewind 重建复位计数（tokens 可重建命中率、不可重建归因——诚实边界）；
  bootstrap session-debug 旁路接受 ModelComplete 累计因集；shared 三处 strict 镜像
  - services 显式挑取中继**同批加宽**（v4 客户端整帧校验，漏一处 =
    SUBSCRIPTION_CONTENT_REJECTED，P0 教训）；镜像层用开放 record 不复刻枚举
    （CLI 未来加因免动 shared）；UI 落点 DeveloperToolsPane（未识别因名原样展示，
    偏斜宽容）+ 双语 i18n；contextUsage 弹层 breakdown 登记 phase 2。
- **no-telemetry**：诊断零网络出口，测试含负向断言。
- **测试**：`apps/acode-cli/tests/prompt-cache-diagnostics.test.mjs` 9/9（归因
  优先级/命中不计数/快照拷贝/闭集纪律/四处镜像守护/事件点与复位守护/no-telemetry/
  UI 与 i18n 落点）。全量验证：根 typecheck exit0、CLI contracts/core/bootstrap
  tsc exit0（contracts dist 重建后）、lint 0 error、architecture 0 违规、
  CLI 回归 52/52、shared+services+desktop 套件 101/101。

## 实施记录（2026-10-03 · 批次 3 · auto 分类器——设计对齐阶段）

- 按批次 3 纪律（高风险项先对齐再动码），设计文档已交付：
  `docs/auto-mode-classifier-design.md`——现状核实（auto 桩可达、元数据地基、
  sync/async 接缝、辅助模型 sidecar 骨架、bot 面 auto 未禁的新通道风险）、
  zoode 机制情报转译（Claude Code 服务端分类器 → provider 侧 sidecar，零新信任
  边界；Codex Guardian 确定性后置 + 校准）、5 条设计不变量、决策顺序架构图、
  D1–D9 裁决点（各带推荐）、提示注入硬化四件套、成本估算、v1/v2/v3 批次序。
- **状态：D1–D9 已裁决（2026-10-03 所有者批复「按推荐」，裁决记录进设计文档 §9），
  spec 与 v1 实施已完成**，见下。

## 实施记录（2026-10-03 · 批次 3 · auto 分类器 v1）

spec `apps/acode-cli/specs/auto-mode-risk-classifier.md` 先行（R1–R7 + 12 验收场景），
实施前侦察修正设计 5 处（sidecar 装配点唯一在 createRuntimeToolExecutor、bot 常量
必须拆分、死标志 allowMediumRiskInAutoMode 顺势激活、alwaysAsk 不进灰区、接缝 2
消费先于 ruleId 过滤器）——均已并入 spec 与裁决记录。

- **确定性分层（R1）**：service.ts 两处 auto deny 桩移除；auto 分支按
  critical 恒 ask / high+medium 灰区（ask 形态 + `autoGrayZone` 标记，wire 面
  三值不变、忽略标记者天然 fail-safe）/ medium 受 `allowMediumRiskInAutoMode`
  显式信任放行 / low 放行（workspace 副作用例外进灰区）；alwaysAsk 工具走既有
  ask 语义不进灰区。
- **分类器（R2–R4）**：纯层 `permission/auto-risk-classifier.ts`（端口/常量/
  rubric 提示词/解析硬化/LRU/接缝消费辅助/审计 sink）+ sidecar 实现
  `runtime/methods/auto-risk-classifier-sidecar.ts`（1:1 沿 title sidecar 纪律：
  auxiliaryModelOptions、15s 超时、querySource=auto_risk_classify、usage 入账、
  tools:[]、取证窗=最近 1 条真实用户消息 ≤2K）；装配点唯一
  `createRuntimeToolExecutor`，子代理 child runtime 自动覆盖。
- **接缝（R3）**：permission-flow 与 permission-input-recheck 共用
  `resolveAutoGrayZoneDecision`（recheck 消费先于 ruleId 过滤器）；裁决映射
  allow/deny/ask + `auto.classifier.*` ruleId + reason 展示；fail-safe 全谱
  （超时/坏输出/低置信/预算尽/端口缺席/端口抛异常）一律 ask；只缓存 allow/deny。
- **bot 面（R5）**：`BOT_REMOTE_MODE_CEILING_FORBIDDEN`（+auto）与 bypass 身份集
  拆分——桌面 execution-state 的 modePolicyForbidden 判定不受波及；
  bot-draft-options spec 同批增补。
- **可观测（R6）**：`tool.permission.auto_classified` debug 事件 + 进程级审计
  sink（create-app 装配期接 JSONL，仿反射门先例）；零协议新增面、零网络出口。
- **词汇**：contracts `ModelApiOperation`/`AgentTelemetryOperation` 增
  `auto_risk_classification`（本地用量归类，非遥测上报）。
- **测试**：`auto-risk-classifier.test.mjs` 18/18（R1 分层/标记纪律/裁决映射/
  fail-safe 六因/解析硬化含注入样本/LRU/源码不变量五组/rubric 要素）；
  bot-guardrails 增 auto 拆分断言 12/12；权限回归电池 247/247（policy floor/
  breakers/反射门/对抗组全量）；CLI 相关套件 67/67。验证：根 typecheck exit0、
  contracts/core 构建 exit0、core/bootstrap tsc exit0、lint 0 error、arch 0 违规。
- **真实测试已执行（2026-10-03 同日补验，证据细节在 spec「实施批次记录」）**：
  ① headless `--mode auto` 表面同批放宽（CliRuntimeMode 链路，TUI 菜单/桌面
  picker 留 v2 灰度）；② 两轮真模型实跑（GLM-5.3）：灰区 Write → sidecar 真调
  （rollout querySource=auto_risk_classify、辅助档 max_tokens 5000、rubric 硬化
  prompt 原文在案）→ 模型结构化裁决 allow/0.9 与 allow/0.95
  （serves_stated_intent）→ 文件真实落盘 → 审计 sink JSONL 全字段留痕
  （ruleId=auto.classifier.allow, latencyMs=2160, cache=miss）；③ migration 0004
  在用户真实 tasks-index.sqlite 的**副本**上全过（迁移账本 0001-0004、
  notify_decision 往返、重试复位、prune 安全边界；live DB 零触碰，副本用后即删）。
  轮 1 暴露的「bootstrap dist 陈旧则审计 sink 缺席」是构建新鲜度事实（发布走
  build:bootstrap 管线自然覆盖），已登记 spec 为发布检查项。
- **仍未执行**：heartbeat 与 miss-cause UI 的桌面 E2E（需 dev:desktop 交互环境）；
  rubric 的 evals fixtures 跑批（v2，守 hillclimb 纪律）。
