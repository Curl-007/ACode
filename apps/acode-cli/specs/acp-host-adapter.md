# ACP 宿主适配：IDE 经 Agent Client Protocol 嵌入 ACode（K8）

方案条目：`docs/k-series-upgrade-plan.md` §K8。适配层组织参照 jcode (MIT) `src/cli/acp.rs`
（2201 行：ACP 消息到内部 session 的桥接、provider/model 配置面、usage 上报），自撰
TypeScript 实现，未拷贝任何文件。ACP 上游规范（Agent Client Protocol，JSON-RPC over
stdio，Zed 主导）按其公开文档实现，不引入其代码。

让外部 IDE/编辑器（Zed、其他 ACP client）把 ACode 当作内嵌 agent 使用：新增
`acode acp` 入口进程，在 stdio 上讲 ACP，内部经 **K7 harness API**（前置依赖）驱动
引擎——ACP client ↔ acp 适配进程 ↔ harness SDK ↔ 翻译桥 ↔ services。

红线：**K7 未合入前本项不开工**（翻译目标必须先稳定——总纲依赖关系）；acode-protocol
v4 / Desktop / Web 零改动（ACP 是旁路入口，不动内部面）；凭据/权限语义完全继承
harness 面（无 ACP 特权路径）。

裁剪边界：只实现 ACP 的 agent 侧核心面（会话生命周期 + 提示 + 流更新 + 权限），不做
ACP 全特性对齐（编辑器侧 LSP/补全类能力不属 agent 协议）；不做 ACP 版本前瞻（跟随
已发布稳定版规范，规范演进走 additive 适配）；无 UI（适配进程是 headless 桥）。

---

## 背景：已核实的现状

1. **全仓无 ACP 面**（`agent-client-protocol|@zed` 零命中，已核实）——净新增；
2. **K7 harness 面**（前置）：create/attach/fork session、send + 事件流、
   permission_respond、configure_tools、get_models——ACP 需要的引擎能力 K7 v1 已
   覆盖（见映射表）；
3. **CLI 入口体系**：`apps/acode-cli` 的 CLI 子命令面（`cli/src/`）已有 provider-doctor
   等子命令先例——`acp` 子命令同型落位；
4. **jcode 参照要点**（acp.rs 组织法，只读提炼）：per-session 状态机管理多 ACP 会话 ↔
   内部 session 映射；流式 assistant 更新（text/diff 两种 ACP 形态）映射内部 delta；
   权限请求双向桥（ACP 的 permission request ↔ 内部 PermissionRequested）；模型/配置
   面对齐；usage 上报映射。

## 产品规则

### R1 进程与协议形态

- 入口：`acode acp`（CLI 子命令）——headless 进程，stdio 上跑 ACP（JSON-RPC 2.0，
  LSP 风格：`Content-Length` 头分帧或 ACP 规范现行分帧——按规范现行版实现，规范分帧
  形态实施首日核对）；
- 内部通道：进程内直接实例化 K7 harness 桥（同进程直连 services——不绕道子进程）。
  原设想的 `AcodeHarnessClient.connectInProcess(services)` 经实施核查不宜落进
  harness-sdk（services 层在 server 包），实际走 **适配层直接消费
  `createHarnessApiServer` 的 in-process 形态**（内存 loopback 传输）——决策记录与
  import 面修正见附录 A.1；
- **单进程多会话**：ACP 协议允许 client 开多个 session；适配层维护
  `Map<acpSessionId, harnessSession>`，各自独立事件流转发。

### R2 消息映射表（核心契约）

