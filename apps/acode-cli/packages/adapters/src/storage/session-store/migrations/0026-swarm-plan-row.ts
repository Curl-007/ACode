// K2（specs/swarm-task-graph.md R6 +「未做与取舍」#5 附录）：swarm plan 的每 session 一行
// 存储。对齐 todo 链路的「专用表 + 每 session 键」先例（todo 表 / migration 0023-0024 的
// 加列族），不借用 generic KV 表——plan 行有独立的生存周期（随任务清除/重种）与演进面
// （SwarmTaskPlan schema），混进 local_setting 会让两边的清理语义互相污染。
// 回滚 = 旧代码不读不写该表（core 侧 duck-typing 缺席即纯内存），不需要 down migration。
export const SWARM_PLAN_ROW_MIGRATION_SQL = `
      create table if not exists swarm_plan (
        session_id text primary key,
        plan_json text not null,
        time_created integer not null,
        time_updated integer not null
      );
`;
