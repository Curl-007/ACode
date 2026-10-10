# architecture-contracts-module

`@acode/contracts`（`apps/acode-cli/packages/contracts/src`）纳管为架构模块 `acode-cli-contracts` 的边界规格。对应 `docs/project-review-2026-10-08.md` ARCH-04：该包此前 `managed: false`，`pnpm architecture:context acode-cli` 误把 `src/tools/contract.ts`（工具声明契约）当作包的架构契约；本规格落地真实的模块契约面并把存量债务显式登记。

## 模块所有者

- 模块 id：`acode-cli-contracts`；owner：`cli-contracts`。
- 唯一职责：CLI 各包（bootstrap/core/cli/node-repl-host/plugins 等）与 Desktop/Web 宿主共享的**类型与纯函数契约**。不含 IO 实现、不持有运行时状态（`node:async_hooks`、`node:net` 等仅出现在类型/上下文工具面，因此模块只声明单一非 domain 层 `app`，不声明 domain 层以免 domain-io 规则误报）。

## 公开契约面（publicEntrypoints）

| 入口 | 角色 |
| --- | --- |
| `src/contract.ts` | 模块架构契约：策展的稳定公开面（纯 re-export，≤300 行，无 >12 方法的接口）。 |
| `src/index.ts` | 包主入口（package.json `exports["."]`），761+ 处 `@acode/contracts` 导入解析到这里。 |
| `src/plugins/index.ts` | package.json `exports["./plugins"]`；`cli/src/plugin-host-command.ts` 依赖。 |
| `src/tools/node-repl.ts` | package.json `exports["./tools/node-repl"]`；`node-repl-host/src/server.ts` 依赖。 |

`./plugins` 与 `./tools/node-repl` 两个子路径是**合法包导出**，因此按入口登记，而不是改调用方。其余 package.json 子路径（`./browser-control`、`./mcp` 等）映射到 `dist/interfaces/*.port.js`，架构检查器按 `src/<subpath>` 朴素解析不到源码文件，不构成 deep-import 边；调用方均位于 legacy 模块，不产生 `unresolved-workspace-import`。

注：`src/tools/contract.ts` 是工具声明面的领域文件，不是模块契约；模块契约固定为根 `src/contract.ts`。

## 依赖方向

- `requires: [shared]`：contracts 只导入 `@acode/shared` 及其子路径（`workspace-hook-trust-store-file`、`model-selection`、`model-config`、`acode-protocol-v4`）与外部包 zod / zod-to-json-schema。已核实**不**导入 `@acode/shared-types` 或 apps/acode-cli 下其他包（不需要 `acode-cli`；对照 `workflow-run-read` 的 `requires: [acode-cli, acode-cli-contracts]` 是因为它反向消费 CLI 包）。
- `provides: [cli-contracts]`。
- 模块内部为文件级 DAG（`forbidCycles` 对 managed 模块按文件粒度执行，type-only import 与 `import("…")` 类型引用都算边）。为断环引入的叶子文件：
  - `interfaces/session-shared.ts`：CollaborationMode/RiskLevel/TurnSteer*/TurnInputIntentMetadata（ModelSelection 直接取自 `@acode/shared/model-selection`，避免回边）；
  - `telemetry/observations.ts`：ModelApi* 观测类型（telemetry ↔ model 互指的断点）；
  - `model/protocol-types.ts` + `model/request-status.ts`：model/index.ts 中被 model.ts、invocation-context.ts、telemetry/index.ts 反向引用的定义下沉；
  - `tools/todo-confidence-gate.ts`：todo ↔ todo-deps ↔ todo-confidence 环的门槛函数层；
  - `interfaces/dynamic-workflow-run-error.port.ts`：dwr.port ↔ workspace.port 环的共享错误类型。
  所有搬移都在原文件保留 re-export，包公开导出面逐名不变。

## 存量例外（本批登记，偿还计划随后批次）

`architecture-policy.yaml` `exceptions:` 以 `contracts-onboarding-*` 前缀登记，`expires: "2026-12-31"`：

- 11 条 `max-file-lines`（>400 行存量文件）：events/session.events.ts、interfaces/session-store.port.ts、model/index.ts、interfaces/dynamic-workflow-run.port.ts、workflow/index.ts、events/event-reducer.ts、interfaces/browser-control.port.ts、tools/create-workflow.ts、tools/target.ts、config/index.ts、hooks/index.ts。
- 6 条 `disable-count`（文件头 `eslint-disable max-lines`）：event-reducer.ts、session.events.ts、browser-control.port.ts、session-store.port.ts、model/index.ts、workflow/index.ts。

偿还意图：后续批次按职责拆分上述文件（拆分后删除对应例外），到期前未偿还则例外过期即失败（expired-exception），迫使显式决策。`max-file-lines`/`disable-count` 是仅有的两条可例外规则；cycle/deep-import/max-contract-lines 不可例外，本批已实修。

## 验收

1. `node scripts/architecture/architecture-check.mjs check`：`acode-cli-contracts` 零违规（cycle 全断、deep-import 被入口覆盖、例外登记生效）。
2. `node scripts/architecture/architecture-check.mjs context acode-cli-contracts`：显示根 `src/contract.ts`、owner、requires。
3. `pnpm --filter @acode/contracts typecheck` 与 `pnpm --filter @acode/contracts lint` 通过；包公开导出面不变（消费方零改动）。
4. `architecture-policy.yaml` 只改 `acode-cli-contracts` 条目与 `exceptions` 追加；不触碰 `.architecture-baseline.json`，不运行 `baseline:update`。
