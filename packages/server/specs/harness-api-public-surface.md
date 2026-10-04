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
6. **configure_tools**：v1 按附录 A 映射表返回 `not_supported`（services 层无 create 后
   的会话级动态工具配置面，也无自定义工具注册回调）；工具控制经
   `create_session.toolDenylist`（创建时禁用清单）表达；自定义工具回调属 v2 additive
   落地后解除。**修订说明（K7 对抗复核 M5）**：原场景 6 描述的「disable 生效 + 自定义
   工具回调往返」与附录 A 映射表矛盾——v1 契约以附录 A 为准，spec 修订而非改实现；
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

---

## 实施附录（K7 落地登记，2026-10-04）

### A. services 层方法面映射表（翻译桥逐方法）

| Harness 方法                          | services 层入口                                                                                                                                  | 结论                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list_sessions                         | `IACodeAgentService.listSessions`                                                                                                                | 直译                                                                                                                                                                                   |
| create_session                        | `IACodeAgentService.createSession`（mode/model/toolDenylist 透传）                                                                               | 直译；`systemPrompt` 入参 services 层 createSession 无对应 → 提供时返回 not_supported                                                                                                  |
| attach_session                        | `IACodeAgentService.resumeSession`                                                                                                               | 直译                                                                                                                                                                                   |
| detach_session                        | `IACodeTaskService.releaseWorkspacePreparation`                                                                                                  | 直译（detach=放手：绝不 closeSession——那会终止会话本体）                                                                                                                               |
| fork_session                          | `IACodeAgentService.createSession({ parentSessionId })`                                                                                          | 直译                                                                                                                                                                                   |
| rewind_session                        | —                                                                                                                                                | **not_supported**：services 层无会话级 rewind API（仅 CLI 内建 `/rewind` 命令与 v4 文件 rewind 预览）；schema 预留 target，待 services additive                                        |
| send_message                          | `IACodeAgentService.sendPrompt`（服务层既有入口；v4 sendText 收敛路径仍由 services 内部承担）                                                    | 直译                                                                                                                                                                                   |
| cancel_turn                           | `IACodeTaskService.stopGeneration`（taskId ≡ sessionId）                                                                                         | 直译                                                                                                                                                                                   |
| run                                   | `sendPrompt`（预分配 `harness-run-<uuid>` inputId 随 send 下发，引擎 TurnStarted/TurnComplete payload 回显——K7 复核 H1 归属依据）+ `onDynamicSessionEvent` 订阅窗口等**本 run turn** 的终态；引擎不回显 inputId 时退化只认「订阅后 TurnStarted→TurnDone 完整对」；不轮询 readSessionEvents——afterSeq=0 起扫会命中历史 turn 终态 | 组合翻译                                                                                                                                                                               |
| subscribe_events / unsubscribe_events | `IACodeAgentService.onDynamicSessionEvent`（deliveryKind=desktop-continuous；桥持连接作用域订阅登记 + 单调 seq）                                 | 直译                                                                                                                                                                                   |
| permission_respond                    | `IACodeTaskService.respondPermission`（taskId ≡ sessionId；服务层 response 字段在 v4 resolveInteraction 路径不被消费，决策由 optionId 完整承载） | 直译                                                                                                                                                                                   |
| set_model                             | `IACodeAgentService.setModel`                                                                                                                    | 直译                                                                                                                                                                                   |
| get_models                            | `IModelSelectionService.getView`（只读；不含凭据管理写操作）                                                                                     | 直译                                                                                                                                                                                   |
| compact                               | `IACodeAgentService.compactSession`                                                                                                              | 直译                                                                                                                                                                                   |
| read_file                             | `IFileService.readTextFile`                                                                                                                      | 直译                                                                                                                                                                                   |
| search_text                           | —                                                                                                                                                | **not_supported**：IFileService 只有文件名搜索（searchWorkspaceFiles），内容 grep 在 agent 工具面不在 services 层                                                                      |
| find_files                            | `IFileService.searchWorkspaceFiles`                                                                                                              | 直译                                                                                                                                                                                   |
| configure_tools                       | —                                                                                                                                                | **not_supported**：services 层工具控制是 create/resume/send 时点的 toolAllowlist/toolDenylist 参数，无 create 后动态配置面与自定义工具注册回调；可用替代 `create_session.toolDenylist` |

