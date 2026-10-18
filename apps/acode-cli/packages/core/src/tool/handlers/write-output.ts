// ============================================================
// Write 工具模型内容格式化（自 write.ts 抽出，400 行 ratchet 预算腾挪；
// 行为与抽出前一致，另按 specs/conflict-uri-resolution.md R5 增 conflict
// 解决摘要段）。
// ============================================================

const WRITE_STORAGE_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";
const WRITE_USER_MODIFIED_NOTE = " The user modified your proposed content before accepting it.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatWriteModelContent(
  output: unknown,
  consumePendingDiagnostics: (filePath: string) => string | undefined,
): string {
  if (!isRecord(output)) {
    return "The file has been written successfully.";
  }

  const filePath = typeof output.filePath === "string" ? output.filePath : "the file";
  const userModified = output.userModified === true;
  const userModifiedNote = userModified ? WRITE_USER_MODIFIED_NOTE : "";
  const storageSuffixNote = userModified ? "" : WRITE_STORAGE_SUFFIX;

  const base =
    output.type === "create"
      ? `File created successfully at: ${filePath}${userModifiedNote}${storageSuffixNote}`
      : `The file ${filePath} has been updated successfully.${userModifiedNote}${storageSuffixNote}`;
  // conflict:// 解决摘要（specs/conflict-uri-resolution.md R5）：已解决块 id、
  // 批量场景的其余文件、会话剩余计数——普通写无该字段，输出与既有逐字节一致。
  const conflictNote = formatConflictResolutionNote(output.conflictResolution);
  // LSP 诊断回流（specs/lsp-diagnostics-loop.md）：钩子挂起的新增诊断块附在尾部。
  const pendingDiagnostics = consumePendingDiagnostics(filePath);
  return [base + conflictNote, pendingDiagnostics].filter(Boolean).join("\n\n");
}

function formatConflictResolutionNote(conflictResolution: unknown): string {
  if (!isRecord(conflictResolution)) return "";
  const ids = Array.isArray(conflictResolution.resolvedIds)
    ? conflictResolution.resolvedIds.filter((id): id is number => typeof id === "number")
    : [];
  if (ids.length === 0) return "";
  const extraFiles = Array.isArray(conflictResolution.extraFiles)
    ? conflictResolution.extraFiles.filter((path): path is string => typeof path === "string")
    : [];
  const remaining =
    typeof conflictResolution.sessionRemaining === "number"
      ? conflictResolution.sessionRemaining
      : 0;
  const parts = [
    `\n\nResolved merge conflict block(s): ${ids.map((id) => `conflict://${id}`).join(", ")}.`,
  ];
  if (extraFiles.length > 0) {
    parts.push(` Also rewrote: ${extraFiles.join(", ")}.`);
  }
  if (remaining > 0) {
    parts.push(
      ` ${remaining} conflict block(s) remain registered in this session (ids of resolved files were invalidated — re-read those files for fresh ids).`,
    );
  }
  return parts.join("");
}
