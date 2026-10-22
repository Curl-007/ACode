// SessionPane 命令编排的**纯决策逻辑**（god-component-split-plan.md 第二批）。
//
// 为什么只有纯函数、没有闭包：SessionPane 的命令组闭包族（dispatchCommand/snapshotRef/lease/
// pendingCommandRegistry + 20 多个 handler）整体保留在 SessionPane——把它们搬进模块需要引入一个
// 巨大的 context 对象或 state 副本，违反 AGENTS.md「避免重复状态和多条写入路径」，也打散豁免头注
// 自辩的「闭包纪律」。本文件只抽**可纯化的决策**：把「命令 → type/payload/baseRevision」「编辑 →
// payload/空守卫」「queue item → composer restore 目标」这类不依赖 React state/ref 的判断收敛成
// 纯函数，交给接缝内测试（test/sessionPaneCommandOrchestration.test.ts）覆盖，作为后续重构安全网。
//
// 迁移纪律：submissionConfigFromCommand / resolveQueuedComposerRestore /
// shouldRestoreQueuedComposerFromAck 从 SessionPane 逐字迁移；resolveSlashCommandDispatch /
// resolveEditUserQueryPayload 是把原 switch/guard 的决策部分抽出，日志与 dispatch 副作用仍留在
// SessionPane 闭包内，行为逐字不变（warn 文案在本文件单一构造，SessionPane 只负责 logger.warn 落地）。
import type {
  AttachmentRef,
  CommandAck,
  CommandType,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@acode/shared/acode-protocol-v4";
import type { ComposerSubmissionConfig } from "../composer/composerSubmissionConfig.js";
import type { ComposerRestoreRequest } from "../ConversationComposer.js";
import { v4QueuedCommandText, type V4VisibleSlashCommand } from "../slashCommands.js";

/** 从命令 payload 提取本次 Submission（模型选择/模式），用于 accepted 边界写回推荐选择。 */
export function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

/** 把 queue item 还原成 composer 草稿恢复目标（撤回编辑）；compact 项不可编辑返回 null。 */
export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

/** delete ACK 只在 accepted/duplicate 时恢复 composer 草稿；rejected/stale/failed 放弃本地恢复。 */
export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

/**
 * 行内编辑（editUserQuery）的 payload 决策。
 * - 空守卫：内容为空且无附件时跳过（原 handleEdit 的 warn + return false 分支）。
 * - attachments 缺省 = 保留 canonical 原附件；只有显式透传 [] 时 CLI 才能区分
 *   「用户删除全部」与「调用方未修改附件」——故这里严格保留 undefined vs [] 的差异。
 */
export type EditUserQueryPlan =
  | { skip: true }
  | { skip: false; payload: Record<string, unknown> };

export function resolveEditUserQueryPayload(params: {
  target: ConversationRowTarget;
  newText: string;
  attachments?: readonly AttachmentRef[];
  workspaceMode: "preserve" | "rewind";
}): EditUserQueryPlan {
  const { target, newText, attachments, workspaceMode } = params;
  if (!newText.trim() && (!attachments || attachments.length === 0)) {
    return { skip: true };
  }
  return {
    skip: false,
    payload: {
      target,
      newText,
      workspaceMode,
      ...(attachments ? { attachments: [...attachments] } : {}),
    },
  };
}

/**
 * slash 命令（dispatchSlashCommand）的 dispatch 决策。
 * 返回判别联合，SessionPane 据此决定「不消费 / 消费但不发命令（含 warn）/ 发命令」：
 * - notConsumed：原 `return false`（sendGoalCommand 无 submission、planShortcut 等 default 分支）。
 * - consumedWithoutDispatch：原 `return true` 且不发命令（emptyGoal/unsupportedGoal/resumeGoal 缺 baseRevision）；
 *   warn 文案在此单一构造，SessionPane 落地 logger.warn。
 * - dispatch：原走 dispatchCommand 的分支（compact/sendGoalCommand/resumeGoal/usage/autoResumeCommand）。
 *   baseRevision 仅在 withBaseRevision 命令（resumeGoal）透传，其余传 undefined（compact 不走 CAS）。
 *
 * usageTimeZone 由 SessionPane 传入（Intl.DateTimeFormat().resolvedOptions().timeZone），保持纯函数可测。
 */
export type SlashCommandDispatchPlan =
  | { outcome: "notConsumed" }
  | { outcome: "consumedWithoutDispatch"; warn: string }
  | {
      outcome: "dispatch";
      type: CommandType;
      payload: Record<string, unknown>;
      baseRevision: number | undefined;
    };

export function resolveSlashCommandDispatch(params: {
  command: V4VisibleSlashCommand;
  submission?: ComposerSubmissionConfig;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  expectedHeldQueueItemIds?: readonly string[];
  baseRevision: number | undefined;
  usageTimeZone: string | undefined;
}): SlashCommandDispatchPlan {
  const {
    command,
    submission,
    heldQueueDisposition,
    expectedHeldQueueItemIds,
    baseRevision,
    usageTimeZone,
  } = params;
  switch (command.kind) {
    case "compact":
      // compact 是可排队 input command，不走 CAS（baseRevision 不透传）。
      return { outcome: "dispatch", type: "compact", payload: {}, baseRevision: undefined };
    case "sendGoalCommand": {
      // 人工合并曾让 /goal 在准备完成后重新读取 Composer，覆盖点击时已冻结的档位。
      // 与 sendText 一样沿用本次 Submission；后续菜单修改只影响下一次发送。
      if (!submission) return { outcome: "notConsumed" };
      return {
        outcome: "dispatch",
        type: "sendGoalCommand",
        payload: {
          text: command.objective,
          displayText: command.displayText,
          ...submission,
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
        },
        baseRevision: undefined,
      };
    }
    case "resumeGoal": {
      // resumeGoal 是 CAS 命令：必须带 baseRevision。
      if (baseRevision === undefined) {
        return {
          outcome: "consumedWithoutDispatch",
          warn: `[v4-pane] slash ${command.kind} 缺少 baseRevision`,
        };
      }
      return {
        outcome: "dispatch",
        type: "resumeGoal",
        payload: {},
        baseRevision,
      };
    }
    case "usage":
      // /usage 查询命令族：零 token 本地查询，不进模型轮、不排队、不走 CAS。
      // timeZone 由客户端携带（IANA，与 v4/usage/stats 通道同惯例）；缺席按 UTC 归桶。
      return {
        outcome: "dispatch",
        type: "usage",
        payload: {
          ...(command.args ? { args: command.args } : {}),
          ...(usageTimeZone ? { timeZone: usageTimeZone } : {}),
        },
        baseRevision: undefined,
      };
    case "autoResume":
      // /auto-resume 命令面：零 token 本地命令；args = 子命令原文，解析/回执单一实现在 core。
      return {
        outcome: "dispatch",
        type: "autoResumeCommand",
        payload: command.args ? { args: command.args } : {},
        baseRevision: undefined,
      };
    case "emptyGoal":
      return { outcome: "consumedWithoutDispatch", warn: "[v4-pane] /goal 需要目标文本" };
    case "unsupportedGoal":
      return {
        outcome: "consumedWithoutDispatch",
        warn: `[v4-pane] 暂不支持 /goal ${command.action}`,
      };
    default:
      // planShortcut / unsupportedPlanShortcut 不在这里消费（由发送流程上游处理）。
      return { outcome: "notConsumed" };
  }
}
