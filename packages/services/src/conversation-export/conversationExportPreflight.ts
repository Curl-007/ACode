import type { ConversationRow } from "@acode/shared/acode-protocol-v4";

import { findRunningRowReason, filterRowsBySelection } from "./conversationExportIr.js";
import type {
  ConversationExportBlockingReason,
  ConversationExportPreflightResult,
  ConversationExportSelection,
} from "./conversationExport.js";

/**
 * 导出预检：进入导出流程前的纯判定（不产生文件、不写盘）。
 *
 * 与分享的预检不同，导出只需要三条阻塞项：会话仍在运行 / 会话为空 / 没有选中任何轮次。
 * 附件可读性、artifact 类型白名单等分享侧约束与「本地单文件导出」无关，不在此重复。
 */
export function buildConversationExportPreflight(input: {
  rows: readonly ConversationRow[];
  selection: ConversationExportSelection;
  logEpoch: string;
  revision: number;
}): ConversationExportPreflightResult {
  const blockingReasons: ConversationExportBlockingReason[] = [];

  if (input.selection.kind === "productTurns" && input.selection.productTurnIds.length === 0) {
    blockingReasons.push("no_selection");
  }

  // 会话仍在运行：导出会得到半截内容，且与分享同一口径拒绝。
  if (findRunningRowReason(input.rows)) {
    blockingReasons.push("running");
  }

  const selected = filterRowsBySelection(input.rows, input.selection);
  if (selected.length === 0) {
    blockingReasons.push("empty");
  }

  return {
    blockingReasons,
    atLogEpoch: input.logEpoch,
    atRevision: input.revision,
  };
}
