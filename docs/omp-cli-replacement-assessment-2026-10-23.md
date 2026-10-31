# 用 omp（oh-my-pi）替换 ACode Agent CLI 的可行性评估

> **文档状态**：评估结论（assessment），供后续决策。**日期**：2026-10-23。**评估对象**：`C:\Users\Administrator\Desktop\oh-my-pi`（omp，`@oh-my-pi/pi-coding-agent` v18.12.6，HEAD `0b5c27ab24`，origin `github.com/can1357/oh-my-pi`）。**被替换方**：ACode `apps/acode-cli`（native `glm` 引擎，`acode.cjs app-server --stdio`）。
>
> **姊妹评估**：[jcode 候选评估](jcode-cli-replacement-assessment-2026-10-23.md)——同题不同候选，其 §8 有两者的横向对比表（结论：jcode 净优于 omp，但各有前置墙）。
>
> **评估方法**：4 路并发只读子代理深度分析（omp 架构 / ACode 客户端契约 / 协议桥接 / 非功能冲突），主 agent 亲验三条最硬的载荷性事实（见附录 B）。全文只读，未改动任一仓库。

## 结论（先读这段）

**直接替换不可行。唯一可行形态是「ACode 客户端零改动 + 新增 v4↔omp-RPC 翻译 shim + omp 作可选 agent 后端」，且这是一笔 3–5 人月一次性投入 + 每月 1–2 人周永久追踪税的工程账，代价是 ACode 独有防御能力净倒退。**

除非明确需要 omp 的三项 ACode 没有的能力（DAP 调试、语音 STT/TTS、多人实时协作），否则这笔账不划算。**建议不推进**；若推进，先做 2–3 人日 spike 证伪/证实桥接路线（见 §8）。

三堵墙（§2）、协议鸿沟（§3）、治理否决（§2.3）任一单独成立都足以否决"换个二进制客户端照跑"的朴素设想。

## 1. 背景与评估范围

- **诉求**：把 ACode 自己的 Agent CLI（`apps/acode-cli`）换成 omp，并适配 ACode 客户端（Desktop / Web / TUI）。
- **两者都是"一码多端"的 AI coding agent**，但实现基座完全不同：
  - **ACode agent**：Node 24（V8）+ TypeScript，生产形态是 Electron-as-node 跑 V8 字节码；对客户端说私有 **acode-protocol-v4**（状态投影协议）。
  - **omp**：Bun（JavaScriptCore）+ TypeScript + ~35 万行 Rust（napi cdylib）；对外说 **omp-RPC**（事件日志协议，NDJSON over stdio）。
- **评估边界**：本文覆盖协议桥接、运行时、能力得失、供应链、测试门禁、工作量。不覆盖具体 shim 代码实现。

## 2. 三堵墙

### 2.1 运行时引擎不可调和（V8 ↔ JavaScriptCore）—— 严重度：高

不是版本差，是两套 JS 引擎：互不能运行对方字节码、互不暴露对方 host API。

- **omp 强制 Bun，无实用 Node 路径**（亲验）：`packages/coding-agent/package.json` `engines: {bun: ">=1.3.14"}`（无任何包声明 `engines.node`）；`bun:sqlite` 在 `packages/coding-agent/src` 直接 import **24 个文件**（Node 的 `node:sqlite` 是另一套 API，无 shim）；`Bun.*` 用法散布数百文件。README 自称"SDK — embed in Node"与代码矛盾（`sdk.ts` 用 `Bun.randomUUIDv7`/`Bun.env`）。
- **ACode 桌面生产形态是 V8 字节码**（亲验 spec）：`packages/desktop/specs/agent-bytecode-production.md`——桌面生产 agent 就绪中位数 1073ms，字节码形态 604ms，**-44%**；编译三件套用 `node:v8` 的 `cachedDataVersionTag()` + `new vm.Script(source,{cachedData})`，`ELECTRON_RUN_AS_NODE=1`（`scripts/build-desktop-agent-bytecode.mjs:90`）。
- **Bun 无法消费 V8 cachedData；Electron 内置 Node 无法执行 JSC 字节码或 `Bun.*`/`bun:sqlite`。**
- napi 原生层（`@oh-my-pi/pi-natives`）对 Node 友好（标准 N-API cdylib）——**冲突不在原生层，在 TS 层的 Bun host API + 字节码引擎**。
- **唯一集成形态**：ACode 用 Node `child_process` spawn omp 编译二进制（内嵌 Bun 运行时，~50MB）作子进程，走 stdio。不能在 Electron 主进程内 `import`。

