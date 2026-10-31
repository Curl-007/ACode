# M2-6：workflows + skills + mcp 域 8 个 legacy 方法迁 v4

> 状态：**已实施**（2026-10-28 落地，2026-10-29 补录）。
> 实施记录（验收节逐项证据）：
> A. `acodeProtocolMethods.` 消费：本域 8 法 9 → 0（mcpList 占 2 行：请求 +
>    isProtocolRequestTimeout 方法名匹配，均切 V4_METHODS.mcpList；§7 分词 grep 自证）；
>    单批口径 72 → 63（优于批次预估 −8/→64，差异即 mcpList 第二行）。
> B. shared protocol-boundary.test.mjs 46/46 绿，其中本批 M2-6 块 5 条（536 行起）：
>    八法名落 V4_METHODS 带 v4/ 前缀、workflows params/result 逐字 parity、skills
>    referenceCatalog parity、mcp list parity、新叶无反向 import。
> C. CLI handler 测试：按 §5 边界（apps/acode-cli/tests 无引用被删符号）未建专属文件；
>    CLI 耦合套件 20 文件 134 pass/0 fail/2 skip（project-mcp×2、config-mcp、skill×8、
>    script-workflow×2、protocol-server 耦合×5、v4/protocol×3）。
> D. 套件（季末收口值；§7 为本批落地时点口径——shared 449、boundary 17/17、CLI 耦合 134）：
>    shared 478/478；services 578 pass/0 fail（7 skip 基线）；ui 1125/1125；
>    CLI 3205 pass/0 fail（38 skip 基线）；typecheck 32/32。
> E. lint 163w/0e（基线 164，−1）；architecture:check --changed new 0/regrown 0
>    （violations 303 = 基线，legacy 棘轮 413）。
> 冒烟：§6 如实登记——本批 8 方法**不在** 13 个高危名单；单链路功能测试 + 单测口径。
>    裁决落实：services mcpList unrecognizedKeys 兼容重试链已退役（v4 方法名即版本边界）；
>    `ACodeAgentMcpStatusModeUnsupportedError` 保留（UI McpSettingsSection.tsx 仍 import，
>    本路径不再抛出）。
> 关联：docs/reviews/2026-10-28/m2-scoping.md §5 Batch M2-6；M2-1 迁移样板；
>    M2-5 三叶拆分先例；§7 批次记录。
> 上游调研：`docs/reviews/2026-10-28/m2-scoping.md` §5 Batch M2-6
> 收敛计划：`docs/legacy-protocol-convergence-plan.md` M2 节
> 迁移样板：M2-1（commit 5da76197）+ usage/headerMeta 的 v4 独立 query 先例

## 1. 范围与行为

迁移 8 个 workspace 级 legacy 方法到 v4 名字空间（JSON-RPC 方法名带 `v4/` 前缀，载体复用同一传输）：

| legacy 词 | v4 词 | 形态 | 语义 |
|---|---|---|---|
| `workflows/list` | `v4/workflows/list` | query | 扫 `<cwd>/.acode/workflows/`（或全局根），回条目 + invalid + dir |
| `workflows/get` | `v4/workflows/get` | query | 按名解析一档：meta + script，失败四态不抛错 |
| `workflows/updateMeta` | `v4/workflows/updateMeta` | command（写） | 读-改-写覆写 frontmatter，整文件落盘 |
| `workflows/delete` | `v4/workflows/delete` | command（写） | 按名删文件；名字先验后拼路径（路径穿越防线） |
| `workflows/runs` | `v4/workflows/runs` | query | dwf journal 运行历史分页（limit ≤ 50，多取一条判 truncated） |
| `workflows/move` | `v4/workflows/move` | command（写） | 全局档搬回项目根，只此一向，不覆盖 |
| `skills/referenceCatalog` | `v4/skills/referenceCatalog` | query | Composer 只读 catalog（session/workspace 双 authority） |
| `mcp/list` | `v4/mcp/list` | query（connect 有副作用） | MCP server 状态列表；`mode=status` 只读，`connect` 收敛连接集 |

载荷形状与 legacy **逐字 parity**（同字段、同 strict、同值域）——消费者（UI store / 设置页）语义零变化。v4 侧在 `acode-protocol-v4/` 结构化再声明（不反向 import legacy barrel，守 protocol-boundary 纪律），两侧形状由 `packages/shared/tests/protocol-boundary.test.mjs` 新增用例钉住。

