# 文档索引

本目录承载**跨模块**的计划、审查、治理与设计文档。单个模块的行为规范走 spec-first 约定，写在 `packages/*/specs/` 与 `apps/acode-cli/specs/` 里，不在此处——改行为前先更新对应 spec。

分区规则：

- **活跃治理 / 规范**：日常工作会反复引用的规则，多数被 `AGENTS.md`、CI 工作流、`scripts/` 或源码引用，**禁止移动或重命名**。
- **路线图 / 进行中计划**：仍在指导后续工作的升级计划；条目常带「拟议 / 尚未实现」标记，不代表行为已落地。
- **设计依据**：已实现功能的设计原理与基线记录，常被源码注释回指。
- **审查（reviews/）**：按日期归档的全项目 review 与各专项。
- **归档（archive/）**：已完成、不再指导后续工作的 plan / handoff / 一次性记录，保留作实现状态与验收证据。

> 带 🔒 的文档被 `AGENTS.md` / CI / 源码 / 测试引用，移动会打断链接，改动前先查入链。

## 活跃治理 / 规范

| 文档                                                                          | 内容                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [git-collaboration.md](git-collaboration.md) 🔒                               | 分支模型、提交规范、合并与发布流程                                                 |
| [legacy-protocol-convergence-plan.md](legacy-protocol-convergence-plan.md) 🔒 | legacy 协议收敛里程碑（只删不增的退役计划）                                        |
| [tech-debt-backlog.md](tech-debt-backlog.md) 🔒                               | 技术债台账，CI 引用                                                                |
| [security-hardening-plan.md](security-hardening-plan.md)                      | P0–P3 安全加固路线图（P3 尚未开始，仍活跃）                                        |
| [specs/engineering-invariants.md](specs/engineering-invariants.md) 🔒         | 跨切面工程不变量（失败降级、生命周期、并发、持久化、性能、UI、协作派工、API 设计） |
| [specs/cli-validation-gates.md](specs/cli-validation-gates.md) 🔒             | CLI 验证门禁，被 ci.yml / release.yml / typecheck-gate 引用                        |
| [specs/ci-platform-matrix.md](specs/ci-platform-matrix.md) 🔒                 | CI 平台矩阵规格，被 ci.yml / release.yml 引用                                      |
| [specs/architecture-coverage.md](specs/architecture-coverage.md) 🔒           | 架构覆盖规格                                                                       |
| [specs/architecture-ratchet.md](specs/architecture-ratchet.md)                | 架构棘轮（超限文件计数只减不增）                                                   |

## 路线图 / 进行中计划

| 文档                                                                                     | 内容                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [capability-uplift-plan.md](capability-uplift-plan.md) 🔒                                | 能力提升批次计划，多个 spec / script 回指                                                 |
| [project-upgrade-recommendations-2026-10.md](project-upgrade-recommendations-2026-10.md) | 2026-10 升级立项依据                                                                      |
| [upgrades/product-and-support-2026-10.md](upgrades/product-and-support-2026-10.md) 🔒    | 产品与支持升级项（多为提案）                                                              |
| [upgrades/runtime-and-protocol-2026-10.md](upgrades/runtime-and-protocol-2026-10.md)     | runtime 与协议升级项（多为提案）                                                          |
| [upgrades/quality-and-release-2026-10.md](upgrades/quality-and-release-2026-10.md) 🔒    | 质量与发布升级项（U01 已落地，其余提案）                                                  |
| [k-series-upgrade-plan.md](k-series-upgrade-plan.md)                                     | K 系列升级计划（K1-K9 已全部实施；非目标项维持登记，被 spec 当 §K1–K9 立项依据引用，故留活跃区） |
| [desktop-evolution-analysis-2026-10-26.md](desktop-evolution-analysis-2026-10-26.md)      | 桌面端功能进化分析：四个已立项未实施 U 项核验、U14 工具链裁决点、协同接线机会、建议排序       |

## 设计依据

| 文档                                                                    | 内容                                        |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| [credential-os-keychain-design.md](credential-os-keychain-design.md) 🔒 | 凭据 OS 钥匙串设计原理，源码注释回指        |
| [j5-performance-baseline.md](j5-performance-baseline.md) 🔒             | Agent CLI 四种运行形态的性能与资源基线      |
| [auto-mode-classifier-design.md](auto-mode-classifier-design.md)        | auto 模式风险分类器设计（对应 spec 已存在） |
| [prompt-corpus-audit-2026-10.md](prompt-corpus-audit-2026-10.md) 🔒     | 提示语料审计，源码注释回指                  |

## 审查（reviews/）

