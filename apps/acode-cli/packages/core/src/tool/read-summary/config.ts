// read 结构化摘要配置面（specs/read-structural-summary.md R1/R2/R5）。
// 阈值语义参照 oh-my-pi (MIT) read-summary.ts 的 cfgReadSummarize* 族，
// Copyright (c) 2025 Mario Zechner & Stencil Labs；env 旋钮为 ACode 形态。

const JS_TS_SUMMARY_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** prose 文件永不进代码摘要（omp isProseSummaryPath 同款）。 */
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export const READ_SUMMARY_DEFAULTS = {
  /** 总开关（ACODE_READ_SUMMARIZE=0/false/off 关闭；脏值→开启，安全特性不静默关闭——与密钥混淆开关同纪律）。 */
  enabled: true,
  /** 整读行数下限：低于此值不摘要（小文件全文更有用）。 */
  minTotalLines: 300,
  /** 体行数下限：低于此值不折叠。 */
  minBodyLines: 8,
  /** 体行数 ≤ 此值整体保留（小函数是理解主力）。折叠条件 = ≥minBodyLines 且 >unfoldLimitLines。 */
  unfoldLimitLines: 40,
  /** 连续 import 超过此数折叠中段为计数行。 */
  maxConsecutiveImports: 10,
  /** omp 同款上限。 */
  maxFileBytes: 2 * 1024 * 1024,
  maxFileLines: 20_000,
} as const;

export interface ReadSummaryConfig {
  enabled: boolean;
  minTotalLines: number;
  minBodyLines: number;
  unfoldLimitLines: number;
  maxConsecutiveImports: number;
  maxFileBytes: number;
  maxFileLines: number;
}

function envFlagOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 进程级配置快照（env 一次解析；测试可注入 override）。 */
export function resolveReadSummaryConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ReadSummaryConfig> = {},
): ReadSummaryConfig {
  return {
    enabled: envFlagOff(env.ACODE_READ_SUMMARIZE) ? false : READ_SUMMARY_DEFAULTS.enabled,
    minTotalLines: envInt(env.ACODE_READ_SUMMARY_MIN_LINES, READ_SUMMARY_DEFAULTS.minTotalLines),
    minBodyLines: READ_SUMMARY_DEFAULTS.minBodyLines,
    unfoldLimitLines: READ_SUMMARY_DEFAULTS.unfoldLimitLines,
    maxConsecutiveImports: READ_SUMMARY_DEFAULTS.maxConsecutiveImports,
    maxFileBytes: READ_SUMMARY_DEFAULTS.maxFileBytes,
    maxFileLines: READ_SUMMARY_DEFAULTS.maxFileLines,
    ...overrides,
  };
}

/** R1 资格门的路径面判定（扩展名族；大小写不敏感，跨平台）。 */
export function isSummarizableCodePath(filePath: string): boolean {
  const extension = extensionOf(filePath);
  return JS_TS_SUMMARY_EXTENSIONS.has(extension);
}

export function isProsePath(filePath: string): boolean {
  return PROSE_EXTENSIONS.has(extensionOf(filePath));
}

function extensionOf(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}
