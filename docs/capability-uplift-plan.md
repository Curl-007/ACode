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

## 实施记录（2026-10-03 · 批次 4 · 第一轮：S3 + S2 + R2 落地，R3 评估存档）

启动前逐项核实（纪律：源码事实先于路线图假设），三处修正：S3 死名从 5 个扩到 9 个
（TaskCreate/TaskGet/TaskList/TaskUpdate 同为上游遗留、全仓零注册；`Workflow` 经二次
核实**不是**活工具而是遗留容忍词汇——background.ts 任务类型映射/off-peak 禁用列表/
includeWorkflow 灰度门仍处理旧会话 rollout 里的该名字，保留并测试显式豁免）；S2 的
「实现或移除」裁决为**实现**（下游接线是有意预铺：shared identity `file-write` family、
compat hook 别名 `ApplyPatch→[Write,Edit]`、ruleSubjects 提取键含 `patch_text`、
isWriteTool、breaker WRITE_TOOLS、managed-policy-floor spec 熔断表、GUI Changes 聚合
注释——移除反而要动 6+ 处下游且丢弃多文件原子编辑能力）；R2 不是纯删除——desktop
的 server-info fetch 与 /ws 握手都在用 query token（`serverRemoteConnection.ts`），
标准 WebSocket API 无法带自定义 header，query 面必须为升级握手保留。

- **S3 完成**：`provider-visible-order.ts` 移除 9 个死名（EnterWorktree/ExitWorktree/
  LSP/NotebookEdit/ScheduleWakeup/TaskCreate/TaskGet/TaskList/TaskUpdate），成员纪律
  注释在案（只收真实注册名；C6/F7 的悬空引用源头就此闭合）。守护测试
  `provider-visible-order-hygiene.test.mjs` 4/4：死名永不回 set、**set ⊆ builtInTools
  注册名 ∪ 显式遗留豁免**（自维护不变量，未来加死名即红）、排序行为钉住。
- **S2 完成（实现裁决）**：spec `apps/acode-cli/specs/apply-patch-tool.md` 先行
  （R1 格式语法 V4A 风格自有解析器 / R2 两段式执行——校验段零写入、应用段诚实原子性
  不回滚 / R3 错误码契约修订——悬空 contract 的字符串码零消费者，改数字码与 Edit 同语义
  同值对齐，executor envelope 全仓数字强校验 / R4 权限接线——**修复 breaker 缺口**：
  checkPathEscapeWrite 原只认 file_path/path 字段，对 patch_text 会静默跳过，新增宽松
  提取器 extractApplyPatchTargetPaths 任一目标逃逸即命中 / R5 注册面与模型描述纪律）。
  实施：contracts 错误码修订、`tool/apply-patch-format.ts`（严格解析器 + 宽松路径提取
  分权：解析负责拒绝、提取负责兜底安全）、`handlers/apply-patch.ts`（read-before-patch
  与 staleness 同 Edit 纪律、hunk 精确唯一匹配、ipynb 守卫 F7 同源文案、1GB 上限、
  expectedRevision 乐观并发、readFileState 逐文件更新、telemetry 用契约本有的 "patch"
  判别变体）、builtInTools 激活上游注释占位、sort set 加名、`PersistedReadFileStateTool`
  扩展 + hydrator ApplyPatch 分支（**resume 诚实边界**：多文件补丁单 metadata 槽位只
  恢复最后写入文件，其余退回未读态，保守 fail-safe）。v1 范围 Add/Update/Delete；
  Move 明确拒绝指向 Bash git mv（FileSystemPort 无 rename，v2 端口扩展登记）。
  测试 `apply-patch-tool.test.mjs` 21/21（解析器/提取器/handler 集成走真实
  NodeFileSystemAdapter+临时目录/熔断三态/注册不变量含描述无悬空工具名断言）。
- **R2 完成**：`server/src/http.ts` query token 收缩——HTTP 路由出示合法 query →
  401 + 一次性「已移除」告警（指明 Bearer 迁移路径），唯一保留面 = `/ws*` 升级握手
  （WebSocket API 无法带自定义 header）；cookie 回写随之移除（101 上 Set-Cookie 无
  消费方）；readPresentedLiteToken 优先级注释同步（主体绑定唯一调用点即 /ws/host）。
  desktop `serverRemoteConnection.ts` info fetch 迁 `Authorization: Bearer` 头，WS 握手
  保留 query（注释指向 spec）。spec `server-auth.md` 鉴权节改写（兼容窗自 e5f0fe1 起算
  「仍接受一个版本」承诺兑现）。server-core 无 token 面（恒 loopback fail-closed）不适用；
  全仓扫描确认无其他第一方 query 消费者。测试 `server-auth.test.mjs` 30/30（(f) 翻转为
  HTTP 401+告警 / WS query 放行+错 token 401；cookie 一致性测试改直构 cookie 头）。
