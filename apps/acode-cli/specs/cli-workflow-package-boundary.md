# @acode/cli-workflow 包边界（W1-R3 物理拆包）

状态：已实施（W1-R3 实施批，2026-10-09）。前置：W0（workflow-wiring / workflow-app-facade）、
W1-R1（`@acode/workflow-run-read`）、W1-R2（`@acode/workflow-run-command`）已落地，
见 `bootstrap-app-boundary.md`。本 spec 定义 workflow 引擎族迁出 bootstrap 的目标形态、
所有权、依赖方向与验收；实现不得偏离本文件，偏离前先改 spec。

## 目标

把 `packages/bootstrap/src/app/` 的 workflow 引擎族（约 62 文件 / 15.7k 行）物理迁入新包
`@acode/cli-workflow`（`apps/acode-cli/packages/cli-workflow`），并登记为受管架构模块
`acode-cli-workflow`。bootstrap 只保留装配接缝，经包名公开入口消费引擎。

## 迁移范围

**迁入新包（引擎族）**：

- `dynamic-workflow-run-*` 全部 17 个文件（launch/launch-anchor/submit/service/lifecycle/
  replay/roster*/observation/introspection/reconcile/retune/compile/progress-sink/
  sequence-capture）；
- `workflow-driver*` 全部 12 个文件；
- `script-workflow-*` 中除 `script-workflow-methods.ts` 外的 14 个文件；
- `workflow-*` 中除 `workflow-wiring.ts`、`workflow-app-facade.ts`、`workflow-facade.ts`、
  `workflow-methods.ts` 外的 13 个文件（actor-model/actor-tools/actor-transcript/
  artifact-publish/ask-epilogue/concurrency-ceiling/concurrency-governor/escalation-registry/
  run-control/seat-gate/worktree-manager/world-read/git-world-read）；
- `dynamic-workflow-import.ts`、`dynamic-workflow-snippet-service.ts`、
  `dynamic-workflow-gate.ts`。

**留在 bootstrap（装配接缝，经包名引用引擎）**：`create-app.ts`、`workflow-wiring.ts`、
`workflow-app-facade.ts`、`workflow-facade.ts`、`workflow-methods.ts`、
`script-workflow-methods.ts`、`types.ts` 及其余非 workflow 文件。接缝文件是 ACodeApp
表面与引擎之间的适配层：它们拥有能力门控与 ACodeApp 成员实现，不拥有 run/journal/owner
状态（与 W0/W1-R2 边界一致）。

## 所有权与公共接口

- 新包拥有：DWF run 应用服务（launch/submit/lifecycle/replay/roster/observation/
  introspection/reconcile）、expert workflow driver、Script Workflow 引擎（runtime/
  child-runtime/tool-port/process/replay/reconcile/progress-adapter/meta/format/prepare/
  utils/child-source/run-status/run-summary）、workflow 支撑件（artifact 发布、并发
  governor/ceiling、seat gate、escalation registry、worktree manager、world read、
  snippet/gate/import）。
- 公共入口唯一：`src/contract.ts`（package exports `"."` 与 `"./contract"`，`index.ts`
  仅 `export * from "./contract.js"`）。bootstrap 装配层、legacy `saved-workflows.ts`、
  CLI 测试是唯一消费方，一律经包名入口，不得深导入。
- 新包不拥有：会话/runtime 事实（`@acode/core`）、journal 存储（`@acode/adapters`）、
  run 读模型（`@acode/workflow-run-read`）、三条跨边界命令顺序（`@acode/workflow-run-command`）、
  ACodeApp 能力门控（bootstrap facade）。不新建第二份 run 表、journal 或 owner 状态。

## 依赖方向

新包允许依赖：`@acode/contracts`、`@acode/core`、`@acode/adapters/*`、
`@acode/dynamic-workflow`、`@acode/dynamic-workflow-runtime`、`@acode/shared/*`、
`@acode/workflow-run-read/contract`、`@acode/workflow-run-command/contract`、`meriyah`、
node builtins。**禁止**依赖 `@acode/bootstrap` 或以相对路径 reaching bootstrap 源码；
禁止反向依赖（新包不得出现在 workflow-run-read/command 的依赖中）。

## 宿主类型解耦（不得反向依赖 bootstrap）

1. `PrepareUserExecutionBoundary`：函数类型在新包 contract 中定义
   `(options?: { abortSignal?: AbortSignal; traceContext?: TraceContext }) => Promise<void>`；
   bootstrap `types.ts` 改为 re-export 该定义，保持全仓单一定义。
