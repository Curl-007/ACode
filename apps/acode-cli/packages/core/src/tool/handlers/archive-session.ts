// ============================================================
// ArchiveSession Tool Handler
// ============================================================
// 归档 + 级联 + 拒绝而非强制（specs/session-fleet.md R7）：停跟进、移入归档、
// 对话保留可重开；共享 worktree 或已完成的 side 会话随单级联；在跑的拒绝而非
// 强制；支持 "self"。审批语义分模式 = 既有 needsApproval ask 面（普通模式弹卡、
// yolo 直通）——与 DeleteSessions 的 bypass 免疫（requiresUserInteraction）刻意
// 不同档。

import {
  ARCHIVE_SESSION_TOOL_NAME,
  ArchiveSessionInputJsonSchema,
  ArchiveSessionInputSchema,
  ArchiveSessionOutputJsonSchema,
  ArchiveSessionOutputSchema,
  FLEET_SELF_SESSION_ALIAS,
  type ArchiveSessionInput,
  type ArchiveSessionOutput,
} from "@acode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { executeFleetArchive, resolveFleetArchivePlan } from "../../fleet/archive.js";
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

const ARCHIVE_TIMEOUT_MS = 30_000;

const ARCHIVE_SESSION_DESCRIPTION = [
  'Archive a fleet session you own (or "self"): it stops accepting follow-ups and moves out of the active list, while its conversation is retained and stays readable/reopenable.',
  "",
  "- Refuses rather than forces: a session that is still running is rejected (wait for it or TaskStop it first); the same applies to a shared-worktree cascade target.",
  "- Cascades: sessions sharing its worktree, and finished side sessions it started, are archived with it.",
  '- session_id "self" archives the calling session: as a fleet session it closes to further routing once its current turn wraps up; as your main interactive session it marks the conversation archived.',
  "- Worktrees are NOT removed by archiving - inactive worktree cleanup is ReapSessionWorktrees' job.",
].join("\n");