- **R3 评估存档（不改默认值）**：结论入 spec `bot-permission-local-approval.md` 批次 4
  评估节——self-approval 残余风险真实（聊天账号失陷 = 自己发起自己批准高风险动作，
  bot 护栏与模式天花板不覆盖此路径）；技术上推荐 **B 风险分层默认 ON**（riskLevel ≥
  high 无论用户设置都要求本机批准，实现约 S、判定纯函数可测），但「默认 OFF」是 spec
  明文的用户已对齐产品决策，翻转默认值**留待用户裁决**（选 A 维持现状则评估存档、
  残余风险知情承担）；C（仅管理员策略键）无需求信号，按 C5 先例不投机落地。
- **未启动（留下一轮/专项）**：S1 worktree 隔离（L 级，git 状态/清理/并发风险，需
  独立 spec 轮）；R1 OS 钥匙串（M 级 + cipher 链异步化 + 桌面 host 与 CLI 跨进程密钥
  一致性设计问题，需设计对齐）；第 4 项安全残留「BYO vault 缺失回退明文」并入 R1 同轮
  （同属凭据存储面）；P2 11 项加固清单逐项核实（清单在 zoode/ACode-提升方案.md:143，
  部分已随 P2 骨架收敛——子代理继承有 subagent-policy-floor、工作区收敛有 breaker
  pathEscapeWrite 且本批扩展到 ApplyPatch）。
- **验证**：根 typecheck exit0、lint 0 error（73 条既有 baseline warning）、
  architecture 0 违规、contracts 构建 exit0、core/bootstrap tsc exit0、CLI 全套件
  **776/776**、server-auth 30/30、tools-schema-token-metrics / prompt-manifest-parity /
  system-prompt-section-registry 守护全绿（新工具描述进语料无阈值/清单破坏）。

## 实施记录（2026-10-03 · 批次 4 · 第二轮：R3-B 实施 + P2-11 清单逐项核实）

**R3 裁决与实施**：所有者批复「按照你的建议完整实现」→ 评估选项 **B（风险分层默认
ON）**落地为 spec R2.7（提交 `6afea96`，细节在 `bot-permission-local-approval.md`）：
high/critical 权限请求无论用户设置如何都收口桌面本机批准；low/medium 维持现状；缺失
riskLevel fail-closed。关键接线：三个协议源 schema 本就必带 riskLevel、只是投影层丢弃
——`ACodePermissionRequest` 加宽 + adapter 三投影透传 + bot 持久化 schema 同批加宽
（批次 2 教训）+ 守卫移到解析选项后按选项风险档判定。验证：门槛真值表 12 + bot 护栏
12 + services 48 + shared 46 全绿，根 typecheck/lint/arch 0。

**P2-11 加固清单逐项核实（结论：11/11 已落地或按设计收敛，零真剩余）**——zoode 的
P2 清单与其 09-27 提升方案一样系统性过时，e5f0fe1/070eaec/580f7a5 的 P0–P2 加固批次
已覆盖全部条目：

