# jcode 外部 agent 桥接：ACode 客户端经 ACP 驱动 jcode（v4 北向复用）

> **文档状态**：spec（先于实现）。**分支**：`feature/cli-jcode-adapter`。
> **决策依据**：[docs/jcode-cli-replacement-assessment-2026-10-23.md](../../../docs/jcode-cli-replacement-assessment-2026-10-23.md)（分析）、[docs/jcode-adapter-spike-2026-10-23.md](../../../docs/jcode-adapter-spike-2026-10-23.md)（Windows 真机实测，本 spec 的产品约束全部来自它）。
> **同类参照**：[acp-host-adapter.md](acp-host-adapter.md)（K8，**方向相反**：那份是 ACode 作为 ACP server 被 IDE 驱动；本 spec 是 ACode 作为 ACP **client** 驱动外部 agent）。本 spec 的结构与之同构，映射方向相反。

## 背景：已核实的现状

- ACode 客户端（Desktop / Web / TUI）只说 `acode-protocol-v4`：CLI 端归约出带 `revision`/`seq`/`logEpoch` 的权威 snapshot + 键级 delta，客户端从不自己归约事件。
- `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/` 的 v4 网关（约 2.4 万行）是 **host 无关**的通道运行时：它只经一个南向接口 `V4GatewayHost`（`v4-gateway.ts:218-466`，3 个必选方法）拿事件、发命令，只经 `emitWireFrame` 出帧。目录内仅 `commands/` 子树绑定 native runtime。
- jcode（外部 Rust agent，v0.99.0）在 Windows 上可用通道是 `jcode acp`（stdio JSON-RPC 2.0）。其功能更全的 harness API 桥 `api-bridge` 是 `#[cfg(unix)]`，Windows shipped 二进制不含该子命令（spike §4 修正 3 实测确认）。
- spike 已实测：Node 栈经 ACP 能驱动 jcode 跑完带工具调用的完整会话（读、写各一轮），多会话并发与 `session/load`/`resume` 可用。

## 产品规则

### R1 进程与协议形态

- **入口**：`acode jcode-bridge --stdio`（CLI 新子命令）。进程形态与 native `app-server --stdio` 同构：单可执行入口、stdio 三 pipe、**stdout 只写协议帧**（一行一条 JSON、LF 结尾）、诊断一律走 stderr。
- **北向**：对 ACode 客户端说 v4，**复用**现有 `ConversationV4Gateway`（不自建投影）。shim 实现 `V4GatewayHost`，把 `emitWireFrame` 接到 stdout NDJSON connection。
- **南向**：`child_process.spawn` 一个 jcode 子进程跑 `acp` 子命令，stdio 上说 ACP JSON-RPC 2.0（NDJSON，逐行）。**每 shim 进程一个 jcode 子进程**（1:1），不复用、不共享。
- **argv 兼容**：入口必须接受 `app-server --stdio` 与 `--surface desktop` 等 native 形态的参数而不报错（宿主 `applyPresentationSurfaceToCommand` 会追加），未识别参数忽略。
- **打包形态**：落在 `apps/acode-cli` 内（`architecture-policy.yaml:257-259` 该模块 `managed:false`），编进现有 SEA/`acode.cjs` 链，**零架构登记**；受"新文件 ≤400 行"ratchet 约束，故按 host 面拆分多文件（R6）。
- **接线（分两态，边界明确）**：
  - **dev / 独立 CLI / 远程 server（非打包态）**：设 `ACODE_AGENT_SERVER_COMMAND` + `ACODE_AGENT_SERVER_ARGS_JSON=["jcode-bridge","--stdio"]` 即可（`acodeAgentProcessManager.ts:604-620`）。**本 spec 的实现范围**。
  - **打包态桌面**：env 覆盖被 [`agent-command-env-gate.md`](../../../packages/services/specs/agent-command-env-gate.md) R1 禁用（安全加固 P2，不可绕）。需先推翻 [`agent-engine-external-slots-removal.md`](../../../packages/shared/specs/agent-engine-external-slots-removal.md) 的单引擎裁决、在注册表加回外部引擎槽位（`acode-agent-registry.ts:23`）+ Settings 显式选择。**这是治理决策，不在本 spec 实现范围**，见「前置决策」。

### R2 消息映射表（核心契约）

方向：ACP（shim ↔ jcode）↔ v4（shim ↔ ACode 客户端）。

