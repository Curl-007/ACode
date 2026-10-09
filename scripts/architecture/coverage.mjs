const MANAGED_RULES = [
  "missing-module-artifact",
  "missing-public-entrypoint",
  "max-file-lines",
  "max-contract-lines",
  "max-public-methods",
  "disable-count",
  "domain-io",
  "layer-direction",
  "module-dependency",
  "ui-implementation-import",
  "deep-import",
  "unresolved-workspace-import",
  "cycle",
];
const LEGACY_UNCHECKED_RULES = [
  "missing-module-artifact",
  "max-contract-lines",
  "max-public-methods",
  "disable-count",
  "domain-io",
  "layer-direction",
  "module-dependency",
  "unresolved-workspace-import",
  "ui-implementation-import",
  "cycle",
];

/** 覆盖从全量 discovered files 派生，不能让 --changed 的违规子集冒充全仓治理。 */
export function architectureCoverage(policy, files, modulesByFile) {
  const managed = policy.modules.filter((module) => module.managed);
  const legacy = policy.modules.filter((module) => !module.managed);
  const managedFiles = files.filter((file) => modulesByFile.get(file)?.managed).length;
  const legacyFiles = files.filter(
    (file) => modulesByFile.get(file) && !modulesByFile.get(file).managed,
  ).length;
  return {
    totalFiles: files.length,
    managed: {
      moduleIds: managed.map((module) => module.id).sort(),
      fileCount: managedFiles,
      checkedRules: MANAGED_RULES,
    },
    legacy: {
      moduleIds: legacy.map((module) => module.id).sort(),
      fileCount: legacyFiles,
      checkedRules: policy.global.managedOnly
        ? [
            "max-file-lines-ratchet",
            "missing-public-entrypoint",
            "imports-into-managed-public-entrypoint",
            "reverse-dependency-graph",
          ]
        : MANAGED_RULES,
      uncheckedRules: policy.global.managedOnly ? LEGACY_UNCHECKED_RULES : [],
    },
  };
}
