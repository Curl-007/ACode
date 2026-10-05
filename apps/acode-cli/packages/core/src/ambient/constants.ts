// 机制参照 jcode (MIT)：crates/jcode-ambient-types 与
// crates/jcode-app-core/src/ambient/（AdaptiveScheduler 预算公式、指数退避、活跃暂停、
// wake nudge），自撰 TypeScript 实现（apps/acode-cli/specs/ambient-budget-scheduler.md）。
//
// 本文件是 ambient 域的常量唯一所有者（spec「常量」表）；改动值必须先改 spec。

/** R3：interval 下限（jcode 同值）——再急也不能 5 分钟内连续 cycle。 */
export const AMBIENT_MIN_INTERVAL_MS = 5 * 60_000;
/** R3：interval 上限（jcode 同值）——再闲也不超过 2 小时一次。 */
export const AMBIENT_MAX_INTERVAL_MS = 120 * 60_000;
/** R3：ambient 最多拿用户余量的 20%（reserve 留给用户）。 */
export const AMBIENT_USER_BUDGET_RESERVE = 0.8;
/** R3：无历史 cycle 消耗时的保守均值（宁可少跑，不可低估成本）。 */
export const AMBIENT_CYCLE_TOKEN_FALLBACK = 10_000;
/** R3：指数退避倍率上限。 */
export const AMBIENT_BACKOFF_CAP = 64;
/** R3：runner 单次 sleep 的下限（tick floor）——防忙轮询。 */
export const AMBIENT_TICK_FLOOR_MS = 30_000;
/** R3：busy（用户活跃）暂停后的重查间隔。 */
export const AMBIENT_BUSY_RECHECK_MS = 60_000;
/** R3：跨进程防双跑的 claim 过期阈值（services 定时任务域 CLAIM_STALE_MS 同款语义）。 */
export const AMBIENT_QUEUE_CLAIM_STALE_MS = 10 * 60_000;
/**
 * F2（批次C）：runner 长 sleep 的心跳分段上限 = ⌊STALE/3⌋。单次 sleep 最长可达
 * AMBIENT_MAX_INTERVAL_MS=120min，远超 CLAIM_STALE=10min——不分段的话 claim 在睡梦中
 * 过期被接管而原 runner 无从察觉（双跑）。每段醒先续租再继续剩余睡眠，三段以内必有一次
 * 续租落在 STALE 窗口内。
 */
export const AMBIENT_CLAIM_RENEW_SEGMENT_MS = Math.floor(AMBIENT_QUEUE_CLAIM_STALE_MS / 3);
/**
 * R2/F11（批次C）：每来源会话（createdBySession）的 schedule 上限（防滥用堆积），
 * 超限给可读错误。无 createdBySession 的项按同一键（undefined）计数。
 */
export const SCHEDULE_MAX_ITEMS = 50;
/**
 * F11（批次C）：全局软上限——防多会话各自 50 项导致总量失控（spec 偏差补记：
 * R2 字面「每任务 50」在旧实现里被写成全局 50，本批归属化后补全局兜底）。
 */
export const SCHEDULE_GLOBAL_MAX_ITEMS = 200;
/** R1：usage 账本滚动窗口。 */
export const USAGE_LEDGER_WINDOW_MS = 24 * 60 * 60_000;
/** R1：账本每 N 条落盘一次（缓冲写；jcode UsageLog 同款）。 */
export const USAGE_LEDGER_FLUSH_EVERY = 10;
/**
 * F7（批次C）：trim 重写阈值——裁剪量占行数比例 ≤ 该值时不重写文件（缩小与他进程
 * append 的交错窗口）；超过才做全量重写。
 */
export const USAGE_LEDGER_TRIM_REWRITE_THRESHOLD = 0.1;
/**
 * F8（批次C）：flush 失败回填后的 pending 缓冲上限——回填仍超上限才丢最旧
 *（防持续失败下内存无界增长）。
 */
export const USAGE_LEDGER_MAX_PENDING_LINES = 1000;