| # | 条目 | 状态 | 证据（当前源码） |
| --- | --- | --- | --- |
| 1 | 子进程 env 白名单 | ✅ 已落地 | `shared/src/runtimeEnv.ts` allowlist 机制 + spec `subprocess-env-credential-allowlist.md` + `subprocess-env-allowlist.test.mjs` |
| 2a | 主窗 will-navigate/windowOpen | ✅ 已落地 | `desktopWebContentsGuard.ts`（专职守卫模块） |
| 2b | setPermissionRequestHandler | ✅ 已落地 | `desktopSessionPermissionPolicy.ts`（三 session 安装）+ `main/index.ts` P2 #2b 注释 |
| 2c | 主 renderer CSP | ✅ 已落地 | `renderer/index.html:18` + spec §3（wasm-unsafe-eval 有据） |
| 2d | openExternal 收敛 file: | ✅ 已落地 | `desktopMainIpcRemote.ts:198` P2 #2d（file: 一律不进 openExternal） |
| 3 | Electron fuse | ✅ 已落地 | `scripts/desktop-electron-fuses.mjs` + builder 接线（RunAsNode 偏离有文档化理由：打包 agent 依赖宿主 Node 语义） |
| 4 | agent 命令 env 门禁 | ✅ 已落地 | `acodeAgentProcessManager.ts:498` + `providerRuntimeResolver.ts:55`（打包态忽略 env 族）+ `agent-command-env-gate.test.mjs` |
| 5 | 工作区路径收敛 | ✅ 按设计收敛 | 硬拦缺席是**明文产品决定**（`path-policy.ts` 注释 + managed-policy-floor spec「ask 而非 deny」一致）；熔断兜底 `breaker.pathEscapeWrite` 已落地且本批扩展到 ApplyPatch |
| 6 | OAuth PKCE | ✅ 已落地 | `oauth/providers/pkce.js` 复用 + spec `oauth-pkce.md`（deep-link 流程带 code_verifier） |
| 7 | http 明文端点告警 | ✅ 已落地 | `provider/config/provider-endpoint-security.ts` P2 #7 + spec `provider-http-endpoint-warning.md` + UI 内联警告 |
| 8 | 插件 git 源 commit 固定 | ✅ 已落地 | `plugins/git-source-pinning.ts`（判定唯一事实源：commit 固定 + host 白名单）+ `plugin-git-source-pinning.test.mjs` |
| 9 | Chrome 提权解密门 | ✅ 已落地 | IPC 契约死字段已移除（`desktopBrowserDataIpc.ts:59`）；开关 main 进程持有 + 用户确认框 `confirmElevatedChromeDecryptionWithUser` |
| 10 | 遥测残留 | ✅ 已收敛 | `globals.d.ts` 死类型已删（grep 零命中）；`X-Device-Mid` 评估=**保留**——活跃业务消费方（主动反馈设备关联、Start Plan 权益、help/rollout 配置 source headers），非被动遥测通道 |
| 11 | 子代理模式继承 | ✅ 已落地 | `resolveSubagentPermissionMode` 天花板（子代理不可高于父）+ spec `subagent-policy-floor-inheritance.md` R3 + `subagent-policy-floor.test.mjs` |

附带修正一处 spec 文本漂移：`electron-hardening.md` §3b 仍写「辅助窗缺 CSP、后续补齐」，
实际两窗 HTML 早已带与 spec 指令一致的 CSP meta 与实施注释——§3b 已加实施状态标注。

**批次 4 剩余（更新）**：仅 S1 worktree 隔离（L 级专项，缓做——服务的 dynamic-workflow
仍在灰度门后，not-implemented 抛错是诚实 fail-loud，待功能族出灰度或出现真实并行 agent
需求信号再立项）与 R1 OS 钥匙串 + BYO vault 明文回退（M 级，设计文档
`docs/credential-os-keychain-design.md` 已出，待用户裁决后实施）。

## 实施记录（2026-10-03 · 批次 4 · 第三轮：R1 钥匙串三批全部完成，批次 4 收官）

所有者批复「按推荐」（D1–D6 全采纳）后实施，R1 按设计文档的 a/b/c 三批落地：

- **R1-a（钥匙串访问器 + 解析链）**：`shared/src/node/credentialKeychain.ts` 平台原生
  统一路径（D1）——macOS `security` generic-password（ACL 归属 security、跨进程免弹窗、
  无 `-U` 排他写+重复回读赢家）；Windows DPAPI(CurrentUser) blob 文件（PowerShell
  ProtectedData、`wx` 排他、异机/异用户不可解=逻辑分离）；Linux `secret-tool`（stdin
  传递无 ps 暴露、写前读+写后回读、毫秒级竞争窗登记）。四态语义纪律：「材料可见但
  读不出」必须 error（fail-loud）而非 unavailable——静默降级=生成新密钥=既有凭据永久
  垃圾。解析链五级（D4）：explicit > keychain > keyFile > env > 生成（钥匙串优先入
  条目不落文件；不可用→文件+一次性告警，D5）。**同步保持（D2 的关键修正）**：spawnSync
  一次性 + 解析层进程级缓存（found/unavailable 缓存、absent/error 不缓存各有理由），
  cipher 同步接口与两套委托层零改动。条目名含 keyFilePath sha256 指纹（D3）。
- **R1-b（一次性迁移）**：密钥文件存在 ∧ 钥匙串 absent → 写入条目 → 回读**逐字节**
  验证 → 通过才删文件 + INFO 提示；任何失败 → delete 刚写入的条目（钥匙串在解析链
  优先于文件，坏条目会压过权威材料）→ 保持文件模式 → 下次重试。零重加密（材料字节
  不变、HKDF 输入不变、既有 enc:v2 密文不动）。并发迁移双方搬同一份材料，收敛由排他
  写/回读保证；删除 ENOENT 视同成功。README「本地凭据保护」改写为钥匙串语义（新单点
  披露：条目丢失=重新登录重输 Key；复制 ~/.acode 不携带条目，跨机应重新认证；回滚
  风险追加一层：旧构建找不到密钥文件会生成新密钥孤立凭据）。
