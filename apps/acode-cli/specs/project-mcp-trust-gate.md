# 项目作用域 MCP server 信任门（project MCP trust gate）

安全修复 H2。项目作用域（`.acode/config.json` / `acode.json` 的 `mcp.servers`）声明的
**stdio 型** MCP server 纳入与 Workspace Hooks 同级的信任门：默认 untrusted、不自动
spawn；用户显式信任后按**内容 digest** 持久化，配置内容变更即失效、需重新确认。

## 背景与根因

此前 `packages/bootstrap/src/app/runtime-config.ts` 的 `untrustedProjectMcpServers`
恒为空集（注释原文「产品决定 workspace MCP 开箱即用」），链路上：

1. 项目配置的 `mcp.servers` 经 `packages/adapters/src/config/project-config.adapter.ts`
   完整保留（permission 有 restrictive floor，`mcp` 没有任何门）；
2. `config-factory.ts` 将其并入有效配置；
3. `packages/core/src/runtime/methods/mcp.ts` 在 AgentRuntime 启动期即
   `connectConfiguredServers`，stdio 型经 `packages/adapters/src/mcp/index.ts` 直接用
   仓库文件的 `command/args/env` spawn 子进程。

后果：**clone + 打开恶意仓库即远程代码执行**，且早于任何用户输入。同仓库的 hooks 已有
完整信任门先例（digest 持久化、review、headless skip 提示），更危险的「仓库携带的可执行
进程声明」反而开箱即用——与 `project-permission-restrictive-floor.md` 指出的不对称同源。
本修复经安全审计批准，**改变「开箱即用」正是修复目的**。

## 产品规则

- **R1 门控范围**：仅 `serverSources[name] === "project"`（config-factory 的有效来源
  标记）且有效配置 `type === "stdio"` 的 server。untrusted 时从自动连接集合剔除
  （不 spawn、不注册其工具）；状态投影为既有 `untrusted` 状态
  （`listMcpServerStatuses`），不伪装成连接失败。
- **R2 非 stdio 不受门控**：项目声明的 http/sse server 不 spawn 本地进程（无本地代码
  执行面），维持自动连接。
- **R3 用户自身配置原则上不受门控**：user/env/cli 作用域的 server 是用户自己的声明，
  照常连接。**例外（R10 内容命中）**：其规范化可执行内容（command/args/env）与任一
  项目声明完全一致时，视同「内容可能来自 workspace 文件」，同样过 digest 门——
  用户自有配置与仓库声明逐字节相同的概率极低，误伤方向是 fail-closed（grant 一次
  即恢复），远比放行仓库回声安全。
- **R4 宿主 authority 优先**：`builtInMcpServers`（如 node_repl）与官方 CUA 由宿主
  不可伪造凭据持有，永不因项目同名声明被剔除。判定用**引用相等**（有效对象 ===
  项目层对象才门控，同 `resolveTrustedOfficialCuaServerNames` 的既有手法）：项目声明
  被宿主对象遮蔽时，实际 spawn 的不是仓库内容，不构成威胁，也不允许恶意仓库借
  「声明同名 node_repl」把宿主工具 DoS 掉。
- **R5 显式信任按内容 digest 持久化**：信任记录键为
  `(workspaceIdentity, serverName)`，值为
  `sha256(serverName + 规范化配置 JSON)`；规范化覆盖 `type/command/args/cwd/env`
  （键排序、args 缺省为空数组、env 键排序、cwd 取 adapter 归一化后的绝对路径）。
  配置内容任何变化 → digest 变化 → 旧记录不再匹配 → 重新拦截（重新确认）。
- **R6 fail-closed**：trust store 缺失、损坏、读取异常时，全部项目 stdio server 视为
  untrusted；损坏文件按 hooks 同款恢复语义改名 `*.corrupt-<ts>` 留证。
- **R7 headless/无 UI 场景**：skip + 提示，与 hooks 行为一致——bootstrap 记一条
  info 日志（含 server 名与 review 指引）；`acode -p` 纯文本/JSON 输出路径向 stderr
  追加提示（`Project MCP servers skipped (pending trust) … Review with: acode mcp
  trust review`），JSON summary 携带 `projectMcpTrust` 字段。
