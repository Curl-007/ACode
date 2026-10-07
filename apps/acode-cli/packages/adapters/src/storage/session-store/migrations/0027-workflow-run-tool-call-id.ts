// 脚本工作流 run 的发起工具调用 id（specs/script-workflow-revival.md R15）。
//
// 为什么要这一列：run 目录页把**缺 toolCallId 的摘要整条剔除**（workflowRunDirectoryModel.ts
// 的 hasDetailAnchor），理由是「`workflow-run` tab 要它去父会话投影里找静态图那一行」。
// 脚本工作流的 run 记录里没有这一列，于是即便枚举面已经把两套 run 合到同一个查询里，
// 目录页仍然一条脚本 run 都显示不出来——过滤器把它们全吃了。
//
// 那条理由现在只对 dwf 成立：侧栏已经有了不吃静态图的「实时活动」主体
// （WorkflowRunActivityList），所以缺图不再是「开不出详情页」。但**仍然要存这一列**，
// 而不是简单放宽过滤器，因为它同时是另外两件事的关联键：
//   - 聊天里的工具卡按 toolCallId 与 run 联接（TUI 的 buildTuiWorkflowCardIndex 与
//     GUI 的 buildWorkflowRunByToolCallId 同规），缺它则冷恢复的 run 联不回发起它的那一行；
//   - 目录行点开详情页时带的就是 toolCallId。
// 放宽过滤器只能让行出现，联不回去的问题一个都没解决。
//
// 可空：存量行没有这个事实可回填（当时没记），新行才有。读侧对缺席的处理照旧。
// 回滚 = 旧代码不读不写该列（codec 只多认一个可空字段），不需要 down migration；
// 与 0023/0024 的加列族同款。
export const WORKFLOW_RUN_TOOL_CALL_ID_MIGRATION_SQL = `
      alter table workflow_run add column tool_call_id text;
`;
