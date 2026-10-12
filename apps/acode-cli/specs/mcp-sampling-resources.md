# ACode：MCP sampling 与 resources（拉取面）

## 背景与目标

上游 zcode 3.15.1 引入 MCP UI（server 提供可渲染应用 + sampling 回调 + 资源订阅）。
ACode 现状（调研结论）：MCP 客户端在 agent 进程（`@modelcontextprotocol/client`
2.3.1），未声明任何 client capability，sampling/resources 全缺。

本 spec 落地**协议价值核心**：resources（拉取）。MCP UI 应用容器（http 形态 app
渲染进宿主）**本轮不做**——它需要常驻 origin+存储的沙箱面与 MCP apps 生态配合，
登记为独立后续项（上游 pluginUi.* i18n 亦随之缓议）。

## 范围修订（实施期裁决，2026-10-11）

**sampling 消费面本轮不实现，配置字段保留。** 实施期核实：当前 SDK
（`@modelcontextprotocol/client` 2.3.1，协议纪元 2026-07-28）已把 `sampling` 能力
标记为 **deprecated**（client d.mts：「the `roots` and `sampling` capabilities are
deprecated as of protocol …」，elicitation 是后继面）。在已弃用的协议面上新建消费
特征违背仓库纪律（「发现设计缺陷先对齐，不不断增加兜底分支」）——正确路径是等
elicitation 面对齐后一并立项。因此：

- `McpServerConfig.sampling` 字段与设置页开关**保留**（DTO 透传已就位，fail-closed
  缺省 false）：将来 elicitation/sampling 消费面落地时配置不迁移；
- adapter **不声明** sampling capability（server 发起 createMessage 会被 SDK 层拒绝，
  与字段缺省语义一致）；
- resources 拉取面（list/read 工具 + uri 白名单窗口）按原 spec 全量实现。

## server 配置扩展

`McpServerConfig`（shared DTO 与 `.acode/.agents` 配置文件）新增两个开关
（缺省 **false**，fail-closed）：

```jsonc
{ "sampling": true, "resources": true }
```

- `sampling:true` → 该 server 被允许发起 `sampling/createMessage`；false 时 SDK 层
  拒绝（capability 不声明）。
- `resources:true` → 该 server 的资源暴露为拉取工具（见下）。
- 设置页 MCP 表单加两个开关（带风险说明文案：sampling = 允许该 server 触发模型
  调用并产生 token 计费）。
- **配置入口同步登记**（2026-10-11 实机补）：`adapters/src/config/schema.ts` 的
  `mcpServerBaseSchema` 必须含 `resources`/`sampling` 两键。该 schema 是 `.strict()`
  判别联合的基座，漏键时整条 server 配置被判 Unrecognized key 跳过（日志仅一条
  `config.mcp_server.skipped`），拉取面工具永不合成——与 protocolVersion 同款教训
  同文件再犯一次。实机曾因此把「模型复述了资源文本」误当验证通过（模型读的是
  server 脚本文件），验收必须以 journal 里真实的 `mcp__<server>__*` tool part 为准。

## sampling 链（adapters → core）

- `adapters/src/mcp/index.ts`：Client 构造按配置声明 `sampling` capability；注册
  `client.sampling` 处理器 → 经 `McpPort` 新方法 `onSamplingRequest` 上抛。
- core：sampling 请求复用既有 model 执行链（非 turn 的单次补全），
  **权限面**：`permission: "mcp"` 类别下的新动作 `sampling`（沿用既有 MCP 权限
  矩阵，默认每次询问；会话级减免可用）。执行记录投影为 toolCall row（工具名
  `mcp__<server>__sampling`，display kind 走 MCP 卡既有渲染），结果按
  maxTokens 钳制后回给 server。
- 上限：单次 sampling 请求 prompt ≤ 64 KiB、maxTokens ≤ 4096；会话累计 sampling
  调用 ≤ 64（防 server 循环烧钱），超限拒绝并断开该 server 的 sampling。

## resources 拉取面（core 工具）

`resources:true` 的 server 注册两个普通工具（进 ToolRegistry，权限 `mcp`）：

- `mcp__<server>__list_resources` → `[{ uri, name, mimeType?, description? }]`
  （上限 200 条）。
- `mcp__<server>__read_resource { uri }` → 内容文本（二进制 base64，单次 ≤ 512 KiB
  上限，超限提示分段策略由 server 侧资源设计承担）。

uri 永不拼路径、不落盘；`read_resource` 的 uri 必须出现在最近一次 list 结果里
（防任意 uri 探测，缓存 5 分钟）。资源**订阅**（subscribe/updated 推送）不做——
拉取面先立住。

### uri 白名单窗口的所有权（不跨会话）

窗口是**进程内存事实**：不落盘、**不跨会话**。其唯一所有者是「一次
`registerMcpResourceTools` 调用」——即一个 runtime 注册资源工具时新建的窗口 Map，
被该 runtime 注册的 list/read 工具 handler 闭包持有，随 runtime 生命周期存续。

- **禁止**用「模块级、仅按 `serverName` 键控」的全局 Map 承载窗口。一个 agent 进程
  同时托管多个并发 runtime（每 session 独立 pool lease、fork/child session、
  parent+subagent），它们会注册**同名** server（同一份 `.acode/.agents` 配置）却持有
  **各自独立**的 MCP 连接（per-lease connectionKey，账号/token/可达性可能不同，
  list 结果因此可能不同甚至为空）。仅按 `serverName` 键控会让 B 的 list **整体覆盖**
  A 的窗口：A 随后 read 自己刚列出的 uri 被误判 `uri_not_listed`（错误结果）；反向
  则 B 能 read 只有 A 列过的 uri（越过 per-session 授权边界，正是本窗口要防的探测）。
- 窗口 Map 必须在 `registerMcpResourceTools` 内部创建、按 `serverName` 键控（该 Map
  已天然 per-runtime，`serverName` 在其作用域内唯一），并注入 list/read 工具 entry
  工厂；handler 只读写自己闭包内的 Map，不触碰任何模块级共享状态。
- 过期即删除对应条目，模型需重新 list（工具结果里如实告知），与既有 5 分钟 TTL 一致。

## 协议与登记

- McpPort 接口（contracts）扩 `onSamplingRequest`/`listResources`/`readResource`；
- shared `packages/shared/src/mcp.ts` DTO + `McpServerConfig` 双目录读写侧同步；
- capability 协商不涉及 v4 新命令（sampling 在 agent 进程内闭环，只投影为既有
  toolCall row）；
- 设置页 UI：`McpServerForm` 两个开关 + i18n（`settings.mcp.sampling.label/
  description/resources.*`）。

## 验收场景

1. sampling:false 的 server 发起 createMessage → 拒绝（capability 未声明）；
   true → 弹权限确认 → 允许后模型被调用、结果回传、会话出现 sampling 工具卡。
2. 累计 64 次后拒绝并停用该 server 的 sampling。
3. list/read 工具只在 resources:true 时注册；read 未列过的 uri 被拒。
4. 单测：capability 条件声明、上限钳制、uri 白名单窗口、权限面接线；
   以 in-process mock MCP server（SDK server 侧）做一次 sampling+resources 集成测试。
5. 白名单窗口不跨会话：两个 runtime 各自 `registerMcpResourceTools` 注册同名 server
   （各持独立 port，list 返回不同 uri 集）时，A 的 read 只认 A 自己列出的 uri，
   B 的 list 不覆盖 A 的窗口，B 无法 read 只有 A 列过的 uri（跨 session 误放行）。