连锁冲击（8 面）：CLI 分发包（`acode.cjs` JS bundle → Bun 单文件二进制）、install.sh（`node` → `bun`）、`~/.acode/runtime` 语义消失、mise.toml/engines 全改、桌面 extraResources 须额外打包独立 Bun 运行时（~50MB × 5 平台/arch）、**V8 字节码 -44% 收益整条死亡**、release.yml 每 runner 须编 Bun 二进制（omp 有 8 个 compile target）。

### 2.2 协议是两套世界观 —— 严重度：高

- **ACode v4 是状态投影协议**：CLI 端归约出带 `revision`/`seq`/`logEpoch` 的**权威 snapshot**（`ConversationSnapshot`，字段级整体替换）+ 键级 delta（7 个 op 封闭集合）。客户端从不自己归约事件，只吃 CLI 归约好的 `payload:{kind:snapshot|deltas}`（`packages/shared/src/acode-protocol-v4/snapshot.ts`、`delta.ts`）。
- **omp 是事件日志协议**：吐原始 `AgentSessionEvent`（`message_*`/`tool_execution_*`/`subagent_*`）+ 命令式 `get_state`（无 seq 快照）+ `get_entries`（事件日志），让消费者自己归约（`packages/coding-agent/src/modes/rpc/`、`docs/rpc.md`）。
- **两者之间必须自建"投影引擎 + admission 账本"**：把 omp append-only 事件流归约成 v4 的 revision/seq 键级投影。这套东西 acode-cli 已写了约 **2.4 万行**（`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/`）。
- **ACP 当不了桥**（两路独立查明，一致）：ACode 与 omp 的 ACP **都是 agent/server 端**（被 Zed 等 IDE 驱动），没有一端是 ACP client；且 ACP 交集比 v4 更薄（无 snapshot/replay、无 revision CAS、无 attachment 事务）。要用 ACP 桥，ACode 得先新写一个 ACP client（两仓都没有），翻译量约等于重实现半个 v4 gateway。

### 2.3 治理层已否决外部引擎（架构级前置）—— 严重度：高（需先推翻决策）

- **`packages/shared/specs/agent-engine-external-slots-removal.md`（亲验，真实存在）**：产品决定**删除三个外部引擎槽位**（`codex`/`opencode`/`gemini`），**仅保留 native `glm`**。注册表 `resolveAgentEngine` 未知/缺省一律回退 native。
- **`packages/shared/src/acode-agent-runtime.ts:53-61`（亲验，同源注释）**：`getEngineRuntime()` 恒等于 `ACODE_AGENT_RUNTIME`，注释明写"外部引擎槽位已下线（spec: agent-engine-external-slots-removal.md）"。
- **含义**：引入 omp 作第二引擎，正是这条 spec 移除的能力。写代码前必须先推翻这条架构决策，否则 `architecture:check` 与 spec 治理会持续对抗。

## 3. 协议概念映射：omp 的结构性缺口

v4 有、omp 无（或更浅），按"结构性依赖 vs 功能缺失"分档。**结构性缺口**没有它整条链路不工作，必须由 shim 自建：

| v4 概念                                | omp 对应                                                                          | 判定         | shim 必须自建什么                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **snapshot/replay 权威投影**           | `get_state`（无 seq）+ `get_entries`（事件日志）                                  | ❌           | 投影引擎 + revision/seq/logEpoch 账本。手机 `web-remote-replayable` 恢复链路的唯一载体；缺则手机/web 首屏全黑、断线不可恢复                                                              |
| **attachment begin/chunk/commit 事务** | `prompt.images` 内联 base64                                                       | ❌           | 三段事务 staging registry（20MiB/64chunk/5min TTL）。手机远控发文件的唯一通道；缺则手机端不能发图/文件                                                                                   |
| **CommandInbox admission**             | `queue_update` + prompt `id` 关联                                                 | 🟡           | admissionSeq / CAS 六态裁决 / 512 幂等 / redelivery 取代。缺则 pending guide / queued 列表 / 重连对账全失效                                                                              |
| **凭据运行期 RPC 下发链**              | 自己的 `login`/provider auth（明文 SQLite）                                       | ❌（硬冲突） | omp 用 `~/.omp/agent/agent.db` 明文存 key；ACode 用共享 `credentials.json` + OS 钥匙串（`credentialKeychain.ts`）。shim 必须让 omp 用 ACode 凭据——**唯一无法靠复用解决、需专门设计的点** |
| **per-call 权限弹窗**                  | RPC 模式无交互式审批（靠启动期 `--approval-mode`）；审批走 `extension_ui_request` | 🟡           | pendingInteraction 投影 + resolveInteraction 闭环。缺则权限弹窗永不出现，只能全程 yolo 或全程拒                                                                                          |

