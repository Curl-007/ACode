// read 结构化摘要编排（specs/read-structural-summary.md）。
// 资格门（R1）→ 缓存（R5）→ 折叠（fold.ts）→ 原行号锚定渲染 + 尾注（R4）。
// 对不合格输入返回 summarized:false，调用方走现行为——零回归面。

import { foldSourceStructurally, type FoldResult } from "./fold.js";
import {
  getCachedFold,
  noteFoldParseCall,
  readSummaryCacheKey,
  setCachedFold,
} from "./cache.js";
import {
  isProsePath,
  isSummarizableCodePath,
  resolveReadSummaryConfig,
  type ReadSummaryConfig,
} from "./config.js";

export * from "./config.js";
export * from "./selector.js";
export { foldSourceStructurally, type FoldResult, type FoldSegment } from "./fold.js";
export { clearReadSummaryCache, readFoldParseCallCount } from "./cache.js";

export interface SummarizeReadInput {
  absolutePath: string;
  /** 尾注/标记展示路径（与 read 输出同口径）。 */
  displayPath: string;
  /** 整读正文（LF 归一形态，port readTextFile* 返回值）。 */
  text: string;
  /** 内容含未解决冲突块时调用方置 true——冲突文件永不摘要（R6）。 */
  hasConflicts?: boolean;
  config?: ReadSummaryConfig;
}

export interface SummarizeReadOutput {
  summarized: boolean;
  /** 已带原行号锚定的摘要正文（preNumbered，渲染层不再二次编号）。 */
  numberedText?: string;
  /** 摘要尾注（R4）。 */
  footer?: string;
  foldedBlocks?: number;
  foldedLines?: number;
}

const NOT_SUMMARIZED: SummarizeReadOutput = { summarized: false };

export function summarizeWholeFileRead(input: SummarizeReadInput): SummarizeReadOutput {
  const config = input.config ?? resolveReadSummaryConfig();
  if (!config.enabled || input.hasConflicts) return NOT_SUMMARIZED;
  if (!isSummarizableCodePath(input.absolutePath) || isProsePath(input.absolutePath)) {
    return NOT_SUMMARIZED;
  }
  const lines = input.text.split("\n");
  // 末尾换行产生的空尾行不计入行数门槛。
  const lineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (lineCount < config.minTotalLines || lineCount > config.maxFileLines) {
    return NOT_SUMMARIZED;
  }
  if (Buffer.byteLength(input.text, "utf8") > config.maxFileBytes) {
    return NOT_SUMMARIZED;
  }

  const key = readSummaryCacheKey(
    input.absolutePath,
    input.text,
    `${config.minTotalLines},${config.minBodyLines},${config.unfoldLimitLines},${config.maxConsecutiveImports}`,
  );
  const cached = getCachedFold(key);
  let fold: FoldResult | null;
  if (cached.hit) {
    fold = cached.value;
  } else {
    noteFoldParseCall();
    fold = foldSourceStructurally({
      fileName: input.absolutePath,
      text: input.text,
      displayPath: input.displayPath,
      config,
    });
    setCachedFold(key, fold);
  }
  if (!fold || fold.foldedBlocks === 0) return NOT_SUMMARIZED;

  const numberedText = renderFoldedLines(fold, lines);
  const footer = [
    `⟨structural summary⟩ ${fold.foldedBlocks} block(s) folded (${fold.foldedLines} of ${fold.totalLines} lines elided); signatures, JSDoc/comments and top-level statements are kept verbatim with original line numbers.`,
    `Expand a fold: read "${input.displayPath}:<start>-<end>" from the marker (multi-range "a-b,c-d", tail ":-N", verbatim window ":raw"). Summaries apply only to whole-file reads of JS/TS-family files ≥ ${config.minTotalLines} lines; disable with ACODE_READ_SUMMARIZE=0.`,
  ].join("\n");
  return {
    summarized: true,
    numberedText,
    footer,
    foldedBlocks: fold.foldedBlocks,
    foldedLines: fold.foldedLines,
  };
}

/** 原行号锚定渲染（R2）：keep 段逐行 `<行号>\t<原文>`，fold 段单行标记。 */
function renderFoldedLines(fold: FoldResult, lines: readonly string[]): string {
  const out: string[] = [];
  for (const segment of fold.segments) {
    if (segment.kind === "keep") {
      for (let lineNumber = segment.startLine; lineNumber <= segment.endLine; lineNumber += 1) {
        out.push(`${lineNumber}\t${lines[lineNumber - 1] ?? ""}`);
      }
    } else {
      out.push(`${segment.startLine}\t${segment.marker ?? ""}`);
    }
  }
  return out.join("\n");
}
