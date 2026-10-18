import type {
  ElectronReleaseChannel,
  PostUpdateReleaseNotesPayload,
  UpdateStatePayload,
} from "@acode/shared";

export type UpdateStatusDialogPhase = "before-download" | "downloading" | "downloaded";

export type UpdateActionInFlight = "download" | "cancel" | "skip" | "restart" | null;

/**
 * 更新恢复诊断通知（desktop/specs/update-recovery-notice.md）：journal 启动核对
 * 发现上次交接未生效/验证失败/陈旧包清理时的用户可见解释面。
 */
export type UpdateRecoveryNotice = {
  outcome: "verification-failed" | "install-not-effective" | "stale-pending-cleared";
  fingerprint?: "version-unchanged" | "version-diverged";
  fromVersion: string;
  toVersion: string;
  retryAvailable: boolean;
  exitSweepHandoff?: "pending" | "completed" | "failed" | "absent" | "unknown";
};

export type UpdateStatusViewModel = {
  dialogPhase: UpdateStatusDialogPhase;
  displayVersion: string | null;
  progressLabel: string | null;
  progressValue: number;
  releaseNotesPayload: PostUpdateReleaseNotesPayload | undefined;
  recoveryNotice: UpdateRecoveryNotice | null;
  skippableVersion: string | null;
  updateChannel: ElectronReleaseChannel | undefined;
};

export function deriveUpdateStatusViewModel({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}): UpdateStatusViewModel {
  const isDownloadingUpdate = updateState?.kind === "download-progress";
  const recovery = updateState?.kind === "install-recovery" ? updateState : null;
  const readyVersion = resolveReadyVersion({ legacyReadyVersion, updateState });
  const progressVersion = isDownloadingUpdate ? updateState.version : null;
  const availableVersion = updateState?.kind === "update-available" ? updateState.version : null;
  const displayVersion =
    readyVersion ??
    progressVersion ??
    availableVersion ??
    // 恢复通知（不可重试形态）也要可见：以 toVersion 撑起入口与弹窗
    // （update-recovery-notice.md R4），phase 落 before-download=重新下载语义。
    (recovery ? recovery.toVersion : null) ??
    // download-progress.version 是协议可选字段。下载态必须按 kind 保持 UI，
    // 否则某一帧缺少版本号会让入口卸载并关闭已打开弹窗。
    (isDownloadingUpdate ? "…" : null);

  return {
    dialogPhase: readyVersion
      ? "downloaded"
      : isDownloadingUpdate
        ? "downloading"
        : "before-download",
    displayVersion,
    progressLabel: getUpdateDownloadProgressLabel(updateState),
    progressValue: getUpdateDownloadProgressValue(updateState),
    releaseNotesPayload: getUpdateReleaseNotesPayload(updateState),
    recoveryNotice: recovery
      ? {
          outcome: recovery.outcome,
          ...(recovery.fingerprint ? { fingerprint: recovery.fingerprint } : {}),
          fromVersion: recovery.fromVersion,
          toVersion: recovery.toVersion,
          retryAvailable: recovery.retryAvailable,
          ...(recovery.exitSweepHandoff ? { exitSweepHandoff: recovery.exitSweepHandoff } : {}),
        }
      : null,
    skippableVersion:
      updateState?.kind === "update-available" || updateState?.kind === "download-progress"
        ? (updateState.version ?? null)
        : null,
    updateChannel:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded"
        ? updateState.channel
        : undefined,
  };
}

export function isUpdateActionCompleted(
  action: UpdateActionInFlight,
  updateState: UpdateStatePayload | null,
) {
  return (
    // 点击下载后 main 侧可能先广播 checking/idle 等过渡态。
    // 这些状态不代表下载已经进入可观察阶段，不能释放按钮锁并触发弹窗卸载；
    // 只有真正进入下载进度或下载完成，才算下载命令完成。
    (action === "download" &&
      (updateState?.kind === "download-progress" || updateState?.kind === "update-downloaded")) ||
    (action === "cancel" && updateState?.kind !== "download-progress") ||
    (action === "skip" &&
      updateState?.kind !== "update-available" &&
      updateState?.kind !== "download-progress")
  );
}

function getUpdateDownloadProgressLabel(updateState: UpdateStatePayload | null) {
  if (updateState?.kind !== "download-progress") {
    return null;
  }

  const { totalBytes, transferredBytes } = updateState;
  if (
    typeof transferredBytes === "number" &&
    Number.isFinite(transferredBytes) &&
    transferredBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return `${formatMegabytes(transferredBytes)} / ${formatMegabytes(totalBytes)}`;
  }

  // 下载进度文案已经改为展示已下载/总大小。只有百分比时继续显示
  // “0% / 42%” 会和新的大小口径冲突，且启动下载的临时态会残留一个 0%。
  return null;
}

function resolveReadyVersion({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}) {
  if (updateState?.kind === "update-downloaded") {
    return updateState.version;
  }

  // install-recovery+retryAvailable 与 update-downloaded 同级（update-recovery-
  // notice.md R2/R4）：ready 语义由 journal 恢复保住，重启链路同源。
  if (updateState?.kind === "install-recovery" && updateState.retryAvailable) {
    return updateState.toVersion;
  }

  // legacy UpdateReady 只是一份“曾经 ready”的缓存。
  // 一旦新的 UpdateState 已明确同步到 renderer，idle/checking/error 都应以新状态为准，
  // 不能继续用旧 version 撑出“重启以更新”按钮。
  return updateState === null ? legacyReadyVersion : null;
}

function getUpdateDownloadProgressValue(updateState: UpdateStatePayload | null) {
  const rawProgressValue =
    updateState?.kind === "download-progress" ? Number(updateState.progress) : 0;
  return Number.isFinite(rawProgressValue) ? Math.max(0, Math.min(100, rawProgressValue)) : 0;
}

function getUpdateReleaseNotesPayload(updateState: UpdateStatePayload | null) {
  return updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded"
    ? updateState.releaseNotes
    : undefined;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
