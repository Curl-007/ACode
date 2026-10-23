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
  - **dev / 独立 CLI / 远程 server（非打包态）**：设 `ACODE_AGENT_SERVER_COMMAND` + `ACODE_AGENT_SERVER_ARGS_JSON=["jcode-bridge","--stdio"]` 即可（`acodeAgentProcessManager.ts:604-620`）。**本 spec 的实现范围**——已由 L1/L2 真实客户端栈测试验证（附录 A.5）。
    **⚠ 限定（附录 A.8 实证）**：此通道对**直接 new ProcessManager 的调用方**（独立 CLI、远程 server、L1/L2 测试）成立，但**对桌面 Host 不成立**——Host 的 `prepareSessionStorage` 硬性要求 command 带 `storagePreparationEntry`，而 env 覆盖分支不提供，故桌面走此通道会在 storage 准备阶段 `unsupported_runtime` 失败、agent 根本不被 spawn。桌面接线只能走下方「前置决策」的注册表通道（与 `agent-command-env-gate.md` R3「不恢复 env 通道」的裁决一致）。
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
- bot `/engine` 命令与 `getBotSelectablePermissionModes` 天花板重新裁决；
- **storage 入口与会话命令解耦**：A.8 曾表述为"需要新增解耦"，A.9 修正为更精确的两层区分——**Worker argv 的解耦早已存在**（`prepareSessionStorage` 的 argv 硬编码 `app-server --stdio --prepare-storage`，`storagePreparationProcesses.ts:131`，与 `command.args` 无关），但**入口 bundle 的解析此前仍耦合**在 `resolveDefaultACodeAgentCommand` 的返回值上（读它的 `storagePreparationEntry`），故 env 覆盖分支不带该字段就 `unsupported_runtime` 失败。**已在 `host-startup-storage-cwd.md` R6 落地解耦**：新增 `resolveACodeStoragePreparationEntry`（services，独立候选链、刻意不吃 env 覆盖），桌面 `storagePreparationProcesses.ts` 改用它，storage 入口从此与会话 agent 引擎选择完全无关。A.8 的 `unsupported_runtime` 失败已由 R6 修复（受控对照实测计数 1→0）。

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

### A.5 真实客户端栈验证（三层保真度，已完成）

A.4 的冒烟用自写脚本客户端说 v4 stdio，只验了 shim 的协议契约。此后又补了两层更真实的验证，全部 Windows + jcode v0.99.0 真机实测、真模型执行：

| 层  | 测试文件                                                      | 驱动方                                             | 覆盖                                                                                                                                                                                                                   | 实测                           |
| --- | ------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| L0  | `apps/acode-cli/tests/jcode-bridge-e2e-smoke.test.mjs`        | 自写脚本客户端（v4 stdio）                         | shim 协议契约                                                                                                                                                                                                          | **pass 20.5s**                 |
| L1  | `packages/services/tests/jcode-bridge-real-client.test.mjs`   | `ACodeAgentProcessManager` + `ACodeProtocolClient` | env 覆盖 spawn、命令解析、storage gate、帧收发、投影                                                                                                                                                                   | **pass 17.0s**（帧 8、rows 4） |
| L2  | `packages/services/tests/jcode-bridge-service-layer.test.mjs` | **`createACodeAgentService()`** 完整 service 层    | 桌面 Host 真实走的接口：`sendConversationCommandV4`（provider 就绪门禁）、`subscribeConversationV4`（getReadOnlyClient + SQLite task-index）、`onDynamicConversationFrame`（帧 fan-out emitter，packages/ui 的消费面） | **pass 16.1s**（帧 9、rows 4） |

L1/L2 默认 skip（需本机 jcode + 其自身凭据），`ACODE_JCODE_E2E=1` 开启。L2 的假件：`modelSelectionReadinessSource`（过 `getClient` 就绪门禁，`acodeAgentService.ts:3134/3151`）+ `ACODE_DATA_BASE_DIR` 指 temp（SQLite 不落真实 `~/.acode`）；**刻意省略** `accountProviderConfigSource`——注入它会发 legacy `provider/updateAccountConfig`，shim 的 dispatch 只处理 v4 方法而回 -32601，且该错误不被降级（`:1490` 原样 rethrow）会拖垮整个 createSession；省略即整条同步 early-return（`:1450`）。

**真实测试暴露并修复的两个 shim bug**（L0 脚本客户端测不出，只有真客户端栈才踩到）：