| ACP（client ↔ 适配层） | harness API（适配层 ↔ 引擎） |
| --- | --- |
| `initialize` | 进程内握手（版本/能力声明；无引擎调用） |
| `session/new`（prompt/cwd/systemPrompt…） | `create_session`（schema 字段映射；ACP 的 cwd 合法性校验后透传） |
| `session/prompt` | `send_message` + 订阅该 session 事件流 |
| `session/update`（notification，agent→client） | harness 事件翻译：`TextDelta`→`agent_message_chunk`；`ToolCallStarted/Finished`→`tool_call` 更新组；`PermissionRequested`→`session/request_permission` |
| `session/request_permission`（双向请求） | `PermissionRequested` 透传（选项映射：ACP 的 allow/reject 选项集 ↔ 引擎权限档位；**映射不到的档位按更严侧折叠**） |
| `session/cancel` | `cancel_turn` |
| `fs/read` 等（可选） | 缺省不开（`initialize` 能力声明不含 fs——client 自管文件；将来开走 harness read_file） |
| 模型选择（ACP 配置面） | `get_models` / `set_model` |

- **流形态**：ACP 的 agent 输出有 `agent_message_chunk`（append/replace 语义）——
  harness `TextDelta` 映射 append；**replace 语义（TextReplace 类）** 若 K7 v1 事件
  无对应，适配层缓冲重建（每 turn 首个 delta 前 reset 标记）——不反向要求 K7 加事件
  （适配层的职责就是吸收两端语义差）；
- **错误映射**：引擎错误 → ACP 的 JSON-RPC error（code 用 ACP 规范保留段 + data 带
  人话；未知引擎错误归 `internal` 不透内部栈）。

### R3 权限与安全

- 权限请求**永不自动 allow**：ACP client 不支持权限交互的场景（无人值守 IDE 脚本）
  → 权限请求按 reject 处理（K7 R5 的 fail-closed 超时语义一致）；
- 工具面裁剪：ACP 会话默认 `configure_tools` 禁用 UI 交互类工具
  （`AskUserQuestion` 类——IDE client 无 ACode UI 面承载；留 harness 事件通道的照常）；
- 凭据：进程内 services 自带 provider 凭据解析（与 CLI 同源），无 ACP 特权；
  **适配层不处理、不转发、不存储任何凭据内容**（源码断言）；
- cwd 边界：`session/new` 的 cwd 超出允许范围（按既有 workspace 治理）→ 创建拒绝。

### R4 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| ACP JSON-RPC 帧收发 | 适配进程 stdio 循环 | 进程 |
| acpSession↔harnessSession 映射 | 适配层内存 map | 进程 |
| 会话/turn 真实状态 | 引擎（services，经 harness 桥） | 不变 |
| 事件流缓冲（replace 语义） | 适配层 per-session | 会话 |

不变量：适配层无持久状态（重启即新映射，引擎侧会话可经 `list_sessions` 重新 attach
——attach 恢复是 K7 面）；映射表是唯一会话关联事实源；单向数据流（ACP 帧→harness
调用→事件→ACP 通知），无绕过 harness 的第二条引擎访问路径（源码断言：适配层只
import harness SDK 面）。

## 常量

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `ACP_MAX_CONCURRENT_SESSIONS` | `8` | R1（IDE 场景足够，防失控） |
| `ACP_UNKNOWN_ERROR_CODE` | `-32603`（JSON-RPC internal） | R2 |
| `ACP_SESSION_BUSY` | `-32052`（自用段，F9 改码；原 -32001） | 附录 A.4 |
| `ACP_LINE_TOO_LONG` | `-32053`（自用段，F4 新增） | 附录 A.4 |
| `ACP_PROMPT_TIMEOUT_MS` | `600000`（镜像 K7 `RUN_DEFAULT_TIMEOUT_MS` 量级，F3） | 附录 A.4 |

## 接口

`apps/acode-cli/packages/cli/src/acp-command.ts`（子命令入口）+
`apps/acode-cli/packages/cli/src/acp/{protocol,mapping,session-registry}.ts`
（帧循环/映射表/会话映射）；依赖 `@acode/harness-sdk`（K7 包的 in-process 构造）。
**不新增 shared/contracts 类型**（ACP 类型在适配层内部定义——不进公开契约，规范
跟随时只动适配层）。

