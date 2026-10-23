# 用 jcode 替换 ACode Agent CLI 的可行性评估

> **文档状态**：评估结论（assessment），供后续决策。**日期**：2026-10-23。**评估对象**：`C:\Users\Administrator\Desktop\jcode`（jcode v0.99.1，纯 Rust，origin `github.com/1jehuang/jcode`，YC S26，MIT，1607 个 .rs / ~86 万行 Rust / 89 workspace crates）。**被替换方**：ACode `apps/acode-cli`（native `glm` 引擎，`acode.cjs app-server --stdio`）。
>
> **姊妹评估**：[omp（oh-my-pi）候选评估](omp-cli-replacement-assessment-2026-10-23.md)——同题不同候选，横向对比见本文 §8。
>
> **实测补充**：[jcode-adapter-spike-2026-10-23.md](jcode-adapter-spike-2026-10-23.md)——本文是分析态评估；spike 记录是 Windows 真机实测，**修正了本文 §3.1/§3.2 的三处判断**（其中一处重大利好：ACP 子进程自包含、kill 即重置，符合 ACode 独占子进程模型），并**证实了 §4 的权限缺口**（写文件全程零审批）。冲突处以 spike 实测为准。
>
> **评估方法**：3 路并发只读子代理深度分析（jcode 架构与接口面 / 协议桥接可行性 / 非功能冲突），主 agent 亲验两条决定性事实（见附录 B）。全文只读，未改动任一仓库。

## 结论（先读这段）

**jcode 比 omp 可行，但撞上一堵 omp 没有的墙：Windows 上没有稳定的独占驱动通道——而 Windows 是 ACode 桌面主平台。**

- **净判断**：治理前提不变（[`agent-engine-external-slots-removal.md`](../packages/shared/specs/agent-engine-external-slots-removal.md) 已删外部引擎槽位，动之前须先推翻该决策）。在此之上，**若必须选一个外部后端，jcode 净优于 omp**：防御机制同源（ACode 反射门/blast-radius 的祖本就是 jcode）、凭据桥接近现成、协议 v1 从未 break、并行共存 10–18 人周（< omp 的 12–20）、追踪税 0.5–1 人周/月（< omp 的 1–2）。
- **但推进有两个硬前提**：(i) 解决 Windows 驱动通道——shipped `jcode.exe` 的稳定 API 桥 `api-bridge --stdio` 是 `#[cfg(unix)]`，Windows 上不存在，只能自行编译随附 `jcode-harness-api-bridge.exe`（该 bin 无 cfg 门控）或推动上游解除门控；(ii) jcode 侧接通惰性权限桥——稳定 API 的 `permission_request` schema 存在但桥从不发，权限弹窗在 ACode 客户端永不出现，这不是 ACode 单侧可解的。
- **前置安全硬化层 3–5 人周**（不可省）：jcode 独有三个高危面直接对撞 ACode 的"无遥测 + fail-closed + 供应链锁定"立身——遥测自有端点默认开、self-dev 可改写自己被分发的二进制、daemon socket fail-open 无鉴权（§3.3、§3.4、§7）。
- **第一步 spike（2–3 人日）应把 Windows 那条腿单独验**：确认 shipped `jcode.exe` 在 Windows 上除"共享 daemon + named pipe（内部不稳定协议）"外确无独占 stdio 路径——这一步能单独证伪整条路线。

## 1. jcode 是什么，与 ACode 什么关系

