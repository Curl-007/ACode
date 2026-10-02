// J2-1（specs/todo-confidence-semantics.md R5）：todo 表加一个 nullable 列 confidence_json，
// 存 { completionConfidence?, confidenceHistory? } 的规范化序列化结果——参照 deps_json
// （migration 0023）的同款做法：独立 JSON 列而不是扩 deps_json，因为 TodoDepsJsonSchema
// 是 strict，往里加成员会让旧版本代码 safeParse 失败、回滚时连 id/blockedBy 一起丢。
// 维护者确认（apps/acode-cli/AGENTS.md「修改数据库结构前，应与模块维护者确认」）：
// 方案由 J2-1 实施指令（2026-09-30，工作流下发）明确指定「参照 deps_json 列的做法加列 +
// migration」，与 0023 同一确认先例——nullable、可逆（回滚策略 = 旧代码忽略该列，
// 不需要 down migration；decodeTodoRow 显式挑字段，旧代码 select * 读到新列也会忽略，
// 前向兼容天然成立），spec R5 已定义回滚语义。
// 不改主键：position 仍是主键的一半，updateTodos 仍是 delete-all + re-insert。
export const TODO_CONFIDENCE_JSON_MIGRATION_SQL = `
      alter table todo add column confidence_json text;
`;
