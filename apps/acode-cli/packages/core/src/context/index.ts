// ============================================================
// Context Builder exports
// ============================================================

export * from "./types.js";
export * from "./builder.js";
export * from "./utils.js";
// P2 段注册表基础设施（specs/system-prompt-section-registry.md）：
// descriptor 类型、条件组装管线（resolveSections）、本地诊断旗标与两条注册表。
export * from "./registry.js";
// P3 提示词版本清单（R6）：manifest 数据核心（目录计算 / hash / 硬校验）。
export * from "./manifest.js";

// Section builders (for testing)
export { buildCliPrefixSection } from "./sections/cli-prefix.js";
export { buildIdentitySection } from "./sections/identity.js";
export { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
export { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
export { buildSkillsSection } from "./sections/skills.js";
export { buildCurrentDateSection } from "./sections/current-date.js";
export { buildMemorySection } from "./sections/memory.js";
export { buildDesktopContextSection } from "./sections/desktop.js";
