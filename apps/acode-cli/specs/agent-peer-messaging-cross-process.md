# Agent 间跨进程通信 P1：SessionMailboxPort 写入方（编排方案 Phase 5 / ④-P1）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 5 P1 与 §7④ 裁决（跨进程用 `SessionMailboxPort`、不建 board）。前置批次：
P0 进程内同父兄弟（[`agent-peer-messaging.md`](agent-peer-messaging.md)，本批不改其
sink/queued 路径任何行为）；peer-5 turn 起点 drain
（[`subagent-pending-message-drain.md`](subagent-pending-message-drain.md)）保障 queued
补投。参照机制：Codex 持久 mailbox 的 store-and-forward 语义。只搬运机制设计。

**分批**：本 spec 只覆盖 **P1 = 跨进程 store-and-forward 写入方**。P2（整树 live
寻址表、多层镜像逐级收口、跨层环路/深度硬闸）另行立项；P0 的进程内路径原样不动。

## 背景（已核实的现状，基线：当前检出，行号实施前需复核）

- `SessionMailboxPort`（`contracts/src/interfaces/session-mailbox.port.ts:12-17`）是
  **半成品**：只有 `drainUnread` 读方，全仓无写入方——信封 schema（v1）、文件适配器
  （`adapters/src/mailbox/index.ts`，含 `SESSION_ID_PATTERN` + root 包含检查双重路径
  防护）、hook drain（`core/src/hooks/session-mailbox.ts:44-58`，UserPromptSubmit /
  PostToolUse / Stop 三个 hook 点，`MAILBOX_DRAIN_LIMIT=20`）全部现成，但消息永远
  无法到达。
- `ACODE_MESSAGE_ENABLED` env 门（`bootstrap/src/app/app-config-options.ts:6-8`，
  **默认关**）：开启时 `create-app.ts:473-481` 构造 `NodeSessionMailboxAdapter`
  （rootDir = `ACODE_MAILBOX_ROOT ?? ~/.acode/mailbox`），只注入**根 runtime** deps；
  子 runtime deps（`runtime/methods/subagent.ts` child deps 块）不转发——活的 child
  session 不会 drain 自己的信箱，落盘消息要等到该 session 独立 resume 才被消费。
- `drainUnread` 每次调用先 `mkdir` unread+read 两个目录（`adapters/src/mailbox/index.ts:24-25`）：
  PostToolUse 每个工具调用触发一次 drain，child 转发后等于每工具调用铲两个目录。
- P0 peer 窄面（`core/src/subagent/peer-messaging.ts`）：registry 外目标一律结构化
  拒绝（`:127-131`）；注入围栏（`PEER_UNTRUSTED_HEADER` + escapeXml 信封，
  `message-steering.ts:21/:80-93`）与双维度速率窗（sender 20/60s + pair 10/60s，
  `peer-messaging.ts:61-63`）现成。
- `agentId↔childSessionId` 恒等式：`subagent/runner.ts:860`
  `createSessionId(\`subagent_${agentId}\`)`——纯推导、无表查询；
  `sessionStore.getSession(sessionId)`（`session-store.port.ts:1100`）可做存在性校验
  并取得 `parentID` 链（`bootstrap/src/acode-protocol/background-work-owner.ts` 同款
  属主定位模式）。
- 投递语义联合：`subagent.port.ts:74`
  `"queued" | "steered" | "resumed_background"` + `tools/send-message.ts:36` zod enum
  （`.strict()` 对象，运行时校验会拒未知值——两处必须同步扩）。
- `AgentRuntimeInternal.sessionMailboxPort`（`runtime/internal.ts:137`）声明了但
  **从未被赋值**（全仓无 `this.sessionMailboxPort =` 写入点）；消费方
  `runtime-tools.ts:151/:180` 读的是 `deps.sessionMailboxPort`。本批装配一律走 deps，
  不依赖该死字段。

## 产品规则

**R0 双门控，默认关（方案边界条款）。** P1 写入方生效 = `config.subagents.peerMessaging.enabled`
（装配期定值，P0 R0 同款）∧ `deps.sessionMailboxPort` 在场（`ACODE_MESSAGE_ENABLED`
env 门，默认关）。任一缺席：peer 域外拒绝文案与 P0 **逐字节一致**（负向面零变化），
child deps 无 mailbox 字段（转发是条件 spread）。

