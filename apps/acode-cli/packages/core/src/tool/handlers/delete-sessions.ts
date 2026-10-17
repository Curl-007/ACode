// ============================================================
// DeleteSessions Tool Handler
// ============================================================
// 批量删除（specs/session-fleet.md R8）：≤25；**所有权限模式（含 yolo）都必须
// 过用户审批**——静态 requiresUserInteraction:true 是既有的 bypass 免疫 ask 通道
// （PermissionService 在 yolo 直通之前命中 tool.userInteraction，与熔断器同哲学、
// 不同通道）；**绝不删本会话**（includes_self）。
//
// resolveInput 在确认窗之前收口校验（dwf 先例：坏输入不配打断用户）：批量上限、
// self 检查、所有权逐条——任一违规回业务失败，不弹卡；弹卡时列表必然全部合法
// （卡面列全部会话 = 输入本身含全部 id）。
//
// 数据面诚实语义（spec 非目标 #7）：sessionStore 无 deleteSession 原语，删除 =
// 停进程 + 舰队/registry 除名（所有权消灭，SendMessage/TaskOutput/TaskStop 自然
// not-found）+ store 归档标记；转录保留在磁盘，结果文本如实陈述。

import {
  DELETE_SESSIONS_TOOL_NAME,
  DeleteSessionsInputJsonSchema,
  DeleteSessionsInputSchema,
  DeleteSessionsOutputJsonSchema,
  DeleteSessionsOutputSchema,
  FLEET_DELETE_BATCH_MAX,
  FLEET_SELF_SESSION_ALIAS,
  type DeleteSessionsInput,
  type DeleteSessionsOutput,
} from "@acode/contracts";
import type {
  ToolEntry,
  ToolHandler,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import type { FleetSessionRecord } from "../../fleet/registry.js";
import { isFleetSessionRunning } from "../../fleet/archive.js";
import {
  FLEET_MAX_OUTPUT_BYTES,
  fleetCancellation,
  fleetRejection,
  fleetResultBudget,
  fleetTimeout,
  fleetTrace,
  fleetUnattendedRejection,
  formatFleetModelContent,
  resolveFleetRegistry,
  type FleetToolDeps,
} from "./session-fleet-shared.js";

const DELETE_TIMEOUT_MS = 60_000;
const DELETE_ERROR_CODE = {
  BATCH_TOO_LARGE: 1,
  INCLUDES_SELF: 2,
  OWNERSHIP: 3,
} as const;

const DELETE_SESSIONS_DESCRIPTION = [
  `Delete fleet sessions you own (batch of up to ${FLEET_DELETE_BATCH_MAX}).`,
  "",
  "EVERY delete is presented to the user for approval in EVERY permission mode, including yolo - deletion is bypass-immune; there is no silent path. The current session can never be deleted.",
  "",
  "Deleting stops a running session first, removes it from the fleet (it disappears from ListSessions and refuses further routing), and marks its stored conversation archived. Transcript data itself is retained on disk in this release.",
].join("\n");

/**
 * 确认窗之前的校验（spec R8）：只依赖同步可得的 registry 事实与调用方 sessionId。
 * 校验不过 = 业务失败退回，绝不先打断用户一次确认。registry 在**调用期**解析
 * （不在 entry 构造期捕获单例），resetFleetRegistryForTest 之后静态 entry 不会
 * 抱着旧实例。
 */
function makeResolveInput(deps: FleetToolDeps) {
  return (input: unknown, context: ToolInputResolutionContext): ToolInputResolutionResult => {
    const registry = resolveFleetRegistry(deps);
    const parsed = DeleteSessionsInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: false,
        errorCode: DELETE_ERROR_CODE.BATCH_TOO_LARGE,
        message: `DeleteSessions input is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }
    const ids = parsed.data.session_ids;
    if (ids.length > FLEET_DELETE_BATCH_MAX) {
      return {
        result: false,
        errorCode: DELETE_ERROR_CODE.BATCH_TOO_LARGE,
        message: `DeleteSessions accepts at most ${FLEET_DELETE_BATCH_MAX} ids per call (got ${ids.length}). Split the batch.`,
      };
    }
    const callerSessionId = context.sessionId;
    if (
      ids.includes(FLEET_SELF_SESSION_ALIAS) ||
      (callerSessionId !== undefined && ids.includes(String(callerSessionId)))
    ) {
      return {
        result: false,
        errorCode: DELETE_ERROR_CODE.INCLUDES_SELF,
        message:
          "DeleteSessions can never delete the current session. Remove your own session id from the batch.",
      };
    }
    for (const id of ids) {
      const ownership = registry.resolveOwned(String(callerSessionId ?? ""), id, {
        allowArchived: true,
      });
      if (!ownership.ok) {
        return {
          result: false,
          errorCode: DELETE_ERROR_CODE.OWNERSHIP,
          message: `${ownership.message} DeleteSessions validates the whole batch before asking the user.`,
        };
      }
    }
    return { result: true, input };
  };
}

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = DeleteSessionsInputSchema.parse(input) as DeleteSessionsInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies DeleteSessionsOutput;
    const registry = resolveFleetRegistry(deps);

    // 复核（resolveInput 之后状态可能变化；ask 卡批准的是那一份合法列表）。
    const records: FleetSessionRecord[] = [];
    for (const id of parsed.session_ids) {
      const ownership = registry.resolveOwned(context.sessionId, id, { allowArchived: true });
      if (!ownership.ok) {
        return fleetRejection(
          ownership.reason,
          `${ownership.message} Nothing was deleted (the batch is validated as a whole).`,
        ) satisfies DeleteSessionsOutput;
      }
      records.push(ownership.record);
    }

    const stopped: string[] = [];
    const deleted: string[] = [];
    for (const record of records) {
      const running = isFleetSessionRunning(record, context.runtimeTaskRegistry);
      if (running) {
        const stopResult = await context.backgroundTaskControlPort?.stopBackgroundTask(
          record.agentId,
          { initiator: "model", strict: true, traceContext: context.traceContext },
        );
        if (stopResult?.ok === true) stopped.push(String(record.sessionId));
        // 停不下来（端口缺席/不支持）不阻断删除：用户已批准整单，条目照移除，
        // child 的在飞 turn 由既有 abort/finalize 面收口。
      }
      context.runtimeTaskRegistry?.remove(record.agentId);
      registry.remove(record.sessionId); // 所有权消灭 + note watcher 撤销
      if (context.sessionStore) {
        try {
          await context.sessionStore.updateSession({
            id: record.sessionId,
            timeArchived: Date.now(),
          });
        } catch {
          // best-effort：舰队与 registry 面已除名，store 标记失败不回滚删除。
        }
      }
      deleted.push(String(record.sessionId));
    }

    return {
      outcome: "deleted",
      deleted,
      ...(stopped.length === 0 ? {} : { stopped }),
      message:
        `Deleted ${deleted.length} fleet session(s)${stopped.length > 0 ? ` (stopped ${stopped.length} running first)` : ""}: ${deleted.join(", ")}. ` +
        "They are removed from the fleet and refuse further routing. Their transcripts remain on disk in this release (no storage-level delete primitive yet); they are marked archived in the session store.",
    } satisfies DeleteSessionsOutput;
  };
}

function buildEntry(deps: FleetToolDeps): ToolEntry {
  return {
    capability: "Delete owned fleet sessions in a user-approved batch (bypass-immune)",
    // 顶层 requiresUserInteraction 同步镜像 metadata（toContracts 读顶层优先）。
    requiresUserInteraction: true,
    metadata: {
      name: DELETE_SESSIONS_TOOL_NAME,
      description: DELETE_SESSIONS_DESCRIPTION,
      readOnly: false,
      destructive: true,
      concurrentSafe: false,
      requiresUserInteraction: true,
      timeoutMs: DELETE_TIMEOUT_MS,
      maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
      sideEffectScope: "session",
      riskLevel: "high",
      needsApproval: true,
    },
    handler: makeHandler(deps),
    resolveInput: makeResolveInput(deps),
    formatModelContent: formatFleetModelContent,
    inputSchema: DeleteSessionsInputJsonSchema,
    outputSchema: DeleteSessionsOutputJsonSchema,
    runtimeInputSchema: DeleteSessionsInputSchema,
    runtimeOutputSchema: DeleteSessionsOutputSchema,
    permission: {
      permission: "fleet.session.delete",
      reason:
        "DeleteSessions removes fleet sessions and stops their processes; every delete requires the user's explicit approval in every permission mode, including yolo (bypass-immune)",
      riskLevel: "high",
      sideEffectScope: "session",
      needsApproval: true,
      patternSources: ["toolName", "input"],
      alwaysAllowPatternSources: [],
      denyPriority: "beforeAsk",
    },
    resultBudget: fleetResultBudget(),
    timeout: fleetTimeout(DELETE_TIMEOUT_MS),
    cancellation: fleetCancellation("DeleteSessions was cancelled before the batch settled"),
    trace: fleetTrace(),
  };
}

export function createDeleteSessionsToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return buildEntry(deps);
}

export const deleteSessionsToolEntry: ToolEntry = buildEntry({});