## 验收场景

测试：`apps/acode-cli/tests/acp-host-adapter.test.mjs`（ACP client 桩 + in-process
harness 桩双向断言）。

1. 握手：initialize 能力声明正确（含/不含 fs 两形态钉住）；非 ACP 输入 → 协议错误
   不崩进程；
2. 会话生命周期：new→prompt→（流 chunk 序列：首块 reset、append 链）→update 通知
   顺序符合 ACP 规范；多会话并行互不串流（双 session 交错 delta 断言）；
3. 工具事件：ToolCallStarted/Finished 映射的 update 结构完整；
4. 权限桥：引擎 PermissionRequested → ACP request_permission 选项正确折叠；allow →
   引擎继续；reject → 拒绝回执；**无响应 → 按超时拒绝**（fail-closed 钉住）；
5. cancel：prompt 进行中 cancel → 引擎 cancel_turn → 会话可继续新 prompt；
6. 错误映射：引擎内部错误 → JSON-RPC internal + 人话 data，无内部栈泄漏；
   cwd 越界 → 创建拒绝；
7. 工具裁剪：ACP 会话工具面不含 AskUserQuestion 类（configure_tools 调用断言）；
8. **边界红线**：适配层源码对 services/runtime 内部模块 import 零命中（只 import
   harness SDK）；Desktop/Web/acode-protocol 零 diff；
9. 上游规范符合性：以 ACP 官方 schema（若可取）对握手与 update 帧做结构校验；
   不可得时按规范文档快照手工断言（附录记版本）。

## 未做与取舍

1. **不做 fs/read-write 承载**：ACP client（编辑器）自管文件系统；开了反而绕过
   ACode 的 workspace 治理——将来若有 headless client 需求再评估；
2. **不做 ACP 规范前瞻/实验特性**：跟随稳定版；实验面等规范稳定 additive；
3. **不做 Zed 特调**：ACP 的意义就是协议中立；Zed 实测是验收手段（人工项）不是
   代码依赖；
4. **ACP 规范版本锁定**：实施首日取规范现行稳定版快照进 spec 附录（URL+日期），
   升级规范=独立小项走 spec 修订。

## 第三方归属

适配层组织法参照 jcode (MIT) `src/cli/acp.rs`（多会话状态机/流映射/权限双向桥的
问题分解），ACP 规范为公开标准按文档实现；无代码拷贝。

---

## 附录 A：实施决策记录（K8 实施首日）

### A.1 in-process 构造选择

spec R1 原文设想的 `AcodeHarnessClient.connectInProcess(services)` 未在 K7 落地，
且经核查**不宜**加进 harness-sdk：

1. `AcodeHarnessClient`/`HarnessConnection`（K7 已提交代码）与子进程 stdio 强耦合
   （私有构造器持有 `ChildProcessWithoutNullStreams`，握手依赖 pause/attach/resume），
   in-process 化需要重构 K7 连接层本体，超出「最小面新增」；
2. services 层位于 `@acode/services`（server 包的依赖），harness-sdk 依赖它会让
   SDK 失去独立发布形态（对外预留 `@acode/sdk`）。

**实际选择（本附录登记，覆盖 R1 的构造路径描述）**：适配层直接消费 server 包的
in-process 形态——`createHarnessApiServer`（`@acode/server/harness` 公开导出）挂在
**内存 loopback 传输**上（同进程直连 services，不绕道子进程，满足 R1 的语义要求）；
适配层自带一条薄客户端链路（hello 握手 + request 关联 + 事件扇出，全部讲 K7 的
NDJSON 帧协议）。R4/验收 8 的 import 断言相应落地为：适配层源码只 import
`@acode/harness-sdk`、`@acode/server/harness`、`@acode/server/harness-inprocess`、
`@acode/shared/harness-api`（K7 协议类型）与 node 内建模块；零 services/runtime
内部模块。fail-closed 权限语义复用 harness-sdk 的 `pickDenyOption` 与
`SDK_PERMISSION_TIMEOUT_MS`（单一出处）。