**R1 写入方补在 `SessionMailboxPort` 上，读写同一接口（§7④ 裁决：不建 board）。**
`deliver(input)` 收完整信封事实：`messageId` 由调用方生成（peer port 已有
`createMessageId` 单点，适配器不自造身份）、`createdAt` 缺省 now。适配器职责只有
落盘：`mkdir unread` → **原子写**（同目录 tmp + rename——读方 `readdir`+`readFile`
跨进程并发，半截文件会炸 `parseEnvelope`）→ 文件名 = `createdAt` 毫秒零填充 +
`messageId`（`drainUnread` 按文件名 sort，即按发送序 drain）。sessionId 走既有
`SESSION_ID_PATTERN` + root 包含检查（复用，不另立第二份路径防护）；`messageId`
新增文件名安全校验（`[A-Za-z0-9_-]`，防路径注入——信封字段进文件名的唯一防线）。

**R2 寻址 = 恒等式推导 + 存在性校验（不建整树表——那是 P2）。** peer port 的
mailbox fallback 只在 `to` ∉ 父 registry 时触发：`to`（agentId）→ 恒等式推导
childSessionId → `getSession` 校验存在 → 通过才落盘。不存在的目标结构化拒绝（指引
经父协调），**无任何写副作用**。`fromSessionId` = 发送方 child session id，由 runner
在 port 构造期铸造（`lifecycle.childSessionId`），模型不可伪造。**不设同树限制**：
桌面多窗口 = 同一 Host 进程内多棵树（sessions 池），跨树正是主场景；滥用面由
「必须知道目标 agentId 才能寻址」+ R4 限速 + env 门（默认关）+ 存在性校验共同封顶。

**R3 store-and-forward，绝不触发即时算力（P0 R7 / peer-1 纪律的跨进程形态）。**
写入方只触文件系统：不触任何 runtime/registry/steer/resume 路径，本进程零算力副作用；
消费时机 = 目标会话**自己**醒来（既有 hook 点 drain，读方零新增机制）。
`persisted_mailbox` 的模型可见文案明示「delivered when that session next runs」——
不承诺即时性，不复用 steered/queued 的语义暗示。

**R4 限速沿用 P0 双维度窗口，mailbox 与 sink 路径共享额度。** 同一 `claimRate`
表（sender 20/60s + pair 10/60s）：跨进程风暴与进程内风暴收在同一闸里，模型无法
通过「改走 mailbox」绕过限额。`deliver` IO 失败 = 结构化 `failed`（不伪装成功、
不自动重试——重试语义归模型决策）；镜像失败吞掉留痕（P0 R5 同款观察面纪律）。

**R5 注入围栏与 sink 路径单源（peer-2 跨进程形态）。** 把 `message-steering.ts` 的
peer 信封构造提取为导出函数 `formatPeerMessageEnvelope`（`PEER_UNTRUSTED_HEADER` +
escapeXml 信封；提取是纯重构，sink 路径输出**逐字节不变**），mailbox content 与
sink 注入共用——不立第二份围栏文案。消息体先按 `MAX_SEND_MESSAGE_MODEL_BYTES`
（4096）截断再进信封（同源常量，P0 R6.3 纪律）。读方 drain 的
`<session-message source="mailbox">` 外层包装保留：双层信封，外层背 mailbox 语义
（含 "For reference only" 声明行），内层背 peer 围栏。

**R6 持久镜像（peer-3 硬性要求的跨进程形态）。** `persisted_mailbox` 受理成功即
mirror 落**发送方父会话** synthetic notice（复用 P0 `persistPeerMirror` 单点；
`metadata.peerMessage` 增 `toSessionId`，`delivery` 记 `persisted_mailbox`）。
接收方的持久痕迹 = mailbox `read/` 归档 + 注入其会话事件流——两端冷目录都看得到
跨进程 peer 流量。拒绝（寻址 miss / 限速 / IO 失败）不镜像。

