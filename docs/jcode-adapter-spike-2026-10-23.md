# jcode 适配 Spike 实测记录（2026-10-23）

> **文档状态**：spike 实测记录（implementation evidence）。**分支**：`feature/cli-jcode-adapter`。
> **上游评估**：[jcode-cli-replacement-assessment-2026-10-23.md](jcode-cli-replacement-assessment-2026-10-23.md)（分析态，本文是它的实测补充，含三处修正）。
> **性质**：只读验证，未改动 ACode 与 jcode 任一仓库源码。

## 结论

**技术基石验证成功：ACode 的 Node 栈能在 Windows 上驱动 jcode 跑完一轮带工具调用的真实会话。** 事件流形态清晰、可映射到 acode-protocol-v4 的 rows。整条"v4↔jcode shim"路线未被证伪，可以进入 spec 与实现阶段。

同时实测**修正了上游评估的三处判断**（见 §4），其中一处是重大利好。

## 1. 实测环境

| 项          | 值                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| OS          | Windows 11 Pro 10.0.26200                                                                                                   |
| jcode       | v0.99.0 (`774613c90`)，shipped 二进制 `C:\Users\Administrator\AppData\Local\jcode\bin\jcode.exe`（133 MB）                  |
| Rust 工具链 | cargo/rustc 1.96.0，host `x86_64-pc-windows-gnu`（mingw，非 msvc）                                                          |
| Node        | v25.9.0（另有 bun 1.3.14）                                                                                                  |
| 驱动脚本    | Node ESM + `child_process.spawn` + readline NDJSON（临时文件，未入库）                                                      |
| 安全措施    | 全程 `JCODE_NO_TELEMETRY=1` + `DO_NOT_TRACK=1` + `--no-update`；cwd 用临时目录（绝不在 jcode repo 内跑，避免触发 self-dev） |

## 2. ACP 通道实测（成功路径）

三帧驱动一轮完整会话，全部走 stdio JSON-RPC：

1. **`initialize`** → `agentInfo:{name:"jcode",version:"0.99.0"}`、`protocolVersion:1`、`agentCapabilities:{loadSession:true, promptCapabilities:{image:true,audio:false,embeddedContext:true}, sessionCapabilities:{close,resume}, mcpCapabilities:{http:false,sse:false}}`、`authMethods:[]`
2. **`session/new`**（cwd 必须是 **Windows 绝对路径**，msys 风格 `/tmp/...` 被拒 `-32602 "ACP cwd must be absolute"`）→ 返回真实 `sessionId`（形如 `session_retriever_1792735243337_a8a51d56e4b2116d`）+ `models.currentModelId`（实测 `kimi-k3`）+ 完整 `availableModels` 目录 + `configOptions`（model/effort）
3. **`session/prompt`**（任务：读 cwd 下 `test.txt`）→ 模型真的调了文件读取工具并正确返回内容，`stopReason:"end_turn"`，`usage:{inputTokens:13027, outputTokens:142, cachedReadTokens:6400, totalTokens:19569}`

**注意**：本机无 `~/.jcode/auth.json`、无 provider env 文件，会话仍成功——说明 daemon 侧已有可用凭据路径（jcode 自己的配置）。**ACode 凭据桥接仍是待验项**（见 §5）。

## 3. 事件流形态实录（shim 翻译层的输入规范）

`session/update` 通知的 `sessionUpdate` 字段取值与实测计数（一轮读文件会话）：

| sessionUpdate               | 次数 | 关键字段（实测）                                                                                    | 映射到 v4                                            |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `available_commands_update` | 1    | `availableCommands[]{name,description,input.hint}`（实测 model/models/effort）                      | 会话配置面                                           |
| `tool_call`                 | 1    | `title:"Reading file"`、`kind:"read"`、`status:"pending"`                                           | `toolCallRow` status=inputStreaming/pendingApproval  |
| `tool_call_update`          | 16   | 同 toolCallId，`status` 走 pending→in_progress→completed；**多数帧 title/kind/status 为空**（增量） | `toolCallRow` status 状态机 + output                 |
| `usage_update`              | 2    | token 用量                                                                                          | `sessionUsageState` / `turnHeaderStats`              |
| `agent_message_chunk`       | 19   | `content.text`（流式增量，实测拼出完整回答）                                                        | `assistantTextRow` + `row.delta{path:"text",append}` |

