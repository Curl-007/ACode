// bash 目标 blast-radius 风险分级模块（J1-1）公共出口。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md。
//
// 消费点只有三个（不新建旁路）：
// - tool/handlers/bash.ts 的 capability 计算（与既有 riskLevel 取更严者合并）；
// - permission/bypass-immune-breakers.ts 的 catastrophic 命中类（deny 级熔断）；
// - tool/handlers/bash-command-permission-policy.ts 的规则建议收窄。
// 类型细节（TargetRiskAssessment/Finding/Level）见 ./types.ts，模块内部消费。
export { assessBashCommandTargetRisk } from "./assess.js";
export type { TargetRiskContext } from "./types.js";