1. **`--surface desktop` 被 argv 校验拒绝**：桌面 Host 的 `applyPresentationSurfaceToCommand` 会追加 `--surface desktop`，而 `run.ts` 的 `isPresentationSurfaceSupportedInvocation` 白名单只有 `app-server`/`agent-server` → shim 立即以 `SURFACE_SCOPE_ERROR` 退出（L1 实测：进程 3 秒内 `code:1`、`terminationKind:"unexpected"`）。修复：把 `jcode-bridge` 加入白名单（spec R1 本就要求入口接受 native 形态参数）。
2. **北向被南向启动阻塞**：原 `entry.ts` 在 `spawn jcode` + ACP `initialize` **之后**才 `connection.start()`。jcode 首次拉起 daemon 需 15–60s（jcode issue #503），期间 v4 通道完全不读 stdin，客户端请求挂在缓冲区直到超时（L1 实测：`v4/capabilities/query` **180s 无响应**）。修复：`connection.start()` 提到南向启动之前，南向就绪改为 `southboundReady` promise——**只有真正需要 jcode 的命令（createSession）才 await 它**，capabilitiesQuery/subscribe 等立即应答。按 AGENTS.md「不能用超时掩盖同步问题」，这里没有把 30s 超时调大，而是消除了阻塞本身。

### A.6 共享 daemon 生命周期（真实测试实证的架构边界）

L2 跑完后本机残留一个 jcode 进程：`jcode.exe --provider auto serve`，**父进程已退出（孤儿）**，且不在 shim 的进程树内。查证为 **jcode 的设计行为，非 shim 缺陷**：

- `src/cli/acp.rs:776-786` 的 `ensure_daemon()` 调 `dispatch::spawn_server` → `spawn_server_with_executable` → **硬编码 `ServerLifetime::Shared`**（`dispatch.rs:1263`）。
- `ServerLifetime::Shared` 的定义注释（`dispatch.rs:1241-1245`）：_"The long-lived shared daemon: **survives this process** and serves later clients."_ 另有 `OwnedByThisProcess`（owner 退出即自毁，"leaves no daemon behind"），但**只有 `jcode run` headless 路径使用**（`dispatch.rs:1291`），ACP 路径无 flag/env 可切换。
- 后果：shim 的进程树终止（`spawn-jcode.ts` 的 taskkill /T 波次）**结构上够不到它**——daemon 已 setsid 脱离，不是 shim 子进程的后代。
- **不是每次泄漏一个**：`ensure_daemon` 先查 `server_is_running()`，已有则复用（实测连跑 L1+L2 后仅 1 个 daemon）。回收靠 jcode 自己的 300s idle 超时（`server.rs:672` `IDLE_TIMEOUT_SECS`，判据 `client_count == 0 && !has_live_headless_worker`，`server.rs:128-130`）。实测该 daemon 在测试结束后约 10 分钟内自行退出。
- 这正是评估文档 §3.2 与 spike §4.4 记录的「daemon 共享模型反转 ACode 独占子进程假设」那堵墙，在真实客户端栈下被实证坐实。

**已知边界（不修，登记）**：ACode 的「kill agent 即重置会话」在 jcode 后端**不成立**——kill shim 只断客户端连接，daemon 与其会话继续存活，下个 shim 会 attach 到同一个 daemon。要真正独占需 (a) jcode 上游为 ACP 路径开放 `OwnedByThisProcess`，或 (b) shim 用 `JCODE_HOME` + 独立 socket 起私有实例（但 spike §4.4 实测 `JCODE_HOME` 隔离部分失效：session 数据仍落真实 `~/.jcode/sessions/`），或 (c) ACode 侧接受共享语义并在 UI/文档明示。三者的取舍属产品决策，见「前置决策」。

### A.7 剩余未验项

1. **真桌面 UI 端到端**：L2 已覆盖到 service 层（packages/ui 的直接消费面），但 Electron renderer 消费 shim 帧仍未验证。A.8 的真实 Electron 冒烟实证：**env 覆盖通道在桌面 Host 上跑不通**（storage 准备阶段即失败），桌面接线必须走「前置决策」的 Settings/注册表通道，不能靠 env。
2. **Unix 侧行为**：三层测试全部在 Windows。Linux/macOS 上 daemon 生命周期与 socket 形态不同（Unix socket vs named pipe），须重跑。
3. **多窗口 / 多会话并发**：只验单会话单轮。结合 A.6 的共享 daemon 与 spike §4.4 的 `JCODE_HOME` 部分失效，多窗口只能靠 sessionId 逻辑隔离。
4. **长会话与 compaction**、**MCP 配置下发**、**ACode 凭据桥**：见「未做与取舍」。

### A.8 真实 Electron 客户端冒烟（受控对照，含一个决定性发现）

**客户端编译验证（全部通过）**：

| 门禁              | 命令                            | 结果                                                                                      |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| 全仓类型编译      | `pnpm typecheck`                | **32 tasks successful / 0 error**（packages + desktop-renderer + cli 三段门禁，30s）      |
| desktop main/host | `tsup`（packages/desktop）      | Build success，产出 `out/main/index.js`、`out/host/index.js`                              |
| desktop renderer  | `vite build`                    | 产出 `out/renderer/index.html` 等                                                         |
| 原生 agent bundle | `prepare-agent-node-bundle.mjs` | 产出 `apps/acode-cli/packages/cli/dist/acode.cjs`（25.9MB）+ 17 官方插件 + bundled-skills |