事件面映射：`turn.started→turn_started`、`turn.completed/failed→turn_done`（终态
resultType 归一 success/cancelled/error）+ `token_usage`、`part.delta(field=text)→text_delta`、
`tool.updated(started|result|error)→tool_call_started/finished`、
`permission.requested→permission_requested`（session 帧与 typed 帧双发按 requestId 去重）；
其余内部事件（message.upserted/session.\* 等）不在 v1 公开面，桥侧丢弃。

### B. CLI 入口选择：独立 bin `acode-harness`（spec R3 二选一裁决）

`packages/server/src/entry-harness.ts` + package.json bin + tsup entry。
理由：`acode-server-cli` 是 supervisor 守护进程命令面（serve/status/stop/restart/
update/uninstall + data-root 锁/OS service 注册/更新事务），在其上挂 `--harness`
stdio 直连形态会绕过锁与 Supervisor 生命周期治理；独立 bin 与 stdio/http entry
同层级，services 懒构造（握手/版本拒绝路径零服务面初始化）。

### C. 凭据继承实现结论（R4 launch）

凭据存储形态（实施核实，`packages/shared/src/node/credentialMasterKey.ts`）：
密文 `{dataBaseDir}/.acode/v2/credentials.json`（enc:v2 全加密，磁盘无明文）；
主密钥解析优先级 = OS 钥匙串（macOS Keychain / Windows DPAPI blob 文件
`credential-key.dpapi.json` / Linux libsecret）→ `credential-key.json` → env。

- **引用式继承不可实现**：凭据目录没有独立 env（随 ACODE_DATA_BASE_DIR 整体
  .acode 隔离），无「指向原库」的机制。
- **采用的继承 = 加密文件成对字节拷贝**：credentials.json + 随行密钥材料
  （credential-key.json 与/或 credential-key.dpapi.json）一起拷入 runtime 目录
  （0600 语义、零解密零明文、写 sdk-credential-inheritance.json 溯源标记）——
  与既有 `copyDataDirectory` 迁移同安全语义，不绕过主密钥（子进程走同一解析链）。
- **钥匙串模式 fail**：credentials.json 存在而密钥材料文件不在场（macOS Keychain /
  Linux libsecret 持有材料）时，返回 `{ status: "failed" }` 并说明原因——绝不拷明文、
  绕钥匙串。消费方可选 `inheritCredentials:false` 或在隔离 runtime 内重新登录。
  **K7 复核 M7 例外**：`ACODE_CREDENTIAL_SECRET` env 模式（主密钥解析第 4 级来源）
  不是「钥匙串持有」——env 随 launch 传子进程，凭据可继承（只拷密文 credentials.json，
  无需随行密钥材料，仍然零解密零明文）；launch() 对 `failed` 状态直接抛
  `HarnessLaunchError`（fail 并报告，不再静默继续到首次调用才炸）。
- 第三方 IDE 凭据：红线不碰（jcode inherit 清单仅作情报）。

### D. 实施期修复的真实缺陷

- SDK `prepareLaunchRuntime` 凭据源目录曾用 `node:os homedir()`——Windows 上它只认
  USERPROFILE、忽略 HOME 覆盖，launch 隔离测试（及任何设 HOME 的宿主）会**静默读到
  真实用户凭据库**并拷进 runtime。已修复为镜像 services 层 `getDataBaseDir` 解析链
  `ACODE_DATA_BASE_DIR → HOME → homedir()`（launch 隔离测试的「主库文件集不变」断言
  抓住该缺陷）。
