// 原生 handler 注册表（每组加一行 spread）。
// 组文件命名 = 命令分组：session-flow / queue / session-mgmt /
// goal-compact / model-config / interaction-background / fork-edit-retry /
// usage-query / auto-resume。
import { autoResumeHandlers } from "./auto-resume.js";
import { forkEditRetryHandlers } from "./fork-edit-retry.js";
import { fileRewindHandlers } from "./file-rewind.js";
import { goalCompactHandlers } from "./goal-compact.js";
import { interactionBackgroundHandlers } from "./interaction-background.js";
import { modelConfigHandlers } from "./model-config.js";
import { queueHandlers } from "./queue.js";
import { scriptWorkflowManagementHandlers } from "./script-workflow-management.js";
import { sessionFlowHandlers } from "./session-flow.js";
import { sessionMgmtHandlers } from "./session-mgmt.js";
import { selectionSideSessionHandlers } from "./selection-side-session.js";
import { assistantFeedbackHandlers } from "./assistant-feedback.js";
import { usageQueryHandlers } from "./usage-query.js";

export const NATIVE_HANDLERS = {
  ...sessionFlowHandlers,
  ...queueHandlers,
  ...sessionMgmtHandlers,
  ...selectionSideSessionHandlers,
  ...goalCompactHandlers,
  ...modelConfigHandlers,
  ...interactionBackgroundHandlers,
  ...forkEditRetryHandlers,
  ...fileRewindHandlers,
  ...scriptWorkflowManagementHandlers,
  ...assistantFeedbackHandlers,
  ...usageQueryHandlers,
  ...autoResumeHandlers,
} as const;
