// 编排方案 Phase 1（specs/subagent-topology-persistence.md R7）：agent 拓扑边表——每
// agentId 一行的 parent→child 持久边，事后审计 / UI 冷恢复 / 崩溃收敛的拓扑权威。
// 不加 FK（0019 纪律）：子会话可能尚无 session 行（spawn 事件先于子会话落库的窗口是
// 合法的），FK 会挡合法记录。回滚 = 旧代码不读不写该表（core 侧 duck-typing 缺席即
// 按无持久化降级），不需要 down migration（migration-runner 强制历史不可变）。
export const SUBAGENT_EDGE_MIGRATION_SQL = `
      create table if not exists subagent_edge (
        agent_id text primary key,
        parent_session_id text not null,
        child_session_id text,
        agent_type text,
        parent_tool_call_id text,
        description text,
        background integer not null default 0,
        model text,
        output_file text,
        status text not null,
        started_at integer,
        ended_at integer,
        total_tokens integer,
        error text
      );

      create index if not exists subagent_edge_parent_idx on subagent_edge(parent_session_id);
`;
