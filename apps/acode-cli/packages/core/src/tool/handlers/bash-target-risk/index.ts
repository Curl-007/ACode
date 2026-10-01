// bash 目标 blast-radius 风险分级模块（J1-1）公共出口。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md 与
// apps/acode-cli/specs/npm-script-body-scan.md。
//
// 消费点（不新建旁路）：
// - tool/handlers/bash.ts 的 capability 计算（与既有 riskLevel 取更严者合并）；
// - permission/bypass-immune-breakers.ts 的 catastrophic 命中类（deny 级熔断）；
// - tool/handlers/bash-command-permission-policy.ts 的规则建议收窄；
// - tool/handlers/bash-package-script-context.ts 的 run 族预取（R6 边界⑥收口）：
//   它只消费纯解析助手（PACKAGE_MANAGER_PROGRAMS）来对齐管理器词汇，IO 全部在
//   接线层自身，bash-target-risk 模块保持零 IO 宪法。
// 类型细节（TargetRiskAssessment/Finding/Level/Context）见 ./types.ts，模块内部消费。
export { assessBashCommandTargetRisk } from "./assess.js";
export { PACKAGE_MANAGER_PROGRAMS } from "./npm-scripts.js";
export type { PackageScriptSource, TargetRiskContext } from "./types.js";