配套最小新增：`packages/server` 新增 `src/harness-inprocess.ts`（不碰
`src/harness/**` 本体）——把「懒构造 services + 退出回收」封装成 server 公开面
（`@acode/server/harness-inprocess`），避免适配层直接 import `@acode/services`。

### A.2 ACP 规范快照（实施首日取，版本锁定）

来源（2026-10-04 抓取）：

- 仓库：`github.com/zed-industries/agent-client-protocol`（README 明示
  **"The current stable ACP protocol version is `1`"**；v2 为 `2.0.0-alpha` 前瞻，
  本实现不跟随）；
- schema：`schema/v1/schema.json`（schema 产物版本 1.24.1，2026-09-30）+ `meta.json`；
- 文档：`agentclientprotocol.com/protocol/v1/*.md`（站点对 LLM 暴露 `.md` 原文）。

关键形态钉住：

1. **分帧**：stdio 上 NDJSON——一行一条 JSON-RPC 2.0 消息（UTF-8，消息内不得含
   换行）；stderr 仅日志；stdout 不得输出非 ACP 消息（transports.md 原文）。
   **不是** LSP 的 `Content-Length` 分帧；
2. **initialize**（client→agent 请求）：params `{protocolVersion, clientCapabilities?,
   clientInfo?}` → result `{protocolVersion, agentCapabilities, authMethods: [],
   agentInfo}`；版本协商：agent 支持即回显，否则回自己最新版（=1）；
   fs 读写是 **client 能力**（agent→client 请求 `fs/read_text_file` 等）——本适配层
   不发这类请求，等价于「fs 不开」（R2 表最后一行的现行语义）；
3. **session/new**：params `{cwd(绝对路径,必填), mcpServers(必填数组),
   additionalDirectories?}` → result `{sessionId, modes?, configOptions?}`。
   注：v1 稳定版 **没有** `prompt`/`systemPrompt` 入参（映射表按现行规范执行）；
4. **session/prompt**：params `{sessionId, prompt: ContentBlock[]}` →
   result `{stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled}`；
5. **session/update**（agent→client 通知）：`{sessionId, update:{sessionUpdate…}}`，
   v1 稳定变体集：`user_message_chunk`/`agent_message_chunk`/`agent_thought_chunk`/
   `tool_call`/`tool_call_update`/`plan`/`available_commands_update`/
   `current_mode_update`/`config_option_update`/`session_info_update`/`usage_update`。
   chunk 为 append 语义，`messageId` 变更表示新消息（无显式 replace 指令）；
6. **session/request_permission**（agent→client 请求）：params `{sessionId,
   toolCall: ToolCallUpdate, options:[{optionId, kind, name, description?}]}` →
   result `{outcome:{outcome:"selected",optionId}|{outcome:"cancelled"}}`；
   `PermissionOptionKind` 仅四值：`allow_once`/`allow_always`/`reject_once`/
   `reject_always`；
7. **session/cancel**（通知）：`{sessionId}`；取消时 client 必须以 `cancelled`
   outcome 应答在途权限请求；`$/cancel_request`（通知）为 JSON-RPC 层取消
   （`-32800`）；
8. **错误码**：JSON-RPC 保留段 `-32700/-32600/-32601/-32602/-32603` + ACP 保留段
   `-32000..-32099`（已用：`-32000` 需鉴权、`-32800` 取消、`-32002` 资源不存在）。

### A.3 映射落点（R2 表按 A.2 快照的具体化）

