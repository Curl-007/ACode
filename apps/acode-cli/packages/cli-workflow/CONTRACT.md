# cli-workflow

`contract.ts` 是这个应用上下文的公开入口。上下文拥有 ACode CLI 的 workflow 引擎族：
DWF run 应用服务（launch/submit/lifecycle/replay/roster/observation/introspection/
reconcile）、expert workflow driver、Script Workflow 引擎与 workflow 支撑件（artifact
发布、并发 governor/ceiling、seat gate、escalation registry、worktree manager、
world read、snippet/gate/import）。

它不拥有会话/runtime 事实（`@acode/core`）、journal 存储（`@acode/adapters`）、run 读模型
（`@acode/workflow-run-read`）、三条跨边界命令顺序（`@acode/workflow-run-command`）或
ACodeApp 能力门控（bootstrap facade）；这些经 deps/端口注入，本包不新建第二份 run 表、
journal 或 owner 状态。宿主类型以窄结构化面定义（`host-types.ts` 的
`PrepareUserExecutionBoundary` / `ScriptWorkflowHostOptions`），引擎不反向依赖 bootstrap。

消费方只有 bootstrap 装配接缝、legacy `saved-workflows.ts` 与 CLI 测试，一律经 `"."` /
`"./contract"` 包名入口，不得深导入。W1-R3 边界、解环与验收见
`apps/acode-cli/specs/cli-workflow-package-boundary.md`。
