// Overnight（K3）完成通知的 Main 侧出口 seam（specs/overnight-completion-notify.md）。
//
// 职责边界（严格）：本模块**只弹系统通知 + 路由点击**，不承载任何 overnight 业务状态——
// 权威事实在 CLI supervisor（apps/acode-cli/packages/core/src/overnight/supervisor.ts）。
// 它持有的唯一状态是「哪些 runId 已通知过」的有界幂等集，属转发去重态（非快照、不落盘），
// 与 desktopNotifications 的 recentTaskNotificationTimestamps、taskRealtimeBus 的 seenEventBuckets 同性质，
// 符合 specs/task-realtime-bus-mirror.md §1「Main 侧不得新增 task/session 快照落盘」。
//
// 复用而非新建：呈现/焦点闸/去重/防 GC/点击路由全部走 desktopNotifications.presentTaskNotification；
// 角标数值走既有 renderer 单写者路径（syncWindowUnreadCount），本模块**不新增任何计数器**。
//
// ⚠ 触发信号的生产者是跨包拟议项（spec §7）：overnight 完成事件当前止于 CLI 进程内日志，
// 尚无 host→Main 通道投递 OvernightCompletionSignal。本 seam 已建成并以注入信号完整测试，
// 但在 §7 协议/发射点/路由落地前无真实生产者——不得声称端到端已通。
import type { BrowserWindow } from "electron";
import type { Locale, TaskNotificationPayload } from "@acode/shared";
import {
  presentTaskNotification,
  type TaskNotificationPresentOutcome,
} from "./desktopNotifications.js";

/** 幂等集上限：超限按插入序淘汰最旧，防无界增长（类比 realtime bus 的 MAX_SEEN_EVENT_BUCKETS）。 */
const MAX_NOTIFIED_OVERNIGHT_RUNS = 256;

/** overnight run 的终态（对齐 supervisor 的 overnight.completed/failed + cancelled 标记）。 */
export type OvernightCompletionOutcome = "completed" | "failed" | "cancelled";

/**
 * 跨包 seam 投递的完成信号（spec §7 拟议协议载荷的 Main 侧消费形态）。
 * parentTaskId 是点击直达目标——coordinator 是隐藏 fork 子会话，live 期不在 taskListCache，
 * 路由到它会被 onTaskNotificationClick 判「task not found」；parentTaskId 是发起 /overnight 的可见会话。
 */
export interface OvernightCompletionSignal {
  runId: string;
  parentTaskId: string;
  outcome: OvernightCompletionOutcome;
  /** 晨报文件是否已确认存在（决定文案是「晨报就绪」还是「已结束」）。 */
  morningReportReady: boolean;
}

/** Main 侧本地化文案键（outcome × morningReportReady）。native 通知文案归 Main，与 desktopMenu 同族。 */
type OvernightNotifyMessageId = "completedReport" | "completedNoReport" | "failed" | "cancelled";

const OVERNIGHT_NOTIFY_MESSAGES: Record<
  Locale,
  Record<OvernightNotifyMessageId, { title: string; body: string }>
> = {
  "zh-CN": {
    completedReport: { title: "挂机任务已完成", body: "晨报已就绪，点击查看今日成果。" },
    completedNoReport: { title: "挂机任务已结束", body: "本次运行已结束，点击查看详情。" },
    failed: { title: "挂机任务失败", body: "运行遇到错误已停止，点击查看详情。" },
    cancelled: { title: "挂机任务已取消", body: "运行已按请求取消，点击查看详情。" },
  },
  "en-US": {
    completedReport: {
      title: "Overnight run finished",
      body: "Morning report is ready. Click to review.",
    },
    completedNoReport: {
      title: "Overnight run ended",
      body: "The run has ended. Click for details.",
    },
    failed: {
      title: "Overnight run failed",
      body: "The run stopped after an error. Click for details.",
    },
    cancelled: {
      title: "Overnight run cancelled",
      body: "The run was cancelled as requested. Click for details.",
    },
  },
};

