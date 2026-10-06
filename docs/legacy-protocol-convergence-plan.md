# Legacy ACode Protocol 收敛时间表

> 生成日期：2026-10-05。行号与计数以 dev/0.0.4 当日检出实测为准（`wc -l` / `git grep`），实施前按文件名+符号名复核。
> 本文是 2026-10-05 深度审查 P1 建议「明确 legacy 协议删除时间表」的落地件。与 [AGENTS.md](../AGENTS.md) 冲突时以 AGENTS.md 为准。

## 现状：三代协议面并存

| 协议面 | 位置 | 规模（实测） | 状态 |
| --- | --- | --- | --- |
| legacy 协议 schema | `packages/shared/src/acode-protocol/index.ts` | 3,714 行、约 257 个导出 | 头注已声明删除边界：「上述旧协议 client/server 组删除时，本文件整体删除」 |
| legacy 协议 server | `apps/acode-cli/packages/bootstrap/src/acode-protocol/` | 48 文件 / 14,713 行 | 与 v4 并存，靠 `v4-bridge.ts` 单向依赖（只允许旧目录 → v4 目录）做 strangler 迁移 |
| v4 协议 | `packages/shared/src/acode-protocol-v4/` + `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/` | shared 侧约 10.8k 行；bootstrap 侧 51 文件 / 21,737 行 | 目标形态，263 个文件已引用 v4/V4_METHODS |
| （相关面）ACP 适配 | `apps/acode-cli/packages/cli/src/acp/` | 约 1.8k 行 | 独立对外协议面，不在本收敛范围，但依赖 v4 gateway，M3 需一并回归 |

混合调用的直接证据：`packages/services/src/acode-agent/acodeAgentService.ts` 同时调用 legacy `acodeProtocolMethods.*` 与 `V4_METHODS.*`；`v4-bridge.ts` 头注列出的过渡钩子（`ensureModelReady` / `afterLegacyStateMutation` / `closeSession` / `createSessionRecord` / child record registration / `resumePersistedSession`）全部注入旧协议实现，「随旧协议一同删除」。

## 调用方清单（git grep 实证，2026-10-05）

**services 侧（legacy 方法契约消费方，7 个文件）**——`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src`：

- `acode-agent/acodeAgentProcessManager.ts`
- `acode-agent/acodeAgentService.ts`
- `acode-agent/acodeProtocolClient.ts`（legacy 客户端本体）
- `acode-agent/independentPlanSupport.ts`
- `acode-agent/pluginReferenceCatalogRequest.ts`
- `node.ts`（组合根装配）

**UI 侧（旧投影读路径，8 个文件）**——`git grep -l "acodeSessionProjection" -- packages/ui/src`：

- `components/workflow-timeline/WorkflowRunSettingsPopover.tsx`、`subagent-model-label.ts`、`workflowRunSettings.ts`
- `hooks/useActiveTaskSnapshotMeta.ts`、`hooks/workspacePrepareRpc.ts`
- `settings/AutomationEditView.tsx`、`settings/SubagentsSection.tsx`
- `v4/SessionPane.tsx`

**CLI 侧**：legacy server 目录自身（48 文件）+ `v4-bridge.ts` 过渡钩子。

**冻结规则（自本文落地起生效）**：新命令、新事件、新 schema 只进 `acode-protocol-v4/`；legacy 面只允许删减与缺陷修复，不允许新增导出。承重类型继续留在 `acode-protocol-legacy-types.ts` 直至 M4 甄别。

## 里程碑

每个里程碑的验收都必须包含：对应 grep 归零命令 + `pnpm typecheck` + `pnpm test`（全仓）+ `pnpm architecture:check`；超限文件数下降时运行 `pnpm architecture:baseline:update` 收紧 ratchet 基线。

### M1 — UI 旧投影收口（可与 M2 并行）

- 内容：8 个 UI 消费文件从 `acodeSessionProjection` 读路径迁到 v4 snapshot/query 投影（`taskQueryCacheStore` / v4 conversation projection store 已有承接面）。
- 验收：`git grep acodeSessionProjection -- packages/ui/src` 归零；`pnpm --filter @acode/ui test` 绿。
- 风险：SessionPane.tsx 本身是 3,629 行上帝组件（带 max-lines 豁免），改动面大；迁移时不得顺手重构，只换投影读路径。

### M2 — services 双栈调用切换（可与 M1 并行）

- 内容：`acode-agent/` 6 文件的 legacy 方法调用逐个迁到 V4_METHODS；`acodeProtocolClient.ts` 退役；`node.ts` 装配同步收口。
- 验收：`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src` 归零；services/desktop 测试绿。
- 风险（AGENTS.md 要求）：`desktop-continuous` 与 `web-remote-replayable` 两种语义必须同时验证——迁移触及 stream/snapshot/queue 时，本地窗口链路与手机远控恢复链路各跑一遍真实冒烟；owner/lease 与 stale run 防护不得因改名/换路径被绕过。

### M3 — 删除 CLI legacy 协议 server（依赖 M2）

- 内容：删除 `bootstrap/src/acode-protocol/` 48 文件；`v4-bridge.ts` 的过渡钩子内联进 v4 gateway 后删除桥文件；services 作为对端已在 M2 切换，此步是纯删除。
- 验收：目录与桥文件删除；CLI 测试套件绿（当前基线 980）；`acode acp` 冒烟通过（ACP 面依赖 v4 gateway）；desktop 端到端冒烟（起窗口、跑一轮对话、恢复会话）。
- 风险：`server-operations.ts`（3,973 行）内如有仍被 v4 复用的纯函数，先搬进 v4 目录再删（依赖方向只允许旧 → v4，搬运不违反）。

### M4 — 删除 shared legacy 协议文件（依赖 M1+M2+M3）

- 内容：整删 `packages/shared/src/acode-protocol/index.ts`（3,714 行）；甄别 `acode-protocol-legacy-types.ts` 承重类型（迁 v4 或独立命名保留）；同步清理 legacy 词表残留 schema。
- 头注既有约束：「外部零消费 schema 多为存活 schema 联合的内部依赖，随宿主文件一起处理，勿单删」——删除以文件为单位，不做单导出抠除。
- 验收：文件删除；全仓 typecheck + 全部测试绿；knip exports backlog 相应缩减；AGENTS.md 协议条目移除 legacy 文件引用。

## 进度指标（每次发布级验证时更新）

| 指标 | 2026-10-05 基线 | 目标 |
| --- | --- | --- |
| services legacy 消费文件数 | 7 | 0（M2） |
| UI 旧投影消费文件数 | 8 | 0（M1） |
| bootstrap legacy server 文件数/行数 | 48 / 14,713 | 0（M3） |
| shared legacy 协议文件行数 | 3,714 | 0（M4） |
| v4-bridge 过渡钩子数 | 6（见桥头注） | 0（M3） |
