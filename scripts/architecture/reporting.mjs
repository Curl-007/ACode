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
    const dependencyFiles = files.filter(
      (file) => moduleForFile(file, policy)?.id === dependencyId,
    );
    return dependencyFiles
      .filter((file) => path.basename(file) === "contract.ts")
      .map((file) => `- ${posix(path.relative(cwd, file))}`);
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
    `architecture: ${result.newViolations.length === 0 ? "OK" : "FAILED"}`,
    `violations: ${result.violations.length}`,
    `baseline: ${result.baselineViolations.length}`,
    `new: ${result.newViolations.length}`,
    `legacy over-limit (ratchet, 只减不增): ${result.summary?.legacyOverLimit ?? 0}`,
  ];
  for (const item of result.newViolations)
    lines.push(`- ${item.rule} ${item.file}: ${item.message}`);
  return lines.join("\n");
}

export function formatMarkdownReport(result) {
  const lines = [
    `# Architecture report`,
    "",
    `- Status: **${result.newViolations.length === 0 ? "OK" : "FAILED"}**`,
    `- Violations: ${result.violations.length}`,
    `- Baseline: ${result.baselineViolations.length}`,
    `- New: ${result.newViolations.length}`,
    `- Legacy over-limit files (ratchet, 只减不增): ${result.summary?.legacyOverLimit ?? 0}`,
  ];
  if (result.newViolations.length > 0) {
    lines.push("", "## New violations", "", "| Rule | File | Message |", "| --- | --- | --- |");
    for (const item of result.newViolations)
      lines.push(`| ${item.rule} | ${item.file} | ${item.message.replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}