function resolveMessageId(signal: OvernightCompletionSignal): OvernightNotifyMessageId {
  if (signal.outcome === "failed") return "failed";
  if (signal.outcome === "cancelled") return "cancelled";
  return signal.morningReportReady ? "completedReport" : "completedNoReport";
}

function outcomeToNotificationStatus(
  outcome: OvernightCompletionOutcome,
): TaskNotificationPayload["status"] {
  // 复用既有通知状态枚举：failed → "failed"；completed/cancelled → "completed"。
  // cancelled 是用户主动收尾的正常终态，按 completed 呈现（点击直达同一 parentTaskId）。
  return outcome === "failed" ? "failed" : "completed";
}

export interface OvernightCompletionNotifier {
  /**
   * 处理一条完成信号：runId 幂等 → 解析本地化文案 → 经共享呈现核弹通知 + 绑定点击路由。
   * @returns true 仅当本次真正弹出了通知（"presented"）。焦点抑制/去重/缺文案/平台不支持均返回 false。
   */
  notify(signal: OvernightCompletionSignal): boolean;
  /** 只读诊断：已通知的 runId 数（测试断言幂等与有界淘汰用）。 */
  notifiedRunCount(): number;
}

export function createOvernightCompletionNotifier(options: {
  /** 解析信号应弹到哪个窗口（跑该 host/workspace 的窗口）；缺席即无窗口可聚焦，仍可弹通知。 */
  resolveTargetWindow: (signal: OvernightCompletionSignal) => BrowserWindow | null;
  getLocale: () => Locale;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): OvernightCompletionNotifier {
  // 有界幂等集：一个 run 至多一条通知（比既有 3s 时间窗更强——overnight 完成是「每 run 一次」事件）。
  const notifiedRuns = new Set<string>();

  function rememberRun(runId: string): void {
    notifiedRuns.add(runId);
    while (notifiedRuns.size > MAX_NOTIFIED_OVERNIGHT_RUNS) {
      const oldest = notifiedRuns.values().next().value;
      if (oldest === undefined) break;
      notifiedRuns.delete(oldest);
    }
  }

  return {
    notify(signal): boolean {
      // runId 幂等闸：命中即静默返回，永不重发（host 重投/多窗口/跨 3s 窗都不得二次打扰）。
      if (notifiedRuns.has(signal.runId)) {
        return false;
      }

      const locale = options.getLocale();
      const messages = OVERNIGHT_NOTIFY_MESSAGES[locale] ?? OVERNIGHT_NOTIFY_MESSAGES["zh-CN"];
      const copy = messages[resolveMessageId(signal)];

      const outcome = presentTaskNotification({
        senderWindow: options.resolveTargetWindow(signal),
        payload: {
          taskId: signal.parentTaskId,
          status: outcomeToNotificationStatus(signal.outcome),
          title: copy.title,
          body: copy.body,
        },
        logger: options.logger,
      });

      // 「平台不支持」不消费幂等槽：这是环境降级而非「已处置」，平台恢复后应允许重试。
      // 其余非 presented（焦点/去重/缺文案）视为已处置——焦点时用户在 App 内自会看到任务卡，
      // 不应在下次投递时补弹；缺文案是配置缺陷，重投也不会变好。故除 unsupported 外均记 runId。
      if (outcome !== "unsupported") {
        rememberRun(signal.runId);
      }

      if (outcome === "presented") {
        options.logger.info("[overnight-notify] completion notification presented", {
          runId: signal.runId,
          outcome: signal.outcome,
          morningReportReady: signal.morningReportReady,
        });
        return true;
      }
      options.logger.info("[overnight-notify] completion notification suppressed", {
        runId: signal.runId,
        outcome: signal.outcome,
        reason: outcome satisfies TaskNotificationPresentOutcome,
      });
      return false;
    },
    notifiedRunCount: () => notifiedRuns.size,
  };
}