| 决策点 | 落点 |
| --- | --- |
| `session/new.cwd` 校验 | 必须绝对路径，且解析后等于或位于适配进程启动 cwd（workspace 边界）之内；越界 → `-32602` 拒绝创建 |
| `session/new.mcpServers` | harness v1 无 MCP 面：静默丢弃（非空时 stderr 记录）；harness 落地 MCP 面后 additive 透传 |
| ACP sessionId | 直接复用 harness sessionId（opaque），映射表仍是唯一关联事实源 |
| 工具裁剪 | K7 `configure_tools` 为 not_supported（翻译桥如实降级）——按本附录替代路径用 `create_session.toolDenylist` 禁 `AskUserQuestion`、`Open`（`sideEffectScope:"userInteraction"` 的两个 UI 交互工具） |
| 流 reset 标记 | 每 turn 递增会话内计数器，ACP 出向 `messageId = "acp-" + turnCounter + "-" + harnessMessageId`——turn 边界即隐式 reset，吸收引擎重发/替换语义，不反向要求 K7 加事件 |
| `tool_call_started` | `tool_call` 更新（status `in_progress`，kind 按工具名分类，title=description‖toolName） |
| `tool_call_finished` | `tool_call_update` 更新（status `completed`/`failed` + 文本 content） |
| `permission_requested` | 先发 `tool_call`（status `pending`，未播报过的 toolCallId）再发 `session/request_permission` |
| 权限档位折叠 | 引擎 kind 精确命中四枚举则保留；含 deny/reject/block 语义词 → `reject_once`；其余（allow 族未知档位）→ `allow_once`——**家族内取更严侧**（绝不折叠出 `allow_always`）。client 应答的 optionId 经双向映射还原引擎 optionId，还原失败按 deny 处理 |
| 无响应权限 | 复用 harness-sdk `SDK_PERMISSION_TIMEOUT_MS`（120s，测试可注入）：超时自动回执引擎 deny 选项（fail-closed），迟到应答忽略 |
| 模型选择 | `session/new` 返回 `configOptions:[{id:"acode.model", type:"select"}]`（值 `providerId/modelId`，源自 `get_models` best-effort）；`session/set_config_option(configId="acode.model")` → `set_model` |
| turn 错误 | `turn_done(resultType=error)` → prompt 请求回 JSON-RPC `-32603`（data 带 engine 人话 message，无栈）；cancelled → `stopReason:"cancelled"`；success → `"end_turn"` |
| prompt 内容 | 只声明 text 能力（image/audio/embeddedContext=false）；`text` 块按行拼接，`resource_link` 降级为 `name: uri` 文本行；其余块类型 → `-32602` |
| 引擎错误码 | `invalid_params`→`-32602`、`unknown_method`→`-32601`、其余（not_supported/unavailable/run_timeout/internal_error…）→`-32603`（data.reason 保留段位语义，message 人话化，不透内部栈） |
| 未实现 ACP 方法 | `session/load`/`session/set_mode`/`session/list`/… → `-32601`（能力未声明即不存在） |

### A.4 K8 对抗复核修复记录（F1-F11，2026-10-04）

对首批实现做对抗复核后落地的精确修复（测试见 `acp-host-adapter.test.mjs` 的
「K8 对抗复核回归（F1-F8/F11）」组）：

