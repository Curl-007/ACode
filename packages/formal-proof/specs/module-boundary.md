# formal-proof module boundary

## Scope

`packages/formal-proof` 是 ACode 输入裁决模型的形式化证明可视化应用：`model.ts`
以纯函数裁决表枚举「产品上下文 × 候选输入 → 裁决」的全部组合并构建 trace 树，
`main.ts` 用 d3 渲染证明图（vite 应用）。本 spec 登记其纳管为架构模块（managed，
ARCH-04 batch 2）：公开契约、状态所有权、依赖方向与验收场景。纳管批次不改变任何
运行时行为与包导出面。

## Ownership and invariants

- owner：`formal-proof-model`。
- `model.ts` 是裁决事实来源：`evaluate` 纯函数，同一 (context, candidate) 恒得
  同一 Decision；held 状态输入不静默入队（DecisionKind 显式区分
  allow/reject/enqueue/choice/system/undefined）。
- 模型唯一可变状态是 trace 节点编号计数（`nextNodeId`/`nextCaseId`）；
  `buildTraceTree` 入口先 `resetIds()`，同一输入产出确定的节点编号。
- apps/acode-cli bootstrap 的裁决投影（`projection-state.ts`）以注释声明与
  evaluate 逐条对齐：对齐方向单向——model.ts 是事实来源，bootstrap 是消费投影，
  本模块不反向依赖 CLI。

## Public boundary

- 包导出只有 `./model`（`@acode/formal-proof/model` → `src/model.ts`），无 "."
  根导出；`src/contract.ts`（治理登记面，逐名转发 model.ts）与 `src/model.ts`
  同时登记为 publicEntrypoints。`main.ts`/`styles.css` 是 vite 应用内部实现，
  不出包、不入契约，跨模块 deep import 会被 architecture checker 拒绝。
- `model.ts` 是 920 行的入口文件——不触发 max-contract-lines：该规则只匹配
  basename 以 `contract.` 开头的文件（scripts/architecture/index.mjs:178，纳管前
  已核对源码）。contract.ts 本身只有转发语句。
- 全仓当前无源码以包名 import 本模块（bootstrap 只有注释级对齐声明）。

## Dependency direction

- 允许：仅 `d3`（渲染，main.ts 内部）。零 workspace 依赖（requires: []，与
  module.ts 清单一致）。
- 禁止：formal-proof 依赖任何 workspace 模块；任何模块 deep import main.ts。
- 层：单层 `app`（`layers: { app: "." }`）——main.ts 直接持有 DOM/d3 渲染；
  model.ts 虽是纯计算，但两文件同层无方向约束需求，不引入 domain 层声明。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：formal-proof 在
   managed 语义下，除已登记例外 `onboard-formal-proof-over-limit`（max-file-lines，
   `main.ts` 905 行 / `model.ts` 920 行，expires 2026-12-31）外零违规；到期前
   必须拆分收回 400 行上限并移除例外，`.architecture-baseline.json` 不动。
2. `node scripts/architecture/architecture-check.mjs context formal-proof` 展示
   owner `formal-proof-model`、module.ts 与 contract.ts。
3. 包导出面（./model）与纳管前逐名一致；本包无 test 脚本，模型回归由
   apps/acode-cli bootstrap 的对齐注释与可视化应用人工验证承担。
4. `pnpm --filter @acode/formal-proof typecheck`（`tsc -p tsconfig.json --noEmit`，
   不在根 `pnpm typecheck` 工程名单内）通过；`contract.example.ts` 随包工程一起
   编译（纯计算，仅编译与文档验证）。
