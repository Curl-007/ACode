// bash 目标 blast-radius 风险分级的公共类型（J1-1）。
// 规格见 apps/acode-cli/specs/bash-target-blast-radius.md。
//
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-command-risk/src/lib.rs
// 的 RiskLevel/RiskFinding/RiskAssessment/RiskContext 形态，自撰 TypeScript 实现。

/**
 * 段级 cwd 跟踪状态（对抗复审 HIGH-1）。
 *
 * shell 的 cwd 是会话状态，而评估逐 invocation 进行：不跟踪 `cd` 就等于让所有
 * 相对目标以固定基准分级，`cd ~ && rm -rf .ssh` 会被当成删工作区内的 `.ssh` 放行。
 * resolved 与 unresolved 互斥使用：
 * - `resolved`：当前目录已静态解析（归一化 slash 形态），相对目标按它重新定基；
 * - `unresolved`：cwd 曾被动态改变且新值不可静态解析（`cd $X`、`popd`、`cd -`、
 *   命令替换）——后续**相对**目标的破坏性操作 fail-closed 升至少 confirm，
 *   绝对目标不受影响（落点与 cwd 无关）。
 */
export interface TrackedCwd {
  readonly resolved?: string;
  readonly unresolved: boolean;
}

/**
 * 目标风险四级（严重度递增）。分级回答的是「这条命令的破坏半径有多大、
 * 能否静态确定」，与既有命令名维度（HIGH_RISK_ROOT_COMMANDS）正交。
 */
export type TargetRiskLevel = "safe" | "low" | "confirm" | "catastrophic";

/** 级别严重度序：合并时取更严者（safe < low < confirm < catastrophic）。模块内部使用。 */
const TARGET_RISK_LEVEL_ORDER: readonly TargetRiskLevel[] = [
  "safe",
  "low",
  "confirm",
  "catastrophic",
];

/** 单条命中的结构化理由；reason 面向模型展示，target 是触发它的具体路径/参数。 */
export interface TargetRiskFinding {
  readonly level: Exclude<TargetRiskLevel, "safe">;
  readonly reason: string;
  readonly target?: string;
}

/** 一条命令的完整判定。level 是 findings 的最大严重度；targets 是命中目标去重投影。 */
export interface TargetRiskAssessment {
  readonly level: TargetRiskLevel;
  readonly findings: readonly TargetRiskFinding[];
  readonly targets: readonly string[];
}

/**
 * 判定上下文。模块是纯函数、无 IO：homedir/platform 由调用方注入
 * （接线层用 node:os 与 process.platform），模块自身不读环境。
 */
export interface TargetRiskContext {
  /** 会话工作目录：相对目标的解析基准，也是「有界破坏」白名单的根。 */
  readonly workingDirectory?: string;
  /** 工作区根：与 workingDirectory 同等对待的有界破坏范围。 */
  readonly workspaceRoot?: string;
  /** 受信 homedir：`~`/`$HOME`/`%USERPROFILE%` 的展开基准，命令自身的 HOME= 重赋值不影响它。 */
  readonly homeDirectory?: string;
  /** 宿主平台（process.platform）：决定路径大小写敏感性与 MSYS 挂载形 `/c/` 映射。 */
  readonly platform?: string;
  /**
   * 内部字段（HIGH-1 cwd 段级跟踪）：评估器在 cd/pushd/env -C 等改变目录后派生
   * context 时写入，调用方（bash.ts/breakers）无需提供。paths.ts 用它给相对目标
   * 重新定基；unresolved 时相对目标 fail-closed。
   */
  readonly trackedCwd?: TrackedCwd;
}

function targetRiskLevelRank(level: TargetRiskLevel): number {
  return TARGET_RISK_LEVEL_ORDER.indexOf(level);
}

export function stricterTargetRiskLevel(a: TargetRiskLevel, b: TargetRiskLevel): TargetRiskLevel {
  return targetRiskLevelRank(a) >= targetRiskLevelRank(b) ? a : b;
}
