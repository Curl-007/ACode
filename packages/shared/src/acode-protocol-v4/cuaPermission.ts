import { z } from "zod";
import type { CuaPermissionKind } from "../cuaAccessibilitySettings.js";
import { timestampSchema } from "./core.js";

export const cuaRequestAccessStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    // 阶段 4（specs/windows-helper-producer.md §12.2）：受理面由 darwin 字面量扩为
    // darwin|win32 联合（v4 既有 schema 的 accept-widening，非新增命令）。
    // .strict()、schemaVersion、accessibility/screenRecording 值域全部不变（darwin 红线）。
    platform: z.enum(["darwin", "win32"]),
    grantOwner: z.string().min(1),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();
export type CuaRequestAccessStatus = z.infer<typeof cuaRequestAccessStatusSchema>;

export function requiredCuaPermissionsForRequestAccessStatus(
  status: CuaRequestAccessStatus,
): CuaPermissionKind[] {
  const required: CuaPermissionKind[] = [];
  if (status.accessibility === "denied" || status.accessibility === "stale") {
    required.push("accessibility");
  }
  if (status.screenRecording === "denied") {
    required.push("screen_recording");
  }
  return required;
}

export const cuaPermissionObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
    occurredAt: timestampSchema,
    sessionId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    permissionStatus: cuaRequestAccessStatusSchema,
  })
  .strict();
export type CuaPermissionObservation = z.infer<typeof cuaPermissionObservationSchema>;