实测事件序列（完整）：

```
available_commands_update → tool_call → tool_call_update ×16（其中第15帧 in_progress、
usage_update、第16帧 completed）→ usage_update → agent_message_chunk ×19
```

**对翻译层的直接启示**：

- 流式文本天然是 chunk 增量，与 v4 `row.delta{append}` 语义对齐良好（**优于** omp 的"全量累积快照需自己 diff"）。
- `tool_call_update` 大量空字段增量帧需要按 toolCallId 归并，不能逐帧建 row。
- 实测**未见** turn 边界事件（无 turn_id、无成对 start/end）——印证评估 §4「turn 无一等 id，shim 必须自造 turnHeader row」。

## 3.1 写操作零审批实测（核心风险，已证实）

上游评估 §4 推测"权限弹窗在对外接口上是死的"。**第二轮 spike 用写操作证实了这一点，且比推测更严重**：

任务：让 agent 在 cwd 创建 `spike-write.txt`。结果：

- **文件被真实创建**，内容正确（`written by jcode spike`）
- 事件计数：`tool_call` ×1、`tool_call_update` ×27、`agent_message_chunk` ×27、`usage_update` ×2、`available_commands_update` ×1
- **零权限帧**：无 `permission`/`approval`/`elicit` 相关的 `sessionUpdate`，也无任何 agent→client 方向的 JSON-RPC 请求（脚本对两个方向都做了匹配）
- `stopReason:"end_turn"`，正常收尾

**含义**：走 ACP 通道，jcode **不经用户审批直接执行写操作**。ACode 客户端的权限弹窗（`pendingInteractions` + `resolveInteraction` 闭环）在这条通道上**无从触发**——不是"UI 少个按钮"，而是 ACode 的权限治理（build/edit/plan/yolo 模式、策略地板、blast-radius 门控）**整体旁路**。

这是本次适配的**头号风险**，spec 必须正面处理。可选方向（待 spec 裁决）：

1. **宿主侧拦截**：ACP 的 `clientCapabilities.fs.writeTextFile:true` 意味着 agent 的写文件可以**回调宿主**执行（`fs/write_text_file`）。若 jcode 的写操作走这条回调而非自己直接写盘，shim 就能在回调处插入 ACode 的权限裁决。需先验 jcode 是否真的使用 fs 回调（本轮实测它似乎直接写盘，需查 `acp.rs` 的 fs 能力实现）。
2. **daemon 侧策略**：依赖 jcode 自己的 `jcode-command-risk` 反射门（对 bash 生效）+ 配置化 approval 档位。但这是 jcode 的模型，不是 ACode 的，且对文件写操作覆盖面待查。
3. **降级声明**：明确 jcode 后端只支持受限模式（如仅 plan/只读），写操作模式不开放。
4. **换 harness API 通道**：其 `configure_tools` 是"宿主自己实现工具"的客户端回调模型——工具执行权在宿主，天然可插入权限裁决。但该通道在 Windows 受阻（§4 修正 3）。

## 3.2 第一轮（只读）与第二轮（写）的对照

| 轮次 | 任务                 | 工具  | 权限帧 | 结果                   |
| ---- | -------------------- | ----- | ------ | ---------------------- |
| 1    | 读 `test.txt`        | read  | 无     | 成功，内容正确         |
| 2    | 写 `spike-write.txt` | write | **无** | **成功，文件真被创建** |

两轮都无权限帧——不是"只读所以不审批"，而是**该通道根本没有审批回路**。

## 4. 对上游评估文档的三处修正

### 修正 1（重大利好）：ACP 子进程是自包含的，kill 即重置——符合 ACode 独占子进程模型

上游评估 §3.2 担忧"ACP `ensure_daemon()` 连共享 daemon，多窗口落同一 daemon，ACode 无法 kill agent 重置会话"。

**实测否证**：spike 进程结束后 `tasklist //FI "IMAGENAME eq jcode.exe"` 返回**零进程**，`~/.jcode/servers.json` 为 `{}`，无残留 socket/lock 文件。stderr 的 "Starting server..." 表明 server 是**进程内**起的，随子进程一起退出，不是 `setsid` 脱离的常驻 daemon。