- **R8 会话内显式 connect 不是信任**：`connectMcpServer`（设置页用户点击）仍可连接
  untrusted server——那是本会话内的显式用户动作；它**不写信任存储**，冷启动照 R1
  重新门控。持久信任只有一个写入口：R9 的 grant。
- **R9 信任管理入口**：CLI `acode mcp trust status|review|grant|revoke`
  （形态与 `acode hooks trust` 对称），底层为 bootstrap 导出的
  `inspectProjectMcpTrust` / `grantProjectMcpTrust` / `revokeProjectMcpTrustCli`。
  grant 以**当前配置内容**计算 digest（用户确认的就是即将执行的内容）；store 损坏时
  grant/revoke 都拒绝执行（与 hooks 的 corrupt fail-closed 同语义）。
- **R10 显式路径的内容来源门（B1 收口）**：协议显式传入的 `mcpServers`
  （desktop 设置页 mcp/list、legacy/v4 session/create、手机 resumeTask 回声）
  **不携带可信来源信息**——desktop main 的 workspace 目录读取会把仓库携带的
  `.acode/config.json` 与 `.agents/mcp.json` server 一并作为显式参数下发，wire
  schema（`acodeProtocolMcpServerSchema`，legacy 冻结面）又丢失 `cwd`。因此
  stdio server 的门控判定依据是「**内容可能来自 workspace 文件**」而不是 client
  标签或 agent 侧 serverSources 单点标记：显式层 stdio server 的规范化内容
  （command/args/env，键序归一）命中任一项目声明的内容 → 按**自身名字 + 自身
  规范化配置**（cwd 缺省归一到 `resolve(workingDirectory)`，与根级项目声明的
  grant digest 对齐）过 digest 门；命中而未信任 → untrusted（skip + pending）。
  内容不命中任何项目声明的显式 stdio server 维持 R3 放行。改名回声（仓库内容 +
  新名字）因 digest 键含 server 名而天然拦截。
- **R11 项目发现面覆盖 `.agents/mcp.json`**：agent 侧项目 MCP 发现
  （`loadProjectConfigs`）在既有 `acode.json` / `.acode/config.json` 之外，追加读取
  `<workingDirectory>/.agents/mcp.json` 的 `mcpServers` 映射，作为项目层**最低
  优先级**参与合并：同名 server 以 `acode.json`/`.acode/config.json` 为准（对齐
  desktop 的「`.acode` 强优先」），`.agents` 独有条目同样进入项目层并受门控——
  比 desktop 的整文件跳过更保守：**任何 workspace 文件声明过的 server 内容都在
  信任门视野内**（R10 的内容命中判定对混合仓库不被 `.acode` 优先级遮蔽）。
  解析/规范化/诊断复用既有 config 文件管线（type 推断、env 归一、
  `config_mcp_server_invalid` 逐 server 诊断、cwd 绝对化）。此后
  `.agents/mcp.json` 与 `.acode/config.json` 在信任门、`acode mcp trust` CLI、
  serverSources 标记下完全同级——「仓库只放 `.agents/mcp.json`」不再是发现面盲区。

## 状态所有者与写入路径

```text
项目 .acode/config.json ─┐
项目 acode.json          ├─createConfig(loadProjectConfigs, R11 含 .agents/mcp.json)
项目 .agents/mcp.json   ─┘        │
                                  ▼
                     serverSources(单一事实源: config-factory)
                                  │
desktop/手机显式 params.mcpServers（可能回声仓库内容，legacy wire 无 cwd/scope）
                                  │
                                  ▼
用户 acode mcp trust grant ──▶ FileWorkspaceMcpTrustStore（唯一持久信任所有者,
                                  │   ~/.acode/security/workspace-mcp-trust-v1.json）
                                  ▼
bootstrap loadProjectMcpTrustSnapshot ──▶ resolveUntrustedProjectMcpServers
        （只读快照, 每次装配加载）          （唯一门判定点：R1 项目层直判 +
                                  │          R10 显式层内容命中判定）
                     ┌────────────┼────────────────────────┐
                     ▼            ▼                        ▼
        runtimeConfig.mcp.servers  session-facade 状态投影  acode-protocol mcp/list
        （core startMcpStartup 只  （untrusted 状态, 既有）  （同一 gate helper，
          spawn 这个集合）                                   不再有第二份空集真值）
```

