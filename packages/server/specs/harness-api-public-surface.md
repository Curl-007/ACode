# Harness API 公开稳定面 + TS SDK（launch/connect 双模式）（K7）

方案条目：`docs/k-series-upgrade-plan.md` §K7。协议形态参照 jcode (MIT)
`crates/jcode-harness-api`（1916 行：NDJSON 版本化帧、`API_VERSION_MAJOR/MINOR`、枚举
Unknown 兜底、socket 路径单一解析）与 `crates/jcode-sdk`（launch/connect 双模式、
结构化输出、会话级工具控制、TS/Rust parity 测试），自撰 TypeScript 实现，未拷贝任何文件。

把 ACode 引擎边界从「Desktop 私有 stdio 协议」升级出一条**对外承诺稳定**的公开面：
今天 `packages/shared/src/acode-protocol/`（v4，`ACODE_PROTOCOL_VERSION = 1`）服务
Desktop↔agent 内部通信，随产品需要自由演进、无兼容承诺；`packages/server` 的
HTTP/stdio 入口（`src/http.ts` / `src/stdio.ts` 的 `createStdioServer`）直接暴露
ServiceCollection——**内部面即公开面，一次内部重构就是一次下游破坏**。本项建立
「稳定投影层」：版本化帧协议（Harness API v1）+ TS SDK，作为第三方嵌入 ACode 引擎
的唯一受支持通道。

红线：**acode-protocol v4 零改动**（内部协议继续自由演进）；**Desktop 现有 stdio 链路
不经由新面**（自家流量不迁移——迁移是收益为零的风险）；launch 模式凭据继承**仅限
ACode 自有凭据库**（provider 包管的 OAuth/API-key 面），**明确不做** jcode 式 20+ 家
第三方 IDE 凭据拷贝（订阅借用红线，与第一轮结论一致）。

裁剪边界：只交付 NDJSON/stdio 形态（HTTP/WebSocket 投影是 `packages/server` 的后续
扩展，帧协议同构即可）；SDK 只交付 TypeScript（Rust/Python 登记不立项）；SDK 不做
自有 UI 组件（消费方自己渲染）。

---

## 背景：已核实的现状与 jcode 参照

> ACode 行号以 dev/0.0.2 `7798f76` 检出为准。

### ACode 已有面

1. **内部协议**：`packages/shared/src/acode-protocol/index.ts`（v4 帧体系，
   `ACODE_PROTOCOL_VERSION = 1` 于 `:75`；`acode-protocol-v4/` 子域含 snapshot/rows 等）；
   Desktop spawn 链（services `acodeAgentProcessManager.ts:363-398`，J5 基线核实）
   跑 `apps/acode-cli ... app-server --stdio`；
2. **服务暴露基建**：`packages/server`——`stdio.ts:56` `createStdioServer(services)`、
   `http.ts`（Hono，bearer token、host capability）；`packages/rpc` 六层框架
   （VQL→protocol→Channel→Server/Client→代理→Remote）；
3. **客户端连接层**：`packages/client`（WebSocket/Protocol/MessagePort 三连接，
   服务 web/desktop renderer）——private，无版本化承诺；
4. **进程 spawn/字节码链**：J5 L1 的 agent spawn（含 .jsc 门控）——launch 模式的进程
   管理复用该链。

### jcode 参照机制（只读提炼）

- **harness-api 刻意小于内部协议**：公开边界只暴露 UI/嵌入方需要的最小面（34 请求 +
  45 事件），内部协议 additive 变更打不坏它——**独立翻译桥**（harness-api-server）
  逐客户端拨内部 socket 做翻译，不依赖内部类型；
- **帧形态**：NDJSON（一行一 JSON），每帧带 `v`（主版本）；`API_VERSION_MAJOR=1`；
  客户端必须忽略未知字段/未知枚举值（**枚举带 Unknown 兜底**进 wire 契约）；
- **SDK 双模式**：`connect`（连共享 daemon socket/named pipe/SSH 远端 `--stdio`）与
  `launch`（建隔离 runtime 目录 + state home、只继承凭据文件、WakeMode 控制自主唤醒）；
- **SDK 面要点**：会话 create/attach/fork/rewind、`run`（阻塞取 TurnResult）、流事件
  （TextDelta 关联 id）、**会话级工具控制**（enabled/disabled + 自定义工具经回调执行）、
  权限应答、structured output（JSON schema 校验重试）、断连人话归因、TS/Rust parity 测试。

## 产品规则

### R1 版本化帧协议（shared 新 `packages/shared/src/harness-api/`）

