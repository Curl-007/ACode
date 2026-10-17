# MCP 协议协商增量：慢连接记忆 × 403 快速失败 × 超长工具名剔除 × 防双跑

状态：2026-10-15 落地（价值提取第二轮 W2-M1 件2）。机制形态参照外部成熟实现的
公开行为（discover 裁决持久记忆、代理 403 快速失败、128 字符工具名上限、大结果
中途断连的 outcome-unknown 语义），实现与文案全部自撰；厂商内部事件名/遥测面
（`tengu_*`、`web_search_session_cap` 类）不进入本仓。

本 spec 是 `mcp-lifecycle-ttl-approval.md`（R1 懒重连/预算、R2 状态事件、R2.1/R2.2
模型文案）的协商面增量；连接生命周期唯一所有者仍是 `NodeMcpAdapter`。

## 背景：协商本体对照（ACode 已有，不重做）

ACode MCP 客户端（`@modelcontextprotocol/client` 2.3.1）**已有完整 initialize /
版本协商语义**，本批只补缺口、不另造协商本体：

| 参考行为 | ACode 现状（核实） | 结论 |
| --- | --- | --- |
| 最新协议代际默认协商 + 旧代际支持列表 | SDK `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS`；`resolveVersionNegotiationMode`（index.ts）支持 `auto` / `legacy` / `pin: "2026-07-28"` 三态，来自 `McpServerConfig.protocolVersion` | 已有 |
| legacy 退出开关（env 强制旧握手） | `protocolVersion: "legacy"` 配置级开关（per-server，粒度比全局 env 更细）；sse transport 恒 legacy | 已有（形态不同：配置级而非 env 级） |
| auto 协商的 probe 超时预算 | `resolveVersionNegotiation`：auto probe 上限 `MAX_MCP_VERSION_PROBE_TIMEOUT_MS=5s` 且不超过 timeoutMs/2；pin 用满 timeoutMs | 已有 |
| 协商失败稳定分类 | `isProtocolNegotiationFailure`（EraNegotiationFailed / UnsupportedProtocolVersion，结构化判定）→ `failureKind: protocol_negotiation_failed` | 已有 |
| **慢连接 server 记忆（7 天走旧协议路径）** | 无：每次 auto 连接都付一轮 probe 预算 | **本批 R1** |
| **代理/后端 403 不做三连重试** | 官方 MCP 的 auth fetch 已有 403 快速失败（official-auth.ts：`official_auth_forbidden`，不重试）；但连接失败后仍会进懒重连预算循环（最多 crashBudget 轮完整 spawn/握手）；通用 http server 的 403 无识别 | **本批 R2** |
| **>128 字符工具名剔除并点名** | 无：`normalizeMcpToolDescriptor` 只清洗字符集不限长 | **本批 R3** |
| **大结果（16MB 级）防双跑** | stdio 读缓冲已有上限（SDK `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10MB`，同量级）；callTool 的一次重试只对裸 `"Not connected"`（SDK 在请求**未写出**时的早期拒绝，已核 SDK 2.3.1 源码）触发，`CONNECTION_CLOSED`（已写出、响应未回）不重试——重发面已安全；但中途断连的裸错误无「结果未知」指引，模型可能自行原样重发 | **本批 R4**（补文案面；HTTP 响应体大小上限登记为缺口，见「不在本项范围」） |

`contracts/src/interfaces/mcp.port.ts`（398/400 行）按第一轮登记义务先行拆分：
`mcp-config.port.ts` / `mcp-status.port.ts` / `mcp-tools.port.ts` /
`mcp-official-auth.port.ts` / `mcp-resources.port.ts` 五个叶子 + 主文件保留
`McpPort` 接口并 re-export 全部叶子符号——barrel（interfaces/index.ts、
contracts src/index.ts）与全部既有 import 面零改动。

## 产品规则

### R1 慢连接 server 记忆（7 天新鲜窗走旧协议路径）

- **记忆内容**：`auto` 协商真正跑过 probe 且最终落在 **legacy 纪元**的 server
  （probe 超时未答或 server 只认旧握手），按稳定身份键记一条
  `{observedAt, latestProtocolVersion}`。
- **身份键**：stdio = command + args + 排序后 env 的 sha256 摘要（前 32 hex）；
  http/sse = url 摘要。改名/改配置即换键，旧条目随新鲜窗过期。
- **消费**：下一次连接解析出的协商模式为 `auto` 且记忆命中新鲜窗 → 直接以
  `legacy` 模式建连（跳过 probe），debug 日志点名「remembered as a legacy peer」。
  显式 `protocolVersion` 配置（pin/legacy）与 sse 不消费记忆。