- **纯 Rust 高性能 coding agent**：卖点是极致资源效率——每额外会话 ~3.3MB RAM、首输入 19ms（自报基准，有 bench 脚本但非 CI 门禁）；swarm 多 agent 编排；self-dev（agent 改自己源码并热重载二进制）。
- **它是 ACode 防御机制的灵感上游**：ACode 源码注释明写"机制参照 jcode (MIT) `crates/jcode-command-risk/src/gate.rs`，自撰 TypeScript 实现"（`apps/acode-cli/packages/core/src/permission/bash-confirm-reflex-gate.ts:4`）、blast-radius"参照 jcode `command-risk/src/lib.rs` 的 assess/assess_segment"（`bash-target-risk/assess.ts:5-7`）。换 jcode 后端在这两个原语上是**回到祖本**，不是引入陌生实现。
- **daemon 架构**：jcode 一等公民模型是"一个长驻 daemon + 多客户端 attach"（`docs/SERVER_ARCHITECTURE.md`），与 ACode "Host spawn 独占 agent 子进程"根本对立（§3.2）。

## 2. 可驱动接口面（按对 ACode 的可行性排序）

| 通道                     | 传输                                       | Windows                      | 权限弹窗                 | 稳定性                                                                                                                       | 判定                                                    |
| ------------------------ | ------------------------------------------ | ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **harness API / TS SDK** | NDJSON over socket 或 `api-bridge --stdio` | **❌ 桥入口 `#[cfg(unix)]`** | schema 有但桥不发        | **稳定 GA**（协议 v1.11 从未 break，双向 drift 机械校验，npm SDK `@1jehuang/jcode-sdk` v1.2.0 + 6 平台 provenance 二进制包） | 功能最全、最贴合 ACode 需求，但 Windows 入口缺失        |
| **ACP**（`jcode acp`）   | stdio JSON-RPC                             | ✅ 无 cfg 门控               | ❌ 无 permission 方法    | 稳定骨架 + 实验扩展                                                                                                          | Windows 唯一现实通道，但连的是**共享 daemon**、能力面窄 |
| native daemon 协议       | socket / named pipe NDJSON                 | ✅ 可连                      | ❌ 协议层无权限事件      | **内部不稳定**（~90 Request / ~80 ServerEvent 变体，无版本协商）                                                             | 不宜作长期边界                                          |
| WS 网关 :7643            | WebSocket                                  | ✅                           | ❌                       | 实验性，默认关                                                                                                               | 远程场景备选，仍是共享 daemon                           |
| `jcode run --ndjson`     | stdout 单向                                | ✅                           | ❌（权限事件被静默丢弃） | 稳定                                                                                                                         | 只适合一次性子任务，不能续驱交互会话                    |

**关键事实**：SDK `launch()` 的"私有实例"（独立 `JCODE_HOME` + 独立 socket，最接近 ACode 独占模型）也依赖 `api-bridge`，**仅 Unix**；其三个 launch 测试全部 `{skip: process.platform === "win32"}`。

## 3. 四堵墙（jcode 独有，omp 没有）

### 3.1 Windows 无稳定驱动入口 —— 严重度：高（决定性，已亲验）

- `api-bridge` 子命令整体 `#[cfg(unix)]`（`src/cli/args.rs:602`、`src/cli/dispatch.rs:192`），`run_bridge_stdio` 同样 unix-only（`crates/jcode-harness-api-server/src/lib.rs`）；release 只发布 `jcode.exe` 单二进制，跨平台的独立 bridge bin `publish=false` 不进发布产物。
- **Windows 上 ACode 的 `app-server --stdio` 独占子进程契约无法被 shipped jcode 满足**。可选出路：(a) ACode 自行编译并随附 `jcode-harness-api-bridge.exe`（该 bin 无 cfg 门控、能编 Windows）；(b) 走共享 daemon + named pipe 说内部不稳定协议；(c) 走 ACP（Windows 可用但能力面窄、仍共享 daemon）；(d) 推动上游解除门控（不受 ACode 控制）。
- omp 无此墙：Bun stdio 子进程天然跨平台，直接命中 ACode spawn 契约。

### 3.2 daemon 共享模型反转 ACode 进程假设 —— 严重度：高