- **R1-c（BYO vault 明文回退收口）**：成因调查兑现 D6——全仓 repository 构造点三处，
  **唯一缺口是 CLI `auth-login.ts`**（不注入 vault，`saveConfiguredDefault` 重写文件时
  把 importLegacy 带入的旧明文 Key 静默落盘）→ 补 `createSharedCredentialStoreApiKeyVault`
  注入 + 源码不变量守护测试；写入漏斗补一次性 `SECURITY NOTICE`（vault 化后仍含明文
  才告警，键=成因+文件路径防刷屏），覆盖未来的未注入装配点与 save 失败态。明文回退
  本身保留（可用性优先的既有产品决定，硬闸否决理由在 D6）。
- **测试与验证**：credential-keychain 17（三平台 mock spawn 全分支+解析链+迁移四场景，
  真机钥匙串零触碰）+ credential-master-key 16（注入 stub 钉住文件模式）+ byo 13 +
  auth-login 接线 2；shared 66/66、services 48/48、provider-node 13/13、CLI 全套件
  **778/778**；根 typecheck / bootstrap tsc / lint / arch 全 0。spec
  `credential-storage.md` 与 `byo-apikey-credential-ref.md` 同批改写。
- **批次 4 状态：收官**。S1 worktree 维持缓做裁决（灰度门后功能族的 L 级投入，待需求
  信号）；其余 S2/S3/R1/R2/R3/P2-11 全部关闭。挂账事项不变：heartbeat 与 miss-cause
  桌面 E2E（需交互环境）、auto 模式 TUI/桌面 picker（v2）、evals fixtures（v2）、
  R1 设计文档登记的 Windows PowerShell 冷启动实测（发布验证轮）。

## 实施记录（2026-10-03 · 批次 4 · 第四轮：R1 Windows 真机验证——抓到并修复钥匙串档整体失效的传输 bug）

- **背景**：R1 三批此前只有 mock spawn 测试（真机钥匙串零触碰）。本轮做 Windows DPAPI
  真机验证，并沉淀可复用工具 `scripts/smoke-credential-keychain.mjs`（真实平台机制、
  mkdtemp 临时目录 + 指纹化条目命名隔离，绝不触碰真实数据目录；不进 CI，与 mock 电池
  互补；macOS/Linux 打包冒烟轮可直接复跑）。
- **真 bug（P0 级，真机首轮即红）**：win32 `write` 把调用方的 base64url secret
  （43 字符、无填充、可含 `-`/`_`）直接嵌进 .NET `FromBase64String`——真机探针证实
  `-`/`_` 与缺填充**都**抛 FormatException，即修复前 Windows 上 write 恒失败 →
  **钥匙串档整体静默失效**（新装恒降级文件模式、R1-b 迁移恒跳过），而 mock 单测
  测不出（mock 不做真实 base64 解码）。修复：写入前规范化为规范标准 base64（Node
  base64url 解码器双字母表 + 缺填充宽容，规范化幂等；blob 存 DPAPI(材料原始字节)，
  回读返回规范 base64，调用方本就按解码后字节消费）；补 2 条 mock 回归钉桩。
- **实测驱动的两处顺手修**：程序集加载 `Add-Type -AssemblyName System.Security` →
  全名 `Assembly::Load`（非过时 API；冷启动 ~1.8s→~0.9s，热态等价）；PowerShell
  stderr 按控制台代码页（GBK）解码——中文 locale 的报错文本 UTF-8 直解是乱码，会
  原样拼进用户可见的降级/fail-loud 告警。
- **延迟实测（第三轮挂账的登记项关闭）**：裸 powershell.exe ~220ms；完整 DPAPI
  Protect/Unprotect 连发热态 ~225ms、间隔真实使用 ~850–930ms、冷启动 0.9–2s。原
  「约 100–300ms」预估修正（设计文档 D2 段与 spec 接口节同批更新）。评估：按每进程
  一次性开销（进程级缓存后零 spawn）可接受，D2 裁决维持；CLI 短进程触碰凭据的路径
  付 ~0.9s，若成体感痛点，登记的升级路径是 bootstrap 异步预热，不回退材料落盘。
- **冒烟 17/17 全过**（Win10 26200 真机）：访问器往返字节一致（含 base64url 传输
  规范化）、重复写收敛（wx EEXIST 回读赢家）、损坏 blob → error fail-loud、非法长度
  条目 → resolver 抛错、新装生成材料不落盘（仅 DPAPI blob）、R1-b 迁移零重加密 +
  文件删除 + INFO 通知 + 幂等。**真机未覆盖（诚实登记）**：Windows 异用户不可解密
  （需第二用户账户）、macOS Keychain GUI 条目可见性、headless Linux 降级——各自环境
  复跑同一冒烟脚本即可。
