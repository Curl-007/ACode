// unresponsive 聚合报告（specs/main-stall-diagnostics.md R12）：webContents
// `unresponsive` 事件 → 一条聚合结构化日志（surface 分类 + main RSS + 窗口可见性 +
// presence 快照 + 最近 stall 归因（含 worst-offender label）+ 内容桶 + print_call）。
//
// 边界纪律：只记日志——不外发遥测（no-telemetry），不自动 kill/reload（杀 renderer
// 是产品行为，本波诊断-only）；print 守卫命中只改归因与日志级别（info/warn 分流）。
// 纯 Node 依赖注入，不 import electron，node:test 可直接驱动。
import type { ContentBreadcrumbRegistry } from "./contentBreadcrumb.js";
import type { PrintCallAttribution, PrintCallGuard } from "./printCallGuard.js";
import type { PresenceSnapshotPayload } from "./presenceSnapshot.js";
import type { MainStallCaptureStatus } from "./stallSamplerProtocol.js";

/** 聚合日志的 `status` 闭集（延续 R6 的域前缀纪律，不与业务 status 值撞名）。 */
export const UNRESPONSIVE_LOG_STATUS = {
  stalled: "renderer_unresponsive",
  printCall: "renderer_unresponsive_print_call",
} as const;

/** 最近 stall 归因窗口：unresponsive 前 60s 内的 stall report 才随聚合带出。 */
export const RECENT_STALL_WINDOW_MS = 60_000;

/** surface 分类闭集：窗口类型 hint 由接线方提供，不认识一律 unknown（不猜测）。 */
export const UNRESPONSIVE_SURFACE_KINDS = [
  "app_main",
  "app_login",
  "update_status",
  "about",
  "cua_indicator",
  "embedded_browser",
  "unknown",
] as const;

export type UnresponsiveSurfaceKind = (typeof UNRESPONSIVE_SURFACE_KINDS)[number];

export interface UnresponsiveSurfaceHint {
  /** 接线方提供的窗口类型（main / update-status / about / cua-indicator / embedded-browser）。 */
  windowKind?: string | null;
  /** 当前文档 URL；仅用于 main 窗的 login 细分。 */
  url?: string | null;
}

function isLoginUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    return new URL(url).pathname.endsWith("/login.html");
  } catch {
    return false;
  }
}

/** hint → surface 闭集（spec R12）；缺 hint / 不认识 ⇒ unknown 兜底。 */
export function classifyUnresponsiveSurface(
  hint: UnresponsiveSurfaceHint | null | undefined,
): UnresponsiveSurfaceKind {
  switch (hint?.windowKind) {
    case "main":
      return isLoginUrl(hint?.url) ? "app_login" : "app_main";
    case "update-status":
      return "update_status";
    case "about":
      return "about";
    case "cua-indicator":
      return "cua_indicator";
    case "embedded-browser":
      return "embedded_browser";
    default:
      return "unknown";
  }
}

/** stallSampler handle 保留的最近归因（R13 getLastStallAttribution 的形状）。 */
export interface LastStallAttribution {
  stallMs: number;
  sleepSuspected: boolean;
  captureStatus: MainStallCaptureStatus;
  /** 该次 stall report 消费到的同步 IPC worst-offender（已清零前的最后一眼）。 */
  ipcSyncWorst: { label: string; syncMs: number } | null;
  /** 接收墙钟时刻（Date.now 系）。 */
  receivedAtMs: number;
}

export interface UnresponsiveWindowFacts {
  visible: boolean | null;
  minimized: boolean | null;
  focused: boolean | null;
}

export interface UnresponsiveContext {
  webContentsId: number;
  surfaceHint?: UnresponsiveSurfaceHint | null;
  /** 窗口可见性事实（接线从 BrowserWindow 折算；取不到的项传 null）。 */
  window?: UnresponsiveWindowFacts | null;
}

/** 聚合日志 payload（snake_case 自洽 schema，spec R12）。 */
export interface UnresponsiveReportPayload {
  status: (typeof UNRESPONSIVE_LOG_STATUS)[keyof typeof UNRESPONSIVE_LOG_STATUS];
  surface: UnresponsiveSurfaceKind;
  main_rss_bytes: number | null;
  window_visible: boolean | null;
  window_minimized: boolean | null;
  window_focused: boolean | null;
  presence: PresenceSnapshotPayload | null;
  recent_main_stall: {
    stall_ms: number;
    sleep_suspected: boolean;
    capture_status: MainStallCaptureStatus;
    ago_ms: number;
    ipc_sync_worst_label: string | null;
    ipc_sync_worst_ms: number | null;
  } | null;
  content: ReturnType<ContentBreadcrumbRegistry["snapshotFor"]>;
  print_call: PrintCallAttribution;
  print_call_age_ms?: number;
}