- jcode daemon 用 `setsid` 完全脱离派生它的客户端，空闲 **300s 硬编码**才自退；杀客户端不影响 daemon 与其他客户端。ACode 的假设是：Host spawn 独占子进程、`ACODE_AGENT_IDLE_EXIT_MS` 空闲自退、进程换代 `onAgentRuntimeRestarted` 重订阅、每窗口独立崩溃域。
- 冲突后果：shim 变成"daemon 的一个 client"而非进程 owner——ACode 无法"kill agent 重置会话"只能 detach；共享 daemon 崩溃 = **所有窗口的会话一起死**；idle-exit 语义不同（daemon 级 owner-pid 生命周期 vs 窗口级空闲自退）；owner/lease 多窗口路由被架空（会话事实归 daemon，不归宿主）。
- 缓解：每窗口独立 `JCODE_SOCKET` + 独立私有 daemon（Unix 可用 SDK launch 模式；Windows 依赖 §3.1 的出路 (a)）。

### 3.3 self-dev：agent 可改写自己被分发的二进制 —— 严重度：高

- 机制：LLM 可自主调用 selfdev 工具 → `cargo build --profile selfdev` → smoke test → 重指 `~/.jcode/builds/shared-server/jcode` symlink → daemon `exec()` 热重载。**在 jcode repo 目录里启动普通 session 就自动进 self-dev**。
- 供应链冲突：release binary 有完整 SHA256SUMS + provenance，但 **self-dev 产物完全绕过**——唯一校验是"能启动 + git_hash 匹配"，无签名/哈希/provenance；`cargo build` 会执行各 crate 的 `build.rs`，即**以 daemon 用户权限编译期运行 agent 写的任意代码**，无 sandbox/seccomp 隔离；一次 reload 影响该 daemon 上所有会话。
- 更隐蔽：未鉴权 socket client 可发 `UpgradeRuntime{candidate}` 让 daemon `exec()` 进它指定的本地路径（不校验来源/签名）。
- 禁用无单一硬开关：需组合 `[tools] disabled=["selfdev",...]` + `--no-selfdev` + 确保 cwd 不是 jcode repo + 绝不以 canary 拉起。**最稳妥是从源码剥离 `register_selfdev_tools` 后再分发**（落入 fork 领域）。

### 3.4 daemon socket fail-open + 遥测默认开 —— 严重度：高

- **socket 鉴权 fail-OPEN**：accept 即 dispatch，无 token、无握手、无 peer-credential 校验；安全边界完全等于 socket 文件的 OS 权限（0600）——**同 UID 任意本地进程**（恶意 npm 包、被注入的浏览器进程）open 即全权控制所有会话；`Subscribe` 可 attach 任意已存在会话并 `allow_session_takeover` 踢掉老 owner；Windows named pipe 创建无自定义 SECURITY_ATTRIBUTES，隔离弱于 Unix。与 ACode fail-closed 认证纪律（非 loopback 无 token 拒绝启动）正面对撞。
- **遥测自有端点、默认开**：`TELEMETRY_ENDPOINT = "https://telemetry.jcode.sh/v1/event"` 硬编码，install/upgrade/auth/usage 事件启动即发；2026-10-24 起 provider OAuth **邮箱**纳入默认遥测（带一次性提示 + SHA-256 preflight）。提示词/源码/transcript 默认不采（transcript 全文是独立 opt-in）。kill-switch 可靠：`JCODE_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` / marker 文件 / 子命令，但**无 cargo feature 可编译期剔除**。
- **ACode 现有防线对 jcode 双重失明**：(i) no-telemetry 守护测试只扫仓库内 JS/TS 文本，对 spawn 的原生子进程运行时行为不设防——jcode 后台静默上报时守护**保持绿色**；(ii) `runtimeEnv.ts` 剔的是 `OTEL_*`，jcode 用自己的 env 名，且 sanitizer 是"移除器"不是"注入器"——ACode 必须**主动写入** `JCODE_NO_TELEMETRY=1`+`DO_NOT_TRACK=1` 才能关掉。
- **自动更新默认开** + SHA256 校验 fail-open（"有 SHA256SUMS 才验，没有静默跳过"），绕过 ACode 版本锁定；需三重锁（`--no-update` + env + config `check_updates=false`）且代理层不透传 `UpgradeRuntime`。