- **新鲜窗 7 天**（`MCP_NEGOTIATION_MEMORY_TTL_MS`）；窗外条目读取时失效、写入时
  清除。**代际失效**：条目记录的 `latestProtocolVersion` ≠ 当前 SDK
  `LATEST_PROTOCOL_VERSION` 即失效（SDK 升级后旧观察不再可信，重新 probe）。
- **自愈证据优先**：任何一次 auto 协商以 **modern** 纪元连接成功 → 立即清除该
  server 的记忆（server 升级/变快后不再被旧记忆钉死在 legacy 路径）。
- **存储**：`<数据基目录>/.acode/cli/mcp/protocol-memory.json`
  （`ACODE_DATA_BASE_DIR` 尊重，与 doctor ledger 同惯例），版本字段 `version: 1`，
  读取上限 256KB，条目上限 512（超出按 observedAt 逐旧），临时文件 + rename
  原子写，写链串行化。
- **fail-open 纪律**：文件不可读/损坏/超大/版本来自未来 → 一律当作「没有记忆」
  重新 probe；写入失败只 warn、丢弃变更、作废读缓存。记忆面任何故障都不得
  阻断或拒绝连接。
- 对照参考实现的「probe 迟到应答」细节（server 在 probe 超时后才回答 → 忘记
  legacy 记忆）：SDK 2.3.1 不向调用方暴露 probe 迟到应答信号，ACode 以
  「modern 成功即清除 + 7 天窗自然过期」覆盖同一自愈方向（登记差异，不造轮子）。

### R2 HTTP 403 快速失败（不做三连重试）

- **判定（结构化，禁止文本反解）**：沿 cause 链找 `SdkHttpError.status === 403`；
  官方鉴权路径的 `OfficialMcpAuthError.kind === "official_auth_forbidden"` 同等。
- **语义**：403 = 身份被认出但访问被拒（凭据/套餐/权限/访问策略问题）——重连
  不可能改变结果。连接失败时标记该 server（adapter 私有集合），懒重连门禁在
  spawn **之前**直接抛快速失败错误：不再「403 → 冷却 → 重连 → 又 403」消耗
  预算循环（crashBudget 轮完整握手对永久拒绝是纯浪费）。
- **文案（自撰，R2.1 惯例）**：说明 403 事实、点明「重试不会改变结果、不要循环
  重试」、给用户侧检查项（凭据/授权头、套餐/权限要求、访问策略）、显式重连是
  恢复路径。不含响应体、不含凭据。
- **解除点（闭集）**：显式连接入口（connectServer / connectConfiguredServers
  收敛）与任一次连接成功。自动路径永不自我解除。
- 401 不进本面：401 是「凭证缺失/过期」，OAuth 自愈与 official 401-重试一次
  （official-auth.ts 既有语义）继续生效。

### R3 >128 字符工具名剔除并点名日志

- 模型面工具名（`mcp__<server>__<tool>` 完整名）> **128** 字符的工具在注册边界
  （tools/list 归一化处）剔除，不进工具池。
- 128 的依据：MCP SDK server 侧校验 `/^[A-Za-z0-9._-]{1,128}$/` 与 provider API
  工具名限制同级；ACode 前缀放大后更易越界，与其让首次调用/schema 校验炸出
  难归因错误，不如注册边界拒绝。
- **点名日志**（warn，事件 `mcp.tools.name_too_long_dropped`）：server 名 +
  每个被剔工具的 toolName/完整名/长度 + 上限值。日志回答「少了哪个工具、为什么」。
- 剔除是 per-tool 的：同 server 其余合法工具照常注册；server 状态仍 connected。

### R4 大结果防双跑（outcome-unknown 语义）

- **既有安全面（核实，不重做）**：callTool 的「一次重试」只对裸
  `"Not connected"` 触发——SDK 2.3.1 只在请求**尚未写出**（transport 缺席的早期
  拒绝）时抛该消息，重试不构成双跑；`CONNECTION_CLOSED`（已写出、响应未回）
  原样冒泡不重试。stdio 读缓冲上限 10MB（SDK 缺省），与参考实现 16MB 同量级。
- **本批增量**：`CONNECTION_CLOSED` 中途断连的裸错误换成 **outcome-unknown**
  指引文案（原错误进 cause 链）：结果未知——server 可能已执行、仍在执行或根本
  没收到；**先核实效果再决定是否重复，不得盲目原样重发**。大结果（MB 级）传输
  窗口长、中途断连概率高，副作用工具盲重发 = 双跑，文案面是该风险的模型侧闸门。
