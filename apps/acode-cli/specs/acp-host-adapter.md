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
- 内部通道：进程内直接实例化 K7 harness 桥（同进程直连 services——不绕道子进程，
  `AcodeHarnessClient` 的 in-process 形态；K7 SDK 需提供 `connectInProcess(services)`
  便捷构造——已列入 K7 R4 的实施自由度）；
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
