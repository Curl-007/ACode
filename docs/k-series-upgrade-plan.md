# jcode 能力差距升级方案（K-Series Upgrade Plan）

本文件是 2026-10-04 对 jcode（本地检出 `C:\Users\ZhuanZ\Desktop\jcode`，v0.89.2，commit
`76df6464b`）第二轮差距分析的落地路线图。第一轮（2026-09-30，
[`jcode-inspired-upgrade-plan.md`](jcode-inspired-upgrade-plan.md) J1-J4）消化了 jcode
**工程防御层**的精华并已全部合入；本轮消化剩余的**产品级能力差距**——九个立项项（K1-K9），
覆盖记忆语义召回、对话内自组织任务图、挂机执行、会话搜索、导入生态、预算感知调度、
公开引擎边界与 IDE 嵌入。

> **文档状态**：方案（plan）+ 全部条目 spec 已落（2026-10-04）。**本方案只交付 spec，未实施任何代码**。
> 每项落地前按 AGENTS.md spec-first 约定以对应 spec 为准；本文件只做批次编排、依赖关系与优先级，
> 与单项 spec 冲突时以单项 spec 为准。
>
> **生成日期**：2026-10-04。**行号时效性**：ACode 侧 `file:line` 以 dev/0.0.2 `7798f76` 检出为准；
> jcode 侧以其本地检出 v0.89.2 为准。实施前需复核，定位以文件名 + 符号名为主。
>
> **合规声明**（沿用第一轮口径）：jcode 为 MIT 许可仓库，仅本地参照，不入库。本文与各 spec 只做
> 机制级提炼转述，不含其源码原文；实施时翻译 substantial 逻辑的文件，在文件头注释保留 jcode
> 出处与 MIT 归属，并评估是否需在 `THIRD-PARTY-NOTICES.md` 登记。禁止将 jcode 仓库任何文件
> 直接拷入 ACode。

---

## 执行摘要

第一轮结论「ACode 功能覆盖面不落后于 jcode，差距集中在防御深度」在防御维度已被 J1-J3 关闭。
本轮三路对照调研（jcode 编排调度域 / jcode 工具记忆 SDK 域 / ACode 现状盘点）的修订结论：

1. **能力差距仍然真实存在的**集中在六个域：记忆召回无语义层（J3-3 维持评估项两年未动）、
   编排缺「模型自组织任务图」形态（expert workflow 是 definition 预定义图 + planner 扩张，
   dynamic-workflow 是确定性 TS 脚本，都不是模型在对话中维护的持久 DAG）、无挂机长时执行
   （off-peak 是服务器驱动排队，语义不同）、无会话内容搜索（只有按 id 的 ReadSessionContext）、
   导入只支持 Claude Code 一个来源、引擎边界全部 private 无公开稳定协议。
2. **已对齐的域不再立项**：并行工具调用（scheduler parallelGroups）、后台 shell、hooks、
   compact、cron、browser、doctor、todo 置信度、自更新、邮件/IM 批准通道（bots 渠道在）。
   第一轮的 J4 战略储备中，无人值守（K3）、SDK（K7）由本轮升级立项，**会话迁移（原 J4-1
   cloud move）维持登记不立项**——ACode 手机远控是重放语义（web-remote-replayable），
   活会话跨机迁移需要先解决 lease/epoch 与远程 workspace 的所有权模型，属产品决策，见「非目标」。
3. **明确不学**（与第一轮一致）：IDE 订阅额度借用、compile_remote 云编译订阅、selfdev
   canary 自举晋升、TUI 渲染件。K7 的 launch 模式**只继承 ACode 自己的凭据库**，不做
   jcode 式 20+ 家第三方 IDE 凭据拷贝（同订阅借用红线）。

## 优先级总览