2. `ACodeAppOptions`（仅 `script-workflow-child-runtime.ts` 消费）：新包定义结构化窄类型
   `ScriptWorkflowHostOptions`，只声明 child runtime 实际读取的字段；bootstrap 的
   `ACodeAppOptions` 必须保持可赋值（结构化兼容），不改 bootstrap 字段。
3. `DYNAMIC_WORKFLOW_SKILL_NAME`：常量移入新包公开面；`bundled-skills.ts` 从
   `@acode/cli-workflow/contract` 导入（bootstrap → 新包方向合法）。
4. `parseProviderQualifiedModelSelection`（child-runtime、actor-model 消费）：优先下沉到
   `@acode/contracts` 或 `@acode/shared/model-selection`（纯函数、无 bootstrap 耦合时）；
   否则移入新包公开面，bootstrap `provider-registry-selection.ts` 改为 re-export。
5. `collectDisabledPaths`（`../skill-command-overrides.js`，仅 child-runtime 消费）：若
   `skill-command-overrides.ts` 无 bootstrap 内部耦合则整体移入新包并由 bootstrap
   re-export；否则以依赖注入（deps 字段）传入 child runtime。

## 解环（managed 模块 cycle 不可豁免，迁移中必须消除）

1. `DynamicWorkflowRunServiceDeps`（现 `dynamic-workflow-run-service.ts:174`）移入中立
   类型文件 `dynamic-workflow-run-deps.ts`；service/launch/submit 改为从该文件导入，
   消除 launch↔service、service↔submit、compile→launch→service→submit→compile 环。
2. `ActorSessionQuiescence` 类型从 `workflow-driver-quiescence.ts` 移入
   `workflow-driver-types.ts`，消除 quiescence→helpers→types→quiescence 环。
   移动仅限类型；不改运行时语义。

## 治理登记

- `architecture-policy.yaml` 新模块：`id: acode-cli-workflow`，
  `roots: [apps/acode-cli/packages/cli-workflow/src]`，`managed: true`，
  `requires: [shared, acode-cli, acode-cli-contracts, acode-cli-workflow-run-read,
  acode-cli-workflow-run-command]`，`publicEntrypoints: [.../src/contract.ts]`，
  `layers: { app: "." }`（包内含 IO/子进程，不设 domain 层），owner `cli-workflow-engine`。
- 实存例外显式登记（policy `exceptions:`，`expires: "2026-12-31"`，id 前缀 `w1r3-`）：
  迁移时超过 400 物理行的 11 个引擎文件（script-workflow-runtime 866、run-launch 693、
  run-service 679、world-read 638、observation 613、driver 603、run-submit 565、
  dynamic-workflow-import 556、script-workflow-tool-port 556、artifact-publish 550、
  git-world-read 427）登记 `max-file-lines`；带 lint disable 头注的 3 个文件
  （script-workflow-runtime、script-workflow-tool-port、workflow-world-read）登记
  `disable-count`。**不刷新 `.architecture-baseline.json`**；例外到期前由后续批次拆file偿还。
- `knip.jsonc` 按 workflow-run-read 先例登记新包不可达 manifest（module.ts、
  contract.example.ts）。

## 事件顺序与幂等边界

迁移是物理移动 + 解耦，不改任何生命周期语义：reserve → admit → 执行/持久 → 关闭
admission → 取消/排空在飞副作用 → 唯一终态 → 结果/通知 → 释放 owner 的顺序、
DWF journal 幂等、Script attempt/usage 结算、owner lease 行为全部保持既有实现与测试
（W1-R2 的 `port → runtime tracking`、`prepare → runtime → execute` 顺序由
`@acode/workflow-run-command` 冻结，本批不触碰）。

## 验收

1. 新包独立 `typecheck`/`lint`/`build` 绿；bootstrap `typecheck`/`lint` 绿。
2. CLI 全套测试绿（迁移只允许改测试 import 路径，不改断言语义；数量不减）。
3. `bootstrap/src/app/` 不再包含引擎族文件；行数下降约 15.7k。
4. 守护测试扩展：`tests/bootstrap-boundary.test.mjs` 新增——引擎族文件不存在于
   bootstrap；任何包不得深导入 `@acode/cli-workflow/<内部路径>`（仅 `"."` 与
   `"./contract"`）；人为深导入 fixture 使测试红。
5. `node scripts/architecture/architecture-check.mjs check`：新模块 managed 生效，
   0 new / 0 regrown；例外条目与上文清单一一对应。
6. `workflow-run-read-boundary.test.mjs` 等既有边界测试更新路径后保持原断言语义。
7. 根 `pnpm typecheck`、根 `pnpm lint` 不回归；lockfile（根与 apps/acode-cli 两级）
   经真实 `pnpm install` 更新。
