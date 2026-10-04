// ============================================================
// Schedule Tool Handler - K6 Ambient 预算感知调度（specs/ambient-budget-scheduler.md R2）
// ============================================================
// 机制参照 jcode (MIT) crates/jcode-ambient-types 的 ScheduleTool（create/list/cancel
// 与 target 三态），自撰 TypeScript 实现。
//
// ★ 注册待接线：本文件只提供 handler 工厂与 ToolEntry 工厂，不修改
//   tool/handlers/index.ts 与 runtime-tools 的注册面——由整合批次统一接线
//  （flag 缺省 false 时不得注册本工具，spec 场景 10）。
//
// 与 cron 域的分工（提示词引导，不是硬边界）：周期性/用户手填 cron 表达式 → cron 域
// 工具；一次性、对话中受托（"8 分钟后提醒我"）→ Schedule。两者存储与调度器完全独立。
import {
  CoreErrorType,
  SCHEDULE_TOOL_NAME,
  ScheduleInputJsonSchema,
  ScheduleInputSchema,
  ScheduleOutputJsonSchema,
  ScheduleOutputSchema,
  createCoreError,
  type ScheduleInput,
  type ScheduledItemSummary,
  type ToolPermissionSpec,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import type { AmbientScheduleQueue, ScheduledItem } from "../../ambient/queue.js";
import { ScheduleLimitError, ScheduleOwnershipError } from "../../ambient/queue.js";

const SCHEDULE_TOOL_TIMEOUT_MS = 30_000;
const SCHEDULE_MODEL_BYTES = 32_000;

export interface ScheduleToolDeps {
  /** ambient 域自持有的磁盘队列（R2：与 services automation 存储分离）。 */
  queue: AmbientScheduleQueue;
  now?(): number;
  /**
   * 创建成功回调（唤醒 nudge / idle 后重启 runner 的接缝）。真实装配绑 runner 控制
   * 面；缺省 no-op 让工厂可独立于 runner 存在（list/cancel 不需要 runner）。
   */
  onScheduleCreated?(item: ScheduledItem): void;
  /** 创建来源会话标识（提醒投递目标）。 */
  sessionId?: string;
}

function toSummary(item: ScheduledItem): ScheduledItemSummary {
  return {
    scheduleId: item.scheduleId,
    wakeAtMs: item.wakeAtMs,
    priority: item.priority,
    target: item.target,
    taskDescription: item.taskDescription,
    ...(item.context !== undefined ? { context: item.context } : {}),
    ...(item.relevantFiles !== undefined ? { relevantFiles: item.relevantFiles } : {}),
  };
}

/** wakeAt 解析：ISO 字符串 → epoch ms；非法/过去时刻给可读错误（honest 拒绝）。 */
function resolveWakeAtMs(input: ScheduleInput, nowMs: number): number {
  if (input.wakeInMinutes !== undefined) {
    return nowMs + input.wakeInMinutes * 60_000;
  }
  const parsed = Date.parse(input.wakeAt!);
  if (Number.isNaN(parsed)) {
    throw scheduleInputError(`wakeAt is not a valid ISO 8601 time: ${input.wakeAt}`);
  }
  if (parsed <= nowMs) {
    // 过去的绝对时刻是模型自算时间的典型错误（cron delayMinutes 的同款教训）：
    // 静默当作"立即到期"会让提醒永远不响，直接拒绝并引导改用 wakeInMinutes。
    throw scheduleInputError(
      "wakeAt is in the past; for relative delays use wakeInMinutes anchored to the host clock",
    );
  }
  return parsed;
}

function scheduleInputError(message: string): ReturnType<typeof createCoreError> {
  return createCoreError(CoreErrorType.InvalidInput, message, { recoverable: true });
}

/**
 * 创建 Schedule 工具（单一工具、action 分派）。
 * deps 注入队列与时钟——handler 自身无 IO 依赖，测试直接驱动。
 */
export function createScheduleHandler(deps: ScheduleToolDeps): ToolHandler {
  return async (rawInput: unknown) => {
    const parsed = ScheduleInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw scheduleInputError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    const input = parsed.data;
    const nowMs = deps.now?.() ?? Date.now();
    try {
      if (input.action === "create") {
        const item = await deps.queue.create({
          wakeAtMs: resolveWakeAtMs(input, nowMs),
          priority: input.priority,
          target: input.target,
          taskDescription: input.taskDescription!,
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.relevantFiles !== undefined ? { relevantFiles: input.relevantFiles } : {}),
          ...(deps.sessionId !== undefined ? { createdBySession: deps.sessionId } : {}),
        });
        deps.onScheduleCreated?.(item);
        return {
          scheduleId: item.scheduleId,
          item: toSummary(item),
          message: `Scheduled (${item.target}) to wake at ${new Date(item.wakeAtMs).toISOString()}.`,
        };
      }
      if (input.action === "list") {
        // F11（批次C）：list 默认只列当前会话创建的项（单用户 CLI 多窗口形态的隐私
        // 取舍：A 窗口的模型不该看到 B 窗口的提醒文本）；`all: true` 显式要求才列全部。
        // 无归属项（createdBySession 缺失）与无会话身份（deps.sessionId 缺失）时不
        // 过滤——没有可过滤的归属键。
        const all = await deps.queue.list();
        const sessionId = deps.sessionId;
        const visible =
          input.all === true || sessionId === undefined
            ? all
            : all.filter((item) => item.createdBySession === undefined || item.createdBySession === sessionId);
        return {
          items: visible.map(toSummary),
          message: `${visible.length} pending schedule(s).`,
        };
      }
      // F11（批次C）：cancel 带归属键——他人会话的项由 queue 抛 ScheduleOwnershipError
      //（串行段内校验，无 list→cancel 的 TOCTOU 窗口），这里翻译为可读错误给模型。
      const cancelled = await deps.queue.cancel(input.scheduleId!, deps.sessionId);
      return {
        cancelled,
        message: cancelled
          ? `Cancelled schedule ${input.scheduleId}.`
          : `No pending schedule with id ${input.scheduleId}.`,
      };
    } catch (error) {
      if (error instanceof ScheduleLimitError) {
        // 上限是可读业务错误，不是内部故障：直接给模型，让它向用户解释。
        throw createCoreError(CoreErrorType.InvalidInput, error.message, { recoverable: true });
      }
      if (error instanceof ScheduleOwnershipError) {
        // F11：他人会话的项拒绝取消——可读错误（防误删并行窗口的工作单）。
        throw createCoreError(CoreErrorType.InvalidInput, error.message, { recoverable: true });
      }
      throw error;
    }
  };
}