| 批次       | 项  | 主题                                                      | spec                                                                                                        | 影响包                         | 工作量 | 前置            | 状态                                                                                                                                |
| ---------- | --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------ | ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **A 地基** | K1  | 记忆语义召回（BM25+RRF → dense → LLM rerank 三阶段）      | [`specs/memory-semantic-recall.md`](../apps/acode-cli/specs/memory-semantic-recall.md)                      | core/services/contracts        | L      | J3-2（已合入）  | **已实施 @50c97b5**（Phase A；B/C 阶段接口位就绪待度量决策）                                                                        |
| **A 地基** | K4  | 跨会话搜索（SQLite FTS5 + SessionSearch 工具）            | [`specs/session-search.md`](../apps/acode-cli/specs/session-search.md)                                      | adapters/core/contracts        | S-M    | 无              | **已实施 @50c97b5**（trigram 主路径+实测附录）                                                                                      |
| **A 地基** | K9  | 工具微增补（invalid 反馈护栏 / open 工具）                | [`specs/tooling-micro-additions.md`](../apps/acode-cli/specs/tooling-micro-additions.md)                    | core/contracts/shared          | S      | 无              | **已实施 @50c97b5**（CLI native opener 修订）                                                                                       |
| **B 引擎** | K2  | 对话内 swarm 任务图（模型自组织 DAG + artifact dataflow） | [`specs/swarm-task-graph.md`](../apps/acode-cli/specs/swarm-task-graph.md)                                  | core/contracts                 | XL     | J2-3（已合入）  | **已实施 @063aec3**（四段交付，复核修复闭环）                                                                                       |
| **B 引擎** | K3  | Overnight 挂机执行（时间闸状态机 + 交接协议 + 晨报）      | [`specs/overnight-execution.md`](../apps/acode-cli/specs/overnight-execution.md)                            | core/services/contracts        | M      | 无              | **已实施 @063aec3**（fork 链落位 session fork 修订）                                                                                |
| **C 平台** | K5  | 外部会话导入来源扩展（Codex/Gemini CLI/opencode/Cursor）  | [`specs/external-session-import-sources.md`](../packages/services/specs/external-session-import-sources.md) | services/ui                    | M      | 无              | **已实施 @16621e8**（codex 真实样本核实；UI 面登记后续）                                                                            |
| **C 平台** | K6  | Ambient 预算感知调度（usage 滚动账本 + 双层调度）         | [`specs/ambient-budget-scheduler.md`](../apps/acode-cli/specs/ambient-budget-scheduler.md)                  | core/services/contracts        | M-L    | K6 前置子项内含 | **已实施 @16621e8**（默认关；跨进程 flock 登记后续）                                                                                |
| **D 生态** | K7  | Harness API 公开稳定面 + TS SDK（launch/connect）         | [`specs/harness-api-public-surface.md`](../packages/server/specs/harness-api-public-surface.md)             | server/shared/contracts/client | L      | 无              | **已实施 @73dab5f**（4 方法 not_supported 诚实降级）                                                                                |
| **D 生态** | K8  | ACP 宿主适配（IDE 经 Agent Client Protocol 嵌入）         | [`specs/acp-host-adapter.md`](../apps/acode-cli/specs/acp-host-adapter.md)                                  | cli/server                     | M      | **K7**          | **已实施**（本批；ACP v1 schema 1.24.1 快照、loopback in-process 决策、F1 入口断裂修复+归属过滤/超时/行长/回收/死亡传播，附录 A.4） |

> S=小（≤1 天）M=中（1–3 天）L=大（>3 天）XL=特大（>5 天，需拆实施批次）。
> 批次内无依赖项可并行；跨批次 A → B → C → D 顺序推进（A/B 可交错，K8 严格在 K7 后）。
>
> **实施纪律（与第一轮一致）**：每项独立分支 → spec 先行已满足 → 实现 + 对抗测试 →
> `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` / CLI 测试全绿 →
> 对抗复核 → squash 合入 dev（[git-collaboration.md](git-collaboration.md)）。
> 并行实施时遵守已授权的子智能体调度模式：整合方落契约，实现方互斥所有权。

## 依赖关系

```
J1-J5（第一轮，已全部合入）
  ├─ K1 记忆语义召回 ────依赖─── J3-2 pending injector（capture/verify/inject 通道复用）
  ├─ K2 swarm 任务图 ────依赖─── J2-3 typed artifact / gate / artifact-or-nothing
  ├─ K3 overnight ──────────── 复用 sourceTaskId fork + turn 后调度点模式
  ├─ K4 会话搜索 ───────────── 独立（adapters session-store）
  ├─ K5 导入扩展 ───────────── 独立（claude-native 模式泛化）
  ├─ K6 ambient ────────────── 内含前置子项「usage 滚动账本」
  ├─ K7 harness API ────────── 独立（协议层）；K9 的 open 工具无关联
  └─ K8 ACP ──────────依赖─── K7 harness API 稳定面（翻译目标）
```

## 批次详述摘要

### 批次 A · 地基（可三项全并行）