function makeHandler(deps: FleetToolDeps): ToolHandler {
  return async (input, context) => {
    const parsed = ArchiveSessionInputSchema.parse(input) as ArchiveSessionInput;
    const unattended = fleetUnattendedRejection(context);
    if (unattended) return unattended satisfies ArchiveSessionOutput;
    const registry = resolveFleetRegistry(deps);

    // ── self：调用方自己（R7 末段）──
    if (parsed.session_id === FLEET_SELF_SESSION_ALIAS) {
      const selfRecord = registry.get(context.sessionId);
      if (selfRecord) {
        // 舰队会话归档自己：记录即刻 archived（路由门立即关闭），当前回合自然
        // 收口；**自己的在飞 runtime-task 条目不 remove**（finalize 漏斗还在写，
        // 移除会让结算撞 task_missing）。
        if (context.sessionStore) {
          try {
            await context.sessionStore.updateSession({
              id: selfRecord.sessionId,
              timeArchived: Date.now(),
            });
          } catch {
            // best-effort：舰队记录是事实源。
          }
        }
        registry.update(selfRecord.sessionId, (record) => ({
          ...record,
          archived: true,
          archivedAt: Date.now(),
        }));
        registry.disposeWatcher(selfRecord.sessionId);
        return {
          outcome: "archived",
          session_id: String(selfRecord.sessionId),
          message: `Fleet session "${selfRecord.title}" (this session) is archived: it closes to further fleet routing; the current turn wraps up normally and the conversation stays readable.`,
        } satisfies ArchiveSessionOutput;
      }
      // 主交互会话：仅落 store 归档标记（无舰队记录可动）。
      if (context.sessionStore) {
        try {
          await context.sessionStore.updateSession({
            id: context.sessionId,
            timeArchived: Date.now(),
          });
        } catch {
          // best-effort：无内存记录时 store 是唯一归档面，失败如实报告。
          return fleetRejection(
            "delivery_failed",
            "Archiving the current session failed: the session store rejected the archive mark. Nothing was changed.",
          ) satisfies ArchiveSessionOutput;
        }
      }
      return {
        outcome: "archived",
        session_id: String(context.sessionId),
        message:
          "The current conversation is marked archived; it stays readable and this turn completes normally.",
      } satisfies ArchiveSessionOutput;
    }

    // ── 目标会话：所有权 → 计划（含级联校验，任一在跑整单拒绝）→ 执行 ──
    const ownership = registry.resolveOwned(context.sessionId, parsed.session_id);
    if (!ownership.ok) {
      return fleetRejection(ownership.reason, ownership.message) satisfies ArchiveSessionOutput;
    }
    const plan = resolveFleetArchivePlan({
      registry,
      ...(context.runtimeTaskRegistry ? { runtimeTaskRegistry: context.runtimeTaskRegistry } : {}),
      target: ownership.record,
    });
    if (plan.kind === "rejected") {
      return fleetRejection(plan.reason, plan.message) satisfies ArchiveSessionOutput;
    }

    await executeFleetArchive({
      registry,
      ...(context.runtimeTaskRegistry ? { runtimeTaskRegistry: context.runtimeTaskRegistry } : {}),
      ...(context.sessionStore ? { sessionStore: context.sessionStore } : {}),
      targets: [plan.target, ...plan.cascaded],
    });

    const cascadedIds = plan.cascaded.map((record) => String(record.sessionId));
    return {
      outcome: "archived",
      session_id: parsed.session_id,
      ...(cascadedIds.length === 0 ? {} : { cascaded: cascadedIds }),
      message:
        `Archived fleet session "${plan.target.title}" (${parsed.session_id}). Its conversation is retained and readable via ReadSessionContext. ` +
        (cascadedIds.length > 0
          ? `Cascaded to ${cascadedIds.length} session(s): ${cascadedIds.join(", ")} (shared worktree or finished side sessions). `
          : "") +
        "Worktrees were kept; inactive ones are cleaned up by ReapSessionWorktrees.",
    } satisfies ArchiveSessionOutput;
  };
}

const baseEntry = {
  capability: "Archive an owned fleet session with cascade; refuses running sessions",
  metadata: {
    shouldDefer: true, // tool-search wave1a: 非常驻内置工具默认 defer(specs/tool-search.md R4)
    name: ARCHIVE_SESSION_TOOL_NAME,
    description: ARCHIVE_SESSION_DESCRIPTION,
    readOnly: false,
    destructive: false, // 对话保留可重开——归档不是销毁（DeleteSessions 才是 destructive）
    concurrentSafe: false, // 级联校验与执行之间不允许交错
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    maxOutputBytes: FLEET_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    // 审批语义分模式（R7）：普通模式弹卡、yolo 直通——既有 needsApproval ask 面。
    needsApproval: true,
  },
  formatModelContent: formatFleetModelContent,
  inputSchema: ArchiveSessionInputJsonSchema,
  outputSchema: ArchiveSessionOutputJsonSchema,
  runtimeInputSchema: ArchiveSessionInputSchema,
  runtimeOutputSchema: ArchiveSessionOutputSchema,
  permission: {
    permission: "fleet.session.archive",
    reason:
      "ArchiveSession moves fleet sessions out of the active list (conversations are retained)",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: fleetResultBudget(),
  timeout: fleetTimeout(ARCHIVE_TIMEOUT_MS),
  cancellation: fleetCancellation("ArchiveSession was cancelled before the archive settled"),
  trace: fleetTrace(),
} satisfies Omit<ToolEntry, "handler">;

export function createArchiveSessionToolEntry(deps: FleetToolDeps = {}): ToolEntry {
  return { ...baseEntry, handler: makeHandler(deps) };
}

export const archiveSessionToolEntry: ToolEntry = {
  ...baseEntry,
  handler: makeHandler({}),
};