**域边界**：`packages/shared/src/acode-protocol-v4/workflow-runs*.ts` 是**会话内执行面**（dwf run 投影/增量），与本批的「已保存工作流 GUI 中枢」不同域。本批新建 `workflows.ts`（中枢六法）、`skills.ts`（引用 catalog）、`mcp.ts`（server 列表），**不**复用/混入 workflow-runs*。

## 2. 所有权

- **协议面**：`packages/shared/src/acode-protocol-v4/workflows.ts` / `skills.ts` / `mcp.ts`（schema + 类型，纯声明，无运行时）；方法名常量在 `transport.ts` 的 `V4_METHODS`。
- **CLI 实现**：实体迁进 `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/`：
  - `saved-workflows-hub.ts`（六法，逻辑自 legacy `acode-protocol/saved-workflows.ts` 逐字迁，params 改 parse v4 schema）
  - `skills-reference-catalog-query.ts`（自 `skill-reference-catalog.ts` 迁）
  - `mcp-list-query.ts`（自 `mcp.ts` 迁）
  legacy 目录是待删目录（M3），不往里留实体债；三个 legacy 实现文件随 dispatch 删除一并移除。
- **dispatch**：`acode-protocol/server.ts` 只加一行转发/case（usageStats 先例：无会话投影依赖，不经 v4Gateway，直调实体函数）。
- **services**：`acodeAgentService.ts` 8 处 facade 改调 `V4_METHODS.*` + v4 result schema。

## 3. 不变量

1. **路径穿越防线**：`workflows/delete`、`workflows/get`、`workflows/move` 先 `isValidSavedWorkflowName` 验名再拼路径；协议不收路径、不接受 `..`。
2. **move 不覆盖**：目标已存在即拒绝（`target_exists`）；只全局→项目一向，无 `to` 参数。
3. **scope 定向**：中枢永远传定向 scope 扫目录（两根 first-wins 会把 global 混进 project 组）；缺省 `project`；`global` 时 `workspace` 只是载体运行时。
4. **runs 分页**：limit ∈ [1,50] 服务端钳制；多取一条判 `truncated`；journal 缺席回空页不抛错。
5. **skills authority**：带 `sessionId` 必须命中 resident Session（fail closed，禁止回退 workspace 目录把新 Skill 泄漏进旧对话）；bundled 技能包不进引用面板。
6. **mcp trust gate**：`mcp/list` 与 `resolveAppRuntimeConfig` 共用同一对 gate helper（H2 修复，不持有第二份「空集」真值）；`mode=status` 不触发 replace 收敛（OAuth 轮询隔离）。
7. **v4 不反向 import legacy barrel**：`acode-protocol-v4/*.ts` 只从 `acode-protocol-shared.js` / `acode-protocol-legacy-types.js`（workspace ref 先例同 transport.ts）取中性零件。
8. **失败语义**：workflows 域的 resolve/IO 失败走 result 内 `ok:false + reason` 判别联合，**不抛协议错误**；mcp/skills 参数非法走 `-32602`（parseParams 既有行为）。

## 4. 失败语义与版本偏斜

- **skew 方向**：本批 8 方法无 pre-v4 旧 Agent 兼容重试需求（对照 M2-1 保留 sessionSetThoughtLevel 的特例——那是 createSession 对 pre-v4 Agent 的直发重试）。host 与 CLI 同版本发布；v4 方法名本身就是版本边界，旧 CLI 没有这些方法即 skew 不支持的方向（与 usageStats 迁移同判：services 切 v4 后旧词消费清零）。legacy dispatch case 随之删除（M2-1「消费归零后删除」先例）。
- **mcpList 兼容重试退役**：services 侧 `unrecognizedKeys → omit mode/mcpServers 重试` 是 legacy strict-parse 旧 Agent 的偏斜兼容；v4 方法天然全新，该重试链不迁。`ACodeAgentMcpStatusModeUnsupportedError` 保留（仍被抛出点之外的代码引用时另议——若归零则随 dead code 清理；实测确认后在本节记录）。
- **超时重试保留**：`mcp/list` / `pluginsList` 的超时-回收-重试（stale client 语义）与方法名无关，迁 v4 后保留。