**真实 Electron 启动链路（`scripts/e2e-smoke.mjs`，CI desktop-smoke 门禁同款）**：隔离 profile 拉起 dev 态 Electron，CP1 进程存活 / CP2 CDP 端口 / CP3 首窗 ready / CP4 Host fork 全部 PASS。

**决定性受控对照实验**：同一 worktree、同一已构建 bundle，唯一变量是 `ACODE_AGENT_SERVER_*` env 覆盖。

| 场景                               | `unsupported_runtime` | Host storage 准备 |
| ---------------------------------- | --------------------- | ----------------- |
| 基线（有 bundle，**无** env 覆盖） | **0**                 | 成功              |
| jcode env 覆盖（有 bundle）        | **1**                 | **失败**          |

**根因（读源码确认，非猜测）**：Host 的 `prepareSessionStorage`（`packages/desktop/src/host/storagePreparationProcesses.ts:121-127`）调同一个 `resolveDefaultACodeAgentCommand`，但硬性要求返回的 command 带 `supportsStorageStartup && storagePreparationEntry`：

```ts
const command = resolveDefaultACodeAgentCommand({
  workspacePath,
  workspaceKey,
  presentationSurface: "desktop",
});
if (!command?.supportsStorageStartup || !command.storagePreparationEntry)
  throw statusError("unsupported_runtime");
```

而 `resolveDefaultACodeAgentCommand` 的 **env 覆盖分支**（`acodeAgentProcessManager.ts:611-620`）返回的 command **两个字段都不带**——只有 bundled 分支（`:627`）才 `supportsStorageStartup: true` 且 `storagePreparationEntry` 指向 `acode.cjs`。故 env 覆盖一开，Host 在 storage 准备阶段就 `unsupported_runtime` 失败，**根本没走到 spawn 会话 agent，jcode-bridge 从未被启动**。

**这次冒烟的诚实结论**：CP1–CP4 全绿与基线逐字相同，**证明不了任何关于 shim 的事**——shim 压根没被拉起。真正被验证的是"客户端能编译、Electron 启动链路正常"，以及"env 覆盖通道在桌面 Host 上不可用"这个负向事实。

**与既有治理 spec 的印证**：`packages/services/specs/agent-command-env-gate.md` R3 早已预告——「外部引擎……接入会话时若需自定义路径，走 Settings 显式配置（用户可见动作），**不恢复 env 通道**」。本实验实证了这条约束的技术原因：env 覆盖天生不带 storage 能力声明。

**修正 R1 的接线结论**：spec R1「接线（分两态）」原称非打包态可用 `ACODE_AGENT_SERVER_COMMAND` 接线——该结论对**独立 CLI / 远程 server / L1·L2 测试**（直接 new ProcessManager，不经桌面 Host 的 storage 准备）成立，但对**桌面 Host 不成立**。桌面接线只能走「前置决策」：引擎注册表加回外部槽位 + `resolveDefaultACodeAgentCommand` 为该槽位返回带 `storagePreparationEntry`（指向能跑 `--prepare-storage` 的 ACode CLI bundle，而非 jcode 二进制）的 command + Settings 显式配置。注意 storage 准备本质是 **ACode 自己的 SQLite 迁移**（`--prepare-storage` 入口，jcode 不参与），所以正确设计是让 storage 准备仍用 ACode CLI bundle、仅会话 agent 换成 jcode——这需要 `resolveDefaultACodeAgentCommand` 把「storage 入口」与「会话 spawn 命令」解耦，属注册表改造的一部分。

### A.9 打包态 bundle 形态验证（改变桌面接线设计的发现）

A.8 的结论基于"桌面接线需要解析外部 jcode 二进制"这个假设。**实测推翻了该假设**：`jcode-bridge` 是 ACode CLI 自己的子命令（`apps/acode-cli/packages/cli/src/run.ts` 的 `case "jcode-bridge"`），因此它被 esbuild 打进了 `acode.cjs`，与 `app-server` 同在一个 bundle 里。

**实测证据**（`apps/acode-cli/packages/cli/dist/acode.cjs`，25.9MB bundle）：

