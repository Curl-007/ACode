/**
 * 0004：automation_runs 增 notify_decision 列（heartbeat 通知决策，
 * packages/desktop/specs/automation-heartbeat-protocol.md R4）。
 *
 * 冻结 SQL 常量同时作迁移 body 与 checksumInput（仿 0003）。nullable、additive：
 * 旧代码 select * 读到新列直接忽略，回滚 = 忽略该列，无需 down migration。
 * 不得把该列追加进 migrations.ts 的冻结 `columns` 列表——那是 0001 的 checksum
 * 输入，追加会让所有既有 DB checksum 失配。
 */
export const AUTOMATION_NOTIFY_DECISION_MIGRATION_SQL =
  "ALTER TABLE automation_runs ADD COLUMN notify_decision TEXT;";
