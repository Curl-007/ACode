import { booleanField, stringField } from "./state.js";
import {
  arrayField,
  combinedLine,
  compactLines,
  previewLine,
  previewText,
} from "./app-tool-detail-primitives.js";

/**
 * 会话舰队一行态（apps/acode-cli/specs/session-fleet.md R9）：title·mode·目标 id
 * 的最小呈现，不开面板不做富渲染；desktop 舰队面板登记后续批次（spec 非目标 #8）。
 * 从 app-tool-transcript.ts 拆出（max-lines ratchet），分派仍在那边的
 * buildToolTranscriptProjection；行宽/行数纪律复用同一组原语（compactLines）。
 */

export function fleetStartDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    `fleet: "${previewText(stringField(record, "title") ?? "")}"`,
    combinedLine(record, "opts", ["permission_mode"]),
    booleanField(record, "use_worktree") ? "worktree: isolated" : undefined,
    previewLine(record, "prompt"),
  ]);
}

export function fleetRouteDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    `fleet: → ${stringField(record, "session_id") ?? "new session"}`,
    previewLine(record, "message") ?? previewLine(record, "prompt"),
  ]);
}

export function fleetModeDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    `fleet: ${stringField(record, "session_id") ?? "?"} mode → ${stringField(record, "mode") ?? "?"}`,
  ]);
}

export function fleetArchiveDetails(record: Record<string, unknown>): string[] {
  return compactLines([`fleet: archive ${fleetShortId(record)}`]);
}

export function fleetDeleteDetails(record: Record<string, unknown>): string[] {
  return compactLines([`fleet: delete ${arrayField(record, "session_ids").length}`]);
}

/** 舰队 id 只呈现短尾（id 是路由凭据不是显示名，全量在工具结果里）。 */
export function fleetShortId(record: Record<string, unknown>): string {
  const id = stringField(record, "session_id") ?? "";
  return id.length > 12 ? `…${id.slice(-8)}` : id || "?";
}
