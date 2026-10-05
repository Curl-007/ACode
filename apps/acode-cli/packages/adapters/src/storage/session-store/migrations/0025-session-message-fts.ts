// K4 跨会话搜索（specs/session-search.md R1/R2）：SQLite FTS5 全文索引旁挂投影。
//
// 形态决策（已由 spec 附录 2026-10-04 实施首日探测定死，勿再改道）：
// - FTS5 + trigram 分词器在 node v25 `node:sqlite` 下可用（R8 回退不启用）；
// - 分词器一旦随建表落库就不可更换（trigram 的 token 体系与其它分词器不兼容），
//   换分词器 = 删表重建回填，属破坏性操作默认禁止；规则演进只能新表/新列追加；
// - trigram 的 MATCH token 最短 3 字符：查询侧对 <3 字符段降级 body LIKE 兜底
//   （specs/session-search.md 附录「检索口径」），不需要退化分词器；
// - 外部内容表（content=session_message_doc）：body 只存一份，FTS5 只持有倒排索引；
//   doc.id（rowid）就是 FTS rowid，投影维护走 repositories/messages.ts 的仓储代码
//   同事务维护（投影需要 JS 聚合 parts，SQL 触发器写不出唯一投影实现，spec R1 二选一
//   中选仓储路径），维护函数在 storage/session-store/fts.ts（投影唯一实现）。
//
// 本迁移只建结构 + 回填账本，**不做存量回填**：body 投影是 JS 单实现（R6 不变量），
// 不可能用 SQL 在迁移里复制一份；存量回填由 fts.ts 的分批回填（每批独立事务、账本
// 记录游标、幂等可续）在 storageReady 后执行（R1 回填 + R5 预热共用同一入口）。
//
// 列序说明：body 放第 0 列，snippet(session_message_fts, 0, ...) 因此直接指向正文
// （spec 附录验证的 snippet 形态）；session_id/task_id/role/message_ts 全 UNINDEXED，
// 只随行返回不做检索维度。task_id 与 session_id 同值（本域 task 即 session，contracts
// SessionSearchInput 的 taskId 注释「Restrict search to one task/session id」）。
export const SESSION_MESSAGE_FTS_MIGRATION_SQL = `
      create table if not exists session_message_doc (
        id integer primary key,
        message_id text not null unique,
        session_id text not null,
        task_id text not null,
        role text not null,
        message_ts integer not null,
        body text not null,
        time_created integer not null,
        time_updated integer not null
      );

      create virtual table if not exists session_message_fts using fts5(
        body,
        session_id unindexed,
        task_id unindexed,
        role unindexed,
        message_ts unindexed,
        content='session_message_doc',
        content_rowid='id',
        tokenize='trigram'
      );

      create table if not exists session_message_fts_backfill (
        id integer primary key check (id = 1),
        last_message_rowid integer not null default 0,
        done integer not null default 0 check (done in (0, 1)),
        processed integer not null default 0,
        time_updated integer not null default 0
      );

      insert or ignore into session_message_fts_backfill (
        id, last_message_rowid, done, processed, time_updated
      ) values (1, 0, 0, 0, 0);
`;
