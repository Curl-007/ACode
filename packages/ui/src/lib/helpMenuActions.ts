import { ACODE_ISSUES_URL, type IPlatformService } from "@acode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";

interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      // 审计版：问题反馈直接指向本仓库 Issues，不再打开官方反馈弹窗。
      platform.openExternal(ACODE_ISSUES_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
