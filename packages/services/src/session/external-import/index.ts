/**
 * K5 外部会话导入框架公共出口（spec：external-session-import-sources.md）。
 * 只导出编排层与契约类型；各 adapter 也可从各自模块单独引入（互不依赖）。
 */
export type {
  ExternalFailedItem,
  ExternalImportFailedSource,
  ExternalImportResult,
  ExternalImportedItem,
  ExternalMessageRecord,
  ExternalMessageRole,
  ExternalSessionParseStats,
  ExternalSessionRecord,
  ExternalSessionRef,
  ExternalSessionSource,
  ExternalSessionSourceAdapter,
  ExternalSessionSummary,
  ExternalSkippedItem,
  ExternalToolCallSummary,
} from "#src/session/external-import/types.js";
export {
  IMPORTED_TASK_ID_PREFIXES,
  buildImportedExternalTaskFile,
  buildImportedExternalTaskId,
} from "#src/session/external-import/importTaskFile.js";
export {
  IMPORT_DISCOVER_DEFAULT_LIMIT,
  IMPORT_FIELD_MAX_CHARS,
  IMPORT_JSON_MAX_DEPTH,
  IMPORT_LINE_MAX_BYTES,
  parseGuardedJsonText,
  readExternalTimestampMs,
  readGuardedJsonFile,
  readGuardedJsonLinesFile,
  readGuardedJsonLinesFileHead,
} from "#src/session/external-import/importGuards.js";
export {
  discoverExternalSessions,
  getExternalSessionSourceAdapters,
  importExternalSessions,
} from "#src/session/external-import/importService.js";
export {
  EXTERNAL_IMPORT_REPO_RANKING_ENABLED,
  computeExternalRepoRankHint,
  rankExternalSessionSummaries,
} from "#src/session/external-import/repoRanking.js";
export { importedHistoryRepairPolicies } from "#src/session/external-import/importedHistoryRepairPolicy.js";
export { claudeCodeExternalSessionAdapter } from "#src/session/external-import/adapters/claudeCode.js";
export { codexExternalSessionAdapter, CODEX_SESSIONS_DIR_ENV } from "#src/session/external-import/adapters/codex.js";
export {
  cursorExternalSessionAdapter,
  CURSOR_PROJECTS_DIR_ENV,
  decodeCursorProjectDirName,
} from "#src/session/external-import/adapters/cursor.js";
export { geminiCliExternalSessionAdapter, GEMINI_CLI_TMP_DIR_ENV } from "#src/session/external-import/adapters/geminiCli.js";
export {
  opencodeExternalSessionAdapter,
  OPENCODE_STORAGE_DIR_ENV,
} from "#src/session/external-import/adapters/opencode.js";
