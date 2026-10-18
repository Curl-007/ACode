// Mechanism ported from oh-my-pi (MIT) packages/mnemopi — core/beam/store.ts
// （remember() 的重复合并 UPDATE 语义，store.ts:449-495；findDuplicate 的内容比对），
// Copyright (c) 2025 Mario Zechner & Stencil Labs。SQLite 行语义移植为 markdown
// 文件语义：内容归一化哈希找重复 → 幸存者合并 frontmatter → 删除新写重复文件。
// 规则与偏差逐条记录在 specs/memory-semantic-recall.md R13。

import { createHash } from "node:crypto";

import { type FileSystemPort, type Logger } from "@acode/contracts";

import {
  MANIFEST_FILE_LIMIT,
  collectMemoryFilePaths,
  memoryFileRelativeName,
} from "./recall/manifest.js";
import { stripMemoryFrontmatter } from "./recall/retrieval/tokenize.js";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import {
  mergeMemoryFrontmatterFields,
  parseMemoryFrontmatterBlock,
  readMemoryLifecycleFields,
  serializeMemoryFrontmatterBlock,
} from "./lifecycle-frontmatter.js";
import type { MemoryVeracity } from "./veracity.js";

export interface MemoryWriteLifecycleDeps {
  fileSystem: FileSystemPort;
  /** 本轮写侧绑定的记忆根目录（与 agent loop 的 rootDir 同源）。 */
  memoryRoot: string;
  /** veracity 机械缺省（R11）：Extraction 产出传 `extracted`。 */
  defaultVeracity: MemoryVeracity;
  logger?: Logger;
  now?: () => number;
}

export interface MemoryWriteLifecycleOutcome {
  /** 是否给写入文件补写了 veracity 缺省（R11 机械兜底）。 */
  veracityFilled: boolean;
  /** 合并命中的幸存者相对名；未命中去重时缺省。 */
  mergedInto?: string;
  /** 因去重被删除的文件相对名（通常是刚写入的重复文件本身）。 */
  duplicatesRemoved: string[];
  /** 失败原因枚举；enforcement 不向调用方抛错（R13 失败语义）。 */
  error?: "written-file-unreadable" | "scan-failed" | "merge-write-failed" | "duplicate-remove-failed";
}

/**
 * 写侧生命周期 enforcement（R11 缺省补写 + R13 机械去重合并）。
 *
 * 由 memory-agent-loop 在每批模型工具调用后、下一次模型请求前调用：对本批成功落盘的
 * 每个记忆文件依序执行。任何一步失败都收敛为 outcome.error + warn，绝不抛进 agent
 * loop——去重是增强，不是写路径的正确性前提（spec R13 失败语义）。
 * 幂等：重复执行无剩余重复（幸存者保留、重复者已删）。
 */