**含义**：Windows 上走 ACP，ACode 的"Host spawn 独占 agent 子进程、kill 即重置、崩溃域隔离、`ACODE_AGENT_IDLE_EXIT_MS`"这套生命周期假设**天然成立**，无需 §3.2 设想的每窗口独立 `JCODE_SOCKET` + 私有 daemon 改造。这消除了四堵墙中的一堵的主要部分。

（边界：此结论基于 Windows + ACP + 单次会话实测。Unix 上 jcode 的默认 `setsid` 常驻 daemon 行为、以及多客户端并发 attach 同一 daemon 的场景**未实测**。）

### 修正 2：Windows 上 ACP 是唯一现成可用通道，且能力比评估预期的"窄"要够用

上游评估把 ACP 列为"能力面窄的退路"（无 permission 方法、会话 MCP 未实现）。实测确认这两条限制属实，但**核心对话链路（流式文本 + 工具卡 + 多会话 + 模型切换 + usage）完整可用**，足以承载 ACode 客户端的主聊天面。

### 修正 3：自编译 `jcode-harness-api-bridge.exe` 这条路在本机受阻（网络，非代码）

上游评估出路 (a) 设想自行编译随附 bridge exe 以在 Windows 用上功能更全的 harness API。实测：

- **代码层面可行**：`crates/jcode-harness-api-server/src/bin/bridge.rs` 这个独立 bin **无 cfg 门控**（纯 tokio + `run_bridge(api_socket, legacy_socket)`），crate 内已有 `#[cfg(windows)]` 分支（`lib.rs:249`、`translate/credentials.rs:180`）+ `jcode-transport` 的 named-pipe 抽象——上游确实写了 Windows 支持路径。`#[cfg(unix)]` 只门控主 `jcode` 二进制里的 `api-bridge` **子命令**，不门控这个独立 bin。
- **构建受阻**：`cargo build --release -p jcode-harness-api-server --bin jcode-harness-api-bridge` 失败于 `error: failed to get async-trait ... unable to update registry crates-io ... curl failed: [28] Timeout`——**本机无法访问 crates.io**，且两个 git 依赖（`1jehuang/agentgrep`、`1jehuang/mermaid-rs-renderer`）同样需联网。
- 附带教训：该次后台命令因管道 `| tail -40` 吃掉了 cargo 退出码而报 exit 0，**假绿**。产物实际不存在（`target/release/` 无 exe）。后续构建验证必须查产物存在性，不能只看退出码。

**含义**：harness API 路线（功能更全：有 `SetApiKey`/`NotifyAuthChanged` 凭据热重载、`getHistory`、`fork`、`listSessions`）需要能联网的环境或 vendored 依赖才能验证。当前阶段以 **ACP 为主通道**推进，harness API 作为后续增强（其独有能力中，凭据桥对 ACode 最有价值）。

## 4.1 权限缺口经三方印证（实测 + 两条通道源码）

§3.1 的写操作零审批是 ACP 通道的实测结论。进一步的源码调查确认这是**结构性**的，且**两条候选通道都无解**：

| 证据来源                   | 结论                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **实测**（本文 §3.1）      | ACP 写文件成功，零权限帧（agent→client 方向也无任何请求）                                                                                                                                                                                                                                                                                           |
| **jcode ACP 源码**         | `src/cli/acp.rs:341-393` 入站 dispatch 表只有 10 个方法（initialize/session/{new,load,resume,prompt,cancel,close,set_config_option,set_model,set_reasoning_effort}）；全仓零 `session/request_permission` 出站。`acp.rs` 中 `fs/read_text_file`、`fs/write_text_file`、`terminal/*` **零命中**——jcode 不使用 ACP 的宿主回调能力，agent 直接自己写盘 |
| **jcode harness API 源码** | `crates/jcode-harness-api-server/src/translate.rs:1342-1357` 注释原话 "the bridge never emits `permission_request`"；`permission_response` 恒回 `invalid_request`；`hello_ok` 的 capabilities 列表**有意不含** `permissions`（`lib.rs:379-407`）                                                                                                    |
| **daemon 侧策略**          | `crates/jcode-config-types/src/lib.rs` 中 `approval_mode`/`auto_approve`/`permission_mode`/`require_approval` **零命中**——无可配置的审批档位                                                                                                                                                                                                        |

**缓解方向的可行性裁决**（§3.1 列的四条，逐条核实）：