## 5. 迁移边界

**做**：8 方法的 v4 schema + CLI 实体迁移 + dispatch 换名 + services 8 处切换 + 协议单测。

**不做**：
- 不删 legacy schema（`acodeWorkflows*` 等常量和 `acodeProtocolMethods` 词表条目留在 legacy barrel——M2-1 同款纪律，M4 统一删 barrel）。
- 不动 `workflow-runs*.ts`（会话内执行面）。
- 不动 UI（`packages/ui/**` 经 services facade 消费，载荷同形，无感）。
- 不动 core 的 store/journal 实现。
- `apps/acode-cli/tests/**` 只在既有测试引用被删符号时配套修正（实测：无引用，见 §7）。

## 6. 冒烟与验收

本批 8 方法**不在** 13 个 stream/snapshot/queue 高危名单（subscribe/send/stop/cancelBackgroundTask/fork/compact/create/resume/read/messages/events/goal/close）。按纪律执行：单链路功能测试 + 单测。

验收场景：
1. 已保存工作流 CRUD（list/get/updateMeta/delete）+ move + runs 列表：协议单测钉 schema parity；CLI 实体逻辑逐字迁移，行为不变。
2. skills catalog：session/workspace 双 authority 语义不变；bundled 过滤不变。
3. MCP server 列表：connect/status 双模式 + trust gate + OAuth 轮询隔离不变。
4. `git grep "acodeProtocolMethods\." -- packages/services/src | wc -l`：72 → **64**（−8）。
5. legacy dispatch 8 case 删除；三个 legacy 实现文件删除。
6. 新协议单测全绿；shared/services/bootstrap 受影响套件全绿；typecheck 零错误。

## 7. 批次记录（2026-10-28 落地）

- `acodeProtocolMethods.` 消费：HEAD 基线 72；本批 8 方法消费 **9 → 0**（mcpList 占 2 行：请求 + `isProtocolRequestTimeout` 的方法名匹配，均已切 `V4_METHODS.mcpList`）。本批独立口径 **72 → 63**（优于批次预估的 −8/→64，差异即 mcpList 的第二行）。
  - HEAD 证据：`git grep -E "acodeProtocolMethods\.(workflowsList|workflowsGet|workflowsUpdateMeta|workflowsDelete|workflowsRuns|workflowsMove|skillsReferenceCatalog|mcpList)" HEAD -- packages/services/src` = 9 行；工作树同 grep = **0** 行。
- legacy 三实现文件（`saved-workflows.ts` / `skill-reference-catalog.ts` / `mcp.ts`）实体迁入 v4 目录（`saved-workflows-hub.ts` / `skills-reference-catalog-query.ts` / `mcp-list-query.ts`）后删除；`server.ts` 8 个 legacy case 删除、8 个 v4 case 新增（sessionHeaderMeta case 之后，usageStats 同款直派）。
- services 侧 mcpList 的 unrecognizedKeys 兼容重试链退役（v4 方法名即版本边界）；超时-回收-重试保留；`ACodeAgentMcpStatusModeUnsupportedError` 类与 services 导出保留（UI `McpSettingsSection.tsx` 仍 import 该符号，本路径不再抛出）。
- 实测门禁：shared 449/449；services 578 pass/0 fail/7 skipped；CLI 耦合套件 20 个文件 134 pass/0 fail/2 skipped（project-mcp×2、config-mcp、skill×8、script-workflow×2、protocol-server 耦合×5、v4/protocol×3）；protocol-boundary 17/17（含本批新增 4 用例）。
- typecheck：shared `tsc -b` 0 错；services `tsc --noEmit` 0 错；bootstrap `tsc --noEmit` 仅剩兄弟批次在途文件错误（M2-5 plugins-management.ts），本批文件零错误。
- architecture `--changed`：本批文件零 new/regrown（报告的 5 项 new 全部归属兄弟批次在途文件：M2-5 plugins.ts/plugins-management.ts，M2-2 command.ts/transport.ts 的 acodeSessionGoalSchema 白名单）。
- 冒烟说明：本批 8 方法不在 13 个 stream/snapshot/queue 高危名单；单链路功能验证 = 协议单测 parity 钉住 + 实体逐字迁移 + 受影响套件全绿（M2-1 同款替代口径）。
