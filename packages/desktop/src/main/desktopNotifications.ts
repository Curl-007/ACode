import { app, BrowserWindow, Notification } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TaskNotificationPayload } from "@acode/shared";
import { formatZodError, PlatformChannels, taskNotificationPayloadSchema } from "@acode/shared";

const TASK_NOTIFICATION_DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_TASK_NOTIFICATIONS = 100;
const recentTaskNotificationTimestamps = new Map<string, number>();
const activeTaskNotifications = new Set<Notification>();

function isAnyAppWindowFocused() {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function shouldSuppressDuplicateTaskNotification(
  taskId: string,
  status: TaskNotificationPayload["status"],
  requestId?: string,
) {
  const now = Date.now();

  for (const [key, timestamp] of recentTaskNotificationTimestamps) {
    if (now - timestamp > TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentTaskNotificationTimestamps.delete(key);
    }
  }

  // elicitation_request 和 permission_request 一样代表一次具体的人机阻塞请求。
  // 如果仍按 taskId 去重，同一任务连续 AskUserQuestion/计划确认会在 3 秒内漏掉第二条通知。
  const dedupeTarget =
    status === "permission_request" || status === "elicitation_request"
      ? requestId?.trim() || taskId
      : taskId;
  const dedupeKey = `${status}:${dedupeTarget}`;
  const lastTimestamp = recentTaskNotificationTimestamps.get(dedupeKey);
  if (lastTimestamp != null && now - lastTimestamp < TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentTaskNotificationTimestamps.set(dedupeKey, now);
  return false;
}

function retainTaskNotification(notification: Notification) {
  activeTaskNotifications.add(notification);

  if (activeTaskNotifications.size <= MAX_ACTIVE_TASK_NOTIFICATIONS) {
    return;
  }

  const oldestNotification = activeTaskNotifications.values().next().value;
  if (oldestNotification) {
    activeTaskNotifications.delete(oldestNotification);
  }
}

function releaseTaskNotification(notification: Notification) {
  activeTaskNotifications.delete(notification);
}

function focusTaskNotificationWindow(senderWindow: BrowserWindow) {
  if (senderWindow.isMinimized()) {
    senderWindow.restore();
  }

  if (!senderWindow.isVisible()) {
    senderWindow.show();
  }

  // macOS 点通知时如果窗口曾被隐藏/最小化，必须先恢复窗口，再激活 app，
  // 最后聚焦 BrowserWindow；否则 app.focus 抢到前台时没有可显示窗口，后续 focus 可能被系统忽略。
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }

  senderWindow.focus();
}

/**
 * 呈现结果：区分「已弹出」与各种「未弹出原因」，让上层按原因决定幂等语义。
 * overnight 完成通知据此把「平台不支持」与「焦点抑制/去重/缺文案」区别对待
 * （前者不消费 runId 幂等槽，允许平台恢复后重试；后者视为已处置，不再重发）。
 */
export type TaskNotificationPresentOutcome =
  | "presented"
  | "unsupported"
  | "window_focused"
  | "missing_copy"
  | "duplicate";

/**
 * 任务通知的共享呈现核：能力闸 → 焦点闸 → 文案守卫 → 去重 → 弹出 + retain + 点击路由 + 声音。
 * IPC 路径（dispatchTaskNotification）与 Main 侧 seam（overnightCompletionNotify）共用此核，
 * 避免复制焦点/去重/防 GC/点击路由这些原语而产生第二条写入路径（AGENTS.md「避免重复状态」）。
 * 文案纪律不变：Main 无 renderer i18n 上下文，缺失本地化文案直接拒绝展示，不兜底硬编码。
 */
export function presentTaskNotification(options: {
  senderWindow: BrowserWindow | null;
  payload: TaskNotificationPayload;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): TaskNotificationPresentOutcome {
  const { senderWindow, logger } = options;

  if (!Notification.isSupported()) {
    logger.warn("[show-task-notification] notification is not supported on this platform");
    return "unsupported";
  }

  if (isAnyAppWindowFocused()) {
    return "window_focused";
  }

  const { taskId, status, requestId, title, body } = options.payload;
  const notificationTitle = title.trim();
  const notificationBody = body.trim();
  if (!notificationTitle || !notificationBody) {
    // main process 没有 renderer 当前语言上下文，不能在这里兜底生成中文通知文案。
    // 通知文案必须由调用方按 locale 生成后传入；缺失时直接拒绝展示，避免英文界面弹出中文硬编码。
    logger.warn("[show-task-notification] missing localized notification copy", {
      taskId,
      status,
      hasTitle: Boolean(notificationTitle),
      hasBody: Boolean(notificationBody),
    });
    return "missing_copy";
  }

  if (shouldSuppressDuplicateTaskNotification(taskId, status, requestId)) {
    return "duplicate";
  }

  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    silent: true,
  });

  // Electron 原生 Notification 如果只存在于函数局部变量里，系统通知仍能显示，
  // 但主进程 JS 对象可能在用户点击前被回收，导致 click listener 丢失。
  // 这里显式持有对象，等点击/关闭后释放，保证“有通知”与“点击可唤起”属于同一生命周期。
  retainTaskNotification(notification);

  notification.once("click", () => {
    releaseTaskNotification(notification);

    if (!senderWindow || senderWindow.isDestroyed()) {
      logger.warn("[show-task-notification] click ignored: sender window is gone", {
        taskId,
      });
      return;
    }

    focusTaskNotificationWindow(senderWindow);
    senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId);
    logger.info("[show-task-notification] notification click handled", {
      taskId,
      windowId: senderWindow.id,
    });
  });
  notification.once("close", () => {
    releaseTaskNotification(notification);
  });

  notification.show();
  senderWindow?.webContents.send(PlatformChannels.TaskNotificationSound);
  return "presented";
}

export function dispatchTaskNotification(options: {
  event: IpcMainEvent | IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): boolean {
  const result = taskNotificationPayloadSchema.safeParse(options.payload);
  if (!result.success) {
    options.logger.warn("[show-task-notification] invalid payload:", formatZodError(result.error));
    return false;
  }

  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  return (
    presentTaskNotification({ senderWindow, payload: result.data, logger: options.logger }) ===
    "presented"
  );
}