## 4. 协议映射与结构性缺口

jcode 对外稳定面是 **harness API**（`ApiRequest`/`ApiEvent`，NDJSON，hello 握手 + capabilities 协商，协议 v1.11）。与 ACode v4（状态投影协议：revision/seq/logEpoch 权威 snapshot + 7 delta op）的映射：

**映射良好（✅）**：session（完整，含持久化 snapshot+journal）、streaming text delta（`TextDelta` + message_id 分帧）、tool call 三段（`ToolStart/ToolInputDelta/ToolExec/ToolDone`）、todo/plan（比 ACode 更丰富，含 swarm 共享 `VersionedPlan`）、resume/fork（`ForkSession`/`Split`）、sessions-index（`ListSessions`/`PeekSession`，甚至更强）、subagent/swarm（peer session + parent 指针，**jcode 强项**）、model 运行期切换（`SetModel`/`SetReasoningEffort`，mid-turn 有回归测试）。

**结构性缺口（shim 必须自建，与 omp 命中同一批 + 一个新墙）**：

| 缺口                                               | jcode 现状                                                                                                                    | 后果                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| snapshot/replay 投影账本                           | 无 revision/seq/epoch；重连是"History 重取 + live"，**非 missed-delta 重放**                                                  | 手机 `web-remote-replayable` 恢复链路无载体；shim 自建（可复用 ACode 现成 projection） |
| CommandInbox admission                             | 无 admissionSeq/CAS 六态/幂等表                                                                                               | pending guide/队列/重连对账失效；shim 自建（ACode `command-inbox.ts` 现成）            |
| attachment 三段事务                                | 仅 `SendMessage.images` 内联 base64                                                                                           | 手机远控发大文件无通道；shim 自建（`attachment-upload-registry.ts` 现成）              |
| **独占 stdio / daemon 生命周期（Windows 决定性）** | §3.1、§3.2                                                                                                                    | ACode 全套进程假设被击穿；**omp 没有的新增阻断项**                                     |
| per-call 权限闭环                                  | schema 存在但桥从不发（`translate.rs:1342`，已亲验）；`AllowAlways` 全仓零消费者；`docs/SAFETY_SYSTEM.md` 标 "Status: Design" | 权限弹窗永不出现，只能全程放行或全程拒；**需 jcode 上游先接通，非 ACode 单侧可解**     |

**功能缺失（UI 少面板，可降级）**：turn 无一等 id（shim 自造）、workspaceIdentity=working_dir 路径（无独立 GUID）、cost 无一等字段（客户端按静态定价表算）、checkpoint 无可寻址 id（rewind 目标是 1-based 消息索引 + 单级内存 undo）。

**凭据桥不是硬阻断（jcode 相对 omp 的实质优势）**：harness API 有 `SetApiKey{provider,api_key}` + `NotifyAuthChanged{provider}`——daemon **活进程热重载凭据**，且 Anthropic token 是 per-request 动态解析。API key 类凭据桥接近现成（shim 收 ACode `provider/updateAccountConfig` → 调 `SetApiKey`+`NotifyAuthChanged`）。仅 OAuth token 类较难：协议**刻意不能推 token**（注释明写排除），只能带外写 `~/.jcode/auth.json` 再 notify；ACode 的反向 `requestProviderRuntimeHeaders` 在 jcode 无对等通道。凭据存储本身是 0600 加固明文文件（无 OS 钥匙串），与 ACode 钥匙串方案并存需 shim 做单向搬运。

## 5. 桥接路线与量级