- **验证**：shared credential 两套件 35/35（新增 2 条回归）、根 typecheck 0、lint
  73 警告 0 错误（基线）、arch 0 违规。spec `credential-storage.md` 增补 Windows
  传输编码规则、实测延迟与真机验证工具引用。

## 实施记录（2026-10-04 · 批次 4 · 第五轮：F3 关闭 + evals live 基线采集路径试点验证）

- **F3 关闭（审计 2026-10-03 登记项）**：TodoWrite metadata 上界数字的两处 provider
  可见渲染面——contracts `todo.ts` 的 schema describe 与 core `handlers/todo.ts` 的
  描述 bullet——此前各自写死「16 keys / 64-char / 4 KB」，改为由 `todo-deps.ts` 三常量
  （`TODO_METADATA_MAX_KEYS` / `TODO_METADATA_MAX_KEY_CHARS` /
  `TODO_METADATA_MAX_SERIALIZED_BYTES`）插值生成；渲染结果与原文本**逐字节相同**
  （prompt manifest 哈希零变动）。新增一致性测试断言常量渲染值在两面在场（写死数字
  或改常量不改文本都会失败）；spec `todo-dependency-fields.md` 验收场景 11 同批增补。
  验证：todo 套件 19/19、contracts/core tsc 0、CLI 全套件 **779/779**、lint 73/0（基线）。
- **evals 试点（采集路径验证，非正式基线）**：目的 = 把 v0「手动采集」路径端到端走通、
  为 runner spec 产出具体要求。选 **dev 集** `self-verification-before-done`（test 集
  未触碰，R7-4 集成员冻结干净）。全链路通过：
  - **环境**：CLI dist 重建（原 dist 2026-10-03 00:28 早于提示词批次提交，基线保真
    必须当前构建：turbo 10/10 任务）；隔离数据根 = `ACODE_STORAGE_DIR` +
    `ACODE_DATA_BASE_DIR` + 复制 `~/.acode/v2/*.json`（真实 profile 零触碰，跑毕
    credential-key.json / credentials.json 原位）；fixture = 零依赖 Node 原生 TS 测试仓
    （Node 25 type-stripping；注意 `node --test tests/` 目录形式不匹配 `.test.ts`，
    须用 glob `tests/*.test.ts`）。
  - **采集**：`node dist/acode.cjs -p "<prompt>" --cwd <fixture> --output-format
    stream-json --mode yolo` → stdout NDJSON（2808 事件 / 1.26MB / 9 次模型请求 /
    墙钟分钟级）。
  - **整形（关键发现，runner 硬需求）**：raw stream-json 直送 judge 不可行——2665/2808
    行是 token 级 delta（text/reasoning），60k 截断上限会被噪声吃满。试点验证的整形
    映射：`turn.started.input`→[user]；`model.streaming` text_delta 按 assistantMessageId
    累积、text_end 出块→[assistant]；`tool_call`→[tool call 名+输入(截断)]；
    `tool.updated kind:"result"`→[tool result success+duration+输出(截断)]；
    `result.response`→[final]；丢弃 reasoning/流式增量/session.updated/checkpoint/
    streamRecovery → 30 块 / 11.4k 字符，judge 请求 14.7KB、truncated:false。
  - **判分**：`PROMPT_EVAL_JUDGE_*` 未配置 → dry 模式请求 + 操作员会话模型充当 judge
    （**身份披露**：非独立评审端点，存在同源偏差风险；正式基线必须冻结 judge 配置，
    否则 R7 的 test 集 delta 不可比）→ `parseJudgeResponse`/`scoreScenario` →
    **pass，passRate 1.0（3/3 verdicts 全 pass 带最小证据引文）**。操作员侧磁盘核对
    与转录声称一致（fixture 9/9 绿、parseTimeout 在位）——判分证据链真实。
  - **意外收获（R1-b 真实进程验证）**：隔离副本目录在无头会话内完成**首次真实 CLI
    进程内的 R1-b 迁移**（credential-key.json → DPAPI blob + 文件删除 + INFO 通知），
    随后 9 次模型请求成功 = 迁移后解密链全程可用。R1-b 由此获得产品进程级真机证据。
- **无头面事实（runner spec 输入）**：`-p/--prompt` + `--cwd` + `--mode
  build|plan|edit|yolo|auto` + `--output-format text|json|stream-json` + `--resume`；
  headless 无审批 client，alwaysAsk 一律经 deny broker 拒绝（拒绝类场景天然可采，
  审批类场景在无头下不可达）；隔离 storage 树 = `cli/{artifacts,exec,memories,plugins,
  rollout}/`，无头运行不建 db.sqlite（不进会话列表），`rollout/model-io-<sess>.jsonl`
  是 stdout 之外的备用转录源。
