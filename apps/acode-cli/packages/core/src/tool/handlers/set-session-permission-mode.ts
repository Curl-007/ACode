// ============================================================
// SetSessionPermissionMode Tool Handler
// ============================================================
// 权限不对称（specs/session-fleet.md R4）：降权/平调直通；**升权永不静默执行**——
// entry 工厂闭包舰队 registry，resolvePermissionCapability 同步判「请求模式 >
// recorded 模式」（严苛度序单一事实源 = subagent/nesting-policy 的 MODE_SEVERITY，
// 经 moreRestrictiveMode 消费）→ 动态置 requiresUserInteraction:true →
// PermissionService 在 yolo 直通**之前**强制 ask（tool.userInteraction，既有
// bypass 免疫通道，ExitPlanMode/AskUserQuestion 同款）。无人值守升权由 handler
// 直接拒绝并给指引（即使 ask 通道碰巧有人批准也不执行——fail-closed 双保险）。
//
// 生效边界（诚实语义，进 binding 字段与结果文本）：plan 系会话的 resume 不带
// modeOverride → 持久化 execution-state 在下个回合边界绑定；天花板系会话热
// resume 按既有继承裁决重锚发起者当前模式，recorded 绑定冷恢复面；结构性
// 不变量「任何时刻 ≤ 发起者当前模式」独立兜底。

import {
  SET_SESSION_PERMISSION_MODE_TOOL_NAME,
  SetSessionPermissionModeInputJsonSchema,
  SetSessionPermissionModeInputSchema,
  SetSessionPermissionModeOutputJsonSchema,
  SetSessionPermissionModeOutputSchema,
  type SetSessionPermissionModeInput,
  type SetSessionPermissionModeOutput,
} from "@acode/contracts";
import type {
  ToolEntry,
  ToolHandler,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import {
  buildFleetModeEntry,
  isFleetModeEscalation,
  resolveFleetModeBinding,
} from "../../fleet/mode-policy.js";
import { projectFleetPermissionMode } from "../../fleet/projection.js";
import {
  FLEET_MAX_OUTPUT_BYTES,
  fleetCancellation,
  fleetRejection,
  fleetResultBudget,
  fleetTimeout,
  fleetTrace,
  formatFleetModelContent,
  resolveFleetRegistry,
  type FleetToolDeps,
} from "./session-fleet-shared.js";

const SET_MODE_TIMEOUT_MS = 10_000;

const SET_MODE_DESCRIPTION = [
  "Change the recorded permission mode of a fleet session you own.",
  "",
  "Downgrades and sidegrades apply directly. An UPGRADE is never silent: interactively it is presented to the user for approval (in every mode, including yolo), and in unattended runs it is refused outright with guidance. Modes ordered by privilege: plan < edit < build < yolo.",
  "",
  "The recorded mode binds plan-lineage sessions at their next turn boundary and ceiling-lineage sessions on cold restore; independently, a fleet session can never exceed YOUR current mode at any turn boundary (structural ceiling).",
].join("\n");

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = SetSessionPermissionModeInputSchema.parse(
      input,
    ) as SetSessionPermissionModeInput;
    const registry = resolveFleetRegistry(deps);
    const ownership = registry.resolveOwned(context.sessionId, parsed.session_id);
    if (!ownership.ok) {
      return fleetRejection(
        ownership.reason,
        ownership.message,
      ) satisfies SetSessionPermissionModeOutput;
    }
    const { record } = ownership;
    const previousMode = record.mode;
    const escalation = isFleetModeEscalation(previousMode, parsed.mode);

    // 无人值守升权：直接拒绝并给指引（spec R4）——交互式路径已在权限层过 ask，
    // 走到 handler 即已获用户批准；automation/off-peak 轮即使 ask 被批准也不执行
    // （fail-closed 双保险）。降权/平调是变更面里唯一允许无人值守直通的方向
    // （R1/场景 4d：收紧永不放大权限，无人值守放行不违反任何不变量）。
    if (escalation && (context.automationTurn === true || context.offPeakTurn === true)) {
      return fleetRejection(
        "escalation_unattended",
        `Refusing to escalate fleet session "${parsed.session_id}" from ${previousMode} to ${parsed.mode} in an unattended run: privilege increases require the user's own approval. ` +
          "Leave the session as is, or report back so the user can decide interactively.",
      ) satisfies SetSessionPermissionModeOutput;
    }

    const previousModeProjected = projectFleetPermissionMode(previousMode);
    if (previousMode === parsed.mode) {
      return {
        outcome: "updated",
        session_id: parsed.session_id,
        mode: parsed.mode,
        ...(previousModeProjected === undefined ? {} : { previous_mode: previousModeProjected }),
        binding: resolveFleetModeBinding(record.modeLineage),
        message: `Fleet session "${record.title}" already records mode ${parsed.mode}; nothing changed.`,
      } satisfies SetSessionPermissionModeOutput;
    }

    registry.update(record.sessionId, (current) => ({
      ...current,
      mode: parsed.mode,
      lastActivityAt: Date.now(),
    }));

    // 持久化 execution-state 条目（best-effort）：plan 系 resume 与冷恢复面读回。
    if (context.sessionStore?.saveSessionEntry) {
      try {
        await context.sessionStore.saveSessionEntry(
          buildFleetModeEntry(record.sessionId, parsed.mode),
        );
      } catch {
        // 记录面已更新；持久化失败只影响冷恢复绑定，结果文本如实降级。
      }
    }

    const binding = resolveFleetModeBinding(record.modeLineage);
    const direction = escalation ? "escalated (user-approved)" : "changed";
    return {
      outcome: "updated",
      session_id: parsed.session_id,
      mode: parsed.mode,
      ...(previousModeProjected === undefined ? {} : { previous_mode: previousModeProjected }),
      binding,
      message:
        `Fleet session "${record.title}" permission mode ${direction}: ${previousMode} → ${parsed.mode}. ` +
        (binding === "next_turn_boundary"
          ? "It binds from the session's next turn boundary."
          : "It binds the session's cold-restore surface; live turns keep following the structural ceiling (never above your current mode)."),
    } satisfies SetSessionPermissionModeOutput;
  };
}