| 维度         | (a) fork jcode 加 v4 前端                             | **(b) ACode 侧 shim ★唯一现实**                             | (c) 客户端改说 jcode 协议 |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| 核心链路人日 | 120–250+（12.3k 行 zod schema 要在 Rust 侧重实现）    | **40–65** + 长尾面板 20–40                                  | 120–250                   |
| 语言门槛     | **最高**：ACode 零 Rust 能力面（全仓 0 个 .rs）       | 中：TS shim + daemon/named-pipe 传输                        | 中：纯 TS                 |
| 上游跟随     | 最差（永久 rebase vs 63 commits/天、~25 releases/月） | 最好（隔离进程；但 Windows 路径绑内部 legacy 协议是风险点） | 差（绑 UI）               |

路线 (b) 形态：北向复用 `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/`（~2.4 万行 v4 网关现成），南向 Unix spawn `jcode api-bridge --stdio`、Windows 走 §3.1 出路 (a)（自行编译随附 bridge exe）。**比 omp 的 30–50 人日多出的 10–15 人日，全部来自 daemon 生命周期 + Windows 传输 + 惰性权限桥。**

**打包链冲击与 omp 同级**（不是区分点）：断在链 2（`prepare-agent-node-bundle.mjs` 的 JS bundle + V8 字节码管线，大）+ 链 6（`runner.mjs:267` TUI `import()` 无法 import 原生二进制，大）；链 8（spawn resolver `acodeAgentProcessManager.ts:526-545`）**已支持原生二进制**（小）。V8 字节码 -44% 收益作废但被更快的原生启动替代（沉没成本非倒退；注意量纲不同：604ms 是进程就绪，19ms 是 TUI 首输入）。**关键缓解：消费 jcode 官方 npm 平台二进制包（6 平台，provenance/sigstore），ACode CI 几乎零 Rust 成本。**

## 6. 能力得失账

### 换 jcode 会丢（ACode 有、jcode 无或更浅）

| 能力                                                                         | jcode 现状                                                                                             | 严重度                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **三域 checkpoint 的级联文件回滚**                                           | rewind 仅对话层截断（1-based 消息索引 + 单级**内存** undo，进程死即丢）；**无文件级 fork/rollback**    | 高                                  |
| **插件商店**                                                                 | 无自建市场，只**只读消费** Claude Code marketplace 装的 skills；MCP 是一等公民（stdio+HTTP+SSE+OAuth） | 高                                  |
| hooks 17 事件                                                                | 8 事件，且 pre_tool **默认 fail-open**（超时即 Allow）                                                 | 中                                  |
| OS 钥匙串凭据                                                                | 无 keyring，0600 加固文件（macOS Keychain 仅作导入源）                                                 | 中                                  |
| model-option-map DSL                                                         | 无通用 DSL，静态目录 + reasoning-effort 查表                                                           | 低                                  |
| ACode 原创加固三件套（策略地板 / 旁路免疫熔断器 / auto 模式 LLM 风险分类器） | jcode **无对等**（其 "policy floor"/"guardrail" 词义指别的东西；`SAFETY_SYSTEM.md` 是未实现设计稿）    | 高（随 agent 层死亡，需移植或放弃） |

### 换 jcode 会赚（jcode 有、ACode 无）

- **swarm**（生产级，3518 LOC 真编排 + 文件冲突通知 + DM/子树广播/频道；注意实现与 README 有偏差：单层 fan-out、只通知"改过"不通知"读过"）
- **原生 Rust 同源防御**：反射门/blast-radius 回到祖本（`jcode-command-risk` 2833 LOC、85 测试、issue #604 `rm -rf ~` 血泪驱动），保真度 ≥ ACode 的 TS 复刻
- **极致性能**（3.3MB/会话、19ms 首输入，自报基准）
- overnight 通宵自主跑、companion 桌面 sidecar、codemode（QuickJS 沙箱工具编排）、mermaid 纯 Rust 终端渲染、voice 输入（依赖外部 Nari 服务）
- 原生 iOS App + QR 配对手机远控（ACode 的 web 远控之外的形态）
- **无 DAP**（与 omp 不同，jcode 没有调试适配器）

