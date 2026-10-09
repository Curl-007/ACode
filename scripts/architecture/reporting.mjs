import path from "node:path";
import { discoverFiles, loadPolicy, moduleForFile, posix } from "./policy.mjs";

// 报告与阅读包生成（2026-10-05 自 index.mjs 抽出：ratchet 逻辑落地后 index.mjs
// 超出 oxlint max-lines 400——治理工具自身必须先守规则）。

export async function generateContext({ cwd = process.cwd(), moduleId }) {
  const policy = await loadPolicy(cwd);
  const module = policy.modules.find((item) => item.id === moduleId);
  if (!module) throw new Error(`未知模块: ${moduleId}`);
  const files = await discoverFiles(policy);
  const moduleFiles = files.filter((file) => moduleForFile(file, policy)?.id === moduleId);
  const manifest = moduleFiles.find((file) => path.basename(file) === "module.ts");
  const contracts = moduleFiles.filter((file) => path.basename(file).startsWith("contract."));
  const dependencyContracts = module.requires.flatMap((dependencyId) => {
    const dependency = policy.modules.find((item) => item.id === dependencyId);
    const dependencyFiles = files.filter(
      (file) => moduleForFile(file, policy)?.id === dependencyId,
    );
    const publicFiles = (dependency?.publicEntrypoints ?? [])
      .flatMap((entry) => [
        path.resolve(cwd, entry),
        ...(dependency?.roots ?? []).map((root) => path.resolve(root, entry)),
      ])
      .filter((file) => dependencyFiles.includes(file));
    const fallbackFiles = dependencyFiles.filter((file) => path.basename(file) === "contract.ts");
    return [...new Set(publicFiles.length > 0 ? publicFiles : fallbackFiles)].map(
      (file) => `- ${posix(path.relative(cwd, file))}`,
    );
  });
  return [
    `# Architecture context: ${module.id}`,
    `owner: ${module.owner ?? "unassigned"}`,
    `managed: ${module.managed}`,
    `requires: ${module.requires.join(", ") || "none"}`,
    "",
    "## Files",
    ...(manifest ? [`- ${posix(path.relative(cwd, manifest))}`] : ["- module.ts: missing"]),
    ...contracts.map((file) => `- ${posix(path.relative(cwd, file))}`),
    ...module.publicEntrypoints.map((entry) => `- public: ${entry}`),
    "",
    "## Direct dependency contracts",
    ...(dependencyContracts.length > 0 ? dependencyContracts : ["- none discovered"]),
    "",
    "## Boundaries",
    "- Cross-module imports must use declared requirements and public entrypoints.",
    "- Add a contract example before exposing a new capability.",
  ].join("\n");
}

export function formatReport(result) {
  const lines = [
    `architecture: ${result.newViolations.length === 0 ? "OK" : "FAILED"} (已检查范围内)`,
    `violations: ${result.violations.length}`,
    `baseline: ${result.baselineViolations.length}`,
    `new: ${result.newViolations.length}`,
    `regrown after ratchet: ${result.regrown?.length ?? 0}`,
    `legacy over-limit (ratchet, 只减不增): ${result.summary?.legacyOverLimit ?? 0}`,
    ...coverageLines(result.coverage),
  ];
  for (const item of result.newViolations)
    lines.push(`- ${item.rule} ${item.file}: ${item.message}`);
  return lines.join("\n");
}

export function formatMarkdownReport(result) {
  const lines = [
    `# Architecture report`,
    "",
    `- Status: **${result.newViolations.length === 0 ? "OK" : "FAILED"}**（仅已检查范围）`,
    `- Violations: ${result.violations.length}`,
    `- Baseline: ${result.baselineViolations.length}`,
    `- New: ${result.newViolations.length}`,
    `- Regrown after ratchet: ${result.regrown?.length ?? 0}`,
    `- Legacy over-limit files (ratchet, 只减不增): ${result.summary?.legacyOverLimit ?? 0}`,
    ...coverageLines(result.coverage).map((line) => `- ${line}`),
    "- 未检查范围中的规则未通过，也未失败；未纳管模块仍需逐模块补充契约与边界。",
  ];
  if (result.newViolations.length > 0) {
    lines.push("", "## New violations", "", "| Rule | File | Message |", "| --- | --- | --- |");
    for (const item of result.newViolations)
      lines.push(`| ${item.rule} | ${item.file} | ${item.message.replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}

function coverageLines(coverage) {
  if (!coverage) return ["coverage: unavailable (不代表全仓边界已检查)"];
  return [
    `managed: ${coverage.managed.moduleIds.length} modules, ${coverage.managed.fileCount} files (${coverage.managed.moduleIds.join(", ") || "none"})`,
    `managed checked: ${coverage.managed.checkedRules.join(", ")}`,
    `legacy: ${coverage.legacy.moduleIds.length} modules, ${coverage.legacy.fileCount} files`,
    `legacy checked: ${coverage.legacy.checkedRules.join(", ")}`,
    `legacy unchecked: ${coverage.legacy.uncheckedRules.join(", ") || "none"}`,
  ];
}