- `NOT_CONNECTED` 不包装（未发送事实必须保留给安全重试路径）；中途崩溃计数
  （R1 第二计数器）语义不变，包装发生在计数之后。

## 状态所有者

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 协商记忆（文件 + 读缓存 + 写链） | `createMcpNegotiationMemory` 实例 | adapter 构造期注入或缺省创建；fail-open |
| 403 快速失败标记 | `NodeMcpAdapter.permanentAccessDenied` | adapter 实例私有；解除点闭集见 R2 |
| 工具名上限判定 | `descriptor.ts` 纯函数 | 常量 128 单点定义 |
| outcome-unknown 包装 | `callToolOnClient` catch 路径 | 计数（预算）先于包装 |

## 验收场景

1. 记忆往返：`rememberLegacy` 落盘 → 新实例 `isRememberedLegacy` 命中；7 天+1ms
   后失效；`latestProtocolVersion` 不符（模拟 SDK 升级）失效；`forget` 清除。
2. fail-open：损坏 JSON / 超大文件 / version=2 → 读取为空，不抛错。
3. 身份键：stdio 的 env 顺序无关（排序后摘要）；改 command/args/env/url 即换键。
4. 128 剔除：`exceedsMcpToolNameLimit` 边界（128 放行 / 129 剔除）；剔除后
   descriptor 不进池。
5. 403 快速失败：`isHttpForbiddenFailure` 认 SdkHttpError(403)（含 cause 链包裹）；
   标记后 callTool 直接抛 access-denied 文案（含「do not retry this tool in a
   loop」），不触发重连。
6. outcome-unknown：CONNECTION_CLOSED 形态错误 → 文案含「outcome is unknown」与
   「do not resend the same call blindly」，cause 保留原错误；NOT_CONNECTED 不包装。
7. 文案面（R2.2，挂 mcp-lifecycle-ttl-approval.md）：not-connected 阶梯三段
   （稍晚连上/稍候重试一次/仍不可用则说出来并交付替代产物）；挂起文案含缺席
   诊断（宿主进程/应用多半未启动或离线，停止重试）；全部保留「Do not retry this
   tool in a loop」短语（既有测试钉住）。

## 证据对照（还原工程复核，2026-10-15，只读）

| 机制 | 证据 |
| --- | --- |
| 协议代际常量与支持列表 | `Cen/src/beautified-claude-code/chunk-mp591x8p.js:23-24`、`chunk-mpd817py.js:8275` |
| 协商模式 env 开关（legacy/auto）+ denylist | `chunk-mpd817py.js:2849-2906` |
| discover 裁决记忆（1d/7d 窗、256KB、原子写、写链、代际校验） | `chunk-mpd817py.js:1022-1210` |
| probe 超时 → 记 legacy；迟到应答/modern → 忘记忆 | `chunk-mpd817py.js:4425-4451、4615-4633` |
| remembered_legacy 跳过 probe | `chunk-mpd817py.js:3372、3477-3494` |
| 代理 403 + 已发凭证 → 立即抛解释错误（不重试） | `chunk-mpd817py.js:2592-2627` |
| 128 字符工具名校验 | `Claude-2.37337/src/beautified/main/index.chunk-C4qJSrNf.js:31639-31646`（MCP SDK 校验正则） |
| 16MB 结果上限 + 中途断连「结果未知，先核实再重复」 | `chunk-mp591x8p.js:31-41`、`chunk-mpd817py.js:793-811、8044-8070` |

## 常量定值记录

- 记忆新鲜窗 7 天、文件上限 256KB、条目上限 512：对齐参考实现量级（stdio 7d /
  文件 262144B）；条目上限是自加护栏（身份键随配置变更累积）。
- 工具名上限 128：SDK/provider 同源量级，见 R3。
- 403 标记无 TTL：解除只走显式操作/连接成功（永久拒绝不应靠时间自愈）。

## 不在本项范围

- HTTP/SSE 响应体大小上限（参考实现 16MB body / 64MB event-stream 封顶）：ACode
  的 HTTP 路径未强制 body 上限，登记为缺口；实施需要包装 transport fetch 的
  响应流计数，另立小批（与 stdio 10MB 现状合并评估）。
- 协商记忆进设置页 UI（可见/可清除）：记忆是启动税优化，debug 日志即产品面。
- 全局 env 协商开关（参考实现的 MCP_PROTOCOL_NEGOTIATION）：ACode 已有
  per-server `protocolVersion` 配置三态，粒度更细，不另加全局 env。