- K7 对抗复核缺陷（2026-10-04 第二轮，修复清单）：
  - H1 `runAndWaitTurn` 终态归属：只认本 run 的 turn（inputId 回显主路径 + 订阅后
    TurnStarted→TurnDone 完整对的退化路径），在途旧 turn 终态不再被冒领；
  - H2 翻译桥入参接入 `harnessMethodParamsSchemas`（shared 映射表）safeParse，
    失败回 `invalid_params`（含字段路径）；`String(undefined)` 变形透传全部移除
    （send 缺 content / fork 缺 sessionId / limit 越界三实证形态全部拦截）；
  - M1 NDJSON 跨 chunk 多字节 UTF-8：transport/connection 三处 `chunk.toString("utf8")`
    改 `StringDecoder`（中文核心场景）；
  - M2 `session.send()` 补订阅（send-only 权限事件必达、fail-closed 计时器起表）；
  - M3 SDK 双重泄漏：session 连接级监听器可回收（`session.close()`/`client.close()`
    统一清理），events() 队列条目真移除；
  - M4 单行上限 4 MiB（`HARNESS_MAX_LINE_LENGTH`，shared 单一出处；超限 error 帧
    line_too_long + 断连 / SDK `frame-too-large` 断连归因）与 writeLine 写背压
    （write() false → 暂停输入泵，drain 恢复）；
  - M7 launch 凭据继承 failed 抛 `HarnessLaunchError`；env 主密钥模式归因修正；
  - M8 `describeZodSchema` 标量/枚举/optional 识别（ask requirement 不再全 any）；
  - L1 `ACODE_HARNESS_COMMAND_JSON`（JSON 数组形态，支持含空格路径；旧格式兼容）；
  - L2 `pickDenyOption` 显式 deny/reject 匹配（optionId/kind/name，词边界），
    兜底末项的契约假设已注释登记。

### D2. 已知限制（K7 对抗复核 Low 级，登记不实现）

- **L3 run 超时不回收引擎 turn**：`run_timeout` 抛出时 turn 可能仍在引擎执行，
  桥不自动 cancel_turn（消费方自行决定；自动取消会误伤并发 turn）。
- **L4 permission_respond 中性 decision**：services 层 respondPermission 的 response
  字段在 v4 resolveInteraction 收敛路径不被消费，桥传中性 `{decision:"allow"}`
  仅满足入参 schema，决策完全由 optionId 承载。
- **L5 permission 去重集上限**：桥侧 seenPermissionRequestIds 超过 256 清空重建，
  极端场景可能多发一条重复 permission_requested（消费方应答幂等，最坏影响可控）。
- **L6 send_message 不回传 turnId**：sendPrompt 的返回面（ACodeSessionSendResult）
  不含 turnId/inputId，send-only 消费方只能从事件流拿归属（run 路径已有 inputId）。
- **L7 行上限按解码字符计**：`HARNESS_MAX_LINE_LENGTH` 以解码后 UTF-16 字符数近似
  字节（非精确字节数），边界值有 ≤4 字节误差——防 OOM 语义不受影响。
- **L8 同会话并发 run 的退化归属不区分**：引擎不回显 inputId 的退化路径下，
  同会话并发第三方 turn 的终态可能被先到者误收（v1 串行假设，inputId 主路径不受影响）。

### E. 测试与验证真实结果（2026-10-04 复核修复后，Windows / Node 25.8.2 / pnpm 10.33.2）

- `node --import tsx --test packages/server/tests/harness-api.test.mjs`：16/16 pass
  （真实子进程端到端；services 层公开接口脚本化桩件——真实 agent 需真实模型凭据；
  含 H1 归属×2 / H2 参数校验 / M1 UTF-8 跨 chunk / M4 行上限+写背压回归；
  waitFor 上限 8s→20s——tsx 冷启动 9s 实测会顶穿 8s）。
- `node --import tsx --test packages/harness-sdk/tests/parity.test.mjs`：15/15 pass
  （SDK vs 直接 NDJSON 逐方法 parity、seq gap、权限 fail-closed、结构化输出重试、
  断连归因、launch 隔离/凭据继承（含 env 密钥模式）/launch fail 抛错、
  M1 SDK 侧 UTF-8、M2 send-only、M3 泄漏回落、M4 frame-too-large、
  M8 schema 描述、L1/L2 单元）。
- `packages/shared`：`tsc --noEmit -p .` 通过；`tsc -p .` 通过（产出含 harness-api 声明）。
- `packages/server`：`tsc --noEmit -p .` 通过。
- `packages/harness-sdk`：`tsc --noEmit -p .` 通过。
- 根 `pnpm typecheck`：通过（项目列表未动；harness-sdk 由各包 tsconfig/references
  自检，未加入根 `tsc -b` 列表）。
- 红线钉住：acode-protocol / acode-protocol-v4 git 零 diff（测试断言）；翻译桥源码
  acode-protocol import 零命中（测试断言）；Desktop stdio 链路（entry-stdio/stdio.ts）
  零改动。