**K1 记忆语义召回**（原 J3-3 评估项升级立项）：J3-2 已把「注入什么协议」钉死（绑定-重验证-
fail-closed），K1 补「选出注入什么」——三阶段递进：Phase A 纯 BM25 + RRF 融合（零新依赖，
先拿到「比 mtime 排序好」的基线）→ Phase B 本地 dense embedding（transformers.js wasm
后端跑 MiniLM-L6-v2 int8，规避 Electron 原生 ABI 问题；`embedding_model` 标签隔离，
不变量「一向量空间一索引」）→ Phase C LLM listwise 重排（jcode 实测 recall@5 0.53→0.75）。
**同时落 J3-2 登记的两条前置债**：TTL 限速层（防微改写绕过去重）与单调时钟源。
记忆图演化（supersede 边）为可选 Phase D。

**K4 跨会话搜索**：`adapters/src/storage/session-store`（自研 SQLite）加 FTS5 虚表 +
触发器同步维护；core 新增 `SessionSearch` 工具（默认隐藏当前会话与工具噪音）。
实施首日验证 FTS5 可用性，不可用回退 LIKE + 内存倒排（spec 有回退条款）。

**K9 工具微增补**：`invalid` 工具（畸形工具调用的显式反馈通道，模型可学习修复）；
`open` 工具（`IPlatformService.openExternal` 已在 `packages/shared/src/platform.ts:626`，
只缺 agent 工具面）。jcode_docs 自文档搜索**裁剪不做**（ACode 的 spec/AGENTS 注入已有
context 体系覆盖，价值弱，理由记入 spec 边界）。

### 批次 B · 引擎

**K2 对话内 swarm 任务图**（本轮最大件）：把 expert workflow 的图从「definition 预定义 +
planner 扩张」扩展出第三形态——**模型在主对话中经工具族（plan_seed / plan_expand /
plan_complete / plan_inject_gap / plan_status / plan_control）维护持久 TaskGraph**。
引擎侧新增验证式图变更 ops（clone-stage-commit + 环检测，移植 jcode `dag/ops.rs` 语义）与
artifact dataflow（Done 上游 artifact 注入子节点 prompt）。复用 J2-3 已落的 typed artifact
契约、gate 点名、artifact-or-nothing。**裁剪**：swarm member/channel/broadcast 体系
（jcode 的多进程 TUI 生态）不搬——worker = 既有 workflow 子会话，死 worker 的节点 requeue。

**K3 Overnight 挂机执行**：`/overnight <hours>` 语义落 ACode——fork 隐藏 coordinator
任务（复用 `sourceTaskId` fork 链），三层时间闸（handoff_ready → 晨报 → post-wake grace →
final wrapup）+ 四种 poke prompt + preflight 资源快照。supervisor 挂 runtime 层 turn 后
调度点（与 memory extraction 同模式）。生命周期**绑定 app 运行期**（不承诺关机续跑），
与 off-peak（服务器驱动）语义正交可组合。晨报/复审产物走任务卡片 markdown，桌面 UI 直接
渲染，不做 jcode 的 review.html。

### 批次 C · 平台

**K5 导入来源扩展**：把 `claude-native` 导入模式泛化为 external-session-import 框架
（`ExternalSessionSourceAdapter` 接口：discover/parse/normalize），新增 OpenAI Codex、
Gemini CLI、opencode、Cursor 四个 adapter；输出统一 external record 后复用既有
build/persist/repair 链路。含对抗测试要求（恶意会话文件防护，对标 jcode
`claude_adversarial.rs`）。repo_ranking（git 活跃度排序）为可选子项。

**K6 Ambient 预算感知调度**：双层语义——agent 提议层（schedule 工具创建 wake 请求，
target 三态 ambient/session/spawn）+ 系统限流层（AdaptiveScheduler 按 token 预算反推
interval，`(余量 − 用户 1h 滚动速率 × 窗口) × (1 − user_budget_reserve 0.8)`，指数退避
×2 封顶 64）。**前置子项**：usage 滚动账本（24h/1h 窗口，磁盘 JSONL，复用 usage-observability
计量点）。与 cron 的边界：cron=用户显式定时时刻触发；ambient=agent 提议 + 系统按预算
窗口约束，两体系并存不合并。

### 批次 D · 生态

**K7 Harness API 公开稳定面**：把引擎边界从「Desktop 私有 stdio 协议
（acode-protocol v4）」投影出一个**版本化、Unknown 兜底、帧自描述**的公开 NDJSON 面
（Hello/ListSessions/CreateSession/SendMessage/流事件/PermissionResponse/ConfigureTools…），
落 `packages/server` 新 harness 子协议；TS SDK（launch/connect 双模式）独立成包。
launch 模式凭据继承**仅限 ACode 自有凭据库**（provider 包管的面），jcode 式第三方 IDE
凭据拷贝明确不做（红线）。