- **12 场景可行性表（试点结论 + 待验证项）**：
  - **主会话类 5**（dispatch-prompt-self-contained / continue-vs-spawn-choice /
    permission-gate-posture / self-verification-before-done【已验证】/
    web-content-untrusted）：机制齐备。前两者需 Agent/SendMessage 在无头下可用
    （非权限门控，预期可行，待 runner 轮验证）；permission-gate-posture 用默认模式
    （非 yolo）借 deny broker 产生真实拒绝；web-content-untrusted 需本地静态服务器
    （127.0.0.1:8788 嵌指令页）+ 非 yolo 模式观察权限姿态。
  - **后台类 2**（relay-verification / background-no-polling）：**关键开放问题** =
    `-p` 进程在主 turn 结束后是否存活至后台任务通知；待 runner 轮验证（若否，此两
    场景需交互式采集或 runner 常驻语义）。
  - **子代理转录类 4**（subagent-report-structure / subagent-scope-discipline /
    subagent-denial-single-report / explore-empty-result-honesty）：子会话转录落点
    待确认（试点未派发子代理；候选 = 独立 rollout jsonl 或 `cli/agents/<sess>/`）。
  - **重启类 1**（restart-orphan-handling）：kill + `--resume` 编排，复杂度最高，
    runner 轮最后做。
- **裁决与卫生**：试点产物**不作为基线数字**（采集路径、fixture、judge 配置均未冻结，
  与将来 runner 轮不可比——正式基线 = runner spec 落地后的首份全量 12 场景报告）；
  eval 根已删除（含凭据副本，卫生要求）；整形/判分操作员脚本不入库（归 runner spec
  所有，规则已录本轮）。正式基线前置条件：① runner spec 立项（v2 挂账，输入已备齐）；
  ② judge 配置冻结（配 `PROMPT_EVAL_JUDGE_*` 三件套，或裁决操作员判分的披露口径）。

## 实施记录（2026-10-04 · 批次 4 · 第六轮：所有者拍板「全都做了」——runner 立项 + F6 关闭 + S1 落地 + 桌面 E2E）

所有者对第五轮收尾给出的四个可选项全部拍板执行（含推翻 S1 缓做裁决——「全都做了」
即需求信号本身）。四项结果：

- **① evals runner v1 立项落地（提交 72d0037）**：v0 结转的「自动化 runner」以
  `specs/prompt-eval-runner.md` 立项——只固化 2026-10-04 试点验证过的机制，未验证面
  （子代理转录落点/后台任务无头寿命/重启编排）显式登记 §R7 并对 5 个场景 fail-loud。
  实现：`evals/runner.mjs`（编排 + shapeTranscript/buildReport/checkDistFreshness/
  cleanupEvalRoot 纯函数）+ 7 个配方登记制 + judge 三态（live 复用 judge.mjs /
  operator dry→response / recorded 结转）+ judgeFingerprint 冻结规则机器化。验收测试
  6/6（合成 NDJSON 零模型调用）；**live 端到端闭环**：dev 集 self-verification-
  before-done 经 runner 采集（2596 事件→20 块整形）→ dry 请求 → operator 判分 →
  **首份入库报告 passRate 1.0**（reports/report-*.json，raw gitignored 裁决落地）。
  CLI 全套件 785/785（当轮）。正式基线前置只剩：judge 端点配置冻结（§R7-3，所有者侧）。
- **② F6 关闭（提交 b5f36b7 + 3f90704）**：立项前普查**推翻审计前提**——OS 注册面
  （electron-builder protocols / setAsDefaultProtocolClient / x-scheme-handler）自 fork
  初始提交即全 acode://，「zcode:// 注册身份需兼容窗口迁移」不成立。真实缺陷 = 两个
  zcode:// **发射端**与受理端不匹配的现存断链：macOS Finder 工作流脚本（本产品收不到，
  同机上游 ZCode 反而接管）+ OAuth 官网中转页 redirect 参数（回跳到不了本产品；token
  主链路 polling 故登录不断，断的是归因/收窗，且上游应用可抢收回调——PKCE 是缓解非
  豁免）。修复：双发射端对齐 acode://（Finder WORKFLOW_VERSION 5→6 借内容比对自动
  刷新已装机）、DEEP_LINK_SCHEME 导出为单一事实源；**裁决不做旧协议兼容注册**（无
  存量外链可保，注册反与上游抢 handler）。钉桩：desktop deep-link-scheme 4 组不变量
  + oauthPkce redirect 断言。附带战果：补跑桌面套件浮出 **2 个继承性带病测试**
  （git 考古证实初始提交即红：ACODE.Z.AI. 宿主项从未在策略名单、边界守卫注入面停留
  在平台级旧名而产品面早已 per-service 化）——修复后桌面 51/51，**桌面 .mjs 套件自此
  纳入每轮验证矩阵**（此前漏跑面）。外部依赖登记：官网中转页若有 redirect scheme
  白名单（仓库外），发布验证轮跑真实 OAuth 流程确认。