**功能缺失**（UI 少面板，核心对话仍工作）：workflowRuns / swarmPlan / hookInvocation / artifact 面板（omp 无对等 → 空白）；permission policyFloor 只读标记 + nonce（omp 无 → 降级纯文本 ask）；workspaceIdentity/remoteSessionId（omp 身份=cwd 路径 → shim 自维护映射）。

**映射良好**（✅）：session、fork（omp 更细，可从任意 entry 分叉）、resume、tool call 发起/结果、subagent（`subagent_lifecycle/progress/event` + `get_subagents`/`steer_subagent`）。

## 4. 三条桥接路线对比

共同硬骨头同一个：投影引擎 + admission 账本 + attachment 事务。区别只在这套写在哪、复用什么、谁跟随谁升级。

| 维度                 | (a) fork omp 加 v4 前端                                                  | **(b) ACode 侧 shim ★推荐**                     | (c) 客户端改说 omp 协议                      |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| 客户端改动           | 零                                                                       | **零**                                          | 5 万行重写（`packages/ui/src/v4/` 222 文件） |
| 复用现有 v4 实现     | 否                                                                       | **是（2.4 万行 v4 网关）**                      | 否                                           |
| 核心对话链路人日     | 40–70                                                                    | **30–50**                                       | 120–250                                      |
| owner/lease 保全     | 可（自建）                                                               | **天然**（host 在 services 层注入，非 v4 自有） | 需重设计                                     |
| snapshot replay 保全 | 可（自建）                                                               | **天然**（复用 projection + resync RPC）        | 需重发明                                     |
| 凭据保全             | 硬冲突（侵入 omp provider 层）                                           | **需专门设计凭据桥**                            | 全丢                                         |
| 上游跟随成本         | **最差（永久 rebase，omp 依赖 11 内部包 + 135 文件 import pi-natives）** | **最好（隔离进程吸收迭代）**                    | 最差（绑 UI）                                |

**路线 (b) 落地形态**：ACode 内新增 shim 进程。北向复用 `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/`（gateway、command-inbox、attachment-upload-registry、snapshot/delta/seq 账本全现成）；南向 spawn `omp --mode rpc-ui`，把 omp 事件喂进现有 projection、把 v4 命令翻成 omp RpcCommand。客户端（desktop/web/ui）**零改动**，照常说 v4。

**omp 侧驱动通道选型**（omp 架构路结论）：首选 `omp --mode rpc-ui`（能力最全、文档 91KB + 85 命令 schema + Python/Go/Rust 三语言 SDK 背书协议稳定、工具审批走 `extension_ui_request`）；备选 ACP（标准化，但需 ACode 新写 ACP client）。两者都要求 spawn omp 二进制，不能进程内 import。

## 5. 能力得失账（决策关键）

ACode 能力分两层：**Agent 层**（`apps/acode-cli/packages/core|bootstrap|cli-workflow`，omp 替换的就是这层，dies-with-agent）与 **Host 层**（`packages/desktop`+`services`+`provider`，survives）。

### 会丢（ACode 独有，omp 无对应物，随 agent 层死亡）

| 能力                                                    | 证据                                                                       | 严重度 |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| **反射门**（bash-confirm reflexive gate，逼模型自证）   | `core/src/permission/bash-confirm-reflex-gate.ts`                          | 高     |
| **auto 模式 LLM 风险分类器**（7 条 rubric + 独立裁决）  | `core/src/permission/auto-risk-classifier.ts`                              | 高     |
| **托管策略地板 + 旁路免疫熔断器**（yolo 也强制降级）    | `core/src/permission/process-policy-floor.ts`、`bypass-immune-breakers.ts` | 高     |
| **bash-target blast-radius 分级**（目标路径×内容状态）  | `core/src/tool/handlers/bash-target-risk/`                                 | 中     |
| CommandInbox / 三域 checkpoint / owner-lease / 插件播种 | 见 §3、§4                                                                  | 中     |

