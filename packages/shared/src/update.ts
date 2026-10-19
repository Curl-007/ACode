import type { ElectronReleaseChannel, Locale } from "./protocol.js";

export interface PostUpdateReleaseNotesPayload {
  version: string;
  title: string;
  markdown: string;
  releaseDate?: string;
  releaseNotesByLocale?: Partial<Record<Locale, { title: string; markdown: string }>>;
}

/**
 * 用户从菜单手动点击"检查更新"后，main 进程回传给 renderer 的结果。
 * Renderer 根据 kind 展示对应的 toast；不要与启动时的自动 check 混用。
 */
export type UpdateCheckResultPayload =
  | { kind: "up-to-date"; currentVersion: string }
  | {
      kind: "available";
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | { kind: "downloading"; version: string }
  | { kind: "already-downloading"; version: string; progress: string }
  | { kind: "ready"; version: string }
  | { kind: "dev-skipped" }
  | { kind: "error"; message: string };

/**
 * 桌面自动更新器的持续状态，用于同步原生菜单和 Windows 自绘标题栏菜单。
 */
export type UpdateStatePayload =
  | { kind: "idle"; enabled: boolean }
  | { kind: "checking"; enabled: boolean }
  | {
      kind: "update-available";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "download-progress";
      enabled: boolean;
      progress: string;
      transferredBytes?: number;
      totalBytes?: number;
      version?: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      kind: "update-downloaded";
      enabled: boolean;
      version: string;
      channel?: ElectronReleaseChannel;
      releaseNotes?: PostUpdateReleaseNotesPayload;
    }
  | {
      /**
       * 更新恢复诊断通知（desktop/specs/update-recovery-notice.md）：启动核对
       * （updater-journal-recovery.md R3）发现上次交接未生效/验证失败/陈旧包
       * 清理时的用户可见解释面。retryAvailable=true 时接替 update-downloaded
       * 的菜单态语义（重启按钮同源），其余形态为纯通知。
       */
      kind: "install-recovery";
      enabled: boolean;
      outcome: "verification-failed" | "install-not-effective" | "stale-pending-cleared";
      fingerprint?: "version-unchanged" | "version-diverged";
      fromVersion: string;
      toVersion: string;
      retryAvailable: boolean;
      /** retryAvailable 时接替 update-downloaded 的发布说明展示（re-stage 同源）。 */
      releaseNotes?: PostUpdateReleaseNotesPayload;
      /** R19 豁免链标记（pending=死在豁免链之前的事故窗口，诊断用）。 */
      exitSweepHandoff?: "pending" | "completed" | "failed" | "absent" | "unknown";
    };