- **传输**：NDJSON over stdio（一行一帧对象）；首帧握手 `hello` 声明
  `{ v: 1, client: string, capabilities: string[] }`，服务端回
  `{ v: 1, server, protocolMinor: n }`——**主版本不匹配即拒绝**（可读错误+建议），
  minor 差异容忍；
- **兼容铁律**（进 wire 契约文档与 SDK 测试）：
  - 消费方必须忽略未知字段；枚举解析失败一律落 `unknown` 成员**不报错**；
  - 服务端只做 additive 演进（加字段/加枚举值/加方法）；删改语义必须升主版本；
  - `HARNESS_API_VERSION_MAJOR = 1` 常量唯一出处 shared（所有实现从这 import）；
- **帧分类**：`request`（带 `id`，必回 `response{id, ok|error}`）、`event`（服务端推，
  带 `sessionId` 关联与单调 `seq`——消费方可用 seq 检测丢帧）、`error`（协议级）。

### R2 方法面 v1（最小稳定集，刻意小于内部协议）

```
会话：list_sessions / create_session / attach_session / detach_session /
      fork_session / rewind_session
驱动：send_message / cancel_turn / run（send+等待 TurnResult 的便捷合并）
事件流：subscribe_events / unsubscribe_events（TextDelta / TurnStarted / TurnDone /
      ToolCallStarted / ToolCallFinished / PermissionRequested / TokenUsage / Error）
权限：permission_respond
配置：set_model / get_models / compact
文件（嵌入场景便利面）：read_file / search_text / find_files
工具控制：configure_tools（enabled/disabled 清单 + 自定义工具注册）
```

- 每方法的入出参 schema 落 shared（zod，**独立于 acode-protocol v4 的类型**——投影层
  有自己的类型，翻译层负责映射，这是「内部演进打不坏公开面」的结构保证）；
- v1 明确**不含**：仓库级管理、多 workspace 并发编排、provider 凭据管理写操作
  （只读 get_models）——留 v2 按真实嵌入方需求 additive。

### R3 翻译桥（server 包 `packages/server/src/harness/`）

- `createHarnessApiServer({ transport, services })`：逐帧把 R2 方法翻译到既有
  ServiceCollection 调用（acodeTaskService/runtime 面经 services 既有入口——
  **不 import acode-protocol v4 类型**，经 services 层 API 而非协议类型，对齐 jcode
  「翻译桥不依赖重型内部协议」的设计）；
- stdio 形态先行：`acode-server-cli` 增 `--harness` 启动形态（或独立 bin
  `acode-harness`，实施时按 CLI 参数面整洁度定，二选一进 spec 附录）；
- **鉴权**：本地 stdio 无需 token（进程边界即信任边界）；将来 HTTP/WebSocket 投影
  强制 bearer token（复用 `http.ts` 既有鉴权中间件语义——不在本项实现面内但 schema
  预留 `auth` 握手字段）。

### R4 TS SDK（新包 `packages/harness-sdk`，**对外发布名预留** `@acode/sdk`）

```ts
// connect 模式
const client = await AcodeHarnessClient.connect({ transport: "stdio", command, args });
// launch 模式
const client = await AcodeHarnessClient.launch({
  runtimeDir?, inheritCredentials?: boolean,   // 缺省 true：只拷 ACode 凭据库
  env?, agentEnv?, wakeMode?: "internal" | "external",
});
const session = await client.createSession({ cwd, systemPrompt?, model? });
const result = await session.run("解释这个仓库的结构");   // 阻塞取 TurnResult
for await (const ev of session.events()) { ... }           // 流事件（含 seq）
session.configureTools({ disable: ["Bash"], custom: [{ name, schema, execute }] });
```

- launch 实现：spawn `acode-harness` 子进程（复用 agent spawn 链的 env/工作目录治理），
  runtime 目录缺省 `~/.acode/sdk/<uuid>/`（隔离 state home——不与 Desktop 会话库混）；
  `inheritCredentials` 只拷 `packages/provider` 凭据库的**引用/文件**（实施首日核实
  凭据存储形态：DPAPI keychain 或 credential-key.json——引用式继承优先，文件拷贝需
  走 keychain 的授权路径，**绝不绕过凭据主密钥机制**，2026-10-04 凭据分叉事故的教训）；
- 结构化输出：`session.ask(schema, prompt)`——schema 校验失败自动带错误重试（封顶 2 次）；
- 断连归因：`describeDisconnect(error)` 人话分类（进程退出/协议握手失败/主版本不匹配/…）；
- **parity 测试**：SDK 面行为 vs 翻译桥直接 NDJSON 逐方法对照（jcode TS/Rust parity
  同款方法论）。

### R5 状态所有权

