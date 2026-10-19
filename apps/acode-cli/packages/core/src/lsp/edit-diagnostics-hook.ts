// ============================================================
// Edit/Write 落盘诊断回环钩子（P0 + P1 汇合点）
// ============================================================
// 职责：文件落盘成功后，按扩展名与 LSP 配置选择诊断来源：
//   P0  .ts/.tsx → 进程内 TypeScript 诊断（ts-diagnostics.ts）
//   P1  适用 LSP 服务器的文件 → runLspWritethrough（didChange + 按版本等新诊断）
// 输出经 diagnostics-ledger 去重后：
//   ① 挂进 pending 模型内容（Edit/Write 的 formatModelContent 消费，本波落点）
//   ② 迟到结果进 deferred 队列，下一次 edit/write 注入（spec §6）
// 本模块是唯一被 handlers/edit.ts、handlers/write.ts 引用的 lsp 门面。

import { extname } from "node:path";
import { getConfig, getServersForFile } from "./config.js";
import { DiagnosticsLedger } from "./diagnostics-ledger.js";
import {
  formatDeferredDiagnosticsReminder,
  getDeferredDiagnosticsOwner,
  resetDeferredDiagnosticsOwners,
} from "./deferred-diagnostics.js";
import { sanitizeSystemReminderBody, wrapSystemReminder } from "../system-reminder/source.js";
import { runInProcessTsDiagnostics, isTsDiagnosticTarget, resetTsProgramCache } from "./ts-diagnostics.js";
import { detectChangeType, runLspWritethrough } from "./writethrough.js";
import type { FileDiagnosticsResult, FileFormatResult } from "./types.js";
import { logger } from "./logger.js";

// 内联等待预算：诊断必须对 Edit/Write 的 30s 工具预算让路（超时即转 deferred）。
const HOOK_WAIT_BUDGET_MS = 8000;
// LSP 未启用/未配置时 P0 是否兜底：是——P0 是唯一当天可用的回流路径。
const P0_EXTENSIONS = new Set([".ts", ".tsx"]);

function workspaceKeyFor(context: { workspaceIdentity?: string; workingDirectory: string }): string {
  // Workspace Identity 纪律：身份隔离用 identity，文件操作用 path；
  // ledger/deferred 按 workspace 隔离，键统一 trim(identity) || path。
  return (context.workspaceIdentity?.trim() || context.workingDirectory).toString();
}

export interface EditDiagnosticsOutcome {
  result: FileDiagnosticsResult;
  /** 附加进模型内容的文本块（无新增诊断时为 undefined）。 */
  modelContent?: string;
}

/**
 * 落盘后诊断回环。绝不抛出：诊断失败只降级为 debug 日志，
 * Edit/Write 主流程不受影响（现有行为与测试保持全绿的前提）。
 */
export async function runPostWriteDiagnostics(input: {
  resolvedPath: string;
  inputPath: string;
  content: string;
  workspaceIdentity?: string;
  workingDirectory: string;
  abortSignal: AbortSignal;
  /** format-on-write（Write 默认关，按配置）。 */
  enableFormat?: boolean;
}): Promise<EditDiagnosticsOutcome | undefined> {
  const workspaceKey = workspaceKeyFor(input);
  const owner = getDeferredDiagnosticsOwner(workspaceKey);

  // ---- ① 同步等待的新诊断 ----
  let result: FileDiagnosticsResult | undefined;
  try {
    const config = getConfig(input.workingDirectory);
    const servers = getServersForFile(config, input.resolvedPath);
    if (servers.length > 0) {
      // P1：LSP writethrough（内部先同步内容，再按版本等新诊断）。
      const changeType = await detectChangeType(input.resolvedPath);
      const outcome = await runLspWritethrough(
        input.resolvedPath,
        input.content,
        input.workingDirectory,
        {
          enableFormat: input.enableFormat ?? false,
          enableDiagnostics: true,
          requestTimeoutSec: HOOK_WAIT_BUDGET_MS / 1000,
          transformDiagnostics: (_path, diag) => owner.ledger.reduce(_path, diag),
        },
        changeType,
        input.abortSignal,
        owner.deferred.begin(input.resolvedPath),
      );
      result = outcome.diagnostics;
    } else if (isTsDiagnosticTarget(input.resolvedPath) && P0_EXTENSIONS.has(extname(input.resolvedPath).toLowerCase())) {
      // P0：进程内 TS 诊断（同步、无新进程）。
      const raw = runInProcessTsDiagnostics(input.resolvedPath, input.workingDirectory);
      result = owner.ledger.reduce(input.resolvedPath, raw);
    }
  } catch (error) {
    logger.debug("post-write diagnostics failed", {
      path: input.resolvedPath,
      error: logger.formatError(error),
    });
    return undefined;
  }

  if (!result) return undefined;

  // ---- ② 新增诊断挂进模型内容 ----
  const modelContent = buildDiagnosticsModelContent(input.inputPath, result, result.formatter);
  return modelContent ? { result, modelContent } : { result };
}

/** 新增诊断块（无消息时仅在格式化发生时提示）。 */
function buildDiagnosticsModelContent(
  displayPath: string,
  result: FileDiagnosticsResult,
  formatter: FileFormatResult | undefined,
): string | undefined {
  const lines: string[] = [];
  if (result.messages.length > 0) {
    lines.push(`${result.summary} in ${displayPath} (${result.server ?? "diagnostics"}; new diagnostics only):`);
    for (const message of result.messages) lines.push(`- ${message}`);
  }
  if (formatter === "formatted") {
    lines.push(`File was formatted by language server on write.`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

// =============================================================================
// 迟到诊断注入（下一次 Edit/Write 消费）
// =============================================================================

/**
 * 取走并格式化当前积压的迟到诊断（读取即清空，防重复注入）。
 * edit/write 的 formatModelContent 在工具结果模型内容尾部附上它。
 */
export function consumeDeferredDiagnostics(input: {
  workspaceIdentity?: string;
  workingDirectory: string;
}): string | undefined {
  const owner = getDeferredDiagnosticsOwner(workspaceKeyFor(input));
  const entries = owner.queue.drain();
  if (entries.length === 0) return undefined;
  // 服务器诊断文本可能携带任意字节：先消毒嵌套 system-reminder 标签再包裹。
  return wrapSystemReminder(sanitizeSystemReminderBody(formatDeferredDiagnosticsReminder(entries)));
}

/** edit/write handler 把钩子产出的模型内容按 displayPath 单发挂起。 */
const pendingModelContent = new Map<string, string>();

export function stashPendingModelContent(displayPath: string, content: string): void {
  pendingModelContent.set(normalizeKey(displayPath), content);
}

/** formatModelContent 读取并清空挂起内容（同键单发，无残留）。 */
export function consumePendingModelContent(displayPath: string): string | undefined {
  const key = normalizeKey(displayPath);
  const content = pendingModelContent.get(key);
  if (content !== undefined) pendingModelContent.delete(key);
  return content;
}

function normalizeKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** 测试接缝：清空全部会话级状态（ledger/deferred/pending）。 */
export function resetEditDiagnosticsState(): void {
  resetDeferredDiagnosticsOwners();
  pendingModelContent.clear();
  resetTsProgramCache();
}

// DiagnosticsLedger 仅通过 owner.ledger 间接使用；保留类型引用供消费者注型。
export type { DiagnosticsLedger };