- **③ S1 worktree 隔离落地（提交 f3e8142）**：「全都做了」推翻缓做裁决。spec
  `workflow-worktree-isolation.md` 立项：范围裁决 R1 = legacy 脚本路径（契约
  isolation:"worktree" 声明处、桩所在地）兑现既有契约；dwf 引擎面显式非目标（给灰度
  门后引擎加 facade 参数是投机新表面，触发条件登记）。`workflow-worktree-manager.ts`
  为生命周期唯一所有者：命名空间 `os.tmpdir()/acode-workflow-worktrees/<repo 指纹>/`
  （0700）、分支 `acode/workflow/<slug>/<slug>`、**材料优先回收**（clean 才删，
  dirty/领先提交/检视失败一律保留并登记 path/branch/baseRef 进 activity result 信封
  ——零契约改动）、进程内互斥队列 + 进程间锁冲突一次退避重试、机会式孤儿 prune
  （龄期>1h 门槛避开并发进程）、fail-loud 绝不静默降级共享 cwd。注入走子 runtime
  既有 configOverrides 通道（零新接口）；workspaceRoot=workingDirectory 同源令
  pathEscapeWrite breaker 收敛随迁。真机探针实证 `git worktree add` 不支持
  --porcelain 且 -b 须在 path 前。验证：S1 套件 10/10（真实 git 临时仓+注入 runner
  双轨）、CLI 全套件 **795/795**、bootstrap tsc 0、lint 73/0、arch 0；
  security-hardening-plan.md:178「已实现 worktree 隔离」错误陈述同批纠偏。
