// 机制参照 jcode (MIT)：crates/jcode-app-core/src/overnight.rs（coordinator 创建：fork 父会话
// 全部 messages/compaction/provider 设置、关自动评审、复制 todos），自撰 TypeScript 实现
// （apps/acode-cli/specs/overnight-execution.md §K3 R1「经 sourceTaskId fork 隐藏任务」）。
//
// 本文件是 coordinator fork 的**接缝层**：定义任务服务面端口（OvernightCoordinatorPort）与
// 父任务投影（fork create 参数的断言面）。CLI agent 进程内的真实绑定在 bootstrap 装配处
// （create-app），走既有 session fork 链（runtime.forkWorkspaceFromCheckpoint 的 message 目标
// 形态——「历史包含目标回合、不回退之后 checkpoint」正对「fork 全部父 messages 于当下」）；
// 单测以 mock 任务服务断言 create 参数携带父 messages 投影与 provider 配置（验收场景 7）。
import type {
  MessageInfo,
  MessageWithParts,
  ModelSelection,
  SessionInfo,
} from "@acode/contracts";
import { forkSourceMessagesForSession } from "../runtime/methods/session-fork.js";
import type { OvernightTurnResult } from "./supervisor.js";

/**
 * 父任务 messages 的 fork 投影：只携带身份与预览（id/role/时间/截断文本），
 * 不复制完整内容——fork 复制走会话存储的事务链，投影只服务于 create 参数断言与
 * 可观测面（「coordinator 继承了哪些消息」在 runtime-task / 日志里可查）。
 */
export interface OvernightParentMessageProjection {
  messageId: string;
  role: MessageInfo["role"];
  createdAtMs: number;
  textPreview: string;
}

/** fork 请求（create 参数面；场景 7 的断言对象）。 */
export interface OvernightCoordinatorForkRequest {
  runId: string;
  parentTaskId: string;
  title: string;
  /** 隐藏 coordinator：不占用户会话输入通道，可见面只有 runtime-task 投影（R1）。 */
  hidden: true;
  /** fork 后第一轮输入（buildInitialCoordinatorPrompt 的产物，含 preflight 注入）。 */
  initialPrompt: string;
  /** 继承的父任务 messages 投影（fork 语义断言面）。 */
  inheritedMessages: OvernightParentMessageProjection[];
  /** 继承的 provider 配置（父会话当前模型选择；未绑定时为 undefined）。 */
  inheritedModelSelection: ModelSelection | undefined;
  /**
   * fork 落点（父会话 active 分支的最后一条消息）。真实实现把它交给
   * runtime.forkWorkspaceFromCheckpoint({ targetMessageId })；投影里它是
   * inheritedMessages 末条 messageId，单列出来让 create 参数自洽可断言。
   */
  targetMessageId: string;
}

/** fork 出的 coordinator 任务租约：run 的 turn 驱动面。 */
export interface OvernightCoordinatorLease {
  taskId: string;
  /** 以追加指令 prompt 驱动一轮 coordinator turn（supervisor 的 runCoordinatorTurn 绑定点）。 */
  runCoordinatorTurn(prompt: string): Promise<OvernightTurnResult>;
}

/**
 * coordinator 任务服务端口。真实绑定 = 本地会话存储 fork 链（CLI agent 进程内无
 * packages/services 的远端任务服务——那是 desktop/server 侧形态；agent 侧的
 * 「sourceTaskId fork」等价物是 sessionStore 的 parentID+copy 链）。
 */
export interface OvernightCoordinatorPort {
  forkCoordinatorTask(request: OvernightCoordinatorForkRequest): Promise<OvernightCoordinatorLease>;
}

const PROJECTION_PREVIEW_MAX_CHARS = 120;

function textPreviewOf(message: MessageWithParts): string {
  const text = message.parts
    .filter((part): part is Extract<MessageWithParts["parts"][number], { type: "text" }> => {
      const candidate = part as { type?: string; text?: unknown };
      return candidate?.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length > PROJECTION_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, PROJECTION_PREVIEW_MAX_CHARS)}…`
    : normalized;
}

/**
 * 把父会话 messages 投影为 fork create 参数。复用 session-fork 的 active 分支选择器
 * （rewind/edit 后的旧分支不进投影）——不在此手写第二份分支语义。
 * 返回 null 表示父会话没有可 fork 的 active 消息（空会话），调用方应给出可读错误。
 */
export function projectOvernightParentMessages(
  parentMessages: MessageWithParts[],
  parentSession: SessionInfo,
): { inheritedMessages: OvernightParentMessageProjection[]; targetMessageId: string } | null {
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  if (activeMessages.length === 0) return null;
  const inheritedMessages = activeMessages.map((message) => ({
    messageId: String(message.info.id),
    role: message.info.role,
    createdAtMs: new Date(message.info.time.created).getTime(),
    textPreview: textPreviewOf(message),
  }));
  return {
    inheritedMessages,
    targetMessageId: String(activeMessages[activeMessages.length - 1]!.info.id),
  };
}