| 文档                                                                                             | 内容                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [project-review-2026-10-26.md](project-review-2026-10-26.md)                                     | **当前最新** 全项目 review 枢纽（1.0.4 基线）：上轮 16 项整改全部核验站住 + 4×P2 新发现（2 个在修复引入的重连模块内）                                                          |
| [reviews/2026-10-26/](reviews/2026-10-26/)                                                       | 本轮 11 个专项 review（整改核验 + 新发现，主审对全部 P2 逐行亲验）                                                                                                            |
| [project-review-2026-10-22.md](project-review-2026-10-22.md)                                     | 上一轮全项目 review 枢纽（1.0.3 基线；其整改批次即 1.0.4 发布）                                                                                                               |
| [reviews/2026-10-22/](reviews/2026-10-22/)                                                       | 上一轮 11 个专项 review + fix-status（多个 spec / test 引用，活跃）                                                                                                           |
| [project-review-2026-10-08.md](project-review-2026-10-08.md)                                     | 更早一轮全项目 review（基线 `dev/0.0.7`）                                                                                                                                     |
| [reviews/2026-10-08/](reviews/2026-10-08/)                                                       | 该轮专项 + 修复记录（仍被后续 review、活跃文档与源码注释引用，故留原位）                                                                                                      |
| [codex-orchestration-plan-audit-2026-10-10.md](codex-orchestration-plan-audit-2026-10-10.md)     | Codex 编排计划审计（审计对象已归档，见下）                                                                                                                                    |
| [omp-cli-replacement-assessment-2026-10-23.md](omp-cli-replacement-assessment-2026-10-23.md)     | 用 omp（oh-my-pi）替换 ACode Agent CLI 的可行性评估（4 路子代理分析 + 亲验；结论：不建议完整替换，可行形态是 shim 桥接共存）**待决策**                                        |
| [jcode-cli-replacement-assessment-2026-10-23.md](jcode-cli-replacement-assessment-2026-10-23.md) | 用 jcode（纯 Rust）替换 ACode Agent CLI 的可行性评估（3 路子代理分析 + 亲验；结论：净优于 omp 但 Windows 无稳定驱动通道，推进前需安全硬化层）；§8 含两候选横向对比 **待决策** |

## 归档（archive/）

已完成、不再指导后续工作的文档。部分仍被 spec / test 作为「来源」引用，链接已指向 `archive/`。

**已完成的历史 plan / handoff / 记录**：

| 文档                                                                                                             | 内容                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [archive/security-hardening-handoff.md](archive/security-hardening-handoff.md)                                   | 安全加固各批次实现状态、验证命令与交接                                  |
| [archive/jcode-inspired-upgrade-plan.md](archive/jcode-inspired-upgrade-plan.md)                                 | 防御机制升级路线图（八个实施条目全部落地）                              |
| [archive/jcode-upgrade-handoff.md](archive/jcode-upgrade-handoff.md)                                             | 上述升级的逐项实现状态与后续                                            |
| [archive/cli-dispatch-and-system-prompt-upgrade-plan.md](archive/cli-dispatch-and-system-prompt-upgrade-plan.md) | Agent dispatch 与系统提示升级路线图（Phase 0–3 已实施；被多个测试引用） |
| [archive/codex-orchestration-integration-plan.md](archive/codex-orchestration-integration-plan.md)               | Codex 编排集成计划（已全部实施；被 9 个 spec 引用）                     |
| [archive/renderer-memory-soak-2026-10-01.md](archive/renderer-memory-soak-2026-10-01.md)                         | Renderer 内存泄漏根因、修复与真机验证                                   |
| [archive/security-scan-triage-2026-09-29.md](archive/security-scan-triage-2026-09-29.md)                         | 深度安全扫描 118 项发现的分级处置                                       |

**一次性外部验收报告与预研登记**：

| 文档                                                                                               | 内容                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [archive/settings-port-verification.md](archive/settings-port-verification.md)                     | 外部仓 settings 移植验收报告                                   |
| [archive/usage-statusbar-port-verification.md](archive/usage-statusbar-port-verification.md)       | 外部仓 usage statusbar 移植验收报告                            |
| [archive/agent-teams-port-verification.md](archive/agent-teams-port-verification.md)               | 外部仓 agent teams 移植验收报告                                |
| [archive/mobile-device-control-gap-audit.md](archive/mobile-device-control-gap-audit.md)           | 移动设备控制差距审计（预研登记）                               |
| [archive/value-extraction-23737-registrations.md](archive/value-extraction-23737-registrations.md) | 逆向研究价值提取登记（基线 `feature/cli-value-extract-23737`） |
| [archive/vm-sandbox-roadmap.md](archive/vm-sandbox-roadmap.md)                                     | VM / OS 容器级沙箱预研（当前构建无任何 OS 级隔离）             |

归档规则：带日期的一次性记录、已完成且不再指导后续工作的计划归入 `archive/`；被 `AGENTS.md` / CI / 源码 / 测试当**活跃规则**引用者永不归档（历史「来源」引用不在此列，可归档并把链接指向 `archive/`）。