1. ~~宿主侧 fs 回调拦截~~ —— **不可行**。jcode 的 ACP 层不实现 `fs/write_text_file` 回调（源码零命中），写操作不经宿主。
2. **daemon 侧策略 —— 部分可用，覆盖面窄**。`jcode-command-risk` 的反射门确实生效，但只覆盖两个工具：`bash.rs:883`（`destructive_command_refusal`）与 `apply_patch.rs:183`（仅 `is_catastrophic_target` 绝对拒绝层）。`write.rs` 与 `edit.rs` 中 command_risk/permission/approval **零命中**——即普通文件写入无任何门控，与实测一致。源码注释自陈"Only the catastrophic tier: ordinary file deletes are this tool's normal job"。
3. **降级声明 —— 可行且是当前唯一稳妥选项**。jcode 后端只开放只读/plan 类模式，写操作模式不提供。
4. **换 harness API 通道 —— 对该问题无帮助**。其 `configure_tools` 是"宿主自己实现工具"的模型，理论上能把工具执行权收到宿主侧从而插入裁决，但这是**换掉 jcode 的工具体系**（等于不用 jcode 的工具），且该通道在 Windows 受阻（§4 修正 3）。

**净结论**：走 jcode 后端，ACode 的权限治理（build/edit/plan/yolo 模式语义、策略地板、blast-radius 门控、权限弹窗）**在文件写操作维度整体旁路**，仅 bash 命令维度能借 jcode 自己的反射门得到部分保护（且那是 jcode 的模型，不是 ACode 的）。这是 spec 必须显式声明的产品级限制，不能靠工程手段绕过。

## 4.2 凭据桥的通道分裂（新发现）

上游评估 §4 把"凭据桥接近现成"列为 jcode 相对 omp 的实质优势（`SetApiKey`/`NotifyAuthChanged` 运行期热重载）。**该优势只存在于 harness API 通道**：

- **harness API**：`set_api_key{provider,api_key}` → bridge 写盘（0600 原子写，Windows 用 `MoveFileExW`）+ 发 `notify_auth_changed` → daemon **活进程热重载** → 回 `credential_updated{provider,configured}`。白名单 6 个 provider（claude-api/openai-api/openrouter/cursor/gemini/jcode）。落盘位置随 `JCODE_HOME` 隔离（`$JCODE_HOME/config/jcode/<provider>.env`）。
- **ACP**：`initialize` 响应实测 `authMethods:[]`——**无凭据协商面**。shim 只能在 spawn 前预置凭据（写 env 文件或注入 `*_API_KEY` env）。

**含义**：Windows 上现成可跑的 ACP 通道，恰好是凭据桥较弱的那条；凭据桥强的 harness API 通道，恰好是 Windows 受阻的那条（§4 修正 3）。两者不能兼得，除非解决 bridge 编译。

（实测本轮会话在无 `~/.jcode/auth.json`、无 provider env 文件的情况下仍成功调用模型，说明本机 jcode 已有其他凭据来源；**ACode 凭据如何注入仍未验**，见 §5。）

## 4.3 多会话与 resume 实测（第三轮 spike）

| 测试                                     | 结果                                                         | 判定                                     |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| 同一 ACP 连接开两个 `session/new`        | 返回两个不同 sessionId（`session_herb_…` / `session_ant_…`） | ✅ 多会话可用，ACode 侧栏 + 多窗口有载体 |
| `session/load`（已存在会话）             | 成功，返回 configOptions + models                            | ✅ resume 通道可用                       |
| `session/resume`（已存在会话）           | 成功，同上                                                   | ✅                                       |
| **`session/load`（不存在的 sessionId）** | **返回 `{}`（空对象），不是 JSON-RPC error**                 | ⚠️ **fail-open**                         |
| `session/cancel`（空闲会话）             | 返回 `{}`，无错误                                            | ✅ 幂等                                  |

**fail-open 问题**：`session/load` 对不存在的会话静默返回空成功，而非 `-32601`/`unknown_session` 类错误。ACode 的纪律是 fail-closed（参见 `agent-command-env-gate.md`、server auth 的"非 loopback 无 token 拒绝启动"）。shim 必须**自己校验** load/resume 的返回是否含有效 session 身份，不能信"无 error 即成功"——否则 ACode 会以为恢复了一个不存在的会话，UI 呈现空会话而非报错。

这条要写进 shim 的验收场景。

## 4.4 JCODE_HOME 隔离部分失效（安全硬化层的硬约束）