| 状态                                           | 所有者                                         | 生命周期           |
| ---------------------------------------------- | ---------------------------------------------- | ------------------ |
| harness-api schema 与版本常量                  | `packages/shared/src/harness-api/`（唯一出处） | 代码               |
| 翻译桥实例                                     | server 包（per 连接）                          | 连接               |
| SDK 客户端状态（seq/订阅/pending request map） | SDK 实例                                       | 连接               |
| launch 的 runtime 目录                         | SDK launch（隔离 home）                        | 持久（消费方可清） |
| 凭据                                           | provider 体系（唯一所有者，SDK 只继承引用）    | 不变               |

不变量：翻译桥无业务状态（纯映射，逐请求无会话亲和以外的可变状态）；seq 单调由
桥保证；SDK 不提供任何绕过权限管线的「执行」捷径（PermissionRequested 必须消费方
应答或超时拒绝——超时语义 = 拒绝，fail-closed）。

## 常量

| 常量                        | 值                      | 出处 |
| --------------------------- | ----------------------- | ---- |
| `HARNESS_API_VERSION_MAJOR` | `1`                     | R1   |
| `HARNESS_API_VERSION_MINOR` | `0`（随 additive 递增） | R1   |
| `SDK_STRUCTURED_RETRY_MAX`  | `2`                     | R4   |
| `SDK_PERMISSION_TIMEOUT_MS` | `120_000`（超时=拒绝）  | R5   |

## 接口

shared：`harness-api/{index,frames,methods,events}.ts`（zod schema + 版本常量 +
Unknown 兜底解析器 `parseFrameLoose`）；server：`src/harness/{server,translate}.ts` +
CLI 入口形态；`packages/harness-sdk`（新包：client/session/launch/structured/errors）；
`apps/acode-cli`：无改动（harness 桥从 services 层取面——CLI 的 app-server 内部协议
不动）。

## 验收场景

测试：`packages/server/tests/harness-api.test.mjs` + `packages/harness-sdk/tests/*.mjs`
（真实子进程端到端 + 桩件单测）。

1. **握手**：主版本不符 → 可读拒绝；未知 capabilities 忽略；minor 高于服务端 → 容忍；
2. **Unknown 兜底**：注入未知枚举值的事件帧 → SDK 收到 `kind: "unknown"` 不抛；
   未知字段剥离保留（round-trip 断言）；
3. **方法面逐个**：R2 全部方法经 SDK 真实子进程往返（list 空→create→send→事件流→
   TurnResult→rewind→fork）；`run` 与 send+事件等待结果一致（parity）；
4. **seq 丢帧检测**：桥注入丢帧 → SDK `onGap` 回调（测试钩子）；
5. **权限 fail-closed**：PermissionRequested 无应答超时 → turn 拒绝而非挂死；
   应答 allow → 继续；
6. **configure_tools**：disable 生效（工具面不含被禁项）；自定义工具经回调执行且
   结果回传引擎（ToolCall 事件往返）；
7. **launch 隔离**：runtime 目录独立（不污染 Desktop 会话库——两库文件集断言分离）；
   inheritCredentials 走授权路径（keychain 在场时零明文文件拷贝断言）；
8. **structured**：schema 违例 → 重试带错误反馈 → 第 2 次合法 → 返回；连续违例 →
   结构化失败错误（含两次原始输出摘要）；
9. **断连归因**：kill 子进程/握手中断/版本不符三类 → `describeDisconnect` 三种人话；
10. **红线**：acode-protocol v4 源码零 diff；Desktop stdio 链路测试全绿（零回归钉住）；
    翻译桥源码对 acode-protocol import 零命中（源码断言）。

## 未做与取舍

1. **不做 HTTP/WS 投影**：帧协议同构，`http.ts` 侧后续 additive（本项 schema 预留
   auth 字段已够）；
2. **不做 SSH 远端 connect**：jcode `connect_ssh` 复用系统 ssh——ACode 的远程形态是
   acode-server-cli/远程 workspace（AGENTS.md 远程章），SDK connect 指向远端
   `acode-harness --stdio` 即等价（消费方自己套 ssh），SDK 不内置 ssh 管理；
3. **Rust/Python SDK**：登记不立项（jcode 的双语言 parity 教训已吸收为 SDK-vs-桥
   parity 测试形态，语言扩展等需求）；
4. **第三方 IDE 凭据拷贝**：红线不做（总纲合规声明）；jcode `sdk/launch.rs` 的
   inherit 清单仅作情报。

## 第三方归属

协议形态（版本化 NDJSON/Unknown 兜底/翻译桥独立于内部协议/双模式 SDK/parity 测试
方法论）参照 jcode (MIT) harness-api 与 sdk crate，自撰 TypeScript 实现；
wire schema 与方法面按 ACode services 层 API 重新设计。