**R7 子 runtime drain 转发。** child deps 按父 `deps.sessionMailboxPort` 在场转发
（条件 spread；env 门关闭 = 字段缺席 = 行为逐字节不变）——活的 child session 由此
获得自己的 hook drain（`createRuntimeHookRunner` 对任意带该 dep 的 runtime 生效，
零新机制），跨进程来件不再等到独立 resume 才被消费。配套**消除 `drainUnread` 空扫
副作用**：unread 目录不存在（ENOENT）直接返回空、不建目录；read 目录只在确有消息
要归档时惰性建（否则 R7 转发后每个 PostToolUse 都为空信箱铲两个目录）。返回值语义
不变（仍是「本次 drain 到的信封」）。

**R8 投递语义联合扩 `"persisted_mailbox"`。** `subagent.port.ts` union 与
`tools/send-message.ts` zod enum 同步扩（运行时校验面不拒新值）。父 registry 路径
（`createSendMessageSuccess`）不产生该值，其 ternary 文案分支**不扩**——
persisted_mailbox 的模型可见文案由 peer port 单点产出（避免第二文案源）。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| mailbox 文件 | `<root>/<sessionId>/{unread,read}` 文件系统 | 写入 = tmp+rename 单点原子；消费 = drain rename 归档 |
| 信封身份（messageId/createdAt/from） | 调用方（peer port + runner 铸造） | 适配器不生成、不改写 |
| 速率窗口 | 父 runtime 内存 per-run Map（P0 既有表） | mailbox 与 sink 共享额度（R4），不持久化 |
| 目标解析 | sessionStore（getSession 存在性） | 恒等式纯推导，无第二份寻址表（R2） |
| 持久镜像 | 发送方父会话 synthetic notice（既有 owner） | R6，复用 P0 单点 |
| 门控 | config.subagents.peerMessaging（装配期）∧ ACODE_MESSAGE_ENABLED（env） | R0 |

## 接口

- **contracts**（写入方按方案原文补在既有 port 上）：
  - `SessionMailboxDeliverInput { content; fromSessionId; messageId; toSessionId; createdAt? }`；
  - `SessionMailboxPort.deliver(input): Promise<void>`（必选成员——全仓唯一实现方是
    `NodeSessionMailboxAdapter`，无 drain-only 替身需要兼容）；
  - `SubagentSendMessageDelivery` += `"persisted_mailbox"`；`SendMessageOutputSchema`
    delivery enum 同步（R8）。
- **core**（不进 contracts——窄接缝，P0/K4 同款 duck-typing 纪律）：
  - `PeerMailboxWriteSeam { deliver(input): Promise<void>; resolveTargetSession(agentId): Promise<SessionId | undefined> }`
    ——`subagent.ts` 以 `deps.sessionMailboxPort` + `deps.sessionStore` 闭包铸造，经
    `ExploreSubagentPortOptions.peerMailbox` 下发；runner 绑
    `senderSessionId = lifecycle.childSessionId` 传入 `createPeerMessagingPort`；
  - `message-steering.ts` 导出 `formatPeerMessageEnvelope`（R5 提取重构）。
- **装配**：`subagent.ts` peerMessaging 条件块内加 `peerMailbox` 条件 spread；child
  deps 加 `sessionMailboxPort` 条件转发（R7）。

## 事件顺序与幂等

```
子 A 调 SendMessage(to=X) → peer port
  ├─ 自检（to === 自己）→ 拒绝（P0 既有，先于一切解析）
  ├─ X ∈ 父 registry → P0 路径原样（steered/queued/终态拒绝）
  ├─ X ∉ registry ∧ seam 缺席 → P0 拒绝文案（逐字节不变，R0）
  └─ X ∉ registry ∧ seam 在场：
      ├─ resolveTargetSession(X)：恒等式推导 childSessionId → getSession 存在性
      │    miss → 结构化拒绝（零写副作用，指引经父协调）
      ├─ R4 限速（sender+pair，与 P0 共享窗口）→ 超限拒绝（冷却文案）
      ├─ 4096 截断 → R5 围栏（单源信封）→ deliver（mkdir → tmp 写 → rename 原子落盘）
      │    IO 失败 → 结构化 failed（不伪装、不重试）
      ├─ R6 镜像落发送方父会话（失败吞掉留痕，不回滚投递）
      └─ 返回 delivery="persisted_mailbox"（文案：目标会话下次运行时送达）
目标会话侧（任意进程）：hook 点 drainUnread（ENOENT → 空）→ rename 归档 read/
  → 注入模型（外层 mailbox 信封 + 内层 peer 围栏）
幂等：messageId 每尝试唯一；deliver 原子 rename = 单文件单写；drain rename =
  单消费（read/ 归档防重复投递）；镜像每成功受理一次
```

