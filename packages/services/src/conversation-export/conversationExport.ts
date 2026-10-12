import { ServiceChannels } from "@acode/shared";

import { createServiceDescriptor } from "../descriptors.js";

/**
 * 会话本地导出的服务层契约（rows → 导出中间表示 IR 分片）。
 *
 * 分工（见 PRD 3.1）：服务层只做「按页读 rows + 转 IR」，序列化与写盘在 Renderer。
 * 因此这里不 import @acode/ui（依赖方向），也不产生任何用户可见文案。
 */

/** 导出范围。与 ConversationShareSelection 刻意同形但不复用：导出不需要 rowAnchors 粒度。 */
export type ConversationExportSelection =
  | { kind: "all" }
  | { kind: "productTurns"; productTurnIds: string[] };

export type ConversationExportFormat = "markdown" | "html";

/** 导出预检的阻塞原因。用户可预期的拒绝，不是异常。 */
export type ConversationExportBlockingReason = "empty" | "running" | "no_selection";

export interface ConversationExportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

export interface ConversationExportPreflightInput extends ConversationExportTarget {
  selection: ConversationExportSelection;
}

export interface ConversationExportPreflightResult {
  /** 阻塞项；非空时不得进入导出流程。 */
  blockingReasons: readonly ConversationExportBlockingReason[];
  /** 读到的水位；导出首屏必须与之一致（服务层内部也校验）。 */
  atLogEpoch: string;
  atRevision: number;
}

export interface ConversationExportIrAttachment {
  fileName: string;
  sizeBytes: number;
}

/** IR 分片里的一行。序列化器按 kind 分派；服务层不生成文案。 */
export type ConversationExportIrRow =
  | {
      kind: "turnHeader";
      rowId: number;
      /** 取自 row.startedAt；禁止用 Date.now()，否则重跑导出不可复现。 */
      startedAt: number;
      /** 权威工时（turnHeader.activeMs），缺失时回落到 endedAt - startedAt。 */
      durationMs?: number;
    }
  | {
      kind: "userInput";
      rowId: number;
      text: string;
      attachments: ConversationExportIrAttachment[];
    }
  | { kind: "assistantText"; rowId: number; text: string }
  | { kind: "reasoning"; rowId: number; text: string; durationMs?: number }
  | {
      kind: "toolCall";
      rowId: number;
      toolCallId: string;
      toolName: string;
      status: string;
      /** 工具家族（@acode/shared 的 ACodeToolFamily）；无法识别时为 "unknown"。 */
      family: string;
      outputText: string;
      /** 输出被截断的字符数；未截断为 undefined。 */
      truncatedChars?: number;
    }
  | {
      kind: "artifact";
      rowId: number;
      displayName: string;
      artifactType: string;
      sizeBytes: number;
    }
  | { kind: "timelineMarker"; rowId: number; markerType: "compact" | "modelChange" };

export interface ConversationExportChunk {
  rows: ConversationExportIrRow[];
  /** 本片内被跳过的行数（内联工具图片等无法导出的内容）。 */
  skippedRowCount: number;
}

export interface ConversationExportChunkInput extends ConversationExportTarget {
  selection: ConversationExportSelection;
  /** 上一页返回的游标；首屏不传。 */
  beforeRowId?: number;
  /** 首屏水位；后续页必须与之一致，形成 Renderer 之外的第二道水位校验。 */
  expectedWatermark?: { logEpoch: string; revision: number };
}

export interface ConversationExportChunkResult {
  chunk: ConversationExportChunk;
  /** 是否还有更早的页。 */
  hasMore: boolean;
  /** 下一页的游标。 */
  nextBeforeRowId?: number;
  /** 本次读取的水位；后续页必须与之一致。 */
  atLogEpoch: string;
  atRevision: number;
  /** 被跳过的行数（内联工具图片等无法导出的内容）。 */
  skippedRowCount: number;
}

export interface IConversationExportService {
  preflight(input: ConversationExportPreflightInput): Promise<ConversationExportPreflightResult>;
  /** 读一页 rows 并转成导出 IR 分片；由 Renderer 循环调用。 */
  readChunk(input: ConversationExportChunkInput): Promise<ConversationExportChunkResult>;
}

export const IConversationExportService = createServiceDescriptor<IConversationExportService>(
  ServiceChannels.ConversationExport,
);

/**
 * 与 conversationShareConnectionScopeFactory 同形：Symbol method 不可由 string-command
 * ProxyChannel 调用，仅供 Host/Server attachment 装配时重绑 agentService。
 */
export const conversationExportConnectionScopeFactory = Symbol(
  "conversationExportConnectionScopeFactory",
);
