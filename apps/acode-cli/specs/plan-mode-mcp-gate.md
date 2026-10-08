# Plan 模式 MCP 工具放行门（plan-mode MCP gate）

安全修复 H1。定义 plan 模式下 MCP 工具（`permission.permission === "mcp"`）的放行边界：
plan 是「只读调研」模式，MCP 工具只有同时满足全部安全属性才可免审批执行，任何一个
属性不满足即走 plan 的既有拒绝路径（`mode.plan.nonReadOnly`）。

## 背景与根因

`packages/core/src/permission/service.ts` 的 `checkPlanMode` 原有 `mode.plan.mcp` 分支只判
`permissionName === "mcp" && !destructive` 即放行，不看 `needsApproval` / `riskLevel` /
`sideEffectScope`。而 MCP 桥（`packages/core/src/mcp/index.ts`）的三个事实让该分支失效：

1. `destructive` 取自服务端**自报**的 `annotations.destructiveHint === true`——缺省
   fail-open：第三方 MCP server 不声明 destructiveHint 就是「非破坏」。
2. 宿主 `node_repl` 的 `js` 工具被桥明确标注 `sideEffectScope: "system"`、
   `riskLevel: "high"`、`needsApproval: true`（它能执行本机任意 Node 代码）。
3. 桥把所有 MCP 工具的 permission 名固定为 `"mcp"`。

结果：官方默认启用的 `mcp__node_repl__js`（以及任何不自报 destructiveHint 的第三方
MCP 工具）在「只读」plan 模式下**免审批执行任意代码**——plan 的只读承诺被击穿。

对照面：原生 `node_repl` 工具（permission 名 `node_repl`，非 `"mcp"`）在 plan 下本来就被
`mode.plan.nonReadOnly` 拒绝。同一个能力经 MCP 桥投影后反而放行，是路径不一致漏洞。

## 产品规则

- **R1 放行条件收紧**：`mode.plan.mcp` 分支放行当且仅当同时满足
  `!destructive && !needsApproval && riskLevel !== "high" && riskLevel !== "critical"
  && sideEffectScope !== "system"`。
  - `critical` 与 `high` 一并拒绝：`RiskLevel` 含 `"critical"`（严于 high），只拒 high
    会造成严重度倒挂（更危险的等级反而放行）。
  - 任一条件不满足 → 落入 plan 既有拒绝路径 `mode.plan.nonReadOnly`（plan 无 ask 档，
    与 plan 的其余非只读工具同语义）。
- **R2 只读 MCP 不受影响**：`annotations.readOnlyHint === true` 且非破坏的 MCP 工具走
  `mode.plan.readOnly` 分支（本 spec 不改该分支），plan 下照常放行——「普通只读 mcp
  仍放行」。
- **R3 经桥投影的现实语义**：MCP 桥对全部工具硬编码 `needsApproval: true`
  （外部 server 执行，最低审批档），因此 R1 落地后**经桥注册的 MCP 工具在 plan 下
  要么按 R2 只读放行、要么被拒**；`mode.plan.mcp` 分支仅对显式携带更宽松 capability
  的调用方（非桥路径）保留，且必须满足 R1 全条件。
- **R4 路径一致性**：宿主 `node_repl` `js` 能力无论以原生工具（permission 名
  `node_repl`）还是 MCP 投影（`mcp__node_repl__js`，permission 名 `mcp`）出现，plan
  下结论一致：拒绝。
- **R5 判定风格对齐 build 分支**：条件逐项显式合取（同 `checkBuildMode` 的
  readOnly/sessionState 分支风格），不引入辅助状态；`isMcpToolCapability` 仍是
  permission 名的唯一判定点。

## 状态所有者与接口

- 唯一决策点：`PermissionService.checkPlanMode`（`packages/core/src/permission/service.ts`）。
  capability 字段解析仍由 `resolveCapability` 单一收口（`permission.*` 优先于顶层字段），
  本修复不改解析链，只改 plan 分支的合取条件。
- 不新增接口、不新增事件；决策结果的 `ruleId`（`mode.plan.mcp` /
  `mode.plan.nonReadOnly`）保持既有词表。

## 验收场景

见 `apps/acode-cli/tests/permission-plan-mcp-gate.test.mjs`：

1. plan 下 `node_repl js` 形状的 MCP capability（`needsApproval: true`、`riskLevel: "high"`、
   `sideEffectScope: "system"`、非 readOnly）→ deny（`mode.plan.nonReadOnly`）。
2. 单独触发任一收紧条件（仅 `needsApproval`、仅 `riskLevel: "high"`、仅
   `riskLevel: "critical"`、仅 `sideEffectScope: "system"`）→ 全部 deny。
3. 全部条件满足的低风险 MCP capability（非 readOnly、low、network、无审批、非破坏）
   → allow（`mode.plan.mcp`，分支保留证明）。
4. 只读 MCP capability（readOnly、非破坏，即使 `needsApproval: true`）→ allow
   （`mode.plan.readOnly`，R2）。
5. 经 `registerMcpTools` 真实桥注册的 `node_repl/js` descriptor，按 executor 同款
   capability 组装（`{ ...entry.metadata, permission: entry.permission }`）在 plan 下
   → deny；readOnlyHint 工具 → allow（端到端链路钉）。
6. build 模式行为不变（对照：同 capability 在 build 下走 ask/allow 既有分支）。

## 关联

- `specs/builtin-subagent-catalog.md` 附注 6（plan 地板实测结论）：其中「plan 只读」
  意图自本 spec 起对 MCP 工具同样成立（此前 MCP 非破坏即放行是地板上的洞）。
- `specs/project-permission-restrictive-floor.md`：项目配置只能收紧的同一哲学——
  自报注解（destructiveHint）不得成为放宽依据。
