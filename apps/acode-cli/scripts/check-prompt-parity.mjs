// ============================================================
// Check Prompt Parity - 段清单 × 基线 差异报告（P3，仅报告不阻断）
// ============================================================
//
// specs/system-prompt-section-registry.md R6 / 方案 §10.2：
// - 输入 = 当前构建的 prompt-manifest（代码实时产物）+ repo 内基线清单
//   （scripts/parity-baseline.json，只含机制对照项名称与期望段 id，
//   **绝不含任何第三方文本**——合规红线，形状由 validateBaselineShape 把守）
//   + repo 内已提交的 manifest 文件（hash 漂移的对照面）；
// - 输出 = 差异报告（缺失段 / 新增段 / hash 变化段），供人工判定是否有意变更；
// - CI 策略：parity 差异**仅报告不阻断**——本脚本对差异恒退出码 0；
//   退出码非 0 只表示操作性错误（基线/清单文件缺失、损坏或形状违规）。
//   「manifest 与代码一致」的硬校验（阻断）归 generate-prompt-manifest.mjs --check。
//
// 用法（apps/acode-cli 目录）：
//   node --import tsx scripts/check-prompt-parity.mjs [--baseline <file>] [--manifest <file>]

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computePromptManifestSections } from "../packages/core/src/context/manifest.ts";
import {
  buildParityReport,
  renderParityReport,
  validateBaselineShape,
} from "./prompt-parity-lib.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_BASELINE = join(SCRIPT_DIRECTORY, "parity-baseline.json");
const DEFAULT_MANIFEST = join(
  APP_ROOT,
  "packages/core/src/context/generated/prompt-manifest.json",
);

function getArgValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback;
}

const baselinePath = getArgValue("--baseline", DEFAULT_BASELINE);
const manifestPath = getArgValue("--manifest", DEFAULT_MANIFEST);

async function readJsonFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.error(`prompt-parity: ${label} file not found: ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`prompt-parity: ${label} file is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

const baseline = await readJsonFile(baselinePath, "baseline");
const baselineProblems = validateBaselineShape(baseline);
if (baselineProblems.length > 0) {
  // 基线形状违规是操作性错误（可能意味着有人试图把非「名称+id」内容塞进基线）——阻断。
  console.error(`prompt-parity: baseline shape violations (${baselinePath}):`);
  for (const problem of baselineProblems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const manifest = await readJsonFile(manifestPath, "manifest");
const currentSections = computePromptManifestSections();

const report = buildParityReport({
  baseline,
  manifestSections: Array.isArray(manifest.sections) ? manifest.sections : [],
  currentSections,
});

console.log(renderParityReport(report));
const totalDiffs =
  report.missingSections.length + report.addedSections.length + report.hashChangedSections.length;
console.log(
  totalDiffs === 0
    ? "prompt-parity: no differences (baseline × manifest × code)"
    : `prompt-parity: ${totalDiffs} difference(s) reported for human review — 不阻断（R6 CI 策略）`,
);
