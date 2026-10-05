import type { ExternalSessionSource } from "#src/session/external-import/types.js";

/**
 * 导入后修复策略登记（R3：修复器按来源适配）。
 *
 * importedClaudeHistoryRepair 的判定假设与 claude 强耦合：
 * 1. migrationSource === "claudeCode"（shared 协议当前只允许这一个值）；
 * 2. taskId 前缀 claude-import-；
 * 3. 修复数据源是 ~/.claude/projects 原生 jsonl 反查。
 * 新来源三者都不满足——shouldRepairImportedClaudeSnapshot 天然返回 false，
 * 即新来源自动走 no-op（不会被误回填成 Claude 历史）。这里显式登记策略，
 * 等 importedHistory 协议扩展出非 claude 来源后再逐来源接入真实修复器。
 */
export type ImportedHistoryRepairPolicy =
  | { kind: "claude-native" }
  | { kind: "noop"; reason: string };

export const importedHistoryRepairPolicies: Record<ExternalSessionSource, ImportedHistoryRepairPolicy> =
  {
    "claude-code": { kind: "claude-native" },
    "openai-codex": {
      kind: "noop",
      reason: "codex 导入无 migrationSource/claude-import- 前缀，修复器假设不适用",
    },
    "gemini-cli": {
      kind: "noop",
      reason: "gemini 导入无 migrationSource/claude-import- 前缀，修复器假设不适用",
    },
    opencode: {
      kind: "noop",
      reason: "opencode 导入无 migrationSource/claude-import- 前缀，修复器假设不适用",
    },
    cursor: {
      kind: "noop",
      reason: "cursor 导入无 migrationSource/claude-import- 前缀，修复器假设不适用",
    },
  };
