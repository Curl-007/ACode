// D4（specs/todo-dependency-fields.md R5）：todo 表加一个 nullable 列 deps_json，
// 存规范化后的 { id?, blockedBy?, metadata? } 序列化结果。一个 JSON 列而不是三个新列：
// blockedBy 是数组、metadata 是开放记录，三字段同列未来扩展不再改表，也避免为依赖
// 关系建第二张表（= 第二份状态）。
// 维护者确认（apps/acode-cli/AGENTS.md:14）：已于实施时经主代理升级裁决给出
// （2026-09-29）——理由：nullable、可逆（回滚策略 = 旧代码忽略该列，不需要 down
// migration），spec R5 已定义回滚语义；decodeTodoRow 显式挑字段，旧代码 select *
// 读到新列也会忽略，前向兼容天然成立。
// 不改主键：position 仍是主键的一半，updateTodos 仍是 delete-all + re-insert。
export const TODO_DEPS_JSON_MIGRATION_SQL = `
      alter table todo add column deps_json text;
`;