**K8 ACP 宿主适配**：新增 `acode acp` 入口进程，把 Agent Client Protocol（Zed 主导的
JSON-RPC over stdio）翻译到 K7 harness API：session/new↔CreateSession、
session/prompt↔SendMessage、权限请求双向桥。**严格依赖 K7**（翻译目标须先稳定）。

## 非目标（维持登记或明确不做）

1. **活会话跨机迁移**（原 J4-1 cloud move，jcode `src/cli/cloud_move.rs` 租约+epoch+git
   bundle 三件套）：维持登记不立项。理由：ACode 手机远控走 `web-remote-replayable` 重放
   语义（AGENTS.md 进程协议章），活迁移需要 lease/epoch 与远程 workspace 注册表的所有权
   模型重构，产品决策未做；jcode 设计（会话=单所有者租约+单调 epoch）作为届时参照已记入
   第一轮附录 A。
2. **IDE 订阅额度借用 / compile_remote / selfdev canary / TUI 渲染件**：与第一轮结论一致。
3. **jcode_docs 式自文档搜索**：裁剪，理由见 K9 spec 边界章。
4. **Rust/Python SDK**（jcode `sdk/typescript` 镜像生态）：登记不立项，K7 只交付 TS SDK。

## 附录 A · jcode 关键参照文件索引（本轮新增部分）

| jcode 位置（checkout 76df6464b）                                                               | 机制                                                               | 对应 ACode 项 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------- |
| `crates/jcode-embedding`（635 行，tract ONNX + MiniLM）+ `jcode-base/src/embedding_backend.rs` | 向量空间按模型标签隔离不变量、后端可插拔                           | K1 Phase B    |
| `crates/jcode-base/src/memory.rs:567-633`（hybrid 检索）+ `memory_rerank.rs`                   | BM25+dense RRF 融合（k=60、pool=5×limit、无硬阈值）、listwise 重排 | K1            |
| `crates/jcode-base/src/storage/`（会话 FTS/索引预热）+ `tool/session_search.rs`（1892 行）     | 默认隐藏当前会话与工具噪音                                         | K4            |
| `crates/jcode-plan/src/dag/`（mod/ops/schedule/sim 共 ~4.7k 行）                               | 验证式图变更、确定性调度、模拟器先行                               | K2            |
| `crates/jcode-plan/src/lib.rs:150`（VersionedPlan，plan 与 todos 刻意分离）                    | plan 是 server 级共享状态                                          | K2            |
| `crates/jcode-overnight-core`（1471 行）+ `jcode-app-core/src/overnight.rs:231-384`            | 三层时间闸 + 四种 poke + preflight                                 | K3            |
| `crates/jcode-import-core`（2421 行，5 来源 + repo_ranking + 对抗测试）                        | SourceAdapter 模式                                                 | K5            |
| `crates/jcode-ambient-types` + `jcode-app-core/src/ambient/{scheduler,runner}.rs`              | 双层调度、预算反推 interval、指数退避                              | K6            |
| `crates/jcode-harness-api`（1916 行）+ `jcode-harness-api-server`（4653 行）                   | 版本化帧 + Unknown 兜底 + 独立翻译桥                               | K7            |
| `crates/jcode-sdk`（5924 行）+ `sdk/typescript`                                                | launch/connect 双模式、结构化输出                                  | K7            |
| `src/cli/acp.rs`（2201 行）                                                                    | ACP 宿主适配层                                                     | K8            |
| `crates/jcode-tool-core/src/lib.rs:48-92`（invalid 工具语义）                                  | 畸形调用显式反馈                                                   | K9            |

（第一轮的参照索引见 [`jcode-inspired-upgrade-plan.md`](jcode-inspired-upgrade-plan.md) 附录 A，不重复。）

## 附录 B · 分析来源

本方案基于 2026-10-04 三路只读调研：jcode 编排调度域深挖（swarm/overnight/ambient/batch/
selfdev + src/cli 全清单）、jcode 工具记忆 SDK 域深挖（40+ 工具清单/记忆 9k 行/embedding/
SDK/导入/harness-api）、ACode 现状九主题盘点（subagent+dynamic-workflow/三套后台机制/
记忆无 embedding/42+ 工具/无私有 SDK 之外的公开面/仅 Claude 导入/compact 完整/GLM-only
provider/hooks 完整），叠加 2026-09-30 第一轮分析记忆（`jcode-rust-harness-value.md`）。
关键锚点行号已在本仓 dev/0.0.2 `7798f76` 检出上抽样核实；spec 内标注「实施首日复核」的
条目以符号名为准。