- **信任存储所有者**：`packages/adapters/src/storage/workspace-mcp-trust-store.ts` 的
  `FileWorkspaceMcpTrustStore`。锁/原子写/损坏恢复机制住在同目录
  `locked-json-store-file.ts`（从 hook store 实现对称提炼的通用件，MCP store 是首个
  消费者；hook store 的迁移列为后续工作）。文件与 hook trust store 同住
  `~/.acode/security/`（storage root 解析复用 hook store 导出的
  `resolveSecurityDirectory`，单一所有者），0600/0700 权限、lock
  （pid+startTime+token、stale 回收）、原子写、corrupt 恢复与 hooks 存储同模式。
  记录 schema（zod）由 store 文件自持——它只被 CLI 侧（adapters/bootstrap/cli）
  消费，无跨包（root services/UI）消费者，因此不下沉 contracts/shared。
- **digest 计算所有者**：`packages/bootstrap/src/app/project-mcp-trust.ts` 的
  `computeProjectMcpServerDigest`；gate 判定（纯函数）
  `resolveUntrustedProjectMcpServers`（R1 项目层直判 + R10 内容命中判定同点收口）
  与快照加载 `loadProjectMcpTrustSnapshot` 同文件；项目声明收集
  `collectProjectDeclaredStdioServers`、显式层 cwd 归一
  `normalizeExplicitProjectMcpCandidate`、内容键 `projectMcpServerContentKey`
  均为该文件导出（grant/gate/CLI/测试共用，无第二实现）。
- **spawn 门唯一收敛点**：`resolveAppRuntimeConfig`（同步，消费注入的快照；快照缺省
  = 空信任集 = fail-closed）。`bootstrap/src/acode-protocol/mcp.ts` 的 mcp/list 复用
  同一对 helper，不再持有第二份「空集」真值。
- **身份 key**：`workspaceIdentity?.trim() || resolve(workspacePath)`（AGENTS 全局
  约定；与 hooks 的 `normalizeTarget`、config-factory 的 hook snapshot 同款）。grant、
  gate、mcp/list 三处必须同源，否则信任记录对不上号。

## 为什么对称新建而不是复用 FileWorkspaceHookTrustStore

先读了 workspace-hook-trust 链（coordinator/admission/review controller/store/CLI）后
的决定：**模式复用、实现对称新建**。理由：

- hook 记录 schema 是 hook 域专属（`eventAtGrant`/`matcherAtGrant`/`hookIndexAtGrant`
  为必填），且下沉在 root `packages/shared`（zod4，root services 消费）——本修复的
  边界只允许改 `apps/acode-cli`，往 hook schema 里塞 MCP 记录会污染两个域。
- hook 的信任语义是「逐条声明 + bundleDigest + review item + 会话内 admission
  状态机」；MCP server 是「每 server 一条内容 digest」，不需要 bundle/review 状态机。
  硬套会引入用不到的所有者。
- 存储位置、锁与原子写、corrupt fail-closed、CLI 形态、headless 提示**全部与 hooks
  同模式**（对称），审查/诊断心智一致；storage root 解析直接复用 hooks 侧导出函数
  （不复制）。

## 失败语义与已知边界

- trust store 读取失败（IO 异常）：视为空信任集（fail-closed）+ warn 日志；不阻断
  会话启动，其余 server 照常。
- 协议显式传入的 `mcp.servers` **不是**「desktop main 解析的用户配置」——desktop 的
  MCP 目录读取（`packages/desktop/src/main/mcpUserDirectory`）在 workspace scope
  同时读仓库携带的 `.acode/config.json` 与 `.agents/mcp.json` fallback，UI 的
  `getEnabledMcpServersForACode` 把这批仓库内容一并作为显式参数下发（设置页
  mcp/list、session/create、手机端 resumeTask 回声同路径）。显式路径因此按 R10
  内容来源门 fail-closed，不因「显式传入」获得信任；desktop 设置 UI 的信任管理
  界面不在本修复范围（CLI grant 已可完成持久信任，untrusted 状态经既有
  `listMcpServerStatuses` 投影展示）。
