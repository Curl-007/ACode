// ============================================================
// transcript 文件来源台账（specs/auto-mode-risk-classifier.md 第二批 R9）
// ============================================================
// 「本 transcript 哪些文件由工具调用创建/覆盖过」——破坏性判定的来源证据：
// 删除/覆盖台账外文件 = 不可逆破坏档（rubric 文本，判定归分类器；确定性层
// 不因此改变）。会话键控的进程级 Map（fleet registry 同款生命周期哲学：
// child 与父同进程，进程亡故 = 台账亡故）。
//
// 近似性如实登记（spec R9）：喂入点是 allow 决策与分类器 allow 重写，不是
// 执行成功回调——ask→broker 批准的写入对判定面不可见（台账缺该文件 →
// 破坏性判定更严 = fail-safe 方向）；allow 后 handler 失败会多记（删除本不
// 存在的文件无危害）。执行成功面的精确喂入 = 接线项。

/** 台账条目：哪个工具在何时对哪个路径建立了 transcript 来源。 */
export interface TranscriptFileProvenanceEntry {
  path: string;
  tool: string;
  at: number;
}

/** 每会话台账上限；超限逐首（最近的来源最重要）。 */
export const FILE_PROVENANCE_MAX_ENTRIES_PER_SESSION = 512;
/** 进分类器 user message 的台账行数上限（最近 N 条）。 */
export const FILE_PROVENANCE_DIGEST_MAX_LINES = 64;

/** 台账喂入覆盖的写族工具（Write/Edit 取 file_path；ApplyPatch 解析 patch 文本）。 */
const FILE_PROVENANCE_PATH_TOOLS = new Set(["Write", "Edit"]);

/** ApplyPatch 的补丁行格式（tools/apply-patch 契约）：`*** Add/Update File: <path>`。 */
const APPLY_PATCH_FILE_LINE = /^\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/gm;

const ledgers = new Map<string, TranscriptFileProvenanceEntry[]>();

/** 记录一条来源事实（创建或覆盖）。空路径忽略；重复记录照常追加（时间序即事实序）。 */
export function recordTranscriptFileProvenance(input: {
  sessionId: string;
  path: string;
  tool: string;
  now?: () => number;
}): void {
  const path = input.path.trim();
  if (path.length === 0) return;
  const entries = ledgers.get(input.sessionId) ?? [];
  entries.push({ path, tool: input.tool, at: (input.now ?? Date.now)() });
  while (entries.length > FILE_PROVENANCE_MAX_ENTRIES_PER_SESSION) {
    entries.shift();
  }
  ledgers.set(input.sessionId, entries);
}

export function listTranscriptFileProvenance(
  sessionId: string,
): readonly TranscriptFileProvenanceEntry[] {
  return ledgers.get(sessionId) ?? [];
}

/** 会话收口时的台账清理（生命周期卫生；不调用也不泄漏出进程寿命）。 */
export function clearTranscriptFileProvenance(sessionId: string): void {
  ledgers.delete(sessionId);
}

/**
 * 台账 → 分类器 user message 的摘要文本（<transcript-provenance> 块内容）。
 * 缺席/空台账如实报「没有记录」——rubric 的破坏性规则据此从严（台账外 =
 * 不可逆档），诚实的空态比缺席更安全。
 */
export function buildTranscriptProvenanceDigest(sessionId: string | undefined): string {
  if (!sessionId) {
    return "(provenance ledger unavailable for this call: treat every destructive target as NOT created by this transcript)";
  }
  const entries = ledgers.get(sessionId);
  if (!entries || entries.length === 0) {
    return "(no files recorded as created or overwritten by tool calls in this transcript yet)";
  }
  return entries
    .slice(-FILE_PROVENANCE_DIGEST_MAX_LINES)
    .map((entry) => `- ${entry.path} (${entry.tool})`)
    .join("\n");
}

/**
 * allow 决策 → 台账喂入（PermissionService.checkPermission 终局单漏斗与灰区
 * 接缝的 allow 重写共用）。只认写族工具的结构化路径字段：Write/Edit 的
 * file_path、ApplyPatch 的 `*** Add/Update File:` 行。Bash 创建的文件不进
 * 台账（命令产出解析 = blast-radius 面，非本批）：落 fail-safe 方向（更严）。
 */
export function recordTranscriptFileProvenanceFromAllowedCall(input: {
  sessionId: string | undefined;
  toolName: string;
  toolInput: unknown;
  now?: () => number;
}): void {
  if (!input.sessionId) return;
  for (const path of extractProvenancePaths(input.toolName, input.toolInput)) {
    recordTranscriptFileProvenance({
      sessionId: input.sessionId,
      path,
      tool: input.toolName,
      ...(input.now ? { now: input.now } : {}),
    });
  }
}

/** 工具入参 → 本次调用将建立来源的路径列表（非写族工具 = 空）。 */
export function extractProvenancePaths(toolName: string, toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const record = toolInput as Record<string, unknown>;
  if (FILE_PROVENANCE_PATH_TOOLS.has(toolName)) {
    return typeof record.file_path === "string" && record.file_path.trim().length > 0
      ? [record.file_path]
      : [];
  }
  if (toolName === "ApplyPatch" && typeof record.patch_text === "string") {
    const paths: string[] = [];
    for (const match of record.patch_text.matchAll(APPLY_PATCH_FILE_LINE)) {
      const path = match[1]?.trim();
      if (path && path.length > 0) paths.push(path);
    }
    return paths;
  }
  return [];
}

/** 测试隔离：清空全部会话台账。 */
export function resetFileProvenanceLedgerForTest(): void {
  ledgers.clear();
}