## 验收场景

见 `apps/acode-cli/tests/agent-peer-messaging-mailbox.test.mjs`（实施时落地）：

1. 适配器往返：deliver → drainUnread 返回完整信封；多条按 createdAt 序 drain；
   写后 unread 无 tmp 残留。
2. 路径/文件名防护：非法 sessionId（越 root / 不匹配 pattern）→ deliver 抛；
   非文件名安全 messageId → 抛。
3. drain 副作用消除：unread 目录不存在 → 返回空且**不创建任何目录**（R7 配套）。
4. peer fallback：registry 外目标 + resolver 命中 → `persisted_mailbox` 成功
   （fromSessionId = 铸造值；content 含声明行 + escapeXml 转义 + 4096 截断生效）；
   resolver miss → 结构化拒绝且零写。
5. R4 共享窗口：sink 与 mailbox 混合发送，sender 第 21 条拒、pair 第 11 条拒。
6. R6 镜像：`persisted_mailbox` 受理即镜像（metadata 含 delivery/toSessionId）；
   镜像失败不阻断投递成功。
7. R0 负向：seam 缺席 → 拒绝文案与 P0 逐字节一致；自我发送先于 resolver 拒绝。
8. R8 schema：`SendMessageOutputSchema.parse` 接受 `delivery: "persisted_mailbox"`
   （strict 往返）。
9. 不变量守护（负向，仿 P0 场景 8 源文本模式）：peer-messaging 的 mailbox 路径无
   resume/steer/registry 句柄引用；`subagent.ts` 的 child deps mailbox 转发在条件
   spread 内；`createSendMessageSuccess` 文案分支未扩（persisted_mailbox 文案单源
   在 peer port）。

## 未做与取舍

1. **P2 整树 live 寻址不在本批**（agentId→runtime 弱引用表挂 sessions 池、多层镜像
   逐级收口、跨层环路硬闸）：本批跨进程语义只有 persisted_mailbox 一种；进程内
   非兄弟目标（堂兄弟/叔辈，嵌套树）仍按 P0 拒绝。
2. **属主进程存活探测不进写入方**：background-work-owner 式 sessions 池遍历的唯一
   用途是「属主在本进程 → 即时投递」，而那正是 P2 寻址表的职责；P1 写入是进程无关
   的（文件落盘 + 目标侧 hook drain），不做半套 live 路由。
3. **跨进程 hop 上限判定留给 P2**：envelope v1 schema 不动；drain 注入走通用
   mailbox 呈现（无结构化 origin 可携带 hop）。环路 = 两侧模型互相回发，R4 双维度
   限速封顶（P0 取舍 #4 同款论证——无自动转发时速率闸是有效且不过度的闸）。
4. **父侧 SendMessage（coordinator registry 路径）不加 mailbox fallback**：方案 ④
   的主体是 peer（agent↔agent）；coordinator 给任意会话跨进程发消息是另一产品面
   （涉 resume 权威与属主路由），不夹带。
5. **不设同树限制**（R2 理由）；env 门开启后的滥用面 = 知道 agentId 的模型可给
   本机任意存在的 session 留言，由限速 + 存在性校验 + 双层围栏收敛。跨机不可达
   （mailbox 是本机文件系统）。
6. **drain 来件不做 peer 专属 presentation 升级**：跨进程来件走既有 mailbox 文案
   （含 "For reference only" 声明行 + 内层 peer 围栏），presentation 家族演进归
   prompt 面专项（P0 取舍 #5 同款）。