- wire 面（`acodeProtocolMcpServerSchema`，legacy 冻结）无 `cwd` 字段：根级项目
  声明（未显式配置 cwd）的 grant digest 与显式路径归一 digest 一致（R10），
  声明携带自定义 cwd 或位于嵌套项目目录时 digest 不匹配 → 显式路径保持
  untrusted（fail-closed 方向，agent 发现面路径 grant 后照常生效）。
- 无记录压缩（hooks store 的 compact 未对称实现）：记录按 grant 覆盖同键、体量小，
  列为后续工作。

## B1 收口：显式 mcpServers 装配路径的选型记录

**被钉住的绕过**（独立 Review B1）：R1 初版的门控范围判定只看 agent 侧
`serverSources[name] === "project"`，而 serverSources 只覆盖 agent 自己的项目发现面
（`acode.json` + `.acode/config.json`）。desktop main 在 workspace scope 还读
`<repo>/.agents/mcp.json` fallback，UI 把这批仓库携带 server 作为显式
`params.mcpServers` 下发 → `protocolMcpServersToRuntimeMcpConfig` 注入
`runtimeConfig.mcp` / mcp/list connect 直接 spawn：

- 后果①（fail-open）：仓库只放 `.agents/mcp.json`（不放 `.acode/config.json`），
  agent 发现面无名字 → 门跳过 → 打开 MCP 设置页刷新 / legacy session/create /
  手机 resumeTask 即无信任 spawn。
- 后果②（fail-closed 功能面）：wire schema `.strict()` 无 `cwd`，转换后 cwd 丢失；
  grant 侧 `normalizeProjectMcpServer` 恒写绝对 cwd → digest 恒不一致 → 已 grant
  的 server 经显式路径仍被判 untrusted。

**注入路径的 schema 调研**：v4 `createSession.mcpServers`
（`packages/shared/src/acode-protocol-v4/command.ts:57`）**复用 legacy**
`acodeProtocolMcpServerSchema`；legacy session/create（`server-operations.ts`
createRecord）与 mcp/list（`acodeMcpListParamsSchema`）同 schema；三者都经
`protocolMcpServersToRuntimeMcpConfig` 收敛。即：当前没有任何 wire 路径携带
来源/cwd 信息。

**候选方案与否决理由**：

1. *v4 加 cwd/scope 字段 + legacy 一律 fail-closed*：需要 v4 原生 MCP schema、
   desktop/UI/手机发送端全量改造；legacy 面（设置页 mcp/list、手机 resumeTask）
   永远无法携带 scope，只能对 stdio 一律拒绝——用户自有 stdio server 在设置页/
   手机端全部失效；且 scope 是 client 自报标签，陈旧/恶意 client 可标
   `scope:"user"` 绕过，agent 仍需一套内容兜底判定 → 两套判定路径，违背单一
   所有者。否决。
2. *desktop 侧过滤 workspace-scope server 不再下发*：依赖 client 诚实——手机端
   缓存列表、陈旧 desktop、第三方 legacy 调用方仍可回声仓库内容；且不能修复
   后果②（cwd 依旧丢失）。否决。
3. **选定：agent 端内容来源判定（R10 + R11）**——agent 自己补齐发现面盲区
   （`.agents/mcp.json` 进项目层，R11），显式层 stdio server 按「内容命中项目
   声明」过 digest 门（R10）。判定材料（workspace 文件内容）由 agent 本地读取，
   不信任任何 client 标签；legacy/v4/手机/CLI 四条路径同一规则、同一所有者
   （`resolveUntrustedProjectMcpServers`）；零协议改动、零 desktop/UI/services
   改动。代价：用户自有配置与仓库声明内容完全相同时需 grant 一次（保守方向，
   R3 已记载）。

`runtimeConfig.mcp.servers` 的显式 replace 语义保持不变（显式列表仍是 session
运行面的完整覆盖配置）；R10 在 replace 语义之上收口，不引入第二套合并规则。

## 接口