上游评估与 SDK `launch.ts` 设想用独立 `JCODE_HOME` 给每窗口/每实例做数据隔离（SDK 私有实例正是靠它）。**实测发现该隔离是部分的**：

用 `JCODE_HOME=<临时隔离目录>` spawn ACP 并真跑一轮 prompt 后：

| 数据类型                   | 落盘位置                                        | 是否被 JCODE_HOME 隔离 |
| -------------------------- | ----------------------------------------------- | ---------------------- |
| logs                       | `<隔离目录>/logs/`                              | ✅ 是                  |
| migrations 标记            | `<隔离目录>/migrations/`                        | ✅ 是                  |
| **sessions（会话持久化）** | **真实 `~/.jcode/sessions/`**（实测计数 70→71） | ❌ **否**              |
| config                     | 未见写入隔离目录                                | 待查                   |

隔离目录内**没有** `sessions/` 子目录，会话数据全部落进了用户真实的 `~/.jcode`。

**含义（对架构的直接影响）**：

- ACode 设想的"每窗口独立 jcode 实例、数据互不干扰"**在会话存储层不成立**。多个"隔离"实例实际共享同一个 `~/.jcode/sessions` 存储。
- 与 §4 修正 1（进程 kill 即退出）结合看：进程生命周期可隔离，但**持久化数据不隔离**。
- 机制未在 spike 中定位（可能：Windows 上 session 存储路径不完全读 `JCODE_HOME`，或 ACP `ensure_daemon` 连到了用真实 home 起的共享 daemon）。**标注为待查**，不臆断。
- 若 shim 依赖数据隔离来做多窗口边界，此路不通；需改用 sessionId 级逻辑隔离（同一 `~/.jcode` 下按 sessionId 区分会话），并接受所有 jcode 会话共享一个物理存储根。

这条与 §4.1 的权限旁路、§4.2 的凭据分裂一起，构成 spec 必须正面处理的三个产品级约束。

## 5. 剩余未知项（进入 spec 前需明确或标注为待验）

| 未知项                       | 为什么重要            | 怎么验 / 现状                                                                                                                                                                        |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ACode 凭据如何注入 jcode** | 凭据桥是硬契约之一    | ACP `authMethods:[]` 为空，ACP 面无凭据协商；harness API 有 `set_api_key` 但 Windows 受阻（§4.2）。需查 jcode 读凭据的路径能否由 shim 在 spawn 前写入（`JCODE_HOME` 隔离）。**未验** |
| **长会话与 compaction**      | 生产可用性            | 跑长对话观察 auto-compaction 事件。**未验**                                                                                                                                          |
| **ACP 无会话 MCP**           | ACode 的 MCP 配置下发 | `mcpCapabilities:{http:false,sse:false}` + `validate_acp_mcp_servers` 只校验数组即放行；ACode 的 MCP 配置能否经 `~/.jcode/` 配置文件落盘生效。**未验**                               |
| **Unix 侧行为差异**          | 跨平台一致性          | 在 Linux/macOS 上重跑本 spike，确认 daemon 生命周期与 Windows 是否一致（§4 修正 1 的独占子进程结论仅 Windows 实测）。**未验**                                                        |
| ~~多会话并发~~               | —                     | ✅ 已在 §4.3 验通（两 session 独立 id）                                                                                                                                              |
| ~~断线重连 / resume~~        | —                     | ✅ 已在 §4.3 验通（`session/load`、`session/resume` 成功；但发现 fail-open 问题）                                                                                                    |

## 6. 下一步

按 AGENTS.md 的 spec-first 约定：先写集成 spec（产品规则、状态所有者、接口、验收场景），再实现 shim。集成 spec 必须先处理的前置决策是推翻 [`agent-engine-external-slots-removal.md`](../packages/shared/specs/agent-engine-external-slots-removal.md) 的单引擎裁决——注册表当前只剩 native `glm`（`packages/shared/src/acode-agent-registry.ts:23`），加 jcode 引擎要动 `ACodeProvider` 联合类型 + 注册表 + 恢复 externalEngineCommandResolver，且受 [`agent-command-env-gate.md`](../packages/services/specs/agent-command-env-gate.md) R1 约束（**打包态忽略 env 对 agent 命令的覆盖**，故 shim 不能靠 `ACODE_AGENT_SERVER_COMMAND` 注入，必须走 Settings 显式配置 + 注册表候选链）。