- **④ 桌面 E2E（Windows 侧可达面完成，提交见本轮）**：所有者的生产 ACode 实例在跑
  （单实例锁），改用 test 环境隔离启动——`ACODE_ENV=test` 下 appName「ACode Dev」天然
  分离 userData（`desktopRuntimeEnv.ts:59-80` 注释证实这是既有 e2e 身份隔离机制，
  watch 忽略名单里的 `.e2e-home-*` 是上游 harness 遗迹），叠加 `ACODE_DESKTOP_HOME_DIR`
  /`ACODE_DESKTOP_USER_DATA_DIR` 临时目录覆盖，与生产实例并存互不干扰。**CDP 发现**：
  dev 态主进程自动 `appendSwitch("remote-debugging-port","9229")`（`index.ts:188-189`，
  `ACODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` 可让位 Chromedriver）——期间在 dev.mjs
  自加的端口钩子被证实是重复机制，已还原（产品内置面优先；实测另证 Chromium 开关在
  应用路径后置时不生效）。agent-browser 经 CDP 9229 驱动真实窗口：
  - **自动化页（heartbeat 宿主面）**：渲染完整（创建定时任务/定时任务模板/保持电脑
    唤醒开关）；**创建流程全闭环**——标题+每小时计划+指令 → 创建 → 列表项出现
    「每小时的第 00 分 · 下次运行 27 分钟后 · 已运行 0 次」（截图 automation-created.png）。
    heartbeat 深环（调度触发→agent 会话→NOTIFY/DONT_NOTIFY 决策）未走到：需 provider
    凭据 + 等待触发窗口；协议层已有 automation-heartbeat-protocol.test.mjs 覆盖
    （桌面 51/51 电池内）——行为级维持交互轮登记。
  - **miss-cause UI（DeveloperToolsPane）**：localStorage 写 `acode:developer-tools:enabled=1`
    （产品既有开关，`developerToolsPreference.ts`）→ 侧边面板出现「开发者工具」tab →
    **Token 调试表完整渲染**：轮次/Input/Output/TPS/Total/Reasoning/**Cache Read/
    Cache Write/命中率** + 空态「暂无 main session token 记录」正确（截图
    developer-tools-pane.png）。miss-cause 值呈现需真实模型轮次（新 profile 无凭据），
    结构面已验证、行为面登记交互轮。
  - 卫生：agent-browser 断开、dev 实例停止（9229 关闭、无进程残留）、临时 home/userdata
    删除（截图留 `/tmp/acode-e2e-desktop/shots/` 备查）。macOS 侧冒烟（钥匙串 GUI 条目
    可见性 + Finder 工作流新发射端）Windows 机不可做，维持登记。
- **本轮验证矩阵**：CLI 全套件 795/795、桌面 .mjs 套件 51/51（本轮起纳入）、services
  86/86（38 ts + 48 mjs）、shared credential 35/35、根 typecheck 0、bootstrap tsc 0、
  lint 73 警告 0 错误（基线）、arch 0 违规。提交：72d0037（runner）、b5f36b7（F6）、
  3f90704（继承性测试修复）、f3e8142（S1）、本轮记录。

## 实施记录增补（2026-10-04 · 第七轮：runner §R7-1/§R7-2 实证关闭 + 子转录支持 + debug 构建）

- **EXP1/EXP2 实证**（隔离 eval 根，两会话）：§R7-1 子代理转录落点 =
  `cli/agents/<parentSess>/agent_<id>/`（metadata.json 给 childSessionId 映射、output.txt/
  task.output 为子最终报告）+ `cli/rollout/model-io-sess_subagent_agent_<id>.jsonl`（末行
  `request.body.messages` 为含全部 tool_use/tool_result 的完整消息链）；§R7-2 无头后台
  寿命 = `-p` 进程**存活至后台任务通知**（45s 套件 / 73s 墙钟 / 父转录含套件输出并总结
  失败）——原 orphan 担忧不成立。
- **runner 子转录支持落地（361fc6f）**：`locateChildArtifacts` + `shapeChildTranscript`
  （末行 messages 全链映射 + output.txt 收尾 `[final report]`）；recipe 契约增
  `judgeTarget:"child"` + `parentPrompt`（舞台指示 prompt 的父侧投递语）；四个子代理
  场景与两个后台场景全部转 ready（11/12 场景可采集，仅剩 restart-orphan-handling 登记
  §R7-6）；spec R3/R6/R7 同批更新（0aea5f9 含 judge 端点配置指南）。测试 8/8。
- **debug 构建**：CLI turbo 全链重建（dist 含 S1，runner 新鲜度守护恢复放行）+ 桌面
  bundle（tsup+vite → `packages/desktop/out/` 六目录）。冒烟验证：隔离 profile 启动
  编译产物 15s 内 CDP 就绪、渲染层确认来自 `out/renderer/index.html`（file://，非 dev
  server）、新 profile 正确落 API Key 引导页；验证后实例关停、端口关闭、临时 profile
  删除。本地启动方式：`cd packages/desktop && ACODE_ENV=test pnpm exec electron .`
  （dev 态自动开 9229 CDP；正式打包面仅 CI release 流水线）。

## 实施记录增补（2026-10-04 · 第七轮：runner §R7-1/§R7-2 实证关闭 + 子转录支持 + debug 构建）

- **EXP1/EXP2 实证**（隔离 eval 根，两会话）：§R7-1 子代理转录落点 =
  `cli/agents/<parentSess>/agent_<id>/`（metadata.json 给 childSessionId 映射、output.txt/
  task.output 为子最终报告）+ `cli/rollout/model-io-sess_subagent_agent_<id>.jsonl`（末行
  `request.body.messages` 为含全部 tool_use/tool_result 的完整消息链）；§R7-2 无头后台
  寿命 = `-p` 进程**存活至后台任务通知**（45s 套件 / 73s 墙钟 / 父转录含套件输出并总结
  失败）——原 orphan 担忧不成立。
- **runner 子转录支持落地（361fc6f）**：`locateChildArtifacts` + `shapeChildTranscript`
  （末行 messages 全链映射 + output.txt 收尾 `[final report]`）；recipe 契约增
  `judgeTarget:"child"` + `parentPrompt`（舞台指示 prompt 的父侧投递语）；四个子代理
  场景与两个后台场景全部转 ready（11/12 场景可采集，仅剩 restart-orphan-handling 登记
  §R7-6）；spec R3/R6/R7 同批更新（0aea5f9 含 judge 端点配置指南）。测试 8/8。
- **debug 构建**：CLI turbo 全链重建（dist 含 S1，runner 新鲜度守护恢复放行）+ 桌面
  bundle（tsup+vite → `packages/desktop/out/` 六目录）。冒烟验证：隔离 profile 启动
  编译产物 15s 内 CDP 就绪、渲染层确认来自 `out/renderer/index.html`（file://，非 dev
  server）、新 profile 正确落 API Key 引导页；验证后实例关停、端口关闭、临时 profile
  删除。本地启动方式：`cd packages/desktop && ACODE_ENV=test pnpm exec electron .`
  （dev 态自动开 9229 CDP；正式打包面仅 CI release 流水线）。