### 防御能力净判断（对比 omp 的关键差异）

换 jcode：**保住 2 个被拷贝的原语（回到 Rust 祖本），丢 3 个 ACode 原创加固层**。换 omp：**5 个全丢**（omp 只有正则黑名单 + 缓存授权）。jcode 在权限同源度上完胜——但注意 per-call 审批交互今天在 jcode 对外接口上是死的（§4），所以"弹窗式权限"这项两者同为缺口。

## 7. 非功能冲突矩阵

| #   | 冲突项                                                                                                                                                                                                         | 严重度                             | 缓解手段                                                                                                                                          | 量级                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | 遥测：自有端点默认开 + OAuth 邮箱入库；ACode 守护测试与 env 剥离**双重失明**                                                                                                                                   | **高**                             | spawn-env 注入 `JCODE_NO_TELEMETRY=1`+`DO_NOT_TRACK=1`；守护测试升级为审计子进程出站网络                                                          | 1–2 人周                           |
| 2   | self-dev：改写被分发二进制、绕过全部校验、build.rs 无隔离执行                                                                                                                                                  | **高**                             | 源码剥离 `register_selfdev_tools` 后分发；tools disabled + `--no-selfdev` + 非 repo cwd                                                           | 3–5 人周（与 #3 合并为安全硬化层） |
| 3   | daemon socket fail-open：无鉴权、会话零授权隔离、`UpgradeRuntime` 可被未鉴权 client 触发                                                                                                                       | **高**                             | ACode 自建 token 代理**独占持有** socket；每窗口独立 `JCODE_SOCKET`+daemon；代理拦截不透传 `UpgradeRuntime`；Windows named-pipe ACL 加固          | 同上                               |
| 4   | 自动更新默认开 + SHA256 fail-open → 绕过版本锁定                                                                                                                                                               | 中                                 | 三重锁：`--no-update` + `JCODE_NO_AUTO_UPDATE=1` + config `check_updates=false`                                                                   | 含在 #2/#3                         |
| 5   | 供应链：936 crate、**无 license 审计基础设施**、信任根=个人账号、2 个 git-fork 依赖、Windows exe 未签名                                                                                                        | 中—高                              | 消费 provenance 签名的 npm 平台包；ACode 新增 cargo-about/cargo-deny 管线；pin git-fork SHA                                                       | 2–3 人周                           |
| 6   | 原生二进制分发 × 5–7 arch + extraResources 打包                                                                                                                                                                | 中                                 | 走预构建 npm 平台包（免自建 Rust 工具链）                                                                                                         | 2–4 人周                           |
| 7   | 能力缺口（§6 丢失清单）                                                                                                                                                                                        | **高**（完整替换）/ 中（共存降级） | 共存下降级为"选 jcode 后端时不可用"；完整替换须 Rust 重建或永久放弃                                                                               | A 15–25 / B 0                      |
| 8   | 测试/CI/治理：334 CLI 测试作废、9 个跨包测试读 acode-cli 源码（4 个 desktop 测试会 ENOENT 判红）、no-telemetry 守护是"删除态守护"（被守护文件消失即失败）、architecture-policy 23 模块 / knip 30 块不覆盖 Rust | **高**                             | 集成测试替代；解耦 desktop 的源码读取；治理资产重建                                                                                               | A 15–25 / B 4–7 人周               |
| 9   | V8 字节码 -44% 收益作废                                                                                                                                                                                        | 低                                 | 无需缓解——原生启动大概率更快，沉没成本非倒退                                                                                                      | 0                                  |
| 10  | 上游迭代：63 commits/天、1.17 天/版、**80.3% 单人**、无 SECURITY.md/无安全支持政策                                                                                                                             | 低—中                              | pin 版本 + 自扛 CVE triage（跟 `docs/SECURITY_DEPENDENCIES.md` 台账，注意其 last reviewed 已 5 个月）；协议 v1 stable + 双向 drift 检查抵消大部分 | 0.5–1 人周/月                      |