omp 权限模型只有"命令文本正则黑名单 + 缓存授权"（`tools/approval.ts` tier + `bash.ts` `CRITICAL_BASH_PATTERNS`），**深度明显更浅**。反射门 + LLM 分类器是 **ACode 相对 omp 的唯一实质技术领先**，也是重写成本最高的两样。

### 会赚（omp 有、ACode 无）

- **DAP 调试适配器**（真增益，中）：`coding-agent/src/dap/`，14 个预配置适配器（gdb/lldb/debugpy/dlv/js-debug…）。ACode 完全无 DAP。
- **语音 STT/TTS**（真增益，低）：Whisper/sherpa-onnx + 本地 Kokoro。
- **多人实时协作 collab**（真增益，低）：ACode 有单用户手机远控，无多用户同会话。
- 89 provider 静态目录（部分增益，引入双真源）；browser-relay MV3（ACode 用 playwright，大体对等）。

### 非真增益（ACode 已有，omp 仅更宽/更深）

LSP（ACode 30 文件）、MCP（omp 多 Smithery+OAuth）、hooks（omp 15+ vs ACode 7）、session resume（**ACode 三域 checkpoint 更深**）、memory/stats/snapcompact。

## 6. 非功能冲突矩阵

| 冲突项                                                                                                    | 严重度                | 缓解手段                                                                               | 量级                              |
| --------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| **运行时 V8↔JSC**                                                                                         | 高                    | 共存：桌面额外打包可选 Bun 运行时；或只移植 napi 层 + 重写 554 个 Bun-API TS 文件      | 完整 40–70 人周 / 共存 12–20 人周 |
| **能力倒退**（反射门/LLM 分类器/策略地板/blast-radius）                                                   | 高                    | 把 ACode 防御栈移植进 omp `tools/approval.ts` 决策链                                   | 4–8 人周                          |
| **测试+CI+治理**（apps/acode-cli 334 测试/157 spec 废、47 跨包测试、3 CI job 红、5 架构模块、15 knip 块） | 高                    | omp 落 `apps/acode-cli/**`；重 onboard 架构模块+knip；加 bun CI leg                    | 8–15 人周                         |
| **上游追踪税**（omp 8.8× 速度、月度 breaking major、仅 latest 安全支持）                                  | 高（fork）/ 中（npm） | 依赖 npm 预编译包 + 严格钉版 + 自建 backport；不 fork 源码                             | 永久 ~1–2 人周/月                 |
| **供应链双台账**（+126 npm 组件、Rust cargo-about 管线、build.stencil.so 远程二进制、LGPL sharp-libvips） | 中                    | 新建 cargo-about 管线合并 ledger；验证 sharp 被 stub；镜像二进制                       | 3–5 人周                          |
| **协议/契约双真源**（provider 89 目录 vs 远程下发、双凭据体系、session 格式）                             | 中                    | 裁决单一真源，shim 桥接                                                                | 3–6 人周                          |
| **遥测**（omp OTel vs ACode 无遥测守护）                                                                  | **低**                | omp 落 `apps/acode-cli`（不进 `packages/desktop/src`）；默认不上报=零改码              | 0–0.5 人周                        |
| **许可证**（双方 MIT/Apache，Rust 全宽松）                                                                | 低                    | 仅 reviewRequired 纳入 3 个弱著佐权项（sharp-libvips LGPL / inferno CDDL / uluru MPL） | <0.5 人周                         |

**遥测反转（预判最高、实际最低）**：ACode 的"无遥测"实质是**无常开端点 + 默认 no-op + opt-in**，ACode CLI 自己就内建一套照抄 omp 的 OTel 栈（`apps/acode-cli/specs/otel-telemetry.md:3` 明写"机制参照 oh-my-pi"）。omp 遥测默认关（无 `OTEL_EXPORTER_OTLP_*_ENDPOINT` 则整条模块图不加载）、无硬编码上报端点、正文默认不采、剥离半天量级。**落地判据：omp 必须落 `apps/acode-cli/**`，不得进 `packages/desktop/src`**（desktop 的 `no-telemetry.test.mjs`把`@opentelemetry` 钉死为四件套 + 禁静态 import）。

## 7. 工作量与追踪税

