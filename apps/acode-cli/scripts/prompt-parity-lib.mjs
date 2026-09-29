// ============================================================
// Prompt Parity Lib - 基线校验与差异报告的纯函数（P3）
// ============================================================
//
// specs/system-prompt-section-registry.md R6 / 方案 §10.2：
// - 输入 = 当前构建的 prompt-manifest + repo 内基线清单（parity-baseline.json，
//   **只含机制对照项名称与期望段 id，绝不含任何第三方文本**——合规红线）；
// - 输出 = 差异报告（缺失段 / 新增段 / hash 变化段），供人工判定；
// - parity 差异**仅报告不阻断**（CI 阻断项是「manifest 与代码一致」，
//   归 generate-prompt-manifest.mjs --check 的 verifyPromptManifest 硬校验）。
//
// 本文件是纯函数库（无顶层副作用）：check-prompt-parity.mjs 是它的 CLI 壳，
// 测试直接 import 本文件。

/** 基线条目：机制对照项名称 + 期望段 id。仅此两个字段（验收场景 8 有键集断言）。 */
export const BASELINE_ENTRY_FIELDS = Object.freeze(["id", "mechanism"]);
export const BASELINE_TOP_LEVEL_FIELDS = Object.freeze(["version", "entries"]);
export const BASELINE_VERSION = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 基线文件形状校验（操作性错误 → 脚本退出码非 0；这不是 parity 差异）。
 * 同时守住合规红线：条目只允许 id + mechanism 两个字符串字段，
 * 不允许任何长文本/编码载荷字段（第三方原文进不了基线）。
 */
export function validateBaselineShape(baseline) {
  const problems = [];
  if (!isRecord(baseline)) {
    return ["baseline is not an object"];
  }
  for (const key of Object.keys(baseline)) {
    if (!BASELINE_TOP_LEVEL_FIELDS.includes(key)) {
      problems.push(`baseline has unexpected top-level field "${key}" (allowed: ${BASELINE_TOP_LEVEL_FIELDS.join(", ")})`);
    }
  }
  if (baseline.version !== BASELINE_VERSION) {
    problems.push(`baseline version ${String(baseline.version)} !== expected ${BASELINE_VERSION}`);
  }
  if (!Array.isArray(baseline.entries)) {
    problems.push("baseline entries is not an array");
    return problems;
  }
  baseline.entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`baseline entry[${index}] is not an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!BASELINE_ENTRY_FIELDS.includes(key)) {
        problems.push(`baseline entry[${index}] has unexpected field "${key}" (allowed: ${BASELINE_ENTRY_FIELDS.join(", ")})`);
      }
    }
    for (const field of BASELINE_ENTRY_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
        problems.push(`baseline entry[${index}].${field} must be a non-empty string`);
      }
    }
  });
  const ids = baseline.entries.filter(isRecord).map((entry) => entry.id);
  ids.forEach((id, index) => {
    if (typeof id === "string" && ids.indexOf(id) !== index) {
      problems.push(`baseline entry id "${id}" is duplicated`);
    }
  });
  return problems;
}

/**
 * 差异报告（方案 §10.2 的三类输出）：
 * - missingSections：基线期望的段 id 不在当前目录（段被移除/改名或 persistable 翻面）；
 * - addedSections：当前目录里未被基线引用的段 id（新段待人工登记机制对照项）；
 * - hashChangedSections：repo 内 manifest 与当前代码产物的同 id 段 hash 不一致
 *   （= 段文本漂移；「改一个段文本后重跑，报告精确指出该段」）。
 * currentSections 来自代码（computePromptManifestSections），manifestSections 来自
 * repo 内 manifest 文件；两者都是 { id, hash } 形状即可。
 */
export function buildParityReport({ baseline, manifestSections, currentSections }) {
  const baselineEntries = Array.isArray(baseline?.entries) ? baseline.entries.filter(isRecord) : [];
  const baselineIds = new Set(baselineEntries.map((entry) => entry.id));
  const currentById = new Map(
    (currentSections ?? []).filter(isRecord).map((section) => [section.id, section]),
  );
  const manifestById = new Map(
    (manifestSections ?? []).filter(isRecord).map((section) => [section.id, section]),
  );

  const missingSections = baselineEntries
    .filter((entry) => typeof entry.id === "string" && !currentById.has(entry.id))
    .map((entry) => ({ id: entry.id, mechanism: entry.mechanism }));

  const addedSections = [...currentById.keys()]
    .filter((id) => !baselineIds.has(id))
    .map((id) => ({ id }));

  const hashChangedSections = [...currentById.entries()]
    .filter(([id, section]) => {
      const previous = manifestById.get(id);
      return previous !== undefined && previous.hash !== section.hash;
    })
    .map(([id, section]) => ({
      id,
      manifestHash: manifestById.get(id)?.hash,
      currentHash: section.hash,
    }));

  return { missingSections, addedSections, hashChangedSections };
}

/** 报告渲染（stdout 文本；parity 差异仅报告不阻断）。 */
export function renderParityReport(report) {
  const lines = ["prompt-parity report (仅报告，不阻断 — spec R6 CI 策略)"];
  lines.push(`缺失段 (baseline 期望但当前目录缺席): ${report.missingSections.length}`);
  for (const item of report.missingSections) {
    lines.push(`  - ${item.id} — ${item.mechanism}`);
  }
  lines.push(`新增段 (当前目录有但 baseline 未登记): ${report.addedSections.length}`);
  for (const item of report.addedSections) {
    lines.push(`  - ${item.id}`);
  }
  lines.push(`hash 变化段 (repo manifest vs 当前代码): ${report.hashChangedSections.length}`);
  for (const item of report.hashChangedSections) {
    lines.push(`  - ${item.id}: ${String(item.manifestHash)?.slice(0, 12)}… → ${String(item.currentHash)?.slice(0, 12)}…`);
  }
  return lines.join("\n");
}