const schedulePermission: ToolPermissionSpec = {
  permission: "ambient.schedule",
  reason: "Schedule creates a proposed future wake-up for the ambient budget-aware scheduler",
  riskLevel: "low",
  // 创建的是「提议」：真正的唤醒节奏由系统层预算调度约束（两层设计），工具本身
  // 不直接触发任何模型调用或文件写入（只写 ambient 域自己的队列文件）。
  sideEffectScope: "workspace",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

/**
 * Schedule 工具的 ToolEntry 工厂（注册待接线——见文件头）。
 * flag 缺省 false 时整合方不得注册本 entry（spec 场景 10）。
 */
export function createScheduleToolEntry(deps: ScheduleToolDeps): ToolEntry {
  return {
    capability: "Propose a future wake-up handled by the ambient budget-aware scheduler",
    metadata: {
      name: SCHEDULE_TOOL_NAME,
      description:
        "Propose a one-shot future wake-up created from the conversation. target=ambient wakes the budget-aware background agent cycle (system decides actual timing); target=session posts a visible reminder back into this conversation at wake time; target=spawn forks a new background task to do the work. For recurring schedules or user-written cron expressions use the dedicated cron scheduling tool instead.",
      modelInstructions: [
        "Use this only for one-shot wake-ups entrusted to you in conversation, such as 'remind me in 8 minutes' or 'check the build again in an hour'.",
        "For any delay from now, set wakeInMinutes (1-1440) and omit wakeAt; the host anchors to its real current clock. Use wakeAt only for an absolute wall-clock time the user names outright.",
        "target=session is a plain reminder (no agent); target=spawn runs the work as a new background task; target=ambient leaves the decision to the budget-aware scheduler.",
        "For recurring or cron-expression schedules, use the dedicated cron scheduling tool instead of this tool.",
        "taskDescription must be self-contained: reminder text for target=session, a complete work order otherwise.",
        "action=list shows this conversation's own schedules by default; set all=true only when the user explicitly asks for every schedule in the workspace.",
      ],
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      timeoutMs: SCHEDULE_TOOL_TIMEOUT_MS,
      maxOutputBytes: SCHEDULE_MODEL_BYTES,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: createScheduleHandler(deps),
    inputSchema: ScheduleInputJsonSchema,
    outputSchema: ScheduleOutputJsonSchema,
    runtimeInputSchema: ScheduleInputSchema,
    runtimeOutputSchema: ScheduleOutputSchema,
    permission: schedulePermission,
    resultBudget: {
      maxInlineBytes: SCHEDULE_MODEL_BYTES,
      maxModelBytes: SCHEDULE_MODEL_BYTES,
      strategy: "truncate",
      preview: { maxLines: 200, direction: "head" },
    },
    timeout: {
      defaultMs: SCHEDULE_TOOL_TIMEOUT_MS,
      maxMs: SCHEDULE_TOOL_TIMEOUT_MS,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Schedule was cancelled before the change was applied",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}
