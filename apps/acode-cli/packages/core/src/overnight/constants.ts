// 机制参照 jcode (MIT)：crates/jcode-overnight-core（三层时间点/四种 poke/TaskCard 字段）与
// crates/jcode-app-core/src/overnight.rs（supervisor 循环/monitored turn 双 ticker），
// 自撰 TypeScript 实现（apps/acode-cli/specs/overnight-execution.md §K3 常量表）。

/** R1：时长硬限下限——1 分钟。挂机形态不允许「几秒钟的 overnight」。 */
export const OVERNIGHT_MIN_MS = 60_000;

/**
 * R1：时长硬限上限——12 小时。jcode 本地 CLI 形态是 72h，ACode 桌面挂机场景收紧：
 * 单进程 bash/模型连接的可靠性窗口与 renderer 内存稳态（soak 结论）不宜拉到 72h。
 */
export const OVERNIGHT_MAX_MS = 12 * 3_600_000;

/** R2：收尾提前量的上限帽（30 分钟）。 */
export const HANDOFF_LEAD_MAX_MS = 30 * 60_000;

/**
 * R2 派生规则：handoff lead = min(30min, duration/4)。
 * 做成函数而非常量，因为短 run 需要收缩——1h 的 run 只提前 15 分钟收尾，
 * 保证收尾窗非零且不超过 run 总长的 1/4，避免「刚启动就进收尾窗」。
 */
export function handoffLeadMs(durationMs: number): number {
  return Math.min(HANDOFF_LEAD_MAX_MS, Math.floor(durationMs / 4));
}

/** R2：醒后宽限期——到点后 2 小时（jcode 同值；ACode 不做配置面）。 */
export const POST_WAKE_GRACE_MS = 2 * 3_600_000;

/** R2：supervisor 循环等待间隔的上限（每轮至少重读一次取消标志的节奏）。 */
export const SUPERVISOR_TICK_MS = 60_000;

/** R4：monitored turn 的「仍在运行」warn 事件间隔（30 分钟一次）。 */
export const TURN_LONG_NOTICE_MS = 30 * 60_000;

/** R4：monitored turn 的资源采样间隔（5 分钟一次）。 */
export const RESOURCE_SAMPLE_MS = 5 * 60_000;

/** R2/R4：coordinator turn 连续失败熔断阈值（复用 compact 的连续失败上限先例语义）。 */
export const MAX_CONSECUTIVE_TURN_FAILURES = 3;
