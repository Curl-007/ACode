import type { IACodeAgentService } from "../acode-agent/acodeAgent.js";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import {
  readAllConversationRows,
  readConversationRowsPage,
  type ConversationRowsReaderAgentService,
} from "../conversation-share/conversationRowsReader.js";
import { ConversationShareServiceError } from "../conversation-share/conversationShare.js";
import { buildExportChunk } from "./conversationExportIr.js";
import { buildConversationExportPreflight } from "./conversationExportPreflight.js";
import type {
  ConversationExportChunkInput,
  ConversationExportChunkResult,
  ConversationExportPreflightInput,
  ConversationExportPreflightResult,
  IConversationExportService,
} from "./conversationExport.js";
import { conversationExportConnectionScopeFactory } from "./conversationExport.js";

/**
 * 导出服务：只读会话 rows 并转成导出 IR 分片。
 *
 * 状态所有者：会话 rows 归 CLI/Agent（这里只读）；本服务不持有任何缓存或进度状态
 * （进度在 Renderer 的局部状态里）。分页/水位/有序校验复用 conversationRowsReader，
 * 与分享发布走同一条规则，不复制第二套。
 *
 * 连接可信性：`conversationRowsRangeV4` 要求请求携带 host 注入的 trusted connection
 * carrier，Renderer 不能自己伪造。因此本服务与 ConversationShareService 一样，
 * 需要由 Host attachment 用 `conversationExportConnectionScopeFactory` 重新绑定到
 * 当前 attachment 的 agentService 上，见 conversationExportConnectionScopeFactory。
 */
export interface ConversationExportServiceOptions {
  acodeAgentService: Pick<IACodeAgentService, "conversationRowsRangeV4">;
  logger?: ServiceLogger;
}

/** 与分享一致：连接未就绪时把底层 fault 归一成可识别的 connection_unavailable。 */
const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

function normalizeConversationExportConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation export connection is not ready",
    );
  }
  return error;
}

export class ConversationExportService implements IConversationExportService {
  private readonly acodeAgentService: ConversationRowsReaderAgentService;
  private readonly logger: ServiceLogger;

  constructor(options: ConversationExportServiceOptions) {
    this.acodeAgentService = options.acodeAgentService;
    this.logger = options.logger ?? createServiceLogger("conversation-export");
  }

  async preflight(
    input: ConversationExportPreflightInput,
  ): Promise<ConversationExportPreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.acodeAgentService);
    } catch (error) {
      throw normalizeConversationExportConnectionError(error);
    }
  }

  private async preflightWithAgent(
    input: ConversationExportPreflightInput,
    agentService: ConversationRowsReaderAgentService,
  ): Promise<ConversationExportPreflightResult> {
    // 预检需要看到全部行才能判定「会话仍在运行」（运行态在尾部）。
    const read = await readAllConversationRows(agentService, {
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
      sessionId: input.sessionId,
    });
    const result = buildConversationExportPreflight({
      rows: read.rows,
      selection: input.selection,
      logEpoch: read.logEpoch,
      revision: read.revision,
    });
    if (result.blockingReasons.length > 0) {
      // 用户可预期的拒绝，不是异常。
      this.logger.info(undefined, "conversation export preflight rejected", {
        sessionId: input.sessionId,
        reasons: result.blockingReasons.join(","),
      });
    }
    return result;
  }

  async readChunk(input: ConversationExportChunkInput): Promise<ConversationExportChunkResult> {
    try {
      return await this.readChunkWithAgent(input, this.acodeAgentService);
    } catch (error) {
      const normalized = normalizeConversationExportConnectionError(error);
      this.logger.warn(undefined, "read conversation rows for export failed", {
        sessionId: input.sessionId,
        beforeRowId: input.beforeRowId,
        error: normalized instanceof Error ? normalized.message : String(normalized),
      });
      throw normalized;
    }
  }

  private async readChunkWithAgent(
    input: ConversationExportChunkInput,
    agentService: ConversationRowsReaderAgentService,
  ): Promise<ConversationExportChunkResult> {
    const page = await readConversationRowsPage(agentService, {
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
      sessionId: input.sessionId,
      ...(input.beforeRowId === undefined ? {} : { beforeRowId: input.beforeRowId }),
      ...(input.expectedWatermark ? { expectedWatermark: input.expectedWatermark } : {}),
    });
    const chunk = buildExportChunk(page.rows, input.selection);
    return {
      chunk,
      hasMore: page.hasMore,
      ...(page.nextBeforeRowId === undefined ? {} : { nextBeforeRowId: page.nextBeforeRowId }),
      atLogEpoch: page.logEpoch,
      atRevision: page.revision,
      skippedRowCount: chunk.skippedRowCount,
    };
  }

  /**
   * 把本实例重新绑定到某个 attachment 的 agentService 上。
   * Host attachment 必须用当前 MessagePort 已握手的 connection scope，否则 rowsRange 会以
   * connection untrusted 拒绝（与 ConversationShareService 的 scope factory 同一原因）。
   */
  [conversationExportConnectionScopeFactory](
    agentService: ConversationRowsReaderAgentService,
  ): IConversationExportService {
    return {
      preflight: (input) =>
        guardConnectionError(() => this.preflightWithAgent(input, agentService)),
      readChunk: (input) =>
        guardConnectionError(() => this.readChunkWithAgent(input, agentService)),
    };
  }
}

function guardConnectionError<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    throw normalizeConversationExportConnectionError(error);
  });
}