**工作量汇总**：完整替换 **45–75 人周**（≈omp 40–70，主导成本是能力缺口重建而非运行时）；并行共存 **10–18 人周**（< omp 12–20，得益于稳定协议 + 官方 npm SDK + provenance 二进制包）；其中安全硬化层 3–5 人周是共存的**前置门槛**。

## 8. jcode vs omp 横向对比

| 维度          | jcode（纯 Rust）                                                                  | omp（Bun+TS+Rust napi）                                     | 优者                                                                                                         |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 运行时冲突    | 无 JS 引擎墙；但 **daemon 共享模型 + Windows 无 stdio 桥**（新墙）                | V8↔JSC 硬墙；stdio 子进程天然跨平台，直接命中 spawn 契约    | 各有一堵，性质不同：omp 是引擎墙（不可拆），jcode 是传输/生命周期墙（可拆：自编译 bridge exe + 私有 daemon） |
| 协议距离      | 策展稳定 harness API v1.11（hello 握手 + capabilities + 双向 drift 校验）         | 裸事件日志 RPC（文档厚但无版本协商纪律）                    | **jcode**                                                                                                    |
| 权限同源度    | ACode 反射门/blast-radius 的**祖本**；保 2 丢 3                                   | 正则黑名单 + 缓存授权；5 个防御原语全倒退                   | **jcode 完胜**                                                                                               |
| 凭据桥        | `SetApiKey`/`NotifyAuthChanged` 热重载 + per-request 动态 token，API key 类近现成 | 硬冲突（明文 SQLite + 自有 login 流，"唯一无法靠复用解决"） | **jcode 完胜**                                                                                               |
| 遥测          | 自有端点**默认开** + 邮箱入库（配置级可关，但守护失明）                           | 默认关、无常开端点（冲突实际最低）                          | **omp**                                                                                                      |
| 独有安全面    | self-dev 改写分发二进制 + socket fail-open                                        | 无对等风险                                                  | **omp**                                                                                                      |
| 打包冲击      | 断链 2/6，链 8 兜底；官方 npm 平台包免 Rust 工具链                                | 断同两条；~50MB 内嵌 Bun × 5 平台                           | 同级（jcode 体积/无运行时略优）                                                                              |
| 上游迭代      | 63 commits/天、~25 releases/月、协议零 breaking、但 80% 单人 + 无安全政策         | 291 commits/天、月度 breaking major、仅 latest 安全支持     | **jcode**                                                                                                    |
| shim 核心人日 | 40–65（多出 daemon/Windows/权限桥）                                               | 30–50                                                       | **omp**                                                                                                      |
| 共存总账      | 10–18 人周 + 0.5–1 人周/月                                                        | 12–20 人周 + 1–2 人周/月                                    | **jcode**                                                                                                    |
| 独赚能力      | swarm、同源 Rust 防御、性能、overnight/codemode                                   | DAP（14 适配器）、语音、多人协作                            | 看需求                                                                                                       |

**一句话**：omp 赢在"接得上"（stdio 跨平台现成、shim 更便宜、遥测干净），jcode 赢在"值得接"（防御同源、凭据桥近现成、协议稳定、总账更低）——但 jcode 的 Windows 驱动通道与三个高危安全面是必须先付的前置成本。

## 9. 决策选项与第一步