- **完整替换**：40–70 人周（≈10–17 人月）一次性 + 永久 ~1–2 人周/月。**不建议**——运行时重选型（非移植）、桌面字节码 -44% 收益无法在 JSC 复现、防御能力净倒退。
- **并行共存（omp 作可选后端）**：12–20 人周（≈3–5 人月）。避开 all-or-nothing 的运行时重选型，但需接受"两个 agent、两套安全模型、两套运行时"的永久复杂度税，且共存不解决防御倒退（omp 后端权限模型弱于原生，等于同时发布两个安全保证不等的 agent）。协议 shim 核心链路 30–50 人日，长尾面板另计 20–40 人日。
- **上游迭代风险（关键）**：omp 近 7 天 2036 commits（≈291/天）、CalVer 月度 breaking major、`SECURITY.md` "Only the latest release is supported with security updates"、无 dependabot。ACode 近 7 天 232 commits、全部历史仅约 4 周。**速度比 ≈8.8×**。钉版本的 ACode 数天内掉出 omp 安全支持窗口——要拿补丁必须持续追 latest（每月 major 破坏）或 fork 后自行 backport（无上游 LTS）。

## 8. 决策选项与第一步

**选项**：

1. **不推进**（推荐）——除非明确需要 DAP/语音/多人协作，否则 3–5 人月 + 永久税换防御倒退不划算。
2. **先做 spike 证伪/证实**（推进前必做）——2–3 人日：spawn `omp --mode rpc-ui`，把一次 `prompt` 的 `message_*`/`tool_execution_*` 事件手工归约成一个最小 `ConversationSnapshot`，验证"事件流→键级投影"的 seq/revision 记账能否对齐 v4 客户端的 resync 期望。**这一步能证伪整条路线**。
3. **走路线 (b) 完整共存**——接受 §7 全账，优先把反射门 + LLM 分类器移植进 omp 后端拉平安全底线。

**若选 2/3，前置动作**：先推翻 `agent-engine-external-slots-removal.md` 的单引擎决策（§2.3），否则治理层持续对抗。

## 附录 A：证据索引（按分析路）

- **omp 架构**：`packages/coding-agent/src/cli.ts`（Bun 门 + 5 mode dispatch）、`modes/rpc/rpc-mode.ts`（2746 行）、`docs/rpc.md`（91KB）、`modes/rpc/wire/rpc-wire.schema.json`（6776 行/85 命令）、`modes/acp/acp-agent.ts`（3249 行）、`packages/ai/src/auth/sqlite-credential-store.ts`（明文 SQLite）、`telemetry-export.ts`（默认关）、`crates/pi-natives/Cargo.toml`（cdylib）。
- **ACode 客户端契约**：`packages/services/src/acode-agent/acodeAgentProcessManager.ts:1542`（spawn）、`acodeStdioTransport.ts:61`（NDJSON/LF）、`packages/shared/src/acode-protocol-v4/`（37 命令/28 method/3 topic）、`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/command-inbox.ts`、`packages/shared/src/acode-agent-runtime.ts`（凭据 RPC 下发）、`scripts/build-acode.mjs:160`（acode.cjs 断言）。
- **协议桥接**：`snapshot.ts:524`（ConversationSnapshot）、`delta.ts:106`（7 op）、`transport.ts:51`（握手 + deliveryProfile）、omp `agent/types.ts:1264`（AgentEvent）、`rpc-types.ts`（RPC 帧）。
- **非功能冲突**：`apps/acode-cli/specs/otel-telemetry.md`、`packages/desktop/tests/no-telemetry.test.mjs`、`packages/desktop/specs/agent-bytecode-production.md`、`architecture-policy.yaml:257`（5 managed 模块）、`knip.jsonc:166`（15 workspace 块）、omp `SECURITY.md`。

## 附录 B：主 agent 亲验清单（区别于子代理转述）

以下三条最硬的载荷性事实由主 agent 直接读源码/跑命令核实，非子代理转述：

1. **治理 spec 真实存在且措辞硬**：`packages/shared/specs/agent-engine-external-slots-removal.md`（3907 字节）——"删除三个外部槽位，仅保留 native(glm)"；`acode-agent-runtime.ts:53-61` 同源注释"外部引擎槽位已下线"。
2. **omp Bun-only**：`packages/coding-agent/package.json` `engines:{bun:">=1.3.14"}`；`bun:sqlite` 在 coding-agent/src import 24 文件。
3. **V8 字节码 -44%**：`packages/desktop/specs/agent-bytecode-production.md`——1073ms→604ms；编译脚本 `ELECTRON_RUN_AS_NODE=1`。

其余数字（LOC、命令计数、人日估算、上游 commit 速率等）来自 4 路子代理报告，均带文件:行号证据，但未经主 agent 逐条复验——引用时以附录 A 的路径为准。