| v4（客户端 → shim）                               | ACP（shim → jcode）                                                         | 备注                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createSession`                                   | `session/new`（cwd 必须 **Windows 绝对路径**，spike §2 实测 msys 风格被拒） | 返回 jcode `sessionId`；shim 维护 v4 sessionId ↔ jcode sessionId 映射                                                            |
| `sendText`                                        | `session/prompt`                                                            | jcode 无 turn 一等 id，shim 自造 turn 边界（R3）                                                                                 |
| `stop`                                            | `session/cancel`                                                            | spike §4.3 实测幂等（空闲会话返回 `{}` 无错）                                                                                    |
| `switchModelConfig`                               | `session/set_model`                                                         | jcode 侧模型目录经 `session/new` 响应的 `models.availableModels` 获得                                                            |
| `usage`                                           | —（本地归约）                                                               | 由 shim 累加 `usage_update` 事件合成；jcode **无货币成本字段**，cost 置空不伪造                                                  |
| `deleteSession`/`renameSession`                   | `session/close` / —                                                         | jcode ACP 无重命名面，降级为 no-op + 记录                                                                                        |
| `forkAssistant`/`applyFileRewind`/`editUserQuery` | **无对应**（ACP 面无 fork/rewind）                                          | 降级：ACK `rejected` + 明确 reasonCode（R5）                                                                                     |
| attachment `begin`/`chunk`/`commit`               | `session/prompt` 的 `images`（内联 base64）                                 | jcode 无三段事务；shim 复用 v4 `attachment-upload-registry` 完成 staging，commit 后转内联。**受 ACP 帧大小限制**，超限即拒（R5） |

| ACP（jcode → shim）                                     | v4 SessionEvent                                                     | 备注                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `session/update` `agent_message_chunk`                  | `ModelStreaming`（`kind:"text_delta"`，`delta` 追加）               | spike 实测 19–27 chunk/轮，天然对齐 v4 `row.delta{append}`               |
| `session/update` `tool_call`（status pending）          | `ToolCallScheduled` + `ModelStreaming`（`kind:"tool_input_start"`） | rowId = jcode `toolCallId`（四事件稳定一致）                             |
| `session/update` `tool_call_update`（in_progress）      | `ToolCallStarted`                                                   | 大量空字段增量帧须按 toolCallId 归并，**不得逐帧建 row**                 |
| `session/update` `tool_call_update`（completed/failed） | `ToolCallResult` / `ToolCallError`                                  | `rawOutput{output,error}` 映射                                           |
| `session/update` `usage_update`                         | 累加至 `ModelComplete` 的 usage                                     | spike 实测每轮 2 次                                                      |
| `session/update` `available_commands_update`            | `workspace-config` 的 slash 命令目录                                | 实测 model/models/effort                                                 |
| `session/update` `session_info_update`                  | `SessionTitleUpdated`                                               |                                                                          |
| prompt 请求返回 `{stopReason}`                          | `TurnComplete` / `TurnError`                                        | `end_turn`→complete；`cancelled`/其他→error 或 complete 按 reason 分派   |
| **（无对应）**                                          | `TurnStarted`                                                       | **shim 合成**：在 `sendText` 被 admission 接受时分配 turnId 并发出（R3） |

### R3 状态所有权与 turn 合成

| 状态                                            | 所有者                                   | 生命周期 |
| ----------------------------------------------- | ---------------------------------------- | -------- |
| v4 投影（snapshot/seq/revision/logEpoch）       | 复用的 `ConversationV4Gateway`           | 进程     |
| CommandInbox admission（六态 ACK/CAS/512 幂等） | 复用的网关内部 inbox                     | 进程     |
| attachment staging                              | 复用的 `attachment-upload-registry`      | 上传 TTL |
| **turnId 分配与封口**                           | **shim**（jcode 无一等 turn id）         | 轮次     |
| v4 sessionId ↔ jcode sessionId 映射             | shim 内存 map                            | 进程     |
| 会话真实状态与持久化                            | **jcode daemon**（`~/.jcode/sessions/`） | 跨进程   |

**turn 合成规则**：jcode 的 `turn_done`/`message_accepted`/`prompt` 返回都只带 `session_id`，无 turn 标识。shim 在 `sendText` 命令被 inbox admission 接受时分配单调递增 turnId、发 `TurnStarted`；把该轮内所有 `ModelStreaming`/`ToolCall*` 事件挂到此 turnId；收到 prompt 返回（`stopReason`）时发 `TurnComplete`/`TurnError` 封口。**一轮内可有多条 assistant 文本消息**（工具执行会切分文本），turnHeader 须包裹全部。

**不变量**：shim **无持久状态**（重启即新映射）；映射表是会话关联的唯一事实源；单向数据流（v4 命令 → ACP 调用 → ACP 事件 → SessionEvent → 网关 ingest → v4 帧），**不存在绕过网关的第二条客户端访问路径**。

### R4 权限与安全（本 spec 最重的约束，来自 spike 实测）

spike 三方印证（实测 + jcode ACP 源码 + jcode harness 源码）：**jcode 经 ACP 执行写操作时零审批**——ACP 入站 dispatch 表只有 10 个方法，全仓无 `session/request_permission` 出站；jcode 的 ACP 层不实现 `fs/write_text_file` 宿主回调（agent 直接自己写盘）；`jcode-config-types` 无 `approval_mode`/`auto_approve`/`permission_mode` 任何可配置审批档位。jcode 的 `command-risk` 反射门只覆盖 `bash` 与 `apply_patch`（且后者仅 catastrophic 绝对拒绝层）；`write.rs`/`edit.rs` **零门控**。

由此确立规则：

- **R4-1 权限模式不承诺**：jcode 后端的会话**不得**声明支持 ACode 的 `build`/`edit` 权限语义。引擎描述符的 `supportedPermissionModes` 必须收敛为诚实集合（见「前置决策」的注册表约束）。客户端权限弹窗在该后端**永不出现**——这是产品级限制，须在 UI/文档显式声明，不得静默降级成"看起来有权限治理"。
- **R4-2 遥测硬关（不可选）**：spawn jcode 时**必须**注入 `JCODE_NO_TELEMETRY=1` + `DO_NOT_TRACK=1` + `--no-update`。jcode 遥测默认开、上报自有端点 `telemetry.jcode.sh`（含 provider OAuth 邮箱）。ACode 现有 `no-telemetry` 守护测试只扫仓库内 JS/TS 文本，**对原生子进程运行时行为失明**，故不能依赖守护测试兜底——注入是硬要求，且有测试断言（R7）。
- **R4-3 self-dev 禁用**：spawn 的 cwd **必须**是用户 workspace，绝不可是 jcode 源码检出（在 jcode repo 内启动普通 session 会自动进 self-dev，允许 agent 改写自己被分发的二进制、绕过全部签名校验）。shim 须校验 cwd 不含 jcode 源码特征，命中即拒绝启动。
- **R4-4 fail-open 自校验**：`session/load`/`session/resume` 对不存在的 sessionId **静默返回 `{}`**（spike §4.3 实测），不是 JSON-RPC error。shim **不得**以"无 error 即成功"判定恢复成功，必须校验返回体含有效 session 身份，否则按失败处理。与 ACode fail-closed 纪律对齐。
- **R4-5 数据隔离诚实边界**：`JCODE_HOME` 隔离**部分失效**——spike §4.4 实测 logs/migrations 落隔离目录，但 **session 数据仍落真实 `~/.jcode/sessions/`**。故 shim **不得**依赖 `JCODE_HOME` 做窗口间数据隔离；多窗口边界只能靠 sessionId 逻辑隔离，并接受所有 jcode 会话共享一个物理存储根。此边界须在文档中声明。
- **R4-6 凭据**：ACP `initialize` 返回 `authMethods:[]`，**ACP 面无凭据协商通道**。本 spec 的实现范围**不搬运 ACode 凭据**——jcode 使用其自身已配置的凭据（`~/.jcode/auth.json`、`~/.config/jcode/*.env`）。shim 不读、不写、不转发任何凭据内容（源码断言，与 K8 R3 同纪律）。ACode 凭据桥（OS 钥匙串 → jcode）依赖 harness API 的 `set_api_key`/`notify_auth_changed`，Windows 受阻，**留待后续独立立项**。

### R5 降级与错误映射

- **能力降级必须显式**：jcode 无对应的 v4 命令（fork/rewind/editUserQuery/workflow/swarm/goal/hook/artifact）→ `executeCommand` 抛携带 `reasonCode` 的领域错误，网关据此产 ACK `failed` + `fault.capability.unsupportedByExternalAgent`（v4-gateway.ts:2605-2618 的机制：executeCommand 抛错一律归 `failed`，domain reasonCode 原样上行；`rejected` 仅由 inbox 的 guard/CAS 裁决产生，executeCommand 无法直接给出），**不得**静默 noop 让客户端以为成功。
- **错误映射**：jcode ACP 的 JSON-RPC error → v4 ACK `failed` + reasonCode；jcode 子进程崩溃/退出 → 该会话所有在飞命令 `failed` + 会话标记 ended，并经 `onError` 留痕。
- **executeCommand 必须恰好 settle 一次**：`command-inbox.ts:242-272` 用 settle 释放 per-session FIFO gate；shim 的 `executeCommand` 若既不 resolve 也不 reject，**该 session 的命令队列永久卡死**。所有路径（含超时、子进程死亡、未知命令）都必须 settle。
- **超时**：ACP 请求默认超时（常量表），超时即 reject + settle，不悬挂。

### R6 模块拆分（≤400 行/文件硬约束）

| 模块                                 | 职责                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `jcode-bridge/entry.ts`              | 进程入口：stdin 包装、构造 NDJSON connection + 网关、装配 host          |
| `jcode-bridge/host.ts`               | 实现 `V4GatewayHost`（3 必选 + 建议可选方法）                           |
| `jcode-bridge/dispatch.ts`           | 瘦 v4 dispatch（server.ts:494-613 的 v4 子集）+ post-response outbox    |
| `jcode-bridge/acp-client.ts`         | **唯一 I/O 边界**：spawn jcode、ACP 帧收发、id 关联、就绪/退出          |
| `jcode-bridge/spawn-jcode.ts`        | 真 `child_process` spawn + 进程树终止（I/O 收敛点，与 acp-client 同层） |
| `jcode-bridge/acp-types.ts`          | ACP JSON-RPC 帧类型与入站判别（适配层私有契约）                         |
| `jcode-bridge/event-translator.ts`   | ACP `session/update` → `SessionEvent`（含 turn 合成、toolCallId 归并）  |
| `jcode-bridge/command-translator.ts` | v4 `CommandEnvelope` → ACP 调用；settle 语义                            |
| `jcode-bridge/constants.ts`          | 常量集中（R7 表）                                                       |
| `jcode-bridge/session-map.ts`        | v4 sessionId ↔ jcode sessionId 映射                                     |
| `jcode-bridge/selfdev-guard.ts`      | spawn 前 self-dev 防护闸（R4-3）                                        |

按根 AGENTS.md「外部 I/O 边界收敛」：`child_process`/`process.env`/`node:fs` 只允许出现在 `spawn-jcode.ts`（adapter 层），其余模块依赖其接口。

### R7 jcode 二进制解析与 cwd 映射

- **二进制路径解析优先级**：CLI 参数 `--jcode-binary <path>`（显式覆盖）→ PATH 上的 `jcode`（Windows `jcode.exe`）。**不新增 `ACODE_*` 环境变量**——apps/acode-cli/AGENTS.md「不要随便新增环境变量，能用 CLI 参数表达的优先不做成 env」，故走 CLI 参数而非 env。解析失败（PATH 无 jcode 且未给 `--jcode-binary`）→ 进程以明确错误退出，不发半死 storage 帧。
- **cwd 映射**：`createSession` 的 `workspaceId` → jcode `session/new` 的 cwd。依据 Workspace Identity 约束（根 AGENTS.md「身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`」），**本地 workspace 的 workspaceId 即 workspacePath**，故 cwd 直接取 workspaceId；远程 workspace 的路径语义不在本 spec 范围（jcode 后端本期只支持本地）。cwd 必须是平台原生绝对路径（spike §2：msys 风格 `/tmp/...` 被 jcode 拒），经 Node `path.resolve` 归一。
- **v4 sessionId 生成**：shim 自造（jcode sessionId 由 jcode daemon 生成、shim 无法指定），形如 `jcode-<uuid>`，登记进 session-map（R3）。

## 常量

| 常量                                  | 值                                            | 出处                                                |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| `JCODE_ACP_PROTOCOL_VERSION`          | `1`                                           | spike §2 实测（jcode 强制 pin 1，忽略客户端请求值） |
| `JCODE_ACP_REQUEST_TIMEOUT_MS`        | `30000`                                       | R5；对齐 jcode SDK 默认（client.ts:323）            |
| `JCODE_PROMPT_TIMEOUT_MS`             | `600000`                                      | R5；镜像 K8 `ACP_PROMPT_TIMEOUT_MS` 量级            |
| `JCODE_SPAWN_ENV_TELEMETRY_OFF`       | `{JCODE_NO_TELEMETRY:"1",DO_NOT_TRACK:"1"}`   | R4-2 硬要求                                         |
| `JCODE_SPAWN_ARGS`                    | `["acp","--no-update"]`                       | R4-2                                                |
| `JCODE_UNKNOWN_ERROR_CODE`            | `-32603`                                      | R5（JSON-RPC internal）                             |
| `JCODE_CAPABILITY_UNSUPPORTED_REASON` | `fault.capability.unsupportedByExternalAgent` | R5                                                  |

## 接口

- 新增导出：`apps/acode-cli/packages/bootstrap/src/index.ts` 导出 `ConversationV4Gateway`（当前只导出 `runACodeProtocolAgent`，`:68`），使 shim 走公共入口而非深 import。
- CLI 子命令：`apps/acode-cli/packages/cli/src/run.ts` 新增 `case "jcode-bridge"`（argv 判定在 `cli/src/arguments.ts:117-131`）。
- shim 实现的宿主接口：`V4GatewayHost`（`v4-gateway.ts:218-466`），必选 `sessionExists`/`emitWireFrame`/`executeCommand`，建议实现 `loadPersistedEvents`/`getSessionConfigSeed`/`putSessionAttachment`/`onDebug`/`onError`；其余可选方法不实现即优雅降级。
- **不复用** `acode-protocol-v4/commands/`（native executor，绑定 `ACodeApp`/`@acode/core`）；shim 自写 `executeCommand` 整体绕过。

## 验收场景

1. **进程形态**：`acode jcode-bridge --stdio` 启动后 stdout 首帧是 storage startup 控制面（与 native 一致），诊断只出现在 stderr；传 `app-server --stdio --surface desktop` 不报错。
2. **一轮对话端到端**：客户端 `createSession` → `sendText` → 收到 snapshot 帧含 `turnHeader`+`userInput`+`assistantText` row，`row.delta` 增量追加文本，终态 `row.upserted`，`turnHeader.state=completedSuccess`。
3. **工具卡**：jcode 调工具时收到 `toolCall` row，status 走 `inputStreaming`→`running`→`success`；**16–27 个 `tool_call_update` 增量帧只产生一个 row**（归并正确性）。
4. **turn 合成**：一轮内含工具切分的多条 assistant 文本 → 全部挂在同一 turnId 的 turnHeader 下；turnId 单调递增不复用。
5. **命令 ACK 六态**：`sendText` 重复 commandId → `duplicate`；错误 `baseRevision` → `stale`；jcode 无对应能力的命令（`forkAssistant`）→ `failed` + `fault.capability.unsupportedByExternalAgent`。
6. **settle 恰好一次**（R5）：注入超时、子进程中途死亡、未知命令三种故障，断言 per-session gate 未卡死（后续命令仍可 admission）。
7. **遥测硬关**（R4-2）：断言 spawn 的 env 含 `JCODE_NO_TELEMETRY=1`+`DO_NOT_TRACK=1`、argv 含 `--no-update`。**源码断言**：shim 不得存在把这些值设为其他分支的代码路径。
8. **self-dev 防护**（R4-3）：cwd 指向 jcode 源码检出时拒绝启动并给出明确错误，不 spawn。
9. **fail-open 自校验**（R4-4）：`session/load` 返回 `{}`（空对象）时 shim 判定恢复失败，不向客户端呈现空会话为成功。
10. **凭据零接触**（R4-6）：源码断言 shim 不 import 凭据模块、不读写 `auth.json`/`*.env`、不转发凭据字段。
11. **帧 schema 兼容**：产出的 v4 帧过 `conversationDeltaSchema.safeParse` 与 topic wire schema 校验，证明对现有客户端兼容（照 `turn-wrapup-projection.test.mjs:91-100` 惯例）。
12. **跨平台**：cwd 路径构造走 Node `path` API；Windows 绝对路径要求（spike §2）有测试覆盖；spawn 用参数数组形式不用 shell 字符串。

## 前置决策（不在本 spec 实现范围）

打包态桌面集成需先推翻 [`agent-engine-external-slots-removal.md`](../../../packages/shared/specs/agent-engine-external-slots-removal.md)（2026-10-02 实施，删除 codex/opencode/gemini 三个外部槽位、注册表只剩 native `glm`）。该决策是产品级裁决，恢复外部引擎须由维护者显式同意，涉及：

- `ACodeProvider` 联合类型 + `ACODE_AGENT_ENGINE_IDS`（`acode-agent-registry.ts:23`）加回引擎 id；
- 引擎描述符的 `supportedPermissionModes` 必须按 **R4-1** 收敛为诚实集合（jcode 后端不支持权限弹窗，不得声明 `build`/`edit` 的权限语义）；
- 恢复 `externalEngineCommandResolver.ts`（已整文件删除）或等价候选链，且受 `agent-command-env-gate.md` R1 约束：**打包态不吃 env 注入**，只能走 Settings 显式配置 + `~/.acode/server/agents/<engine>` 候选；
- `EngineSection.tsx` 设置页与 locales 键恢复；
- bot `/engine` 命令与 `getBotSelectablePermissionModes` 天花板重新裁决。

本 spec 的实现只在**非打包态**（dev / 独立 CLI / 远程 server）可接线验证，这是 `agent-command-env-gate.md` R1 明确保留的合法配置通道。

## 未做与取舍（诚实边界）

| 项                                              | 状态             | 依据                                                                                                                                |
| ----------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **权限审批闭环**                                | **不做，无法做** | jcode 两条通道均无审批（R4-1，三方印证）。ACode 权限治理在该后端整体旁路，仅 bash 维度借 jcode 自己的反射门得到部分保护             |
| **三域 checkpoint（fork/rewind/级联文件回滚）** | 不做             | ACP 面无对应命令；jcode 的 rewind 是对话层截断 + 单级内存 undo，无文件级回滚                                                        |
| **手机远控 snapshot/replay**                    | 不做             | jcode 无 revision/seq 投影账本；网关的 replay 复用只覆盖桌面 continuous 语义                                                        |
| **ACode 凭据下发**                              | 不做             | R4-6；依赖 harness API，Windows 受阻，独立立项                                                                                      |
| **workflow/swarm/goal/hook/artifact 面板**      | 不做             | jcode 无对等物；相关 v4 命令按 R5 显式 `failed` + `fault.capability.unsupportedByExternalAgent`                                     |
| **cost（货币成本）**                            | 不做             | jcode 全协议无成本字段；只合成 token 用量，不伪造金额                                                                               |
| **sessions-index 侧栏**                         | 降级             | ACP 无跨会话枚举面（harness API 的 `list_sessions` 才有）；shim 只登记本进程创建的会话                                              |
| **Windows harness API 桥**                      | 受阻             | bridge bin 无 cfg 门控、理论可编，但本机 crates.io 不可达（spike §4 修正 3）。需能联网的环境或 vendored 依赖，独立验证              |
| **Unix 侧行为**                                 | 未验             | spike 全部在 Windows 实测；Unix 上 jcode 默认 `setsid` 常驻 daemon，生命周期与 Windows 的"kill 即退"可能不同，须在 Linux/macOS 重跑 |

## 第三方归属

jcode 为 MIT（`Copyright (c) 2025 Jeremy Huang`，fork 自 badlogic/pi-mono 生态）。本 spec 与实现**不拷贝 jcode 源码**，只经其公开的 ACP 协议交互；协议事实来自 spike 实测与 jcode 仓库只读调查，引用处标注文件:行号。若后续引入 jcode 的 npm 包（`@1jehuang/jcode-sdk`，MIT）作为依赖，须同步更新 `third-party/` 台账与 NOTICE 生成流程。

## 附录 A：实施记录（2026-10-23，feature/cli-jcode-adapter）

### A.1 落地的模块与接线

按 R6 拆分，全部落在 `apps/acode-cli/packages/cli/src/jcode-bridge/`（11 文件，2214 行，单文件最大 384 行 acp-client.ts，守住 ≤400 ratchet）：

| 模块                    | 行   | 职责                                                               |
| ----------------------- | ---- | ------------------------------------------------------------------ |
| `resolve-binary.ts`     | 47   | R7 二进制解析（纯函数，PATH 探测由 entry 注入）                    |
| `selfdev-guard.ts`      | 95   | R4-3 self-dev 防护闸（纯逻辑，fs 探测注入）                        |
| `constants.ts`          | 106  | 常量单一事实源                                                     |
| `session-map.ts`        | 119  | R3 双向会话映射（fail-closed 冲突语义）                            |
| `acp-types.ts`          | 179  | ACP 帧类型 + 翻译层契约类型（适配层私有）                          |
| `dispatch.ts`           | 181  | 瘦 v4 dispatch（server.ts v4 子集）+ post-response outbox          |
| `spawn-jcode.ts`        | 205  | 唯一 child_process/fs/env 边界 + 进程树终止波次                    |
| `command-translator.ts` | 219  | v4 CommandEnvelope → ACP（sendText 立即返收据）                    |
| `entry.ts`              | ~290 | 子命令入口：storage 首帧 → connection → gateway(host) → dispatch   |
| `host.ts`               | 67   | V4GatewayHost 实现（3 必选 + loadPersistedEvents/onDebug/onError） |
| `acp-client.ts`         | 384  | ACP 客户端：请求关联 + 通知分发 + 生命周期（R5 settle）            |
| `event-translator.ts`   | 355  | ACP session/update → SessionEvent（turn 合成 + 工具归并）          |

接线三处：

- `apps/acode-cli/packages/bootstrap/src/index.ts`：新增导出 `ConversationV4Gateway`、`V4GatewayHost`(type)、`ACodeProtocolNdjsonConnection`（三者此前均不在公开面；深 import 被 bootstrap exports map 挡死，故必须走公共入口）。
- `apps/acode-cli/packages/cli/src/arguments.ts`：注册 `--jcode-binary`（strict:true 需显式登记）；`isProtocolServerInvocation` 纳入 `jcode-bridge`（stdout 保护，同 app-server）。
- `apps/acode-cli/packages/cli/src/run.ts`：新增 `case "jcode-bridge"`，懒加载 entry（同 acp 的惰性纪律）。

### A.2 装配缝判定 = 选项 (c)（自写瘦 dispatch）

调查确认现有 `ACodeProtocolAgentServer` 把 gateway 硬编码在构造函数（`server.ts:276`）、强依赖 native `createACodeApp`（`server-types.ts:43` 非可选），**无 host 注入缝**。故 entry.ts **不 new server**，只复用 host 无关的 `ConversationV4Gateway` + `ACodeProtocolNdjsonConnection`，dispatch 照 `server.ts:494-613` 的 v4 子集自写（`dispatch.ts`）。gateway 构造期调 0 个 host 方法（全惰性），首次 subscribe 只必调 `sessionExists`；`loadPersistedEvents` 缺席退空基线不 reject。

### A.3 验证结果（如实记录）

| 检查                                                                    | 结果                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm --dir apps/acode-cli/packages/cli typecheck`                      | **0 error**                                                                                 |
| `pnpm --dir apps/acode-cli/packages/bootstrap typecheck`                | **0 error**（改了导出）                                                                     |
| oxlint（17 变更文件）                                                   | **0 warning / 0 error**                                                                     |
| 单文件 ≤400 行 ratchet                                                  | 全部通过（最大 384）                                                                        |
| `tests/jcode-bridge-event-translator.test.mjs`                          | **6/6 pass**（翻译链经真 ProductProjection 产出正确 row + 过 wire schema）                  |
| `tests/jcode-bridge-safety.test.mjs`                                    | **18/18 pass**（R4-2 遥测硬关 / R4-3 self-dev / R4-4 fail-open / R5 settle-once / R3 映射） |
| `tests/jcode-bridge-e2e-smoke.test.mjs`                                 | **pass（15.3s，真进程真模型）**；默认 skip，见 A.4                                          |
| 邻近网关回归（v4-deferred-live-session-repro + turn-wrapup-projection） | **6/6 pass**（bootstrap 导出改动无回归）                                                    |
| 三文件合跑（e2e 默认 skip）                                             | **24 pass / 1 skip / 0 fail**                                                               |

**未执行的验证（环境限制，如实标注）**：

- **未跑 `pnpm verify:pre-push` / 全量 `pnpm test`**：worktree 的 desktop/server 等包 dist 未全量构建，且 pre-push 门禁针对代码模块；本次改动集中在 cli + bootstrap，已按包 typecheck + 定向测试覆盖。
- **打包态桌面接线未做**：属「前置决策」（推翻 `agent-engine-external-slots-removal.md`），是治理决策非工程活，未在本批触碰注册表。
- **未经真桌面 UI 验证**：e2e 冒烟的"v4 客户端"是脚本客户端（直接说 v4 stdio），不是 Electron renderer。桌面 Host（`acodeAgentProcessManager` spawn + services 层消费）未接线跑过，因为那需要打包态或引擎注册表改动（前置决策）。
- **Unix 侧未验**：spike 与本实现的全部实测在 Windows。

### A.4 端到端合流验证（已完成）

`tests/jcode-bridge-e2e-smoke.test.mjs` 补齐了 in-process 单测与 spike 裸 ACP 实测之间缺的最后一环：**真 v4 客户端 → 真 shim 进程（v4 stdio）→ 真 jcode 子进程（ACP）→ 真模型**，15 项断言全过（15.3s，Windows + jcode v0.99.0 实测）：

| 断言              | 实测结果                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| storage 首帧      | `phase:"ready"`、`databaseId:"jcode-bridge"`                                               |
| capabilitiesQuery | `supported:false`（R4-1 诚实降级，不谎报 plan 能力）                                       |
| createSession     | ACK `accepted`，返回 shim 自造 `jcode-<uuid>` sessionId                                    |
| subscribe         | ACK `mode:"snapshot"` + 收到 initial snapshot 帧                                           |
| sendText          | ACK `accepted` + `inputAccepted` 收据 `delivery:"startNow"`（R5：立即返收据不 await 整轮） |
| turnHeader        | `running` → **`completedSuccess`**                                                         |
| rows              | `turnHeader`/`userInput`/`toolCall`/`assistantText` 四类齐备                               |
| assistantText     | 含 probe.txt 真实内容（真模型真读了文件）                                                  |
| toolCall          | 1 个 row、终态 `success`（**jcode 的 16–27 个增量帧正确归并成一个 row**，验收场景 3）      |
| stop              | `accepted`（幂等）                                                                         |
| renameSession     | `failed` + `fault.capability.unsupportedByExternalAgent`（R5 显式降级）                    |
| 帧 seq 记账       | `fromSeq` 0→1→2→3→4→5→9→12 单调，`deliveryKind` initial→online                             |
| spawn 安全        | stderr 实证 `telemetryOff:true`、args `acp --no-update --no-selfdev`（R4-2/R4-3）          |

**跑法**（默认 skip，因需本机 jcode + 其自身 provider 凭据，CI 无这两者）：

```bash
ACODE_JCODE_E2E=1 ACODE_JCODE_E2E_BINARY=<jcode 路径> pnpm --dir apps/acode-cli test
```

**冒烟脚本踩过的两个坑（留痕，避免后人重犯）**：

1. **物理 wire frame 是二级帧**：`{wireVersion, kind:"complete", topic, subscriptionId, frame:<逻辑帧>}`，payload 在**内层** `frame.frame.payload`。首轮脚本在顶层找 `payload` 导致 11 帧全被当空跳过、白等 180s 超时——帧其实一直在正确增长。
2. **Windows spawn 需 file:// URL**：cwd 是 temp workspace（不在仓库下）时 `--import tsx` 无法解析；改绝对路径后又因裸 `C:/` 被当协议 `c:` 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，必须 `pathToFileURL(...).href`。

### A.5 剩余未验项

1. **真桌面 UI 端到端**：需先落地「前置决策」（引擎注册表加回外部槽位 + Settings 选择），才能在 dev 态用 `ACODE_AGENT_SERVER_COMMAND` 拉起桌面验证 Electron renderer 消费 shim 帧。
2. **Unix 侧行为**：Linux/macOS 上 jcode 默认 `setsid` 常驻 daemon，进程生命周期与 Windows 的"kill 即退"（spike §4 修正 1）可能不同，须重跑本 e2e。
3. **多窗口 / 多会话并发**：e2e 只验单会话单轮。`JCODE_HOME` 隔离部分失效（spike §4.4）意味着多窗口只能靠 sessionId 逻辑隔离。
4. **长会话与 compaction**、**MCP 配置下发**、**ACode 凭据桥**：见「未做与取舍」。