export interface CreateUnresponsiveReporterOptions {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  /** 墙钟（默认 Date.now）；须与 stall 归因的 receivedAtMs 同系。 */
  now?: () => number;
  /** main 进程 RSS（默认 process.memoryUsage().rss）。 */
  getProcessRssBytes?: () => number;
  getPresenceSnapshot?: (() => PresenceSnapshotPayload | null) | null;
  contentBreadcrumbs?: Pick<ContentBreadcrumbRegistry, "snapshotFor"> | null;
  getLastStallAttribution?: (() => LastStallAttribution | null) | null;
  printCallGuard?: Pick<PrintCallGuard, "evaluate"> | null;
  recentStallWindowMs?: number;
}

export interface UnresponsiveReporter {
  /** 一次 unresponsive → 恰一条聚合日志；返回 payload（测试断言用）。 */
  handleUnresponsive(context: UnresponsiveContext): UnresponsiveReportPayload;
}

export function createUnresponsiveReporter(
  options: CreateUnresponsiveReporterOptions,
): UnresponsiveReporter {
  const now = options.now ?? (() => Date.now());
  const recentStallWindowMs = options.recentStallWindowMs ?? RECENT_STALL_WINDOW_MS;

  const readRecentStall = (atMs: number): UnresponsiveReportPayload["recent_main_stall"] => {
    const attribution = options.getLastStallAttribution?.() ?? null;
    if (!attribution) return null;
    const agoMs = atMs - attribution.receivedAtMs;
    // 只认归因窗口内的最近一次；未来时刻（时钟回拨）同样不认。
    if (!(agoMs >= 0) || agoMs > recentStallWindowMs) return null;
    return {
      stall_ms: attribution.stallMs,
      sleep_suspected: attribution.sleepSuspected,
      capture_status: attribution.captureStatus,
      ago_ms: Math.round(agoMs),
      ipc_sync_worst_label: attribution.ipcSyncWorst?.label ?? null,
      ipc_sync_worst_ms: attribution.ipcSyncWorst?.syncMs ?? null,
    };
  };

  return {
    handleUnresponsive(context) {
      const atMs = now();
      const windowFacts = context.window ?? null;
      const printEvaluation = options.printCallGuard?.evaluate(context.webContentsId, {
        // 焦点事实缺失按「聚焦」处理：宁照常判卡顿，不误开守卫（fail-safe）。
        windowFocused: windowFacts?.focused !== false,
      }) ?? { skipStallVerdict: false, printCall: "none" as const, printCallAgeMs: null };

      let rssBytes: number | null = null;
      try {
        const rss = (options.getProcessRssBytes ?? (() => process.memoryUsage().rss))();
        rssBytes = Number.isFinite(rss) ? rss : null;
      } catch {
        rssBytes = null;
      }

      const payload: UnresponsiveReportPayload = {
        status: printEvaluation.skipStallVerdict
          ? UNRESPONSIVE_LOG_STATUS.printCall
          : UNRESPONSIVE_LOG_STATUS.stalled,
        surface: classifyUnresponsiveSurface(context.surfaceHint),
        main_rss_bytes: rssBytes,
        window_visible: windowFacts?.visible ?? null,
        window_minimized: windowFacts?.minimized ?? null,
        window_focused: windowFacts?.focused ?? null,
        presence: options.getPresenceSnapshot?.() ?? null,
        recent_main_stall: readRecentStall(atMs),
        content: options.contentBreadcrumbs?.snapshotFor(context.webContentsId, atMs) ?? null,
        print_call: printEvaluation.printCall,
        ...(printEvaluation.printCallAgeMs !== null
          ? { print_call_age_ms: printEvaluation.printCallAgeMs }
          : {}),
      };
      const write = printEvaluation.skipStallVerdict ? options.logger.info : options.logger.warn;
      write("[renderer-diag] renderer unresponsive", payload);
      return payload;
    },
  };
}