export async function enforceMemoryWriteLifecycle(
  deps: MemoryWriteLifecycleDeps,
  writtenPath: string,
  options?: { signal?: AbortSignal },
): Promise<MemoryWriteLifecycleOutcome> {
  const outcome: MemoryWriteLifecycleOutcome = { duplicatesRemoved: [], veracityFilled: false };

  const relativeName = memoryFileRelativeName(deps.memoryRoot, writtenPath);
  // MEMORY.md 是索引不是条目（J3-2 R10 保留语义）；目录外路径不归本通道管。
  if (relativeName === undefined || relativeName === "MEMORY.md" || relativeName.endsWith("/MEMORY.md")) {
    return outcome;
  }

  let writtenContent: string;
  try {
    writtenContent = (
      await deps.fileSystem.readTextFile({ path: writtenPath }, { signal: options?.signal })
    ).content;
  } catch {
    outcome.error = "written-file-unreadable";
    warnFailure(deps, outcome.error);
    return outcome;
  }

  // R11 机械兜底：frontmatter 缺 veracity 字段时补写缺省档；模型已写的值（含显式
  // unknown）不覆盖。补写先行，使缺省档参与同一轮去重合并。
  const writtenBlock = parseMemoryFrontmatterBlock(writtenContent);
  if (writtenBlock && !readMemoryLifecycleFields(writtenBlock.record).hasVeracityField) {
    writtenBlock.record.veracity = deps.defaultVeracity;
    const patched = serializeMemoryFrontmatterBlock(writtenBlock.record, writtenBlock.body);
    try {
      await deps.fileSystem.writeTextFile(
        { path: writtenPath, content: patched },
        { signal: options?.signal },
      );
      writtenContent = patched;
      outcome.veracityFilled = true;
    } catch {
      // 补写失败不阻断去重扫描：扫描用已解析的 record 继续（合并值不受影响）。
      warnFailure(deps, "veracity-fill-failed");
    }
  }

  // 归一化正文哈希（R13）：NFC → 小写 → 空白折叠 → trim → sha256。frontmatter 差异
  // 不参与——两个只有 frontmatter 不同的文件是重复；比 omp findDuplicate 的全等匹配
  // 更强（全等是其子集）。
  const writtenHash = normalizedContentHash(writtenContent);

  let candidatePaths: string[];
  try {
    candidatePaths = (
      await collectMemoryFilePaths(deps.fileSystem, deps.memoryRoot, options?.signal)
    ).slice(0, MANIFEST_FILE_LIMIT);
  } catch {
    outcome.error = "scan-failed";
    warnFailure(deps, outcome.error);
    return outcome;
  }

  const duplicates: string[] = [];
  for (const candidatePath of candidatePaths) {
    // 自身跳过：路径策略解析出的写入路径与适配器列目录返回的路径在分隔符形态上可能
    // 不同（win32 反斜杠 vs 适配器正斜杠）——按分隔符归一后的字符串相等判定同一文件，
    // 否则条目会与自身「去重」并被误删。
    if (isSamePathLoose(candidatePath, writtenPath)) continue;
    try {
      const content = (
        await deps.fileSystem.readTextFile({ path: candidatePath }, { signal: options?.signal })
      ).content;
      if (normalizedContentHash(content) === writtenHash) duplicates.push(candidatePath);
    } catch {
      // 单个候选读取失败与检索层同口径：跳过该条，不影响其余候选的去重判定。
      continue;
    }
  }
  if (duplicates.length === 0) return outcome;

  // 幸存者 = 相对名最小的既有重复（保留文件身份与入链 [[name]]，等价于 omp 返回既有
  // row id）；其余既有重复不动（先存量后清理，不扩散本次写入的影响面）。
  // 幸存者若是写入文件自身（路径形态差异漏网）等价于无重复：原样返回，绝不合自己再删自己。
  const survivors = duplicates
    .filter((candidatePath) => !isSamePathLoose(candidatePath, writtenPath))
    .sort((left, right) =>
      (memoryFileRelativeName(deps.memoryRoot, left) ?? left).localeCompare(
        memoryFileRelativeName(deps.memoryRoot, right) ?? right,
      ),
    );
  if (survivors.length === 0) return outcome;
  const survivorPath = survivors[0]!;

  let survivorBlock: ReturnType<typeof parseMemoryFrontmatterBlock>;
  try {
    survivorBlock = parseMemoryFrontmatterBlock(
      (
        await deps.fileSystem.readTextFile({ path: survivorPath }, { signal: options?.signal })
      ).content,
    );
  } catch {
    outcome.error = "merge-write-failed";
    warnFailure(deps, outcome.error);
    return outcome;
  }
  if (survivorBlock && writtenBlock) {
    const merged = mergeMemoryFrontmatterFields(survivorBlock.record, writtenBlock.record);
    try {
      await deps.fileSystem.writeTextFile(
        {
          content: serializeMemoryFrontmatterBlock(merged, survivorBlock.body),
          path: survivorPath,
        },
        { signal: options?.signal },
      );
      outcome.mergedInto = memoryFileRelativeName(deps.memoryRoot, survivorPath);
    } catch {
      outcome.error = "merge-write-failed";
      warnFailure(deps, outcome.error);
      return outcome;
    }
  }
  // 幸存者无合法 frontmatter（畸形存量）时只删重复不合并字段：正文归一化相等，
  // 无知识损失；给它凭空造 frontmatter 块超出机械通道的职责（注释说明，spec R13）。

  try {
    await deps.fileSystem.removeFile(
      { path: writtenPath, missingOk: true },
      { signal: options?.signal },
    );
    outcome.duplicatesRemoved.push(relativeName);
  } catch {
    outcome.error = "duplicate-remove-failed";
    warnFailure(deps, outcome.error);
  }
  return outcome;
}

/** 归一化正文哈希（R13）：只比正文，不比 frontmatter。 */
export function normalizedContentHash(content: string): string {
  const body = stripMemoryFrontmatter(content);
  const normalized = body
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** 路径同一性的宽松判定：分隔符归一后比较（win32 反斜杠与正斜杠等价）。 */
function isSamePathLoose(left: string, right: string): boolean {
  return left.replace(/\\/gu, "/") === right.replace(/\\/gu, "/");
}

/**
 * agent loop 的批量写后 enforcement（memory-agent-loop 的生命周期通道消费此入口）：
 * 对本批「策略放行且执行成功」的记忆文件写入依序执行 R11 缺省补写 + R13 去重合并。
 * 批内依序串行（R13 并发边界）；单条失败自吞（只记 warn，绝不向 agent loop 抛错）。
 */
export async function enforceMemoryAgentLoopLifecycle(input: {
  config: {
    defaultVeracity: MemoryVeracity;
    fileSystem: FileSystemPort;
    logger?: Logger;
  };
  rootDir: string;
  signal?: AbortSignal;
  workingDirectory: string;
  workspaceRoot: string;
  writes: ReadonlyArray<{ ok: boolean; path?: string }>;
}): Promise<void> {
  for (const write of input.writes) {
    if (!write.ok || write.path === undefined) continue;
    // 路径解析走既有工具路径策略；策略对病态输入会抛 CoreError——生命周期通道
    // 不能因解析失败打断 agent loop（R13 失败语义），解析异常按「不归本通道管」跳过。
    let containedPath: string | undefined;
    try {
      containedPath = resolveContainedMemoryFilePath({
        filePath: write.path,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      });
    } catch {
      containedPath = undefined;
    }
    // 目录外路径不归记忆生命周期通道管（正常情况下写侧 scope guard 已拦下）。
    if (containedPath === undefined) continue;
    await enforceMemoryWriteLifecycle(
      {
        defaultVeracity: input.config.defaultVeracity,
        fileSystem: input.config.fileSystem,
        logger: input.config.logger,
        memoryRoot: input.rootDir,
      },
      containedPath,
      { signal: input.signal },
    );
  }
}

function warnFailure(deps: MemoryWriteLifecycleDeps, reason: string): void {
  deps.logger?.warn("Memory write lifecycle enforcement failed", {
    // 不落路径与内容（J3-2 R4 口径：错误上下文不携带文件名/不可信内容）。
    event: "memory.lifecycle.enforce_failed",
    module: "core.memory",
    reason,
    status: "failed",
  });
}
