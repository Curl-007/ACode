# bootstrap 包边界与 workflow 应用层独立计划

状态：边界规则已冻结并有守护测试（2026-10-05，深度审查 P2「bootstrap 杂物间化」第一批）；物理拆包为登记的后续里程碑。
守护测试：`tests/bootstrap-boundary.test.mjs`（跨包深导入即红）。

## 现状（2026-10-05 实证）

`@acode/bootstrap`（约 66k 行）内混合三类职责：

| 层 | 位置 | 规模 | 说明 |
| --- | --- | --- | --- |
| 协议服务器（legacy） | `src/acode-protocol/` | 48 文件 / 约 14.7k 行 | 删除边界见 `docs/legacy-protocol-convergence-plan.md` M3 |
| 协议服务器（v4）+ 投影 | `src/acode-protocol-v4/` | 51 文件 / 约 21.7k 行 | 目标形态 |
| **workflow 应用层** | `src/app/`（dynamic-workflow-run-* ×20+、workflow-driver ×16、script-workflow-*、workspace-hook-review-*、session-facade、plugin-runtime 等） | 约 24.9k 行 | 完整的 application service 层，「bootstrap（装配）」名不副实的主因 |
| 装配与杂物 | `src/index.ts`、`src/create-app` 接线、auth-login、custom-commands、sessions、skills 等 | 约 5k 行 | 真正的 bootstrap 职责 |

**跨包边界当下是干净的（本批验证）**：其他 CLI 包对 bootstrap 的引用全部经包名公共导出（`"."`、`"./v4-replay"`，见 package.json exports）；`packages/{cli,adapters,core,dynamic-workflow}` 里出现的 `bootstrap/src/...` 字样全部是注释里的实现位置引用，不是 import。

## 边界规则（本批冻结，守护测试强制）

1. bootstrap 之外任何包不得深导入 `@acode/bootstrap/<内部路径>`（`./v4-replay` 是唯一豁免子路径，与 package.json exports 一致）。
2. 不得以相对路径（`../bootstrap/src/...`）直达 bootstrap 源码。
3. 注释中引用 bootstrap 实现位置时写 `bootstrap/src/<file>`（反引号内），不得写成可解析的 import 说明符形态。
4. `src/app/` 内 workflow 引擎核心（`dynamic-workflow-run-*`、`workflow-driver`）的新增消费方必须经 `src/app/` 内的既有 facade/入口，不得新增从协议层直接 reach-in 的路径。

## 里程碑：workflow 应用层独立成包（后续批次）

- **W1**：把 `src/app/` 的 workflow 引擎族（dynamic-workflow-run-*、workflow-driver、script-workflow-*）迁出为 `@acode/cli-workflow`（或并入既有 `@acode/dynamic-workflow`/`@acode/dynamic-workflow-runtime` 的分工面），bootstrap 保留装配接线。验收：新包 typecheck/lint/test 独立绿；bootstrap 行数下降约 20k；守护测试扩展为「workflow 引擎只能被 bootstrap 装配层与 cli 入口经包名引用」。
- **W2**：legacy 协议 server 随 `docs/legacy-protocol-convergence-plan.md` M3 删除后，bootstrap 收敛为「v4 协议服务器 + 装配」，届时评估改名（bootstrap 名实相符）或并入 cli。
- 顺序约束：W1 依赖 M3 之前也可先行（app 层与 legacy 协议 server 的耦合点仅在 v4-bridge 过渡钩子，迁移时以 facade 隔离）；W2 依赖 M3。

## 为什么本批不做物理拆包

约 24.9k 行、数百个相对 import 的迁移在缺少 CLI 全量 E2E 的当前门禁下无法充分验证（typecheck + 980 单测不能覆盖装配顺序/循环初始化风险）；先用守护测试冻结边界防止进一步耦合，物理迁移作为独立批次带完整验证执行。