1. `grep -c 'jcode-bridge' acode.cjs` → **6 处命中**（子命令已打包进 bundle）。
2. 直接跑 bundle 形态：`node acode.cjs jcode-bridge --stdio --jcode-binary <不存在的路径>` → 正确输出 storage 首帧、正确尝试 spawn jcode（`telemetryOff:true`、`args:"acp --no-update --no-selfdev"`）、南向失败后**北向不死**（`southbound startup failed; commands needing jcode will fail` + 优雅收口）——证明 A.5 修的"南向启动失败不连带北向"在 bundle 形态下同样生效。
3. bundle 形态 + 真 jcode 端到端：`capabilitiesQuery` → `{"supported":false}`；`createSession` → `accepted` + `jcode-<uuid>`；`subscribe` → `snapshot` 模式 + subscriptionId；`sendText` → `accepted` + `inputAccepted` + `startNow`；帧统计 `storageState=1 snapshot=1 deltas=4`，真模型正常应答。

**对设计的三点影响**：

1. **不需要独立二进制解析**：桌面态不必在 ACode 侧解析/分发 jcode 可执行文件。`acode.cjs` 自带 `jcode-bridge` 子命令；只有 jcode 本体（`jcode` 可执行文件）需要被发现——仍走 R7 的 PATH / `--jcode-binary`，但那是 shim 进程内部的事，不进 ACode 的命令解析链。
2. **storage 与会话两条解析必须解耦（A.9 起草时误判为"不需要"，已由 R6 落地修正）**：`prepareSessionStorage` 的 Worker argv 确实硬编码 `app-server --stdio --prepare-storage`（与 `command.args` 无关），但**入口 bundle 的解析**此前耦合在 `resolveDefaultACodeAgentCommand` 的返回值上。R6 把它抽成独立的 `resolveACodeStoragePreparationEntry`（只走可信候选链、刻意不吃 env），于是 storage 入口与会话引擎选择彻底无关。见 `host-startup-storage-cwd.md` R6 与 A.10 验证。
3. **A.8 根因收窄 + env 通道在 dev 桌面复活**：`unsupported_runtime` 的唯一原因是 env 覆盖分支不声明 storage 能力字段。R6 之后 storage 不再依赖会话命令，故 **dev 态 env 覆盖通道对桌面 Host 也生效了**（A.10 实测 spawn 决策选中 `jcode-bridge --stdio --surface desktop`）。注意**打包态仍不吃 env**——那是 `agent-command-env-gate.md` R1 的安全门禁（不受 R6 影响，也不应受影响），故打包态桌面接线仍需「前置决策」的注册表 + Settings 通道。两条通道的边界：dev/独立 CLI/远程 server 走 env（R6 已修通），打包态走注册表（前置决策）。

**仍未验证**：Electron renderer 真正消费 shim 帧（需 Settings UI + 引擎选择打通后才能端到端）；打包态（`ACODE_APP_IS_PACKAGED=1`）下 `resources/glm/acode.cjs` 的 jcode-bridge 子命令是否同样在位（本 worktree 只构建了 dev 态 bundle，未跑 electron-builder 打包）。

### A.10 桌面接线机制验证（R6 修复后）

R6 落地后重跑受控对照与机制验证，两项均已固化为回归测试（`packages/services/tests/storage-entry-env-gate.test.mjs`，6/6 pass）：

1. **storage 阻断已解除（受控对照，真 Electron）**：同一已构建 bundle、同一 jcode env 覆盖，`scripts/e2e-smoke.mjs` 下 Host 日志的 `unsupported_runtime` 计数 **1 → 0**，CP1–CP4 全 PASS。Host 已越过 storage 阶段走到 provider 就绪门禁，日志为 `provider/model 尚未就绪，ACode agent 保持未启动 {"providerCount":0}` —— 这是 e2e 隔离 profile 无登录凭据的**正确行为**（原生 glm 基线同样 `providerCount=0`，故基线冒烟也从不 spawn agent），非 jcode/shim 缺陷。
2. **spawn 决策正确选中 jcode-bridge**：`resolveDefaultACodeAgentCommand({workspacePath, workspaceKey, presentationSurface:"desktop"})` 在 env 覆盖下实测返回 `command=<node>`、`args=["jcode-bridge","--stdio","--surface","desktop"]` —— 桌面 surface 追加的 `--surface desktop` 已在白名单内（`run.ts` 修复项），shim 不再被 `SURFACE_SCOPE_ERROR` 拒绝。
3. **两条解析互不干扰**（R6 的核心不变量）：同一 env 下会话命令解析采纳覆盖值，而 storage 入口解析仍只走可信候选链、绝不返回注入路径。

**桌面接线的剩余边界（如实登记）**：真实 Electron 内"spawn shim 并跑通一轮会话"还需要 Host 侧 provider 就绪（登录或配置 API key）+ 引擎选择通道。前者是 ACode 通用前提（与 jcode 无关），后者属「前置决策」的注册表/Settings 改造。当前已验证的是：R6 之后，桌面 Host 在 dev 态经 env 覆盖**能够**把会话 spawn 指向 jcode-bridge，且 storage 准备不再被它破坏。