1. **不推进**（默认建议）：native glm 的三域文件 checkpoint、插件商店、17 hooks、钥匙串、model-option-map 在两个候选侧都是缺口；治理层已下线外部引擎槽位。
2. **先做 spike 证伪/证实**（推进前必做，2–3 人日）：
   - Unix 腿：spawn `jcode api-bridge --stdio`，驱动一次 turn，把 `TextDelta`/`Tool*` 事件手工归约成最小 `ConversationSnapshot`，验证 seq/revision 记账能否对齐 v4 客户端 resync 期望；
   - **Windows 腿（能单独证伪整条路线）**：确认 shipped `jcode.exe` 在 Windows 上除"共享 daemon + named pipe"外确无独占 stdio 路径；同时验证 `jcode-harness-api-bridge` bin 能否为 Windows 编译并正常工作。
3. **走路线 (b) 完整共存**：接受 §7 全账，顺序为——先推翻 `agent-engine-external-slots-removal.md` 决策 → 安全硬化层（3–5 人周）→ Windows bridge 分发 → shim 核心链路（40–65 人日）→ 长尾面板取舍。

## 附录 A：证据索引（按分析路）

- **jcode 架构**：`docs/SERVER_ARCHITECTURE.md`（daemon 模型）、`src/cli/args.rs:602` + `src/cli/dispatch.rs:192`（`api-bridge` `#[cfg(unix)]`）、`crates/jcode-transport/src/windows.rs:13-30`（named pipe）、`crates/jcode-app-core/src/server.rs:672`（300s idle）、`sdk/typescript/src/launch.ts:540-582`（私有实例）、`sdk/typescript/test/launch.test.ts:222,252,274`（win32 skip）、`src/cli/acp.rs`（ACP，2319 行）。
- **协议桥接**：`crates/jcode-harness-api/src/{requests,events}.rs`（ApiRequest/ApiEvent 字段）、`crates/jcode-harness-api-server/src/translate.rs:1342`（权限桥惰性）、`crates/jcode-command-risk/src/{gate,lib,paths}.rs`（反射门/blast-radius 祖本）、`crates/jcode-base/src/auth/claude.rs` + `jcode-harness-api/src/requests.rs:195,202`（凭据热重载）、ACode 侧 `packages/shared/src/acode-protocol-v4/`（37 命令/snapshot/delta）+ `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/`（v4 网关）。
- **非功能**：`crates/jcode-telemetry-core/src/lib.rs:43-64,485,526`（端点/默认开/kill-switch）、`telemetry-worker/wrangler.toml`（Cloudflare Worker 收集端）、`crates/jcode-app-core/src/tool/selfdev/`（4823 LOC）+ `src/cli/dispatch.rs:850-871`（repo 目录自动进 self-dev）、`crates/jcode-app-core/src/server/{runtime,client_lifecycle}.rs`（socket fail-open/takeover/UpgradeRuntime）、`crates/jcode-update-core/src/lib.rs`（自动更新）、ACode 侧 `apps/acode-cli/tests/no-telemetry.test.mjs` + `packages/shared/src/runtimeEnv.ts:85-103`（守护失明依据）、`scripts/acode-distribution/runner.mjs:267` + `packages/desktop/scripts/prepare-agent-node-bundle.mjs:29`（打包断点）。

## 附录 B：主 agent 亲验清单（区别于子代理转述）

1. **Windows 无 stdio 桥**：`src/cli/args.rs:602` 与 `src/cli/dispatch.rs:192` 的 `#[cfg(unix)]` 门控、SDK launch 测试三处 `{skip: process.platform === "win32"}`——grep 直接命中。
2. **权限桥惰性**：`crates/jcode-harness-api-server/src/translate.rs:1342-1358` 源码注释原话 "the bridge never emits `permission_request`"、错误文案 "this server does not issue permission prompts (no `permissions` capability)"——直接读取。

其余数字（LOC、人日估算、commit 频率、遥测端点、self-dev 机制细节等）来自 3 路子代理报告，均带文件:行号证据，但未经主 agent 逐条复验——引用时以附录 A 的路径为准。