/**
 * 动态能力位（升权 → requiresUserInteraction:true）。同步、只读进程内 registry；
 * 记录缺席（unknown/未owned）不升 ask——handler 的拒绝面自会收口，不为必拒的
 * 调用打断用户。registry 在**调用期**解析（不在 entry 构造期捕获单例），
 * resetFleetRegistryForTest 之后静态 entry 不会抱着旧实例。
 */
function makeCapabilityResolver(deps: FleetToolDeps) {
  return (
    input: unknown,
    _context?: ToolRuntimePermissionCapabilityContext,
  ): ToolRuntimePermissionCapability | undefined => {
    const parsed = SetSessionPermissionModeInputSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const record = resolveFleetRegistry(deps).get(parsed.data.session_id);
    if (!record || record.archived) return undefined;
    if (!isFleetModeEscalation(record.mode, parsed.data.mode)) return undefined;
    return { requiresUserInteraction: true };
  };
}

function buildEntry(deps: FleetToolDeps): ToolEntry {
  return {
    capability: "Change a fleet session's recorded permission mode (upgrades always ask the user)",
    metadata: {
      shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
      name: SET_SESSION_PERMISSION_MODE_TOOL_NAME,
      description: SET_MODE_DESCRIPTION,
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: SET_MODE_TIMEOUT_MS,
      maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: makeHandler(deps),
    resolvePermissionCapability: makeCapabilityResolver(deps),
    formatModelContent: formatFleetModelContent,
    inputSchema: SetSessionPermissionModeInputJsonSchema,
    outputSchema: SetSessionPermissionModeOutputJsonSchema,
    runtimeInputSchema: SetSessionPermissionModeInputSchema,
    runtimeOutputSchema: SetSessionPermissionModeOutputSchema,
    permission: {
      permission: "fleet.session.permissionMode",
      reason:
        "SetSessionPermissionMode changes a fleet session's recorded permission mode; escalating it above the recorded mode requires the user's approval in every permission mode, and unattended runs must not escalate - relaunch or report back so the user can decide interactively",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName", "input"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: fleetResultBudget(),
    timeout: fleetTimeout(SET_MODE_TIMEOUT_MS),
    cancellation: fleetCancellation(
      "SetSessionPermissionMode was cancelled before the mode change settled",
    ),
    trace: fleetTrace(),
  };
}

export function createSetSessionPermissionModeToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return buildEntry(deps);
}

export const setSessionPermissionModeToolEntry: ToolEntry = buildEntry({});
