/**
 * renderer 内容状态面包屑的 ui 侧（specs/main-stall-diagnostics.md R11）。
 *
 * 周期上报**分桶**内容状态给 main（stall/unresponsive 归因用）。桶化理由：精确值
 * 既是噪声（每条消息都 diff）又是隐私面（内容规模细节），wire 上只有桶名。
 * 闭集与阈值和 desktop `src/main/contentBreadcrumb.ts` 各持一份副本，spec R11 是
 * 唯一事实源；上移 packages/shared 属接线需求（channels.ts 归 W1-5）。
 *
 * 本文件是纯逻辑（无 React、无 DOM 依赖），transport 经 `send` 注入——ui 不直接
 * 调 window.acode（AGENTS.md 平台边界）；接线时由 desktop renderer 传入 preload
 * 暴露的 send 面。
 */

// ---------------------------------------------------------------------------
// wire 契约（snake_case，与 main 侧 parseContentBreadcrumbPayload 对齐）
// ---------------------------------------------------------------------------

export const CONTENT_ROUTE_KINDS = ["chat", "settings", "browser", "other"] as const;
export const CONTENT_TRANSCRIPT_MSGS_BUCKETS = [
  "zero",
  "small",
  "medium",
  "large",
  "huge",
] as const;
export const CONTENT_COMPOSER_BLOCKS_BUCKETS = ["zero", "few", "many"] as const;
export const CONTENT_ROWS_HELD_BUCKETS = ["zero", "small", "medium", "large"] as const;

export type ContentRouteKind = (typeof CONTENT_ROUTE_KINDS)[number];
export type ContentTranscriptMsgsBucket = (typeof CONTENT_TRANSCRIPT_MSGS_BUCKETS)[number];
export type ContentComposerBlocksBucket = (typeof CONTENT_COMPOSER_BLOCKS_BUCKETS)[number];
export type ContentRowsHeldBucket = (typeof CONTENT_ROWS_HELD_BUCKETS)[number];

export interface ContentBreadcrumbWirePayload {
  route_kind: ContentRouteKind;
  transcript_msgs_bucket: ContentTranscriptMsgsBucket;
  composer_blocks_bucket: ContentComposerBlocksBucket;
  rows_held_bucket: ContentRowsHeldBucket;
}

/** 采样面：由挂载点（app-shell）从 tab/session store 折算，非有限数按 0 处理。 */
export interface ContentStateSample {
  /** 当前顶层界面形态；非闭集成员归一为 other。 */
  routeKind: string;
  /** 当前会话 transcript 消息数。 */
  transcriptMessageCount: number;
  /** composer 内容块数。 */
  composerBlockCount: number;
  /** 虚拟列表当前持有的行数。 */
  rowsHeldCount: number;
}

// ---------------------------------------------------------------------------
// 分桶纯函数（阈值 = spec R11）
// ---------------------------------------------------------------------------

export function normalizeContentRouteKind(value: unknown): ContentRouteKind {
  return typeof value === "string" && (CONTENT_ROUTE_KINDS as readonly string[]).includes(value)
    ? (value as ContentRouteKind)
    : "other";
}

function toCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function bucketTranscriptMessageCount(count: number): ContentTranscriptMsgsBucket {
  const n = toCount(count);
  if (n === 0) return "zero";
  if (n <= 10) return "small";
  if (n <= 50) return "medium";
  if (n <= 200) return "large";
  return "huge";
}

export function bucketComposerBlockCount(count: number): ContentComposerBlocksBucket {
  const n = toCount(count);
  if (n === 0) return "zero";
  if (n <= 3) return "few";
  return "many";
}

export function bucketRowsHeldCount(count: number): ContentRowsHeldBucket {
  const n = toCount(count);
  if (n === 0) return "zero";
  if (n <= 50) return "small";
  if (n <= 500) return "medium";
  return "large";
}

