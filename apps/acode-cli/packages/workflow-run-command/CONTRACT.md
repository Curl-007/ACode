# workflow-run-command

`contract.ts` 是这个应用上下文的公开入口。上下文只编排 Dynamic Workflow 命令的事件顺序：
resume 成功后才追踪，start/amend 先准备用户执行边界再访问 runtime。

它不拥有 run、attempt、journal、owner、reservation 或进程生命周期；这些事实分别由 bootstrap
的 run port 与 core `AgentRuntime` 注入。上下文不保存跨调用状态，每次命令只使用宿主提供的
`traceContext`，所以不会制造第二份 workflow registry。

能力缺席仍由 bootstrap facade 按端口方法门控。这个包不把缺席端口伪装成成功结果，也不复制
saved workflow 解析、编译或 submit 实现。W1-R2 边界与验收场景见
`apps/acode-cli/specs/workflow-run-command-boundary.md`。
