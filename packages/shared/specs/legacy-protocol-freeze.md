# Legacy protocol barrel freeze（冻结面守护）

## Scope

`packages/shared/src/acode-protocol/index.ts` 是 legacy ACode Protocol 的 barrel，
2026-10-05 起冻结，按 [docs/legacy-protocol-convergence-plan.md](../../../docs/legacy-protocol-convergence-plan.md)
的里程碑（M1–M4）整体退役。本 spec 登记该冻结规则、2026-10-22 review 查实的违规修复
（R2-02、dontAsk），以及机械守护门禁。与 AGENTS.md / architecture-policy.yaml 冲突时以后者为准。

## 冻结规则（单一事实源：收敛计划第 37 行）

- **只删不增**：legacy 面只允许删减与缺陷修复，**不允许新增导出**。
- 新命令、新事件、新 schema **只进** `src/acode-protocol-v4/`。
- v4 命令校验仍需的兼容载荷（MCP server / browser ambient context / MCP 熔断挂起等
  wire 契约）落在**中立叶子** `src/acode-protocol-shared.ts`——该叶子对 legacy barrel
  与 v4 目录双向零依赖（M2-B 纪律），M4 删 barrel 时 v4 不形成反向依赖、不被迫回迁。
- legacy barrel 对中立叶子的符号只做 `export { ... } from "../acode-protocol-shared.js"`
  **纯 re-export**，不得出现 `export const ...Schema` 本地定义。

## R2-02：MCP 熔断挂起 schema 外移（2026-10-22 修复）

- **违规**：提交 `43afaba1`（2026-10-19，冻结日之后）在 legacy barrel 新增
  `export const acodeMcpReconnectSuspensionSchema` + 类型 `ACodeMcpReconnectSuspension`。
  虽动机是修 strict schema 拒收的缺陷（correctness fix，spec
  `apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md` R2.3），但**新 schema 定义不应
  落在冻结 barrel**，违反「只删不增」。
- **修复**：schema 与类型定义迁入中立叶子 `src/acode-protocol-shared.ts`（与既有
  MCP server / browser ambient context schema 同一落点）；barrel 改为纯 re-export +
  内部 `import`（`acodeMcpServerStatusSnapshotSchema` 仍在本文件消费它，故保留 import
  绑定，只删本地 `export const` 定义）。
- **v4 面判定**：该字段只在 legacy `mcp/list` wire 上流转（CLI live status → 设置页），
  **v4 无 mcp/list 契约**，故不新增 v4 命令/schema（review 明令「不自行往 v4 加未被
  消费的命令」）。将来 offPeak/mcp 域 v4 化时，v4 命令直接从中立叶子取本 schema，无需回迁。
- **consumer API 不破**：`src/mcp.ts:7`（type import）、UI `McpFailurePresentation.tsx:2`
  从 `@acode/shared` 根入口取 `ACodeMcpReconnectSuspension`——根入口 `src/index.ts:87`
  `export * from "./acode-protocol/index.js"` 仍转发该符号，import 路径逐字不变。

## dontAsk 值域扩张（2026-10-22 review §2 第二条处置）

- **事实**：提交 `1272746b`（2026-10-17）把 `acodeOffPeakPermissionModeSchema` 值域从
  `["build","edit","plan","yolo"]` 追加 `"dontAsk"`。查证：这是**新语义**（P1 权限裁决
  批 2 引入的「无人可问 → 未白名单即拒」产品档位，commit message 明载「dontAsk 全链贯通」），
  非既有值域的缺陷修复。
- **不构成 v4/legacy 分叉**：`dontAsk` 在同一提交批次已进入 v4——
  `src/acode-protocol-v4/submission.ts:6` `submissionModeSchema` 与
  `src/acode-protocol-v4/command.ts:234` collaboration mode enum 均含 `dontAsk`，
  值域与 legacy offPeak 枚举一致（`["build","edit","plan","yolo","dontAsk"]`）。
  offPeak permissionMode 本身**在 v4 无对应命令**（offPeak create/list 尚无 v4 契约，
  收敛计划第 92-94 行已承认）；故 v4 侧无「offPeak 专属枚举」可与 legacy 分叉。
- **登记**：legacy 值域扩张与 v4 submission/collaboration 值域**同源同集**，无双源真相。
  offPeak 域 v4 化时，permissionMode 应复用 v4 的 mode 枚举（submissionModeSchema），
  不得另建第二份五档词表。

## 守护门禁

`test/legacy-protocol-barrel-freeze.test.ts`（配 `test/legacy-protocol-barrel-schema-baseline.json`
冻结基线，2026-10-22 R2-02 修复后生成，246 个定义）：

1. 提取 barrel 内 `export const ...Schema` 本地定义集合，断言**是冻结基线的子集**
   （只删不增；子集关系同时捕获「删一加一」漂移，比计数更严）。
2. 钉住 `acodeMcpReconnectSuspensionSchema`：barrel 不得本地 `export const`，必须以
   `export { ... } from "../acode-protocol-shared.js"` re-export；类型定义同步外移。
3. 中立叶子承载唯一定义，且叶子对 legacy barrel / v4 目录零 import（M2-B 纪律）。

基线只在**合法删减**（M1–M4 退役）或经 review 批准的外移后更新，更新即收紧；
新增定义一律走中立叶子或 v4，不改基线。

## Acceptance scenarios

1. `pnpm --filter @acode/shared test` 全绿，含 `legacy-protocol-barrel-freeze.test.ts`。
2. `node scripts/architecture/architecture-check.mjs check`：shared 零新违规
   （cycle、deep-import 全绿；v4 → legacy 反向依赖仍被拒）。
3. `git grep -cE "^export const [A-Za-z0-9_]+Schema" packages/shared/src/acode-protocol/index.ts`
   不高于冻结基线（当前 246）。