export function buildContentBreadcrumbPayload(
  sample: ContentStateSample,
): ContentBreadcrumbWirePayload {
  return {
    route_kind: normalizeContentRouteKind(sample.routeKind),
    transcript_msgs_bucket: bucketTranscriptMessageCount(sample.transcriptMessageCount),
    composer_blocks_bucket: bucketComposerBlockCount(sample.composerBlockCount),
    rows_held_bucket: bucketRowsHeldCount(sample.rowsHeldCount),
  };
}

export function areContentBreadcrumbPayloadsEqual(
  a: ContentBreadcrumbWirePayload,
  b: ContentBreadcrumbWirePayload,
): boolean {
  return (
    a.route_kind === b.route_kind &&
    a.transcript_msgs_bucket === b.transcript_msgs_bucket &&
    a.composer_blocks_bucket === b.composer_blocks_bucket &&
    a.rows_held_bucket === b.rows_held_bucket
  );
}

// ---------------------------------------------------------------------------
// 周期上报器（纯逻辑核心；React 生命周期见 hooks/useContentStateBreadcrumb.ts）
// ---------------------------------------------------------------------------

export const CONTENT_BREADCRUMB_DEFAULT_INTERVAL_MS = 5_000;

export interface ContentStateBreadcrumbReporter {
  /** 启动周期上报（立即先发一条，main 无需等首个 tick）；幂等。 */
  start(): void;
  /** 停止周期上报；幂等。 */
  stop(): void;
  /** 手动补发一条当前快照（如页面隐藏前）；不改变周期。 */
  reportOnce(): void;
}

export interface CreateContentStateBreadcrumbReporterOptions {
  sample: () => ContentStateSample;
  send: (payload: ContentBreadcrumbWirePayload) => void;
  intervalMs?: number;
  /** 定时器注入（默认真实 setInterval/clearInterval）；单测用假定时器。 */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * 每个 tick 都重发（即使桶没变）：main 侧 content_stamp_age_ms 只反映「上报器
 * 停摆」而非「内容没变」——renderer 卡死时 age 拉大即是佐证（spec R11）。
 * send/sample 抛错一律吞掉：诊断设施 fail-open，不得反杀 UI。
 */
export function createContentStateBreadcrumbReporter(
  options: CreateContentStateBreadcrumbReporterOptions,
): ContentStateBreadcrumbReporter {
  const intervalMs = options.intervalMs ?? CONTENT_BREADCRUMB_DEFAULT_INTERVAL_MS;
  const setTimer = options.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearTimer = options.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
  let timerHandle: unknown = null;

  const reportOnce = (): void => {
    try {
      options.send(buildContentBreadcrumbPayload(options.sample()));
    } catch {
      // 采样/发送失败静默跳过本 tick（下个 tick 自然重试）。
    }
  };

  return {
    start() {
      if (timerHandle !== null) return;
      reportOnce();
      timerHandle = setTimer(reportOnce, intervalMs);
    },
    stop() {
      if (timerHandle === null) return;
      clearTimer(timerHandle);
      timerHandle = null;
    },
    reportOnce,
  };
}

// ---------------------------------------------------------------------------
// print() 假死守卫的 renderer 侧助手（spec R12）
// ---------------------------------------------------------------------------

/**
 * 包裹一次 window.print() 调用：执行前/后经 `report` 上报 printing=true/false。
 * main 侧按 senderFrame 校验 + 记账；unresponsive 且 print 进行中且窗口未聚焦
 * ⇒ 归因 print_call 不判卡顿。report 抛错吞掉（诊断不得让打印本身失败），
 * finally 保证结束上报必发（否则 main 只能等 10min 信任上限自愈）。
 */
export function runWithPrintCallReporting<T>(
  report: (printing: boolean) => void,
  action: () => T,
): T {
  const safeReport = (printing: boolean): void => {
    try {
      report(printing);
    } catch {
      // 上报通道故障不影响用户动作。
    }
  };
  safeReport(true);
  try {
    return action();
  } finally {
    safeReport(false);
  }
}