- `@acode/adapters/config`：`loadProjectConfigs` 的项目发现面在无任何项目文件提供
  `mcp.servers` 时追加 `<workingDirectory>/.agents/mcp.json`（R11，`mcpServers` 映射
  经既有 `parseConfigFileToRuntimePatchWithDiagnostics` + `normalizeProjectConfig`
  管线，签名不变）；公开导出补 `type McpServerConfigSource`。
- `@acode/adapters/storage`：`workspaceMcpTrustRecordSchema` /
  `workspaceMcpTrustStoreFileSchema` / `resolveWorkspaceMcpTrustStorePath` /
  `createDefaultFileWorkspaceMcpTrustStore` / `createFileWorkspaceMcpTrustStore` /
  `FileWorkspaceMcpTrustStore`（load/grant/revoke）。
- `@acode/bootstrap`：`loadProjectMcpTrustSnapshot` /
  `resolveUntrustedProjectMcpServers` / `computeProjectMcpServerDigest` /
  `collectProjectDeclaredStdioServers` / `projectMcpServerContentKey` /
  `normalizeExplicitProjectMcpCandidate` /
  `inspectProjectMcpTrust` / `grantProjectMcpTrust` / `revokeProjectMcpTrustCli`。
- `resolveAppRuntimeConfig` 新增可选输入 `projectMcpTrust`（快照；缺省 fail-closed），
  返回值 `untrustedProjectMcpServers` 语义不变（原恒空集改为真实计算）。
- CLI：`acode mcp trust status|review|grant|revoke`（`--workspace`、`--server`
  （可重复）、`--all`、`--json`）。
- 协议 wire 面零改动（legacy 冻结、v4 无需新字段）；`runtimeConfig.mcp.servers`
  的显式 replace 语义不变。

## 验收场景

见 `apps/acode-cli/tests/project-mcp-trust-gate.test.mjs`（mkdtemp 临时 fixture 仓库 +
临时 store 文件，不触碰真实工作区/HOME）与
`apps/acode-cli/tests/project-mcp-explicit-path-gate.test.mjs`（B1 显式路径收口）：

1. 项目 stdio server 未信任 → 出现在 `untrustedProjectMcpServers`，
   `resolveAppRuntimeConfig` 产出的 `runtimeConfig.mcp.servers` 不含它（startMcpStartup
   只 spawn 该集合，即不 spawn）；项目 http server 不受影响仍在。
2. `grantProjectMcpTrust` 后重新加载快照 → 不再 untrusted，`runtimeConfig.mcp.servers`
   含它（即会 spawn）。
3. 修改项目配置的 `args`（内容变化 → digest 变化）→ 重新拦截（回到场景 1 状态）。
4. store 文件损坏 → fail-closed：全部项目 stdio untrusted，且 load 报 corrupt。
5. user 作用域同名 server 覆盖项目声明（serverSources=user）→ 不门控。
6. 宿主 builtIn 遮蔽项目同名声明（引用不等）→ 不门控（R4，防 DoS）。
7. digest 稳定性：同一配置两次计算一致；env 键序不同不影响 digest。
8. （B1 绕过闭合）仓库只放 `.agents/mcp.json`：agent 发现面标 project；desktop
   风格显式回声（wire 形态、无 cwd）经 `resolveAppRuntimeConfig` → untrusted、
   不进 spawn 集合；改名回声（同内容、新名字）同样被拦。
9. （B1 grant 生效）对场景 8 的仓库 `grant --all` 后，同一显式回声进入
   `runtimeConfig.mcp.servers`（根级声明 digest 与显式归一 digest 对齐）。
10. （B1 legacy/手机 fail-closed）未 grant 时显式路径一律拦截（场景 8 即该语义），
    用户自有 stdio server（内容不命中任何项目声明）照常放行。
11. 按名合并：`.acode/config.json` 与 `.agents/mcp.json` 并存时，同名 server 以
    `.acode` 为准；`.agents` 独有条目进入项目层（source=project）并受门控。
12. `.agents/mcp.json` 的非法 server 条目跳过并发 `config_mcp_server_invalid`
    诊断，不拖垮整个文件。
13. store 损坏时 `revokeProjectMcpTrustCli` 拒绝执行（R9，与 grant 同款 fail-closed）。
