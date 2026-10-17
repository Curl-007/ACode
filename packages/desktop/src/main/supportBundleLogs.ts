/**
 * 支持包日志取材机制（specs/log-privacy-redaction.md desktop R7/R9/R10）。
 *
 * 日志节不整文件导出：只取尾部 ~1MB（近期现场最有排障价值），过滤
 * warn|error 行，再按预算采样——优先类（API/流/网络错误）从尾部取最多
 * 150 行，然后从尾部补足普通行到总预算。截断在行边界进行并带
 * 「已截断，显示最后 N 字节」标记；行边界截断天然不劈名字（注册表的
 * truncatePreservingNames 供非行结构出口复用，见 shared 模块）。
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { getMainLogRedactor } from "./logPrivacyIdentity.js";

/** 日志节 tail 读取上限（字节）。 */
const LOG_TAIL_MAX_BYTES = 1024 * 1024;
/** 预算采样：优先类行数上限。 */
const LOG_PRIORITY_LINE_BUDGET = 150;
/** 预算采样：总行数上限。 */
const LOG_TOTAL_LINE_BUDGET = 400;
/** 单节内容字节上限，超过按尾部截断。 */
const SECTION_CONTENT_MAX_BYTES = 512 * 1024;
/** 截断标记（label 即隐私承诺的一部分，自撰文案）。 */
const TRUNCATION_MARKER_PREFIX = "…（已截断，显示最后";

/** 读取文件尾部 maxBytes 字节并按 utf-8 解码；开头的不完整行丢弃。 */
export async function readFileTailText(filePath: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    const start = Math.max(0, stats.size - maxBytes);
    const length = Math.min(maxBytes, stats.size - start);
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    if (start > 0) {
      // tail 起点大概率落在行中间：丢弃首个不完整行，防止半行误导排障。
      const firstNewline = text.indexOf("\n");
      return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    // ENOENT/权限/共享冲突：日志节缺一个文件不中断整包（调用方给说明行）。
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function splitLogLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * 预算采样（引用形态：优先类从尾部 150 行，再从尾部补足到总预算）：
 * 返回保持原顺序的采样行。
 */
export function sampleLogLines(
  lines: readonly string[],
  options: { priorityPattern?: RegExp } = {},
): string[] {
  const priorityPattern = options.priorityPattern;
  const isPriority = (line: string): boolean =>
    priorityPattern !== undefined && priorityPattern.test(line);
  const passes: ReadonlyArray<readonly [budget: number, predicate: (line: string) => boolean]> = [
    [LOG_PRIORITY_LINE_BUDGET, isPriority],
    [LOG_TOTAL_LINE_BUDGET, (line) => !isPriority(line)],
    [LOG_TOTAL_LINE_BUDGET, () => true],
  ];
  const selected = new Set<number>();
  for (const [budget, predicate] of passes) {
    for (let index = lines.length - 1; index >= 0 && selected.size < budget; index -= 1) {
      const line = lines[index]!;
      if (predicate(line)) {
        selected.add(index);
      }
    }
  }
  return lines.filter((_line, index) => selected.has(index));
}

/**
 * 节内容尾部截断：超过上限时保留尾部（近期内容），前置
 * 「…（已截断，显示最后 N 字节）」标记。行列表在行边界裁剪（不劈名字）；
 * 无行结构的兜底路径用注册表边界感知截断从头部回退。
 */
export function truncateSectionContentKeepingTail(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return content;
  }
  const lines = content.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineBytes = Buffer.byteLength(lines[index]!, "utf-8") + 1;
    if (bytes + lineBytes > maxBytes && kept.length > 0) {
      break;
    }
    kept.unshift(lines[index]!);
    bytes += lineBytes;
  }
  const body = kept.join("\n");
  return `${TRUNCATION_MARKER_PREFIX} ${Buffer.byteLength(body, "utf-8")} 字节）\n${body}`;
}

/** 目录内按 mtime 最新的若干文件（日志节取材入口）。 */
export async function listRecentFiles(
  dir: string,
  pattern: RegExp,
  limit: number,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      continue;
    }
    const filePath = join(dir, entry.name);
    const stats = await stat(filePath).catch(() => null);
    if (stats?.isFile()) {
      candidates.push({ path: filePath, mtimeMs: stats.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates.slice(0, limit).map((candidate) => candidate.path);
}

/**
 * 日志节统一取材管线：tail → 行过滤 → 预算采样 → 逐行脱敏 → 拼接 → 尾部截断。
 * redactor 用 main 进程单例（注册表真名 + 运行期收名的最强身份）。
 */
export async function collectRedactedLogSection(input: {
  files: readonly string[];
  lineFilter: RegExp;
  priorityPattern?: RegExp;
  emptyNotice: string;
}): Promise<string> {
  const redactor = getMainLogRedactor();
  const collected: string[] = [];
  for (const file of input.files) {
    const tail = await readFileTailText(file, LOG_TAIL_MAX_BYTES);
    if (tail === null) {
      continue;
    }
    const lines = splitLogLines(tail).filter((line) => input.lineFilter.test(line));
    for (const line of sampleLogLines(lines, { priorityPattern: input.priorityPattern })) {
      collected.push(redactor.redactLine(line));
    }
  }
  if (collected.length === 0) {
    return input.emptyNotice;
  }
  return truncateSectionContentKeepingTail(collected.join("\n"), SECTION_CONTENT_MAX_BYTES);
}