| 编号 | 缺陷 | 修复落点 |
| --- | --- | --- |
| F1（P1） | `requiresProviderRuntime` 白名单缺 `acp` → `acode acp` 第一道检查即 throw（入口断裂） | `provider-runtime-env.ts` 白名单加 `acp` |
| F2 | `settlePrompt` 无归属过滤，任意 `turn_done` 都释放 busy 锁 | 对齐 K7 H1：prompt 预分配 `acp-prompt-<uuid>` 随 `send_message` 下发；终态只接受 inputId 匹配 / turnId∈owned / 退化路径「prompt 后 TurnStarted→TurnDone 完整对」 |
| F3 | pendingPrompt 无超时；`subscribe_events` 失败返回哑会话；cancel 不清计时器 | `ACP_PROMPT_TIMEOUT_MS`（超时回 `-32603`+释放锁）；订阅失败→`session/new` 直接失败并回收；cancel 成功即以 `cancelled` 收口 |
| F4 | ACP stdin 行长无上限（OOM 面） | `createStreamLineSource` 接入 `HARNESS_MAX_LINE_LENGTH`（`@acode/shared/harness-api` 单一出处），超限回 `line_too_long` 语义错误（`-32053`）后断链 |
| F5 | console 边界安装时机晚于 run/bootstrap 求值 | `main.ts` 的边界条件加 `isAcpInvocation(argv)`（import run 前安装）；`acp-command.ts` 内安装保留为幂等兜底 |
| F6 | 会话零回收 + create 前 check-then-set 竞态 | 硬检查移到 `create_session` 成功后原子登记（并发恰一过，未登记者 detach 后拒绝）；注册表加 `closeSession`（unsubscribe + detach best-effort + map 删除） |
| F7 | loopback 单侧死亡静默 | `request()` 在 `readEnded` 时立即 reject（可读错误）；`sendFrame` 记 warn 不静默；transport dispose 经 `link.onClose` 回调面触发适配层 `failPendingPrompts` |
| F8 | 两份 `node-forge.d.ts` 可能漂移 | 测试加 declare 块逐字一致断言（漂移即红） |
| F9 | `-32001` 占用上游保留段低段有撞位风险 | 自用段改码：`ACP_SESSION_BUSY=-32052`、`ACP_LINE_TOO_LONG=-32053` |
| F11 | prompt 预递增与 `turn_started` 递增并存，重复帧二次递增 | `turn_started` 按 turnId 幂等计数（同 turn 已计数则跳过） |

**上游缺口登记（不在本批实现）**：

1. **ACP v1 无 session destroy 方法**（F6 关联）：client 无法主动释放会话名额，
   超限错误文案已改为可行动（复用既有 session 或重启适配进程）；
   `$ /cancel_request` 语义只覆盖在途请求。上游落 destroy 或复用取消语义时在
   `session-registry.ts` 的 `#sessionLimitMessage()` 附近接入。
2. **harness `send_message` wire 面暂无 `inputId` 字段**（F2 关联）：适配层已随
   `send_message` 下发 `inputId`（当前被 K7 H2 兼容剥离未知字段，无害），引擎
   TurnStarted/TurnDone 回显 inputId 的主路径待上游 additive 放开后自动生效；
   退化路径（prompt 后完整对）先行兜底。
3. **`ACP_PROMPT_TIMEOUT_MS` 镜像 K7 私有常量**：`RUN_DEFAULT_TIMEOUT_MS` 未从
   `@acode/server/harness` 公开导出，本层镜像 10min 并注释来源；上游公开后改为
   import 单一出处。
4. **低危项 F10/F12/F13/F14**：按复核处置登记为后续小修、本批不实现：
   - **F10（deny 族折叠显示语义宽于执行）**：引擎 `reject_*_always`/`block` 等折叠
     显示为 `reject_once`，但回译回执的是引擎**原 optionId**——client 按「仅本次拒绝」
     呈现，引擎可能执行会话级/永久拒绝。「家族内更严侧」声明只在 allow 族成立；
     属 R2 折叠语义缺口，修复需在映射层收敛 deny 族回执文案。
   - **F12（权限收口残留与集合无界增长）**：权限被 deny/cancel 后前置播报的
     `tool_call` 永停 pending（无 tool_call_update 收口）；`announcedToolCallIds`
     无 turn 级清理，随会话生命期无界增长。
   - **F13（cwd 边界不解析符号链接）**：`resolve`+`relative` 字符串前缀判定，
     root 内指向 root 外的 symlink 可让引擎写越界；与既有 CLI cwd 治理同水位
     （非本项新弱化），realpath 化应与全局 cwd 治理一并进行。
   - **F14（零凭据断言证据链弱）**：源码断言为词法 grep；`env: process.env`
     整包传入 services 是设计内路径，断言不能证明数据流层面无凭据接触——
     如需强证据需引入数据流级审查。
